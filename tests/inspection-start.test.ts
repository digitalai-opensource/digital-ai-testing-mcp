/**
 * start_inspection_session against a stub Grid: what the response says about the screen that is actually in front.
 * Remediation note 2026-10-14: with noReset (default true) a running Android app resumes on its LAST screen, not on
 * the requested appActivity; the agent assumed the login screen and wasted three "No element found" calls.
 * Debug-mode intake 2026-10-16: an iOS simulator start timed out at the 120 s default (simulators boot inside the
 * request), and the platform refuses device queries over 255 characters.
 */
import { describe, it, beforeAll, afterAll, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { registerInspectionTools } from '../src/tools/inspection-tools.js';
import { setAccessLevelOverrideForTests } from '../src/utils/access-level.js';
import { isSameActivity, sessionCreateTimeoutMs, deviceQueryLengthError, DEVICE_QUERY_MAX_LENGTH } from '../src/api/webdriver.js';
import { startStubApi, connectTools, accountInfo, type StubApi, type ToolClient } from './helpers/offline.js';

let foreground = '.makePaymentView';
let sweepable = false;
let api: StubApi;
let tools: ToolClient;

beforeAll(async () => {
  api = await startStubApi((req) => {
    if (req.path === '/api/v1/users/my-account-info') return accountInfo('Admin', 'Default');
    if (req.path === '/wd/hub/session' && req.method === 'POST') {
      if (String(req.json.desiredCapabilities?.['digitalai:deviceQuery']).includes('SLOW')) return new Promise((r) => setTimeout(() => r({}), 400));
      // W3C (Appium Server) shape
      return { value: { sessionId: 'sid-1', capabilities: {
        'digitalai:reportTestId': 4242, 'digitalai:reportUrl': 'https://r/4242', deviceUDID: 'UDID-1',
        'digitalai:cloudDeviceName': 'Pixel 7 US-1', 'digitalai:publicModel': 'Pixel 7', platformName: 'Android', platformVersion: '14', appPackage: 'com.experitest.ExperiBank',
      } } };
    }
    if (req.path === '/wd/hub/session/sid-1/appium/device/current_activity') return { value: foreground };
    if (req.path === '/wd/hub/session/sid-1' && req.method === 'DELETE') return { value: null };
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
});
