/**
 * Android Auto / CarPlay projection (automotive_control + start_inspection_session automotiveProjection).
 *
 * Wire behavior mirrored from live probes (2026-10-09, Appium Server Android phones):
 *  - digitalai:automotive.start("800x480") → projection on; getScreenshot → base64 PNG; tap(x, y); stop → off
 *  - with the digitalai:automotiveProjection capability the platform refuses start AND stop
 *  - getDump is "not implemented for Android devices"
 * A fake Grid records every execute call; sessions are registered directly so nothing touches a real device.
 */
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resetClient } from '../src/api/client.js';
import { registerSession } from '../src/api/webdriver.js';
import { registerInspectionTools } from '../src/tools/inspection-tools.js';
import type { InspectionSession } from '../src/types/digital-ai.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const calls: Array<{ script: string; args: unknown[] }> = [];
let server: http.Server;
let client: Client;

function session(handle: string, extra: Partial<InspectionSession> = {}): InspectionSession {
  return {
    handle, gridSessionId: `sid-${handle}`, reportTestId: 0, reportUrl: '', cloudViewLink: null, deviceUDID: 'X',
    deviceName: 'Pixel 7', deviceModel: 'Pixel 7', deviceOs: 'Android', deviceVersion: '16', appPackage: '',
    startedAt: Date.now(), lastUsedAt: Date.now(), canDeleteReport: true, sessionFormat: 'w3c', platform: 'android', ...extra,
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (!/\/wd\/hub\/session\/[^/]+\/execute(\/sync)?$/.test(req.url ?? '')) { res.statusCode = 404; return void res.end('{}'); }
      const { script, args } = JSON.parse(body || '{}');
      calls.push({ script, args });
      // Live responses: Galaxy S10 / Android 12 rejects mid-session start (it projects fine via the capability);
      // a session without projection answers other commands with 404 "not specified".
      if ((req.url ?? '').includes('sid-NOCAP')) {
        res.statusCode = script === 'digitalai:automotive.start' ? 500 : 404;
        const message = script === 'digitalai:automotive.start' ? 'Failed to execute start("LOW")' : 'Automotive projection is not specified';
        return void res.end(JSON.stringify({ value: { error: 'unknown error', message } }));
      }
      // Live Appium Grid response: the execute layer runs the command as page JavaScript.
      if ((req.url ?? '').includes('sid-GRIDJS')) {
        res.statusCode = 500;
        return void res.end(JSON.stringify({ value: { error: 'unknown error', message: "An unknown server-side error occurred. status='false'. Failed to complete internal method: 'hybridRunJavascript args: [, 0, result = null;" } }));
      }
      const value = script === 'digitalai:automotive.getScreenshot' ? PNG : script === 'digitalai:automotive.getDump' ? '<dump/>' : null;
      res.end(JSON.stringify({ value }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  resetClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'aut_1_automotive', 'auto');
  const mcp = new McpServer({ name: 's', version: '0' });
  registerInspectionTools(mcp);
  client = new Client({ name: 'c', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(b), client.connect(a)]);
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { calls.length = 0; });

async function call(name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
  };
  return { res, text: res.content.filter((c) => c.type === 'text').map((c) => c.text).join('') };
}

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
