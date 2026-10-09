/**
 * Server-side sort is ATTEMPTED for every role and falls back safely when the platform refuses it.
 *
 * Runs against a local HTTP server standing in for POST /reporter/api/tests/list. Regression targets:
 *  - sorting was previously gated on key format / role; live probes showed project roles sort correctly;
 *  - a refusal must never leave an early-exit scan believing unsorted data is sorted (silent data loss);
 *  - a genuine auth failure must not be mistaken for "sort refused".
 */
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { resetClient } from '../src/api/client.js';
import { listTests, listTestsSortedDesc, summarizeTestFailures } from '../src/api/reporting.js';
import { clearAccessInfoCache } from '../src/utils/access-level.js';

type Mode = 'allow' | 'refuse-sort' | 'deny-all' | 'refuse-sort-from-page-2';

const N = 1200; // > one 500-row page, so multi-page scans and a mid-scan refusal are exercisable
const BASE = Date.UTC(2026, 9, 1); // 2026-10-01
const HOUR = 3600_000;

// Record i is i hours old. Platform order is deliberately scrambled so "unsorted" is distinguishable.
const records = Array.from({ length: N }, (_, i) => ({
  test_id: i + 1,
  name: `t${i % 3}`,
  status: 'Failed',
  start_time: new Date(BASE - i * HOUR).toISOString(),
}));
const platformOrder = [...records].sort((a, b) => ((a.test_id * 37) % N) - ((b.test_id * 37) % N));
const newestFirst = [...records].sort((a, b) => b.start_time.localeCompare(a.start_time));

