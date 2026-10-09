/**
 * find_elements enrichment cap. Each detailed element costs ~8 requests; with no cap, 48 iOS home-screen icons took
 * 80–160 s live (2026-10-09), past the ~60 s MCP client timeout. Matches beyond the cap come back as IDs only.
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

const MATCHES = 30;
const attrHits = new Set<string>();
let server: http.Server;
let client: Client;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const url = req.url ?? '';
      res.setHeader('Content-Type', 'application/json');
      if (url.endsWith('/elements')) {
        return void res.end(JSON.stringify({ value: Array.from({ length: MATCHES }, (_, i) => ({ 'element-6066-11e4-a52e-4f735466cecf': `el-${i + 1}` })) }));
      }
      const attr = url.match(/\/element\/([^/]+)\/attribute\/([^/?]+)/);
      if (attr) {
        attrHits.add(attr[1]);
        return void res.end(JSON.stringify({ value: attr[2] === 'text' ? `text of ${attr[1]}` : attr[2] === 'clickable' ? 'true' : null }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  resetClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'aut_1_find_test', 'find');
  const mcp = new McpServer({ name: 's', version: '0' });
  registerInspectionTools(mcp);
  client = new Client({ name: 'c', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(b), client.connect(a)]);
  registerSession({
    handle: 'FIND0001', gridSessionId: 'sid-find', reportTestId: 0, reportUrl: '', cloudViewLink: null, deviceUDID: 'X',
    deviceName: 'Galaxy S10', deviceModel: 'Galaxy S10', deviceOs: 'Android', deviceVersion: '12', appPackage: '',
    startedAt: Date.now(), lastUsedAt: Date.now(), canDeleteReport: true, sessionFormat: 'w3c', platform: 'android',
  } as InspectionSession);
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => attrHits.clear());

async function find(args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name: 'find_elements', arguments: { handle: 'FIND0001', strategy: 'class name', selector: 'android.widget.TextView', ...args } })) as { content: Array<{ text?: string }>; isError?: boolean };
  return res.content.map((c) => c.text ?? '').join('');
}

describe('find_elements enrichment cap', () => {
  it('details only the first 20 matches by default and lists the rest by elementId', async () => {
    const text = await find();
    assert.equal(attrHits.size, 20);
    assert.ok(attrHits.has('el-1') && attrHits.has('el-20') && !attrHits.has('el-21'));
    assert.match(text, /Found 30 elements/);
    assert.match(text, /text of el-20/);
    assert.match(text, /Attributes shown for 20 of 30/);
    assert.match(text, /21\. el-21/);
    assert.match(text, /30\. el-30/);
  });

  it('maxResults raises or lowers the cap', async () => {
    await find({ maxResults: 5 });
    assert.equal(attrHits.size, 5);
    attrHits.clear();
    const text = await find({ maxResults: 30 });
    assert.equal(attrHits.size, 30);
    assert.doesNotMatch(text, /Attributes shown for/);
  });
});
