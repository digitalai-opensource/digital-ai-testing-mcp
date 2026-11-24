/**
 * create_report recipes — the pure builders (data in, report spec + highlights out) and the tool's offline paths.
 * Live behaviour (scan speed, grouped counts with a numeric test_id bound) was verified against the dev tenant
 * 2026-11-23; see src/api/report-recipes.ts.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildTestSummary, buildFailureAnalysis, buildDeviceHealth, buildUsageSummary, buildUsageOverview, testFamily, classificationMeans, deviceStats, isFlagged,
  bucketStart, buckets, dayStart, addDays, isoDate, type TestRun, type DeviceRow, type GroupCounts,
} from '../src/utils/report-recipes.js';
import { durationHours } from '../src/api/report-recipes.js';
import { applyInterpretations, registerReportTools } from '../src/tools/report-tools.js';
import { renderReport, type ReportSpec, type Section } from '../src/utils/report-render.js';
import { emptyStatusCounts } from '../src/utils/test-status.js';
import { connectTools, startStubApi, reply } from './helpers/offline.js';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takeFinishedNotice } from '../src/utils/report-jobs.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-17T00:00:00Z'); // a Tuesday
let id = 1000;
const run = (day: number, status: string, name = 'Login', extra: Partial<TestRun> = {}): TestRun => ({
  test_id: id++, name, status, start_time: new Date(T0 + day * DAY + 3_600_000).toISOString(), serial: 'S1', deviceName: 'Pixel 8',
  deviceOs: 'Android', cause: null, errorCategory: null, duration: 1000, ...extra,
});
const counts = (passed: number, failed: number) => ({ ...emptyStatusCounts(), passed, failed, total: passed + failed });
const allSections = (s: ReportSpec): Section[] => (s.tabs ? s.tabs.flatMap((t) => t.sections) : s.sections ?? []);
const section = (s: ReportSpec, title: RegExp) => allSections(s).find((x) => title.test(x.title))!;

describe('recipe helpers', () => {
  it('testFamily strips ids, dates, times and run numbers but keeps real names', () => {
    assert.equal(testFamily('Basic Appium OSS Web Test 00008120-001A0D193410A01E 1084'), 'Basic Appium OSS Web Test');
    assert.equal(testFamily('Basic Appium OSS Web Test e9da94b38e9a192e4aa679d11d9d490bd638e7ad 2396'), 'Basic Appium OSS Web Test');
    assert.equal(testFamily('Basic Appium OSS Native Test R38M30662DH 2393'), 'Basic Appium OSS Native Test');
    assert.equal(testFamily('Appium Test 2026-11-23 15:01'), 'Appium Test');
    assert.equal(testFamily('Login test #12'), 'Login test');
    for (const keep of ['health_check', 'iPhone 15 checkout', 'testLogin_v2', 'sanity_login_success']) assert.equal(testFamily(keep), keep);
  });

  it('buckets are whole days (UTC under the test TZ) or Monday-start weeks', () => {
    assert.equal(bucketStart(T0 + 5 * 3_600_000, 'day'), T0);
    assert.equal(new Date(bucketStart(T0, 'week')).getUTCDay(), 1);
    assert.equal(buckets(T0, T0 + 6 * DAY, 'day').length, 7);
  });

  it('days follow the machine time zone: 20:05 in New York is still today, and usage stays on UTC days', () => {
    const saved = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const evening = Date.parse('2026-11-24T01:05:00Z'); // Nov. 23, 20:05 in New York
      assert.equal(isoDate(evening), '2026-11-23');
      assert.equal(isoDate(evening, true), '2026-11-24');
      assert.equal(dayStart(evening), Date.parse('2026-11-23T05:00:00Z'));
      // A 3-day test summary run then ends on 11/23 and never shows "tomorrow".
      const from = addDays(evening, -2);
      const r = buildTestSummary({ runs: [{ ...run(0, 'Passed'), start_time: new Date(evening - 60_000).toISOString() }], previous: null, failures: [], platforms: null,
        devicesUsed: null, from, to: evening, days: 3 });
      const volume = allSections(r.spec).flatMap((x) => x.blocks).find((x) => x.type === 'bar') as Extract<Section['blocks'][number], { type: 'bar' }>;
      assert.deepEqual(volume.categories, ['11/21', '11/22', '11/23']);
      assert.equal(volume.series[0].values[2], 1, 'the 20:04 run lands on 11/23');
      // Calendar days across the DST change (Nov. 1) stay at local midnight.
      assert.deepEqual(buckets(Date.parse('2026-10-31T16:00:00Z'), Date.parse('2026-11-02T16:00:00Z'), 'day').map((t) => isoDate(t)), ['2026-10-31', '2026-11-01', '2026-11-02']);
      // Usage: the platform cuts the CSV at UTC midnight, so its range is printed in UTC.
      const u = buildUsageSummary({ rows: [], from: Date.parse('2026-11-21T00:00:00Z'), to: Date.parse('2026-11-23T23:59:59Z'), recentDays: 3, projectName: 'P' });
      assert.match(JSON.stringify(u.spec.meta), /Nov\. 21, 2026 to Nov\. 23, 2026 \(UTC\)/);
    } finally {
      if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
    }
  });

  it('classification text is honest about unclassified failures', () => {
    assert.match(classificationMeans(100, 0, 0, [['Unclassified', 100]]), /did not classify/);
    assert.match(classificationMeans(100, 28, 4, [['Unclassified', 72], ['Assertion', 24]]), /left 72% of failures unclassified.*86% point at the test or the app/);
    assert.match(classificationMeans(100, 90, 60, [['Device', 60], ['Assertion', 30]]), /^Device is the largest group \(60%\).*67% point at the lab/);
  });

  it('durationHours reads H:MM:SS and MM:SS', () => {
    assert.equal(durationHours('1:30:00'), 1.5);
    assert.equal(durationHours('0:01:30'), 0.025);
    assert.equal(durationHours('15:00'), 0.25);
    assert.equal(durationHours('bad'), 0);
  });
});

describe('test-summary', () => {
  const runs = [
    ...Array.from({ length: 8 }, (_, k) => run(k % 3, 'Passed')),
    run(0, 'Failed', 'Checkout 0000811-ABCDE1 1001', { errorCategory: 'assertion' }),
    run(1, 'Failed', 'Checkout 0000811-ABCDE2 1002', { errorCategory: 'device' }),
    run(2, 'Error', 'Checkout 0000811-ABCDE3 1003'),
    run(2, 'Incomplete'),
  ];
  const result = buildTestSummary({
    runs, previous: [run(-3, 'Passed'), run(-2, 'Passed'), run(-1, 'Failed')], failures: runs.filter((r) => /Failed|Error/.test(r.status)),
    platforms: [{ key: 'Android', counts: counts(6, 2) }, { key: 'iOS', counts: counts(2, 1) }, { key: null, counts: counts(1, 0) }],
    devicesUsed: 3, from: T0, to: T0 + 2 * DAY + 7_200_000, days: 3, projectName: 'Demo', passRateGoal: 80,
  });

  it('a scan cut short at its record limit says first what it covers, not only in the footer', () => {
    // Asked for 90 days; the newest runs that fit the limit reach back three days.
    const cut = buildTestSummary({ runs, previous: null, failures: [], platforms: null, devicesUsed: null,
      from: T0 - 87 * DAY, to: T0 + 2 * DAY + 7_200_000, days: 90, projectName: 'Demo', capped: true });
    assert.match(cut.highlights[0], /^Only the newest 12 runs were read: the report covers .+ \(3 days\), not the 90 days asked for\./);
    assert.equal(cut.spec.subtitle, 'Newest 12 runs: 3 days of the last 90');
    const first = allSections(cut.spec)[0];
    assert.equal(first.title, 'Coverage');
    const callout = first.blocks[0] as Extract<Section['blocks'][number], { type: 'callout' }>;
    assert.equal(callout.tone, 'warning');
    assert.equal(callout.title, 'This report covers 3 days, not 90');
    assert.match(callout.text, /stopped at its limit of 12 runs[\s\S]*are not in any figure below[\s\S]*maxRecords, up to 25,000/);
    assert.match(String(cut.spec.source), /12 runs from Nov\. 17, 2026 to Nov\. 19, 2026\.[\s\S]*the 90 days asked for begin Aug\. 22, 2026, and the runs before Nov\. 17, 2026 were not read/);
    assert.deepEqual(cut.spec.meta!.find((m) => m.label === 'Range')!.value, 'Nov. 17, 2026 to Nov. 19, 2026', 'the header shows the range the figures cover');
    assert.match(renderReport(cut.spec), /This report covers 3 days, not 90/);

    // The window itself is complete and only the previous period was cut: no coverage warning, one line on the comparison.
    const whole = buildTestSummary({ runs, previous: null, failures: [], platforms: null, devicesUsed: null,
      from: T0, to: T0 + 2 * DAY + 7_200_000, days: 3, comparisonCut: true });
    assert.notEqual(allSections(whole.spec)[0].title, 'Coverage');
    assert.equal(whole.spec.subtitle, 'Last 3 days');
    assert.match(String(whole.spec.source), /The previous period is not compared: the scan reached its record limit/);
    assert.ok(!/incomplete\.\*\*/.test(String(whole.spec.source)));
    // Cut short, but the runs still reach the first day of the range (the failure scan was the one cut): no claim about days.
    const sameDay = buildTestSummary({ runs, previous: null, failures: [], platforms: null, devicesUsed: null,
      from: T0, to: T0 + 2 * DAY + 7_200_000, days: 3, capped: true });
    assert.notEqual(allSections(sameDay.spec)[0].title, 'Coverage');
    assert.match(String(sameDay.spec.source), /oldest part of the range is incomplete/);
  });

  it('counts runs, pass rate and the change against the previous period', () => {
    const kpis = allSections(result.spec)[0].blocks[0] as Extract<Section['blocks'][number], { type: 'kpis' }>;
    assert.equal(kpis.items[0].value, '12');
    assert.equal(kpis.items[1].value, '72.7%'); // 8 / (8 + 3); incomplete excluded
    assert.match(String(kpis.items[1].delta), /▲ 6\.0 points vs\. previous 3 days/);
    assert.equal(kpis.items[4].value, '3', 'devices from the grouped count');
    assert.match(result.highlights[0], /Pass rate 72\.7% over 12 runs \(up 6\.0 points\)/);
  });

  it('marks the running day as partial and draws a goal line', () => {
    const runsPerDay = section(result.spec, /^Runs per Day/).blocks[0] as Extract<Section['blocks'][number], { type: 'bar' }>;
    assert.deepEqual(runsPerDay.partial, ['11/19']);
    const line = section(result.spec, /Pass Rate Over Time/).blocks[0] as Extract<Section['blocks'][number], { type: 'line' }>;
    assert.equal(line.target?.value, 80);
    assert.match(String(section(result.spec, /Pass Rate Over Time/).whatItMeans), /of 3 days met the 80% goal/);
  });

  it('groups run-specific test names into one family and labels platforms', () => {
    const table = section(result.spec, /Most Frequent Failures/).blocks[0] as Extract<Section['blocks'][number], { type: 'table' }>;
    assert.equal(table.rows[0].name, 'Checkout (3 name variants)');
    assert.equal(table.rows[0].fails, 3);
    const plat = section(result.spec, /Results by Platform/).blocks[0] as Extract<Section['blocks'][number], { type: 'bar' }>;
    assert.deepEqual(plat.categories, ['Android', 'iOS', 'Web or no device']);
    assert.match(String(section(result.spec, /Results by Platform/).whatItMeans), /^iOS had the lowest pass rate \(66\.7%/);
  });

  it('every data section explains itself and the spec renders', () => {
    for (const s of allSections(result.spec)) if (s.title !== 'At a Glance') assert.ok(s.whatItMeans, s.title);
    assert.match(renderReport(result.spec), /<h1>Test Execution Summary<\/h1>/);
  });

  it('an empty window says so instead of drawing empty charts', () => {
    const empty = buildTestSummary({ runs: [], previous: null, failures: [], platforms: null, devicesUsed: null, from: T0, to: T0 + DAY, days: 2 });
    assert.match(empty.highlights[0], /^No runs between/);
    assert.match(renderReport(empty.spec), /No data for this period\./);
  });
});

