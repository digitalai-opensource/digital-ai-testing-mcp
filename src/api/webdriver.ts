import axios, { AxiosInstance } from 'axios';
import type { InspectionSession } from '../types/digital-ai.js';
import { deleteTests } from './reporting.js';
import { getActiveKeyType, getActiveUrl, getActiveAccessKey } from './client.js';

// In-process session registry — cleared on MCP server restart
const sessionRegistry = new Map<string, InspectionSession>();
// All report IDs created this process lifetime — for orphan cleanup
const allReportIds = new Set<number>();

function gridBase(): string {
  // getActiveUrl (not process.env) — the Grid must follow switch_environment.
  const base = getActiveUrl();
  if (!base) throw new Error('DIGITAL_AI_BASE_URL not configured');
  return `${base}/wd/hub`;
}

function makeClient(): AxiosInstance {
  return axios.create({
    baseURL: gridBase(),
    timeout: 120_000,
    headers: { 'Content-Type': 'application/json' },
  });
}

export interface InspectionSessionOptions {
  deviceQuery?: string;
  region?: string;
  app?: string;
  appPackage?: string;
  appActivity?: string;
  noReset?: boolean;
  testName?: string;
}

export async function createInspectionSession(
  opts: InspectionSessionOptions
): Promise<InspectionSession> {
  // getActiveAccessKey (not process.env) — the session must be created with the
  // active profile's credential so it matches canDeleteReport's key-type check.
  const accessKey = getActiveAccessKey();
  if (!accessKey) throw new Error('DIGITAL_AI_ACCESS_KEY not configured');

  let query = opts.deviceQuery ?? "@os='android' and @category='PHONE'";
  if (opts.region) query = `${query} and @region='${opts.region}'`;

  const desiredCapabilities: Record<string, unknown> = {
    'digitalai:accessKey': accessKey,
    'digitalai:deviceQuery': query,
    'digitalai:testName': opts.testName ?? '[MCP Inspection]',
    'platformName': 'Android',
    'noReset': opts.noReset ?? true,
  };
  if (opts.app) {
    desiredCapabilities['app'] = opts.app;
    if (opts.appPackage) desiredCapabilities['appPackage'] = opts.appPackage;
    if (opts.appActivity) desiredCapabilities['appActivity'] = opts.appActivity;
  } else if (opts.appPackage) {
    desiredCapabilities['appPackage'] = opts.appPackage;
    if (opts.appActivity) desiredCapabilities['appActivity'] = opts.appActivity;
  }

  const client = makeClient();
  const res = await client.post('/session', { desiredCapabilities });

  // JWP response:  { sessionId: "CLOUD-SID:...", value: { caps... }, status: 0 }
  // W3C response:  { value: { sessionId: "uuid...", capabilities: { caps... } } }
  const caps: Record<string, unknown> =
    res.data.value?.capabilities ?? res.data.value ?? {};

  const rawId = caps['digitalai:reportTestId'];
  const reportTestId = rawId ? parseInt(String(rawId), 10) : 0;
  // Track the report before any validation throw — if the session response is
  // malformed the Grid session times out on its own, but the reporter record is
  // permanent and must stay reachable by cleanup_inspection_sessions.
  if (reportTestId > 0) allReportIds.add(reportTestId);

  const gridSessionId: string =
    res.data.sessionId ?? res.data.value?.sessionId ?? '';
  if (!gridSessionId) {
    throw new Error(
      'Session created but no sessionId in response' +
      (reportTestId > 0
        ? ` — orphaned report ${reportTestId} is tracked; run cleanup_inspection_sessions to delete it`
        : '')
    );
  }

  // POST /reporter/api/tests/delete is CSRF-blocked for project API keys.
  // Only Cloud Admin JWT (Bearer token) bypasses the CSRF check on reporter mutation endpoints.
  const canDeleteReport = getActiveKeyType() === 'jwt';

  const handle = crypto.randomUUID().slice(0, 8).toUpperCase();
  // Field names differ: JWP Grid uses dot-notation (device.name, device.os),
  // W3C Appium 2.x uses flat names (digitalai:cloudDeviceName, platformName, platformVersion).
  const session: InspectionSession = {
    handle,
    gridSessionId,
    reportTestId,
    reportUrl: String(caps['digitalai:reportUrl'] ?? ''),
    cloudViewLink: caps['digitalai:cloudViewLink'] ? String(caps['digitalai:cloudViewLink']) : null,
    deviceUDID: String(caps['deviceUDID'] ?? caps['device.serialNumber'] ?? caps['udid'] ?? ''),
    deviceName: String(caps['device.name'] ?? caps['digitalai:cloudDeviceName'] ?? ''),
    deviceModel: String(caps['device.model'] ?? caps['digitalai:publicModel'] ?? ''),
    deviceOs: String(caps['device.os'] ?? caps['platformName'] ?? 'Android'),
    deviceVersion: String(caps['device.version'] ?? caps['platformVersion'] ?? ''),
    appPackage: String(caps['appPackage'] ?? opts.appPackage ?? ''),
    startedAt: Date.now(),
    canDeleteReport,
  };

  sessionRegistry.set(handle, session);

  return session;
}

