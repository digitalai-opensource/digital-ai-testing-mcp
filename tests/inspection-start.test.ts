/**
 * start_inspection_session against a stub Grid: what the response says about the screen that is actually in front.
 * Remediation note 2026-10-14: with noReset (default true) a running Android app resumes on its LAST screen, not on
 * the requested appActivity; the agent assumed the login screen and wasted three "No element found" calls.
 */
import { describe, it, beforeAll, afterAll, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { registerInspectionTools } from '../src/tools/inspection-tools.js';
import { setAccessLevelOverrideForTests } from '../src/utils/access-level.js';
import { isSameActivity } from '../src/api/webdriver.js';
import { startStubApi, connectTools, accountInfo, type StubApi, type ToolClient } from './helpers/offline.js';

let foreground = '.makePaymentView';
let api: StubApi;
let tools: ToolClient;

beforeAll(async () => {
  api = await startStubApi((req) => {
    if (req.path === '/api/v1/users/my-account-info') return accountInfo('Admin', 'Default');
    if (req.path === '/wd/hub/session' && req.method === 'POST') {
      // W3C (Appium Server) shape
      return { value: { sessionId: 'sid-1', capabilities: {
        'digitalai:reportTestId': 4242, 'digitalai:reportUrl': 'https://r/4242', deviceUDID: 'UDID-1',
        'digitalai:cloudDeviceName': 'Pixel 7 US-1', 'digitalai:publicModel': 'Pixel 7', platformName: 'Android', platformVersion: '14', appPackage: 'com.experitest.ExperiBank',
      } } };
    }
    if (req.path === '/wd/hub/session/sid-1/appium/device/current_activity') return { value: foreground };
    if (req.path === '/wd/hub/session/sid-1' && req.method === 'DELETE') return { value: null };
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
