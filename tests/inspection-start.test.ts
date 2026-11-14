/**
 * start_inspection_session against a stub Grid: what the response says about the screen that is actually in front.
 * Remediation note 2026-10-14: with noReset (default true) a running Android app resumes on its LAST screen, not on
 * the requested appActivity; the agent assumed the login screen and wasted three "No element found" calls.
 * Debug-mode intake 2026-10-16: an iOS simulator start timed out at the 120 s default (simulators boot inside the
 * request), and the platform refuses device queries over 255 characters.
 */
import { describe, it, beforeAll, afterAll, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { registerInspectionTools, looksLikeTablet, isPhoneForOrientation } from '../src/tools/inspection-tools.js';
import { setAccessLevelOverrideForTests } from '../src/utils/access-level.js';
import { isSameActivity, sessionCreateTimeoutMs, deviceQueryLengthError, DEVICE_QUERY_MAX_LENGTH, newSessionWaitSeconds } from '../src/api/webdriver.js';
import { startStubApi, connectTools, accountInfo, reply, type StubApi, type ToolClient } from './helpers/offline.js';

let foreground = '.makePaymentView';
let foregroundPackage = 'com.experitest.ExperiBank';
let sweepable = false;
let orientation = 'PORTRAIT';
let keyboardHidden = false;
let keyboardStaysUp = false;
/** When set, the device record lookup answers with this platform category (otherwise the lookup fails, as before). */
let deviceCategory: string | null = null;
let api: StubApi;
let tools: ToolClient;

beforeAll(async () => {
  api = await startStubApi((req) => {
    if (req.path === '/api/v1/users/my-account-info') return accountInfo('Admin', 'Default');
    if (req.path === '/wd/hub/session' && req.method === 'POST') {
      const requested = String(req.json.desiredCapabilities?.['digitalai:deviceQuery']);
      if (requested.includes('SLOW')) return new Promise((r) => setTimeout(() => r({}), 400));
      // The platform's own refusals, as they arrive (HTTP 500 with the reason in value.message).
      if (requested.includes('NO_MATCH')) return reply(500, { value: { message: `Could not start appium test. Test request timed out. No available device matching the query: ${requested}` } });
      if (requested.includes('BOOT_FAIL')) return reply(500, { value: { message: 'Could not start appium test. Failed to boot emulator.' } });
      if (requested.includes('BARE_500')) return reply(500, {});
      // W3C (Appium Server) shape
      return { value: { sessionId: 'sid-1', capabilities: {
        'digitalai:reportTestId': 4242, 'digitalai:reportUrl': 'https://r/4242', deviceUDID: 'UDID-1',
        'digitalai:cloudDeviceName': 'Pixel 7 US-1', 'digitalai:publicModel': 'Pixel 7', platformName: 'Android', platformVersion: '14', appPackage: 'com.experitest.ExperiBank',
      } } };
    }
    if (req.path === '/api/v1/devices' && deviceCategory) {
      return { status: 'SUCCESS', code: 'OK', data: [{ id: '77', deviceName: 'Pixel 7 US-1', udid: 'UDID-1', displayStatus: 'In Use', agentName: 'a', region: 'US1', deviceCategory }] };
    }
    if (req.path === '/wd/hub/session/sid-1/appium/device/current_activity') return { value: foreground };
    if (req.path === '/wd/hub/session/sid-1/execute/sync' && req.json.script === 'mobile: getCurrentPackage') return { value: foregroundPackage };
    if (req.path === '/wd/hub/session/sid-1' && req.method === 'DELETE') return { value: null };
    if (req.path === '/wd/hub/session/sid-1/orientation') return { value: orientation };
    if (req.path === '/wd/hub/session/sid-1/execute/sync' && req.json.script === 'mobile: isKeyboardShown') return { value: keyboardStaysUp || !keyboardHidden };
    if (req.path === '/wd/hub/session/sid-1/execute/sync' && req.json.script === 'mobile: hideKeyboard') { keyboardHidden = true; return { value: null }; }
    if (req.path === '/reporter/api/tests/list') {
      // After a timed-out start the platform may have created the session anyway — its report carries the test name.
      return sweepable
        ? { count: 1, data: [{ test_id: 777, name: req.json.filter?.[0]?.value, status: 'Incomplete', start_time: new Date().toISOString() }] }
        : { count: 0, data: [] };
    }
    if (req.path === '/reporter/api/tests/delete') return {};
    return undefined;
  });
  tools = await connectTools(registerInspectionTools);
});
afterAll(async () => { await tools.close(); await api.close(); });
afterEach(async () => {
  setAccessLevelOverrideForTests(null);
  for (const h of handles.splice(0)) await tools.call('stop_inspection_session', { handle: h });
});
const handles: string[] = [];

async function start(args: Record<string, unknown>) {
  setAccessLevelOverrideForTests('cloud-admin');
  const j = await tools.callJson('start_inspection_session', args);
  handles.push(j.handle as string);
  return j;
}

describe('start_inspection_session reports the screen in front', () => {
  it('names the resumed screen and explains noReset when it differs from appActivity', async () => {
    foreground = '.makePaymentView';
    const j = await start({ platform: 'android', appPackage: 'com.experitest.ExperiBank', appActivity: '.LoginActivity' });
    assert.equal(j.currentActivity, '.makePaymentView');
    assert.match(String(j.screenNote), /showing "\.makePaymentView", not the requested "\.LoginActivity"/);
    assert.match(String(j.screenNote), /noReset is true/);
    assert.match(String(j.screenNote), /get_element_tree|noReset: false/);
  });

  it('says the app is NOT in front when another package (a launcher) is — never "resumed" (UAT 2026-11-13)', async () => {
    foreground = '.activities.LauncherActivity';
    foregroundPackage = 'com.sec.android.app.launcher';
    try {
      const j = await start({ platform: 'android', app: 'cloud:com.experitest.ExperiBank/.LoginActivity', appPackage: 'com.experitest.ExperiBank', appActivity: '.LoginActivity' });
      assert.match(String(j.screenNote), /NOT in the foreground: com\.sec\.android\.app\.launcher is/);
      assert.match(String(j.screenNote), /launch_app\(packageName: "com\.experitest\.ExperiBank", activity: "\.LoginActivity"\)/);
      assert.doesNotMatch(String(j.screenNote), /resumed/);
    } finally {
      foregroundPackage = 'com.experitest.ExperiBank';
    }
  });

  it('a uniqueName app reference is not mistaken for a package name', async () => {
    foreground = '.LoginActivity';
    const j = await start({ platform: 'android', app: 'cloud:uniqueName=SeeTestDemoApp' });
    assert.doesNotMatch(String(j.screenNote ?? ''), /NOT in the foreground/);
  });

  it('stays quiet when the requested activity is in front, in either spelling', async () => {
    foreground = 'com.experitest.ExperiBank.LoginActivity';
    const j = await start({ platform: 'android', appPackage: 'com.experitest.ExperiBank', appActivity: '.LoginActivity' });
    assert.equal(j.currentActivity, 'com.experitest.ExperiBank.LoginActivity');
    assert.equal(j.screenNote, undefined);
  });

  it('a plain session (no app) adds nothing', async () => {
    const j = await start({ platform: 'android' });
    assert.equal('currentActivity' in j, false);
    assert.equal('screenNote' in j, false);
  });

  it('a phone left in LANDSCAPE gets an orientationNote; portrait and tablets do not (UAT 2026-11-13 run 2)', async () => {
    orientation = 'LANDSCAPE';
    try {
      const j = await start({ platform: 'android' });
      assert.equal(j.orientation, 'LANDSCAPE');
      assert.match(String(j.orientationNote), /set_orientation", orientation: "PORTRAIT"/);
    } finally {
      orientation = 'PORTRAIT';
    }
    // XCUITest reports landscape-right with its own constant, not "LANDSCAPE".
    orientation = 'UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT';
    try {
      const r = await start({ platform: 'android' });
      assert.match(String(r.orientationNote), /set_orientation", orientation: "PORTRAIT"/);
    } finally {
      orientation = 'PORTRAIT';
    }
    const p = await start({ platform: 'android' });
    assert.equal(p.orientation, 'PORTRAIT');
    assert.equal('orientationNote' in p, false);
    assert.equal(looksLikeTablet('Galaxy Tab S7 Plus SM-T970'), true);
    assert.equal(looksLikeTablet('iPad Pro 12.9'), true);
    assert.equal(looksLikeTablet('Pixel 7 US-1 Pixel 7'), false);
    assert.equal(looksLikeTablet('US-0412 iPad13,4'), true);
    assert.equal(looksLikeTablet('Galaxy Tab S6 Lite SM-P610'), true);
  });

  it("the platform's device category decides the LANDSCAPE note when it is known; the name guess is only the fallback", async () => {
    // The stub device is named "Pixel 7" — a phone by name. A FOLDABLE or TABLET record must still suppress the note.
    orientation = 'LANDSCAPE';
    try {
      for (const [category, warned] of [['FOLDABLE', false], ['TABLET', false], ['PHONE', true], ['UNKNOWN', true]] as const) {
        deviceCategory = category;
        const j = await start({ platform: 'android' });
        assert.equal('orientationNote' in j, warned, category);
      }
    } finally {
      orientation = 'PORTRAIT';
      deviceCategory = null;
    }
    assert.equal(isPhoneForOrientation('PHONE', 'Galaxy Tab S7'), true, 'a known category beats the name');
    assert.equal(isPhoneForOrientation('tablet', 'Pixel 7'), false);
    assert.equal(isPhoneForOrientation(undefined, 'iPad Pro 12.9'), false, 'no record: the name guess');
    assert.equal(isPhoneForOrientation(undefined, 'Pixel 7'), true);
  });

  it('hide_keyboard re-checks: a keyboard that stays up is a warning, not "Keyboard hidden" (UAT 2026-11-13 run 2)', async () => {
    const j = await start({ platform: 'android' });
    keyboardHidden = false;
    keyboardStaysUp = true;
    orientation = 'LANDSCAPE';
    try {
      const { res, text } = await tools.call('hide_keyboard', { handle: j.handle });
      assert.notEqual(res.isError, true);
      assert.match(text, /STILL shown/);
      assert.match(text, /LANDSCAPE.*set_orientation/);
      assert.doesNotMatch(text, /✅ Keyboard hidden/);
    } finally {
      keyboardStaysUp = false;
      orientation = 'PORTRAIT';
    }
    keyboardHidden = false;
    const ok = await tools.call('hide_keyboard', { handle: j.handle });
    assert.match(ok.text, /✅ Keyboard hidden/);
  });

  it('isSameActivity compares the final segment, case-insensitively', () => {
    assert.equal(isSameActivity('.LoginActivity', 'com.experitest.ExperiBank.LoginActivity'), true);
    assert.equal(isSameActivity('com.x/.LoginActivity', '.loginactivity'), true);
    assert.equal(isSameActivity('.LoginActivity', '.makePaymentView'), false);
  });
});

describe('session start limits', () => {
  it('waits longer for emulators/simulators and projection; INSPECTION_SESSION_TIMEOUT_MS overrides', () => {
    assert.equal(sessionCreateTimeoutMs("@os='ios' and @category='PHONE'", false, {}), 120_000);
    assert.equal(sessionCreateTimeoutMs("@os='ios' and @emulator='true'", false, {}), 240_000);
    assert.equal(sessionCreateTimeoutMs("@os='ios' and @emulator = 'TRUE'", false, {}), 240_000);
    assert.equal(sessionCreateTimeoutMs("@os='android'", true, {}), 240_000);
    assert.equal(sessionCreateTimeoutMs("@os='android'", false, { INSPECTION_SESSION_TIMEOUT_MS: '300000' }), 300_000);
    assert.equal(sessionCreateTimeoutMs("@os='android'", false, { INSPECTION_SESSION_TIMEOUT_MS: 'nope' }), 120_000);
  });

  it('asks the platform to give up 15 s before the client does, so its reason arrives first', async () => {
    assert.equal(newSessionWaitSeconds(120_000), 105);
    assert.equal(newSessionWaitSeconds(240_000), 225);
    assert.equal(newSessionWaitSeconds(5_000), 10, 'never below 10 s');
    api.requests.length = 0;
    const j = await start({ platform: 'android' });
    assert.ok(j.handle);
    const sent = api.requests.find((r) => r.path === '/wd/hub/session' && r.method === 'POST')!.json;
    assert.equal(sent.desiredCapabilities['digitalai:newSessionWaitTimeout'], 105);
    assert.equal(sent.capabilities.alwaysMatch['digitalai:newSessionWaitTimeout'], 105);
  });

  it('refuses a device query over 255 characters before any session request', async () => {
    assert.equal(deviceQueryLengthError('x'.repeat(DEVICE_QUERY_MAX_LENGTH)), null);
    api.requests.length = 0;
    setAccessLevelOverrideForTests('cloud-admin');
    const { res, text } = await tools.call('start_inspection_session', { deviceQuery: "@os='android' and " + "@name='x' or ".repeat(30) + "@name='y'" });
    assert.equal(res.isError, true);
    assert.match(text, /Device query length restricted to 255 characters \(this one is \d+/);
    assert.equal(api.requests.some((r) => r.path === '/wd/hub/session'), false);
  });

  it('a client-side timeout names INSPECTION_SESSION_TIMEOUT_MS, skips the premature cleanup, and the report is swept later', async () => {
    process.env.INSPECTION_SESSION_TIMEOUT_MS = '100';
    try {
      setAccessLevelOverrideForTests('cloud-admin');
      api.requests.length = 0;
      const { res, text } = await tools.call('start_inspection_session', { deviceQuery: "@os='android' and @name='SLOW'" });
      assert.equal(res.isError, true);
      assert.match(text, /no answer from the platform within 0 s/);
      assert.match(text, /INSPECTION_SESSION_TIMEOUT_MS/);
      assert.match(text, /run cleanup_inspection_sessions afterwards/);
      assert.doesNotMatch(text, /find_available_device/);
      // Nothing exists on the platform yet, so the failed-start report lookup must not run now.
      assert.equal(api.requests.some((r) => r.path === '/reporter/api/tests/list'), false);

      // Later the platform finished the start: cleanup finds the report by test name and offers to delete it.
      sweepable = true;
      const preview = await tools.call('cleanup_inspection_sessions', {});
      assert.match(preview.text, /777/);
      assert.match(preview.text, /1 from timed-out starts/);
      const done = await tools.call('cleanup_inspection_sessions', { confirmDeletion: true });
      assert.equal(done.res.isError, undefined);
      assert.match(done.text, /777/);
    } finally {
      sweepable = false;
      delete process.env.INSPECTION_SESSION_TIMEOUT_MS;
    }
  });

  it('an emulator timeout says the boot may still fail, and a repeat of the same query is told not to retry unchanged', async () => {
    process.env.INSPECTION_SESSION_TIMEOUT_MS = '100';
    try {
      setAccessLevelOverrideForTests('cloud-admin');
      const deviceQuery = "@os='android' and @emulator='true' and @name='SLOW_EMU'";
      const first = await tools.call('start_inspection_session', { deviceQuery });
      assert.equal(first.res.isError, true);
      assert.match(first.text, /may also fail to boot/);
      assert.match(first.text, /list_virtual_device_templates/);
      assert.doesNotMatch(first.text, /timed out \d+ times/);
      assert.doesNotMatch(first.text, /find_available_device/, 'emulators are not listed by find_available_device');
      const second = await tools.call('start_inspection_session', { deviceQuery });
      assert.match(second.text, /^.*timed out 2 times in this session — do not retry it unchanged/);
    } finally {
      delete process.env.INSPECTION_SESSION_TIMEOUT_MS;
    }
  });

  it("an emulator start the platform refuses points at the template catalog, never at real-device advice (intake 2026-11-14)", async () => {
    setAccessLevelOverrideForTests('cloud-admin');
    const emulator = (marker: string) => `@os='android' and @emulator='true' and @model='pixel_4' and @name='${marker}'`;

    const noMatch = await tools.call('start_inspection_session', { deviceQuery: emulator('NO_MATCH') });
    assert.equal(noMatch.res.isError, true);
    assert.match(noMatch.text, /No available device matching the query/, "the platform's reason is kept");
    assert.match(noMatch.text, /list_virtual_device_templates/);
    assert.match(noMatch.text, /waited its whole 225 s/);
    assert.match(noMatch.text, /Do not repeat the query unchanged/);
    assert.doesNotMatch(noMatch.text, /run find_available_device|prefer a generic @os/);

    const bootFail = await tools.call('start_inspection_session', { deviceQuery: emulator('BOOT_FAIL') });
    assert.equal(bootFail.res.isError, true);
    assert.match(bootFail.text, /Failed to boot emulator/);
    assert.match(bootFail.text, /another OS version or model from list_virtual_device_templates, or use a real device/);
    assert.doesNotMatch(bootFail.text, /run find_available_device|prefer a generic @os|waited its whole/);

    const bare = await tools.call('start_inspection_session', { deviceQuery: emulator('BARE_500') });
    assert.match(bare.text, /HTTP 500\. For an emulator\/simulator: \(1\) check the query against list_virtual_device_templates/);
    assert.doesNotMatch(bare.text, /run find_available_device/);

    // A real-device query keeps the device-pool diagnostics.
    const real = await tools.call('start_inspection_session', { deviceQuery: "@os='android' and @name='NO_MATCH'" });
    assert.equal(real.res.isError, true);
    assert.match(real.text, /run find_available_device\(os: "android"\)/);
    assert.doesNotMatch(real.text, /list_virtual_device_templates/);
  });
});
