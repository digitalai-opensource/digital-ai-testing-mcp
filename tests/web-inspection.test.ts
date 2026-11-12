/**
 * Web (browser) inspection tool handlers against a stub Grid.
 *  - get_page_dom's default call must return the interactive elements on a standard (non-shadow) page (UAT #53)
 *  - shadowMode "never" prints the HTML instead of only announcing its length
 * tests/tools.test.ts covers the no-HTTP paths (unknown handle, browser prompt).
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { registerSession } from '../src/api/webdriver.js';
import { certificateWarning } from '../src/api/browser-inspection.js';
import { normalizeBidiMessage, injectBrowserEventsForTests, type BrowserEvent } from '../src/api/browser-events.js';
import { setAccessLevelOverrideForTests } from '../src/utils/access-level.js';
import { registerWebInspectionTools } from '../src/tools/web-inspection-tools.js';
import type { InspectionSession } from '../src/types/digital-ai.js';
import { startStubApi, connectTools, accountInfo, type StubApi, type ToolClient } from './helpers/offline.js';

const sessionCaps: Array<Record<string, unknown>> = [];

const ELEMENTS = [{ tag: 'a', href: 'https://www.iana.org/domains/example', text: 'More information...' }];

const webSession = (handle: string): InspectionSession => ({
  handle, gridSessionId: `sid-${handle}`, reportTestId: 0, reportUrl: '', cloudViewLink: null, deviceUDID: '', deviceName: 'chrome',
  deviceModel: '', deviceOs: 'Windows', deviceVersion: '', appPackage: '', startedAt: Date.now(), lastUsedAt: Date.now(),
  canDeleteReport: true, sessionFormat: 'w3c', platform: 'web', browserName: 'chrome',
});

let api: StubApi;
let tools: ToolClient;

beforeAll(async () => {
  api = await startStubApi((req) => {
    if (req.path === '/api/v1/users/my-account-info') return accountInfo('Admin', 'Default');
    if (req.path === '/wd/hub/session' && req.method === 'POST') {
      sessionCaps.push(req.json.capabilities?.alwaysMatch ?? {});
      return { value: { sessionId: `s-${sessionCaps.length}`, capabilities: { browserVersion: '158', 'digitalai:reportTestId': 0 } } };
    }
    if (/^\/wd\/hub\/session\/s-\d+$/.test(req.path) && req.method === 'DELETE') return { value: null };
    // navigate_to: sessions whose id contains "badcert" land on Chrome's certificate warning page.
    if (/\/wd\/hub\/session\/[^/]+\/url$/.test(req.path)) return { value: req.method === 'GET' ? 'https://self-signed.badssl.com/' : null };
    if (/\/wd\/hub\/session\/[^/]+\/title$/.test(req.path)) return { value: /badcert/.test(req.path) ? 'Privacy error' : 'self-signed.badssl.com' };
    if (/\/wd\/hub\/session\/[^/]+\/execute\/sync$/.test(req.path) && /readyState/.test(req.json.script ?? '')) return { value: 'complete' };
    if (/\/wd\/hub\/session\/[^/]+\/execute\/sync$/.test(req.path)) {
      const script: string = req.json.script ?? '';
      // Detection script → page meta; anything else is the element walker.
      const value = /hasShadowDom/.test(script) && !/extractDOM/.test(script)
        ? JSON.stringify({ url: 'https://example.com/', title: 'Example Domain', hasShadowDom: false })
        : JSON.stringify({ url: 'https://example.com/', title: 'Example Domain', hasShadowDom: true, elements: ELEMENTS });
      return { value };
    }
    if (/\/wd\/hub\/session\/[^/]+\/source$/.test(req.path)) return { value: '<html><body><a href="x">More</a></body></html>' };
    return undefined;
  });
  tools = await connectTools(registerWebInspectionTools);
});
afterAll(async () => { await tools.close(); await api.close(); });

describe('get_page_dom', () => {
  it('lists elements on a standard page; hasShadowDom reflects detection (false); json form is machine-readable', async () => {
    registerSession(webSession('WEB00001'));
    const human = await tools.call('get_page_dom', { handle: 'WEB00001' });
    assert.notEqual(human.res.isError, true, human.text);
    assert.match(human.text, /Interactive elements \(1 found\)/);
    assert.match(human.text, /href="https:\/\/www\.iana\.org\/domains\/example"/);
    assert.doesNotMatch(human.text, /DOM extracted as raw HTML/, 'the old "length only, no content" output must not return');
    const j = await tools.callJson('get_page_dom', { handle: 'WEB00001' });
    assert.equal(j.hasShadowDom, false, 'the detection result, not "the walker ran"');
    assert.equal(j.elementCount, 1);
  });

  it('shadowMode "never" prints the HTML instead of only announcing its length', async () => {
    registerSession(webSession('WEB00002'));
    const { text } = await tools.call('get_page_dom', { handle: 'WEB00002', shadowMode: 'never' });
    assert.match(text, /--- RAW HTML \(\d+ chars\) ---/);
    assert.match(text, /<a href="x">More<\/a>/);
  });
});

describe('self-signed / untrusted certificates (verified live 2026-11-12 against self-signed.badssl.com)', () => {
  it('certificateWarning recognises the Firefox error and the Chrome/Edge/Safari warning-page titles, nothing else', () => {
    assert.match(certificateWarning('HTTP 400: insecure certificate') ?? '', /acceptInsecureCerts: true/);
    assert.ok(certificateWarning('Privacy error'));
    assert.ok(certificateWarning('This Connection Is Not Private'));
    assert.equal(certificateWarning('Example Domain'), null);
    assert.equal(certificateWarning('Privacy error — our policy page'), null, 'an ordinary page titled with the phrase');
    assert.equal(certificateWarning(''), null);
  });

  it('navigate_to reports a certificate warning page as an error with the acceptInsecureCerts remedy', async () => {
    registerSession({ ...webSession('WEB00003'), gridSessionId: 'sid-badcert' });
    const { res, text } = await tools.call('navigate_to', { handle: 'WEB00003', url: 'https://self-signed.badssl.com/' });
    assert.equal(res.isError, true, text);
    assert.match(text, /"Privacy error"/);
    assert.match(text, /start_browser_inspection_session\(acceptInsecureCerts: true\)/);
  });

  it('navigate_to skips the check on a session started with acceptInsecureCerts', async () => {
    registerSession({ ...webSession('WEB00004'), gridSessionId: 'sid-badcert', acceptInsecureCerts: true });
    const { res, text } = await tools.call('navigate_to', { handle: 'WEB00004', url: 'https://self-signed.badssl.com/' });
    assert.notEqual(res.isError, true, text);
  });
});

describe('browser log capture over WebDriver BiDi (verified live 2026-11-12 on Chrome, Firefox, Edge, Opera)', () => {
  const msg = (method: string, params: Record<string, unknown>) => JSON.stringify({ type: 'event', method, params });

  it('normalizeBidiMessage maps console, uncaught JS errors and failed requests; counts successes; ignores the rest', () => {
    const log = normalizeBidiMessage(msg('log.entryAdded', { type: 'console', level: 'error', text: 'mcp-probe console error', timestamp: 5 }));
    assert.deepEqual(log, { kind: 'console', level: 'error', text: 'mcp-probe console error', url: undefined, time: 5 });
    const js = normalizeBidiMessage(msg('log.entryAdded', {
      type: 'javascript', level: 'error', text: 'Uncaught Error: boom', timestamp: 6,
      stackTrace: { callFrames: [{ url: 'https://example.com/app.js', lineNumber: 41 }] },
    })) as BrowserEvent;
    assert.equal(js.kind, 'javascript');
    assert.equal(js.url, 'https://example.com/app.js:42');
    const net = normalizeBidiMessage(msg('network.responseCompleted', { request: { url: 'https://example.com/x', method: 'GET' }, response: { status: 404, statusText: 'Not Found' }, timestamp: 7 }));
    assert.deepEqual(net, { kind: 'network', level: 'error', text: '404 Not Found', url: 'https://example.com/x', status: 404, method: 'GET', time: 7 });
    assert.equal(normalizeBidiMessage(msg('network.responseCompleted', { request: { url: 'u' }, response: { status: 200 } })), 'ok-request');
    assert.match((normalizeBidiMessage(msg('network.fetchError', { request: { url: 'u', method: 'POST' }, errorText: 'net::ERR_FAILED' })) as BrowserEvent).text, /ERR_FAILED/);
    assert.equal(normalizeBidiMessage(msg('browsingContext.load', {})), null);
    assert.equal(normalizeBidiMessage('not json'), null);
  });

  it('get_browser_log filters by kind and level, reports successes, and clears on request', async () => {
    registerSession(webSession('WEB00010'));
    injectBrowserEventsForTests('WEB00010', [
      { kind: 'console', level: 'info', text: 'hello', time: 1 },
      { kind: 'console', level: 'error', text: 'bad thing', time: 2 },
      { kind: 'javascript', level: 'error', text: 'Uncaught Error: boom', url: 'https://e.com/a.js:3', time: 3 },
      { kind: 'network', level: 'error', text: '404 Not Found', url: 'https://e.com/api', status: 404, method: 'GET', time: 4 },
    ], 7);
    let r = await tools.call('get_browser_log', { handle: 'WEB00010', outputFormat: 'human' });
    assert.match(r.text, /^4 matching entries · 7 successful requests not listed/);
    assert.match(r.text, /js-error\s+Uncaught Error: boom  \(https:\/\/e\.com\/a\.js:3\)/);
    assert.match(r.text, /network GET\s+404 Not Found  \(https:\/\/e\.com\/api\)/);
    r = await tools.call('get_browser_log', { handle: 'WEB00010', kind: 'console', errorsOnly: true, outputFormat: 'human' });
    assert.match(r.text, /^2 matching entries/);
    assert.doesNotMatch(r.text, /hello|404/);
    const j = await tools.callJson('get_browser_log', { handle: 'WEB00010', kind: 'network', clear: true });
    assert.equal(j.matched, 1);
    r = await tools.call('get_browser_log', { handle: 'WEB00010', outputFormat: 'human' });
    assert.match(r.text, /^0 matching entries · 0 successful requests/);
  });

  it('a session without capture explains why; a mobile session is pointed to get_device_log', async () => {
    registerSession({ ...webSession('WEB00011'), browserEvents: 'unavailable: safari is not supported' });
    let r = await tools.call('get_browser_log', { handle: 'WEB00011' });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /capture is unavailable: safari is not supported/);
    registerSession({ ...webSession('MOB00001'), platform: 'android' });
    r = await tools.call('get_browser_log', { handle: 'MOB00001' });
    assert.match(r.text, /get_device_log/);
  });

  it('start_browser_inspection_session asks for webSocketUrl on chrome, never on safari, and not when disabled', async () => {
    setAccessLevelOverrideForTests('cloud-admin');
    try {
      const chrome = await tools.callJson('start_browser_inspection_session', { inspectionBrowser: 'chrome' });
      assert.equal(sessionCaps.at(-1)?.webSocketUrl, true);
      assert.equal(chrome.browserLog, 'unavailable: the platform returned no webSocketUrl', 'stub returns no URL — reported, session still opens');
      const safari = await tools.callJson('start_browser_inspection_session', { inspectionBrowser: 'safari' });
      assert.equal(sessionCaps.at(-1)?.webSocketUrl, undefined);
      assert.match(String(safari.browserLog), /^unavailable: safari/);
      const off = await tools.callJson('start_browser_inspection_session', { inspectionBrowser: 'firefox', captureBrowserLog: false });
      assert.equal(sessionCaps.at(-1)?.webSocketUrl, undefined);
      assert.equal(off.browserLog, 'off');
      for (const h of [chrome.handle, safari.handle, off.handle]) await tools.call('stop_browser_inspection_session', { handle: h });
    } finally {
      setAccessLevelOverrideForTests(null);
    }
  });
});
