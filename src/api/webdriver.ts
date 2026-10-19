import axios, { AxiosInstance } from 'axios';
import type { InspectionSession } from '../types/digital-ai.js';
import { deleteTests, listTests } from './reporting.js';
import { getMyAccountInfo } from './users.js';
import { getActiveUrl, getActiveAccessKey } from './client.js';
import { checkDeleteAllowed } from './access-level.js';
import { isEmulatorQuery } from '../utils/device-query.js';

// In-process session registry — cleared on MCP server restart
const sessionRegistry = new Map<string, InspectionSession>();
// All report IDs created this process lifetime, mapped to the project name they
// were created under — for orphan cleanup. Sessions started under a non-default
// profile create reports in that project's reporter instance; deleting them
// later (e.g. after switching back to the admin key) MUST scope by projectName
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
  /** Android Auto / CarPlay projection resolution (digitalai:automotiveProjection) — projection runs for the whole session. */
  automotiveProjection?: AutomotiveResolution;
  /** iOS CarPlay only: instrument cluster content (digitalai:instrumentCluster). */
  instrumentCluster?: InstrumentClusterContent;
}

/** Android Auto supports all three; CarPlay supports 800x480 only (platform docs). */
export const AUTOMOTIVE_RESOLUTIONS = ['800x480', '1280x720', '1920x1080'] as const;
export type AutomotiveResolution = (typeof AUTOMOTIVE_RESOLUTIONS)[number];
export const INSTRUMENT_CLUSTER_CONTENT = ['Instruction Card', 'Map', 'Navigation App'] as const;
export type InstrumentClusterContent = (typeof INSTRUMENT_CLUSTER_CONTENT)[number];

/** The platform rejects longer device queries ("Device query length restricted to 255", seen live 2026-10-16). */
export const DEVICE_QUERY_MAX_LENGTH = 255;

/** Same wording as the platform, plus the length, so the caller can shorten it without a round trip. */
export function deviceQueryLengthError(query: string): string | null {
  return query.length > DEVICE_QUERY_MAX_LENGTH
    ? `Device query length restricted to ${DEVICE_QUERY_MAX_LENGTH} characters (this one is ${query.length}, including any region clause). Shorten it — e.g. drop redundant clauses or match a shorter part of the name with contains().`
    : null;
}

const DEFAULT_SESSION_CREATE_TIMEOUT_MS = 120_000;
const LONG_SESSION_CREATE_TIMEOUT_MS = 240_000;

/**
 * How long to wait for POST /session. Emulators/simulators boot (and install the app) inside the request: a Java test
 * took 60–130 s for an iOS simulator while the 120 s default timed out (debug-mode intake 2026-10-16). A projection
 * session needs the platform's own failure to arrive (see below). INSPECTION_SESSION_TIMEOUT_MS overrides both.
 */
export function sessionCreateTimeoutMs(query: string, automotiveProjection: boolean, env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.INSPECTION_SESSION_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return override;
  if (automotiveProjection || isEmulatorQuery(query)) return LONG_SESSION_CREATE_TIMEOUT_MS;
  return DEFAULT_SESSION_CREATE_TIMEOUT_MS;
}

/**
 * digitalai:newSessionWaitTimeout (seconds) — how long the platform waits for a matching free device. Without it the
 * platform kept an unmatchable query waiting 5+ minutes, so our client timed out with no reason; with it the platform
 * answers "No available device matching the query: …" (verified live 2026-10-16, Grid and Appium Server). It is set
 * 15 s under the client timeout so the platform's answer always arrives first.
 */
export function newSessionWaitSeconds(clientTimeoutMs: number): number {
  return Math.max(10, Math.floor(clientTimeoutMs / 1000) - 15);
}