let mode: Mode = 'allow';
const requests: Array<{ sorted: boolean; page: number; limit: number }> = [];
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url?.startsWith('/reporter/api/tests/list')) {
        const body = JSON.parse(raw || '{}');
        const sorted = Array.isArray(body.sort) && body.sort.length > 0;
        requests.push({ sorted, page: body.page ?? 1, limit: body.limit ?? 50 });
        const refuseLate = mode === 'refuse-sort-from-page-2' && sorted && (body.page ?? 1) > 1;
        if (mode === 'deny-all' || (mode === 'refuse-sort' && sorted) || refuseLate) {
          res.statusCode = 403;
          res.end(JSON.stringify({ detail: 'refused' }));
          return;
        }
        const src = sorted ? newestFirst : platformOrder;
        const page = body.page ?? 1;
        const limit = body.limit ?? 50;
        res.end(JSON.stringify({ count: N, data: src.slice((page - 1) * limit, page * limit) }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

let keySeq = 0;
function useFreshKey(): string {
  const key = `aut_1_sort_test_${++keySeq}`;
  resetClient(baseUrl, key, `sort-${keySeq}`);
  return key;
}

beforeEach(() => {
  clearAccessInfoCache(); // also clears the per-credential sort-refused memo
  requests.length = 0;
  mode = 'allow';
  useFreshKey();
});

const SORT = [{ property: 'start_time', descending: true }];

describe('listTests with sort', () => {
  it('server honors sort → sortApplied true, newest first, one request, no role consulted', async () => {
    const res = await listTests({ limit: 5, page: 1, sort: SORT });
    assert.equal(res.sortApplied, true);
    assert.deepEqual(res.data.map((r) => r.test_id), newestFirst.slice(0, 5).map((r) => r.test_id));
    assert.deepEqual(requests, [{ sorted: true, page: 1, limit: 5 }]);
  });

  it('a request without sort carries no sortApplied flag', async () => {
    const res = await listTests({ limit: 5, page: 1 });
    assert.equal(res.sortApplied, undefined);
  });

  it('server refuses sort → falls back to unsorted, sortApplied false, and REMEMBERS (no repeat 403)', async () => {
    mode = 'refuse-sort';
    const first = await listTests({ limit: 5, page: 1, sort: SORT });
    assert.equal(first.sortApplied, false);
    assert.deepEqual(first.data.map((r) => r.test_id), platformOrder.slice(0, 5).map((r) => r.test_id));
    assert.deepEqual(requests.map((r) => r.sorted), [true, false]); // refused, then retried unsorted

    requests.length = 0;
    const second = await listTests({ limit: 5, page: 1, sort: SORT });
    assert.equal(second.sortApplied, false);
    assert.deepEqual(requests.map((r) => r.sorted), [false], 'a refused credential must not re-attempt sort');
  });

  it('a genuine failure (403 even WITHOUT sort) throws and is NOT remembered as a sort refusal', async () => {
    mode = 'deny-all';
    await assert.rejects(() => listTests({ limit: 5, page: 1, sort: SORT }), /listTests failed/);
    assert.deepEqual(requests.map((r) => r.sorted), [true, false]);

    mode = 'allow';
    requests.length = 0;
    const res = await listTests({ limit: 5, page: 1, sort: SORT });
    assert.equal(res.sortApplied, true, 'bad-key failure must not have disabled sort');
    assert.deepEqual(requests.map((r) => r.sorted), [true]);
  });

  it('refusal is per credential — another key still attempts sort', async () => {
    mode = 'refuse-sort';
    await listTests({ limit: 5, page: 1, sort: SORT }); // key A refused + remembered

    mode = 'allow';
    useFreshKey(); // key B
    requests.length = 0;
    const res = await listTests({ limit: 5, page: 1, sort: SORT });
    assert.equal(res.sortApplied, true);
    assert.deepEqual(requests.map((r) => r.sorted), [true]);
  });
});

describe('listTestsSortedDesc', () => {
  it('fast path: one server-sorted request', async () => {
    const res = await listTestsSortedDesc({ limit: 10, page: 1 });
    assert.deepEqual(res.data.map((r) => r.test_id), newestFirst.slice(0, 10).map((r) => r.test_id));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].sorted, true);
  });

  it('sort refused → scans and sorts client-side, still returning the TRUE newest records', async () => {
    mode = 'refuse-sort';
    const res = await listTestsSortedDesc({ limit: 10, page: 1 });
    assert.deepEqual(res.data.map((r) => r.test_id), newestFirst.slice(0, 10).map((r) => r.test_id));
    // not simply platform order's first page
    assert.notDeepEqual(res.data.map((r) => r.test_id), platformOrder.slice(0, 10).map((r) => r.test_id));
  });

  it('sort refused + scan capped: `count` is the SERVER total when asked for, never the capped scan length', async () => {
    // Regression: get_project_test_summary printed exactly "failed: 5000" (the scan cap) for 29k real failures.
    mode = 'refuse-sort';
    const asked = await listTestsSortedDesc({ limit: 10, page: 1, returnTotalCount: true }, undefined, undefined, 500);
    assert.equal(asked.scanCapped, true);
    assert.equal(asked.count, N);
    const notAsked = await listTestsSortedDesc({ limit: 10, page: 1 }, undefined, undefined, 500);
    assert.equal(notAsked.count, 500, 'without returnTotalCount, count stays the scanned length');
  });
});

describe('early-exit scans never lose data when sort is refused', () => {
  // Window = the 40 newest hours' worth of records (ids 1..40 are within 39h of BASE).
  const startDate = new Date(BASE - 39 * HOUR).toISOString();
  const endDate = new Date(BASE + HOUR).toISOString();
  const expectedInWindow = records.filter((r) => r.start_time >= startDate).length; // 40

  function totalOf(buckets: Array<{ count: number }>): number {
    return buckets.reduce((n, b) => n + b.count, 0);
  }

  it('sort honored: correct window, early-exit keeps the scan to one page', async () => {
    const out = await summarizeTestFailures({ startDate, endDate, groupBy: 'name' });
    assert.equal(out.totalFailures, expectedInWindow);
    assert.equal(totalOf(out.buckets), expectedInWindow);
    assert.equal(requests.length, 1);
  });

  it('sort refused only from page 2: scan restarts unsorted instead of splicing sorted page 1 onto unsorted page 2', async () => {
    // Window spans 600 records — more than one sorted page — so a naive scan would take 500 from sorted
    // page 1 and then an unsorted page 2 that is NOT the continuation (duplicates + omissions).
    mode = 'refuse-sort-from-page-2';
    const wideStart = new Date(BASE - 599 * HOUR).toISOString();
    const expected = records.filter((r) => r.start_time >= wideStart).length; // 600
    const out = await summarizeTestFailures({ startDate: wideStart, endDate, groupBy: 'name', maxReports: 5000 });
    assert.equal(out.totalFailures, expected, 'sorted page 1 + unsorted page 2 were spliced — count is wrong');
    assert.equal(totalOf(out.buckets), expected);
    // the refusal was remembered: later sorted requests are not re-attempted
    requests.length = 0;
    await listTests({ limit: 1, page: 1, sort: SORT });
    assert.deepEqual(requests.map((r) => r.sorted), [false]);
  });

  it('sort refused: unsorted data has in-window records AFTER out-of-window ones — all must still be found', async () => {
    mode = 'refuse-sort';
    const out = await summarizeTestFailures({ startDate, endDate, groupBy: 'name' });
    assert.equal(out.totalFailures, expectedInWindow, 'an early-exit on unsorted data would have dropped records');
    assert.equal(totalOf(out.buckets), expectedInWindow);
  });
});
