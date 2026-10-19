/**
 * Release 2 (2026-10-18), verified live on Appium Server (Galaxy Note 20 / iPhone 13 Pro Max) and reproduced here
 * against a stub Grid:
 *  - Appium Settings API: one POST /appium/settings per W3C session makes POST /elements carry attributes inline;
 *    UiAutomator2 honours text/rect/enabled/displayed (not class/resource-id), XCUITest type/label/rect/enabled/displayed
 *    (its inline `name` is the TYPE) — so the remaining attributes are still fetched, 4 GETs instead of 7–8.
 *  - Webview contexts: `mobile: getContexts` (waits for a webview), POST /context, HTML page source, css selector finds.
 *  - scroll_to_element on Android W3C uses `mobile: scrollGesture` (finger direction) and its canScrollMore answer.
 *  - get_device_log: GET /log/types + POST /log, tail + contains filtering.
 */
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { registerInspectionTools } from '../src/tools/inspection-tools.js';
import { setAccessLevelOverrideForTests } from '../src/utils/access-level.js';
import { startStubApi, connectTools, accountInfo, reply, type StubApi, type ToolClient } from './helpers/offline.js';

let api: StubApi;
let tools: ToolClient;
const hits: string[] = [];
const executed: Array<{ script: string; args: unknown[] }> = [];
let settingsStatus = 200;
let context = 'NATIVE_APP';
let chromeVisible = false;
let scrollAnswers: boolean[] = [];
let elementsFoundAfterSwipes = 0;
let swipes = 0;

beforeAll(async () => {
  api = await startStubApi((req) => {
    const path = req.path.replace(/^\/wd\/hub\/session\/[^/]+/, '');
    hits.push(`${req.method} ${path}`);
    if (req.path === '/api/v1/users/my-account-info') return accountInfo('Admin', 'Default');
    if (req.path === '/wd/hub/session' && req.method === 'POST') {
      const ios = String(req.json.desiredCapabilities?.platformName) === 'iOS';
      return { value: { sessionId: ios ? 'ios-1' : 'and-1', capabilities: { 'digitalai:reportTestId': 1, platformName: ios ? 'iOS' : 'Android', platformVersion: '17' } } };
    }
    const ios = req.path.includes('/ios-1/');
    if (path === '/appium/settings' && req.method === 'POST') return settingsStatus === 200 ? { value: null } : reply(settingsStatus, { value: { error: 'unknown command', message: 'no' } });
    if (path === '/elements') {
      if (context !== 'NATIVE_APP') return { value: [{ 'element-6066-11e4-a52e-4f735466cecf': 'web-1' }] };
      if (swipes < elementsFoundAfterSwipes) return { value: [] };
      return { value: settingsStatus === 200
        ? [ios
            ? { 'element-6066-11e4-a52e-4f735466cecf': 'el-1', type: 'XCUIElementTypeTextField', label: 'usernameTextField', rect: { x: 20, y: 131, width: 388, height: 31 }, enabled: true, displayed: true, name: 'XCUIElementTypeTextField' }
            : { 'element-6066-11e4-a52e-4f735466cecf': 'el-1', text: 'Username', rect: { x: 26, y: 444, width: 1028, height: 126 }, enabled: 'true', displayed: 'true', name: null }]
        : [{ 'element-6066-11e4-a52e-4f735466cecf': 'el-1' }] };
    }
    const attr = path.match(/^\/element\/([^/]+)\/attribute\/(.+)$/);
    if (attr) {
      const values: Record<string, string> = { name: 'usernameTextField', value: 'Username', visible: 'true', hittable: 'true', class: 'android.widget.EditText', 'resource-id': 'com.app:id/user', 'content-desc': 'null', clickable: 'true', text: 'Username', bounds: '[1,2][3,4]', enabled: 'true', label: 'usernameTextField', type: 'XCUIElementTypeTextField', id: 'login', 'class-web': '' };
      return attr[2] in values ? { value: values[attr[2]] } : reply(404, { value: { error: 'invalid argument', message: `no attribute ${attr[2]}` } });
    }
    if (/^\/element\/[^/]+\/rect$/.test(path)) return { value: { x: 1, y: 2, width: 10, height: 20 } };
    if (/^\/element\/[^/]+\/name$/.test(path)) return { value: 'input' };
    if (/^\/element\/[^/]+\/text$/.test(path)) return { value: 'hello' };
    if (path === '/window/rect') return { value: { width: 1080, height: 2280, x: 0, y: 0 } };
    if (path === '/execute/sync') {
      const script = String(req.json.script);
      const args = req.json.args as unknown[];
      executed.push({ script, args });
      if (script === 'mobile: getContexts') {
        if (ios) return { value: [{ id: 'NATIVE_APP' }, { id: 'WEBVIEW_123.1', title: 'balance', url: 'file:///app/', bundleId: 'com.app' }] };
        return chromeVisible ? { value: [{ webview: 'WEBVIEW_chrome', info: { 'Android-Package': 'com.android.chrome' }, pages: [{ type: 'service_worker', title: 'sw' }, { type: 'page', title: 'Boost', url: 'https://wap.boostmobile.com/' }] }] } : { value: [] };
      }
      if (script === 'mobile: scrollGesture') { swipes++; return { value: scrollAnswers.shift() ?? false }; }
      return { value: null };
    }
    if (path === '/contexts') return { value: ['NATIVE_APP', 'OCR'] };
    if (path === '/context' && req.method === 'POST') { context = String(req.json.name); return { value: null }; }
    if (path === '/title') return { value: 'balance' };
    if (path === '/url') return { value: 'file:///app/' };
    if (path === '/source') return { value: context === 'NATIVE_APP' ? '<hierarchy></hierarchy>' : '<html><head><title>balance</title></head><body><h1>Your balance</h1></body></html>' };
    if (path === '/log/types') return { value: ios ? ['syslog', 'crashlog'] : ['logcat', 'bugreport', 'server'] };
    if (path === '/log' && req.method === 'POST') return { value: Array.from({ length: 500 }, (_, i) => ({ timestamp: i, level: 'ALL', message: i % 50 === 0 ? `line ${i} FATAL EXCEPTION in com.app` : `line ${i} noise` })) };
    if (req.path.startsWith('/wd/hub/session/') && req.method === 'DELETE') return { value: null };
    if (req.path === '/reporter/api/tests/delete') return {};
    return undefined;
  });
  tools = await connectTools(registerInspectionTools);
  setAccessLevelOverrideForTests('cloud-admin');
});
afterAll(async () => {
  setAccessLevelOverrideForTests(null);
  await tools.close();
  await api.close();
});
beforeEach(() => { hits.length = 0; executed.length = 0; settingsStatus = 200; context = 'NATIVE_APP'; chromeVisible = false; scrollAnswers = []; elementsFoundAfterSwipes = 0; swipes = 0; });