export async function createInspectionSession(
  opts: InspectionSessionOptions
): Promise<InspectionSession> {
  // getActiveAccessKey (not process.env) — the session must be created with the
  // active profile's credential so canDeleteReport is derived from the same credential.
  const accessKey = getActiveAccessKey();
  if (!accessKey) throw new Error('DIGITAL_AI_ACCESS_KEY not configured');

  const platform = opts.platform ?? 'android';
  let query =
    opts.deviceQuery ??
    (platform === 'ios' ? "@os='iOS' and @category='PHONE'" : "@os='android' and @category='PHONE'");
  // Android Auto projection needs Android 10+ — the default query landed on an Android 9 phone that the platform then
  // rejected (UAT 2026-10-10). The query compares versions numerically (verified live: 66 phones = 63 at >= 10 + 3 below).
  // Only the default is narrowed; an explicit query or a pinned device stays the caller's choice.
  if (!opts.deviceQuery && opts.automotiveProjection && platform === 'android') query = `${query} and @version>='10.0'`;
  if (opts.region) query = `${query} and @region='${opts.region}'`;
  const tooLong = deviceQueryLengthError(query);
  if (tooLong) throw new Error(tooLong);

  // Capture the active profile's project — the session's report is created in
  // this project's reporter instance and any later delete must scope to it.
  let projectName: string | undefined;
  try {
    projectName = (await getMyAccountInfo()).project?.name;
  } catch {
    // Non-fatal — deletes fall back to the default reporter scope
  }

  const desiredCapabilities: Record<string, unknown> = {
    'digitalai:accessKey': accessKey,
    'digitalai:deviceQuery': query,
    'digitalai:testName': opts.testName ?? '[MCP Inspection]',
    'platformName': platform === 'ios' ? 'iOS' : 'Android',
    'noReset': opts.noReset ?? true,
  };
  // iOS identifies the app by bundleId (XCUITest capability reference); appPackage/appActivity are Android-only.
  const appIdCap = platform === 'ios' ? 'bundleId' : 'appPackage';
  if (opts.app) {
    desiredCapabilities['app'] = opts.app;
    if (opts.appPackage) desiredCapabilities[appIdCap] = opts.appPackage;
    if (opts.appActivity && platform !== 'ios') desiredCapabilities['appActivity'] = opts.appActivity;
  } else if (opts.appPackage) {
    desiredCapabilities[appIdCap] = opts.appPackage;
    if (opts.appActivity && platform !== 'ios') desiredCapabilities['appActivity'] = opts.appActivity;
  }
  if (opts.automotiveProjection) desiredCapabilities['digitalai:automotiveProjection'] = opts.automotiveProjection;
  if (opts.instrumentCluster) desiredCapabilities['digitalai:instrumentCluster'] = opts.instrumentCluster;
  const timeout = sessionCreateTimeoutMs(query, !!opts.automotiveProjection);
  desiredCapabilities['digitalai:newSessionWaitTimeout'] = newSessionWaitSeconds(timeout);

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
  const testName = desiredCapabilities['digitalai:testName'] as string;
  const requestedAt = Date.now();
  let res;
  try {
    // A projection session can take longer than the client default: the platform's projection start has its own 60 s
    // deadline on the device host, and a failed CarPlay start reached the reporter at 125.8 s (live 2026-10-14) — past
    // the 120 s default, so the client timed out first, never saw the platform's reason, and the failed-start cleanup
    // below never ran. `timeout` (sessionCreateTimeoutMs, above) waits long enough to receive the platform's answer.
    res = await client.post('/session', {
      desiredCapabilities,
      capabilities: { alwaysMatch, firstMatch: [{}] },
    }, { timeout });
  } catch (e) {
    const detail = describeWdError(e);
    // Our own client gave up, but the platform did not: it may still be booting an emulator/simulator and will create
    // the session (and its report) seconds or minutes later, unknown to this process. Nothing exists to clean up yet,
    // so the start is remembered and cleanup_inspection_sessions sweeps whatever it left (sweepTimedOutStarts).
    if (/timeout of \d+ms exceeded/i.test(detail)) {
      timedOutStarts.push({ testName, projectName, requestedAt });
      const timeouts = (timedOutQueries.get(query) ?? 0) + 1;
      timedOutQueries.set(query, timeouts);
      // The old text only said "wait longer", so the agent repeated the identical start for another 240 s; the platform
      // then answered at ~516 s with "Failed to boot emulator" (debug-mode intake 2026-10-19). Say the start can still
      // fail and steer away from an identical retry.
      const emulator = isEmulatorQuery(query);
      throw new Error(
        (timeouts > 1 ? `This query has now timed out ${timeouts} times in this session — do not retry it unchanged. ` : '') +
        `Session creation failed: no answer from the platform within ${Math.round(timeout / 1000)} s. ` +
        (emulator
          ? `Emulators/simulators boot and install the app inside this request and can take 60–130 s or more, but one ` +
            `that has not answered by now may also fail to boot (seen live: "Failed to boot emulator" after ~8.5 min). ` +
            `Rather than repeating the same query, try another emulator model or OS version (list_virtual_device_templates) or a real device. `
          : `The platform may still be waiting on the device or fail the start; rather than repeating the same query, widen it or pick another device. `) +
        `To wait longer instead, set INSPECTION_SESSION_TIMEOUT_MS (ms) in the MCP server's environment. ` +
        `The platform may still finish this start: the session would then hold the device unattended until its idle ` +
        `timeout (~4 min) and leave a report "${testName}" (its status and cause show the platform's final outcome — ` +
        `find_latest_test_for_name) — run cleanup_inspection_sessions afterwards to delete it.`
      );
    }
    // A start that fails after a device was allocated still leaves an "Error" report (UAT 2026-10-10: five of them).
    const leftover = await cleanUpFailedSessionReport(testName, projectName, requestedAt);
    // Automotive projection failures have specific causes the generic advice below doesn't cover (UAT 2026-10-10).
    const automotive = automotiveSessionHint(detail);
    if (automotive) throw new Error(`Session creation failed: ${detail}. ${automotive}${leftover}`);
    // The Grid often returns a bare 500 with no body when the device agent pool
    // is saturated (v36) — give the caller a diagnosis path instead of a status code.
    throw new Error(
      `Session creation failed: ${detail}. Diagnostics: ` +
      (platform === 'ios'
        ? '(1) run check_ios_readiness — if available is 0, the device pool or platform agents are busy; '
        : '(1) run find_available_device(os: "android") or get_device_health_summary — if nothing is available, the device pool or platform agents are busy; ') +
      `(2) if launching an app, verify it is assigned to your ACTIVE project (get_application_info → projectsInfo) — a successful install does NOT imply the session can use the app; ` +
      `(3) specific-device queries (@name/@serialNumber) can time out — prefer a generic @os/@category query with the region param. ` +
      `A bare 500 usually means platform load — retry shortly.` +
      leftover
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

  // Reporter deletes need Cloud Admin, or a project role on a project with allowUsersDeleteTests=true.
  // Level and flag come from the API (not the key format); if either can't be determined we try anyway
  // (a failed delete below is non-fatal and the report stays tracked for cleanup).
  const canDeleteReport = (await checkDeleteAllowed(projectName)) === null;

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
    appPackage: String(caps['appPackage'] ?? caps['bundleId'] ?? opts.appPackage ?? ''),
    startedAt: Date.now(),
    lastUsedAt: Date.now(),
    canDeleteReport,
    sessionFormat: isW3c ? 'w3c' : 'jwp',
    platform,
    projectName,
    ...(opts.automotiveProjection ? { automotiveMode: 'capability' as const, automotiveRunning: true } : {}),
  };

  sessionRegistry.set(handle, session);

  return session;
}

export async function quitInspectionSession(
  handle: string,
  keepReport = false
): Promise<{
  reportDeleted: boolean;
  /** Why the report could not be deleted (it is still in the reporter). */
  reportDeleteError?: string;
  reportKept: boolean;
  canDeleteReport: boolean;
  reportTestId: number;
  reportUrl: string;
}> {
  const session = requireSession(handle);

  const client = makeClient();
  // A HAR / device-log capture left running would never be finalised once the session is gone — stop it first
  // (best-effort: the session may already be dead).
  for (const [field, script] of [
    ['harRecording', 'seetest:client.stopHarRecording'],
    ['deviceLogRecording', 'seetest:client.stopLoggingDevice'],
  ] as const) {
    if (!session[field]) continue;
    try {
      await execScript(client, session, script, [], 15_000);
    } catch {
      // Best-effort
    }
    session[field] = undefined;
  }
  try {
    await client.delete(`/session/${session.gridSessionId}`, { timeout: 30_000 });
  } catch {
    // Best-effort — session may already be expired
  }

  sessionRegistry.delete(handle);

  let reportDeleted = false;
  let reportDeleteError: string | undefined;
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
    } catch (e) {
      // A report that carries a performance transaction cannot be deleted while the transaction exists — the platform
      // answers 400 "Persistent instance of Attachment references an unsaved transient instance of TestTransactionServer"
      // (verified 2026-10-18). Keep the reason so the caller knows the record is still there.
      reportDeleteError = (e as Error).message.includes('TestTransactionServer')
        ? 'the report holds a performance transaction, which the platform refuses to delete (400 TransientPropertyValueException) — the report stays'
        : (e as Error).message;
      // Non-fatal — user can delete via reporter UI
    }
  }

  return {
    reportDeleted,
    ...(reportDeleteError ? { reportDeleteError } : {}),
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
/** A 404 means a dead session only when the body says so — Appium 2/3 also answer 404 ("unknown command") for a route
 *  the driver lacks, and the Digital.ai proxy wraps seetest:client failures the same way (a camera-injection URL the
 *  platform could not fetch came back 404 and was misreported as a terminated session, 2026-10-18). */
function looksLikeDeadSession(e: unknown): boolean {
  const err = e as { response?: { status?: number; data?: { value?: { error?: string; message?: string } } } };
  if (err.response?.status !== 404) return false;
  const v = err.response.data?.value;
  if (!v || (v.error == null && v.message == null)) return true; // bare route 404: nothing to proxy to
  const msg = `${v.error ?? ''} ${v.message ?? ''}`.toLowerCase();
  if (/invalid session id|no such session|session .*(not found|terminated|expired|does not exist|has ended|is not running)/.test(msg)) return true;
  // 'unknown command' covers both a route the driver lacks and a wrapped seetest:client failure — neither is a dead session.
  return v.error !== 'unknown command' && v.error !== 'no such element' && v.error !== 'no such alert' && v.error !== 'invalid argument';
}

function sessionAwareError(e: unknown, handle: string): string {
  const detail = describeWdError(e);
  if (looksLikeDeadSession(e)) {
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
  /** iOS only: XCUITest's tap-ability flag. `clickable` mirrors `visible` (accessibility-layer visibility); an element
   *  can be visible yet not hittable (covered, off the hit-test path) — verified live 2026-10-17 on a home-screen icon. */
  hittable?: boolean | null;
  /** false when the match is beyond the attribute cap/time budget — only elementId is set. */
  enriched?: boolean;
}

export interface FindElementsOptions {
  /** Fetch attributes for at most this many matches (default 20); the rest come back as IDs only. */
  maxEnriched?: number;
  /** Stop fetching attributes after this long (default 35 s) so the call stays under MCP client timeouts (~60 s). */
  budgetMs?: number;
}

/**
 * Appium Settings API (Appium Server / W3C sessions only): one POST per session makes every `POST /elements` answer
 * carry attributes inline. Verified live 2026-10-18 — what each driver honours in `elementResponseAttributes`:
 *   UiAutomator2: name, text, rect, enabled, displayed, selected (NOT class / resource-id / content-desc / clickable)
 *   XCUITest:     type, label, rect, enabled, displayed (NOT value / visible / hittable; and its inline `name` is the
 *                 element TYPE, not the accessibility id — only `label` carries the identifier-or-label)
 * So the inline answer replaces 3 (Android) / 4 (iOS, incl. the rect call) of the 7–8 per-element GETs; the rest are
 * still fetched. 3 ExperiBank fields: 1 275 ms → 207 ms inline on Android, 3 612 ms → 357 ms on iOS (before the GETs).
 * A session where the settings call fails keeps the GET path (`inlineAttributes: false`, tried once).
 */
async function ensureInlineAttributes(client: AxiosInstance, session: InspectionSession): Promise<boolean> {
  if (session.sessionFormat !== 'w3c' || session.platform === 'web') return false;
  if (session.inlineAttributes != null) return session.inlineAttributes;
  const attrs = session.platform === 'ios' ? 'type,label,rect,enabled,displayed' : 'name,text,rect,enabled,displayed';
  try {
    await client.post(
      `/session/${session.gridSessionId}/appium/settings`,
      { settings: { shouldUseCompactResponses: false, elementResponseAttributes: attrs } },
      { timeout: 10_000 }
    );
    session.inlineAttributes = true;
  } catch {
    session.inlineAttributes = false;
  }
  return session.inlineAttributes;
}

const rectToBounds = (r: unknown): string | null => {
  const o = r as { x?: number; y?: number; width?: number; height?: number } | null;
  if (!o || o.x == null || o.width == null) return null;
  return `[${o.x},${o.y}][${o.x + o.width},${(o.y ?? 0) + (o.height ?? 0)}]`;
};
const asBool = (v: unknown): boolean | null => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);
const asStr = (v: unknown): string | null => (v == null ? null : String(v));

/**
 * Attribute enrichment costs 7–9 requests per element. Done one element at a time with no cap, 48 iOS home-screen
 * icons took 80–160 s (measured live 2026-10-09) — past the ~60 s MCP client timeout. So: a cap, a time budget, and
 * bounded parallelism (iOS kept low — hammering WebDriverAgent has crashed sessions before). Elements beyond the cap
 * or budget are still returned, with `enriched: false` and null attributes.
 */
export async function findElements(
  handle: string,
  using: string,
  value: string,
  opts: FindElementsOptions = {}
): Promise<WdElement[]> {
  const session = requireSession(handle);
  const client = makeClient();
  const sid = session.gridSessionId;
  const inline = await ensureInlineAttributes(client, session);
  const inWebview = isWebviewContext(session);

  let res;
  try {
    res = await client.post(
      `/session/${sid}/elements`,
      { using, value },
      // A Chrome WEBVIEW find on a heavy page exceeded 20 s live (2026-10-18); native finds answer in well under 1 s.
      { timeout: inWebview ? 60_000 : 20_000 }
    );
  } catch (e) {
    throw new Error(sessionAwareError(e, handle));
  }

  const rawList: Record<string, unknown>[] = res.data.value ?? [];
  const rawById = new Map<string, Record<string, unknown>>();
  const ids = rawList
    .map((raw) => {
      const id = (raw['ELEMENT'] ?? raw['element-6066-11e4-a52e-4f735466cecf']) as string | undefined;
      if (id) rawById.set(id, raw);
      return id;
    })
    .filter((id): id is string => Boolean(id));

  const bare = (elementId: string): WdElement => ({
    elementId, className: null, resourceId: null, contentDesc: null, text: null, bounds: null,
    clickable: null, enabled: null, name: null, label: null, value: null, enriched: false,
  });

  const enrich = async (elementId: string): Promise<WdElement> => {
    const raw = rawById.get(elementId) ?? {};
    if (inWebview) {
      // Web element inside a WEBVIEW context: tag, text, id/class attributes and geometry (W3C routes).
      const [tag, text, id, cls, rect] = await Promise.allSettled([
        client.get(`/session/${sid}/element/${elementId}/name`, { timeout: 10_000 }).then((r) => asStr(r.data.value)),
        client.get(`/session/${sid}/element/${elementId}/text`, { timeout: 10_000 }).then((r) => asStr(r.data.value)),
        getAttr(client, sid, elementId, 'id'),
        getAttr(client, sid, elementId, 'class'),
        client.get(`/session/${sid}/element/${elementId}/rect`, { timeout: 10_000 }).then((r) => r.data.value),
      ]).then((rs) => rs.map((r) => (r.status === 'fulfilled' ? r.value : null)));
      return {
        elementId, className: tag as string | null, resourceId: id as string | null, contentDesc: cls as string | null,
        text: text as string | null, bounds: rectToBounds(rect), clickable: null, enabled: null, name: null, label: null, value: null, enriched: true,
      };
    }
    if (session.platform === 'ios' && inline && 'type' in raw) {
      // Inline: type, label, rect, enabled, displayed. Still fetched: name (identifier), value, visible, hittable.
      const [name, val, visible, hittable] = await Promise.allSettled([
        getAttr(client, sid, elementId, 'name'),
        getAttr(client, sid, elementId, 'value'),
        getAttr(client, sid, elementId, 'visible'),
        getAttr(client, sid, elementId, 'hittable'),
      ]).then((rs) => rs.map((r) => (r.status === 'fulfilled' ? r.value : null)));
      return {
        elementId,
        className: asStr(raw['type']),
        resourceId: null,
        contentDesc: null,
        text: null,
        bounds: rectToBounds(raw['rect']),
        clickable: visible === 'true' ? true : visible === 'false' ? false : asBool(raw['displayed']),
        enabled: asBool(raw['enabled']),
        name: name ?? asStr(raw['label']),
        label: asStr(raw['label']),
        value: val,
        hittable: hittable === 'true' ? true : hittable === 'false' ? false : null,
        enriched: true,
      };
    }
    if (session.platform === 'android' && inline && 'text' in raw) {
      // Inline: text, rect, enabled, displayed. Still fetched: class, resource-id, content-desc, clickable.
      const [className, resourceId, contentDesc, clickable] = await Promise.allSettled([
        getAttr(client, sid, elementId, 'class'),
        getAttr(client, sid, elementId, 'resource-id'),
        getAttr(client, sid, elementId, 'content-desc'),
        getAttr(client, sid, elementId, 'clickable'),
      ]).then((rs) => rs.map((r) => (r.status === 'fulfilled' ? r.value : null)));
      return {
        elementId, className, resourceId, contentDesc: contentDesc === 'null' ? null : contentDesc,
        text: asStr(raw['text']), bounds: rectToBounds(raw['rect']),
        clickable: clickable === 'true' ? true : clickable === 'false' ? false : null,
        enabled: asBool(raw['enabled']), name: null, label: null, value: null, enriched: true,
      };
    }
    if (session.platform === 'ios') {
      // iOS attribute model: name/label/value/type. XCUITest rejects Android
      // names (class, text, bounds) outright; the Grid exposes `class` instead
      // of `type` — fetch both and take whichever resolves.
      const [name, label, val, type, cls, enabled, visible, hittable] =
        await Promise.allSettled([
          getAttr(client, sid, elementId, 'name'),
          getAttr(client, sid, elementId, 'label'),
          getAttr(client, sid, elementId, 'value'),
          getAttr(client, sid, elementId, 'type'),
          getAttr(client, sid, elementId, 'class'),
          getAttr(client, sid, elementId, 'enabled'),
          getAttr(client, sid, elementId, 'visible'),
          getAttr(client, sid, elementId, 'hittable'),
        ]).then((rs) => rs.map((r) => (r.status === 'fulfilled' ? r.value : null)));

      let bounds: string | null = null;
      try {
        const { x, y, width, height } = await elementRect(client, session, elementId);
        bounds = `[${x},${y}][${x + width},${y + height}]`;
      } catch {
        // Non-fatal — element is still usable without geometry
      }

      return {
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
        hittable: hittable === 'true' ? true : hittable === 'false' ? false : null,
        enriched: true,
      };
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

    return {
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
      enriched: true,
    };
  };

  const maxEnriched = Math.max(0, opts.maxEnriched ?? 20);
  const deadline = Date.now() + (opts.budgetMs ?? 35_000);
  const concurrency = session.platform === 'ios' ? 2 : 4;
  const elements = ids.map(bare);
  let next = 0;
  const worker = async () => {
    while (next < Math.min(ids.length, maxEnriched) && Date.now() < deadline) {
      const i = next++;
      elements[i] = await enrich(ids[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  return elements;
}

// Lightweight single-element lookup: one round trip via the singular /element
// route, no attribute enrichment. Returns null when nothing matches ("no such
// element" 404). Used by internal helpers (e.g. press_back's nav-bar lookup)
// where the full findElements enrichment (7–9 requests/element) is wasteful.
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

/**
 * After a failed session start, find the report that attempt created — same test name, started after the request was
 * sent — and delete it the way stop_inspection_session does. If deleting isn't allowed, name it so the caller can.
 * Returns a sentence to append to the error ('' when nothing was left or the lookup failed). Never throws.
 */
export async function cleanUpFailedSessionReport(testName: string, projectName: string | undefined, requestedAt: number): Promise<string> {
  try {
    const find = async () => {
      const batch = await listTests({ limit: 10, filter: [{ property: 'name', operator: '=', value: testName }] }, undefined, projectName);
      // 15 s of slack for clock skew. Only Error records (what a failed start leaves), and never a report that belongs to
      // a live session in this process — the default test name is shared, so a parallel session could match otherwise.
      return (batch.data ?? [])
        .filter((r) => r.status === 'Error' && new Date(r.start_time).getTime() >= requestedAt - 15_000 && !allReports.has(r.test_id))
        .map((r) => r.test_id);
    };
    let ids = await find();
    if (ids.length === 0) {
      await new Promise((r) => setTimeout(r, 2_000)); // the record can land a moment after the failure
      ids = await find();
    }
    if (ids.length === 0) return '';
    if ((await checkDeleteAllowed(projectName)) === null) {
      await deleteTests(ids, undefined, projectName);
      return ` The report this attempt created (${ids.join(', ')}) was deleted.`;
    }
    return ` This attempt left report ${ids.join(', ')} behind — delete it with delete_test_reports if you don't need it.`;
  } catch {
    return '';
  }
}

/**
 * Specific guidance for automotive projection failures, or null. Both messages were seen live (UAT 2026-10-10) when
 * a session was started with digitalai:automotiveProjection on a device that can't project.
 */
export function automotiveSessionHint(detail: string): string | null {
  // Seen live 2026-10-14 (iPhone 13 Pro Max on a newly CarPlay-enabled host): the host's projection service never
  // finished the start inside the platform's own 60 s deadline. The phone showed a one-time iOS consent dialog
  // ("Allow CarPlay with 'CarPlay Simulator' while phone is locked?"); accepting it did not clear the deadline on
  // that host, so it is a host-side condition to report, after ruling the dialog out.
  if (/DEADLINE_EXCEEDED|deadline exceeded/i.test(detail)) {
    return 'The device host\'s projection service did not finish starting CarPlay / Android Auto within the platform\'s 60 s ' +
      'deadline. Start a plain session on the same device and take_inspection_screenshot: if the phone shows "Allow CarPlay ' +
      'with \'CarPlay Simulator\' while phone is locked?", tap Allow (it is a one-time consent) and retry projection in a NEW ' +
      'session. If the deadline repeats after that, the host\'s projection service is not responding — report the host name ' +
      'to your platform admin; retrying will fail the same way.';
  }
  if (/Apple Silicon Device Host/i.test(detail)) {
    return 'Automotive projection only works on devices attached to an Apple Silicon device host, and this device\'s host ' +
      'is not one. This is a property of the device, not your request: try another device or region, or ask your platform ' +
      'admin which devices support Android Auto / CarPlay projection. Retrying the same device will fail the same way.';
  }
  // Seen live: "Timeout while waiting for the DHU process to connect" (UAT 2026-10-10), and a "no head unit server"
  // failure on a device without Android Auto set up.
  if (/\bDHU\b|head ?unit server/i.test(detail)) {
    return 'The Android Auto head unit (DHU) never connected — usually Android Auto isn\'t set up on this device or its ' +
      'head-unit server didn\'t start. This is a property of the device: try another device or region; retrying the same ' +
      'device usually fails the same way.';
  }
  if (/automotive dev mode|start Android Auto/i.test(detail)) {
    return 'The device could not switch on Android Auto developer mode. It needs Android 10 or later, and not every device ' +
      'or host supports projection: try another device, or ask your platform admin which devices support it.';
  }
  return null;
}

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

/**
 * Run a gesture through the session's native mechanism, falling back to the other protocol on an unknown-command
 * error. W3C sessions (Appium 2/3) use POST /actions; JWP sessions (the Grid) use POST /touch/perform.
 *
 * Appium 3 removed /touch/perform (verified live on Appium Server 3.8.0: 404). When a W3C gesture fails and the
 * fallback 404s too, the old code surfaced only the FALLBACK's error — "touch/perform not found" — hiding why
 * /actions failed. Both errors are now reported, the primary first. The primary error's HTTP response stays attached
 * so sessionAwareError can still recognise a dead session (404 on every route).
 */
async function gestureWithFallback(
  session: InspectionSession,
  w3c: () => Promise<unknown>,
  jwp: () => Promise<unknown>
): Promise<'w3c-actions' | 'jwp-touch'> {
  const order: Array<['w3c-actions' | 'jwp-touch', () => Promise<unknown>]> =
    session.sessionFormat === 'w3c' ? [['w3c-actions', w3c], ['jwp-touch', jwp]] : [['jwp-touch', jwp], ['w3c-actions', w3c]];
  try {
    await order[0][1]();
    return order[0][0];
  } catch (e) {
    if (!isUnknownCommand(e)) throw e;
    try {
      await order[1][1]();
      return order[1][0];
    } catch (e2) {
      const note = order[1][0] === 'jwp-touch' ? ' (the legacy /touch/perform route does not exist on Appium 3)' : '';
      const combined = new Error(
        `${order[0][0] === 'w3c-actions' ? 'W3C /actions' : 'JWP /touch/perform'} failed: ${describeWdError(e)}; ` +
        `fallback ${order[1][0] === 'w3c-actions' ? 'W3C /actions' : 'JWP /touch/perform'} failed: ${describeWdError(e2)}${note}`
      ) as Error & { response?: unknown };
      combined.response = (e as { response?: unknown }).response;
      throw combined;
    }
  }
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

  return gestureWithFallback(session, w3c, jwp);
}

export async function launchApp(
  handle: string,
  packageName: string,
  activity?: string
): Promise<string> {
  const session = requireSession(handle);
  const client = makeClient();
  const sid = session.gridSessionId;

  // For app launch the Digital.ai Grid (proprietary JWP proxy) accepts only
  // seetest:client.* execute commands — the legacy start_activity / activate_app
  // routes return 500/404 (other /appium/device/* routes such as press_keycode do
  // work there) and `mobile:` commands fail with "missing 'client.' prefix".
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
    // On Appium Grid an app that is not installed on the allocated device fails with an opaque "javascript error …
    // status='false'" (verified live 2026-10-09: the same launch succeeded once the app was installed via the session's
    // app capability) — so name the most likely cause instead of leaving the caller with the raw message.
    throw new Error(
      `All launch mechanisms failed:\n  ${errors.join('\n  ')}\n` +
      'Most common cause: the app is not installed on THIS device. Install it first (install_application on this device ' +
      'before the session, or start the session with app="cloud:<package>/<activity>"), and pass the exact activity from ' +
      'get_application_info.mainActivity.'
    );
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
        // stop: true — without it an already-running app only gets the intent "delivered to currently running top-most
        // instance" (no restart; verified live 2026-10-17 on Android 13); with it the launch is COLD, matching the Grid's
        // seetest:client.launch(..., stopIfRunning = true) used below.
        { script: 'mobile: startActivity', args: [{ intent: activityUrl, wait: true, stop: true }] },
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
  args: unknown[] = [{}],
  timeoutMs = 30_000
): Promise<{ data: { value: unknown } }> {
  const path = session.sessionFormat === 'w3c' ? 'execute/sync' : 'execute';
  // Appium Grid: a seetest:client command with NO arguments must be written inline — "seetest:client.cmd()" — because
  // the Grid parses arguments out of the script string ("invalid parameters delimiter" for the bare form). Verified
  // live 2026-10-19: report("x", true), startStepsGroup("g"), stopStepsGroup(), setLocation("37.33","-122.03"),
  // clearLocation(), addTestProperty("k","v"), hybridClearCache() and getNetworkConnection("wifi") all run inline on the
  // Grid, so every 0-arg command is reachable there after all (an earlier note said otherwise).
  const inline = session.sessionFormat === 'jwp' && script.startsWith('seetest:client.') && args.length === 0 && !script.endsWith(')');
  return client.post(
    `/session/${session.gridSessionId}/${path}`,
    inline ? { script: `${script}()`, args: [] } : { script, args },
    { timeout: timeoutMs }
  );
}

// ─── Android Auto / CarPlay projection ────────────────────────────────────────
// digitalai:automotive.* execute commands (platform 26.4+), verified live 2026-10-09 on Appium Server Android phones
// (Pixel 7 / Pixel 8): start("800x480") takes ~20 s and brings up the Android Auto head unit (DHU); getScreenshot
// returns a base64 PNG of the projected display; tap(x, y) is in projection coordinates; stop ends it and the phone
// stays drivable; start works again after stop (any supported resolution). getDump is iOS-only ("not implemented for
// Android devices"); getScreenshot("cluster") is the CarPlay instrument cluster (on Android it returns the main display).
// When the session was created with digitalai:automotiveProjection, the platform refuses start AND stop. The capability
// is the more reliable route: a Galaxy S10 / Android 12 fails mid-session start("LOW") yet projects fine with it.
// Android Automotive OS emulators (e.g. @emulator='true' and @model='automotive_1024p_landscape') are NOT projection
// targets — the head unit IS the device, driven with the normal inspection tools; these commands fail there.

export type AutomotiveAction = 'start' | 'stop' | 'screenshot' | 'tap' | 'dump';

// ─── Audio (play into / record from the device's audio line) ───────────────────
// seetest:client.startAudioPlay / stopAudioPlay / startAudioRecording / stopAudioRecording, verified live 2026-10-16 on
// an Appium Server Android phone whose audio line is configured (device.bluetooth.state = PAIRED):
//  - play takes "cloud:<repository uniqueName>" of an uploaded audio file; it feeds the device's audio INPUT
//  - recording captures the device's audio OUTPUT into a NEW repository file "cloud:<name>"; when the device plays
//    nothing the file is a 44-byte header-only WAV (seen live — and in older call-test recordings)
//  - a device without an audio line fails every command: "Audio line is not configured for device: <udid>"
//  - digitalai:instrumentApp was not needed for the commands to run (the SIM-call use case sets it for call audio)
//  - waitForAudioPlayEnd returns immediately (UseCase-SIM-Card-Tests), so "play for N seconds" sleeps here instead
// Both stop commands take no arguments. The Grid runs 0-arg commands in the inline form (execScript), but audio on a
// Grid session has not been verified live, so the tool still refuses there.

export type AudioAction = 'play' | 'stop_play' | 'record_start' | 'record_stop';
export const WAV_HEADER_ONLY_BYTES = 44;

const cloudRef = (name: string) => (name.startsWith('cloud:') ? name : `cloud:${name}`);
const bareName = (name: string) => name.replace(/^cloud:/, '');

export async function audioControl(
  handle: string,
  action: AudioAction,
  opts: { file?: string; durationSeconds?: number; recordingName?: string } = {},
  deps: {
    /** Looked up in the session's project — "cloud:<name>" resolves within that project. */
    findRepositoryFile: (uniqueName: string, projectName?: string) => Promise<{ id: number; uniqueName: string; size: number } | undefined>;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<{ message: string; recording?: { id: number | null; name: string; size: number | null; headerOnly: boolean } }> {
  const session = requireSession(handle);
  if (session.platform === 'web') throw new Error('audio_control needs a mobile inspection session, not a browser session.');
  if (session.sessionFormat === 'jwp') {
    throw new Error('audio_control has only been verified on Appium Server sessions — use an Appium Server project (the Grid is unverified for the audio commands).');
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const client = makeClient();
  const run = (script: string, args: unknown[] = []) => execScript(client, session, script, args, 60_000);
  try {
    switch (action) {
      case 'play': {
        if (!opts.file) throw new Error('play needs file: the repository uniqueName of an audio file (see list_repository_files).');
        const found = await deps.findRepositoryFile(bareName(opts.file), session.projectName);
        if (!found) throw new Error(`No repository file named "${bareName(opts.file)}" — upload it with upload_repository_file, or pick one from list_repository_files.`);
        await run('seetest:client.startAudioPlay', [cloudRef(found.uniqueName)]);
        if (!opts.durationSeconds) {
          return { message: `Playing "${found.uniqueName}" into the device's audio input. Call stop_play when done (the platform's own "wait for end" does not block).` };
        }
        await sleep(opts.durationSeconds * 1000);
        await run('seetest:client.stopAudioPlay');
        return { message: `Played "${found.uniqueName}" for ${opts.durationSeconds} s, then stopped.` };
      }
      case 'stop_play':
        await run('seetest:client.stopAudioPlay');
        return { message: 'Playback stopped.' };
      case 'record_start': {
        if (session.audioRecording) throw new Error(`A recording ("${session.audioRecording}") is already running — record_stop it first.`);
        const name = bareName(opts.recordingName ?? `mcp-recording-${session.handle}-${Date.now()}.wav`);
        await run('seetest:client.startAudioRecording', [cloudRef(name)]);
        session.audioRecording = name;
        return { message: `Recording the device's audio output to repository file "${name}". Call record_stop to finish.` };
      }
      case 'record_stop': {
        const name = session.audioRecording;
        await run('seetest:client.stopAudioRecording');
        session.audioRecording = undefined;
        if (!name) return { message: 'Recording stopped (it was not started through audio_control, so the file name is unknown — check list_repository_files).' };
        let file: { id: number; uniqueName: string; size: number } | undefined;
        // The file can take a moment to be indexed — up to 5 lookups, sleeping only BETWEEN them.
        for (let i = 0; i < 5; i++) {
          if (i > 0) await sleep(2000);
          file = await deps.findRepositoryFile(name, session.projectName);
          if (file) break;
        }
        const headerOnly = !!file && file.size <= WAV_HEADER_ONLY_BYTES;
        const where = file ? `saved as repository file "${name}" (id ${file.id}, ${file.size} bytes) — download_repository_file to fetch it` : `not found in the repository yet under "${name}" — check list_repository_files shortly`;
        return {
          message: `Recording stopped, ${where}.` + (headerOnly ? ' ⚠️ The recording is EMPTY (header only): the device played no sound while recording. Recording captures the device\'s audio OUTPUT — start the media/call that produces sound before record_start.' : ''),
          recording: { id: file?.id ?? null, name, size: file?.size ?? null, headerOnly },
        };
      }
    }
  } catch (e) {
    throw new Error(`audio ${action} failed: ${describeWdError(e)}${/Audio line is not configured/i.test(describeWdError(e)) ? ' — this device has no audio line. Pick one with find_available_device(requireAudioLine: true).' : ''}`);
  }
}

export async function automotiveControl(
  handle: string,
  action: AutomotiveAction,
  opts: { resolution?: AutomotiveResolution; clusterContent?: InstrumentClusterContent; x?: number; y?: number; display?: 'main' | 'cluster' } = {}
): Promise<{ message: string; image?: { data: string; mimeType: string }; dump?: string }> {
  const session = requireSession(handle);
  if (session.platform === 'web') throw new Error('automotive_control needs a mobile inspection session (Android Auto / CarPlay), not a browser session.');
  const client = makeClient();
  const run = (script: string, args: unknown[], timeoutMs?: number) => execScript(client, session, script, args, timeoutMs);
  try {
    switch (action) {
      case 'start': {
        if (session.automotiveMode === 'capability') {
          return { message: 'Projection is already running — this session was started with automotiveProjection, and the platform refuses start/stop for such sessions.' };
        }
        if (session.automotiveRunning) return { message: 'Projection is already running for this session — call stop first to change resolution.' };
        const resolution = opts.resolution ?? '800x480';
        const args: unknown[] = [resolution];
        if (opts.clusterContent) {
          if (session.platform !== 'ios') throw new Error('clusterContent (instrument cluster) is CarPlay / iOS only.');
          args.push(opts.clusterContent);
        }
        await run('digitalai:automotive.start', args, 180_000);
        session.automotiveMode = 'command';
        session.automotiveRunning = true;
        return { message: `Projection started at ${resolution}${opts.clusterContent ? ` with cluster content "${opts.clusterContent}"` : ''}. Use action "screenshot" to see the head unit.` };
      }
      case 'stop': {
        if (session.automotiveMode === 'capability') {
          return { message: 'This session was started with automotiveProjection — projection stays on until the session ends (the platform refuses stop).' };
        }
        await run('digitalai:automotive.stop', [], 120_000);
        session.automotiveRunning = false;
        return { message: 'Projection stopped. The phone remains controllable with the normal inspection tools.' };
      }
      case 'screenshot': {
        const args = opts.display === 'cluster' ? ['cluster'] : [];
        const res = await run('digitalai:automotive.getScreenshot', args, 60_000);
        const data = String(res.data.value ?? '');
        if (!data) throw new Error('the platform returned an empty projection screenshot');
        const mimeType = data.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
        const note = opts.display === 'cluster' && session.platform !== 'ios' ? ' (the instrument cluster is CarPlay-only — Android returns the main display)' : '';
        return { message: `Projection screenshot captured${note}.`, image: { data, mimeType } };
      }
      case 'tap': {
        if (opts.x == null || opts.y == null) throw new Error('tap needs x and y in projection-display coordinates (e.g. 0–800 × 0–480 at 800x480).');
        await run('digitalai:automotive.tap', [opts.x, opts.y], 30_000);
        return { message: `Tapped the projected display at (${opts.x}, ${opts.y}).` };
      }
      case 'dump': {
        if (session.platform !== 'ios') throw new Error('dump is CarPlay / iOS only — the platform does not implement it for Android. Use action "screenshot" instead.');
        const res = await run('digitalai:automotive.getDump', [], 60_000);
        return { message: 'Projection element dump captured.', dump: String(res.data.value ?? '') };
      }
    }
  } catch (e) {
    throw new Error(`automotive_control ${action} failed: ${automotiveError(e, handle)}`);
  }
}

// The platform answers automotive commands it can't run with 404/500 + a specific message — NOT a dead session. Only
// fall back to the dead-session diagnosis (sessionAwareError) when the message is not one of these.
function automotiveError(e: unknown, handle: string): string {
  const detail = describeWdError(e);
  // Seen live 2026-10-14 (CarPlay, iPhone 13 Pro Max): the platform's own 60 s deadline on the host's projection service.
  if (/DEADLINE_EXCEEDED|deadline exceeded/i.test(detail)) {
    return (
      `${detail} — the device host's projection service did not answer within the platform's 60 s deadline. ` +
      'Call take_inspection_screenshot: if the phone shows "Allow CarPlay with \'CarPlay Simulator\' while phone is locked?", ' +
      'tap Allow (one-time consent) — then stop this session and start a NEW one before retrying, because the platform ' +
      'counts this start as executed. If it repeats, the host\'s projection service is not responding: report the host to ' +
      'your platform admin.'
    );
  }
  // Seen live 2026-10-14: the platform marks start as executed even when it failed, so a session gets ONE start attempt.
  if (/start command was already executed/i.test(detail)) {
    return (
      `${detail} — the platform allows one projection start per session, even after a failed attempt. ` +
      'stop_inspection_session, then start_inspection_session again (or start it with automotiveProjection) and retry.'
    );
  }
  if (/start\("?LOW"?\)|Failed to execute start/i.test(detail)) {
    return (
      `${detail} — the mid-session start command is not supported on this device. Start a new session with ` +
      `automotiveProjection instead (verified: a Galaxy S10 / Android 12 fails this command but projects fine with the ` +
      `capability; Pixel 7/8 support both). An Android Automotive OS emulator is not a projection target at all — drive it ` +
      `with the normal inspection tools.`
    );
  }
  if (/hybridRunJavascript/i.test(detail)) {
    // Verified live 2026-10-09 on an Appium Grid project: the Grid execute layer treats digitalai:automotive.* as page
    // JavaScript, so every automotive command fails — with or without the automotiveProjection capability.
    return (
      'Appium Grid does not support Android Auto / CarPlay projection commands (the Grid execute layer runs them as ' +
      'JavaScript). Use a project on Appium Server — projection is verified there.'
    );
  }
  if (/automotive|projection|DHU|cluster|GetDump/i.test(detail)) return detail;
  return sessionAwareError(e, handle);
}

// Start or end a Digital.ai performance transaction inside a live inspection
// session. The platform records CPU/memory/battery/network + Speed Index for
// the window between start and end; the agent runs the UI steps to measure in
// between using the normal tap/type/launch tools.
//
// These are seetest:client.* commands — the Digital.ai cloud proxy interprets
// them, not Appium, so they route through execScript on both Grid (/execute)
// and Appium Server / OSS (/execute/sync). The Grid execute parser cannot
// express a zero-argument seetest command in the bare form (the inline "cmd()" form does run there, see execScript), and
// the platform treats an empty profile as "3G-average" — so start REQUIRES an explicit network profile.
export async function performanceTransaction(
  handle: string,
  action: 'start' | 'end',
  opts: { networkProfile?: string; transactionName?: string; forApplication?: string }
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
      // Per-application variant (verified live 2026-10-18, Android + iOS): CPU/memory/battery are sampled for ONE app
      // (the one named) instead of the whole device; the start call took ~18 s on both platforms (vs ~1 s for the
      // device-wide form) — the platform attaches to the process first. Platform docs: a transaction is capped at
      // 5 minutes, cancelled when the session quits, "NONE" means no NV profile, and no HAR is recorded while NV
      // tunneling is on.
      if (opts.forApplication) {
        await execScript(client, session, 'seetest:client.startPerformanceTransactionForApplication', [opts.forApplication, opts.networkProfile], 60_000);
      } else {
        await execScript(client, session, 'seetest:client.startPerformanceTransaction', [opts.networkProfile]);
      }
      const isMonitor = opts.networkProfile.toLowerCase() === 'monitor';
      const throttleNote = isMonitor
        ? `"Monitor" is pass-through — no throttling is applied, so there is no ANR risk from network shaping. `
        : `⚠️ NV throttling is now ACTIVE — if the app makes background network calls during this window it may ANR/crash; keep the measured window tight. `;
      return (
        `Started ${opts.forApplication ? `per-application performance transaction for ${opts.forApplication}` : 'performance transaction'} with NV profile "${opts.networkProfile}". ` +
        throttleNote +
        `Perform ONLY the UI steps you want measured, then call action:"end" (within 5 minutes — the platform cancels longer transactions, and quitting the session cancels it too).`
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

  await gestureWithFallback(session, w3c, jwp);
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

  await gestureWithFallback(session, w3c, jwp);
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

  await gestureWithFallback(session, w3c, jwp);
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
  const client = makeClient();

  // iOS Appium Server: XCUITest scrolls the application element to a name / predicate in ONE call (no page-source
  // polling). `mobile: scroll` only targets the app under test ("application ... is not running" when another app is
  // in front — verified live 2026-10-18), so a failure here just falls through to the swipe loop below.
  if (session.sessionFormat === 'w3c' && session.platform === 'ios' && !isWebviewContext(session) &&
      (using === 'accessibility id' || using === '-ios predicate string')) {
    const args = using === 'accessibility id' ? { name: value, direction: direction === 'up' ? 'down' : 'up' } : { predicateString: value, direction: direction === 'up' ? 'down' : 'up' };
    try {
      await execScript(client, session, 'mobile: scroll', [args], 20_000);
      const found = await findElements(handle, using, value, { maxEnriched: 1 });
      if (found.length > 0) return { found: true, element: found[0], swipesUsed: 1, reachedEnd: false };
    } catch {
      // fall through to the generic loop
    }
  }

  // Android Appium Server: `mobile: scrollGesture` answers canScrollMore, a real end-of-list signal that replaces the
  // page-source diff (one full XML dump per swipe). `mobile: scroll` (UiScrollable) was tried first and dropped: it
  // fails with "Cannot scroll to UiSelector[...]" on the first scrollable it picks (Settings on Samsung/LG, the
  // ExperiBank country dialog) — verified live 2026-10-18.
  if (session.sessionFormat === 'w3c' && session.platform === 'android' && !isWebviewContext(session)) {
    const area = { left: Math.round(width * 0.1), top: Math.round(height * 0.15), width: Math.round(width * 0.8), height: Math.round(height * 0.7) };
    for (let i = 0; i <= maxSwipes; i++) {
      const found = await findElements(handle, using, value, { maxEnriched: 1 });
      if (found.length > 0) return { found: true, element: found[0], swipesUsed, reachedEnd: false };
      if (i === maxSwipes) break;
      let canScrollMore: boolean | null = null;
      try {
        // direction is the FINGER direction (same convention as swipeGesture): 'up' reveals the content below. Verified
        // live 2026-10-18 — mapping it the other way ended a Settings scroll after two swipes with canScrollMore=false.
        const r = await execScript(client, session, 'mobile: scrollGesture', [{ ...area, direction, percent: 0.8 }], 20_000);
        canScrollMore = asBool(r.data.value);
      } catch {
        canScrollMore = null; // unknown-command (older agent) → use the raw swipe instead
      }
      if (canScrollMore == null) await swipeScreen(handle, midX, startY, midX, endY, 500);
      swipesUsed++;
      await new Promise((r) => setTimeout(r, 500));
      if (canScrollMore === false) {
        const last = await findElements(handle, using, value, { maxEnriched: 1 });
        return last.length > 0
          ? { found: true, element: last[0], swipesUsed, reachedEnd: false }
          : { found: false, element: null, swipesUsed, reachedEnd: true };
      }
    }
    return { found: false, element: null, swipesUsed, reachedEnd: false };
  }

  let lastSource = '';
  for (let i = 0; i <= maxSwipes; i++) {
    const found = await findElements(handle, using, value, { maxEnriched: 1 });
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
// mobile: pressButton supports only home / volumeup / volumedown on a real device ("The button 'power' is not
// supported", verified live 2026-10-17, iPhone 13 mini / iOS 17.6). POWER is handled separately below with
// mobile: lock / unlock (both returned OK on the same device); the Grid's deviceAction("Lock") stays as its fallback.
const IOS_BUTTONS: Record<string, { w3c: string | null; grid: string }> = {
  HOME: { w3c: 'home', grid: 'Home' },
  VOLUME_UP: { w3c: 'volumeup', grid: 'Volume Up' },
  VOLUME_DOWN: { w3c: 'volumedown', grid: 'Volume Down' },
  POWER: { w3c: null, grid: 'Lock' },
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
    let w3cResult = key!;
    const w3c = async () => {
      if (button.w3c) {
        await execScript(client, session, 'mobile: pressButton', [{ name: button.w3c }]);
        return;
      }
      // POWER = toggle the lock state: lock when unlocked, unlock when locked (a physical side-button press does both).
      const locked = (await execScript(client, session, 'mobile: isLocked', [{}])).data.value === true;
      await execScript(client, session, locked ? 'mobile: unlock' : 'mobile: lock', [{}]);
      w3cResult = locked ? 'POWER (device unlocked)' : 'POWER (device locked — press POWER again to unlock)';
    };
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
    return w3cResult;
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

export type AppControlAction = 'terminate' | 'clear_data' | 'query_state' | 'deep_link' | 'background' | 'is_installed' | 'current' | 'install';

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
  url?: string,
  opts: { seconds?: number; appRef?: string } = {}
): Promise<string> {
  const session = requireSession(handle);
  const client = makeClient();
  const sid = session.gridSessionId;
  const isW3c = session.sessionFormat === 'w3c';

  const isIos = session.platform === 'ios';
  const idArg = (pkg: string) => (isIos ? { bundleId: pkg } : { appId: pkg });

  switch (action) {
    // Verified live 2026-10-18 (Appium Server, Galaxy Note 20 / iPhone 13 Pro Max): backgroundApp returns after the
    // seconds elapse and the app is in the foreground again (queryAppState 4); isAppInstalled → true/false;
    // getCurrentActivity/getCurrentPackage (Android) and activeAppInfo (iOS); `mobile: installApp {appPath: "cloud:…"}`
    // installs from the Digital.ai repository mid-session (the `app` key is rejected: "required parameter appPath").
    case 'background': {
      const seconds = Math.max(1, Math.round(opts.seconds ?? 3));
      if (!isW3c) throw new Error('background is not available on Appium Grid sessions — press HOME (press_key) and relaunch with launch_app instead.');
      await execScript(client, session, 'mobile: backgroundApp', [{ seconds }], (seconds + 20) * 1000);
      return `App sent to the background for ${seconds} s and brought back to the foreground. Verify the restored screen with take_inspection_screenshot.`;
    }
    case 'is_installed': {
      if (!packageName) throw new Error('is_installed requires packageName (Android) or bundleIdentifier (iOS).');
      if (!isW3c) throw new Error('is_installed is not available on Appium Grid sessions — use list_applications / get_application_info, or launch_app and read the error.');
      const r = await execScript(client, session, 'mobile: isAppInstalled', [idArg(packageName)]);
      return `${packageName} is ${r.data.value === true ? '' : 'NOT '}installed on ${session.deviceName || 'this device'}.`;
    }
    case 'current': {
      if (isW3c && isIos) {
        const r = await execScript(client, session, 'mobile: activeAppInfo');
        const v = r.data.value as { bundleId?: string; name?: string; pid?: number };
        return `Foreground app: ${v.bundleId ?? 'unknown'}${v.name ? ` (${v.name})` : ''}${v.pid != null ? `, pid ${v.pid}` : ''}.`;
      }
      if (isW3c) {
        const [act, pkg] = await Promise.all([
          execScript(client, session, 'mobile: getCurrentActivity').then((r) => String(r.data.value ?? '')),
          execScript(client, session, 'mobile: getCurrentPackage').then((r) => String(r.data.value ?? '')),
        ]);
        return `Foreground: package ${pkg}, activity ${act}.`;
      }
      if (isIos) throw new Error('current is not available on Grid iOS sessions — use take_inspection_screenshot.');
      const res = await client.get(`/session/${sid}/appium/device/current_activity`, { timeout: 15_000 });
      return `Foreground activity: ${String(res.data.value ?? '')} (Grid sessions report the activity only).`;
    }
    case 'install': {
      const ref = opts.appRef ?? packageName;
      if (!ref) throw new Error('install requires appRef — a repository reference such as "cloud:com.example.app" (Android: "cloud:com.example.app/.MainActivity"), "cloud:uniqueName=<name>" or "cloud:<package>:releaseVersion=<v>".');
      const appPath = ref.startsWith('cloud:') ? ref : `cloud:${ref}`;
      if (!isW3c) throw new Error('install mid-session is not available on Appium Grid sessions — install_application before the session (the device must not be reserved).');
      await execScript(client, session, 'mobile: installApp', [{ appPath }], 180_000);
      return `Installed ${appPath} from the repository onto ${session.deviceName || 'the device'}. Use launch_app to open it.`;
    }
    case 'terminate': {
      if (!packageName) throw new Error('terminate requires packageName (Android) or bundleIdentifier (iOS).');
      if (isW3c) {
        // timeout: how long the driver waits for the process to disappear before answering false (UiAutomator2 default
        // 500 ms — a slow-exiting app was reported "was not running"); verified live 2026-10-17 with 2000.
        const args = isIos ? { bundleId: packageName } : { appId: packageName, timeout: 3000 };
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
  const client = makeClient();
  if (session.sessionFormat === 'jwp') {
    // seetest:client.clearLocation() — inline 0-arg form (execScript adds the parentheses on the Grid).
    await execScript(client, session, 'seetest:client.clearLocation', []);
    return;
  }
  const script = session.platform === 'ios' ? 'mobile: resetSimulatedLocation' : 'mobile: resetGeolocation';
  await execScript(client, session, script, [{}]);
}

/** Alert text and, on iOS Appium Server, its button labels (`mobile: alert getButtons` → ["Yes","No"] live 2026-10-18). */
export async function getAlertInfo(handle: string): Promise<{ text: string; buttons: string[] | null }> {
  const session = requireSession(handle);
  if (session.sessionFormat === 'jwp') {
    throw new Error('Alert routes are not supported on Appium Grid sessions (501) — dialogs are regular UI elements there: use get_element_tree / find_elements and tap_element.');
  }
  const client = makeClient();
  let text: string;
  try {
    const r = await client.get(`/session/${session.gridSessionId}/alert/text`, { timeout: 15_000 });
    text = String(r.data.value ?? '');
  } catch (e) {
    const detail = describeWdError(e).toLowerCase();
    if (detail.includes('no alert') || detail.includes('noalertopen') || detail.includes('modal dialog when one was not open')) throw new Error('No alert is present on the screen.');
    throw new Error(describeWdError(e));
  }
  let buttons: string[] | null = null;
  if (session.platform === 'ios') {
    try {
      const r = await execScript(client, session, 'mobile: alert', [{ action: 'getButtons' }]);
      buttons = Array.isArray(r.data.value) ? r.data.value.map(String) : null;
    } catch {
      buttons = null;
    }
  }
  return { text, buttons };
}

export async function handleAlert(
  handle: string,
  action: 'accept' | 'dismiss',
  buttonLabel?: string
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
    if (buttonLabel && session.platform === 'ios') {
      // XCUITest: pick the button by its label (plain /alert/accept presses the default one).
      await execScript(client, session, 'mobile: alert', [{ action, buttonLabel }]);
      return;
    }
    if (buttonLabel) {
      throw new Error('buttonLabel is iOS-only (mobile: alert). On Android tap the dialog button by text with find_elements + tap_element.');
    }
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

  // Both platforms take string replies (verified live 2026-10-17 — numeric LAError codes are refused on iOS:
  // "Invalid setAuthenticationReply() parameter 1 for iOS, possible values are: MockFullGUI, Success, StopMock,
  // AuthenticationFailedError, UserCancelError, UserFallbackError, SystemCancelError, PasscodeNotSetError,
  // TouchIDNotAvailableError, TouchIDNotEnrolledError, TouchIDLockoutError, AppCancelError, InvalidContextError";
  // Android: CLEAR_MOCK, AUTHENTICATION_SUCCEEDED, AUTHENTICATION_FAILED, ERROR_CANCELED, ERROR_HW_UNAVAILABLE,
  // ERROR_LOCKOUT, ERROR_NO_SPACE, ERROR_TIMEOUT, ERROR_UNABLE_TO_PROCESS, ERROR_VENDOR_BASE, FP_ACQUIRED_*).
  const replyValue: string =
    session.platform === 'ios'
      ? ({ success: 'Success', failed: 'AuthenticationFailedError', cancel: 'UserCancelError', clear: 'StopMock' } as const)[reply]
      : ({ success: 'AUTHENTICATION_SUCCEEDED', failed: 'AUTHENTICATION_FAILED', cancel: 'ERROR_CANCELED', clear: 'CLEAR_MOCK' } as const)[reply];

  // The platform rejects delay 0 ("Parameter delay must be a number greater than 0") on both platforms — so a zero
  // default made EVERY call fail until 2026-10-17. 1 ms is the smallest accepted value.
  const delay = Math.max(1, Math.floor(delayMs));

  try {
    await execScript(client, session, 'seetest:client.setAuthenticationReply', [replyValue, delay]);
  } catch (e) {
    const detail = describeWdError(e);
    if (/not instrumented/i.test(detail)) {
      throw new Error(
        `${detail}. The app under test must be instrumented: re-upload it with instrument=true (upload_application_file / ` +
        `upload_application_from_url) or start the session with the digitalai:instrumentApp capability, then launch it again.`
      );
    }
    throw new Error(detail);
  }

  const label = reply === 'clear' ? 'cleared (no mock active)' : `staged as "${reply}"`;
  return (
    `Authentication response ${label}. ` +
    `The next biometric prompt in the instrumented app will respond automatically.`
  );
}

// ─── Session capture: HAR + device log into the file repository ──────────────
// seetest:client.startHarRecording("cloud:<name>.har") / stopHarRecording(), startLoggingDevice("cloud:<name>.log") /
// stopLoggingDevice() — verified live 2026-10-18 on Appium Server Android + iOS and 2026-10-19 on the Grid (the 0-arg
// stops run inline there, see execScript). The HAR lands as a ZIP that contains `har.json`; with NV tunneling on (this tenant) the platform
// records no entries, so the ZIP is ~290 bytes — the tool says so instead of handing over an empty capture.

export type CaptureKind = 'har' | 'device_log';

export async function sessionCapture(
  handle: string,
  kind: CaptureKind,
  action: 'start' | 'stop',
  name?: string
): Promise<{ file: string; repositoryFile?: { id: number; size: number }; note?: string }> {
  const session = requireSession(handle);
  const client = makeClient();
  const field = kind === 'har' ? 'harRecording' : 'deviceLogRecording';
  if (action === 'start') {
    if (session[field]) throw new Error(`A ${kind} capture ("${session[field]}") is already running — stop it first.`);
    const base = (name ?? `mcp-${kind}-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`).replace(/^cloud:/, '');
    const file = kind === 'har' ? (base.endsWith('.har') ? base : `${base}.har`) : (base.endsWith('.log') ? base : `${base}.log`);
    try {
      await execScript(client, session, kind === 'har' ? 'seetest:client.startHarRecording' : 'seetest:client.startLoggingDevice', [`cloud:${file}`], 60_000);
    } catch (e) {
      throw new Error(sessionAwareError(e, handle));
    }
    session[field] = file;
    return { file };
  }
  const file = session[field];
  if (!file) throw new Error(`No ${kind} capture is running on this session — start one first.`);
  try {
    await execScript(client, session, kind === 'har' ? 'seetest:client.stopHarRecording' : 'seetest:client.stopLoggingDevice', [], 60_000);
  } catch (e) {
    throw new Error(sessionAwareError(e, handle));
  }
  session[field] = undefined;
  let repositoryFile: { id: number; size: number } | undefined;
  let note: string | undefined;
  try {
    const { listFiles } = await import('./repository.js');
    for (let i = 0; i < 5 && !repositoryFile; i++) {
      const hit = (await listFiles()).find((f) => f.uniqueName === file);
      if (hit) repositoryFile = { id: hit.id, size: Number(hit.size ?? 0) };
      else await new Promise((r) => setTimeout(r, 1500));
    }
  } catch {
    // listing is best-effort
  }
  if (kind === 'har' && repositoryFile && repositoryFile.size < 400) {
    note = 'The HAR holds no entries: the platform does not record HTTP traffic while NV tunneling is on for the device (platform docs), and this tenant tunnels every device. Use a performance transaction for network byte counts instead.';
  }
  return { file, repositoryFile, note };
}

// ─── Network connection / conditions ─────────────────────────────────────────
// seetest:client.getNetworkConnection(kind) → boolean and setNetworkConnection(kind, enabled) for wifi / mobile_data /
// airplane_mode / bluetooth — verified live 2026-10-18 on a Galaxy Note 20 (get all four; set bluetooth off/on). iOS
// answered get wifi → true; set is Android-only per the platform docs. setNetworkConditions(profile, durationMs) applies
// an NV profile WITHOUT a transaction (0 = until changed); docs restrict it to Project Admin and above.

export type NetworkConnectionKind = 'wifi' | 'mobile_data' | 'airplane_mode' | 'bluetooth';

export async function networkConnection(
  handle: string,
  kind: NetworkConnectionKind,
  enabled?: boolean
): Promise<{ kind: NetworkConnectionKind; enabled: boolean }> {
  const session = requireSession(handle);
  if (enabled != null && session.platform === 'ios') {
    throw new Error('setNetworkConnection is Android-only (platform docs) — on iOS only the read-back works.');
  }
  const client = makeClient();
  try {
    if (enabled != null) {
      await execScript(client, session, 'seetest:client.setNetworkConnection', [kind, enabled]);
    }
    const r = await execScript(client, session, 'seetest:client.getNetworkConnection', [kind]);
    return { kind, enabled: r.data.value === true };
  } catch (e) {
    throw new Error(sessionAwareError(e, handle));
  }
}

export async function setNetworkConditions(handle: string, profile: string, durationMs = 0): Promise<string> {
  const session = requireSession(handle);
  const client = makeClient();
  try {
    await execScript(client, session, 'seetest:client.setNetworkConditions', [profile, Math.max(0, Math.round(durationMs))]);
  } catch (e) {
    throw new Error(sessionAwareError(e, handle));
  }
  return `NV profile "${profile}" applied to the device's traffic${durationMs > 0 ? ` for ${Math.round(durationMs / 1000)} s` : ' until changed (apply "Monitor" or quit the session to lift it)'}. No transaction is recorded — this only shapes the network.`;
}

// ─── Camera image injection ──────────────────────────────────────────────────
// seetest:client.simulateCapture(source): "cloud:<repository file>" or an http(s) URL; the platform checks the
// extension first ("Only the following are supported:[jpg, jpeg, png]", live 2026-10-18) and needs the app under test
// instrumented (digitalai:instrumentApp=true / instrument=true at upload) — not instrumented → "application is not
// instrumented", the same gate as setAuthenticationReply.

export async function injectCameraImage(handle: string, source: string): Promise<string> {
  const session = requireSession(handle);
  const client = makeClient();
  const src = source.trim();
  if (!/\.(jpe?g|png)(\?.*)?$/i.test(src)) {
    throw new Error(`"${src}" is not a jpg/jpeg/png — the platform accepts only those extensions (a repository file "cloud:<uniqueName>.png" or an http(s) URL ending in .jpg/.jpeg/.png).`);
  }
  if (!/^(cloud:|https?:\/\/)/i.test(src)) {
    throw new Error('source must be "cloud:<repository uniqueName>" (upload the image with upload_repository_file first) or an http(s) URL.');
  }
  try {
    await execScript(client, session, 'seetest:client.simulateCapture', [src], 60_000);
  } catch (e) {
    const detail = describeWdError(e);
    if (/not instrumented/i.test(detail)) {
      throw new Error(`${detail}. Camera injection needs an instrumented build: re-upload the app with instrument=true, or start the session with digitalai:instrumentApp=true, then launch it again.`);
    }
    throw new Error(sessionAwareError(e, handle));
  }
  return `Camera injection armed with ${src}: the next camera capture in the instrumented app returns this image instead of the sensor frame.`;
}

export async function clearWebCache(handle: string): Promise<void> {
  const session = requireSession(handle);
  try {
    await execScript(makeClient(), session, 'seetest:client.hybridClearCache', [], 60_000);
  } catch (e) {
    throw new Error(sessionAwareError(e, handle));
  }
}

// ─── Device diagnostics (Appium Server) ──────────────────────────────────────
// Verified live 2026-10-18/19: Android `mobile: deviceInfo` (apiVersion, brand, model, locale, timeZone, realDisplaySize,
// displayDensity, carrierName, networks), `batteryInfo` {level, state}, `getSystemBars`, `getDisplayDensity`,
// `getDeviceTime`, `isLocked`, `getUiMode`/`setUiMode {mode:'night', value:'yes'|'no'}` (dark mode; getNotifications
// fails to parse on Samsung — not exposed). iOS `deviceInfo` (currentLocale, timeZone, userInterfaceStyle, thermalState,
// isSimulator, model), `batteryInfo`, `deviceScreenInfo` {statusBarSize, scale, screenSize}, `get/setAppearance
// {style:'dark'|'light'}`, `performAccessibilityAudit` (XCTest audit — array of findings), `isLocked`.
// NEVER use the "-image" locator strategy: a single find killed the agent's Appium process on both platforms (every
// later command "Connection refused"); the image plugin is not loaded on the cloud agents.

export async function deviceDiagnostics(handle: string): Promise<Record<string, unknown>> {
  const session = requireSession(handle);
  if (session.sessionFormat !== 'w3c') throw new Error('device_info needs an Appium Server session (mobile: deviceInfo is not available on the Grid) — get_device_detail reads the platform record instead.');
  const client = makeClient();
  const call = async (script: string, args: unknown[] = [{}]) => { try { return (await execScript(client, session, script, args, 20_000)).data.value; } catch { return undefined; } };
  const info = (await call('mobile: deviceInfo')) as Record<string, unknown> | undefined;
  const battery = (await call('mobile: batteryInfo')) as Record<string, unknown> | undefined;
  const locked = await call('mobile: isLocked');
  if (session.platform === 'ios') {
    const screen = (await call('mobile: deviceScreenInfo')) as Record<string, unknown> | undefined;
    const appearance = (await call('mobile: getAppearance')) as { style?: string } | undefined;
    return {
      platform: 'iOS', model: info?.model, name: info?.name, locale: info?.currentLocale, timeZone: info?.timeZone,
      isSimulator: info?.isSimulator, thermalState: info?.thermalState, appearance: appearance?.style ?? info?.userInterfaceStyle,
      battery, screen, locked,
    };
  }
  const bars = await call('mobile: getSystemBars');
  const density = await call('mobile: getDisplayDensity');
  const time = await call('mobile: getDeviceTime', [{ format: 'YYYY-MM-DD HH:mm:ss Z' }]);
  const night = await call('mobile: getUiMode', [{ mode: 'night' }]);
  return {
    platform: 'Android', brand: info?.brand, model: info?.model, manufacturer: info?.manufacturer, apiVersion: info?.apiVersion,
    platformVersion: info?.platformVersion, locale: info?.locale, timeZone: info?.timeZone, carrier: info?.carrierName,
    realDisplaySize: info?.realDisplaySize, displayDensity: density ?? info?.displayDensity, systemBars: bars,
    appearance: night === 'yes' ? 'dark' : night === 'no' ? 'light' : undefined, deviceTime: time, battery, locked,
  };
}

export async function setAppearance(handle: string, style: 'dark' | 'light'): Promise<string> {
  const session = requireSession(handle);
  if (session.sessionFormat !== 'w3c') throw new Error('appearance is Appium Server only (mobile: setAppearance / setUiMode).');
  const client = makeClient();
  // Remember the appearance the session started with, so the tool reminds the caller to restore it only when the
  // device is left different (intake 2026-10-19: restoring light still said "set it back").
  if (session.originalAppearance === undefined) {
    try {
      const before = session.platform === 'ios'
        ? String(((await execScript(client, session, 'mobile: getAppearance', [{}])).data.value as { style?: string })?.style ?? '')
        : ((await execScript(client, session, 'mobile: getUiMode', [{ mode: 'night' }])).data.value === 'yes' ? 'dark' : 'light');
      if (before === 'dark' || before === 'light') session.originalAppearance = before;
    } catch {
      // unknown — the reminder stays on
    }
  }
  if (session.platform === 'ios') {
    await execScript(client, session, 'mobile: setAppearance', [{ style }]);
    const r = await execScript(client, session, 'mobile: getAppearance', [{}]);
    return String((r.data.value as { style?: string })?.style ?? style);
  }
  await execScript(client, session, 'mobile: setUiMode', [{ mode: 'night', value: style === 'dark' ? 'yes' : 'no' }]);
  const r = await execScript(client, session, 'mobile: getUiMode', [{ mode: 'night' }]);
  return r.data.value === 'yes' ? 'dark' : 'light';
}

export async function accessibilityAudit(handle: string): Promise<Array<Record<string, unknown>>> {
  const session = requireSession(handle);
  if (session.platform !== 'ios' || session.sessionFormat !== 'w3c') {
    throw new Error('accessibility_audit runs XCTest\'s audit on iOS Appium Server sessions only. For Android (or a report-attached scan on either platform) generate the test with includeAxeScan.');
  }
  const r = await execScript(makeClient(), session, 'mobile: performAccessibilityAudit', [{}], 60_000);
  return Array.isArray(r.data.value) ? (r.data.value as Array<Record<string, unknown>>) : [];
}

// ─── Webview contexts ─────────────────────────────────────────────────────────
// Verified live 2026-10-18 (Appium Server): ExperiBank iOS exposes "WEBVIEW_<pid>.1" (its balance page) once logged
// in; Chrome on Android exposes "WEBVIEW_chrome" with page titles/urls via `mobile: getContexts`, which also waits for
// a webview to appear (`waitForWebviewMs`) — GET /contexts immediately after an app switch listed none. An "OCR"
// context (plugin) is listed on Appium Server too. The Grid lists NATIVE_APP only (switching there is unverified).

export interface ContextInfo { id: string; title?: string; url?: string; bundleId?: string; package?: string }

export function isWebviewContext(session: InspectionSession): boolean {
  return !!session.currentContext && session.currentContext !== 'NATIVE_APP';
}

export async function listContexts(handle: string, waitMs = 3000): Promise<ContextInfo[]> {
  const session = requireSession(handle);
  const client = makeClient();
  if (session.sessionFormat === 'w3c') {
    try {
      const r = await execScript(client, session, 'mobile: getContexts', [{ waitForWebviewMs: waitMs }], waitMs + 20_000);
      const v = r.data.value;
      if (Array.isArray(v) && v.length) {
        const out: ContextInfo[] = [];
        for (const c of v as Array<Record<string, unknown>>) {
          if (typeof c === 'string') { out.push({ id: c }); continue; }
          if (c.id) { out.push({ id: String(c.id), title: c.title ? String(c.title) : undefined, url: c.url ? String(c.url) : undefined, bundleId: c.bundleId ? String(c.bundleId) : undefined }); continue; }
          // Android shape: { webview, info: { 'Android-Package' }, pages: [{ title, url, type }] }
          const pages = (c.pages as Array<Record<string, unknown>> | undefined)?.filter((pg) => pg.type === 'page') ?? [];
          const info = c.info as Record<string, unknown> | undefined;
          if (!c.webview) continue;
          out.push({ id: String(c.webview), package: info?.['Android-Package'] ? String(info['Android-Package']) : undefined, title: pages[0]?.title ? String(pages[0].title) : undefined, url: pages[0]?.url ? String(pages[0].url) : undefined });
        }
        if (!out.some((c) => c.id === 'NATIVE_APP')) out.unshift({ id: 'NATIVE_APP' });
        return out;
      }
    } catch {
      // fall back to the plain route
    }
  }
  const r = await client.get(`/session/${session.gridSessionId}/contexts`, { timeout: 15_000 });
  return (Array.isArray(r.data.value) ? r.data.value : []).map((c: unknown) => ({ id: String(c) }));
}

export async function switchContext(
  handle: string,
  target: 'native' | 'auto' | string,
  waitMs = 3000
): Promise<{ context: string; title?: string; url?: string; available: string[] }> {
  const session = requireSession(handle);
  const client = makeClient();
  const contexts = await listContexts(handle, target === 'native' ? 0 : waitMs);
  const ids = contexts.map((c) => c.id);
  let name: string;
  if (target === 'native') name = 'NATIVE_APP';
  else if (target === 'auto') {
    const web = ids.find((id) => /^WEBVIEW/i.test(id));
    if (!web) {
      throw new Error(
        `No WEBVIEW context is available (contexts: ${ids.join(', ') || 'none'}). The screen in front has no web content, ` +
        `or the webview is not debuggable (Android: WebView.setWebContentsDebuggingEnabled(true) in a debug build; ` +
        `iOS: the app must be built with web inspection allowed). Navigate to the hybrid screen first, then retry.`
      );
    }
    name = web;
  } else {
    if (!ids.includes(target)) throw new Error(`Context "${target}" is not available (contexts: ${ids.join(', ') || 'none'}).`);
    name = target;
  }
  try {
    await client.post(`/session/${session.gridSessionId}/context`, { name }, { timeout: 30_000 });
  } catch (e) {
    throw new Error(`Switching to ${name} failed: ${describeWdError(e)}`);
  }
  session.currentContext = name;
  const result: { context: string; title?: string; url?: string; available: string[] } = { context: name, available: ids };
  if (name !== 'NATIVE_APP') {
    try { result.title = String((await client.get(`/session/${session.gridSessionId}/title`, { timeout: 10_000 })).data.value ?? ''); } catch { /* optional */ }
    try { result.url = String((await client.get(`/session/${session.gridSessionId}/url`, { timeout: 10_000 })).data.value ?? ''); } catch { /* optional */ }
  }
  return result;
}

// ─── Device log (in-session) ─────────────────────────────────────────────────
// GET /log/types → Android: logcat, bugreport, server (Grid: logcat); iOS: syslog, crashlog, performance,
// safariConsole, safariNetwork, server. POST /log {type} returns every line captured so far (3 580 logcat / 9 548
// syslog lines live 2026-10-18), so the tail is cut here and `contains` filters before anything is returned.

export async function getDeviceLog(
  handle: string,
  type?: string,
  opts: { tail?: number; contains?: string } = {}
): Promise<{ type: string; totalLines: number; lines: string[]; types: string[] }> {
  const session = requireSession(handle);
  const client = makeClient();
  let types: string[] = [];
  try {
    const r = await client.get(`/session/${session.gridSessionId}/log/types`, { timeout: 15_000 });
    types = Array.isArray(r.data.value) ? r.data.value.map(String) : [];
  } catch {
    types = [];
  }
  const wanted = type ?? (session.platform === 'ios' ? 'syslog' : 'logcat');
  if (types.length && !types.includes(wanted)) {
    throw new Error(`Log type "${wanted}" is not available on this session. Available: ${types.join(', ')}.`);
  }
  let entries: Array<{ message?: string; timestamp?: number; level?: string }>;
  try {
    const r = await client.post(`/session/${session.gridSessionId}/log`, { type: wanted }, { timeout: 60_000 });
    entries = Array.isArray(r.data.value) ? r.data.value : [];
  } catch (e) {
    throw new Error(`Reading the ${wanted} log failed: ${describeWdError(e)}`);
  }
  let lines = entries.map((e) => (typeof e === 'string' ? e : String(e.message ?? '')));
  const totalLines = lines.length;
  if (opts.contains) {
    const needle = opts.contains.toLowerCase();
    lines = lines.filter((l) => l.toLowerCase().includes(needle));
  }
  const tail = Math.max(1, opts.tail ?? 200);
  return { type: wanted, totalLines, lines: lines.slice(-tail), types };
}

export function registerSession(session: InspectionSession): void {
  sessionRegistry.set(session.handle, session);
  if (session.reportTestId > 0) allReports.set(session.reportTestId, session.projectName);
}

/**
 * The Android activity in the foreground right now, or null when it cannot be read (iOS has no equivalent; a
 * failure here is never fatal). Used by start_inspection_session: with noReset=true (the default) an app that was
 * already running resumes on its LAST screen, not the activity the caller named — an agent that assumed the
 * login screen then wasted three calls on "No element found" (remediation note 2026-10-14).
 */
export async function getForegroundActivity(handle: string): Promise<string | null> {
  const session = requireSession(handle);
  if (session.platform !== 'android') return null;
  try {
    const res = await makeClient().get(`/session/${session.gridSessionId}/appium/device/current_activity`, { timeout: 15_000 });
    const activity = res.data?.value;
    return typeof activity === 'string' && activity ? activity : null;
  } catch {
    return null;
  }
}

/** True when `current` is the activity the caller asked for — `.LoginActivity` vs `com.x.app.LoginActivity` are the same screen. */
export function isSameActivity(requested: string, current: string): boolean {
  const tail = (a: string) => a.split(/[./]/).filter(Boolean).pop()?.toLowerCase() ?? '';
  return tail(requested) === tail(current);
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

/** Session starts the client gave up on (POST /session timeout) — the platform may have completed them later. */
const timedOutStarts: Array<{ testName: string; projectName: string | undefined; requestedAt: number }> = [];
/** Client-side timeouts per device query in this process — a repeat gets an explicit "don't retry unchanged". */
const timedOutQueries = new Map<string, number>();

/**
 * Register the reports that timed-out starts created after the client stopped waiting, so cleanup_inspection_sessions
 * can delete them. Any status counts (the session may still be running or have idled out). A start whose report
 * has not appeared stays pending for the next sweep. Returns the newly tracked report IDs. Never throws.
 */
export async function sweepTimedOutStarts(): Promise<number[]> {
  const found: number[] = [];
  for (const start of [...timedOutStarts]) {
    try {
      const batch = await listTests({ limit: 10, filter: [{ property: 'name', operator: '=', value: start.testName }] }, undefined, start.projectName);
      const ids = (batch.data ?? [])
        .filter((r) => new Date(r.start_time).getTime() >= start.requestedAt - 15_000 && !allReports.has(r.test_id))
        .map((r) => r.test_id);
      for (const id of ids) {
        allReports.set(id, start.projectName);
        found.push(id);
      }
      if (ids.length > 0) timedOutStarts.splice(timedOutStarts.indexOf(start), 1);
    } catch {
      // Reporter unreachable — try again on the next sweep.
    }
  }
  return found;
}

export async function deleteAllTrackedReports(): Promise<{ deleted: number[]; failed: number[] }> {
  if (allReports.size === 0) return { deleted: [], failed: [] };
  // Group by originating project — each project's reports live in its own
  // reporter instance and must be deleted with a matching projectName scope.
  const byProject = new Map<string | undefined, number[]>();
  for (const [id, project] of allReports) {
    const list = byProject.get(project) ?? [];
    list.push(id);
    byProject.set(project, list);
  }
  // Tolerate per-project failures: one project's delete failing must not abort
  // the rest, and failed reports stay tracked so a later cleanup can retry them.
  const deleted: number[] = [];
  const failed: number[] = [];
  for (const [project, ids] of byProject) {
    try {
      await deleteTests(ids, undefined, project);
      for (const id of ids) {
        allReports.delete(id);
        deleted.push(id);
      }
    } catch {
      failed.push(...ids);
    }
  }
  return { deleted, failed };
}
