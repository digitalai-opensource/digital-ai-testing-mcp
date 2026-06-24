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
  platform?: 'android' | 'ios';
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

  const platform = opts.platform ?? 'android';
  let query =
    opts.deviceQuery ??
    (platform === 'ios' ? "@os='iOS' and @category='PHONE'" : "@os='android' and @category='PHONE'");
  if (opts.region) query = `${query} and @region='${opts.region}'`;

  const desiredCapabilities: Record<string, unknown> = {
    'digitalai:accessKey': accessKey,
    'digitalai:deviceQuery': query,
    'digitalai:testName': opts.testName ?? '[MCP Inspection]',
    'platformName': platform === 'ios' ? 'iOS' : 'Android',
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
  let res;
  try {
    res = await client.post('/session', {
      desiredCapabilities,
      capabilities: { alwaysMatch, firstMatch: [{}] },
    });
  } catch (e) {
    // The Grid often returns a bare 500 with no body when the device agent pool
    // is saturated (v36) — give the caller a diagnosis path instead of a status code.
    throw new Error(
      `Session creation failed: ${describeWdError(e)}. Diagnostics: ` +
      `(1) run check_${platform === 'ios' ? 'ios' : 'android'}_readiness — if available is 0, the device pool or platform agents are busy; ` +
      `(2) if launching an app, verify it is assigned to your ACTIVE project (get_application_info → projectsInfo) — a successful install does NOT imply the session can use the app; ` +
      `(3) specific-device queries (@name/@serialNumber) can time out — prefer a generic @os/@category query with the region param. ` +
      `A bare 500 usually means platform load — retry shortly.`
    );
  }

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

  // POST /reporter/api/tests/delete is CSRF-blocked for project-level keys (Project Admin and Project User).
  // Only Cloud Admin credentials (JWT Bearer token) bypass the CSRF check on reporter mutation endpoints.
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
    lastUsedAt: Date.now(),
    canDeleteReport,
    sessionFormat: isW3c ? 'w3c' : 'jwp',
    platform,
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
  let res;
  try {
    res = await client.get(`/session/${session.gridSessionId}/screenshot`, {
      timeout: 30_000,
    });
  } catch (e) {
    throw new Error(sessionAwareError(e, handle));
  }
  if (!res.data.value) throw new Error('Screenshot returned empty response');
  const data = res.data.value as string;
  // Detect image format from base64 prefix — Grid returns PNG, OSS Appium may return JPEG
  const mimeType = data.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
  return { data, mimeType };
}

// Augment a WebDriver error with a dead-session hint — a 404 on an established
// session almost always means the Grid/agent terminated it (timeout, WDA crash).
function sessionAwareError(e: unknown, handle: string): string {
  const detail = describeWdError(e);
  const err = e as { response?: { status?: number } };
  if (err.response?.status === 404) {
    const s = sessionRegistry.get(handle);
    const idleNote =
      s?.lastIdleMs != null && s.lastIdleMs > 60_000
        ? ` The session was idle for ${Math.round(s.lastIdleMs / 60_000)} minute(s) before this command — Grid sessions expire after ~4 minutes of inactivity.`
        : '';
    return (
      `${detail} — the Grid session has likely been terminated (idle timeout or agent crash).${idleNote} ` +
      `The handle "${handle}" is no longer usable: call stop_inspection_session to clean up, ` +
      `then start_inspection_session for a fresh session.`
    );
  }
  return detail;
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
  // iOS locator attributes (null on Android)
  name: string | null;
  label: string | null;
  value: string | null;
}

