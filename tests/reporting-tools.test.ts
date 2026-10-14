/**
 * Reporting tool handlers against a stub reporter (tests/reporting.test.ts covers the live API itself).
 * Regression targets, all from live UAT runs:
 *  - get_distinct_test_key_values / get_grouped_test_reports fold device.os case variants (ANDROID/Android/IOS/iOS)
 *  - get_grouped_test_reports adds totalRecords (the platform's count is the number of groups)
 *  - get_daily_execution_trend names the missing range and suggests a maxRecords value when capped
 *  - get_test_report no longer invents status_code/project_id = 0 and counts attachment files
 *  - list_active_test_executions ignores Incomplete records older than maxAgeHours
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { registerReportingTools } from '../src/tools/reporting-tools.js';
import { startStubApi, connectTools, accountInfo, type StubApi, type ToolClient } from './helpers/offline.js';

const HOUR = 3_600_000;
const NOW = Date.now();
let spacingMs = HOUR; // gap between consecutive runs in the fake reporter
let listFixture: 'trend' | 'incomplete' = 'trend';

// One run per `spacingMs`, newest first — 100 hourly records cover ~4 days of a 14-day window.
const trendRows = (page: number) =>
  Array.from({ length: 500 }, (_, i) => {
    const n = (page - 1) * 500 + i;
    return { test_id: n + 1, name: `t${n}`, status: 'Passed', start_time: new Date(NOW - n * spacingMs).toISOString() };
  });
const INCOMPLETE = [
  { test_id: 1, uuid: 'u1', name: 'running', status: 'Incomplete', duration: null, start_time: new Date(NOW - HOUR).toISOString(), project_id: 2 },
  { test_id: 2, uuid: 'u2', name: 'abandoned', status: 'Incomplete', duration: null, start_time: new Date(NOW - 72 * HOUR).toISOString(), project_id: 2 },
];
const GROUPED_BY_OS_STATUS = [
  { 'device.os': 'ANDROID', status: 'Error', _count_: 22 }, { 'device.os': 'Android', status: 'Error', _count_: 100 },
  { 'device.os': 'Android', status: 'Passed', _count_: 900 }, { 'device.os': 'IOS', status: 'Passed', _count_: 5 }, { 'device.os': null, status: 'Passed', _count_: 7 },
];

let api: StubApi;
let tools: ToolClient;

beforeAll(async () => {
  api = await startStubApi((req) => {
    if (req.path === '/api/v1/users/my-account-info') return accountInfo('Admin', 'Default');
    if (req.path === '/reporter/api/tests/grouped') {
      const groupBy: string[] = req.json.groupBy ?? [];
      return groupBy.includes('device.os')
        ? { count: GROUPED_BY_OS_STATUS.length, data: GROUPED_BY_OS_STATUS }
        : { count: 2, data: [{ status: 'Passed', _count_: 90 }, { status: 'Failed', _count_: 10 }] };
    }
    if (req.path === '/reporter/api/tests/distinct') {
      return { count: 4, data: [{ 'device.os': 'ANDROID' }, { 'device.os': 'Android' }, { 'device.os': 'IOS' }, { 'device.os': 'iOS' }] };
    }
    if (req.path === '/reporter/api/tests/list') {
      return listFixture === 'trend'
        ? { count: null, data: trendRows(req.json.page ?? 1) }
        : { count: INCOMPLETE.length, data: INCOMPLETE };
    }
    if (req.path === '/reporter/api/tests/742904') {
      return {
        uuid: '3ed64d18-1146-4e95-9e67-cc7c20a4d559', id: 742904, name: 'health_check', startTime: new Date(NOW).toISOString(),
        duration: 1000, status: 'Failed', success: false, keyValuePairs: {}, projectName: 'Default',
        testAttachments: [{ type: 'log', filePath: 'a.log', size: 1 }, { type: 'video', filePath: 'v.mp4', size: 2 }],
      };
    }
    return undefined;
  });
  tools = await connectTools(registerReportingTools);
});
afterAll(async () => { await tools.close(); await api.close(); });

describe('device.os case folding', () => {
  it('get_distinct_test_key_values folds OS case variants and keeps the raw spellings', async () => {
    const r = await tools.callJson('get_distinct_test_key_values', { keys: ['device.os'] });
    assert.deepEqual(r['device.os'], ['Android', 'iOS']);
    assert.deepEqual((r.rawValues as Record<string, unknown>)['device.os'], ['ANDROID', 'Android', 'IOS', 'iOS']);
  });

  it('get_grouped_test_reports merges OS casings per FULL group key and reports the merged count', async () => {
    const j = await tools.callJson('get_grouped_test_reports', { groupBy: ['device.os', 'status'] });
    const rows = (j.data as Array<Record<string, unknown>>).map((r) => `${r['device.os']}/${r.status}=${r._count_}`).sort();
    assert.deepEqual(rows, ['Android/Error=122', 'Android/Passed=900', 'iOS/Passed=5', 'null/Passed=7']);
    assert.equal(j.count, 4);
  });
});

describe('get_grouped_test_reports totals', () => {
  it("adds totalRecords when returnTotalCount is true (the platform's count is the number of groups)", async () => {
    const r = await tools.callJson('get_grouped_test_reports', { groupBy: ['status'], returnTotalCount: true });
    assert.equal(r.count, 2);
    assert.equal(r.totalRecords, 100);
    const without = await tools.callJson('get_grouped_test_reports', { groupBy: ['status'], returnTotalCount: false });
    assert.equal('totalRecords' in without, false);
  });
});

describe('get_daily_execution_trend when maxRecords caps the window', () => {
  it('names the missing range and suggests a maxRecords value', async () => {
    const r = await tools.callJson('get_daily_execution_trend', { lookbackDays: 14, maxRecords: 100 });
    assert.equal(r.windowComplete, false);
    const missing = r.missingRange as { from: string; to: string };
    assert.ok(new Date(missing.from).getTime() < new Date(missing.to).getTime());
    // ~24 runs/day × 14 days × 1.1, rounded up to 500 → 500
    assert.equal(r.suggestedMaxRecords, 500);
    assert.equal(r.fittingLookbackDays, undefined);
  });

  it('says when even the 25,000 maximum cannot cover the window', async () => {
    // ~24.2 runs/day × 365 × 1.1 ≈ 9,733 → rounded up to the next 500
    const r = await tools.callJson('get_daily_execution_trend', { lookbackDays: 365, maxRecords: 100 });
    assert.equal(r.suggestedMaxRecords, 10000);
    // A busy project: one run every 10 minutes (~144/day) — 365 days would need ~58k records.
    spacingMs = 10 * 60_000;
    try {
      const r2 = await tools.callJson('get_daily_execution_trend', { lookbackDays: 365, maxRecords: 100 });
      assert.equal(r2.suggestedMaxRecords, 25000);
      const fitting = r2.fittingLookbackDays;
      assert.ok(typeof fitting === 'number' && fitting > 100 && fitting < 200);
    } finally {
      spacingMs = HOUR;
    }
  });
});

describe('get_test_report', () => {
  it('has no invented status_code/project_id and counts the attachment files', async () => {
    const r = await tools.callJson('get_test_report', { testId: 742904 });
    assert.equal('status_code' in r, false);
    assert.equal('project_id' in r, false);
    assert.equal(r.projectName, 'Default');
    assert.equal(r.attachment_count, 2);
  });
});

describe('list_active_test_executions', () => {
  it('ignores Incomplete records older than maxAgeHours', async () => {
    listFixture = 'incomplete';
    try {
      const j = await tools.callJson('list_active_test_executions', {});
      assert.deepEqual((j.executions as Array<{ name: string }>).map((e) => e.name), ['running']);
      assert.equal(j.staleExcluded, 1);
      const wide = await tools.callJson('list_active_test_executions', { maxAgeHours: 168 });
      assert.equal(wide.count, 2);
    } finally {
      listFixture = 'trend';
    }
  });
});
