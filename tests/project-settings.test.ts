/**
 * v1 project settings — wire format verified live 2026-10-09 (DAIMCP POC, no-op writes):
 *  - every setter takes its value in the QUERY STRING; a JSON body → 400 "Required <type> parameter ... is not present"
 *  - getters wrap the value in a one-key object of STRINGS ({ maxQueuedTests: "50" })
 *  - webhook cleanup lives at /webhook-cleanup (/web-hook-cleanup → 404)
 *  - the browser limit parameter is maxSeleniumSessions; automation memory is maxAutomationMemory, 256–1024 MB
 * The local server below enforces exactly those rules, so a regression to body params or old paths fails here.
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resetClient } from '../src/api/client.js';
import { clearAccessInfoCache } from '../src/utils/access-level.js';
import { registerProjectTools } from '../src/tools/project-tools.js';

const PARAM: Record<string, string[]> = {
  'web-cleanup': ['enable'], 'webhook-cleanup': ['enable'], 'max-reservations': ['maxReservations'],
  'max-queued-tests': ['maxQueuedTests'], 'max-concurrent-browser': ['maxSeleniumSessions'],
  'max-automation-memory': ['maxAutomationMemory'], 'allow-telephony': ['allowCalls', 'allowSMS'],
};
const state: Record<string, string> = {
  webCleanupMode: 'false', webHookCleanupMode: 'true', maxReservationsMode: 'false', maxQueuedTests: '50',
  maxSeleniumSessions: '-1', maxAutomationMemory: '512',
};
const GET_KEY: Record<string, string> = {
  'web-cleanup': 'webCleanupMode', 'webhook-cleanup': 'webHookCleanupMode', 'max-reservations': 'maxReservationsMode',
  'max-queued-tests': 'maxQueuedTests', 'max-concurrent-browser': 'maxSeleniumSessions', 'max-automation-memory': 'maxAutomationMemory',
};
const writes: string[] = [];
let server: http.Server;
let client: Client;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const u = new URL(req.url ?? '/', 'http://x');
      const m = u.pathname.match(/^\/api\/v1\/projects\/(\d+)\/([a-z-]+)$/);
      const setting = m?.[2] ?? '';
      if (!m || (!(setting in PARAM) && setting !== 'notes')) { res.statusCode = 404; return void res.end('{"detail":"No static resource"}'); }
      if (setting === 'notes') return void res.end('{"status":"SUCCESS","data":null}');
      if (req.method === 'GET') {
        const k = GET_KEY[setting];
        return void res.end(JSON.stringify({ status: 'SUCCESS', data: { [k]: state[k] }, code: 'OK' }));
      }
      const missing = PARAM[setting].find((p) => !u.searchParams.has(p));
      if (missing) { res.statusCode = 400; return void res.end(JSON.stringify({ status: 'ERROR', message: `Required parameter '${missing}' is not present` })); }
      if (setting === 'max-automation-memory') {
        const v = Number(u.searchParams.get('maxAutomationMemory'));
        if (v < 256 || v > 1024) { res.statusCode = 400; return void res.end('{"message":"maxAutomationMemory must be between 256 and 1024"}'); }
        state.maxAutomationMemory = String(v);
      }
      writes.push(`${setting}?${u.searchParams.toString()}${body ? ' BODY' : ''}`);
      res.end('{"status":"SUCCESS","code":"OK"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  clearAccessInfoCache();
  resetClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'aut_1_project_settings', 'ps');
  const mcp = new McpServer({ name: 's', version: '0' });
  registerProjectTools(mcp);
  client = new Client({ name: 'c', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(b), client.connect(a)]);
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function call(name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text?: string }>; isError?: boolean };
  return { res, text: res.content.map((c) => c.text ?? '').join('') };
}

describe('update_project_settings — query-string setters', () => {
  it('sends every setting as query params (never a body) to the right paths', async () => {
    writes.length = 0;
    const { res, text } = await call('update_project_settings', {
      projectId: 7, webCleanup: true, webhookCleanup: false, maxReservations: 3, maxQueuedTests: 40,
      maxConcurrentBrowserSessions: 5, maxAutomationMemoryMB: 768,
    });
    assert.notEqual(res.isError, true, text);
    assert.deepEqual(writes, [
      'web-cleanup?enable=true', 'webhook-cleanup?enable=false', 'max-reservations?maxReservations=3',
      'max-queued-tests?maxQueuedTests=40', 'max-concurrent-browser?maxSeleniumSessions=5', 'max-automation-memory?maxAutomationMemory=768',
    ]);
    assert.match(text, /Max Automation Memory: 768 MB \(verified\)/);
  });

  it('rejects automation memory outside 256–1024 before any request', async () => {
    writes.length = 0;
    for (const v of [100, 2048]) {
      const { res } = await call('update_project_settings', { projectId: 7, maxAutomationMemoryMB: v });
      assert.equal(res.isError, true, String(v));
    }
    assert.deepEqual(writes, []);
  });

  it('set_telephony_status sends allowCalls/allowSMS as query params', async () => {
    writes.length = 0;
    const { res, text } = await call('set_telephony_status', { projectId: 7, allowCalls: true, allowSMS: false });
    assert.notEqual(res.isError, true, text);
    assert.deepEqual(writes, ['allow-telephony?allowCalls=true&allowSMS=false']);
  });
});

describe('get_project_settings — unwraps string-valued getters', () => {
  it('returns real booleans/numbers, including automation memory', async () => {
    state.maxAutomationMemory = '512';
    const { res, text } = await call('get_project_settings', { projectId: 7, outputFormat: 'json' });
    assert.notEqual(res.isError, true, text);
    const j = JSON.parse(text);
    assert.equal(j.webCleanup, false);
    assert.equal(j.webhookCleanup, true);
    assert.equal(j.reservationLimitEnforced, false);
    assert.equal(j.maxQueuedTests, 50);
    assert.equal(j.maxConcurrentBrowserSessions, -1);
    assert.equal(j.maxAutomationMemoryMB, 512);
  });
});
