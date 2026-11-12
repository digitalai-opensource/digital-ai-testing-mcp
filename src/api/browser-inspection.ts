import { canonicalBrowserName } from '../utils/browser-name.js';
import axios, { AxiosInstance } from 'axios';
import type { InspectionSession } from '../types/digital-ai.js';
import { getMyAccountInfo } from './users.js';
import { getActiveUrl, getActiveAccessKey } from './client.js';
import { checkDeleteAllowed } from './access-level.js';
import { registerSession, requireSession, listActiveSessions } from './webdriver.js';
import { extractApiErrorMessage } from '../utils/api-error.js';

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
  const err = e as { response?: { data?: unknown; status?: number }; message?: string };
  // WebDriver errors nest under `value`; the shared extractor handles every other shape (and never
  // yields "[object Object]" or an empty string).
  const data = err.response?.data;
  const value = data && typeof data === 'object' && 'value' in data ? (data as { value?: unknown }).value : undefined;
  const msg = extractApiErrorMessage(value ?? data, err.message ?? String(e));
  const status = err.response?.status;
  return status ? `HTTP ${status}: ${msg}` : msg;
}

export interface BrowserSessionOptions {
  browserName: string;
  os?: string;
  reportName?: string;
  /** W3C acceptInsecureCerts — load sites with self-signed/untrusted certificates (verified live 2026-11-12 on
   *  Chrome, Firefox, MicrosoftEdge and Safari against self-signed.badssl.com). */
  acceptInsecureCerts?: boolean;
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

  // Case-sensitive on the grid: lowercasing turned MicrosoftEdge into a rejected "microsoftedge" (verified live).
  const browserName = canonicalBrowserName(opts.browserName) ?? opts.browserName;
  const reportName = opts.reportName ?? `[MCP Browser Inspection] ${opts.browserName}`;

  // Browsers are pure W3C — send both desiredCapabilities (legacy compat) and
  // capabilities.alwaysMatch. digitalai:* keys already contain the colon prefix
  // so they pass through to alwaysMatch without the appium: prefix.
  const caps: Record<string, unknown> = {
    browserName,
    'digitalai:accessKey': accessKey,
    // digitalai:testName names the report; digitalai:reportName is ignored by the platform (verified 2026-10-16).
    'digitalai:testName': reportName,
  };
  if (opts.os) caps['platformName'] = opts.os;
  if (opts.acceptInsecureCerts) caps['acceptInsecureCerts'] = true;

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
  // Derived from the API (access level + the project's allowUsersDeleteTests), not the key format; fail open when undetermined.
  const canDeleteReport = (await checkDeleteAllowed(projectName)) === null;

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
    acceptInsecureCerts: opts.acceptInsecureCerts === true,
    currentUrl: '',
    projectName,
  };

  registerSession(session);
  return session;
}

/**
 * A site with a self-signed / untrusted certificate (verified live 2026-11-12 against self-signed.badssl.com):
 * Firefox refuses the navigation with "insecure certificate"; Chrome and Edge load a page titled "Privacy error" and
 * Safari one titled "This Connection Is Not Private", with no WebDriver error. Returns guidance, or null.
 */
export function certificateWarning(errorOrTitle: string | null | undefined): string | null {
  if (!errorOrTitle) return null;
  if (!/insecure certificate|^Privacy error$|^This Connection Is Not Private$/i.test(errorOrTitle.trim())) return null;
  return 'The site\'s TLS certificate is self-signed, expired or from an untrusted CA, so the browser showed its ' +
    'security warning instead of the page. If this is the user\'s staging/dev site, stop this session and start a new one ' +
    'with start_browser_inspection_session(acceptInsecureCerts: true), and pass acceptInsecureCerts: true to ' +
    'get_web_test_boilerplate.';
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
    const detail = describeError(e);
    const hint = certificateWarning(detail);
    throw new Error(`navigate_to failed: ${detail}${hint ? `\n${hint}` : ''}`);
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
  // Chrome/Edge/Safari answer a bad certificate with a warning page, not an error — surface it as one.
  if (!session.acceptInsecureCerts) {
    try {
      const t = await client.get(`/session/${session.gridSessionId}/title`, { timeout: 10_000 });
      const hint = certificateWarning(String(t.data.value ?? ''));
      if (hint) throw new Error(`navigate_to: the browser showed "${t.data.value}" for ${url}.\n${hint}`);
    } catch (e) {
      if ((e as Error).message.startsWith('navigate_to:')) throw e;
    }
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
    // SVG elements keep lowercase tagNames ("path"), so compare upper-cased — the skip never applied to them before.
    if (skipTags[el.tagName.toUpperCase()]) continue;
    // Decorative content: SVG internals and aria-hidden subtrees, unless the element itself is actionable
    // (UAT 2026-10-16: an icon's <path id="q"> was the first "interactive element" on example.com).
    var tabindex = el.getAttribute('tabindex');
    var actionable = el.getAttribute('role') || el.hasAttribute('onclick') || (tabindex !== null && tabindex !== '-1');
    if (!actionable && el.closest && (el.closest('svg') || el.closest('[aria-hidden="true"]'))) continue;
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

  // The walker extracts interactive elements whether or not shadow roots exist, so "auto" always uses it — the tool
  // promises structured elements by default. (UAT 2026-10-09: on a standard page "auto" returned only a raw-HTML
  // length, no elements and no HTML.) "never" remains the fast raw-HTML path.
  const useWalker = shadowMode !== 'never';

  // Phase 2a: element extraction (recursive JS walker — descends into shadow roots when present)
  if (useWalker) {
    try {
      const shadowRes = await client.post(
        `/session/${sid}/execute/sync`,
        { script: SHADOW_DOM_EXTRACT_SCRIPT, args: [] },
        { timeout: 30_000 }
      );
      const full: PageDomResult = JSON.parse(String(shadowRes.data.value));
      full.hasShadowDom = metaResult.hasShadowDom; // detection result, not "the walker ran"
      if (includeRawHtml) {
        const sourceRes = await client.get(`/session/${sid}/source`, { timeout: 20_000 });
        full.rawHtml = String(sourceRes.data.value ?? '');
      }
      // Update currentUrl
      session.currentUrl = full.url;
      return full;
    } catch (e) {
      throw new Error(`get_page_dom element extraction failed: ${describeError(e)}`);
    }
  }

  // Phase 2b: shadowMode "never" — standard rendered DOM only (GET /source returns the live rendered DOM in Selenium)
  try {
    const sourceRes = await client.get(`/session/${sid}/source`, { timeout: 20_000 });
    session.currentUrl = metaResult.url;
    return {
      url: metaResult.url,
      title: metaResult.title,
      hasShadowDom: metaResult.hasShadowDom,
      rawHtml: String(sourceRes.data.value ?? ''),
    };
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
