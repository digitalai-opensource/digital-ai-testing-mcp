/**
 * Android Auto / CarPlay projection (automotive_control + start_inspection_session automotiveProjection).
 *
 * Wire behavior mirrored from live probes (2026-10-09, Appium Server Android phones):
 *  - digitalai:automotive.start("800x480") → projection on; getScreenshot → base64 PNG; tap(x, y); stop → off
 *  - with the digitalai:automotiveProjection capability the platform refuses start AND stop
 *  - getDump is "not implemented for Android devices"
 * A fake Grid records every execute call; sessions are registered directly so nothing touches a real device.
 */
import { describe, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { registerSession, createInspectionSession, automotiveSessionHint } from '../src/api/webdriver.js';
import { registerInspectionTools } from '../src/tools/inspection-tools.js';
import { setAccessLevelOverrideForTests } from '../src/utils/access-level.js';
import type { InspectionSession } from '../src/types/digital-ai.js';
import { startStubApi, connectTools, accountInfo, reply, type StubApi, type ToolClient } from './helpers/offline.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const calls: Array<{ script: string; args: unknown[] }> = [];
const sessionBodies: Array<{ desiredCapabilities: Record<string, unknown> }> = [];
const deleted: number[][] = [];
let api: StubApi;
let tools: ToolClient;

function session(handle: string, extra: Partial<InspectionSession> = {}): InspectionSession {
  return {
    handle, gridSessionId: `sid-${handle}`, reportTestId: 0, reportUrl: '', cloudViewLink: null, deviceUDID: 'X',
    deviceName: 'Pixel 7', deviceModel: 'Pixel 7', deviceOs: 'Android', deviceVersion: '16', appPackage: '',
    startedAt: Date.now(), lastUsedAt: Date.now(), canDeleteReport: true, sessionFormat: 'w3c', platform: 'android', ...extra,
  };
}

beforeAll(async () => {
  api = await startStubApi((req) => {
    if (req.path === '/api/v1/users/my-account-info') return accountInfo('ProjectAdmin', 'Mobile QA');
    // Session START (projection via capability) — the live Appium-infrastructure failure, verified 2026-10-10.
    if (req.path === '/wd/hub/session' && req.method === 'POST') {
      sessionBodies.push(req.json as { desiredCapabilities: Record<string, unknown> });
      return reply(500, { value: { message: 'Failed to prepare the Appium Infrastructure: Failed to enable automotive dev mode and start Android Auto on the device.' } });
    }
    if (req.path === '/reporter/api/tests/list') {
      const name = (req.json.filter as Array<{ property: string; value: string }> | undefined)?.find((f) => f.property === 'name')?.value;
      const now = Date.now();
      return { count: null, data: [
        { test_id: 9001, name, status: 'Error', start_time: new Date(now).toISOString() },             // this attempt
        { test_id: 9002, name, status: 'Passed', start_time: new Date(now).toISOString() },            // not a failed start
        { test_id: 9003, name, status: 'Error', start_time: new Date(now - 3_600_000).toISOString() }, // an hour old
      ] };
    }
    if (req.path === '/reporter/api/tests/delete') { deleted.push(req.json as unknown as number[]); return {}; }
    if (!/\/wd\/hub\/session\/[^/]+\/execute(\/sync)?$/.test(req.path)) return undefined;
    const { script, args } = req.json;
    calls.push({ script, args });
    // Live responses: Galaxy S10 / Android 12 rejects mid-session start (it projects fine via the capability);
    // a session without projection answers other commands with 404 "not specified".
    if (req.path.includes('sid-NOCAP')) {
      const message = script === 'digitalai:automotive.start' ? 'Failed to execute start("LOW")' : 'Automotive projection is not specified';
      return reply(script === 'digitalai:automotive.start' ? 500 : 404, { value: { error: 'unknown error', message } });
    }
    // Live Appium Grid response: the execute layer runs the command as page JavaScript.
    if (req.path.includes('sid-GRIDJS')) {
      return reply(500, { value: { error: 'unknown error', message: "An unknown server-side error occurred. status='false'. Failed to complete internal method: 'hybridRunJavascript args: [, 0, result = null;" } });
    }
    const value = script === 'digitalai:automotive.getScreenshot' ? PNG : script === 'digitalai:automotive.getDump' ? '<dump/>' : null;
    return { value };
  }, { key: 'aut_1_automotive', profile: 'auto' });
  tools = await connectTools(registerInspectionTools);
});
afterAll(async () => { await tools.close(); await api.close(); });
beforeEach(() => { calls.length = 0; sessionBodies.length = 0; deleted.length = 0; });
afterEach(() => setAccessLevelOverrideForTests(null));

const call = (name: string, args: Record<string, unknown>) => tools.call(name, args);

describe('automotive_control — command mode (toggled mid-session)', () => {
  it('start → screenshot (image) → tap → stop sends the platform commands with the right args', async () => {
    registerSession(session('AAAA0001'));
    assert.notEqual((await call('automotive_control', { handle: 'AAAA0001', action: 'start', resolution: '1280x720' })).res.isError, true);
    const shot = await call('automotive_control', { handle: 'AAAA0001', action: 'screenshot' });
    const img = shot.res.content.find((c) => c.type === 'image');
    assert.equal(img?.mimeType, 'image/png');
    assert.equal(img?.data, PNG);
    await call('automotive_control', { handle: 'AAAA0001', action: 'tap', x: 714, y: 62 });
    await call('automotive_control', { handle: 'AAAA0001', action: 'stop' });
    assert.deepEqual(calls, [
      { script: 'digitalai:automotive.start', args: ['1280x720'] },
      { script: 'digitalai:automotive.getScreenshot', args: [] },
      { script: 'digitalai:automotive.tap', args: [714, 62] },
      { script: 'digitalai:automotive.stop', args: [] },
    ]);
  });

  it('a second start while running is answered locally (the platform would 404)', async () => {
    registerSession(session('AAAA0002'));
    await call('automotive_control', { handle: 'AAAA0002', action: 'start' });
    const again = await call('automotive_control', { handle: 'AAAA0002', action: 'start' });
    assert.match(again.text, /already running/);
    assert.equal(calls.filter((c) => c.script === 'digitalai:automotive.start').length, 1);
  });

  it('tap without coordinates and Android dump are refused before any request', async () => {
    registerSession(session('AAAA0003'));
    assert.equal((await call('automotive_control', { handle: 'AAAA0003', action: 'tap', x: 5 })).res.isError, true);
    const dump = await call('automotive_control', { handle: 'AAAA0003', action: 'dump' });
    assert.equal(dump.res.isError, true);
    assert.match(dump.text, /iOS only/);
    assert.deepEqual(calls, []);
  });

  it('iOS dump, cluster screenshot and cluster content pass the CarPlay arguments', async () => {
    registerSession(session('AAAA0004', { platform: 'ios' }));
    const dump = await call('automotive_control', { handle: 'AAAA0004', action: 'dump' });
    assert.match(dump.text, /<dump\/>/);
    await call('automotive_control', { handle: 'AAAA0004', action: 'screenshot', display: 'cluster' });
    await call('automotive_control', { handle: 'AAAA0004', action: 'start', clusterContent: 'Map' });
    assert.deepEqual(calls.map((c) => [c.script, c.args]), [
      ['digitalai:automotive.getDump', []],
      ['digitalai:automotive.getScreenshot', ['cluster']],
      ['digitalai:automotive.start', ['800x480', 'Map']],
    ]);
  });

  it('clusterContent on Android is refused', async () => {
    registerSession(session('AAAA0005'));
    const r = await call('automotive_control', { handle: 'AAAA0005', action: 'start', clusterContent: 'Map' });
    assert.equal(r.res.isError, true);
    assert.deepEqual(calls, []);
  });
});

describe('automotive_control — platform refusals are explained, not misread as a dead session', () => {
  it('a device that rejects mid-session start points to the automotiveProjection capability', async () => {
    registerSession(session('NOCAP'));
    const r = await call('automotive_control', { handle: 'NOCAP', action: 'start' });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /not supported on this device/);
    assert.match(r.text, /automotiveProjection/);
  });

  it('Appium Grid (commands run as JavaScript) is explained as unsupported, not as a dead session', async () => {
    registerSession(session('GRIDJS', { sessionFormat: 'jwp' }));
    const r = await call('automotive_control', { handle: 'GRIDJS', action: 'screenshot' });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /Appium Grid does not support/);
    assert.doesNotMatch(r.text, /terminated|no longer usable|hybridRunJavascript/);
  });

  it('a 404 "projection is not specified" keeps the platform message and does NOT claim the session died', async () => {
    registerSession(session('NOCAP'));
    const r = await call('automotive_control', { handle: 'NOCAP', action: 'screenshot' });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /Automotive projection is not specified/);
    assert.doesNotMatch(r.text, /terminated|no longer usable/);
  });
});