const session = async (platform: 'ios' | 'android') => (await tools.callJson('start_inspection_session', { platform })).handle as string;
const attrGets = () => hits.filter((h) => /GET \/element\/[^/]+\/attribute\//.test(h));

describe('find_elements with inline attributes (Appium Settings API)', () => {
  it('Android: one settings call per session, then 4 attribute GETs per element instead of 7', async () => {
    const h = await session('android');
    const r = await tools.call('find_elements', { handle: h, strategy: 'id', selector: 'com.app:id/user' });
    assert.equal(r.res.isError, undefined, r.text);
    assert.equal(hits.filter((x) => x === 'POST /appium/settings').length, 1);
    assert.deepEqual(attrGets().map((x) => x.split('/attribute/')[1]).sort(), ['class', 'clickable', 'content-desc', 'resource-id']);
    assert.match(r.text, /resource-id:\s+com\.app:id\/user/);
    assert.match(r.text, /text:\s+Username/);
    assert.match(r.text, /bounds:\s+\[26,444\]\[1054,570\]/);
    hits.length = 0;
    await tools.call('find_elements', { handle: h, strategy: 'id', selector: 'com.app:id/user' });
    assert.equal(hits.filter((x) => x === 'POST /appium/settings').length, 0, 'settings are applied once per session');
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('iOS: label/type/rect come inline; name, value, visible and hittable are still fetched', async () => {
    const h = await session('ios');
    const r = await tools.call('find_elements', { handle: h, strategy: 'accessibility id', selector: 'usernameTextField' });
    assert.equal(r.res.isError, undefined, r.text);
    assert.deepEqual(attrGets().map((x) => x.split('/attribute/')[1]).sort(), ['hittable', 'name', 'value', 'visible']);
    assert.match(r.text, /type:\s+XCUIElementTypeTextField/);
    assert.match(r.text, /name:\s+usernameTextField/);
    assert.match(r.text, /value:\s+Username/);
    assert.match(r.text, /hittable:\s+true/);
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('falls back to the full GET path when the settings call fails (tried once)', async () => {
    settingsStatus = 404;
    const h = await session('android');
    await tools.call('find_elements', { handle: h, strategy: 'id', selector: 'x' });
    assert.equal(attrGets().length, 7);
    hits.length = 0;
    await tools.call('find_elements', { handle: h, strategy: 'id', selector: 'x' });
    assert.equal(hits.filter((x) => x === 'POST /appium/settings').length, 0);
    await tools.call('stop_inspection_session', { handle: h });
  });
});

describe('webview_context', () => {
  it('iOS: lists the app webview, switches into it (HTML source, css finds), and back', async () => {
    const h = await session('ios');
    const list = await tools.call('webview_context', { handle: h, action: 'list' });
    assert.match(list.text, /WEBVIEW_123\.1 — "balance"/);
    const sw = await tools.call('webview_context', { handle: h, action: 'switch' });
    assert.equal(sw.res.isError, undefined, sw.text);
    assert.match(sw.text, /Switched to WEBVIEW_123\.1 — "balance"/);
    const tree = await tools.call('get_element_tree', { handle: h });
    assert.match(tree.text, /web context WEBVIEW_123\.1/);
    assert.match(tree.text, /<h1>Your balance<\/h1>/);
    const f = await tools.call('find_elements', { handle: h, strategy: 'css selector', selector: 'h1' });
    assert.equal(f.res.isError, undefined, f.text);
    assert.match(f.text, /type:\s+input/);
    assert.match(f.text, /text:\s+hello/);
    const back = await tools.call('webview_context', { handle: h, action: 'native' });
    assert.match(back.text, /Back in NATIVE_APP/);
    assert.equal(context, 'NATIVE_APP');
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('Android: no webview → explains debuggability; Chrome in front → WEBVIEW_chrome with the page title', async () => {
    const h = await session('android');
    const none = await tools.call('webview_context', { handle: h, action: 'switch' });
    assert.equal(none.res.isError, true);
    assert.match(none.text, /No WEBVIEW context is available/);
    assert.match(none.text, /setWebContentsDebuggingEnabled/);
    chromeVisible = true;
    const list = await tools.call('webview_context', { handle: h, action: 'list', waitMs: 100 });
    assert.match(list.text, /WEBVIEW_chrome — "Boost" https:\/\/wap\.boostmobile\.com\/ \(com\.android\.chrome\)/);
    await tools.call('stop_inspection_session', { handle: h });
  });
});

describe('scroll_to_element on Android W3C uses scrollGesture', () => {
  it('passes the finger direction through and stops on canScrollMore=false', async () => {
    const h = await session('android');
    scrollAnswers = [true, false];
    elementsFoundAfterSwipes = Infinity;
    const r = await tools.call('scroll_to_element', { handle: h, strategy: 'id', selector: 'x', direction: 'up', maxSwipes: 8 });
    assert.match(r.text, /reached the end of the scrollable content after 2 swipes/);
    const gestures = executed.filter((e) => e.script === 'mobile: scrollGesture');
    assert.equal(gestures.length, 2);
    assert.equal((gestures[0].args[0] as { direction: string }).direction, 'up');
    assert.equal(hits.filter((x) => x === 'GET /source').length, 0, 'no page-source polling');
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('returns the element once a swipe reveals it', async () => {
    const h = await session('android');
    scrollAnswers = [true, true, true];
    elementsFoundAfterSwipes = 2;
    const r = await tools.call('scroll_to_element', { handle: h, strategy: 'id', selector: 'com.app:id/user' });
    assert.match(r.text, /Found after 2 swipes/);
    await tools.call('stop_inspection_session', { handle: h });
  });
});

describe('get_device_log', () => {
  it('tails and filters the session log, and names the available types on a bad one', async () => {
    const h = await session('android');
    const r = await tools.call('get_device_log', { handle: h, contains: 'FATAL', tail: 3 });
    assert.equal(r.res.isError, undefined, r.text);
    assert.match(r.text, /logcat: 500 line\(s\) captured, 3 shown matching "FATAL"/);
    assert.equal((r.text.match(/FATAL EXCEPTION/g) ?? []).length, 3);
    const bad = await tools.call('get_device_log', { handle: h, logType: 'nope' });
    assert.equal(bad.res.isError, true);
    assert.match(bad.text, /Available: logcat, bugreport, server/);
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('iOS defaults to syslog', async () => {
    const h = await session('ios');
    const r = await tools.call('get_device_log', { handle: h, tail: 2 });
    assert.match(r.text, /^syslog: 500 line\(s\) captured, last 2 shown/);
    await tools.call('stop_inspection_session', { handle: h });
  });
});
