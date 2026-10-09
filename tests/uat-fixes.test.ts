/**
 * Regressions for the UAT run of 2026-10-09 (reports/uat-report-2026-10-09.md) and the systemic gaps behind them:
 *  - #20  transactions: deviceOs arrives as "IOS"/"ANDROID" for recent records → normalised once at the API boundary
 *  - #49  list tools: a list cut at maxResults must say so in its JSON (total / returned / truncated)
 *  - #53  get_page_dom: the default call must return the interactive elements on a standard (non-shadow) page
 *  - #64  every *_command tool: the JSON payload must carry the plaintext-credential warning
 * (#24, the daily-trend cap, is covered in tests/reporting-sort.test.ts.)
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { normaliseDeviceOs, listTransactions } from '../src/api/transactions.js';
import { withPaging, applyMaxResults } from '../src/utils/pagination.js';
import { PLAINTEXT_KEY_WARNING } from '../src/utils/command-payload.js';
import { resetClient } from '../src/api/client.js';
import { registerSession } from '../src/api/webdriver.js';
import { registerBrowserTools } from '../src/tools/browser-tools.js';
import { registerWebInspectionTools } from '../src/tools/web-inspection-tools.js';
import { registerTestRunTools } from '../src/tools/test-run-tools.js';
import { registerReportingTools } from '../src/tools/reporting-tools.js';
import { registerRepositoryTools } from '../src/tools/repository-tools.js';
import { registerTransactionTools } from '../src/tools/transaction-tools.js';
import type { InspectionSession } from '../src/types/digital-ai.js';

describe('pure helpers', () => {
  it('normaliseDeviceOs folds every casing to iOS / Android and leaves anything else alone', () => {
    for (const v of ['IOS', 'ios', 'iOS', ' iOS ']) assert.equal(normaliseDeviceOs(v), 'iOS');
    for (const v of ['ANDROID', 'android', 'Android']) assert.equal(normaliseDeviceOs(v), 'Android');
    assert.equal(normaliseDeviceOs('Windows'), 'Windows');
    assert.equal(normaliseDeviceOs(undefined), undefined);
  });

  it('withPaging adds total/returned/truncated without overwriting existing keys', () => {
    const paged = applyMaxResults(Array.from({ length: 60 }, (_, i) => i), 50);
    assert.deepEqual(withPaging({ items: [] }, paged), { items: [], total: 60, returned: 50, truncated: true });
    assert.equal(withPaging({ total: 'devices' }, paged).total, 'devices', 'an existing total keeps its meaning');
  });
});

// ─── handler level, against a local server standing in for the API and the Grid ──────────────────────────────

let server: http.Server;
let client: Client;
const BROWSERS = Array.from({ length: 60 }, (_, i) => ({ browserName: i % 2 ? 'chrome' : 'MicrosoftEdge', browserVersion: String(100 + i), platform: 'WINDOWS', osName: 'Windows 11', agentName: `agent-${i}`, region: 'US1' }));
const TXS = [
  { id: 1, name: 'Login', deviceOs: 'IOS', startTime: '2026-09-17T00:00:00Z', duration: 1000, speedIndex: -1 },
  { id: 2, name: 'Login', deviceOs: 'iOS', startTime: '2024-11-05T00:00:00Z', duration: 1000, speedIndex: 900 },
  { id: 3, name: 'Login', deviceOs: 'ANDROID', startTime: '2026-09-01T00:00:00Z', duration: 1000, speedIndex: 800 },
];
const ELEMENTS = [{ tag: 'a', href: 'https://www.iana.org/domains/example', text: 'More information...' }];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const url = req.url ?? '';
      if (url.startsWith('/api/v1/browsers')) return void res.end(JSON.stringify({ status: 'SUCCESS', data: BROWSERS }));
      if (url.startsWith('/reporter/api/transactions/list')) return void res.end(JSON.stringify({ count: null, data: TXS }));
      if (/\/wd\/hub\/session\/[^/]+\/execute\/sync$/.test(url)) {
        const { script } = JSON.parse(body || '{}');
        // Detection script → page meta; anything else is the element walker.
        const value = /hasShadowDom/.test(script) && !/extractDOM/.test(script)
          ? JSON.stringify({ url: 'https://example.com/', title: 'Example Domain', hasShadowDom: false })
          : JSON.stringify({ url: 'https://example.com/', title: 'Example Domain', hasShadowDom: true, elements: ELEMENTS });
        return void res.end(JSON.stringify({ value }));
      }
      if (/\/wd\/hub\/session\/[^/]+\/source$/.test(url)) return void res.end(JSON.stringify({ value: '<html><body><a href="x">More</a></body></html>' }));
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  resetClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'aut_1_uat_fixes', 'uat');
  const mcp = new McpServer({ name: 's', version: '0' });
  for (const register of [registerBrowserTools, registerWebInspectionTools, registerTestRunTools, registerReportingTools, registerRepositoryTools, registerTransactionTools]) register(mcp);
  client = new Client({ name: 'c', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(b), client.connect(a)]);
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function call(name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text?: string }>; isError?: boolean };
  return { res, text: res.content.map((c) => c.text ?? '').join('') };
}

describe('#20 transactions — deviceOs casing', () => {
  it('listTransactions returns normalised deviceOs and still maps the -1 Speed Index sentinel to null', async () => {
    const txs = await listTransactions();
    assert.deepEqual(txs.map((t) => t.deviceOs), ['iOS', 'iOS', 'Android']);
    assert.equal(txs[0].speedIndex, null);
  });

  it('list_transactions(deviceOs: "iOS") includes records the API stored as "IOS"', async () => {
    const { text } = await call('list_transactions', { deviceOs: 'iOS', outputFormat: 'json' });
    assert.deepEqual(JSON.parse(text).transactions.map((t: { id: number }) => t.id).sort(), [1, 2]);
  });
});

describe('#49 list truncation is visible in JSON', () => {
  it('list_available_browsers reports total / returned / truncated', async () => {
    const j = JSON.parse((await call('list_available_browsers', { outputFormat: 'json' })).text);
    assert.equal(j.total, 60);
    assert.equal(j.returned, 50);
    assert.equal(j.truncated, true);
    assert.equal(j.browsers.length, 50);
  });
});

describe('#53 get_page_dom — default call returns elements on a standard page', () => {
  const web = (handle: string): InspectionSession => ({
    handle, gridSessionId: `sid-${handle}`, reportTestId: 0, reportUrl: '', cloudViewLink: null, deviceUDID: '', deviceName: 'chrome',
    deviceModel: '', deviceOs: 'Windows', deviceVersion: '', appPackage: '', startedAt: Date.now(), lastUsedAt: Date.now(),
    canDeleteReport: true, sessionFormat: 'w3c', platform: 'web', browserName: 'chrome',
  });

  it('elements are listed, hasShadowDom reflects detection (false), json form is machine-readable', async () => {
    registerSession(web('WEB00001'));
    const human = await call('get_page_dom', { handle: 'WEB00001' });
    assert.notEqual(human.res.isError, true, human.text);
    assert.match(human.text, /Interactive elements \(1 found\)/);
    assert.match(human.text, /href="https:\/\/www\.iana\.org\/domains\/example"/);
    assert.doesNotMatch(human.text, /DOM extracted as raw HTML/, 'the old "length only, no content" output must not return');
    const j = JSON.parse((await call('get_page_dom', { handle: 'WEB00001', outputFormat: 'json' })).text);
    assert.equal(j.hasShadowDom, false, 'the detection result, not "the walker ran"');
    assert.equal(j.elementCount, 1);
  });

  it('shadowMode "never" prints the HTML instead of only announcing its length', async () => {
    registerSession(web('WEB00002'));
    const { text } = await call('get_page_dom', { handle: 'WEB00002', shadowMode: 'never' });
    assert.match(text, /--- RAW HTML \(\d+ chars\) ---/);
    assert.match(text, /<a href="x">More<\/a>/);
  });
});

describe('#64 command generators carry the credential warning in JSON', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['get_test_run_command', { executionType: 'MAESTRO', cloudAppId: 1, testsPath: '/x/flows.zip', deviceQueries: ["@os='android'"], localPlatform: 'linux' }],
    ['get_test_attachments_download_command', { uuid: '44882dbd-7cbd-4f82-96a1-9e12fcbead5f', localPlatform: 'linux' }],
    ['get_repository_upload_command', { localFilePath: '/x/data.json', localPlatform: 'linux' }],
  ];
  for (const [tool, args] of cases) {
    it(tool, async () => {
      const { res, text } = await call(tool, { ...args, outputFormat: 'json' });
      assert.notEqual(res.isError, true, text);
      assert.equal(JSON.parse(text).credentialWarning, PLAINTEXT_KEY_WARNING);
    });
  }
});