describe('automotive_control — capability mode (projection for the whole session)', () => {
  it('start and stop are explained locally, never sent (the platform refuses both)', async () => {
    registerSession(session('BBBB0001', { automotiveMode: 'capability', automotiveRunning: true }));
    assert.match((await call('automotive_control', { handle: 'BBBB0001', action: 'start' })).text, /refuses start\/stop/);
    assert.match((await call('automotive_control', { handle: 'BBBB0001', action: 'stop' })).text, /stays on until the session ends/);
    assert.deepEqual(calls, []);
    await call('automotive_control', { handle: 'BBBB0001', action: 'screenshot' });
    assert.equal(calls.length, 1);
  });
});

describe('start_inspection_session — automotive argument validation (before any device allocation)', () => {
  it('instrumentCluster needs iOS + automotiveProjection; CarPlay is 800x480 only', async () => {
    for (const args of [
      { platform: 'android', automotiveProjection: '800x480', instrumentCluster: 'Map' },
      { platform: 'ios', instrumentCluster: 'Map' },
      { platform: 'ios', automotiveProjection: '1280x720' },
    ]) {
      const r = await call('start_inspection_session', args);
      assert.equal(r.res.isError, true, JSON.stringify(args));
    }
    assert.deepEqual(calls, []);
  });
});