describe('failure-analysis', () => {
  it('ranks devices, finds the worst device-day and lists causes with an example', () => {
    const fails = [
      ...Array.from({ length: 6 }, () => run(1, 'Failed', 'Pay', { deviceName: 'Galaxy S24', serial: 'G', errorCategory: 'device', cause: 'Element not found: pay_button' })),
      run(0, 'Failed', 'Login', { deviceName: 'Pixel 8', serial: 'P', errorCategory: 'assertion', cause: 'Expected Welcome' }),
      run(2, 'Error', 'Login', { deviceName: 'iPhone 15', serial: 'I', cause: 'Session timed out' }),
      run(2, 'Failed', 'Login', { deviceName: 'Pixel Fold', serial: 'F', errorCategory: 'assertion', cause: 'Expected Welcome' }),
    ];
    const r = buildFailureAnalysis({ failures: fails, totalRuns: 40, from: T0, to: T0 + 2 * DAY, days: 3 });
    assert.match(r.highlights[0], /Galaxy S24 carries 67% of failures/);
    assert.match(String(section(r.spec, /Failures by Device$/).whatItMeans), /One device carrying this share usually means a device problem/);
    assert.match(String(section(r.spec, /per Device and Day/).whatItMeans), /11\/18 on Galaxy S24 \(6 failures\)/);
    const causes = section(r.spec, /Most Common Causes/).blocks[0] as Extract<Section['blocks'][number], { type: 'table' }>;
    assert.deepEqual(causes.rows[0], { cause: 'Element not found: pay_button', n: 6, cat: 'Device', test: 'Pay' });
    const kpis = allSections(r.spec)[0].blocks[0] as Extract<Section['blocks'][number], { type: 'kpis' }>;
    assert.equal(kpis.items[1].value, '22.5%');
  });

  it('no failures → a note, not empty charts', () => {
    const r = buildFailureAnalysis({ failures: [], totalRuns: 10, from: T0, to: T0 + DAY, days: 2 });
    assert.deepEqual(r.highlights, ['No failures in this range.']);
    assert.match(renderReport(r.spec), /No run failed between/);
  });
});

