/**
 * audio_control against a stub Grid + repository. Source: dai-continuous-testing/UseCase-SIM-Card-Tests (repo scan
 * 2026-10-16). Verified live the same day on a Galaxy S24 with an audio line: record_start → play 5 s → record_stop
 * produced a 44-byte header-only WAV (the device played nothing), which the tool flags; a device without an audio line
 * fails with "Audio line is not configured"; the Grid is unverified for audio, so the tool refuses there.
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { registerInspectionTools } from '../src/tools/inspection-tools.js';
import { setAccessLevelOverrideForTests } from '../src/utils/access-level.js';
import { startStubApi, connectTools, accountInfo, type StubApi, type ToolClient } from './helpers/offline.js';

let recordingSize = 44;
let api: StubApi;
let tools: ToolClient;
const executed: Array<{ script: string; args: unknown[] }> = [];

beforeAll(async () => {
  api = await startStubApi((req) => {
    if (req.path === '/api/v1/users/my-account-info') return accountInfo('Admin', 'Default');
    if (req.path === '/wd/hub/session' && req.method === 'POST') {
      const grid = String(req.json.desiredCapabilities?.['digitalai:deviceQuery']).includes('GRID');
      return grid
        ? { sessionId: 'CLOUD-SID:grid-1', status: 0, value: { 'digitalai:reportTestId': 11, platformName: 'Android' } }
        : { value: { sessionId: 'w3c-1', capabilities: { 'digitalai:reportTestId': 12, platformName: 'Android', platformVersion: '14' } } };
    }
    if (req.path === '/wd/hub/session/w3c-1/execute/sync') {
      executed.push({ script: req.json.script, args: req.json.args });
      return { value: null };
    }
    if (req.path === '/api/v1/files') {
      const recordings = executed.filter((x) => x.script === 'seetest:client.startAudioRecording').map((x, i) => ({
        id: 900 + i, uniqueName: String(x.args[0]).replace(/^cloud:/, ''), size: recordingSize, projectName: 'Default', extension: 'wav',
      }));
      return { status: 'SUCCESS', data: [{ id: 1, uniqueName: 'hello.wav', size: 5000, projectName: 'Default', extension: 'wav' }, ...recordings], code: 'OK' };
    }
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

async function session(query = "@os='android'"): Promise<string> {
  return (await tools.callJson('start_inspection_session', { platform: 'android', deviceQuery: query })).handle as string;
}

describe('audio_control', () => {
  it('plays a repository clip with the argument passed separately, and play+duration stops afterwards', async () => {
    const h = await session();
    executed.length = 0;
    const r = await tools.call('audio_control', { handle: h, action: 'play', file: 'hello.wav', durationSeconds: 1 });
    assert.equal(r.res.isError, undefined, r.text);
    assert.deepEqual(executed.map((x) => x.script), ['seetest:client.startAudioPlay', 'seetest:client.stopAudioPlay']);
    assert.deepEqual(executed[0].args, ['cloud:hello.wav']);
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('refuses a clip that is not in the repository before touching the device', async () => {
    const h = await session();
    executed.length = 0;
    const r = await tools.call('audio_control', { handle: h, action: 'play', file: 'missing.wav' });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /No repository file named "missing\.wav"/);
    assert.equal(executed.length, 0);
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('record_stop reports the saved file and flags a header-only recording', async () => {
    const h = await session();
    for (const [size, empty] of [[44, true], [96_000, false]] as const) {
      recordingSize = size;
      await tools.call('audio_control', { handle: h, action: 'record_start', recordingName: `rec-${size}.wav` });
      const r = await tools.call('audio_control', { handle: h, action: 'record_stop' });
      const rec = JSON.parse(r.res.content[1].text!).recording;
      assert.equal(rec.name, `rec-${size}.wav`);
      assert.equal(rec.size, size);
      assert.equal(rec.headerOnly, empty);
      assert.equal(/EMPTY \(header only\)/.test(r.text), empty);
    }
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('refuses a second record_start while one is running', async () => {
    const h = await session();
    await tools.call('audio_control', { handle: h, action: 'record_start' });
    const r = await tools.call('audio_control', { handle: h, action: 'record_start' });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /already running/);
    await tools.call('audio_control', { handle: h, action: 'record_stop' });
    await tools.call('stop_inspection_session', { handle: h });
  });

  it('refuses Appium Grid sessions (audio is unverified there)', async () => {
    const h = await session("@os='android' and @name='GRID'");
    const r = await tools.call('audio_control', { handle: h, action: 'record_start' });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /only been verified on Appium Server/);
    await tools.call('stop_inspection_session', { handle: h });
  });
});