export async function findElements(
  handle: string,
  using: string,
  value: string
): Promise<WdElement[]> {
  const session = requireSession(handle);
  const client = makeClient();
  const sid = session.gridSessionId;

  let res;
  try {
    res = await client.post(
      `/session/${sid}/elements`,
      { using, value },
      { timeout: 20_000 }
    );
  } catch (e) {
    throw new Error(sessionAwareError(e, handle));
  }

  const rawList: Record<string, string>[] = res.data.value ?? [];
  const elements: WdElement[] = [];

  for (const raw of rawList) {
    const elementId =
      raw['ELEMENT'] ?? raw['element-6066-11e4-a52e-4f735466cecf'];
    if (!elementId) continue;

    if (session.platform === 'ios') {
      // iOS attribute model: name/label/value/type. XCUITest rejects Android
      // names (class, text, bounds) outright; the Grid exposes `class` instead
      // of `type` — fetch both and take whichever resolves.
      const [name, label, val, type, cls, enabled, visible] =
        await Promise.allSettled([
          getAttr(client, sid, elementId, 'name'),
          getAttr(client, sid, elementId, 'label'),
          getAttr(client, sid, elementId, 'value'),
          getAttr(client, sid, elementId, 'type'),
          getAttr(client, sid, elementId, 'class'),
          getAttr(client, sid, elementId, 'enabled'),
          getAttr(client, sid, elementId, 'visible'),
        ]).then((rs) => rs.map((r) => (r.status === 'fulfilled' ? r.value : null)));

      let bounds: string | null = null;
      try {
        const { x, y, width, height } = await elementRect(client, session, elementId);
        bounds = `[${x},${y}][${x + width},${y + height}]`;
      } catch {
        // Non-fatal — element is still usable without geometry
      }

      elements.push({
        elementId,
        className: type ?? cls,
        resourceId: null,
        contentDesc: null,
        text: null,
        bounds,
        clickable: visible === 'true' ? true : visible === 'false' ? false : null,
        enabled: enabled === 'true' ? true : enabled === 'false' ? false : null,
        name,
        label,
        value: val,
      });
      continue;
    }

    // Android: Appium 1.x JWP uses XML-matching hyphenated attribute names
    const [className, resourceId, contentDesc, text, bounds, clickable, enabled] =
      await Promise.allSettled([
        getAttr(client, sid, elementId, 'class'),
        getAttr(client, sid, elementId, 'resource-id'),
        getAttr(client, sid, elementId, 'content-desc'),
        getAttr(client, sid, elementId, 'text'),
        getAttr(client, sid, elementId, 'bounds'),
        getAttr(client, sid, elementId, 'clickable'),
        getAttr(client, sid, elementId, 'enabled'),
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
      name: null,
      label: null,
      value: null,
    });
  }

  return elements;
}

// Lightweight single-element lookup: one round trip via the singular /element
// route, no attribute enrichment. Returns null when nothing matches ("no such
// element" 404). Used by internal helpers (e.g. press_back's nav-bar lookup)
// where the full findElements enrichment (~9 requests/element) is wasteful.
export async function findFirstElementId(
  handle: string,
  using: string,
  value: string
): Promise<string | null> {
  const session = requireSession(handle);
  const client = makeClient();
  try {
    const res = await client.post(
      `/session/${session.gridSessionId}/element`,
      { using, value },
      { timeout: 20_000 }
    );
    const raw: Record<string, string> = res.data.value ?? {};
    return raw['ELEMENT'] ?? raw['element-6066-11e4-a52e-4f735466cecf'] ?? null;
  } catch (e) {
    const detail = describeWdError(e).toLowerCase();
    if (detail.includes('no such element') || detail.includes('an element could not be located')) {
      return null;
    }
    throw new Error(describeWdError(e));
  }
}