describe('device-health', () => {
  const dev = (name: string, status: string, age: number | null = 10): DeviceRow => ({ name, serial: name, os: name.startsWith('i') ? 'iOS' : 'Android', model: 'M', status, statusAgeMin: age, region: 'US2', agent: 'a1' });
  const devices = [dev('Pixel 8', 'Available'), dev('Galaxy S24', 'Available'), dev('iPhone 13', 'Offline', 4320), dev('iPhone 15', 'In Use'), dev('Pixel Fold', 'Error', 0)];
  const deviceCounts: GroupCounts = [
    { key: 'Pixel 8', counts: counts(40, 2) }, { key: 'Galaxy S24', counts: counts(6, 6) }, { key: 'iPhone 15', counts: counts(30, 1) }, { key: null, counts: counts(5, 0) },
  ];
  const failures = Array.from({ length: 6 }, () => run(0, 'Failed', 'Pay', { serial: 'Galaxy S24', deviceName: 'Galaxy S24', errorCategory: 'device', cause: 'Stuck dialog' }));

  it('flags a device far above the pool baseline from grouped counts', () => {
    const { stats, baseline } = deviceStats(deviceCounts, failures);
    assert.equal(baseline, 0.1); // 9 failures / 90 runs with a verdict
    const s24 = stats.find((s) => s.serial === 'Galaxy S24')!;
    assert.equal(s24.failRatio, 0.5);
    assert.equal(s24.infraShare, 1);
    assert.equal(s24.topCause, 'Stuck dialog');
    assert.equal(isFlagged(s24, baseline), true);
    assert.equal(isFlagged(stats.find((s) => s.serial === 'Pixel 8')!, baseline), false);
  });

  it('builds status, tiles worst first (degraded included) and the long-offline table', () => {
    const r = buildDeviceHealth({ devices, deviceCounts, failures, days: 3, now: T0 + 3 * DAY });
    assert.match(r.highlights.join(' '), /2 of 5 devices available, 2 offline or in error\. 1 device offline for more than a day\. 1 device fail far more often/);
    const tiles = section(r.spec, /^Devices$/).blocks[0] as Extract<Section['blocks'][number], { type: 'tiles' }>;
    const s24 = tiles.items.find((t) => t.name === 'Galaxy S24')!;
    assert.equal(s24.status, 'Degraded');
    assert.equal(s24.metric, '50% pass');
    assert.equal(tiles.items.find((t) => t.name === 'Pixel Fold')!.detail, 'M · US2', 'no "for 0 min"');
    assert.match(String(tiles.items.find((t) => t.name === 'iPhone 13')!.detail), /for 3 days/);
    const offline = section(r.spec, /Offline for More Than a Day/).blocks[0] as Extract<Section['blocks'][number], { type: 'table' }>;
    assert.equal(offline.rows.length, 1);
    assert.match(renderReport(r.spec), /Devices Failing Far More Often Than the Pool/);
  });
});

