/**
 * Reporter status coverage — all SIX statuses (Passed, Failed, Error, Incomplete, Skipped, Healed) must reach every
 * summary. Before 2026-10-09 the summaries hardcoded Passed/Failed/Incomplete: on the dev tenant ~27k Error records
 * were missing from get_project_test_summary, and get_test_view_summary 400'd on every call (wrong path).
 *
 * Pure helpers are tested directly; the two summary tools run through a real MCP client/server pair against a local
 * HTTP server that returns the response shapes captured live (grouped pivot row, testView /{id}/summary).
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  countsFromPivotRow,
  tallyStatuses,
  passRate,
  statusOutcome,
  unknownStatusCount,
} from '../src/utils/test-status.js';
import { resetClient } from '../src/api/client.js';
import { clearAccessInfoCache } from '../src/utils/access-level.js';
import { registerReportingTools } from '../src/tools/reporting-tools.js';
import { registerTestViewTools } from '../src/tools/test-view-tools.js';

// Exact shape returned live by POST /reporter/api/tests/grouped {pivotBy:["status"]} and GET /testView/{id}/summary.
const PIVOT_ROW = {
  passedCount: 683279, failedCount: 29030, incompleteCount: 2730,
  skippedCount: 37, errorCount: 27131, healedCount: 57, _count_: 742264,
};

describe('test-status helpers (pure)', () => {
  it('countsFromPivotRow reads all six columns and the server total', () => {
    const c = countsFromPivotRow(PIVOT_ROW);
    assert.deepEqual(c, { passed: 683279, failed: 29030, error: 27131, incomplete: 2730, skipped: 37, healed: 57, total: 742264 });
    assert.equal(unknownStatusCount(c), 0);
  });

  it('a status the code does not know yet still counts in the total (via _count_)', () => {
    const c = countsFromPivotRow({ passedCount: 5, failedCount: 1, _count_: 9 });
    assert.equal(c.total, 9);
    assert.equal(unknownStatusCount(c), 3);
  });

  it('missing columns are 0; no _count_ → sum of known columns', () => {
    assert.deepEqual(countsFromPivotRow({ passedCount: 2, errorCount: 1 }), { passed: 2, failed: 0, error: 1, incomplete: 0, skipped: 0, healed: 0, total: 3 });
    assert.equal(countsFromPivotRow(undefined).total, 0);
  });

  it('pass rate = (Passed+Healed)/(Passed+Healed+Failed+Error); Incomplete and Skipped excluded', () => {
    const c = countsFromPivotRow({ passedCount: 6, healedCount: 2, failedCount: 1, errorCount: 1, incompleteCount: 50, skippedCount: 50 });
    assert.equal(passRate(c), 80);
    assert.equal(passRate(countsFromPivotRow({ incompleteCount: 4 })), null, 'nothing decided → null, not 0%');
  });

  it('Error counts against the pass rate (it used to be silently dropped)', () => {
    const before = passRate(countsFromPivotRow({ passedCount: 9, failedCount: 1 }));
    const after = passRate(countsFromPivotRow({ passedCount: 9, failedCount: 1, errorCount: 10 }));
    assert.equal(before, 90);
    assert.equal(after, 45);
  });

  it('tallyStatuses classifies by status, never by `success` (false for Healed, live)', () => {
    const c = tallyStatuses([
      { status: 'Passed' }, { status: 'Healed' }, { status: 'Failed' }, { status: 'Error' },
      { status: 'Incomplete' }, { status: 'Skipped' }, { status: 'Brand-New' },
    ]);
    assert.deepEqual(c, { passed: 1, failed: 1, error: 1, incomplete: 1, skipped: 1, healed: 1, total: 7 });
    assert.equal(statusOutcome('Healed'), 'pass');
    assert.equal(statusOutcome('Error'), 'fail');
    assert.equal(statusOutcome('Incomplete'), 'other');
  });
});

// ─── Handler level ────────────────────────────────────────────────────────────

let server: http.Server;
let client: Client;
const seen: string[] = [];
const recentByStatus: Record<string, Array<Record<string, unknown>>> = {
  Failed: [{ test_id: 1, name: 'loginTest', status: 'Failed', start_time: new Date().toISOString() }],
  Error: [
    { test_id: 2, name: 'checkoutTest', status: 'Error', start_time: new Date().toISOString() },
    { test_id: 3, name: 'checkoutTest', status: 'Error', start_time: new Date().toISOString() },
  ],
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const url = req.url ?? '';
      seen.push(`${req.method} ${url.split('?')[0]}`);
      if (url.startsWith('/reporter/api/tests/grouped')) {
        const body = JSON.parse(raw || '{}');
        // Mirror the live server: pivotBy status with no groupBy → one aggregate row.
        if (body.pivotBy?.includes('status') && !body.groupBy) return void res.end(JSON.stringify({ count: null, data: [PIVOT_ROW] }));
        if (body.groupBy?.[0] === 'device.pool.actual') {
          return void res.end(JSON.stringify({ count: 3, data: [
            { 'device.pool.actual': null, passedCount: 500, _count_: 500 },
            { 'device.pool.actual': 'dedicated', passedCount: 90, failedCount: 5, errorCount: 5, _count_: 100 },
            { 'device.pool.actual': 'shared', passedCount: 3, errorCount: 1, _count_: 4 },
          ] }));
        }
        return void res.end(JSON.stringify({ count: null, data: [] }));
      }
      if (url.startsWith('/reporter/api/tests/list')) {
        const body = JSON.parse(raw || '{}');
        const status = body.filter?.find((f: { property: string }) => f.property === 'status')?.value;
        const data = recentByStatus[status] ?? [];
        return void res.end(JSON.stringify({ count: data.length, data }));
      }
      const m = url.match(/^\/reporter\/api\/testView\/(\d+)\/summary/);
      if (m) return void res.end(JSON.stringify({ count: null, data: [PIVOT_ROW] }));
      if (/^\/reporter\/api\/testView\/\d+:summary/.test(url)) {
        res.statusCode = 400; // what the live server does with the old path
        return void res.end(JSON.stringify({ detail: 'For input string' }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  clearAccessInfoCache();
  resetClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'aut_1_status_test', 'status');
  const mcp = new McpServer({ name: 's', version: '0' });
  registerReportingTools(mcp);
  registerTestViewTools(mcp);
  client = new Client({ name: 'sc', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(b), client.connect(a)]);
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function callJson(name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: { ...args, outputFormat: 'json' } })) as { content: Array<{ text?: string }>; isError?: boolean };
  const text = res.content.map((c) => c.text ?? '').join('');
  assert.notEqual(res.isError, true, text);
  return JSON.parse(text);
}

describe('get_project_test_summary — all statuses', () => {
  it('reports Error/Skipped/Healed, uses the server total, and lists top erroring tests', async () => {
    const s = await callJson('get_project_test_summary', {});
    assert.equal(s.total, 742264, 'total must be the server total, not passed+failed+incomplete');
    assert.equal(s.error, 27131);
    assert.equal(s.skipped, 37);
    assert.equal(s.healed, 57);
    assert.equal(s.failed, 29030, 'failed must be the real count, never a scan length');
    assert.equal(s.passRate, passRate(countsFromPivotRow(PIVOT_ROW)));
    assert.match(s.passRateBasis, /Error/);
    assert.deepEqual(s.topFailures, ['loginTest (1x)']);
    assert.deepEqual(s.topErrors, ['checkoutTest (2x)']);
  });

  it('breaks results down by device pool (shared vs dedicated), leaving out unrecorded (null) rows', async () => {
    const s = await callJson('get_project_test_summary', {});
    assert.deepEqual(s.byDevicePool, [
      { pool: 'dedicated', total: 100, failed: 5, error: 5, passRate: 90 },
      { pool: 'shared', total: 4, failed: 0, error: 1, passRate: 75 },
    ]);
  });

  it('human output shows the Error line', async () => {
    const res = (await client.callTool({ name: 'get_project_test_summary', arguments: { outputFormat: 'human' } })) as { content: Array<{ text?: string }> };
    const text = res.content.map((c) => c.text ?? '').join('');
    assert.match(text, /Error:\s+27131/);
    assert.match(text, /Top erroring tests/);
  });
});

describe('get_test_view_summary — correct path and all statuses', () => {
  it('calls /testView/{id}/summary (the {id}:summary form always 400s live) and returns error/healed', async () => {
    seen.length = 0;
    const s = await callJson('get_test_view_summary', { id: 52 });
    assert.ok(seen.includes('GET /reporter/api/testView/52/summary'), seen.join(', '));
    assert.equal(s.error, 27131);
    assert.equal(s.healed, 57);
    assert.equal(s.total, 742264);
  });
});
