import axios, { AxiosInstance } from 'axios';
import type { InspectionSession } from '../types/digital-ai.js';
import { getMyAccountInfo } from './users.js';
import { getActiveKeyType, getActiveUrl, getActiveAccessKey } from './client.js';
import { registerSession, requireSession, listActiveSessions } from './webdriver.js';

function gridBase(): string {
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

function describeError(e: unknown): string {
  const err = e as { response?: { data?: { value?: { message?: string }; message?: string }; status?: number }; message?: string };
  const msg =
    err.response?.data?.value?.message ??
    err.response?.data?.message ??
    err.message ??
    String(e);
  const status = err.response?.status;
  return status ? `HTTP ${status}: ${msg}` : msg;
}

export interface BrowserSessionOptions {
  browserName: string;
  os?: string;
  reportName?: string;
}

export async function createBrowserInspectionSession(
  opts: BrowserSessionOptions
): Promise<InspectionSession> {
  const accessKey = getActiveAccessKey();
  if (!accessKey) throw new Error('DIGITAL_AI_ACCESS_KEY not configured');

  let projectName: string | undefined;
  try {
    projectName = (await getMyAccountInfo()).project?.name;
  } catch {
    // Non-fatal
  }

  const browserName = opts.browserName.toLowerCase();
  const reportName = opts.reportName ?? `[MCP Browser Inspection] ${opts.browserName}`;

  // Browsers are pure W3C — send both desiredCapabilities (legacy compat) and
  // capabilities.alwaysMatch. digitalai:* keys already contain the colon prefix
  // so they pass through to alwaysMatch without the appium: prefix.
  const caps: Record<string, unknown> = {
    browserName,
    'digitalai:accessKey': accessKey,
    'digitalai:reportName': reportName,
  };
  if (opts.os) caps['platformName'] = opts.os;

  const client = makeClient();
  let res;
  try {
    res = await client.post('/session', {
      desiredCapabilities: caps,
      capabilities: { alwaysMatch: caps, firstMatch: [{}] },
    });
  } catch (e) {
    throw new Error(
      `Browser session creation failed: ${describeError(e)}. ` +
      `Check that the requested browser (${opts.browserName}) is available via list_available_browsers.`
    );
  }

  // Browsers always respond in W3C format
  const value = res.data.value ?? {};
  const sessionCaps: Record<string, unknown> = value.capabilities ?? value ?? {};
  const gridSessionId: string = value.sessionId ?? res.data.sessionId ?? '';

  if (!gridSessionId) {
    throw new Error('Browser session created but no sessionId in response');
  }

  const rawId = sessionCaps['digitalai:reportTestId'];
  const reportTestId = rawId ? parseInt(String(rawId), 10) : 0;
  const canDeleteReport = getActiveKeyType() === 'jwt';

  const handle = crypto.randomUUID().slice(0, 8).toUpperCase();
  const session: InspectionSession = {
    handle,
    gridSessionId,
    reportTestId,
    reportUrl: String(sessionCaps['digitalai:reportUrl'] ?? ''),
    cloudViewLink: null, // No Mobile Studio for browser sessions
    deviceUDID: '',
    deviceName: `${opts.browserName}${opts.os ? ` on ${opts.os}` : ''}`,
    deviceModel: opts.browserName,
    deviceOs: opts.os ?? 'Web',
    deviceVersion: String(sessionCaps['browserVersion'] ?? sessionCaps['version'] ?? ''),
    appPackage: '',
    startedAt: Date.now(),
    lastUsedAt: Date.now(),
    canDeleteReport,
    sessionFormat: 'w3c',
    platform: 'web',
    browserName: opts.browserName,
    currentUrl: '',
    projectName,
  };

  registerSession(session);
  return session;
}

export async function navigateTo(handle: string, url: string): Promise<void> {
  const session = requireSession(handle);
  if (session.platform !== 'web') {
    throw new Error(`navigate_to is for browser sessions only. Use launch_app for mobile sessions.`);
  }
  const client = makeClient();
  try {
    await client.post(`/session/${session.gridSessionId}/url`, { url }, { timeout: 60_000 });
  } catch (e) {
    throw new Error(`navigate_to failed: ${describeError(e)}`);
  }
  // Wait for readyState === 'complete' (up to 30s)
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await client.post(
        `/session/${session.gridSessionId}/execute/sync`,
        { script: 'return document.readyState', args: [] },
        { timeout: 10_000 }
      );
      if (r.data.value === 'complete') break;
    } catch {
      break; // If the execute fails, don't block
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  // Update currentUrl in session
  try {
    const urlRes = await client.get(`/session/${session.gridSessionId}/url`, { timeout: 10_000 });
    session.currentUrl = String(urlRes.data.value ?? url);
  } catch {
    session.currentUrl = url;
  }
}

export async function getCurrentUrl(handle: string): Promise<string> {
  const session = requireSession(handle);
  const client = makeClient();
  const res = await client.get(`/session/${session.gridSessionId}/url`, { timeout: 10_000 });
  const url = String(res.data.value ?? '');
  session.currentUrl = url;
  return url;
}

export interface PageDomNode {
  tag: string;
  id?: string;
  name?: string;
  type?: string;
  placeholder?: string;
  ariaLabel?: string;
  role?: string;
  dataTestId?: string;
  text?: string;
  href?: string;
  shadowChildren?: PageDomNode[];
}

export interface PageDomResult {
  url: string;
  title: string;
  hasShadowDom: boolean;
  rawHtml?: string;
  elements?: PageDomNode[];
}

// Shadow DOM walker script — runs inside the browser via executeScript.
// Self-contained (no closures over outer scope) so it can be sent as a string.
const SHADOW_DOM_EXTRACT_SCRIPT = `
var extractDOM = function(root, depth) {
  if (depth > 3) return [];
  var acc = [];
  var skipTags = {SCRIPT:1,STYLE:1,HEAD:1,META:1,LINK:1,NOSCRIPT:1,SVG:1,PATH:1};
  var nodes = root.querySelectorAll('*');
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (skipTags[el.tagName]) continue;
    var node = {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      name: el.getAttribute('name') || undefined,
      type: el.getAttribute('type') || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      role: el.getAttribute('role') || undefined,
      dataTestId: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-cy') || undefined,
      href: (el.tagName === 'A' || el.tagName === 'LINK') ? (el.getAttribute('href') || undefined) : undefined
    };
    for (var j = 0; j < el.childNodes.length; j++) {
      if (el.childNodes[j].nodeType === 3) {
        var t = el.childNodes[j].textContent.trim();
        if (t) { node.text = t.slice(0, 80); break; }
      }
    }
    if (el.shadowRoot) {
      node.shadowChildren = extractDOM(el.shadowRoot, depth + 1);
    }
    if (node.id || node.name || node.dataTestId || node.ariaLabel || node.role || node.text || node.shadowChildren) {
      acc.push(node);
    }
  }
  return acc;
};
var hasShadow = Array.from(document.querySelectorAll('*')).some(function(el) { return el.shadowRoot !== null; });
return JSON.stringify({
  url: window.location.href,
  title: document.title,
  hasShadowDom: hasShadow,
  elements: extractDOM(document.body, 0)
});
`;

const SHADOW_DETECT_SCRIPT = `
return JSON.stringify({
  url: window.location.href,
  title: document.title,
  hasShadowDom: Array.from(document.querySelectorAll('*')).some(function(el) { return el.shadowRoot !== null; })
});
`;

export async function getPageDom(
  handle: string,
  shadowMode: 'auto' | 'always' | 'never' = 'auto',
  includeRawHtml = false
): Promise<PageDomResult> {
  const session = requireSession(handle);
  if (session.platform !== 'web') {
    throw new Error(`get_page_dom is for browser sessions only. Use get_element_tree for mobile sessions.`);
  }
  const client = makeClient();
  const sid = session.gridSessionId;

  // Phase 1: detect shadow DOM (also collects url + title cheaply)
  let metaResult: { url: string; title: string; hasShadowDom: boolean };
  try {
    const detectRes = await client.post(
      `/session/${sid}/execute/sync`,
      { script: SHADOW_DETECT_SCRIPT, args: [] },
      { timeout: 15_000 }
    );
    metaResult = JSON.parse(String(detectRes.data.value));
  } catch (e) {
    throw new Error(`get_page_dom detection phase failed: ${describeError(e)}`);
  }

  const useShadow =
    shadowMode === 'always' ||
    (shadowMode === 'auto' && metaResult.hasShadowDom);

  // Phase 2a: shadow expansion (runs recursive JS walker)
  if (useShadow) {
    try {
      const shadowRes = await client.post(
        `/session/${sid}/execute/sync`,
        { script: SHADOW_DOM_EXTRACT_SCRIPT, args: [] },
        { timeout: 30_000 }
      );
      const full: PageDomResult = JSON.parse(String(shadowRes.data.value));
      if (includeRawHtml) {
        const sourceRes = await client.get(`/session/${sid}/source`, { timeout: 20_000 });
        full.rawHtml = String(sourceRes.data.value ?? '');
      }
      // Update currentUrl
      session.currentUrl = full.url;
      return full;
    } catch (e) {
      throw new Error(`get_page_dom shadow extraction failed: ${describeError(e)}`);
    }
  }

  // Phase 2b: standard rendered DOM (GET /source returns the live rendered DOM in Selenium)
  try {
    const sourceRes = await client.get(`/session/${sid}/source`, { timeout: 20_000 });
    const rawHtml = String(sourceRes.data.value ?? '');
    session.currentUrl = metaResult.url;
    const result: PageDomResult = {
      url: metaResult.url,
      title: metaResult.title,
      hasShadowDom: metaResult.hasShadowDom,
    };
    if (includeRawHtml || shadowMode === 'never') result.rawHtml = rawHtml;
    // For non-shadow path, return rawHtml for the AI to parse; elements are optional
    if (!includeRawHtml) result.rawHtml = rawHtml; // always include for standard path
    return result;
  } catch (e) {
    throw new Error(`get_page_dom DOM extraction failed: ${describeError(e)}`);
  }
}

export async function browserNavigate(
  handle: string,
  action: 'back' | 'forward' | 'refresh'
): Promise<void> {
  const session = requireSession(handle);
  if (session.platform !== 'web') {
    throw new Error(`browser_action is for browser sessions only.`);
  }
  const client = makeClient();
  const sid = session.gridSessionId;
  const routes: Record<string, string> = { back: 'back', forward: 'forward', refresh: 'refresh' };
  try {
    await client.post(`/session/${sid}/${routes[action]}`, {}, { timeout: 30_000 });
  } catch (e) {
    throw new Error(`browser_action ${action} failed: ${describeError(e)}`);
  }
  // Refresh currentUrl after navigation
  try {
    const urlRes = await client.get(`/session/${sid}/url`, { timeout: 10_000 });
    session.currentUrl = String(urlRes.data.value ?? '');
  } catch {
    // Non-fatal
  }
}

export function listActiveBrowserSessions(): InspectionSession[] {
  return listActiveSessions().filter((s) => s.platform === 'web');
}