describe('usage-summary', () => {
  it('weekly hours shade the recent window, ranks users and devices against the total', () => {
    const to = Date.parse('2026-11-22T23:59:59Z'), from = Date.parse('2026-08-25T00:00:00Z');
    const rows = [
      { start: from + DAY, hours: 10, user: 'ana', device: 'mn-005', deviceDetail: 'iPhone 17, iOS 26', project: 'P' },
      { start: to - 5 * DAY, hours: 4, user: 'bo', device: 'mn-021', deviceDetail: 'Pixel 8, Android 16', project: 'P' },
      { start: to - 2 * DAY, hours: 6, user: 'ana', device: 'mn-005', deviceDetail: 'iPhone 17, iOS 26', project: 'P' },
    ];
    const r = buildUsageSummary({ rows, from, to, recentDays: 30, projectName: 'P' });
    assert.match(r.highlights[0], /20 reserved hours over 90 days, 10 in the last 30/);
    const weekly = section(r.spec, /Weekly Reserved Hours/).blocks[0] as Extract<Section['blocks'][number], { type: 'bar' }>;
    assert.equal(weekly.highlight?.label, 'Last 30 days');
    assert.ok(weekly.categories.includes(weekly.highlight!.from));
    const users = section(r.spec, /Top Users/).blocks[0] as Extract<Section['blocks'][number], { type: 'bar' }>;
    assert.deepEqual(users.categories, ['ana', 'bo']);
    assert.equal(users.shareTotal, 20);
    const recent = section(r.spec, /Device Usage, Last 30 Days/).blocks[0] as Extract<Section['blocks'][number], { type: 'bar' }>;
    assert.deepEqual(recent.categories, ['mn-005|iPhone 17, iOS 26', 'mn-021|Pixel 8, Android 16']);
    assert.match(String(r.spec.source), /includes both manual and automated use/);
  });
});

