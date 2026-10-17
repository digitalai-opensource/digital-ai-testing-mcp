/**
 * Reporting tool handlers against a stub reporter (tests/api/reporting.test.ts covers the live API itself).
 * Regression targets, all from live UAT runs:
 *  - get_distinct_test_key_values / get_grouped_test_reports fold device.os case variants (ANDROID/Android/IOS/iOS)
 *  - get_grouped_test_reports adds totalRecords (the platform's count is the number of groups)
 *  - get_daily_execution_trend names the missing range and suggests a maxRecords value when capped
 *  - get_test_report no longer invents status_code/project_id = 0 and counts attachment files
 *  - list_active_test_executions ignores Incomplete records older than maxAgeHours (fallback path)
 *  - list_active_test_executions reads the platform's running test requests, passing through allow-listed fields only
 *  - list_test_reports never sends always-returned columns in keys (searchValue + keys:[start_time] → platform 400)
 *    and explains the opaque 400 a comparison filter on a text key produces
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { registerReportingTools } from '../src/tools/reporting-tools.js';
import { startStubApi, connectTools, accountInfo, reply, type StubApi, type ToolClient } from './helpers/offline.js';

const HOUR = 3_600_000;
const NOW = Date.now();
let spacingMs = HOUR; // gap between consecutive runs in the fake reporter
let listFixture: 'trend' | 'incomplete' | 'failures' | 'failures-no-keys' = 'trend';
let runningFixture: unknown = undefined; // undefined → 404 → list_active_test_executions falls back to the reporter heuristic

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
const FAILURES = [
  { test_id: 501, name: 'login', status: 'Failed', start_time: new Date(NOW - HOUR).toISOString(), errorClassification: 'element_not_found', errorCategory: 'assertion' },
  { test_id: 502, name: 'login', status: 'Failed', start_time: new Date(NOW - 2 * HOUR).toISOString(), errorClassification: 'element_not_found', errorCategory: 'assertion' },
  { test_id: 503, name: 'pay', status: 'Failed', start_time: new Date(NOW - 3 * HOUR).toISOString(), errorClassification: 'application_crash', errorCategory: 'application' },
];
const GROUPED_BY_OS_STATUS = [
  { 'device.os': 'ANDROID', status: 'Error', _count_: 22 }, { 'device.os': 'Android', status: 'Error', _count_: 100 },
  { 'device.os': 'Android', status: 'Passed', _count_: 900 }, { 'device.os': 'IOS', status: 'Passed', _count_: 5 }, { 'device.os': null, status: 'Passed', _count_: 7 },
];

// Attachment ZIPs by report UUID: only a device log (common on mobile), none (browser reports), and two logs.
const zipOf = (files: Record<string, string>) => {
  const z = new AdmZip();
  for (const [name, text] of Object.entries(files)) z.addFile(name, Buffer.from(text));
  return z.toBuffer();
};
const ATTACHMENT_ZIPS: Record<string, Buffer> = {
  'only-device': zipOf({ 'device.log': 'boot\nE/App: crash\n', 'video.mp4': 'x' }),
  'no-logs': zipOf({ 'screenshot.png': 'x' }),
  'two-logs': zipOf({ 'device.log': 'd\n', 'ws_on_device.log': 'w\n' }),
};

let api: StubApi;
let tools: ToolClient;

beforeAll(async () => {
  api = await startStubApi((req) => {
    if (req.path === '/api/v1/users/my-account-info') return accountInfo('Admin', 'Default');
    if (req.path === '/api/v2/test-requests/running') return runningFixture;
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
      if ((req.json.filter ?? []).some((f: { operator: string }) => f.operator === '>')) {
        return reply(400, { status: 'ERROR', message: 'Failed to retrieve data. Please check log for details.' });
      }
      if (listFixture === 'failures' || listFixture === 'failures-no-keys') {
        const withKeys = listFixture === 'failures' && (req.json.keys ?? []).includes('errorClassification');
        return { count: null, data: FAILURES.map((r) => (withKeys ? r : { test_id: r.test_id, name: r.name, status: r.status, start_time: r.start_time })) };
      }
      return listFixture === 'trend'
        ? { count: null, data: trendRows(req.json.page ?? 1) }
        : { count: INCOMPLETE.length, data: INCOMPLETE };
    }
    const detail = req.path.match(/^\/reporter\/api\/tests\/(50[123])$/);
    if (detail) {
      const r = FAILURES.find((x) => String(x.test_id) === detail[1])!;
      return { id: r.test_id, name: r.name, status: r.status, startTime: r.start_time, keyValuePairs: { errorClassification: r.errorClassification, errorCategory: r.errorCategory } };
    }
    const zipFor = req.path.match(/^\/reporter\/api\/reports\/([\w-]+)\/attachments$/);
    if (zipFor && ATTACHMENT_ZIPS[zipFor[1]]) return reply(200, [ATTACHMENT_ZIPS[zipFor[1]]]);
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

describe('list_test_reports keys', () => {
  const lastListBody = () => api.requests.filter((r) => r.path === '/reporter/api/tests/list').at(-1)!.json;

  it('sends only custom keys — built-in columns are always returned and break searchValue', async () => {
    await tools.call('list_test_reports', { searchValue: 't1', keys: ['name', 'status', 'start_time', 'duration', 'device.name'], limit: 5 });
    assert.deepEqual(lastListBody().keys, ['device.name']);
    await tools.call('list_test_reports', { searchValue: 't1', keys: ['start_time', 'duration'], limit: 5 });
    assert.equal('keys' in lastListBody(), false);
  });

  it('applies the same rule on the startDate scan path', async () => {
    await tools.call('list_test_reports', { searchValue: 't1', keys: ['start_time', 'user'], startDate: new Date(NOW - HOUR).toISOString(), limit: 5 });
    assert.deepEqual(lastListBody().keys, ['user']);
  });

  it('explains the opaque 400 a comparison filter produces', async () => {
    const { res, text } = await tools.call('list_test_reports', { filter: [{ property: 'loadSeq', operator: '>', value: 8 }] });
    assert.equal(res.isError, true);
    assert.match(text, /comparison operators .* only work on numeric keys; \[loadSeq\]/);
  });
});

describe('list_active_test_executions — platform live list', () => {
  const RUNNING = {
    totalRunningTestRequest: 7, // counts every running request on the platform — never reported
    runningTestRequests: [
      { id: 1, name: 'checkout', status: 'Running', projectName: 'Default', projectId: 2, username: 'a@b.c', deviceName: 'Pixel 7', deviceOs: 'Android', deviceOsVersion: '14', executionType: 'Appium Server', appiumServerVersion: '3.5.2', searchQuery: "@os='android'", sessionId: 'CLOUD-SID:1', createdAt: NOW - 60_000, startedAt: NOW - 50_000, accessKey: 'aut_1_SHOULD_NOT_LEAK', wifiPassword: 'nope' },
      { id: 2, name: 'login', status: 'Running', projectName: 'POC', projectId: 9, startedAt: NOW - 10_000 },
    ],
  };

  it('lists the running requests with allow-listed fields only', async () => {
    runningFixture = RUNNING;
    try {
      const j = await tools.callJson('list_active_test_executions', {});
      assert.equal(j.source, 'running-test-requests');
      assert.equal(j.count, 2);
      assert.equal(j.total, 2, 'the platform-wide totalRunningTestRequest is not the caller\'s count');
      const first = (j.executions as Array<Record<string, unknown>>)[0];
      assert.equal(first.deviceQuery, "@os='android'");
      assert.equal(first.appiumServerVersion, '3.5.2');
      assert.equal(first.startedAt, new Date(NOW - 50_000).toISOString());
      assert.doesNotMatch(JSON.stringify(j), /SHOULD_NOT_LEAK|wifiPassword|accessKey/);
    } finally {
      runningFixture = undefined;
    }
  });

  it('projectName / projectId scope the list', async () => {
    runningFixture = RUNNING;
    try {
      const byName = await tools.callJson('list_active_test_executions', { projectName: 'poc' });
      assert.deepEqual((byName.executions as Array<{ name: string }>).map((e) => e.name), ['login']);
      const byId = await tools.callJson('list_active_test_executions', { projectId: 2 });
      assert.deepEqual((byId.executions as Array<{ name: string }>).map((e) => e.name), ['checkout']);
    } finally {
      runningFixture = undefined;
    }
  });

  it('a 200 without the list (other envelope / HTML) falls back instead of reporting an empty farm', async () => {
    runningFixture = { somethingElse: true };
    listFixture = 'incomplete';
    try {
      const j = await tools.callJson('list_active_test_executions', {});
      assert.equal(j.source, 'reporter-heuristic');
    } finally {
      runningFixture = undefined;
      listFixture = 'trend';
    }
  });

  it('a projectId sent as a string still matches the projectId filter', async () => {
    runningFixture = { runningTestRequests: [{ id: 9, name: 'string-id', status: 'Running', projectId: '9', startedAt: NOW }] };
    try {
      const j = await tools.callJson('list_active_test_executions', { projectId: 9 });
      assert.deepEqual((j.executions as Array<{ name: string }>).map((e) => e.name), ['string-id']);
    } finally {
      runningFixture = undefined;
    }
  });

  it('falls back to the reporter heuristic when the live list is unavailable, and says so', async () => {
    listFixture = 'incomplete';
    try {
      const j = await tools.callJson('list_active_test_executions', {});
      assert.equal(j.source, 'reporter-heuristic');
    } finally {
      listFixture = 'trend';
    }
  });
});

describe('summarize_test_failures', () => {
  const buckets = (j: Record<string, unknown>) => Object.fromEntries((j.buckets as Array<{ key: string; count: number }>).map((b) => [b.key, b.count]));

  it('reads the classification from the list in one request — no per-report fetches', async () => {
    listFixture = 'failures';
    api.requests.length = 0;
    try {
      const j = await tools.callJson('summarize_test_failures', {});
      assert.deepEqual(buckets(j), { element_not_found: 2, application_crash: 1 });
      assert.equal(j.detailsFetched, 0);
      const list = api.requests.filter((r) => r.path === '/reporter/api/tests/list');
      assert.deepEqual(list[0].json.keys, ['errorClassification', 'errorCategory']);
      assert.equal(api.requests.some((r) => /^\/reporter\/api\/tests\/\d+$/.test(r.path)), false);
      assert.deepEqual(buckets(await tools.callJson('summarize_test_failures', { groupBy: 'errorCategory' })), { assertion: 2, application: 1 });
    } finally {
      listFixture = 'trend';
    }
  });

  it('falls back to per-report fetches when the platform ignores the keys', async () => {
    listFixture = 'failures-no-keys';
    api.requests.length = 0;
    try {
      const j = await tools.callJson('summarize_test_failures', {});
      assert.deepEqual(buckets(j), { element_not_found: 2, application_crash: 1 });
      assert.equal(j.detailsFetched, 3);
    } finally {
      listFixture = 'trend';
    }
  });
});

describe('get_test_log when the requested log is missing (UAT 2026-10-16)', () => {
  it('returns the only log a report has and says it fell back', async () => {
    const { res, text } = await tools.call('get_test_log', { uuid: 'only-device' });
    assert.notEqual(res.isError, true, text);
    assert.match(text, /^\[no appium log in this report — showing its only log instead — device\.log/);
    assert.match(text, /E\/App: crash/);
  });

  it('says a report with no logs has none (browser reports) instead of listing nothing', async () => {
    const { res, text } = await tools.call('get_test_log', { uuid: 'no-logs' });
    assert.equal(res.isError, true);
    assert.match(text, /no log files attached/);
  });

  it('with several other logs, names them and the logType values to retry with', async () => {
    const { res, text } = await tools.call('get_test_log', { uuid: 'two-logs' });
    assert.equal(res.isError, true);
    assert.match(text, /No appium log in this report\. It has: device\.log, ws_on_device\.log\. Retry with logType: "device" or "ws"\./);
  });
});
