/**
 * Device keys, app lifecycle and biometric mocking against a stub Grid — the fixes verified live on 2026-10-17
 * (iPhone 13 mini / iOS 17.6, Galaxy S25+ / Android 15, both Appium Server):
 *  - mobile: pressButton has no "power" button ("The device under test only supports the following buttons: home,
 *    volumedown, volumeup") — POWER toggles mobile: lock / unlock instead.
 *  - seetest:client.setAuthenticationReply refuses delay 0 on both platforms and numeric codes on iOS (string replies:
 *    Success / AuthenticationFailedError / UserCancelError / StopMock) — a 0 default had made every call fail.
 *  - mobile: startActivity without stop:true only re-fronts a running app; terminateApp needs a timeout for slow exits.
 *  - iOS sessions identify the app with bundleId, not the Android-only appPackage.
 *  - XCUITest's `hittable` differs from `visible` and is surfaced beside clickable.
 */
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { registerInspectionTools } from '../src/tools/inspection-tools.js';
import { registerPerformanceTools } from '../src/tools/performance-tools.js';
import { setAccessLevelOverrideForTests } from '../src/utils/access-level.js';
import { mockAuthentication } from '../src/api/webdriver.js';
import { startStubApi, connectTools, accountInfo, reply, type StubApi, type ToolClient } from './helpers/offline.js';

let api: StubApi;
let tools: ToolClient;
let locked = false;
let authReply: unknown = { value: { message: null } };
let alertOpen = true;
let deleteFails = false;
const netState: Record<string, boolean> = { wifi: true, bluetooth: false };
const executed: Array<{ script: string; args: unknown[] }> = [];
const sessionBodies: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  api = await startStubApi((req) => {
    if (req.path === '/api/v1/users/my-account-info') return accountInfo('Admin', 'Default');
    if (req.path === '/wd/hub/session' && req.method === 'POST') {
      sessionBodies.push(req.json as Record<string, unknown>);
      const ios = String(req.json.desiredCapabilities?.platformName) === 'iOS';
      return { value: { sessionId: ios ? 'ios-1' : 'and-1', capabilities: { 'digitalai:reportTestId': ios ? 21 : 22, platformName: ios ? 'iOS' : 'Android', platformVersion: '17' } } };
    }
    if (/^\/wd\/hub\/session\/[^/]+\/execute\/sync$/.test(req.path)) {
      const script = String(req.json.script);
      const args = req.json.args as unknown[];
      executed.push({ script, args });
      if (script === 'mobile: pressButton' && (args[0] as { name: string }).name === 'power') {
        return reply(500, { value: { error: 'unknown error', message: "The button 'power' is not supported. The device under test only supports the following buttons: (home, volumedown, volumeup)" } });
      }
      if (script === 'mobile: isLocked') return { value: locked };
      if (script === 'mobile: lock') { locked = true; return { value: null }; }
      if (script === 'mobile: unlock') { locked = false; return { value: null }; }
      if (script === 'mobile: terminateApp') return { value: true };
      if (script === 'mobile: isAppInstalled') return { value: true };
      if (script === 'mobile: getCurrentActivity') return { value: '.LoginActivity' };
      if (script === 'mobile: getCurrentPackage') return { value: 'com.experitest.ExperiBank' };
      if (script === 'mobile: activeAppInfo') return { value: { bundleId: 'com.experitest.ExperiBank', pid: 42, name: '' } };
      if (script === 'mobile: alert') return { value: (args[0] as { action: string }).action === 'getButtons' ? ['Yes', 'No'] : null };
      if (script === 'seetest:client.getNetworkConnection') return { value: netState[String(args[0])] ?? false };
      if (script === 'seetest:client.setNetworkConnection') { netState[String(args[0])] = args[1] === true; return { value: { message: null } }; }
      if (script === 'seetest:client.simulateCapture') return reply(404, { value: { error: 'unknown command', message: 'Failed to execute simulateCapture(): application is not instrumented' } });
      if (script === 'seetest:client.endPerformanceTransaction') return { value: { transactionId: 99, transactionName: args[0] } };
      if (script === 'seetest:client.setAuthenticationReply') return authReply;
      return { value: null };
    }
    if (/\/elements$/.test(req.path)) return { value: [{ 'element-6066-11e4-a52e-4f735466cecf': 'el-1' }] };
    if (req.path === '/api/v1/files') return { status: 'SUCCESS', data: [{ id: 501, uniqueName: 'mcp-har-x.har', size: 290, projectName: 'Default', extension: 'har' }, { id: 502, uniqueName: 'runlog.log', size: 33000, projectName: 'Default', extension: 'log' }], code: 'OK' };
    if (req.path === '/reporter/api/tests/delete') return deleteFails ? reply(400, { message: 'org.hibernate.TransientPropertyValueException: Persistent instance of Attachment references an unsaved transient instance of TestTransactionServer' }) : {};
    if (/\/alert\/text$/.test(req.path)) return alertOpen ? { value: 'Are you sure you want to send payment?' } : reply(404, { value: { error: 'no such alert', message: 'An attempt was made to operate on a modal dialog when one was not open' } });
    if (/\/element\/el-1\/attribute\/(\w+)$/.test(req.path)) {
      const attr = req.path.split('/').pop();
      const values: Record<string, string> = { name: 'usernameTextField', label: 'Username', type: 'XCUIElementTypeTextField', enabled: 'true', visible: 'true', hittable: 'false' };
      return attr! in values ? { value: values[attr!] } : reply(404, { value: { error: 'invalid argument', message: `no attribute ${attr}` } });
    }
    if (/\/element\/el-1\/rect$/.test(req.path)) return { value: { x: 10, y: 20, width: 100, height: 40 } };
    if (req.path.startsWith('/wd/hub/session/') && req.method === 'DELETE') return { value: null };
    if (req.path === '/reporter/api/tests/delete') return {};
    return undefined;
  });
  tools = await connectTools(registerInspectionTools, registerPerformanceTools);
  setAccessLevelOverrideForTests('cloud-admin');
});
afterAll(async () => {
  setAccessLevelOverrideForTests(null);
  await tools.close();
  await api.close();
});
beforeEach(() => { executed.length = 0; sessionBodies.length = 0; locked = false; alertOpen = true; deleteFails = false; netState.bluetooth = false; authReply = { value: { message: null } }; });