describe('usage overview (every project)', () => {
  const to = Date.parse('2026-11-22T23:59:59Z'), from = Date.parse('2026-08-25T00:00:00Z');
  const devices = [
    { device: 'mn-005', os: 'iOS', osVersion: '26.1', project: 'Alpha', hours: 60 },
    { device: 'mn-021', os: 'Android', osVersion: '16', project: 'Alpha', hours: 20 },
    { device: 'mn-005', os: 'iOS', osVersion: '26.1', project: 'Beta', hours: 20 },
    { device: 'mn-030', os: 'Android', osVersion: '15', project: 'Gamma', hours: 0 },
  ];

  it('ranks projects, devices and platforms against the total, and lists every project with usage', () => {
    const r = buildUsageOverview({ devices, recentDevices: [{ ...devices[0], hours: 30 }], users: null, from, to, recentDays: 30, usersNote: 'Users are not shown: too long.' });
    assert.match(r.highlights[0], /100 reserved hours across 2 projects over 90 days, 30 in the last 30\./);
    assert.match(r.highlights[1], /Alpha leads with 80% of the hours/);
    assert.equal(r.spec.title, 'Usage Overview');
    assert.deepEqual(r.spec.tabs!.map((t) => t.label), ['Executive Overview', 'Projects', 'Devices']);
    const byProject = section(r.spec, /Reserved Hours by Project/).blocks[0] as Extract<Section['blocks'][number], { type: 'bar' }>;
    assert.deepEqual(byProject.categories, ['Alpha', 'Beta']);
    assert.deepEqual(byProject.series[0].values, [80, 20]);
    const table = section(r.spec, /Every Project/).blocks[0] as Extract<Section['blocks'][number], { type: 'table' }>;
    assert.deepEqual(table.rows.map((x) => [x.project, x.hours, x.share, x.recent, x.devices]), [['Alpha', 80, 80, 30, 2], ['Beta', 20, 20, 0, 1]]);
    assert.ok(!table.columns.some((c) => c.key === 'users'), 'no users column without the per-user report');
    const top = section(r.spec, /Top Devices/).blocks[0] as Extract<Section['blocks'][number], { type: 'bar' }>;
    assert.deepEqual(top.categories, ['mn-005|iOS 26.1', 'mn-021|Android 16'], 'a device used by two projects is one device');
    assert.deepEqual(top.series[0].values, [80, 20]);
    const os = section(r.spec, /by Platform/).blocks[0] as Extract<Section['blocks'][number], { type: 'share' }>;
    assert.deepEqual(os.parts, [{ label: 'iOS', value: 80 }, { label: 'Android', value: 20 }]);
    assert.match(String(r.spec.source), /"Devices Usage" usage reports, all projects[\s\S]*for weekly hours, name one project\. Users are not shown: too long\./);
    assert.match(renderReport(r.spec), /<h1>Usage Overview<\/h1>/);
  });

  it('with the per-user report: active users, users per project and a Users tab; without a recent window no trend', () => {
    const users = [{ user: 'ana', project: 'Alpha', hours: 50 }, { user: 'bo', project: 'Alpha', hours: 30 }, { user: 'ana', project: 'Beta', hours: 20 }, { user: 'cy', project: 'Beta', hours: 0 }];
    const r = buildUsageOverview({ devices, recentDevices: null, users, from, to, recentDays: 30 });
    assert.deepEqual(r.spec.tabs!.map((t) => t.label), ['Executive Overview', 'Projects', 'Devices', 'Users']);
    assert.ok(!r.spec.tabs![0].sections.some((s) => /Usage Trend/.test(s.title)));
    const kpis = section(r.spec, /At a Glance/).blocks[0] as Extract<Section['blocks'][number], { type: 'kpis' }>;
    assert.deepEqual(kpis.items.map((k) => [k.label, k.value]), [['Hours, last 90 days', '100'], ['Projects with usage', '2'], ['Devices used', '2'], ['Active users', '2']]);
    const table = section(r.spec, /Every Project/).blocks[0] as Extract<Section['blocks'][number], { type: 'table' }>;
    assert.deepEqual(table.rows.map((x) => x.users), [2, 1]);
    const top = section(r.spec, /Top Users/).blocks[0] as Extract<Section['blocks'][number], { type: 'bar' }>;
    assert.deepEqual(top.categories, ['ana', 'bo']);
    assert.match(String(r.spec.source), /"Devices Usage" and "Users Usage" usage reports/);
  });

  it('no usage at all still renders', () => {
    const r = buildUsageOverview({ devices: [], recentDevices: null, users: null, from, to, recentDays: 30 });
    assert.match(r.highlights[0], /0 reserved hours across 0 projects/);
    assert.match(renderReport(r.spec), /No reserved hours in this range/);
  });
});

