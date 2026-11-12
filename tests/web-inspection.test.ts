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
import { registerWebInspectionTools } from '../src/tools/web-inspection-tools.js';
import type { InspectionSession } from '../src/types/digital-ai.js';
import { startStubApi, connectTools, type StubApi, type ToolClient } from './helpers/offline.js';

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