async function session(platform: 'ios' | 'android', extra: Record<string, unknown> = {}): Promise<string> {
  return (await tools.callJson('start_inspection_session', { platform, ...extra })).handle as string;
}

describe('press_key POWER on iOS (Appium Server)', () => {
  it('never sends pressButton power — it locks an unlocked device and unlocks a locked one', async () => {
    const h = await session('ios');
    let r = await tools.call('press_key', { handle: h, key: 'POWER' });
    assert.equal(r.res.isError, undefined, r.text);
    assert.match(r.text, /device locked/);
    r = await tools.call('press_key', { handle: h, key: 'POWER' });
    assert.match(r.text, /device unlocked/);
    const scripts = executed.map((x) => x.script);
    assert.deepEqual(scripts, ['mobile: isLocked', 'mobile: lock', 'mobile: isLocked', 'mobile: unlock']);
    assert.ok(!scripts.includes('mobile: pressButton'));
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('HOME still goes through mobile: pressButton', async () => {
    const h = await session('ios');
    const r = await tools.call('press_key', { handle: h, key: 'HOME' });
    assert.equal(r.res.isError, undefined, r.text);
    assert.deepEqual(executed[0], { script: 'mobile: pressButton', args: [{ name: 'home' }] });
    await tools.call('stop_inspection_session', { handle: h });
  });
});

describe('mock_authentication', () => {
  it('sends the iOS string replies with a delay of at least 1 ms by default', async () => {
    const h = await session('ios');
    for (const [reply, expected] of [['success', 'Success'], ['failed', 'AuthenticationFailedError'], ['cancel', 'UserCancelError'], ['clear', 'StopMock']] as const) {
      executed.length = 0;
      const r = await tools.call('mock_authentication', { handle: h, reply });
      assert.equal(r.res.isError, undefined, r.text);
      assert.deepEqual(executed[0], { script: 'seetest:client.setAuthenticationReply', args: [expected, 1] });
    }
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('sends the Android enum replies and keeps an explicit delay', async () => {
    const h = await session('android');
    const r = await tools.call('mock_authentication', { handle: h, reply: 'success', delay: 250 });
    assert.equal(r.res.isError, undefined, r.text);
    assert.deepEqual(executed[0], { script: 'seetest:client.setAuthenticationReply', args: ['AUTHENTICATION_SUCCEEDED', 250] });
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('clamps a zero delay to 1 at the API layer (the platform rejects 0)', async () => {
    const h = await session('android');
    await mockAuthentication(h, 'clear', 0);
    assert.deepEqual(executed[0].args, ['CLEAR_MOCK', 1]);
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('explains instrumentation when the platform answers "application is not instrumented"', async () => {
    authReply = reply(500, { value: { error: 'unknown error', message: 'Failed to execute setAuthenticationReply(): application is not instrumented' } });
    const h = await session('ios');
    const r = await tools.call('mock_authentication', { handle: h, reply: 'success' });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /not instrumented/);
    assert.match(r.text, /instrument=true|digitalai:instrumentApp/);
    await tools.call('stop_inspection_session', { handle: h });
  });
});

describe('launch_app / app_control on Appium Server Android', () => {
  it('launch_app force-stops a running app before starting the activity (stop: true)', async () => {
    const h = await session('android');
    const r = await tools.call('launch_app', { handle: h, packageName: 'com.experitest.ExperiBank', activity: '.LoginActivity' });
    assert.equal(r.res.isError, undefined, r.text);
    assert.deepEqual(executed[0], { script: 'mobile: startActivity', args: [{ intent: 'com.experitest.ExperiBank/.LoginActivity', wait: true, stop: true }] });
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('terminate waits for a slow exit (timeout) and reports the result', async () => {
    const h = await session('android');
    const r = await tools.call('app_control', { handle: h, action: 'terminate', packageName: 'com.experitest.ExperiBank' });
    assert.match(r.text, /Terminated/);
    assert.deepEqual(executed[0], { script: 'mobile: terminateApp', args: [{ appId: 'com.experitest.ExperiBank', timeout: 3000 }] });
    await tools.call('stop_inspection_session', { handle: h });
  });
});

describe('iOS session capabilities and element attributes', () => {
  it('identifies the app with bundleId (never the Android-only appPackage/appActivity)', async () => {
    const h = await session('ios', { app: 'cloud:com.experitest.ExperiBank', appPackage: 'com.experitest.ExperiBank', appActivity: '.Ignored' });
    const body = sessionBodies[0];
    const desired = body.desiredCapabilities as Record<string, unknown>;
    const always = (body.capabilities as { alwaysMatch: Record<string, unknown> }).alwaysMatch;
    assert.equal(desired.bundleId, 'com.experitest.ExperiBank');
    assert.equal(always['appium:bundleId'], 'com.experitest.ExperiBank');
    assert.ok(!('appPackage' in desired) && !('appium:appPackage' in always) && !('appActivity' in desired));
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('Android sessions keep appPackage/appActivity', async () => {
    const h = await session('android', { app: 'cloud:com.experitest.ExperiBank/.LoginActivity', appPackage: 'com.experitest.ExperiBank', appActivity: '.LoginActivity' });
    const desired = sessionBodies[0].desiredCapabilities as Record<string, unknown>;
    assert.equal(desired.appPackage, 'com.experitest.ExperiBank');
    assert.equal(desired.appActivity, '.LoginActivity');
    assert.ok(!('bundleId' in desired));
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('find_elements shows hittable separately from clickable on iOS', async () => {
    const h = await session('ios');
    const r = await tools.call('find_elements', { handle: h, strategy: 'accessibility id', selector: 'usernameTextField' });
    assert.equal(r.res.isError, undefined, r.text);
    assert.match(r.text, /clickable:\s+true/);
    assert.match(r.text, /hittable:\s+false \(visible but not on the hit-test path/);
    await tools.call('stop_inspection_session', { handle: h });
  });
});

describe('app_control release-2 actions (verified live 2026-10-18)', () => {
  it('background / is_installed / current / install map to the documented mobile: commands', async () => {
    const h = await session('android');
    let r = await tools.call('app_control', { handle: h, action: 'background', seconds: 2 });
    assert.match(r.text, /background for 2 s/);
    assert.deepEqual(executed.at(-1), { script: 'mobile: backgroundApp', args: [{ seconds: 2 }] });
    r = await tools.call('app_control', { handle: h, action: 'is_installed', packageName: 'com.experitest.ExperiBank' });
    assert.match(r.text, /is installed/);
    assert.deepEqual(executed.at(-1), { script: 'mobile: isAppInstalled', args: [{ appId: 'com.experitest.ExperiBank' }] });
    r = await tools.call('app_control', { handle: h, action: 'current' });
    assert.match(r.text, /package com\.experitest\.ExperiBank, activity \.LoginActivity/);
    r = await tools.call('app_control', { handle: h, action: 'install', appRef: 'com.experitest.ExperiBank/.LoginActivity' });
    assert.match(r.text, /Installed cloud:com\.experitest\.ExperiBank\/\.LoginActivity/);
    assert.deepEqual(executed.at(-1), { script: 'mobile: installApp', args: [{ appPath: 'cloud:com.experitest.ExperiBank/.LoginActivity' }] });
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('iOS current reads activeAppInfo and is_installed uses bundleId', async () => {
    const h = await session('ios');
    const r = await tools.call('app_control', { handle: h, action: 'current' });
    assert.match(r.text, /Foreground app: com\.experitest\.ExperiBank, pid 42/);
    await tools.call('app_control', { handle: h, action: 'is_installed', packageName: 'com.experitest.ExperiBank' });
    assert.deepEqual(executed.at(-1), { script: 'mobile: isAppInstalled', args: [{ bundleId: 'com.experitest.ExperiBank' }] });
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('install requires a repository reference', async () => {
    const h = await session('android');
    const r = await tools.call('app_control', { handle: h, action: 'install' });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /install requires appRef/);
    await tools.call('stop_inspection_session', { handle: h });
  });
});

describe('device_control alerts (release 2)', () => {
  it('get_alert returns the text and, on iOS, the button labels; accept_alert presses one by label', async () => {
    const h = await session('ios');
    const r = await tools.call('device_control', { handle: h, action: 'get_alert' });
    assert.equal(r.res.isError, undefined, r.text);
    assert.match(r.text, /Alert text: "Are you sure you want to send payment\?"/);
    assert.match(r.text, /Buttons: "Yes", "No"/);
    const a = await tools.call('device_control', { handle: h, action: 'accept_alert', buttonLabel: 'No' });
    assert.match(a.text, /button "No" pressed/);
    assert.deepEqual(executed.at(-1), { script: 'mobile: alert', args: [{ action: 'accept', buttonLabel: 'No' }] });
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('no alert open → a plain "No alert is present" error (XCUITest wording mapped)', async () => {
    alertOpen = false;
    const h = await session('ios');
    const r = await tools.call('device_control', { handle: h, action: 'get_alert' });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /No alert is present on the screen/);
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('buttonLabel is refused on Android with the tap-by-text alternative', async () => {
    const h = await session('android');
    const r = await tools.call('device_control', { handle: h, action: 'accept_alert', buttonLabel: 'OK' });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /buttonLabel is iOS-only/);
    await tools.call('stop_inspection_session', { handle: h });
  });
});

describe('release-3 session tools (verified live 2026-10-18)', () => {
  it('session_capture: start/stop for har and device_log, repository lookup, empty-HAR note, double start refused', async () => {
    const h = await session('android');
    let r = await tools.call('session_capture', { handle: h, kind: 'har', action: 'start', name: 'mcp-har-x' });
    assert.match(r.text, /har capture started → repository file "mcp-har-x\.har"/);
    assert.deepEqual(executed.at(-1), { script: 'seetest:client.startHarRecording', args: ['cloud:mcp-har-x.har'] });
    r = await tools.call('session_capture', { handle: h, kind: 'har', action: 'start' });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /already running/);
    r = await tools.call('session_capture', { handle: h, kind: 'device_log', action: 'start', name: 'runlog' });
    assert.deepEqual(executed.at(-1), { script: 'seetest:client.startLoggingDevice', args: ['cloud:runlog.log'] });
    r = await tools.call('session_capture', { handle: h, kind: 'har', action: 'stop' });
    assert.equal(r.res.isError, undefined, r.text);
    assert.match(r.text, /id 501, 290 bytes/);
    assert.match(r.text, /HAR holds no entries/);
    assert.deepEqual(executed.at(-1), { script: 'seetest:client.stopHarRecording', args: [] });
    r = await tools.call('session_capture', { handle: h, kind: 'device_log', action: 'stop' });
    assert.match(r.text, /id 502, 33000 bytes/);
    assert.doesNotMatch(r.text, /holds no entries/);
    r = await tools.call('session_capture', { handle: h, kind: 'har', action: 'stop' });
    assert.equal(r.res.isError, true);
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('network_control: get/set a connection and apply NV conditions', async () => {
    const h = await session('android');
    let r = await tools.call('network_control', { handle: h, action: 'get', kind: 'wifi' });
    assert.match(r.text, /^wifi: ON/);
    r = await tools.call('network_control', { handle: h, action: 'set', kind: 'bluetooth', enabled: true });
    assert.match(r.text, /bluetooth: ON/);
    assert.deepEqual(executed.filter((e) => e.script === 'seetest:client.setNetworkConnection').at(-1)?.args, ['bluetooth', true]);
    r = await tools.call('network_control', { handle: h, action: 'set_conditions', profile: '3G-average', durationMs: 5000 });
    assert.match(r.text, /NV profile "3G-average" applied .* for 5 s/);
    assert.deepEqual(executed.at(-1), { script: 'seetest:client.setNetworkConditions', args: ['3G-average', 5000] });
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('network_control set is refused on iOS', async () => {
    const h = await session('ios');
    const r = await tools.call('network_control', { handle: h, action: 'set', kind: 'wifi', enabled: false });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /Android-only/);
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('inject_camera_image validates the source first and explains instrumentation', async () => {
    const h = await session('android');
    let r = await tools.call('inject_camera_image', { handle: h, source: 'https://x/y.ico' });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /not a jpg\/jpeg\/png/);
    r = await tools.call('inject_camera_image', { handle: h, source: 'C:/photo.png' });
    assert.match(r.text, /source must be "cloud:/);
    assert.equal(executed.filter((e) => e.script === 'seetest:client.simulateCapture').length, 0);
    r = await tools.call('inject_camera_image', { handle: h, source: 'cloud:cheque.png' });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /not instrumented/);
    assert.match(r.text, /instrument=true/);
    assert.doesNotMatch(r.text, /terminated/);
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('app_control clear_web_cache sends the 0-arg hybridClearCache', async () => {
    const h = await session('android');
    const r = await tools.call('app_control', { handle: h, action: 'clear_web_cache' });
    assert.match(r.text, /cache cleared/);
    assert.deepEqual(executed.at(-1), { script: 'seetest:client.hybridClearCache', args: [] });
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('performance_transaction_control forApplication uses the per-app start', async () => {
    const h = await session('android');
    const r = await tools.call('performance_transaction_control', { handle: h, action: 'start', networkProfile: 'Monitor', forApplication: 'com.experitest.ExperiBank' });
    assert.match(r.text, /per-application performance transaction for com\.experitest\.ExperiBank/);
    assert.deepEqual(executed.at(-1), { script: 'seetest:client.startPerformanceTransactionForApplication', args: ['com.experitest.ExperiBank', 'Monitor'] });
    await tools.call('performance_transaction_control', { handle: h, action: 'end', transactionName: 'T' });
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('stop_inspection_session explains a report the platform refuses to delete (transaction attached)', async () => {
    deleteFails = true;
    const h = await session('android');
    const r = await tools.call('stop_inspection_session', { handle: h });
    assert.equal(r.res.isError, undefined, r.text);
    assert.match(r.text, /Report NOT deleted \(test_id=22\): the report holds a performance transaction/);
  });
});
