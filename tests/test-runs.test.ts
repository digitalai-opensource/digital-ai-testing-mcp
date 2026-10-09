/**
 * Test Run API tools (execute_test_run / get_test_run_status / cancel_test_run / get_test_run_command).
 * Wire format verified live 2026-10-09 (passing Maestro run, then a cancelled one):
 *  - multipart; deviceQueries in the QUERY STRING; Maestro bundle in the `tests` FILE field and it must contain flows/
 *  - cloudApp is a numeric id; cancel is POST; status counts are strings that can read "-1" mid-run
 * The local server asserts the exact multipart fields, so a regression to body device queries or a different file field fails.
 */
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  validateTestRunRequest,
  normalizeTestRunStatus,
  checkMaestroBundle,
  deviceQueriesQueryString,
  type TestRunRequest,
} from '../src/api/test-runs.js';
import { resetClient } from '../src/api/client.js';
import { registerTestRunTools } from '../src/tools/test-run-tools.js';
import { REGISTERED_TOOLS } from '../src/tools/meta-tools.js';

const Q = "@os='android' and @category='PHONE'";
const base: TestRunRequest = { executionType: 'MAESTRO', runningType: 'fastFeedback', cloudAppId: 27982153, testsPath: '/x/flows.zip', deviceQueries: [Q] };

let dir: string;
let goodZip: string;
let badZip: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'test-runs-'));
  const good = new AdmZip();
  good.addFile('flows/login.yaml', Buffer.from('appId: com.experitest.ExperiBank\n---\n- launchApp\n'));
  goodZip = join(dir, 'good.zip');
  good.writeZip(goodZip);
  const bad = new AdmZip();
  bad.addFile('login.yaml', Buffer.from('appId: x\n---\n- launchApp\n'));
  badZip = join(dir, 'bad.zip');
  bad.writeZip(badZip);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('test-runs (pure)', () => {
  it('accepts the verified Maestro shape', () => assert.equal(validateTestRunRequest(base), null));

  it('rejects ambiguous / missing sources and Maestro misuse', () => {
    const cases: Array<[Partial<TestRunRequest>, RegExp]> = [
      [{ cloudAppId: undefined }, /exactly one app source/],
      [{ appUrl: 'https://x/app.apk' }, /exactly one app source/],
      [{ testsPath: undefined, testsUrl: 'https://x/t.zip' }, /MAESTRO needs the flow bundle as a file/],
      [{ deviceQueries: [] }, /at least one deviceQuery/],
      [{ deviceQueries: [Q, Q] }, /fastFeedback takes exactly ONE/],
      [{ deviceQueries: ["@os='ios'"] }, /Android devices only/],
      [{ useTestOrchestrator: true }, /not supported with MAESTRO/],
      [{ retry: 9 }, /retry must be 0–5/],
    ];
    for (const [patch, re] of cases) assert.match(validateTestRunRequest({ ...base, ...patch }) ?? '', re, JSON.stringify(patch));
    assert.equal(validateTestRunRequest({ ...base, runningType: 'coverage', deviceQueries: [Q, Q] }), null, 'coverage takes several queries');
    assert.equal(validateTestRunRequest({ ...base, executionType: 'ESPRESSO', testsPath: undefined, testsUrl: 'https://x/t.zip' }), null);
  });

  it('normalizes the live status payload; "-1" mid-run counts become null; Cancelled is final', () => {
    const running = normalizeTestRunStatus('1', { 'Test Run State': 'Running', 'Number of passed tests': '1', 'Number of skipped tests': '-1', 'Link to Reporter': 'https://r' });
    assert.equal(running.finished, false);
    assert.equal(running.counts.passed, 1);
    assert.equal(running.counts.skipped, null);
    assert.equal(normalizeTestRunStatus('1', { 'Test Run State': 'Cancelled' }).finished, true);
    assert.equal(normalizeTestRunStatus('1', { 'Test Run State': 'Finished' }).finished, true);
  });

  it('Maestro bundle pre-flight mirrors the platform rule (flows/ directory required)', () => {
    assert.equal(checkMaestroBundle(goodZip), null);
    assert.match(checkMaestroBundle(badZip) ?? '', /flows\/ directory/);
    assert.match(checkMaestroBundle(join(dir, 'x.tar')) ?? '', /\.zip/);
  });

  it('device queries go in the query string, URL-encoded and repeated', () => {
    assert.equal(deviceQueriesQueryString(["@os='android'", "@os='ios'"]), 'deviceQueries=%40os%3D\'android\'&deviceQueries=%40os%3D\'ios\''.replace(/'/g, '%27'));
  });
});

// ─── Handler level ────────────────────────────────────────────────────────────

let server: http.Server;
let client: Client;
const hits: Array<{ method: string; path: string; query: URLSearchParams; body: string }> = [];
let state = 'Starting';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://x');
      hits.push({ method: req.method ?? '', path: u.pathname, query: u.searchParams, body: Buffer.concat(chunks).toString('latin1') });
      res.setHeader('Content-Type', 'application/json');
      if (u.pathname === '/api/v1/test-run/execute-test-run-async') {
        return void res.end(JSON.stringify({ status: 'SUCCESS', data: { 'Test Run Id': '555', 'Link to Reporter': 'https://r/555' } }));
      }
      if (u.pathname === '/api/v1/test-run/555/status') {
        return void res.end(JSON.stringify({ status: 'SUCCESS', data: { 'Test Run Id': '555', 'Test Run State': state, 'Number of passed tests': '1', 'Total number of tests': '1' } }));
      }
      if (u.pathname === '/api/v1/test-run/555/cancel' && req.method === 'POST') { state = 'Cancelled'; return void res.end('{"status":"SUCCESS"}'); }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  resetClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'aut_1_test_runs', 'tr');
  const mcp = new McpServer({ name: 's', version: '0' });
  registerTestRunTools(mcp);
  client = new Client({ name: 'c', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(b), client.connect(a)]);
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { hits.length = 0; state = 'Starting'; });

