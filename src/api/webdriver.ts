import axios, { AxiosInstance } from 'axios';
import type { InspectionSession } from '../types/digital-ai.js';
import { deleteTests } from './reporting.js';
import { getMyAccountInfo } from './users.js';
import { getActiveKeyType, getActiveUrl, getActiveAccessKey } from './client.js';

// In-process session registry — cleared on MCP server restart
const sessionRegistry = new Map<string, InspectionSession>();
// All report IDs created this process lifetime, mapped to the project name they
// were created under — for orphan cleanup. Sessions started under a non-default
// profile create reports in that project's reporter instance; deleting them
// later (e.g. after switching back to the admin JWT) MUST scope by projectName
// or the same numeric test_id in the default reporter scope gets deleted instead.
const allReports = new Map<number, string | undefined>();

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

  // Capture the active profile's project — the session's report is created in
  // this project's reporter instance and any later delete must scope to it.
  let projectName: string | undefined;
  try {
    projectName = (await getMyAccountInfo()).project?.name;
  } catch {
    // Non-fatal — deletes fall back to the default reporter scope
  }

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

  // Dual-protocol session request: the proprietary Grid (JWP) reads
  // desiredCapabilities; standard Appium Server (W3C) reads capabilities.alwaysMatch
  // and requires non-standard caps to carry the appium: vendor prefix.
  const W3C_STANDARD_CAPS = new Set(['platformName', 'browserName', 'browserVersion']);
  const alwaysMatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(desiredCapabilities)) {
    if (W3C_STANDARD_CAPS.has(key) || key.includes(':')) {
      alwaysMatch[key] = value;
    } else {
      alwaysMatch[`appium:${key}`] = value;
    }
  }

  const client = makeClient();
  const res = await client.post('/session', {
    desiredCapabilities,
    capabilities: { alwaysMatch, firstMatch: [{}] },
  });

  // JWP response:  { sessionId: "CLOUD-SID:...", value: { caps... }, status: 0 }
  // W3C response:  { value: { sessionId: "uuid...", capabilities: { caps... } } }
  const isW3c = res.data.value?.capabilities != null;
  const caps: Record<string, unknown> =
    res.data.value?.capabilities ?? res.data.value ?? {};

  const rawId = caps['digitalai:reportTestId'];
  const reportTestId = rawId ? parseInt(String(rawId), 10) : 0;
  // Track the report before any validation throw — if the session response is
  // malformed the Grid session times out on its own, but the reporter record is
  // permanent and must stay reachable by cleanup_inspection_sessions.
  if (reportTestId > 0) allReports.set(reportTestId, projectName);

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
    sessionFormat: isW3c ? 'w3c' : 'jwp',
    projectName,
  };

  sessionRegistry.set(handle, session);

  return session;
}