export async function quitInspectionSession(
  handle: string
): Promise<{ reportDeleted: boolean; canDeleteReport: boolean; reportTestId: number }> {
  const session = requireSession(handle);

  const client = makeClient();
  try {
    await client.delete(`/session/${session.gridSessionId}`, { timeout: 30_000 });
  } catch {
    // Best-effort — session may already be expired
  }

  sessionRegistry.delete(handle);

  let reportDeleted = false;
  if (session.reportTestId > 0 && session.canDeleteReport) {
    try {
      await deleteTests([session.reportTestId]);
      allReportIds.delete(session.reportTestId);
      reportDeleted = true;
    } catch {
      // Non-fatal — user can delete via reporter UI
    }
  }

  return {
    reportDeleted,
    canDeleteReport: session.canDeleteReport,
    reportTestId: session.reportTestId,
  };
}

export async function captureScreenshot(
  handle: string
): Promise<{ data: string; mimeType: string }> {
  const session = requireSession(handle);
  const client = makeClient();
  const res = await client.get(`/session/${session.gridSessionId}/screenshot`, {
    timeout: 30_000,
  });
  if (!res.data.value) throw new Error('Screenshot returned empty response');
  const data = res.data.value as string;
  // Detect image format from base64 prefix — Grid returns PNG, OSS Appium may return JPEG
  const mimeType = data.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
  return { data, mimeType };
}

export async function getPageSource(handle: string): Promise<string> {
  const session = requireSession(handle);
  const client = makeClient();
  const res = await client.get(`/session/${session.gridSessionId}/source`, {
    timeout: 30_000,
  });
  return (res.data.value as string) ?? '';
}

export interface WdElement {
  elementId: string;
  className: string | null;
  resourceId: string | null;
  contentDesc: string | null;
  text: string | null;
  bounds: string | null;
  clickable: boolean | null;
  enabled: boolean | null;
}

export async function findElements(
  handle: string,
  using: string,
  value: string
): Promise<WdElement[]> {
  const session = requireSession(handle);
  const client = makeClient();

  const res = await client.post(
    `/session/${session.gridSessionId}/elements`,
    { using, value },
    { timeout: 20_000 }
  );

  const rawList: Record<string, string>[] = res.data.value ?? [];
  const elements: WdElement[] = [];

  for (const raw of rawList) {
    const elementId =
      raw['ELEMENT'] ?? raw['element-6066-11e4-a52e-4f735466cecf'];
    if (!elementId) continue;

    // Appium 1.x JWP uses XML-matching hyphenated attribute names (resource-id, content-desc)
    const [className, resourceId, contentDesc, text, bounds, clickable, enabled] =
      await Promise.allSettled([
        getAttr(client, session.gridSessionId, elementId, 'class'),
        getAttr(client, session.gridSessionId, elementId, 'resource-id'),
        getAttr(client, session.gridSessionId, elementId, 'content-desc'),
        getAttr(client, session.gridSessionId, elementId, 'text'),
        getAttr(client, session.gridSessionId, elementId, 'bounds'),
        getAttr(client, session.gridSessionId, elementId, 'clickable'),
        getAttr(client, session.gridSessionId, elementId, 'enabled'),
      ]).then((rs) => rs.map((r) => (r.status === 'fulfilled' ? r.value : null)));

    elements.push({
      elementId,
      className,
      resourceId,
      contentDesc,
      text,
      bounds,
      clickable: clickable === 'true' ? true : clickable === 'false' ? false : null,
      enabled: enabled === 'true' ? true : enabled === 'false' ? false : null,
    });
  }

  return elements;
}

async function getAttr(
  client: AxiosInstance,
  sessionId: string,
  elementId: string,
  attr: string
): Promise<string | null> {
  try {
    const res = await client.get(
      `/session/${sessionId}/element/${elementId}/attribute/${attr}`,
      { timeout: 10_000 }
    );
    return res.data.value != null ? String(res.data.value) : null;
  } catch {
    return null;
  }
}

export async function tapElement(handle: string, elementId: string): Promise<void> {
  const session = requireSession(handle);
  const client = makeClient();
  await client.post(
    `/session/${session.gridSessionId}/element/${elementId}/click`,
    {},
    { timeout: 15_000 }
  );
}

export async function typeIntoElement(
  handle: string,
  elementId: string,
  text: string
): Promise<void> {
  const session = requireSession(handle);
  const client = makeClient();
  // Send both formats: JWP (value: charArray) and W3C (text: string)
  // Appium accepts both across protocol versions
  await client.post(
    `/session/${session.gridSessionId}/element/${elementId}/value`,
    { value: text.split(''), text },
    { timeout: 15_000 }
  );
}

export async function clearElement(handle: string, elementId: string): Promise<void> {
  const session = requireSession(handle);
  const client = makeClient();
  await client.post(
    `/session/${session.gridSessionId}/element/${elementId}/clear`,
    {},
    { timeout: 15_000 }
  );
}

export function requireSession(handle: string): InspectionSession {
  const s = sessionRegistry.get(handle);
  if (!s)
    throw new Error(
      `No active inspection session "${handle}". Use list_inspection_sessions to see active sessions.`
    );
  return s;
}

export function listActiveSessions(): InspectionSession[] {
  return [...sessionRegistry.values()];
}

export function getPendingReportIds(): number[] {
  return [...allReportIds];
}

export async function deleteAllTrackedReports(): Promise<number[]> {
  const ids = [...allReportIds];
  if (ids.length === 0) return [];
  await deleteTests(ids);
  for (const id of ids) allReportIds.delete(id);
  return ids;
}