describe('create_report tool (offline paths)', () => {
  it('replaces interpretations by section title and reports titles that matched nothing', () => {
    const spec: ReportSpec = { title: 't', tabs: [{ label: 'a', sections: [{ title: 'Runs per Day', blocks: [{ type: 'text', text: 'x' }], whatItMeans: 'old' }] }] };
    const out = applyInterpretations(spec, { 'runs per day': 'new', 'Nope': 'y' });
    assert.equal(out.spec.tabs![0].sections[0].whatItMeans, 'new');
    assert.deepEqual(out.unknown, ['nope']);
    assert.equal(spec.tabs![0].sections[0].whatItMeans, 'old', 'the original is not changed');
  });

  it('asks for a recipe, and explains an unknown runId', async () => {
    const tools = await connectTools(registerReportTools);
    let r = await tools.call('create_report', {});
    assert.equal(r.res.isError, true);
    assert.match(r.text, /Give a recipe \(test-summary, failure-analysis, device-health, usage-summary\)/);
    r = await tools.call('create_report', { runId: 'test-summary-zzz', whatItMeans: { a: 'b' } });
    assert.match(r.text, /No report "test-summary-zzz" in this server run/);
    await tools.close();
  });

  it('the per-recipe tools (named the way people ask) run the same handler with their recipe fixed', async () => {
    const tools = await connectTools(registerReportTools);
    const names = (await tools.client.listTools()).tools.map((t) => t.name);
    for (const n of ['create_test_summary_report', 'create_failure_analysis_report', 'create_device_health_report', 'create_usage_summary_report']) assert.ok(names.includes(n), n);
    const usage = (await tools.client.listTools()).tools.find((t) => t.name === 'create_usage_summary_report')!;
    assert.deepEqual(Object.keys(usage.inputSchema.properties ?? {}).sort(), ['background', 'days', 'outputPath', 'projectName', 'recentDays', 'title']);
    await tools.close();
  });

  it('a usage summary without a project is the overview of every project, from the two small aggregated reports', async () => {
    const DEVICES = 'Device ID,Device name,OS,OS Version,Project,Total duration (in hours)\n' +
      '1,mn-005,iOS,26.1,Alpha,30.5\n2,mn-021,Android,16,Alpha,9.5\n1,mn-005,iOS,26.1,Beta,10\n3,mn-030,Android,15,Gamma,0\n';
    const USERS = 'Project,Start Date,End Date,Total Reservation Time (hours)\nAlpha,a,b,40\n\n' +
      "User ID,Username,User's first name,User's last name,User's email,Project,Total Duration (in hours),Tokens,User Tag\n" +
      '7,ana,A,A,a@x.test,Alpha,25,0,\n8,bo,B,B,b@x.test,Alpha,15,0,\n7,ana,A,A,a@x.test,Beta,10,0,\n';
    const api = await startStubApi((req) => {
      if (!req.path.startsWith('/api/v2/configuration/get-CSV-reports/0/0/')) return undefined;
      return reply(200, decodeURIComponent(req.path).endsWith('Users Usage') ? USERS : DEVICES);
    });
    const saved = { dir: process.env.MCP_REPORT_DIR, mode: process.env.MCP_DEPLOYMENT_MODE };
    process.env.MCP_DEPLOYMENT_MODE = 'docker'; // nothing written: the report comes back attached
    delete process.env.MCP_REPORT_DIR;
    const tools = await connectTools(registerReportTools);
    try {
      const r = await tools.call('create_usage_summary_report', { days: 30, recentDays: 7 });
      assert.notEqual(r.res.isError, true, r.text);
      assert.match(r.text, /Report ready: usage-overview-\d{8}-\d{4}/);
      assert.match(r.text, /50 reserved hours across 2 projects over 30 days/);
      const kinds = api.requests.map((q) => decodeURIComponent(q.path).split('/').pop()).sort();
      assert.deepEqual(kinds, ['Devices Usage', 'Devices Usage', 'Users Usage'], 'the whole range, the recent window, and users (30 days)');
      api.requests.length = 0;
      const long = await tools.call('create_report', { recipe: 'usage-summary', days: 180 });
      assert.notEqual(long.res.isError, true, long.text);
      assert.deepEqual(api.requests.map((q) => decodeURIComponent(q.path).split('/').pop()).sort(), ['Devices Usage', 'Devices Usage'],
        'over 31 days the per-user report of every project takes about a minute: not asked for');
    } finally {
      await tools.close();
      await api.close();
      if (saved.dir === undefined) delete process.env.MCP_REPORT_DIR; else process.env.MCP_REPORT_DIR = saved.dir;
      if (saved.mode === undefined) delete process.env.MCP_DEPLOYMENT_MODE; else process.env.MCP_DEPLOYMENT_MODE = saved.mode;
    }
  });
});