async function call(name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text?: string }>; isError?: boolean };
  return { res, text: res.content.map((c) => c.text ?? '').join('') };
}

describe('execute_test_run', () => {
  it('Maestro: uploads the bundle as the `tests` file, scalars as fields, device query in the URL', async () => {
    const { res, text } = await call('execute_test_run', { executionType: 'MAESTRO', cloudAppId: 27982153, testsPath: goodZip, deviceQueries: [Q], maxDevices: 1, outputFormat: 'json' });
    assert.notEqual(res.isError, true, text);
    assert.equal(JSON.parse(text).testRunId, '555');
    const h = hits[0];
    assert.equal(h.query.getAll('deviceQueries')[0], Q);
    assert.match(h.body, /name="tests"; filename="good\.zip"/);
    assert.match(h.body, /name="executionType"\r\n\r\nMAESTRO/);
    assert.match(h.body, /name="runningType"\r\n\r\nfastFeedback/);
    assert.match(h.body, /name="cloudApp"\r\n\r\n27982153/);
    assert.match(h.body, /name="maxDevices"\r\n\r\n1/);
    assert.doesNotMatch(h.body, /name="deviceQueries"/);
  });

  it('a bundle without flows/ is rejected locally — nothing is uploaded', async () => {
    const { res, text } = await call('execute_test_run', { executionType: 'MAESTRO', cloudAppId: 1, testsPath: badZip, deviceQueries: [Q] });
    assert.equal(res.isError, true);
    assert.match(text, /flows\/ directory/);
    assert.deepEqual(hits, []);
  });

  it('credential-file paths are refused before reading', async () => {
    const { res } = await call('execute_test_run', { executionType: 'MAESTRO', cloudAppId: 1, testsPath: join(dir, '.env'), deviceQueries: [Q] });
    assert.equal(res.isError, true);
    assert.deepEqual(hits, []);
  });
});

describe('get_test_run_status / cancel_test_run', () => {
  it('status normalizes counts', async () => {
    const { text } = await call('get_test_run_status', { testRunId: '555', outputFormat: 'json' });
    const s = JSON.parse(text);
    assert.equal(s.state, 'Starting');
    assert.equal(s.counts.passed, 1);
  });

  it('cancel without confirmDeletion previews and sends nothing; with it, POSTs /cancel and reports the new state', async () => {
    const preview = await call('cancel_test_run', { testRunId: '555' });
    assert.notEqual(preview.res.isError, true);
    assert.deepEqual(hits, []);
    const done = await call('cancel_test_run', { testRunId: '555', confirmDeletion: true, outputFormat: 'json' });
    assert.equal(hits[0].method, 'POST');
    assert.equal(hits[0].path, '/api/v1/test-run/555/cancel');
    assert.equal(JSON.parse(done.text.slice(done.text.indexOf('{'))).state, 'Cancelled');
  });
});

describe('get_test_run_command', () => {
  it('emits the same field names and URL-encoded device query as the executor', async () => {
    const { res, text } = await call('get_test_run_command', {
      executionType: 'MAESTRO', cloudAppId: 27982153, testsPath: 'C:\\work\\flows.zip', deviceQueries: [Q], localPlatform: 'linux', outputFormat: 'json',
    });
    assert.notEqual(res.isError, true, text);
    const { curlCommand, endpoint } = JSON.parse(text);
    assert.match(curlCommand, /-F "tests=@C:\/work\/flows\.zip"/);
    assert.match(curlCommand, /-F "executionType=MAESTRO"/);
    assert.match(curlCommand, /-F "cloudApp=27982153"/);
    assert.match(endpoint, /execute-test-run-async\?deviceQueries=%40os%3D%27android%27/);
    assert.deepEqual(hits, [], 'a command generator never calls the API');
  });
});

describe('REGISTERED_TOOLS stays in sync with the tool modules', () => {
  it('every server.tool registration is listed (and nothing extra)', () => {
    const toolsDir = join(__dirname, '..', 'src', 'tools');
    const registered = new Set<string>();
    for (const f of readdirSync(toolsDir)) {
      for (const m of readFileSync(join(toolsDir, f), 'utf8').matchAll(/server\.tool\(\s*'([a-z0-9_]+)'/g)) registered.add(m[1]);
    }
    const listed = new Set<string>(REGISTERED_TOOLS);
    assert.deepEqual([...registered].filter((t) => !listed.has(t)), [], 'registered but missing from REGISTERED_TOOLS');
    assert.deepEqual([...listed].filter((t) => !registered.has(t)), [], 'listed but not registered');
  });
});