export async function quitInspectionSession(
  handle: string,
  keepReport = false
): Promise<{
  reportDeleted: boolean;
  reportKept: boolean;
  canDeleteReport: boolean;
  reportTestId: number;
  reportUrl: string;
}> {
  const session = requireSession(handle);

  const client = makeClient();
  try {
    await client.delete(`/session/${session.gridSessionId}`, { timeout: 30_000 });
  } catch {
    // Best-effort — session may already be expired
  }

  sessionRegistry.delete(handle);

  let reportDeleted = false;
  let reportKept = false;
  if (session.reportTestId > 0 && keepReport) {
    // Deliberately preserved (e.g. for the platform's session video recording) —
    // remove from the orphan registry so cleanup_inspection_sessions won't delete it.
    allReports.delete(session.reportTestId);
    reportKept = true;
  } else if (session.reportTestId > 0 && session.canDeleteReport) {
    try {
      // Scope to the project the session was created under — without projectName
      // the delete resolves the test_id in the default reporter scope.
      await deleteTests([session.reportTestId], undefined, session.projectName);
      allReports.delete(session.reportTestId);
      reportDeleted = true;
    } catch {
      // Non-fatal — user can delete via reporter UI
    }
  }

  return {
    reportDeleted,
    reportKept,
    canDeleteReport: session.canDeleteReport,
    reportTestId: session.reportTestId,
    reportUrl: session.reportUrl,
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

// ─── Gestures & app management ───────────────────────────────────────────────
// Ported from the official appium/appium-mcp implementation patterns.
// W3C agents (Appium 2/3) use POST /actions and `mobile:` execute commands —
// Appium 3 removed every legacy JWP route (touch/perform, /appium/device/*).
// JWP agents (Appium 1.x) only have the legacy routes — the `mobile:` gesture
// family arrived in the Appium 1.22 era. Each helper tries the session's
// native format first and falls back to the other on unknown-command errors,
// because the Digital.ai Grid proxy does not always match the agent's protocol.

// Extract a readable error from an Axios/WebDriver failure — the agent's actual
// message (e.g. "No alert is present on the screen") lives in the response body,
// which axios's default "Request failed with status code N" hides entirely.
function describeWdError(e: unknown): string {
  const err = e as { response?: { status?: number; data?: unknown }; message?: string };
  const status = err.response?.status;
  if (!status) return err.message ?? String(e);
  const data = err.response?.data as { value?: { message?: string; error?: string } } | undefined;
  const detail = data?.value?.message ?? data?.value?.error;
  return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
}

function isUnknownCommand(e: unknown): boolean {
  const err = e as { response?: { status?: number; data?: unknown } };
  const status = err.response?.status;
  if (status === 404 || status === 405 || status === 501) return true;
  const text = JSON.stringify(err.response?.data ?? '').toLowerCase();
  return (
    text.includes('unknown command') ||
    text.includes('unknown mobile command') ||
    text.includes('not implemented') ||
    text.includes('could not find a route')
  );
}

export async function getWindowSize(
  handle: string
): Promise<{ width: number; height: number }> {
  const session = requireSession(handle);
  const client = makeClient();
  // W3C route first, JWP route as fallback
  try {
    const res = await client.get(`/session/${session.gridSessionId}/window/rect`, {
      timeout: 15_000,
    });
    const v = res.data.value;
    if (v?.width != null) return { width: Number(v.width), height: Number(v.height) };
  } catch (e) {
    if (!isUnknownCommand(e)) throw e;
  }
  const res = await client.get(
    `/session/${session.gridSessionId}/window/current/size`,
    { timeout: 15_000 }
  );
  return { width: Number(res.data.value.width), height: Number(res.data.value.height) };
}

export async function swipeScreen(
  handle: string,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  durationMs = 300
): Promise<'w3c-actions' | 'jwp-touch'> {
  const session = requireSession(handle);
  const client = makeClient();
  const sid = session.gridSessionId;

  // W3C Actions — the initial 200ms pause after pointerDown makes the gesture
  // register as a drag/scroll rather than a fling (appium-mcp swipe pattern).
  const w3c = () =>
    client.post(
      `/session/${sid}/actions`,
      {
        actions: [
          {
            type: 'pointer',
            id: 'finger1',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', duration: 0, x: startX, y: startY },
              { type: 'pointerDown', button: 0 },
              { type: 'pause', duration: 200 },
              { type: 'pointerMove', duration: durationMs, x: endX, y: endY },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ],
      },
      { timeout: 30_000 }
    );

  // JWP TouchAction — moveTo coordinates are absolute since Appium 1.8.0.
  const jwp = () =>
    client.post(
      `/session/${sid}/touch/perform`,
      {
        actions: [
          { action: 'press', options: { x: startX, y: startY } },
          { action: 'wait', options: { ms: durationMs } },
          { action: 'moveTo', options: { x: endX, y: endY } },
          { action: 'release', options: {} },
        ],
      },
      { timeout: 30_000 }
    );

  if (session.sessionFormat === 'w3c') {
    try {
      await w3c();
      return 'w3c-actions';
    } catch (e) {
      if (!isUnknownCommand(e)) throw e;
      await jwp();
      return 'jwp-touch';
    }
  }
  try {
    await jwp();
    return 'jwp-touch';
  } catch (e) {
    if (!isUnknownCommand(e)) throw e;
    await w3c();
    return 'w3c-actions';
  }
}

export async function launchApp(
  handle: string,
  packageName: string,
  activity?: string
): Promise<string> {
  const session = requireSession(handle);
  const client = makeClient();
  const sid = session.gridSessionId;

  // The Digital.ai Grid (proprietary JWP proxy) rejects EVERYTHING except
  // seetest:client.* execute commands — legacy /appium/device/* routes return
  // 500/404 and `mobile:` commands fail with "missing 'client.' prefix".
  // Confirmed live: seetest:client.launch(activityURL, instrument, stopIfRunning)
  // with exactly 3 args is the working mechanism on the Grid. Standalone Appium
  // agents need `mobile:` commands (Appium 2/3) or the legacy routes (Appium 1.x),
  // so each mechanism is tried in order and all failures are reported together.
  type Mechanism = [string, () => Promise<unknown>];
  const errors: string[] = [];

  const tryAll = async (mechanisms: Mechanism[]): Promise<string> => {
    for (const [desc, fn] of mechanisms) {
      try {
        await fn();
        return desc;
      } catch (e) {
        const err = e as { response?: { data?: unknown }; message?: string };
        const detail = err.response?.data
          ? JSON.stringify(err.response.data).slice(0, 200)
          : err.message ?? String(e);
        errors.push(`${desc}: ${detail}`);
      }
    }
    throw new Error(`All launch mechanisms failed:\n  ${errors.join('\n  ')}`);
  };

  if (activity) {
    // Normalise: ".LoginActivity" and "com.full.path.LoginActivity" both valid.
    const fullActivity = activity.startsWith('.') || activity.includes('.')
      ? activity
      : `.${activity}`;
    const activityUrl = `${packageName}/${fullActivity}`;

    const seetest: Mechanism = ['seetest:client.launch', () =>
      client.post(
        `/session/${sid}/execute`,
        { script: 'seetest:client.launch', args: [activityUrl, false, true] },
        { timeout: 30_000 }
      )];
    const w3c: Mechanism = ['mobile: startActivity', () =>
      client.post(
        `/session/${sid}/execute/sync`,
        { script: 'mobile: startActivity', args: [{ intent: activityUrl, wait: true }] },
        { timeout: 30_000 }
      )];
    const legacy: Mechanism = ['legacy start_activity', () =>
      client.post(
        `/session/${sid}/appium/device/start_activity`,
        { appPackage: packageName, appActivity: fullActivity },
        { timeout: 30_000 }
      )];

    const order = session.sessionFormat === 'w3c' ? [w3c, seetest, legacy] : [seetest, w3c, legacy];
    const used = await tryAll(order);
    return `Launched ${activityUrl} via ${used}`;
  }

  // No activity — bring an installed app to the foreground. NOTE: the Digital.ai
  // Grid has no activate-by-package command — pass the activity for Grid sessions.
  const w3cActivate: Mechanism = ['mobile: activateApp', () =>
    client.post(
      `/session/${sid}/execute/sync`,
      { script: 'mobile: activateApp', args: [{ appId: packageName }] },
      { timeout: 30_000 }
    )];
  const legacyActivate: Mechanism = ['legacy activate_app', () =>
    client.post(
      `/session/${sid}/appium/device/activate_app`,
      { appId: packageName },
      { timeout: 30_000 }
    )];

  const order = session.sessionFormat === 'w3c'
    ? [w3cActivate, legacyActivate]
    : [legacyActivate, w3cActivate];
  const used = await tryAll(order);
  return `Activated ${packageName} via ${used} (foregrounded)`;
}

export async function pressBack(handle: string): Promise<void> {
  const session = requireSession(handle);
  const client = makeClient();
  // POST /back is a standard WebDriver route — works on JWP and W3C alike.
  await client.post(`/session/${session.gridSessionId}/back`, {}, { timeout: 15_000 });
}

// Execute a script via the protocol-appropriate endpoint.
// JWP agents route /execute; W3C agents (Appium 2/3) only route /execute/sync.
function execScript(
  client: AxiosInstance,
  session: InspectionSession,
  script: string,
  args: unknown[]
): Promise<{ data: { value: unknown } }> {
  const path = session.sessionFormat === 'w3c' ? 'execute/sync' : 'execute';
  return client.post(
    `/session/${session.gridSessionId}/${path}`,
    { script, args },
    { timeout: 30_000 }
  );
}

// Resolve an element's center point from its bounds attribute ("[x1,y1][x2,y2]").
// Works identically on JWP and W3C agents.
async function elementCenter(
  client: AxiosInstance,
  sessionId: string,
  elementId: string
): Promise<{ x: number; y: number }> {
  const res = await client.get(
    `/session/${sessionId}/element/${elementId}/attribute/bounds`,
    { timeout: 10_000 }
  );
  const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(String(res.data.value ?? ''));
  if (!m) throw new Error(`Could not read bounds for element ${elementId}`);
  return {
    x: Math.round((Number(m[1]) + Number(m[3])) / 2),
    y: Math.round((Number(m[2]) + Number(m[4])) / 2),
  };
}

async function resolvePoint(
  client: AxiosInstance,
  session: InspectionSession,
  opts: { elementId?: string; x?: number; y?: number }
): Promise<{ x: number; y: number }> {
  if (opts.elementId) return elementCenter(client, session.gridSessionId, opts.elementId);
  if (opts.x != null && opts.y != null) return { x: opts.x, y: opts.y };
  throw new Error('Provide either elementId or both x and y.');
}

export async function longPress(
  handle: string,
  opts: { elementId?: string; x?: number; y?: number },
  durationMs = 1500
): Promise<void> {
  const session = requireSession(handle);
  const client = makeClient();
  const { x, y } = await resolvePoint(client, session, opts);
  const sid = session.gridSessionId;

  const jwp = () =>
    client.post(
      `/session/${sid}/touch/perform`,
      {
        actions: [
          { action: 'longPress', options: { x, y } },
          { action: 'wait', options: { ms: durationMs } },
          { action: 'release', options: {} },
        ],
      },
      { timeout: 30_000 }
    );
  const w3c = () =>
    client.post(
      `/session/${sid}/actions`,
      {
        actions: [
          {
            type: 'pointer',
            id: 'finger1',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', duration: 0, x, y },
              { type: 'pointerDown', button: 0 },
              { type: 'pause', duration: durationMs },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ],
      },
      { timeout: 30_000 }
    );

  const [primary, fallback] = session.sessionFormat === 'w3c' ? [w3c, jwp] : [jwp, w3c];
  try {
    await primary();
  } catch (e) {
    if (!isUnknownCommand(e)) throw e;
    await fallback();
  }
}

export async function doubleTap(
  handle: string,
  opts: { elementId?: string; x?: number; y?: number }
): Promise<void> {
  const session = requireSession(handle);
  const client = makeClient();
  const { x, y } = await resolvePoint(client, session, opts);
  const sid = session.gridSessionId;

  // JWP TouchAction tap supports a count option.
  const jwp = () =>
    client.post(
      `/session/${sid}/touch/perform`,
      { actions: [{ action: 'tap', options: { x, y, count: 2 } }] },
      { timeout: 30_000 }
    );
  const w3c = () =>
    client.post(
      `/session/${sid}/actions`,
      {
        actions: [
          {
            type: 'pointer',
            id: 'finger1',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', duration: 0, x, y },
              { type: 'pointerDown', button: 0 },
              { type: 'pointerUp', button: 0 },
              { type: 'pause', duration: 100 },
              { type: 'pointerDown', button: 0 },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ],
      },
      { timeout: 30_000 }
    );

  const [primary, fallback] = session.sessionFormat === 'w3c' ? [w3c, jwp] : [jwp, w3c];
  try {
    await primary();
  } catch (e) {
    if (!isUnknownCommand(e)) throw e;
    await fallback();
  }
}

export async function dragAndDrop(
  handle: string,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  holdMs = 600,
  moveMs = 1200
): Promise<void> {
  const session = requireSession(handle);
  const client = makeClient();
  const sid = session.gridSessionId;

  const jwp = () =>
    client.post(
      `/session/${sid}/touch/perform`,
      {
        actions: [
          { action: 'longPress', options: { x: startX, y: startY } },
          { action: 'wait', options: { ms: holdMs } },
          { action: 'moveTo', options: { x: endX, y: endY } },
          { action: 'wait', options: { ms: 150 } },
          { action: 'release', options: {} },
        ],
      },
      { timeout: 30_000 }
    );
  const w3c = () =>
    client.post(
      `/session/${sid}/actions`,
      {
        actions: [
          {
            type: 'pointer',
            id: 'finger1',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', duration: 0, x: startX, y: startY },
              { type: 'pointerDown', button: 0 },
              { type: 'pause', duration: holdMs },
              { type: 'pointerMove', duration: moveMs, x: endX, y: endY },
              { type: 'pause', duration: 150 },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ],
      },
      { timeout: 30_000 }
    );

  const [primary, fallback] = session.sessionFormat === 'w3c' ? [w3c, jwp] : [jwp, w3c];
  try {
    await primary();
  } catch (e) {
    if (!isUnknownCommand(e)) throw e;
    await fallback();
  }
}

export async function pinchZoom(
  handle: string,
  direction: 'in' | 'out',
  centerX?: number,
  centerY?: number,
  distance = 300,
  durationMs = 400
): Promise<void> {
  const session = requireSession(handle);
  // Confirmed live: the Grid's JWP proxy 501s multi-touch (touch/multi/perform)
  // and does not route /actions — pinch is Appium Server (W3C) only.
  if (session.sessionFormat === 'jwp') {
    throw new Error(
      'Pinch/zoom is not supported on Appium Grid sessions (the Grid rejects multi-touch). ' +
      'It works on Appium Server (OSS) project sessions.'
    );
  }
  const client = makeClient();
  const sid = session.gridSessionId;

  let cx = centerX;
  let cy = centerY;
  if (cx == null || cy == null) {
    const { width, height } = await getWindowSize(handle);
    cx = Math.round(width / 2);
    cy = Math.round(height / 2);
  }

  // 'in' = zoom in = fingers diverge from center; 'out' = zoom out = fingers converge.
  const near = 60;
  const [f1Start, f1End, f2Start, f2End] =
    direction === 'in'
      ? [cx - near, cx - near - distance, cx + near, cx + near + distance]
      : [cx - near - distance, cx - near, cx + near + distance, cx + near];

  const finger = (id: string, startX: number, endX: number) => ({
    type: 'pointer',
    id,
    parameters: { pointerType: 'touch' },
    actions: [
      { type: 'pointerMove', duration: 0, x: startX, y: cy },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 100 },
      { type: 'pointerMove', duration: durationMs, x: endX, y: cy },
      { type: 'pointerUp', button: 0 },
    ],
  });

  await client.post(
    `/session/${sid}/actions`,
    { actions: [finger('finger1', f1Start, f1End), finger('finger2', f2Start, f2End)] },
    { timeout: 30_000 }
  );
}

export interface ScrollToElementResult {
  found: boolean;
  element: WdElement | null;
  swipesUsed: number;
  reachedEnd: boolean;
}

export async function scrollToElement(
  handle: string,
  using: string,
  value: string,
  direction: 'up' | 'down' = 'up',
  maxSwipes = 8
): Promise<ScrollToElementResult> {
  const session = requireSession(handle);
  const { width, height } = await getWindowSize(handle);
  const midX = Math.round(width / 2);
  // 'up' finger movement scrolls content forward/down — the common case for lists.
  const [startY, endY] =
    direction === 'up'
      ? [Math.round(height * 0.7), Math.round(height * 0.3)]
      : [Math.round(height * 0.3), Math.round(height * 0.7)];

  let swipesUsed = 0;
  let lastSource = '';
  for (let i = 0; i <= maxSwipes; i++) {
    const found = await findElements(handle, using, value);
    if (found.length > 0) return { found: true, element: found[0], swipesUsed, reachedEnd: false };
    if (i === maxSwipes) break;

    const source = await getPageSource(session.handle);
    if (source === lastSource) {
      // Screen unchanged after a swipe — end of scrollable content.
      return { found: false, element: null, swipesUsed, reachedEnd: true };
    }
    lastSource = source;

    await swipeScreen(handle, midX, startY, midX, endY, 500);
    swipesUsed++;
    await new Promise((r) => setTimeout(r, 600)); // let the scroll settle
  }
  return { found: false, element: null, swipesUsed, reachedEnd: false };
}

// ─── Keys & keyboard ─────────────────────────────────────────────────────────

export const ANDROID_KEYCODES: Record<string, number> = {
  HOME: 3,
  BACK: 4,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  TAB: 61,
  ENTER: 66,
  DELETE: 67,
  MENU: 82,
  SEARCH: 84,
  APP_SWITCH: 187,
};

export async function pressKey(handle: string, keycode: number): Promise<void> {
  const session = requireSession(handle);
  const client = makeClient();
  const sid = session.gridSessionId;

  // Confirmed live: the Grid routes the legacy press_keycode endpoint.
  const jwp = () =>
    client.post(`/session/${sid}/appium/device/press_keycode`, { keycode }, { timeout: 15_000 });
  const w3c = () => execScript(client, session, 'mobile: pressKey', [{ keycode }]);

  const [primary, fallback] = session.sessionFormat === 'w3c' ? [w3c, jwp] : [jwp, w3c];
  try {
    await primary();
  } catch (e) {
    if (!isUnknownCommand(e)) throw e;
    await fallback();
  }
}

export async function isKeyboardShown(handle: string): Promise<boolean> {
  const session = requireSession(handle);
  const client = makeClient();
  const sid = session.gridSessionId;

  const w3c = async () => {
    const res = await execScript(client, session, 'mobile: isKeyboardShown', [{}]);
    return Boolean(res.data.value);
  };
  const jwp = async () => {
    const res = await client.get(`/session/${sid}/appium/device/is_keyboard_shown`, {
      timeout: 15_000,
    });
    return Boolean(res.data.value);
  };

  const [primary, fallback] = session.sessionFormat === 'w3c' ? [w3c, jwp] : [jwp, w3c];
  try {
    return await primary();
  } catch (e) {
    try {
      return await fallback();
    } catch (e2) {
      throw new Error(`isKeyboardShown failed: ${describeWdError(e)}; fallback: ${describeWdError(e2)}`);
    }
  }
}

export async function hideKeyboard(handle: string): Promise<void> {
  const session = requireSession(handle);
  const client = makeClient();
  const sid = session.gridSessionId;

  const w3c = () => execScript(client, session, 'mobile: hideKeyboard', [{}]);
  const jwp = () =>
    client.post(`/session/${sid}/appium/device/hide_keyboard`, {}, { timeout: 15_000 });

  const [primary, fallback] = session.sessionFormat === 'w3c' ? [w3c, jwp] : [jwp, w3c];
  try {
    await primary();
  } catch (e) {
    try {
      await fallback();
    } catch (e2) {
      throw new Error(`hideKeyboard failed: ${describeWdError(e)}; fallback: ${describeWdError(e2)}`);
    }
  }
}

// ─── App control ─────────────────────────────────────────────────────────────

export type AppControlAction = 'terminate' | 'clear_data' | 'query_state' | 'deep_link';

const APP_STATE_LABELS: Record<number, string> = {
  0: 'not installed',
  1: 'not running',
  2: 'running in background (suspended)',
  3: 'running in background',
  4: 'running in foreground',
};

export async function appControl(
  handle: string,
  action: AppControlAction,
  packageName?: string,
  url?: string
): Promise<string> {
  const session = requireSession(handle);
  const client = makeClient();
  const sid = session.gridSessionId;
  const isW3c = session.sessionFormat === 'w3c';

  switch (action) {
    case 'terminate': {
      if (!packageName) throw new Error('terminate requires packageName.');
      if (isW3c) {
        const res = await execScript(client, session, 'mobile: terminateApp', [{ appId: packageName }]);
        return res.data.value
          ? `Terminated ${packageName}.`
          : `${packageName} was not running.`;
      }
      await execScript(client, session, 'seetest:client.applicationClose', [packageName]);
      return `Closed ${packageName}.`;
    }
    case 'clear_data': {
      if (!packageName) throw new Error('clear_data requires packageName.');
      if (isW3c) {
        await execScript(client, session, 'mobile: clearApp', [{ appId: packageName }]);
      } else {
        await execScript(client, session, 'seetest:client.applicationClearData', [packageName]);
      }
      return `Cleared app data for ${packageName}. The app is back to first-launch state.`;
    }
    case 'query_state': {
      if (!packageName) throw new Error('query_state requires packageName.');
      if (isW3c) {
        const res = await execScript(client, session, 'mobile: queryAppState', [{ appId: packageName }]);
        const code = Number(res.data.value);
        return `${packageName}: ${APP_STATE_LABELS[code] ?? `state ${code}`} (code ${code}).`;
      }
      // The Grid has no queryAppState — report the foreground check instead.
      const res = await client.get(`/session/${sid}/appium/device/current_activity`, {
        timeout: 15_000,
      });
      const activity = String(res.data.value ?? '');
      const fg = activity.startsWith(packageName) || activity.startsWith('.')
        ? `current activity is "${activity}" — compare against the app's activities`
        : `current activity is "${activity}"`;
      return `${packageName}: Grid sessions can only check the foreground activity — ${fg}.`;
    }
    case 'deep_link': {
      if (!url) throw new Error('deep_link requires url.');
      if (isW3c) {
        const args: Record<string, unknown> = { url };
        if (packageName) args['package'] = packageName;
        await execScript(client, session, 'mobile: deepLink', [args]);
        return `Opened deep link ${url}.`;
      }
      // Best-effort on the Grid: seetest:client.launch accepts URLs but depends
      // on the device's default handler being in a usable state.
      await execScript(client, session, 'seetest:client.launch', [url, false, true]);
      return `Opened ${url} via seetest:client.launch (best-effort on Grid — depends on the device's default URL handler).`;
    }
  }
}

// ─── Device control ──────────────────────────────────────────────────────────

export async function getOrientation(handle: string): Promise<string> {
  const session = requireSession(handle);
  const client = makeClient();
  const res = await client.get(`/session/${session.gridSessionId}/orientation`, {
    timeout: 15_000,
  });
  return String(res.data.value ?? '').toUpperCase();
}

export async function setOrientation(
  handle: string,
  orientation: 'PORTRAIT' | 'LANDSCAPE'
): Promise<void> {
  const session = requireSession(handle);
  const client = makeClient();
  await client.post(
    `/session/${session.gridSessionId}/orientation`,
    { orientation },
    { timeout: 15_000 }
  );
}

export async function getClipboard(handle: string): Promise<string> {
  const session = requireSession(handle);
  const client = makeClient();
  let b64: string;
  if (session.sessionFormat === 'w3c') {
    const res = await execScript(client, session, 'mobile: getClipboard', [
      { contentType: 'plaintext' },
    ]);
    b64 = String(res.data.value ?? '');
  } else {
    const res = await client.post(
      `/session/${session.gridSessionId}/appium/device/get_clipboard`,
      { contentType: 'plaintext' },
      { timeout: 15_000 }
    );
    b64 = String(res.data.value ?? '');
  }
  return b64 ? Buffer.from(b64, 'base64').toString('utf8') : '';
}

export async function setClipboard(handle: string, text: string): Promise<void> {
  const session = requireSession(handle);
  const client = makeClient();
  const content = Buffer.from(text, 'utf8').toString('base64');
  if (session.sessionFormat === 'w3c') {
    await execScript(client, session, 'mobile: setClipboard', [
      { content, contentType: 'plaintext' },
    ]);
    return;
  }
  await client.post(
    `/session/${session.gridSessionId}/appium/device/set_clipboard`,
    { content, contentType: 'plaintext' },
    { timeout: 15_000 }
  );
}

export async function setGeolocation(
  handle: string,
  latitude: number,
  longitude: number
): Promise<void> {
  const session = requireSession(handle);
  const client = makeClient();
  if (session.sessionFormat === 'w3c') {
    // Legacy POST /location 500s on Appium Server — mobile: setGeolocation is the route.
    await execScript(client, session, 'mobile: setGeolocation', [{ latitude, longitude }]);
    return;
  }
  // Confirmed live on the Grid: seetest:client.setLocation takes string args.
  await execScript(client, session, 'seetest:client.setLocation', [
    String(latitude),
    String(longitude),
  ]);
}

export async function resetGeolocation(handle: string): Promise<void> {
  const session = requireSession(handle);
  if (session.sessionFormat === 'jwp') {
    // seetest:client.clearLocation exists but the Grid's execute parser cannot
    // express 0-arg commands — confirmed live.
    throw new Error(
      'Geolocation reset is not supported on Appium Grid sessions. ' +
      'Set explicit coordinates instead, or use an Appium Server (OSS) project session.'
    );
  }
  const client = makeClient();
  await execScript(client, session, 'mobile: resetGeolocation', [{}]);
}

export async function handleAlert(
  handle: string,
  action: 'accept' | 'dismiss'
): Promise<void> {
  const session = requireSession(handle);
  if (session.sessionFormat === 'jwp') {
    // Confirmed live: all alert routes 501 on the Grid.
    throw new Error(
      'Alert handling is not supported on Appium Grid sessions (the Grid returns 501 Not Implemented). ' +
      'On Android, dialogs are regular UI elements — use get_element_tree to find the button and tap_element to dismiss it.'
    );
  }
  const client = makeClient();
  try {
    await client.post(
      `/session/${session.gridSessionId}/alert/${action}`,
      {},
      { timeout: 15_000 }
    );
  } catch (e) {
    const detail = describeWdError(e);
    if (detail.toLowerCase().includes('no alert') || detail.toLowerCase().includes('noalertopen')) {
      throw new Error('No alert is present on the screen — nothing to accept/dismiss.');
    }
    throw new Error(detail);
  }
}

export async function pushFileToDevice(
  handle: string,
  remotePath: string,
  base64Data: string
): Promise<void> {
  const session = requireSession(handle);
  const client = makeClient();
  if (session.sessionFormat === 'w3c') {
    await execScript(client, session, 'mobile: pushFile', [
      { remotePath, payload: base64Data },
    ]);
    return;
  }
  await client.post(
    `/session/${session.gridSessionId}/appium/device/push_file`,
    { path: remotePath, data: base64Data },
    { timeout: 60_000 }
  );
}

export async function pullFileFromDevice(
  handle: string,
  remotePath: string
): Promise<string> {
  const session = requireSession(handle);
  const client = makeClient();
  if (session.sessionFormat === 'w3c') {
    const res = await execScript(client, session, 'mobile: pullFile', [{ remotePath }]);
    return String(res.data.value ?? '');
  }
  const res = await client.post(
    `/session/${session.gridSessionId}/appium/device/pull_file`,
    { path: remotePath },
    { timeout: 60_000 }
  );
  return String(res.data.value ?? '');
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
  return [...allReports.keys()];
}

export async function deleteAllTrackedReports(): Promise<number[]> {
  if (allReports.size === 0) return [];
  // Group by originating project — each project's reports live in its own
  // reporter instance and must be deleted with a matching projectName scope.
  const byProject = new Map<string | undefined, number[]>();
  for (const [id, project] of allReports) {
    const list = byProject.get(project) ?? [];
    list.push(id);
    byProject.set(project, list);
  }
  const deleted: number[] = [];
  for (const [project, ids] of byProject) {
    await deleteTests(ids, undefined, project);
    for (const id of ids) {
      allReports.delete(id);
      deleted.push(id);
    }
  }
  return deleted;
}