describe('background report', () => {
  it('is saved to the report folder the moment it finishes, before anyone collects it', async () => {
    const DEVICES = 'Device ID,Device name,OS,OS Version,Project,Total duration (in hours)\n1,mn-005,iOS,26.1,Alpha,30\n';
    const api = await startStubApi((req) => (req.path.startsWith('/api/v2/configuration/get-CSV-reports/0/0/') ? reply(200, DEVICES) : undefined));
    const folder = mkdtempSync(join(tmpdir(), 'bg-report-'));
    const saved = { dir: process.env.MCP_REPORT_DIR, mode: process.env.MCP_DEPLOYMENT_MODE };
    process.env.MCP_REPORT_DIR = folder;
    process.env.MCP_DEPLOYMENT_MODE = 'local';
    const tools = await connectTools(registerReportTools);
    try {
      takeFinishedNotice(); // notices of earlier tests
      const started = await tools.call('create_report', { recipe: 'usage-summary', days: 60, background: true });
      const jobId = /jobId "([^"]+)"/.exec(started.text)?.[1];
      assert.ok(jobId, started.text);
      // Nothing is called until the file is there: the agent has ended its turn and may never come back.
      const htmlFiles = () => readdirSync(folder).filter((n) => n.endsWith('.html'));
      for (let i = 0; i < 100 && htmlFiles().length === 0; i++) await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(htmlFiles().length, 1, 'saved at completion');
      const notice = takeFinishedNotice();
      assert.match(String(notice), /Background report ready[\s\S]*already saved at .*usage-overview-\d{8}-\d{4}/);
      const collected = await tools.call('create_report', { jobId });
      assert.match(collected.text, /Report saved: .*usage-overview-/);
      assert.deepEqual(htmlFiles().length, 1, 'collecting it writes the same file, not a second one');
    } finally {
      await tools.close();
      await api.close();
      if (saved.dir === undefined) delete process.env.MCP_REPORT_DIR; else process.env.MCP_REPORT_DIR = saved.dir;
      if (saved.mode === undefined) delete process.env.MCP_DEPLOYMENT_MODE; else process.env.MCP_DEPLOYMENT_MODE = saved.mode;
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
