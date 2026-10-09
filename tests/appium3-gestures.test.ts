/**
 * Appium 3 removed the legacy /touch/perform route (verified live on Appium Server 3.8.0 → 404). Gestures on W3C
 * sessions use /actions and only fall back to /touch/perform on an unknown-command error. When both fail, the error
 * must show WHY /actions failed — previously only the fallback's "not found" surfaced.
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

let mode: 'actions-ok' | 'actions-unknown' = 'actions-ok';
const hits: string[] = [];
let server: http.Server;
let client: Client;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const url = req.url ?? '';
      hits.push(url.replace(/^\/wd\/hub\/session\/[^/]+/, ''));
      res.setHeader('Content-Type', 'application/json');
      if (url.endsWith('/window/rect')) return void res.end(JSON.stringify({ value: { width: 1080, height: 2280, x: 0, y: 0 } }));
      if (url.endsWith('/actions')) {
        if (mode === 'actions-ok') return void res.end('{"value":null}');
        res.statusCode = 404;
        return void res.end(JSON.stringify({ value: { error: 'unknown command', message: 'The requested resource could not be found (actions disabled on this agent)' } }));
      }
      if (url.endsWith('/touch/perform')) {
        res.statusCode = 404; // Appium 3: route removed
        return void res.end(JSON.stringify({ value: { error: 'unknown command', message: 'The requested resource could not be found, or a request was received using an HTTP method that is not supported by the mapped resource.' } }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  resetClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'aut_1_appium3', 'a3');
  const mcp = new McpServer({ name: 's', version: '0' });
  registerInspectionTools(mcp);
  client = new Client({ name: 'c', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(b), client.connect(a)]);
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { hits.length = 0; });

const session = (handle: string): InspectionSession => ({
  handle, gridSessionId: `sid-${handle}`, reportTestId: 0, reportUrl: '', cloudViewLink: null, deviceUDID: 'X', deviceName: 'Galaxy S10',
  deviceModel: 'Galaxy S10', deviceOs: 'Android', deviceVersion: '12', appPackage: '', startedAt: Date.now(), lastUsedAt: Date.now(),
  canDeleteReport: true, sessionFormat: 'w3c', platform: 'android',
});

async function call(name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text?: string }>; isError?: boolean };
  return { res, text: res.content.map((c) => c.text ?? '').join('') };
}

describe('W3C gestures on Appium 3', () => {
  it('uses /actions and never touches /touch/perform when /actions works', async () => {
    mode = 'actions-ok';
    registerSession(session('A3000001'));
    const { res, text } = await call('swipe_screen', { handle: 'A3000001', direction: 'up' });
    assert.notEqual(res.isError, true, text);
    assert.match(text, /w3c-actions/);
    assert.ok(!hits.some((h) => h.endsWith('/touch/perform')));
  });

  it('when both fail, the error names the /actions failure first and explains the removed legacy route', async () => {
    mode = 'actions-unknown';
    registerSession(session('A3000002'));
    for (const [tool, args] of [
      ['swipe_screen', { direction: 'up' }],
      ['long_press', { x: 10, y: 10 }],
      ['double_tap', { x: 10, y: 10 }],
    ] as const) {
      const { res, text } = await call(tool, { handle: 'A3000002', ...args });
      assert.equal(res.isError, true, tool);
      assert.match(text, /W3C \/actions failed: .*actions disabled on this agent/, `${tool}: primary error first`);
      assert.match(text, /does not exist on Appium 3/, `${tool}: explains the removed route`);
    }
  });
});