describe('start_inspection_session — automotiveProjection start failures (verified live 2026-10-10)', () => {
  it('a failed projection start uses an Android 10+ default query and deletes only its own Error report', async () => {
    setAccessLevelOverrideForTests('cloud-admin');
    await assert.rejects(
      createInspectionSession({ platform: 'android', automotiveProjection: '800x480', testName: 'UAT automotive' }),
      (e: Error) => /Android 10 or later/.test(e.message) && /The report this attempt created \(9001\) was deleted\./.test(e.message)
    );
    assert.equal(sessionBodies[0].desiredCapabilities['digitalai:deviceQuery'], "@os='android' and @category='PHONE' and @version>='10.0'");
    assert.deepEqual(deleted, [[9001]], 'not the Passed record, not the hour-old one');
  });

  it('an explicit query or a non-projection session is left alone', async () => {
    setAccessLevelOverrideForTests('cloud-admin');
    await assert.rejects(createInspectionSession({ platform: 'android', automotiveProjection: '800x480', deviceQuery: "@serialNumber='X'" }));
    await assert.rejects(createInspectionSession({ platform: 'android' }));
    assert.equal(sessionBodies[0].desiredCapabilities['digitalai:deviceQuery'], "@serialNumber='X'");
    assert.equal(sessionBodies[1].desiredCapabilities['digitalai:deviceQuery'], "@os='android' and @category='PHONE'");
  });

  it('when the role may not delete reports, the leftover report is named instead', async () => {
    setAccessLevelOverrideForTests('project-user');
    // The project-level refusal needs the project flag readable and false; when it can't be read the platform decides,
    // so assert only that either path ends with a clear sentence about report 9001.
    await assert.rejects(
      createInspectionSession({ platform: 'android', testName: 'UAT automotive' }),
      (e: Error) => /9001/.test(e.message)
    );
  });

  it('automotiveSessionHint gives specific guidance per platform failure', () => {
    assert.match(automotiveSessionHint('HTTP 500: Automotive Projection is only supported on Apple Silicon Device Host Machines') ?? '', /Apple Silicon device host.*not your request/);
    assert.match(automotiveSessionHint('HTTP 500: Failed to enable automotive dev mode and start Android Auto on the device') ?? '', /Android 10 or later/);
    assert.match(automotiveSessionHint('HTTP 500: Timeout while waiting for the DHU process to connect.') ?? '', /head unit \(DHU\) never connected/);
    assert.match(automotiveSessionHint('HTTP 500: no Android Auto head unit server on the device') ?? '', /property of the device/);
    assert.equal(automotiveSessionHint('HTTP 500: something else'), null);
  });
});