// Element geometry that works on every agent: W3C agents route GET /element/{id}/rect;
// JWP agents (incl. the Grid, both platforms — confirmed live) route /location + /size.
async function elementRect(
  client: AxiosInstance,
  session: InspectionSession,
  elementId: string
): Promise<{ x: number; y: number; width: number; height: number }> {
  const sid = session.gridSessionId;
  const rect = async () => {
    const r = await client.get(`/session/${sid}/element/${elementId}/rect`, { timeout: 10_000 });
    const v = r.data.value;
    if (v?.width == null) throw new Error('rect route returned no geometry');
    return { x: Number(v.x), y: Number(v.y), width: Number(v.width), height: Number(v.height) };
  };
  const locSize = async () => {
    const [loc, size] = await Promise.all([
      client.get(`/session/${sid}/element/${elementId}/location`, { timeout: 10_000 }),
      client.get(`/session/${sid}/element/${elementId}/size`, { timeout: 10_000 }),
    ]);
    return {
      x: Number(loc.data.value?.x),
      y: Number(loc.data.value?.y),
      width: Number(size.data.value?.width),
      height: Number(size.data.value?.height),
    };
  };
  const [primary, fallback] = session.sessionFormat === 'w3c' ? [rect, locSize] : [locSize, rect];
  try {
    return await primary();
  } catch {
    return await fallback();
  }
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

  if (session.platform === 'ios') {
    // iOS launches by bundle ID — there is no activity concept.
    const seetest: Mechanism = ['seetest:client.launch', () =>
      client.post(
        `/session/${sid}/execute`,
        { script: 'seetest:client.launch', args: [packageName, false, true] },
        { timeout: 30_000 }
      )];
    const w3cLaunch: Mechanism = ['mobile: launchApp', () =>
      client.post(
        `/session/${sid}/execute/sync`,
        { script: 'mobile: launchApp', args: [{ bundleId: packageName }] },
        { timeout: 30_000 }
      )];
    const w3cActivate: Mechanism = ['mobile: activateApp', () =>
      client.post(
        `/session/${sid}/execute/sync`,
        { script: 'mobile: activateApp', args: [{ bundleId: packageName }] },
        { timeout: 30_000 }
      )];

    const order = session.sessionFormat === 'w3c'
      ? [w3cLaunch, w3cActivate, seetest]
      : [seetest, w3cLaunch, w3cActivate];
    const used = await tryAll(order);
    return `Launched ${packageName} via ${used}`;
  }

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

export async function pressBack(handle: string): Promise<string> {
  const session = requireSession(handle);
  if (session.platform === 'ios') {
    // iOS has no Back button. Primary: tap the navigation bar's back button —
    // present on every pushed screen (single cheap lookup, no enrichment).
    // Fallback: the left-edge swipe, which only helps in gesture-driven apps
    // (synthetic touches often don't trigger the system edge recognizer —
    // confirmed live on the Grid).
    try {
      const backButton = await findFirstElementId(
        handle,
        'xpath',
        '//XCUIElementTypeNavigationBar/XCUIElementTypeButton[1]'
      );
      if (backButton) {
        await tapElement(handle, backButton);
        return 'Tapped the navigation bar back button';
      }
    } catch {
      // Fall through to the edge swipe
    }
    const { width, height } = await getWindowSize(handle);
    const midY = Math.round(height / 2);
    await swipeScreen(handle, 2, midY, Math.round(width * 0.6), midY, 300);
    return 'No navigation bar back button found — attempted the left-edge back swipe (may not navigate in all apps; if the screen is unchanged, look for an on-screen close/back element)';
  }
  const client = makeClient();
  // POST /back is a standard WebDriver route — works on JWP and W3C alike.
  await client.post(`/session/${session.gridSessionId}/back`, {}, { timeout: 15_000 });
  return 'Back pressed';
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

// Start or end a Digital.ai performance transaction inside a live inspection
// session. The platform records CPU/memory/battery/network + Speed Index for
// the window between start and end; the agent runs the UI steps to measure in
// between using the normal tap/type/launch tools.
//
// These are seetest:client.* commands — the Digital.ai cloud proxy interprets
// them, not Appium, so they route through execScript on both Grid (/execute)
// and Appium Server / OSS (/execute/sync). The Grid execute parser cannot
// express a zero-argument seetest command, so start REQUIRES a network profile.
export async function performanceTransaction(
  handle: string,
  action: 'start' | 'end',
  opts: { networkProfile?: string; transactionName?: string }
): Promise<string> {
  const session = requireSession(handle);
  const client = makeClient();
  try {
    if (action === 'start') {
      if (!opts.networkProfile) {
        throw new Error(
          'networkProfile is required to start a performance transaction. Use "Monitor" to observe WITHOUT ' +
          'throttling (the usual choice when you just want to measure current performance). Throttling profiles ' +
          '("3G-average", "wifi", etc.) apply network conditions and must exist on your NV server — obtain valid ' +
          'names from your platform admin; only "Monitor" is broadly guaranteed. The NV server for the device\'s ' +
          'region must be ONLINE and tunnel-connected (verify with list_nv_servers) or the transaction records nothing.'
        );
      }
      await execScript(client, session, 'seetest:client.startPerformanceTransaction', [opts.networkProfile]);
      const isMonitor = opts.networkProfile.toLowerCase() === 'monitor';
      const throttleNote = isMonitor
        ? `"Monitor" is pass-through — no throttling is applied, so there is no ANR risk from network shaping. `
        : `⚠️ NV throttling is now ACTIVE — if the app makes background network calls during this window it may ANR/crash; keep the measured window tight. `;
      return (
        `Started performance transaction with NV profile "${opts.networkProfile}". ` +
        throttleNote +
        `Perform ONLY the UI steps you want measured, then call action:"end".`
      );
    }
    if (!opts.transactionName) {
      throw new Error('transactionName is required to end a performance transaction.');
    }
    const res = await execScript(client, session, 'seetest:client.endPerformanceTransaction', [opts.transactionName]);
    const value = (res?.data as { value?: unknown })?.value;
    const perfJson = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    return (
      `Ended performance transaction "${opts.transactionName}". The platform is writing the record — it appears in ` +
      `the reporter within ~1 minute (not instantly). Retrieve it with list_transactions(transactionName:"${opts.transactionName}", ` +
      `deviceName, startDate=today) then get_transaction(id) for the Speed Index and telemetry. ` +
      `Raw perf payload (truncated): ${perfJson.slice(0, 400)}`
    );
  } catch (e) {
    throw new Error(sessionAwareError(e, handle));
  }
}

async function resolvePoint(
  client: AxiosInstance,
  session: InspectionSession,
  opts: { elementId?: string; x?: number; y?: number }
): Promise<{ x: number; y: number }> {
  if (opts.elementId) {
    const { x, y, width, height } = await elementRect(client, session, opts.elementId);
    return { x: Math.round(x + width / 2), y: Math.round(y + height / 2) };
  }
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

// iOS physical buttons: XCUITest `mobile: pressButton` name → SeeTest deviceAction label.
const IOS_BUTTONS: Record<string, { w3c: string; grid: string }> = {
  HOME: { w3c: 'home', grid: 'Home' },
  VOLUME_UP: { w3c: 'volumeup', grid: 'Volume Up' },
  VOLUME_DOWN: { w3c: 'volumedown', grid: 'Volume Down' },
  POWER: { w3c: 'power', grid: 'Lock' },
};

export async function pressKey(
  handle: string,
  key?: string,
  keycode?: number
): Promise<string> {
  const session = requireSession(handle);
  const client = makeClient();
  const sid = session.gridSessionId;

  if (session.platform === 'ios') {
    const button = key ? IOS_BUTTONS[key] : undefined;
    if (!button) {
      throw new Error(
        `${key ?? `keycode ${keycode}`} is not available on iOS. Supported: HOME, VOLUME_UP, VOLUME_DOWN, POWER. ` +
        `For ENTER, type "\\n" with type_into_element; iOS has no BACK button — press_back performs the edge-swipe instead.`
      );
    }
    const w3c = () => execScript(client, session, 'mobile: pressButton', [{ name: button.w3c }]);
    const grid = () =>
      client.post(
        `/session/${sid}/execute`,
        { script: 'seetest:client.deviceAction', args: [button.grid] },
        { timeout: 15_000 }
      );
    const [primary, fallback] = session.sessionFormat === 'w3c' ? [w3c, grid] : [grid, w3c];
    try {
      await primary();
    } catch (e) {
      try {
        await fallback();
      } catch (e2) {
        throw new Error(`pressKey failed: ${describeWdError(e)}; fallback: ${describeWdError(e2)}`);
      }
    }
    return key!;
  }

  const code = keycode ?? (key ? ANDROID_KEYCODES[key] : undefined);
  if (code == null) throw new Error('Provide a named key or an Android keycode.');

  // Confirmed live: the Grid routes the legacy press_keycode endpoint.
  const jwp = () =>
    client.post(`/session/${sid}/appium/device/press_keycode`, { keycode: code }, { timeout: 15_000 });
  const w3c = () => execScript(client, session, 'mobile: pressKey', [{ keycode: code }]);

  const [primary, fallback] = session.sessionFormat === 'w3c' ? [w3c, jwp] : [jwp, w3c];
  try {
    await primary();
  } catch (e) {
    if (!isUnknownCommand(e)) throw e;
    await fallback();
  }
  return key ?? `keycode ${code}`;
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

  const isIos = session.platform === 'ios';

  switch (action) {
    case 'terminate': {
      if (!packageName) throw new Error('terminate requires packageName (Android) or bundleIdentifier (iOS).');
      if (isW3c) {
        const args = isIos ? { bundleId: packageName } : { appId: packageName };
        const res = await execScript(client, session, 'mobile: terminateApp', [args]);
        return res.data.value
          ? `Terminated ${packageName}.`
          : `${packageName} was not running.`;
      }
      await execScript(client, session, 'seetest:client.applicationClose', [packageName]);
      return `Closed ${packageName}.`;
    }
    case 'clear_data': {
      if (!packageName) throw new Error('clear_data requires packageName.');
      if (isIos) {
        throw new Error(
          'iOS cannot clear app data (XCUITest has no equivalent of Android clearApp). ' +
          'Uninstall and reinstall the app instead: uninstall_application_by_package, then install_application.'
        );
      }
      if (isW3c) {
        await execScript(client, session, 'mobile: clearApp', [{ appId: packageName }]);
      } else {
        await execScript(client, session, 'seetest:client.applicationClearData', [packageName]);
      }
      return `Cleared app data for ${packageName}. The app is back to first-launch state.`;
    }
    case 'query_state': {
      if (!packageName) throw new Error('query_state requires packageName (Android) or bundleIdentifier (iOS).');
      if (isW3c) {
        const args = isIos ? { bundleId: packageName } : { appId: packageName };
        const res = await execScript(client, session, 'mobile: queryAppState', [args]);
        const code = Number(res.data.value);
        return `${packageName}: ${APP_STATE_LABELS[code] ?? `state ${code}`} (code ${code}).`;
      }
      if (isIos) {
        throw new Error(
          'query_state is not supported on Grid iOS sessions (no current-activity equivalent). ' +
          'Use take_inspection_screenshot to check what is in the foreground.'
        );
      }
      // The Android Grid has no queryAppState — report the foreground check instead.
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
        // Android needs the handler package; iOS routes through the system.
        if (packageName && !isIos) args['package'] = packageName;
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
  try {
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
  } catch (e) {
    // Grid iOS devices report "This option is not supported on this device".
    throw new Error(describeWdError(e));
  }
  return b64 ? Buffer.from(b64, 'base64').toString('utf8') : '';
}

export async function setClipboard(handle: string, text: string): Promise<void> {
  const session = requireSession(handle);
  const client = makeClient();
  const content = Buffer.from(text, 'utf8').toString('base64');
  try {
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
  } catch (e) {
    throw new Error(describeWdError(e));
  }
}

export async function setGeolocation(
  handle: string,
  latitude: number,
  longitude: number
): Promise<void> {
  const session = requireSession(handle);
  const client = makeClient();
  if (session.sessionFormat === 'w3c') {
    // Legacy POST /location 500s on Appium Server. XCUITest uses
    // setSimulatedLocation; UiAutomator2 uses setGeolocation — both confirmed live.
    const script = session.platform === 'ios' ? 'mobile: setSimulatedLocation' : 'mobile: setGeolocation';
    await execScript(client, session, script, [{ latitude, longitude }]);
    return;
  }
  // Confirmed live on the Grid (both platforms): seetest:client.setLocation, string args.
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
  const script = session.platform === 'ios' ? 'mobile: resetSimulatedLocation' : 'mobile: resetGeolocation';
  await execScript(client, session, script, [{}]);
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
    const detail = describeWdError(e).toLowerCase();
    if (
      detail.includes('no alert') ||
      detail.includes('noalertopen') ||
      detail.includes('modal dialog when one was not open')
    ) {
      throw new Error('No alert is present on the screen — nothing to accept/dismiss.');
    }
    throw new Error(describeWdError(e));
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

// ─── Biometric authentication mock ───────────────────────────────────────────

export async function mockAuthentication(
  handle: string,
  reply: 'success' | 'failed' | 'cancel' | 'clear',
  delayMs: number
): Promise<string> {
  const session = requireSession(handle);
  if (session.platform === 'web') throw new Error('mock_authentication is not available for browser sessions.');
  const client = makeClient();

  // Android uses string enum values; iOS uses LAError numeric codes.
  const replyValue: string | number =
    session.platform === 'ios'
      ? ({ success: 1, failed: -1, cancel: -2, clear: 0 } as const)[reply]
      : ({ success: 'AUTHENTICATION_SUCCEEDED', failed: 'AUTHENTICATION_FAILED', cancel: 'ERROR_CANCELED', clear: 'CLEAR_MOCK' } as const)[reply];

  await execScript(client, session, 'seetest:client.setAuthenticationReply', [replyValue, delayMs]);

  const label = reply === 'clear' ? 'cleared (no mock active)' : `staged as "${reply}"`;
  return (
    `Authentication response ${label}. ` +
    `The next biometric prompt in the instrumented app will respond automatically.`
  );
}

export function registerSession(session: InspectionSession): void {
  sessionRegistry.set(session.handle, session);
  if (session.reportTestId > 0) allReports.set(session.reportTestId, session.projectName);
}

export function requireSession(handle: string): InspectionSession {
  const s = sessionRegistry.get(handle);
  if (!s)
    throw new Error(
      `No active inspection session "${handle}". Use list_inspection_sessions to see active sessions.`
    );
  // Track idle gaps — Grid sessions expire after ~4 minutes without a command,
  // so the gap preceding a failure is the key diagnostic (v36).
  const now = Date.now();
  s.lastIdleMs = now - s.lastUsedAt;
  s.lastUsedAt = now;
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
