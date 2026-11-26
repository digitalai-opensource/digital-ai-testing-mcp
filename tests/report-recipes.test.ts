/**
 * create_report recipes — the pure builders (data in, report spec + highlights out) and the tool's offline paths.
 * Live behaviour (scan speed, grouped counts with a numeric test_id bound) was verified against the dev tenant
 * 2026-11-23; see src/api/report-recipes.ts.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildTestSummary, buildFailureAnalysis, buildDeviceHealth, buildUsageSummary, buildUsageOverview, buildTestInventory, buildTestBreakdown, buildTestTrend, buildTestReliability, buildReleaseReadiness, buildDeviceCoverage, buildDeviceUtilization, buildLicenseUsage, peakConcurrency, foldBreakdownRows, reportKey, testFamily, classificationMeans, causeQuote, deviceStats, isFlagged,
  bucketStart, buckets, dayStart, addDays, isoDate, type TestRun, type DeviceRow, type PoolDevice, type LicenseSession, type GroupCounts,
} from '../src/utils/report-recipes.js';
import { durationHours, deviceRows } from '../src/api/report-recipes.js';
import { buildPerformanceOverview } from '../src/utils/report-performance.js';
import type { Transaction } from '../src/types/digital-ai.js';
import { applyInterpretations, registerReportTools } from '../src/tools/report-tools.js';
import { renderReport, type ReportSpec, type Section } from '../src/utils/report-render.js';
import { emptyStatusCounts } from '../src/utils/test-status.js';
import { connectTools, startStubApi, reply, accountInfo } from './helpers/offline.js';
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
    // Most failures unclassified: the split of the rest as numbers, and no verdict about where the problem is.
    const mostly = classificationMeans(100, 28, 4, [['Unclassified', 72], ['Assertion', 24]]);
    assert.match(mostly, /left 72% of failures unclassified, so the classification cannot say where the problem is\. Of the 28 classified failures, 14% point at the lab .* and 86% at the test or the app\./);
    assert.ok(!/not the main problem|fix the lab before/.test(mostly), mostly);
    assert.match(mostly, /Read the most common causes before deciding where to look\.$/);
    assert.match(classificationMeans(100, 28, 4, [['Unclassified', 72]], { n: 66, classified: false }), /The most common cause \(66 failures\) is among the unclassified ones/);
    assert.match(classificationMeans(100, 28, 4, [['Unclassified', 72]], { n: 20, classified: true }), /Read the most common causes before deciding/);
    assert.match(classificationMeans(100, 90, 20, [['Assertion', 70], ['Device', 20]]), /78% point at the test or the app .*so the lab is not the main problem/);
    assert.match(classificationMeans(100, 90, 60, [['Device', 60], ['Assertion', 30]]), /^Device is the largest group \(60%\).*67% point at the lab/);
  });

  it('quotes the informative part of a cause, cut at a word', () => {
    assert.equal(causeQuote('unknown error - An unknown server-side error occurred while processing the command. Original error: org.apache.hc.client5.http.HttpHostConnectException: Connect to host failed'),
      'org.apache.hc.client5.http.HttpHostConnectException: Connect to host failed');
    assert.equal(causeQuote('Element  not\nfound: pay_button'), 'Element not found: pay_button');
    const long = causeQuote('word '.repeat(60));
    assert.ok(long.length <= 121 && long.endsWith('word…'), long);
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
    assert.match(r.highlights[0], /^Most common cause: "Element not found: pay_button" \(6 failures, 67%\); the top three causes cover 100%\.$/);
    assert.match(r.highlights[1], /Galaxy S24 carries 67% of failures/);
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

describe('report wording (UAT 2026-11-24)', () => {
  it('failure analysis draws no lab-or-test verdict when most failures are unclassified, and names the top cause', () => {
    const conn = 'unknown error - An unknown server-side error occurred while processing the command. Original error: org.apache.hc.client5.http.HttpHostConnectException: Connect failed';
    const fails = [
      ...Array.from({ length: 7 }, () => run(1, 'Failed', 'Web', { cause: conn })),
      run(1, 'Failed', 'Login', { errorCategory: 'assertion', cause: 'Expected Welcome' }),
      run(2, 'Failed', 'Login', { errorCategory: 'assertion', cause: 'Expected Welcome' }),
      run(2, 'Failed', 'Pay', { errorCategory: 'environment', cause: 'No route' }),
    ];
    const r = buildFailureAnalysis({ failures: fails, totalRuns: 50, from: T0, to: T0 + 2 * DAY, days: 3 });
    const means = String(section(r.spec, /Failures by Classification/).whatItMeans);
    assert.match(means, /left 70% of failures unclassified, so the classification cannot say where the problem is/);
    assert.match(means, /The most common cause \(7 failures\) is among the unclassified ones/);
    assert.ok(!/not the main problem/.test(means), means);
    const causes = String(section(r.spec, /Most Common Causes/).whatItMeans);
    assert.match(causes, /appears 7 times: "org\.apache\.hc\.client5\.http\.HttpHostConnectException: Connect failed"/, 'the quote holds the informative part');
    assert.match(r.highlights[0], /^Most common cause: "org\.apache.*" \(7 failures, 70%\); the top three causes cover 100%\./);
  });

  it('test summary: no "top five" beside five or fewer failing tests, never 100% with failures outside it, singular day', () => {
    const one = buildTestSummary({ runs: [run(0, 'Passed'), run(0, 'Failed', 'Login')], previous: [run(-1, 'Passed')], failures: [], platforms: null, devicesUsed: 1,
      from: T0, to: T0 + 7_200_000, days: 1 });
    const failText = String(section(one.spec, /Most Frequent Failures/).whatItMeans);
    assert.match(failText, /^1 test failed at least once/);
    assert.ok(!/top five/.test(failText), failText);
    assert.equal(one.spec.subtitle, 'Last 1 day, compared with the day before');
    const kpis = section(one.spec, /At a Glance/).blocks[0] as Extract<Section['blocks'][number], { type: 'kpis' }>;
    assert.match(String(kpis.items[0].delta), /vs\. previous day$/);
    assert.equal(kpis.items[3].label, 'Distinct test names');
    const volume = String(section(one.spec, /Runs per Day/).whatItMeans);
    assert.match(volume, /^2 runs on /);
    assert.ok(!/busiest|per day/.test(volume), volume);
    assert.match(String(section(one.spec, /Pass Rate Over Time/).whatItMeans), /points on the previous day/);

    // Six failing tests, 931 of 933 failures in the top five: 99.7%, not "100%".
    const names = ['A', 'B', 'C', 'D', 'E', 'F'];
    const many = [...Array.from({ length: 931 }, (_, k) => run(k % 3, 'Failed', names[k % 5])), run(0, 'Failed', 'F'), run(1, 'Failed', 'F')];
    const six = buildTestSummary({ runs: many, previous: null, failures: [], platforms: null, devicesUsed: 1, from: T0, to: T0 + 2 * DAY + 7_200_000, days: 3 });
    assert.match(String(section(six.spec, /Most Frequent Failures/).whatItMeans), /^6 tests failed at least once .*The top five account for 99\.7% of failures\./);
  });

  it('test summary: mostly unclassified failures give no lab headline', () => {
    const det = [...Array.from({ length: 8 }, () => run(0, 'Failed', 'Web', { cause: 'x' })), run(0, 'Failed', 'Login', { errorCategory: 'device', cause: 'y' })];
    const r = buildTestSummary({ runs: det, previous: null, failures: det, platforms: null, devicesUsed: 1, from: T0, to: T0 + 7_200_000, days: 1 });
    assert.ok(r.highlights.some((h) => /left 89% of failures unclassified/.test(h)), r.highlights.join(' | '));
    assert.ok(!r.highlights.some((h) => /point at the lab/.test(h)));
  });

  it('device health lists every long-offline device', () => {
    const many: DeviceRow[] = Array.from({ length: 27 }, (_, k) => ({ name: `Phone ${k}`, serial: `S${k}`, os: 'Android', model: 'M', status: 'Offline', statusAgeMin: 3000 + k, region: 'US', agent: 'a' } as DeviceRow));
    const r = buildDeviceHealth({ devices: many, deviceCounts: null, failures: [], days: 3, now: T0 + 3 * DAY });
    const table = section(r.spec, /Offline or in Error for More Than a Day/).blocks[0] as Extract<Section['blocks'][number], { type: 'table' }>;
    assert.equal(table.rows.length, 27, 'the table agrees with the "27 devices" in the text');
    const html = renderReport(r.spec);
    assert.match(html, /Phone 26/);
    assert.match(r.highlights.join(' '), /27 devices offline or in error for more than a day/);
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

  it('failures are matched to a device whatever the letter case of its serial (the counts arrive with such serials merged)', () => {
    const lower = failures.map((f) => ({ ...f, serial: 'galaxy s24' }));
    const s24 = deviceStats(deviceCounts, lower).stats.find((s) => s.serial === 'Galaxy S24')!;
    assert.deepEqual([s24.name, s24.infraShare, s24.topCause], ['Galaxy S24', 1, 'Stuck dialog']);
  });

  it('a failing device is found in the pool whatever the letter case of its serial (the reporter keeps the spelling a client sent)', () => {
    const upper: GroupCounts = deviceCounts.map((g) => ({ ...g, key: g.key == null ? null : g.key.toUpperCase() }));
    const r = buildDeviceHealth({ devices, deviceCounts: upper, failures, days: 3, now: T0 + 3 * DAY });
    const tiles = section(r.spec, /^Devices$/).blocks[0] as Extract<Section['blocks'][number], { type: 'tiles' }>;
    const s24 = tiles.items.find((t) => t.name === 'Galaxy S24')!;
    assert.deepEqual([s24.status, s24.metric], ['Degraded', '50% pass']);
    assert.equal(tiles.items.find((t) => t.name === 'Pixel 8')!.metric, '95% pass');
  });

  it('builds status, tiles worst first (degraded included) and the long-offline table', () => {
    const r = buildDeviceHealth({ devices, deviceCounts, failures, days: 3, now: T0 + 3 * DAY });
    assert.match(r.highlights.join(' '), /2 of 5 devices available, 2 offline or in error\. 1 device offline or in error for more than a day\. 1 device fails far more often/);
    const tiles = section(r.spec, /^Devices$/).blocks[0] as Extract<Section['blocks'][number], { type: 'tiles' }>;
    const s24 = tiles.items.find((t) => t.name === 'Galaxy S24')!;
    assert.equal(s24.status, 'Degraded');
    assert.equal(s24.metric, '50% pass');
    assert.equal(tiles.items.find((t) => t.name === 'Pixel Fold')!.detail, 'M · US2', 'no "for 0 min"');
    assert.match(String(tiles.items.find((t) => t.name === 'iPhone 13')!.detail), /for 3 days/);
    const offline = section(r.spec, /Offline or in Error for More Than a Day/).blocks[0] as Extract<Section['blocks'][number], { type: 'table' }>;
    assert.equal(offline.rows.length, 1);
    assert.match(renderReport(r.spec), /Devices Failing Far More Often Than the Pool/);
    assert.equal(r.spec.sections!.some((s) => /by Region|Agents with/.test(s.title ?? '')), false, 'one region, one agent: nothing to compare');
  });

  it('says where the offline devices are: by region, and agents whose every device is down', () => {
    const at = (name: string, status: string, region: string, agent: string): DeviceRow => ({ ...dev(name, status), region, agent });
    const lab = [
      ...Array.from({ length: 6 }, (_, k) => at(`A${k}`, 'Available', 'US1', 'host-1')),
      ...Array.from({ length: 3 }, (_, k) => at(`B${k}`, 'Offline', 'UK1', 'host-2')),
      at('C0', 'Available', 'UK1', 'host-3'), at('C1', 'Offline', 'UK1', 'host-3'), at('C2', 'In Use', 'UK1', 'host-3'),
    ];
    const r = buildDeviceHealth({ devices: lab, deviceCounts: null, failures: [], days: 3, now: T0 + 3 * DAY });
    const region = section(r.spec, /Lab Health by Region/);
    const bar = region.blocks[0] as Extract<Section['blocks'][number], { type: 'bar' }>;
    assert.deepEqual(bar.categories, ['US1', 'UK1']);
    assert.deepEqual(bar.series.map((s) => s.values), [[6, 1], [0, 1], [0, 4]]);
    assert.match(String(region.whatItMeans), /UK1 has the largest share of devices offline or in error: 4 of 6 \(67%\)\. That is 100% of all offline devices in one region/);
    const agents = section(r.spec, /Agents with Offline Devices/);
    const table = agents.blocks[0] as Extract<Section['blocks'][number], { type: 'table' }>;
    assert.deepEqual(table.rows.map((x) => [x.agent, x.region, x.devices, x.down, x.share]), [['host-2', 'UK1', 3, 3, 100], ['host-3', 'UK1', 3, 1, 33]]);
    assert.match(String(agents.whatItMeans), /2 agents of 3 have at least one device offline or in error\. On 1 agent every device is down \(host-2\): check the host machine before the devices\./);
    assert.ok(r.highlights.some((h) => /1 agent has every device offline: host-2\./.test(h)), r.highlights.join(' | '));
    assert.match(renderReport(r.spec), /Lab Health by Region/);
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
    assert.equal(allSections(r.spec).some((s) => /by User Tag/.test(s.title)), false, 'no tag on any user: no tag table');
  });

  it('hours by user tag: a user with two tags counts under each, and untagged hours are named', () => {
    const users = [{ user: 'ana', project: 'Alpha', hours: 50, tags: 'payments, mobile' }, { user: 'bo', project: 'Alpha', hours: 30, tags: 'payments' },
      { user: 'ana', project: 'Beta', hours: 10, tags: 'payments, mobile' }, { user: 'cy', project: 'Beta', hours: 10 }, { user: 'dee', project: 'Beta', hours: 0, tags: 'idle' }];
    const r = buildUsageOverview({ devices, recentDevices: null, users, from, to, recentDays: 30 });
    const tags = section(r.spec, /Reserved Hours by User Tag/);
    assert.deepEqual((tags.blocks[0] as Extract<Section['blocks'][number], { type: 'table' }>).rows, [
      { tag: 'payments', users: 2, hours: 90, share: 90 }, { tag: 'mobile', users: 1, hours: 60, share: 60 }, { tag: '(no tag)', users: 1, hours: 10, share: 10 }]);
    assert.match(String(tags.whatItMeans), /payments has the most reserved hours of 2 user tags \(90%\)\. 10% of the hours belong to users with no tag/);
    assert.match(String(tags.whatItMeans), /1 user with more than one tag is counted under each, so the rows add up to more than the total\./, 'a user with rows in two projects is one user');
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
    assert.match(r.text, /Give a recipe \(test-summary, failure-analysis, device-health, usage-summary, test-inventory, test-breakdown, test-trend, test-reliability, device-coverage, device-utilization, performance-overview, release-readiness, license-usage\)/);
    r = await tools.call('create_report', { runId: 'test-summary-zzz', whatItMeans: { a: 'b' } });
    assert.match(r.text, /No report "test-summary-zzz" in this server run/);
    await tools.close();
  });

  it('the per-recipe tools (named the way people ask) run the same handler with their recipe fixed', async () => {
    const tools = await connectTools(registerReportTools);
    const names = (await tools.client.listTools()).tools.map((t) => t.name);
    for (const n of ['create_test_summary_report', 'create_failure_analysis_report', 'create_device_health_report', 'create_usage_summary_report', 'create_test_inventory_report', 'create_test_breakdown_report', 'create_test_trend_report',
      'create_test_reliability_report', 'create_device_coverage_report', 'create_device_utilization_report', 'create_performance_overview_report', 'create_release_readiness_report', 'create_license_usage_report']) assert.ok(names.includes(n), n);
    const usage = (await tools.client.listTools()).tools.find((t) => t.name === 'create_usage_summary_report')!;
    assert.deepEqual(Object.keys(usage.inputSchema.properties ?? {}).sort(), ['background', 'days', 'outputPath', 'projectName', 'recentDays', 'title']);
    // Report tools are always loaded, so each definition is paid for in every tool list (a trimmed MCP_TOOLSETS list too):
    // the per-recipe tools carry short parameter texts, the full ones are on create_report.
    const listed = (await tools.client.listTools()).tools;
    for (const t of listed.filter((x) => /^create_.+_report$/.test(x.name))) assert.ok(JSON.stringify(t).length < 2200, `${t.name}: ${JSON.stringify(t).length} chars`);
    assert.ok(JSON.stringify(listed.find((x) => x.name === 'create_report')).length < 9000, 'create_report lists one line per recipe');
    assert.equal((usage.inputSchema.properties as Record<string, { description: string }>).days.description, 'Length of the range in days.');
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

describe('test inventory (every report, all dates)', () => {
  const c = (passed: number, failed = 0, error = 0, incomplete = 0) => ({ passed, failed, error, incomplete, skipped: 0, healed: 0, total: passed + failed + error + incomplete });
  const rows = [
    { project: 'Alpha', user: 'bot', counts: c(900, 60, 20, 20) },
    { project: 'Alpha', user: 'ana', counts: c(40, 10) },
    { project: 'Beta', user: 'ana', counts: c(30, 10) },
    { project: 'Beta', user: null, counts: c(0, 0, 0, 10) },
    { project: 'Old POC', user: 'cy', counts: c(5) },
    { project: 'Tiny', user: 'dee', counts: c(2, 1) },
  ];

  it('counts by project, user and status, marks projects with no cloud project, and never rounds a share up to 100%', () => {
    const r = buildTestInventory({ rows, projects: ['Alpha', 'Beta', 'Old POC', 'Tiny', 'Empty'], reporterOnly: ['Old POC'], failed: [], scope: 'all', now: T0 });
    assert.match(r.highlights[0], /^1,108 test reports in 4 of 5 projects, all dates; pass rate 90\.6%\./);
    assert.match(r.highlights[1], /^Alpha holds 94\.8% of them, Beta 4\.5%\./);
    assert.match(r.highlights[2], /^4 users; the top three account for 99% of reports\./, 'bot + ana + cy are 1,105 of 1,108: 99.7% is not "100%"');
    assert.equal(r.spec.title, 'Test Report Inventory');
    assert.deepEqual(r.spec.tabs!.map((t) => t.label), ['Overview', 'Projects', 'Users']);
    const table = section(r.spec, /Every Project with Reports/).blocks[0] as Extract<Section['blocks'][number], { type: 'table' }>;
    assert.deepEqual(table.rows.map((x) => [x.project, x.reports, x.passed, x.failed, x.other, x.rate, x.users, x.note]), [
      ['Alpha', 1050, 940, 90, 20, '91.3%', 2, ''], ['Beta', 50, 30, 10, 10, '75.0%', 1, ''], ['Old POC', 5, 5, 0, 0, '100.0%', 1, 'no cloud project'], ['Tiny', 3, 2, 1, 0, '66.7%', 1, '']]);
    const means = String(section(r.spec, /Reports by Project/).whatItMeans);
    assert.match(means, /Alpha holds 94\.8% of all reports; the top three projects together hold 99%\. 1 project has no report at all\./);
    assert.match(String(section(r.spec, /Every Project with Reports/).whatItMeans), /1 of them no longer has a cloud project of the same name/);
    const users = section(r.spec, /^Users$/).blocks[0] as Extract<Section['blocks'][number], { type: 'table' }>;
    assert.deepEqual(users.rows.map((x) => [x.user, x.reports, x.projects]), [['bot', 1000, 1], ['ana', 90, 2], ['(no user recorded)', 10, 1], ['cy', 5, 1], ['dee', 3, 1]]);
    assert.match(String(section(r.spec, /^Users$/).whatItMeans), /4 user IDs created reports\. 10 reports carry no user\./);
    assert.match(String(r.spec.source), /nothing is sampled or cut off/);
    assert.match(renderReport(r.spec), /<h1>Test Report Inventory<\/h1>/);
  });

  it('one project, a project that did not answer, and an empty instance', () => {
    const one = buildTestInventory({ rows: rows.slice(0, 2), projects: ['Alpha'], reporterOnly: null, failed: [], scope: 'one', now: T0 });
    assert.match(one.highlights[0], /^1,050 test reports in project Alpha, all dates/);
    assert.deepEqual(one.spec.tabs!.map((t) => t.label), ['Overview', 'Users']);
    assert.equal(one.highlights.some((h) => /top three/.test(h)), false, 'two users: no "top three"');
    const failed = buildTestInventory({ rows, projects: ['Alpha', 'Beta', 'Old POC', 'Tiny', 'Gone'], reporterOnly: null, failed: [{ project: 'Gone', error: 'x' }], scope: 'all', now: T0 });
    assert.ok(failed.highlights.some((h) => /1 project did not answer and is not counted: Gone\./.test(h)));
    const empty = buildTestInventory({ rows: [], projects: ['A'], reporterOnly: null, failed: [], scope: 'all', now: T0 });
    assert.match(empty.highlights[0], /^0 test reports in 0 of 1 project/);
    assert.match(renderReport(empty.spec), /No project holds a test report/);
  });

  it('storage: a tab with each project against its quota, and a highlight for a project over it', () => {
    const storage = [{ project: 'Alpha', mb: 3072, quotaMb: 2048 }, { project: 'Beta', mb: 100, quotaMb: 1000 }, { project: 'Ghost', mb: 50, quotaMb: 0 }, { project: 'Empty', mb: 0, quotaMb: 500 }];
    const r = buildTestInventory({ rows, projects: ['Alpha', 'Beta', 'Old POC', 'Tiny', 'Empty'], reporterOnly: null, failed: [], scope: 'all', now: T0, storage });
    assert.deepEqual(r.spec.tabs!.map((t) => t.label), ['Overview', 'Projects', 'Users', 'Storage']);
    assert.ok(r.highlights.some((h) => /1 project is over the storage quota; Alpha holds 3\.0 GB against 2\.0 GB\./.test(h)), r.highlights.join(' | '));
    const table = section(r.spec, /Storage and Quota/).blocks[0] as Extract<Section['blocks'][number], { type: 'table' }>;
    assert.deepEqual(table.rows.map((x) => [x.project, x.mb, x.quota, x.pct, x.reports, x.per]), [
      ['Alpha', 3072, 2048, 150, 1050, 2925.7], ['Beta', 100, 1000, 10, 50, 2000], ['Ghost', 50, 0, null, 0, null]]);
    assert.match(String(section(r.spec, /Storage by Project/).whatItMeans), /take 3\.1 GB in 3 projects; Alpha holds 95% of it\. 1 project is over quota \(Alpha at 150%\)/);
    assert.match(renderReport(r.spec), /Storage and Quota/);
    const none = buildTestInventory({ rows, projects: ['Alpha'], reporterOnly: null, failed: [], scope: 'all', now: T0, storage: null });
    assert.equal(none.spec.tabs!.some((t) => t.label === 'Storage'), false);
  });

  it('the tool asks every reporter project once and builds the report in one call', async () => {
    const api = await startStubApi((req) => {
      if (req.path === '/reporter/api/projects') return [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Old POC' }, { id: 3, name: 'Broken' }];
      if (req.path === '/api/v1/projects') return [{ id: 10, name: 'Alpha' }, { id: 11, name: 'Broken' }];
      if (req.path === '/reporter/api/tests/grouped') {
        const project = req.query.get('projectName');
        if (project === 'Broken') return reply(503, { message: 'unavailable' });
        return project === 'Alpha'
          ? { count: 2, data: [{ user: 'bot', 'digitalai:user': null, _count_: 90, passedCount: 80, failedCount: 10 }, { user: null, 'digitalai:user': 'web@x.test', _count_: 10, passedCount: 10 }] }
          : { count: 1, data: [{ user: 'cy', 'digitalai:user': null, _count_: 5, passedCount: 5 }] };
      }
      return undefined;
    });
    const saved = { dir: process.env.MCP_REPORT_DIR, mode: process.env.MCP_DEPLOYMENT_MODE };
    process.env.MCP_DEPLOYMENT_MODE = 'docker'; // nothing written: the report comes back attached
    delete process.env.MCP_REPORT_DIR;
    const tools = await connectTools(registerReportTools);
    try {
      const r = await tools.call('create_test_inventory_report', {});
      assert.notEqual(r.res.isError, true, r.text);
      assert.match(r.text, /Report ready: test-report-inventory-\d{8}-\d{4}/);
      assert.match(r.text, /105 test reports in 2 of 3 projects, all dates; pass rate 90\.5%/);
      assert.match(r.text, /1 project did not answer and is not counted: Broken/);
      const html = String((r.res.content as unknown as Array<{ type: string; resource?: { text: string } }>).find((x) => x.type === 'resource')?.resource?.text);
      assert.match(html, /web@x\.test/, 'a web report is counted under the user in its own key');
      assert.match(html, /no cloud project/);
      const asked = api.requests.filter((q) => q.path === '/reporter/api/tests/grouped').map((q) => q.query.get('projectName')).sort();
      assert.ok(asked.filter((p) => p === 'Alpha').length === 1 && asked.filter((p) => p === 'Old POC').length === 1, asked.join(','));
      const one = await tools.call('create_report', { recipe: 'test-inventory', projectName: 'Alpha' });
      assert.match(one.text, /100 test reports in project Alpha, all dates/);
    } finally {
      await tools.close();
      await api.close();
      if (saved.dir === undefined) delete process.env.MCP_REPORT_DIR; else process.env.MCP_REPORT_DIR = saved.dir;
      if (saved.mode === undefined) delete process.env.MCP_DEPLOYMENT_MODE; else process.env.MCP_DEPLOYMENT_MODE = saved.mode;
    }
  });
});

describe('test breakdown and trend (counts from the platform, never cut short)', () => {
  const c = (passed: number, failed = 0, error = 0, incomplete = 0) => ({ passed, failed, error, incomplete, skipped: 0, healed: 0, total: passed + failed + error + incomplete });

  it('accepts the words people use for a key', () => {
    assert.equal(reportKey('Platform'), 'device.os');
    assert.equal(reportKey('os version'), 'device.version');
    assert.equal(reportKey('test'), 'name');
    assert.equal(reportKey('digitalai:team'), 'digitalai:team');
  });

  it('one key: merges case variants, prints the run count beside each rate, and does not rank a handful of runs', () => {
    const rows = [{ values: ['ANDROID'], counts: c(400, 40) }, { values: ['Android'], counts: c(500, 60) }, { values: ['iOS'], counts: c(300, 200) },
      { values: [null], counts: c(5, 0, 0, 1) }];
    const r = buildTestBreakdown({ rows, keys: ['device.os'], from: T0 - 29 * DAY, to: T0, days: 30, projectName: 'Demo', passRateGoal: 85 });
    assert.equal(r.spec.title, 'Test Results by Platform');
    assert.match(r.highlights[0], /^1,506 runs in 3 platform groups, last 30 days; pass rate 80\.1%\./);
    assert.match(r.highlights[2], /^Lowest pass rate: iOS at 60\.0% over 500 verdicts; highest: Android at 90\.0%\./);
    const table = section(r.spec, /Every Platform Group/).blocks[0] as Extract<Section['blocks'][number], { type: 'table' }>;
    assert.deepEqual(table.rows.map((x) => [x.group, x.runs, x.passed, x.failed, x.other, x.rate]), [['Android', 1000, 900, 100, 0, '90.0%'], ['iOS', 500, 300, 200, 0, '60.0%'], ['Web or no device', 6, 5, 0, 1, '100.0%']]);
    const means = String(section(r.spec, /Results by Platform/).whatItMeans);
    assert.match(means, /1 group with fewer than 20 verdicts is listed but not ranked/);
    assert.match(means, /1 of 2 ranked groups meet the 85% goal/);
    assert.match(String(r.spec.source), /counts by platform and status for project Demo, .* \(nothing is sampled or cut off\)/);
  });

  it('two keys: a failure-rate grid with thin cells left empty; test names that differ only in ids are one test; all dates', () => {
    const rows = [{ values: ['Login 0000811-ABCDE1 1001', 'iOS'], counts: c(30, 30) }, { values: ['Login 0000811-ABCDE2 1002', 'iOS'], counts: c(20, 20) },
      { values: ['Login 0000811-ABCDE3 1003', 'Android'], counts: c(95, 5) }, { values: ['Pay', 'Android'], counts: c(3, 1) }];
    const r = buildTestBreakdown({ rows, keys: ['name', 'device.os'], from: null, to: T0, days: null });
    assert.equal(r.spec.title, 'Test Results by Test and Platform');
    assert.equal(r.spec.subtitle, 'All dates');
    const heat = section(r.spec, /Failure Rate by Test and Platform/).blocks[0] as Extract<Section['blocks'][number], { type: 'heatmap' }>;
    assert.deepEqual(heat.rows, ['Login', 'Pay']);
    assert.deepEqual(heat.columns, ['Android', 'iOS']);
    assert.deepEqual(heat.values, [[5, 50], [null, null]], 'four verdicts are not a rate');
    assert.match(String(section(r.spec, /Failure Rate by Test and Platform/).whatItMeans), /highest failure rate is Login with iOS: 50\.0% of 100 verdicts failed/);
    assert.match(String(section(r.spec, /Every Test Group/).whatItMeans), /differ only in ids, dates or run numbers are counted as one test/);
    assert.match(renderReport(r.spec), /<h1>Test Results by Test and Platform<\/h1>/);
    assert.match(buildTestBreakdown({ rows: [], keys: ['device.os'], from: T0 - DAY, to: T0, days: 2 }).highlights[0], /^0 runs in 0 platform groups/);
  });

  it('values that differ only in letter case are one group, in the spelling most runs have', () => {
    const folded = foldBreakdownRows([{ values: ['Chrome', '120'], counts: c(8, 1) }, { values: ['chrome', '120'], counts: c(12) }, { values: ['CHROME', '119'], counts: c(2) }, { values: [null, null], counts: c(4) }]);
    assert.deepEqual(folded.map((r) => [r.values, r.counts.total, r.counts.failed]), [[['chrome', '120'], 21, 1], [['chrome', '119'], 2, 0], [[null, null], 4, 0]]);
    // In a report: "Login" and "login" are one test once their run ids are taken off.
    const r = buildTestBreakdown({ rows: [{ values: ['Login 0000811-ABCDE1 1001'], counts: c(30, 10) }, { values: ['login 0000811-ABCDE2 1002'], counts: c(20) }, { values: ['Pay'], counts: c(25, 5) }],
      keys: ['name'], from: T0 - 6 * DAY, to: T0, days: 7 });
    assert.match(r.highlights[0], /^90 runs in 2 test groups/);
  });

  it('trend: weeks for 90 days, exact totals, the lowest week named with its verdicts, UTC days', () => {
    const from = Date.parse('2026-08-28T00:00:00Z'), to = Date.parse('2026-11-25T02:00:00Z');
    const daysRows = [
      { values: ['2026-08-20'], counts: c(999) }, // before the range: the bound is a run id, so an earlier day can slip in
      { values: ['2026-09-01'], counts: c(900, 100) }, { values: ['2026-09-02'], counts: c(800, 200) },
      { values: ['2026-11-03'], counts: c(500, 500) }, { values: ['2026-11-24'], counts: c(10, 0, 0, 2) },
    ];
    const r = buildTestTrend({ daysRows, platforms: [{ values: ['IOS'], counts: c(1000, 600) }, { values: ['iOS'], counts: c(200, 100) }, { values: [null], counts: c(1010, 100) }],
      classes: [{ values: ['assertion'], counts: c(0, 300) }, { values: [null], counts: c(0, 500) }], from, to, days: 90, projectName: 'Demo', passRateGoal: 85 });
    assert.match(r.highlights[0], /^3,012 runs over 90 days; pass rate 73\.4%\./);
    assert.ok(r.highlights.some((h) => /Lowest week: 11\/2 at 50\.0% over 1,000 verdicts/.test(h)), r.highlights.join(' | '));
    assert.equal(r.spec.subtitle, 'Runs and pass rate per week, last 90 days');
    const bars = section(r.spec, /Runs per Week/).blocks[0] as Extract<Section['blocks'][number], { type: 'bar' }>;
    assert.equal(bars.categories.length, 14);
    assert.equal(bars.series[0].values.reduce((t: number, v) => t + (v ?? 0), 0), 2210, 'the day before the range is left out');
    const plat = section(r.spec, /Results by Platform/).blocks[0] as Extract<Section['blocks'][number], { type: 'bar' }>;
    assert.deepEqual(plat.categories, ['iOS', 'Web or no device'], 'case variants merged');
    assert.match(String(section(r.spec, /Failures by Classification/).whatItMeans), /left 63% of them unclassified, so this chart cannot say where the problem is/);
    assert.match(String(r.spec.source), /counts per day and status, Aug\. 28, 2026 to Nov\. 25, 2026 \(the reporter's days/);
    assert.equal(buildTestTrend({ daysRows, platforms: null, classes: null, from: Date.parse('2026-11-12T00:00:00Z'), to, days: 14 }).spec.subtitle, 'Runs and pass rate per day, last 14 days');
    assert.equal(buildTestTrend({ daysRows, platforms: null, classes: null, from: Date.parse('2025-11-26T00:00:00Z'), to, days: 365 }).spec.subtitle, 'Runs and pass rate per month, last 365 days');
    assert.match(buildTestTrend({ daysRows: [], platforms: null, classes: null, from, to, days: 90 }).highlights[0], /^0 runs over 90 days/);
  });

  it('the tools find the first run of the range by its id and count from there, in one call each', async () => {
    const day = (iso: string) => Date.parse(iso);
    const now = Date.now();
    // 1,000 runs, one every 3 hours, ids 1..1000 with the newest last.
    const startOf = (id: number) => new Date(now - (1000 - id) * 3 * 3_600_000).toISOString();
    let probes = 0;
    const api = await startStubApi((req) => {
      if (req.path === '/reporter/api/tests/list') {
        const f = (req.json.filter ?? []).find((x: { property: string }) => x.property === 'test_id');
        if (!f) return { count: 1, data: [{ test_id: 1000, start_time: startOf(1000) }] };
        probes++;
        const id = Math.max(1, Number(f.value));
        return id > 1000 ? { count: 0, data: [] } : { count: 1, data: [{ test_id: id, start_time: startOf(id) }] };
      }
      if (req.path === '/reporter/api/tests/grouped') {
        const bound = (req.json.filter ?? []).find((x: { property: string }) => x.property === 'test_id')?.value;
        const key = (req.json.groupBy as string[])[0];
        if (key === 'date') return { count: 1, data: [{ date: new Date(now).toISOString().slice(0, 10), _count_: 40, passedCount: 30, failedCount: 10 }] };
        if (key === 'errorCategory') return { count: 1, data: [{ errorCategory: 'device', _count_: 10, failedCount: 10 }] };
        return { count: 2, data: [{ 'device.os': 'Android', _count_: 30, passedCount: 27, failedCount: 3, bound }, { 'device.os': 'iOS', _count_: 10, passedCount: 3, failedCount: 7 }] };
      }
      return undefined;
    });
    const saved = { dir: process.env.MCP_REPORT_DIR, mode: process.env.MCP_DEPLOYMENT_MODE };
    process.env.MCP_DEPLOYMENT_MODE = 'docker';
    delete process.env.MCP_REPORT_DIR;
    const tools = await connectTools(registerReportTools);
    try {
      const b = await tools.call('create_test_breakdown_report', { groupBy: ['platform'], days: 5 });
      assert.notEqual(b.res.isError, true, b.text);
      assert.match(b.text, /Report ready: test-results-by-platform-\d{8}-\d{4}/);
      assert.match(b.text, /40 runs in 2 platform groups, last 5 days; pass rate 75\.0%/);
      assert.ok(probes > 0 && probes <= 12, `a binary search, not a scan: ${probes} probes for 1,000 ids`);
      const grouped = api.requests.filter((q) => q.path === '/reporter/api/tests/grouped').at(-1)!;
      const sentBound = (grouped.json as { filter: Array<{ value: number }> }).filter[0].value;
      assert.equal(typeof sentBound, 'number', 'a string bound is refused by the platform');
      const firstInRange = startOf(sentBound), justBefore = startOf(sentBound - 1);
      const cut = new Date(now); cut.setHours(0, 0, 0, 0); cut.setDate(cut.getDate() - 4);
      assert.ok(day(firstInRange) >= cut.getTime() && day(justBefore) < cut.getTime(), 'the bound is the first run of the range');
      const all = await tools.call('create_report', { recipe: 'test-breakdown', groupBy: ['platform'], allDates: true });
      assert.match(all.text, /all dates/);
      assert.equal((api.requests.filter((q) => q.path === '/reporter/api/tests/grouped').at(-1)!.json as { filter?: unknown }).filter, undefined, 'all dates: no bound');
      const none = await tools.call('create_test_breakdown_report', {});
      assert.equal(none.res.isError, true);
      assert.match(none.text, /needs groupBy\. groupBy takes one or two of: platform, device/);
      const t = await tools.call('create_test_trend_report', { days: 14 });
      assert.notEqual(t.res.isError, true, t.text);
      assert.match(t.text, /Report ready: test-execution-trend-\d{8}-\d{4}/);
      assert.match(t.text, /40 runs over 14 days; pass rate 75\.0%/);
    } finally {
      await tools.close();
      await api.close();
      if (saved.dir === undefined) delete process.env.MCP_REPORT_DIR; else process.env.MCP_REPORT_DIR = saved.dir;
      if (saved.mode === undefined) delete process.env.MCP_DEPLOYMENT_MODE; else process.env.MCP_DEPLOYMENT_MODE = saved.mode;
    }
  });
});

describe('test reliability (every test of a period against the one before)', () => {
  const c = (passed: number, failed = 0, error = 0, incomplete = 0) => ({ passed, failed, error, incomplete, skipped: 0, healed: 0, total: passed + failed + error + incomplete });
  const current = [
    { values: ['Login 0000811-ABCDE1 1001'], counts: c(5) }, { values: ['Login 0000811-ABCDE2 1002'], counts: c(5) },
    { values: ['Pay'], counts: c(0, 4, 2) }, { values: ['Search'], counts: c(2, 6) }, { values: ['Cart'], counts: c(15, 5) },
    { values: ['Rare'], counts: c(1) }, { values: ['Odd'], counts: c(1, 1) },
  ];
  const previous = [
    { values: ['Login 0000811-ABCDE9 0900'], counts: c(8, 2) }, { values: ['Pay'], counts: c(0, 4) }, { values: ['Search'], counts: c(9) },
    { values: ['Cart'], counts: c(19, 1) }, { values: ['Odd'], counts: c(5) }, { values: ['Old'], counts: c(7, 1) }, { values: ['Tiny old'], counts: c(1) },
  ];
  type Table = Extract<Section['blocks'][number], { type: 'table' }>;

  it('a test whose name differs only in letter case between the two periods is one test', () => {
    const r = buildTestReliability({ current: [{ values: ['Checkout'], counts: c(0, 6) }], previous: [{ values: ['checkout'], counts: c(9) }], from: T0 - 6 * DAY, to: T0, days: 7 });
    assert.match(r.highlights[0], /1 newly failing/);
  });

  it('sorts every test into a standing and compares it with the period before', () => {
    const r = buildTestReliability({ current, previous, from: T0 - 6 * DAY, to: T0, days: 7, projectName: 'Demo' });
    assert.equal(r.highlights[0], '6 tests ran in the last 7 days (47 runs, pass rate 61.7%): 1 passes every time, 1 has mixed results, 1 fails every time, 1 newly failing, 2 had too few runs to judge.');
    assert.equal(r.highlights[1], '1 test passed every run in the previous 7 days and fails now; the largest is "Search" (6 of 8 runs failed).');
    assert.equal(r.highlights[2], 'Most failures: "Cart" failed 5 of 20 runs (pass rate 75.0%; 95.0% in the previous 7 days).');
    assert.equal(r.highlights[3], '1 test failed every run: 6 runs (13% of all runs) that could not pass. The largest is "Pay" (6 runs).');
    assert.equal(r.highlights[4], '1 test that failed in the previous 7 days passes every run now.');
    assert.equal(r.highlights[5], '1 test that ran in the previous 7 days did not run in this one.');
    assert.deepEqual(r.spec.headline, { value: '1 of 4', label: 'Judged tests passing every run' });
    assert.deepEqual((section(r.spec, /Newly Failing/).blocks[0] as Table).rows, [{ test: 'Search', runs: 8, failed: 6, rate: '25.0%', prev: '9 of 9 passed' }]);
    assert.deepEqual((section(r.spec, /Failing Every Time/).blocks[0] as Table).rows, [{ test: 'Pay', runs: 6, prev: '0 of 4 passed' }]);
    assert.match(String(section(r.spec, /Failing Every Time/).whatItMeans), /It also failed every run in the previous 7 days: that is a broken test or a known defect, not news\./);
    assert.deepEqual((section(r.spec, /Mixed Results/).blocks[0] as Table).rows, [{ test: 'Cart', runs: 20, passed: 15, failed: 5, rate: '75.0%', prev: '95.0%', change: '-20.0 pts' }]);
    assert.match(String(section(r.spec, /Mixed Results/).whatItMeans), /1 of them dropped by more than 10 points/);
    assert.doesNotMatch(renderReport(r.spec), /flaky/i, 'the counts cannot say why a test passes and fails');
    assert.deepEqual((section(r.spec, /Recovered/).blocks[0] as Table).rows, [{ test: 'Login', runs: 10, prev: '8 of 10 passed' }]);
    assert.deepEqual((section(r.spec, /No Longer Run/).blocks[0] as Table).rows, [{ test: 'Old', runs: 8, rate: '87.5%' }], 'one run in the period before is not "stopped running"');
    assert.match(String(section(r.spec, /No Longer Run/).whatItMeans), /1 test ran in this period only/);
    const every = (section(r.spec, /Every Test/).blocks[0] as Table).rows;
    assert.deepEqual(every.map((x) => [x.test, x.standing]), [['Cart', 'Mixed results'], ['Login', 'Passes every time'], ['Search', 'Newly failing'], ['Pay', 'Fails every time'], ['Odd', 'Too few runs'], ['Rare', 'Too few runs']]);
    const where = String(section(r.spec, /Where the Tests Stand/).whatItMeans);
    assert.match(where, /1 of 4 tests with enough runs to judge passed every run; they carry 21% of the runs\./);
    assert.match(where, /Tests that fail every time take 13% of the runs: device time spent on a result that is known in advance/);
    assert.match(where, /1 test both passed and failed in the same period and carries 43% of the runs\. 1 of them passes between 10% and 90% of its runs \(43% of all runs\): for that test a single result says little\./);
    assert.match(String(r.spec.source), /for project Demo, .* and the 7 days before \(nothing is sampled or cut off\)/);
  });

  it('no earlier period: nothing is newly failing, recovered or stopped; a tiny share is "under 1%"; an empty period', () => {
    const alone = buildTestReliability({ current, previous: null, from: T0 - 6 * DAY, to: T0, days: 7 });
    assert.equal(alone.spec.subtitle, 'Every test of the last 7 days');
    assert.equal(allSections(alone.spec).some((s) => /Newly Failing|Recovered|No Longer Run/.test(s.title)), false);
    assert.deepEqual((section(alone.spec, /Mixed Results/).blocks[0] as Table).rows.map((x) => x.test), ['Search', 'Cart']);
    const big = buildTestReliability({ current: [{ values: ['Health'], counts: c(9000, 10) }, { values: ['Broken'], counts: c(0, 12) }], previous: null, from: T0 - 6 * DAY, to: T0, days: 7 });
    assert.match(big.highlights.join(' '), /12 runs \(under 1% of all runs\) that could not pass/);
    assert.match(String(section(big.spec, /Where the Tests Stand/).whatItMeans), /1 test both passed and failed in the same period and carries over 99% of the runs\. None of them is near an even split/, 'a test at 99.9% is not unreliable, and 9,010 of 9,022 runs is not "100%"');
    assert.doesNotMatch(String(section(big.spec, /Where the Tests Stand/).whatItMeans), /device time spent/);
    const empty = buildTestReliability({ current: [], previous: null, from: T0 - 6 * DAY, to: T0, days: 7 });
    assert.equal(empty.highlights[0], '0 tests ran in the last 7 days (0 runs, pass rate n/a).');
    assert.match(renderReport(empty.spec), /No test ran/);
  });
});

describe('device coverage and device utilization', () => {
  const c = (passed: number, failed = 0) => ({ passed, failed, error: 0, incomplete: 0, skipped: 0, healed: 0, total: passed + failed });
  const dev = (name: string, id: string, serial: string, os: string, osVersion: string, model: string, status: string, region = 'US1'): PoolDevice =>
    ({ name, id, serial, os, osVersion, model, status, statusAgeMin: 5, region, agent: 'h1' });
  type Table = Extract<Section['blocks'][number], { type: 'table' }>;

  it('coverage: devices with and without a run, OS versions the pool has and no test ran on', () => {
    const devices = [dev('A1', '1', 'a1', 'Android', '14', 'Pixel 8', 'Available'), dev('A2', '2', 'a2', 'Android', '14.0', 'Pixel 8', 'Available'),
      dev('A3', '3', 'A3', 'Android', '15', 'Galaxy S25', 'Offline'), dev('I1', '4', 'i1', 'iOS', '17.6.1', 'iPhone 15', 'In Use'), dev('I2', '5', 'i2', 'iOS', '18.1', 'iPhone 16', 'Available')];
    const byDevice: GroupCounts = [{ key: 'A1', counts: c(90, 10) }, { key: 'i1', counts: c(40, 10) }, { key: 'emulator-5554', counts: c(5) }, { key: null, counts: c(20) }];
    const byVersion = [{ values: ['ANDROID', '14'], counts: c(90, 10) }, { values: ['iOS', '17.6.1'], counts: c(40, 10) }, { values: ['Android', '13'], counts: c(5) }, { values: [null, null], counts: c(20) }];
    const r = buildDeviceCoverage({ devices, byDevice, byVersion, from: T0 - 29 * DAY, to: T0, days: 30, projectName: 'Demo' });
    assert.deepEqual(r.highlights, [
      'Tests of project Demo ran on 2 of 5 devices in the last 30 days (155 runs on devices, 20 more with no device).',
      '2 devices that are online had no run.',
      '2 OS versions in the pool had no run: Android 15 (1 device), iOS 18 (1 device).']);
    assert.deepEqual(r.spec.headline, { value: '40%', label: 'Of the pool had a run' });
    const kpis = section(r.spec, /At a Glance/).blocks[0] as Extract<Section['blocks'][number], { type: 'kpis' }>;
    assert.deepEqual(kpis.items.map((k) => k.value), ['5', '2', '2', '2 of 4']);
    assert.match(String(section(r.spec, /Coverage of the Pool/).whatItMeans), /40% of the pool ran at least one test of project Demo\. 5 runs were on 1 device that is not in today's pool/);
    const versions = section(r.spec, /Runs by OS Version/);
    assert.deepEqual((versions.blocks[1] as Table).rows.map((x) => [x.version, x.pool, x.tested, x.runs, x.rate]), [
      ['Android 15', 1, 0, 0, ''], ['Android 14', 2, 1, 100, '90.0%'], ['Android 13', 0, 0, 5, '100.0%'], ['iOS 18', 1, 0, 0, ''], ['iOS 17', 1, 1, 50, '80.0%']]);
    const means = String(versions.whatItMeans);
    assert.match(means, /2 OS versions that the pool has were not tested: Android 15, iOS 18\. That includes the newest Android 15 and iOS 18 in the pool/);
    assert.match(means, /Pass rate runs from 80\.0% on iOS 17 \(50 verdicts\) to 90\.0% on Android 14\./);
    assert.match(means, /1 version ran on one device only although the pool has more \(Android 14\)\./);
    assert.deepEqual((section(r.spec, /Device Models/).blocks[0] as Table).rows.map((x) => [x.model, x.pool, x.tested, x.runs]), [['Pixel 8', 2, 1, 100], ['iPhone 15', 1, 1, 50], ['Galaxy S25', 1, 0, 0], ['iPhone 16', 1, 0, 0]]);
    assert.deepEqual((section(r.spec, /Devices with No Run/).blocks[0] as Table).rows.map((x) => [x.device, x.status]), [['A2', 'Available'], ['I2', 'Available'], ['A3', 'Offline']], 'online devices first');
    assert.match(String(r.spec.source), /joined by serial number with the device list/);
    assert.match(renderReport(r.spec), /<h1>Device Coverage<\/h1>/);
    const none = buildDeviceCoverage({ devices: [], byDevice: [], byVersion: [], from: T0 - DAY, to: T0, days: 2 });
    assert.match(renderReport(none.spec), /This access key sees no device/);
  });

  it('utilization: reserved hours against the hours the pool had, joined by device id', () => {
    const devices = [dev('D1', '1', 's1', 'Android', '14', 'Pixel 8', 'In Use'), dev('D2', '2', 's2', 'Android', '14', 'Pixel 8', 'Available'),
      dev('D3', '3', 's3', 'iOS', '17.6', 'iPhone 15', 'Offline', 'UK1'), dev('D4', '4', 's4', 'iOS', '17.6', 'iPhone 15', 'Available', 'UK1')];
    const u = (deviceId: string, device: string, project: string, hours: number) => ({ deviceId, device, os: 'Android', osVersion: '14', project, hours });
    const usage = [u('1', 'D1 renamed', 'Alpha', 100), u('1', 'D1 renamed', 'Beta', 40), u('2', 'D2', 'Alpha', 6), u('3', 'D3', 'Alpha', 0), u('9', 'Gone', 'Alpha', 10)];
    const r = buildDeviceUtilization({ usage, devices, from: T0 - 9 * DAY, to: T0, days: 10 });
    assert.deepEqual(r.highlights, [
      '156 reserved device hours in the last 10 days (every project): 15.2% of the hours the pool of 4 devices had.',
      '2 devices were not reserved once; 1 of them is online.',
      'Highest demand per device: Pixel 8 at 7.3 h a day over 2 devices.',
      '1 device is reserved more than 12 h a day.']);
    const bands = section(r.spec, /How Much Each Device Is Used/).blocks[0] as Extract<Section['blocks'][number], { type: 'bar' }>;
    assert.deepEqual(bands.series[0].values, [2, 1, 0, 0, 1]);
    assert.match(String(section(r.spec, /How Much Each Device Is Used/).whatItMeans), /75% of the pool was reserved for less than an hour a day or not at all, while 1 device was reserved more than 12 hours a day/);
    assert.deepEqual((section(r.spec, /Demand by Model/).blocks[0] as Table).rows, [
      { model: 'Pixel 8', os: 'Android', devices: 2, hours: 146, perDay: 7.3, unused: 0 }, { model: 'iPhone 15', os: 'iOS', devices: 2, hours: 0, perDay: 0, unused: 2 }]);
    assert.match(String(section(r.spec, /Demand by Model/).whatItMeans), /1 model with two or more devices was not reserved at all \(iPhone 15, 2 devices\): candidates to retire/);
    assert.deepEqual((section(r.spec, /Most Used Devices/).blocks[0] as Table).rows.map((x) => [x.device, x.hours, x.util, x.projects]), [['D1', 140, 58.3, 2], ['D2', 6, 2.5, 1]], 'joined by id: a renamed device is still found');
    assert.deepEqual((section(r.spec, /Devices Not Reserved/).blocks[0] as Table).rows.map((x) => x.device), ['D4', 'D3']);
    assert.match(String(r.spec.source), /10 more hours were on 1 device no longer in the device list\./);
    assert.match(String(section(r.spec, /Use by Region/).whatItMeans), /One region holds nearly all devices\./);
    assert.match(renderReport(r.spec), /<h1>Device Utilization<\/h1>/);
  });

  it('the three tools build their report in one call each', async () => {
    const now = Date.now();
    const startOf = (id: number) => new Date(now - (1000 - id) * 3 * 3_600_000).toISOString();
    const DEVICES = 'Device ID,Device name,OS,OS Version,Project,Total duration (in hours)\n11,Pixel A,Android,14,Alpha,30\n12,iPhone B,iOS,17.6,Alpha,0\n';
    const api = await startStubApi((req) => {
      if (req.path === '/api/v1/users/my-account-info') return accountInfo('Admin', 'Default');
      if (req.path === '/api/v1/devices') return { status: 'SUCCESS', data: [
        { id: 11, udid: 'ser-a', deviceName: 'Pixel A', deviceOs: 'Android', osVersion: '14', modelName: 'Pixel 8', displayStatus: 'Available', statusAgeInMinutes: 5, region: 'US1', agentName: 'h1' },
        { id: 12, iosUdid: 'ser-b', deviceName: 'iPhone B', deviceOs: 'iOS', osVersion: '17.6', modelName: 'iPhone 15', displayStatus: 'Available', statusAgeInMinutes: 5, region: 'US1', agentName: 'h1' }] };
      if (req.path.startsWith('/api/v2/configuration/get-CSV-reports/0/0/')) return reply(200, DEVICES);
      if (req.path === '/reporter/api/tests/list') {
        const f = (req.json.filter ?? []).find((x: { property: string }) => x.property === 'test_id');
        if (!f) return { count: 1, data: [{ test_id: 1000, start_time: startOf(1000) }] };
        const id = Math.max(1, Number(f.value));
        return id > 1000 ? { count: 0, data: [] } : { count: 1, data: [{ test_id: id, start_time: startOf(id) }] };
      }
      if (req.path === '/reporter/api/tests/grouped') {
        const filter = (req.json.filter ?? []) as Array<{ operator: string }>;
        const key = (req.json.groupBy as string[])[0];
        if (key === 'name') return filter.some((f) => f.operator === '<')
          ? { count: 1, data: [{ name: 'Login', _count_: 10, passedCount: 10 }] }
          : { count: 2, data: [{ name: 'Login', _count_: 10, passedCount: 2, failedCount: 8 }, { name: 'Pay', _count_: 5, passedCount: 5 }] };
        if (key === 'device.serialNumber') return { count: 1, data: [{ 'device.serialNumber': 'ser-a', _count_: 40, passedCount: 30, failedCount: 10 }] };
        return { count: 1, data: [{ 'device.os': 'Android', 'device.version': '14', _count_: 40, passedCount: 30, failedCount: 10 }] };
      }
      return undefined;
    });
    const saved = { dir: process.env.MCP_REPORT_DIR, mode: process.env.MCP_DEPLOYMENT_MODE };
    process.env.MCP_DEPLOYMENT_MODE = 'docker';
    delete process.env.MCP_REPORT_DIR;
    const tools = await connectTools(registerReportTools);
    try {
      const rel = await tools.call('create_test_reliability_report', {});
      assert.notEqual(rel.res.isError, true, rel.text);
      assert.match(rel.text, /Report ready: test-reliability-\d{8}-\d{4}/);
      assert.match(rel.text, /2 tests ran in the last 7 days \(15 runs, pass rate 46\.7%\): 1 passes every time, 1 newly failing\./);
      const bounds = api.requests.filter((q) => q.path === '/reporter/api/tests/grouped').map((q) => (q.json as { filter: Array<{ operator: string; value: unknown }> }).filter);
      const before = bounds.find((f) => f.length === 2)!;
      assert.deepEqual(before.map((f) => f.operator), ['>=', '<']);
      assert.ok(before.every((f) => typeof f.value === 'number') && (before[0].value as number) < (before[1].value as number), 'the period before: a numeric id range that ends where this period starts');
      const long = await tools.call('create_report', { recipe: 'test-reliability', days: 60 });
      assert.equal(long.res.isError, true);
      assert.match(long.text, /up to 31 days .* use test-trend/);
      const cov = await tools.call('create_device_coverage_report', {});
      assert.notEqual(cov.res.isError, true, cov.text);
      assert.match(cov.text, /Tests of project Default ran on 1 of 2 devices in the last 30 days \(40 runs on devices\)\./);
      assert.match(cov.text, /1 OS version in the pool had no run: iOS 17 \(1 device\)\./);
      const util = await tools.call('create_device_utilization_report', { days: 10 });
      assert.notEqual(util.res.isError, true, util.text);
      assert.match(util.text, /30 reserved device hours in the last 10 days \(every project\): 6\.3% of the hours the pool of 2 devices had\./);
      assert.match(util.text, /1 device was not reserved once; 1 of them is online\./);
    } finally {
      await tools.close();
      await api.close();
      if (saved.dir === undefined) delete process.env.MCP_REPORT_DIR; else process.env.MCP_REPORT_DIR = saved.dir;
      if (saved.mode === undefined) delete process.env.MCP_DEPLOYMENT_MODE; else process.env.MCP_DEPLOYMENT_MODE = saved.mode;
    }
  });

  it('a device with no serial number is still a row of text: its id, and the coverage report is built', async () => {
    const api = await startStubApi((req) => (req.path === '/api/v1/devices' ? { status: 'SUCCESS', data: [
      { id: 21, deviceName: 'No Serial', deviceOs: 'Android', osVersion: '14', displayStatus: 'Available' }, { deviceName: 'Nothing', deviceOs: 'iOS', displayStatus: 'Offline' }] } : undefined));
    try {
      const devices = await deviceRows();
      assert.deepEqual(devices.map((d) => d.serial), ['21', '']);
      const r = buildDeviceCoverage({ devices, byDevice: [], byVersion: [], from: T0, to: T0 + 7 * DAY, days: 7 });
      assert.match(r.highlights[0], /ran on 0 of 2 devices/);
    } finally { await api.close(); }
  });
});

describe('performance overview', () => {
  let txId = 1;
  const tx = (name: string, daysAgo: number, speedIndex: number | null, o: Partial<Transaction> = {}): Transaction => ({
    id: txId++, name, appName: 'com.demo.bank', appVersion: '1.0', startTime: new Date(T0 - daysAgo * DAY).toISOString(), date: '', deviceUid: 'd1', deviceName: 'Pixel 8',
    deviceModel: 'Pixel 8', deviceOs: 'Android', deviceManufacturer: 'Google', deviceVersion: '14', deviceScreen: '', deviceType: 'PHONE', networkProfile: 'Monitor',
    cpuAvg: 10, cpuMax: 20, cpuCoreCount: 8, memAvg: 100, memMax: 120, memTotalInBytes: null, batteryAvg: 1, batteryMax: 2, totalUploadedBytes: 0, totalDownloadedBytes: 0,
    duration: 4000, speedIndex, videoStart: null, videoEnd: null, userName: 'u', testId: null, attachmentId: null, attachmentPath: null, projectId: 1, projectName: 'Demo', attachmentList: null, ...o,
  } as Transaction);
  const list = [
    ...[1000, 1100, 1200].map((v, k) => tx('Login', 80 - k, v)),
    ...[2000, 2200, 2400].map((v, k) => tx('Login', 45 - k, v, { appVersion: '2.0' })),
    ...[500, 600, 700].map((v, k) => tx('Pay', 60 - k, v, { deviceOs: 'iOS', deviceUid: 'd2', networkProfile: '4G-average', duration: 2000 })),
    tx('Solo', 41, null, { cpuAvg: null, memAvg: null, networkProfile: '' }),
  ];
  type Table = Extract<Section['blocks'][number], { type: 'table' }>;

  it('ranks transactions by median Speed Index, compares app versions within one transaction, and says what is missing', () => {
    const r = buildPerformanceOverview({ transactions: list, total: 25, newest: T0 - 41 * DAY, from: T0 - 89 * DAY, to: T0, days: 90, projectName: 'Demo' });
    assert.deepEqual(r.highlights, [
      '10 performance transactions in the last 90 days (of 25 on record): 3 transaction names, 1 app, 2 devices.',
      'Highest median Speed Index: "Login" at 1,600 SI over 6 runs; lowest: "Pay" at 600 SI. Speed Index is a composite score, lower is better.',
      '"Login": median Speed Index rose 100% from app version 1.0 to 2.0 (3 and 3 runs).',
      'The newest transaction is from Oct. 7, 2026: nothing has been measured for 41 days.']);
    assert.deepEqual(r.spec.headline, { value: '1,100 SI', label: 'Median Speed Index' });
    const ranked = section(r.spec, /Transactions by Speed Index/);
    assert.deepEqual((ranked.blocks[0] as Extract<Section['blocks'][number], { type: 'bar' }>).categories, ['Login (6)', 'Pay (3)'], 'one run is listed, never ranked');
    assert.deepEqual((ranked.blocks[1] as Table).rows, [
      { name: 'Login', runs: 6, si: 1600, secs: 4, cpu: 10, mem: 100 }, { name: 'Pay', runs: 3, si: 600, secs: 2, cpu: 10, mem: 100 }, { name: 'Solo', runs: 1, si: null, secs: 4, cpu: null, mem: null }]);
    assert.match(String(section(r.spec, /By Network Profile/).whatItMeans), /3 transactions of 10 ran under a profile that shapes the network/);
    assert.match(String(section(r.spec, /By Platform/).whatItMeans), /not which platform is faster/);
    const versions = section(r.spec, /"Login" by App Version/);
    assert.deepEqual((versions.blocks[1] as Table).rows.map((x) => [x.name, x.runs, x.si]), [['1.0', 3, 1100], ['2.0', 3, 2200]]);
    assert.match(String(versions.whatItMeans), /From 1\.0 to 2\.0 the median Speed Index rose 100% \(3 and 3 runs\), a slowdown to confirm on the same devices and network profile/);
    const quality = section(r.spec, /What the Data Can Support/).blocks[0] as Extract<Section['blocks'][number], { type: 'findings' }>;
    assert.deepEqual(quality.items.map((x) => (typeof x === 'string' ? x : x.text)), [
      '1 transaction recorded no Speed Index (it needs video; the medians above leave them out).',
      '1 transaction recorded neither CPU nor memory (no telemetry from the device).',
      '1 transaction name of 3 has fewer than 3 runs: too few for a median to mean much.']);
    const html = renderReport(r.spec);
    assert.match(html, /<h1>Performance Overview<\/h1>/);
    assert.doesNotMatch(html, /ms faster|milliseconds faster|SI ms/, 'Speed Index is never turned into a duration');
  });

  it('all dates, an empty range that says what is on record, and no transaction at all', () => {
    const all = buildPerformanceOverview({ transactions: list, total: 10, newest: T0, from: null, to: T0, days: null });
    assert.match(all.highlights[0], /^10 performance transactions on record: 3 transaction names/);
    assert.equal(all.spec.subtitle, 'Performance transactions, all dates');
    const empty = buildPerformanceOverview({ transactions: [], total: 25, newest: T0 - 200 * DAY, from: T0 - 6 * DAY, to: T0, days: 7 });
    assert.match(renderReport(empty.spec), /No transaction in the last 7 days; 25 transactions on record, the newest from May 1, 2026\. Ask for a longer range or all dates\./);
    const none = buildPerformanceOverview({ transactions: [], total: 0, newest: null, from: T0 - 6 * DAY, to: T0, days: 7 });
    assert.match(renderReport(none.spec), /startPerformanceTransaction/);
  });

  it('the tool reads the list once and cuts the range itself', async () => {
    const recent = (name: string, daysAgo: number, speedIndex: number) => ({ ...tx(name, 0, speedIndex), startTime: new Date(Date.now() - daysAgo * DAY).toISOString() });
    const api = await startStubApi((req) => (req.path === '/reporter/api/transactions/list'
      ? { count: null, data: [recent('Login', 1, 1000), recent('Login', 2, 1200), recent('Login', 3, -1), { ...recent('Old', 200, 900), deviceOs: 'IOS' }] } : undefined));
    const saved = { dir: process.env.MCP_REPORT_DIR, mode: process.env.MCP_DEPLOYMENT_MODE };
    process.env.MCP_DEPLOYMENT_MODE = 'docker';
    delete process.env.MCP_REPORT_DIR;
    const tools = await connectTools(registerReportTools);
    try {
      const r = await tools.call('create_performance_overview_report', {});
      assert.notEqual(r.res.isError, true, r.text);
      assert.match(r.text, /Report ready: performance-overview-\d{8}-\d{4}/);
      assert.match(r.text, /3 performance transactions in the last 90 days \(of 4 on record\): 1 transaction name, 1 app, 1 device\./);
      assert.match(r.text, /1 transaction \(33%\) recorded no Speed Index\./, 'the platform writes -1 for "not captured"');
      const all = await tools.call('create_report', { recipe: 'performance-overview', allDates: true });
      assert.match(all.text, /4 performance transactions on record: 2 transaction names/);
      assert.equal(api.requests.filter((q) => q.path === '/reporter/api/transactions/list').length, 2, 'one list call per report');
    } finally {
      await tools.close();
      await api.close();
      if (saved.dir === undefined) delete process.env.MCP_REPORT_DIR; else process.env.MCP_REPORT_DIR = saved.dir;
      if (saved.mode === undefined) delete process.env.MCP_DEPLOYMENT_MODE; else process.env.MCP_DEPLOYMENT_MODE = saved.mode;
    }
  });
});

describe('release readiness (a period or one build against stated checks)', () => {
  const c = (passed: number, failed = 0, error = 0, incomplete = 0) => ({ passed, failed, error, incomplete, skipped: 0, healed: 0, total: passed + failed + error + incomplete });
  const current = [{ values: ['Login'], counts: c(60) }, { values: ['Pay'], counts: c(0, 6) }, { values: ['Search'], counts: c(2, 6) }, { values: ['Cart'], counts: c(15, 5) }];
  const previous = [{ values: ['Login'], counts: c(50) }, { values: ['Pay'], counts: c(0, 4) }, { values: ['Search'], counts: c(9) }, { values: ['Cart'], counts: c(19, 1) }];
  const platforms = [{ values: ['ANDROID'], counts: c(30, 2) }, { values: ['Android'], counts: c(40, 3) }, { values: ['iOS'], counts: c(7, 12) }];
  const classes = [{ values: ['assertion'], counts: c(0, 10) }, { values: ['device'], counts: c(0, 4) }, { values: [null], counts: c(0, 3) }, { values: [null], counts: c(77) }];
  type Table = Extract<Section['blocks'][number], { type: 'table' }>;
  const base = { from: T0 - 6 * DAY, to: T0, days: 7 };

  it('not ready: names the checks that fail, the ones at risk and the tests in the way', () => {
    const r = buildReleaseReadiness({ current, previous, platforms, classes, ...base, projectName: 'Demo' });
    assert.deepEqual(r.highlights, [
      'Not ready against this report\'s checks: 3 of 6 checks failed (pass rate, newly failing tests, a platform under the goal); 2 more at risk.',
      'Pass rate 81.9% over 94 verdicts in the last 7 days (4 tests); goal 95%.',
      'Newly failing: "Search".', 'Failing every run: "Pay".']);
    assert.deepEqual(r.spec.headline, { value: 'Not ready', label: 'Against this report\'s checks' });
    const checks = (section(r.spec, /^Checks$/).blocks[0] as Table).rows;
    assert.deepEqual(checks.map((x) => x.result), ['Failed', 'Failed', 'At risk', 'Failed', 'At risk', 'Passed']);
    assert.equal(checks[0].detail, '81.9% over 94 verdicts. 13 fewer failures would reach the goal.');
    assert.match(String(checks[2].detail), /1 test did not pass once: "Pay"\. It also failed every run in the previous 7 days \(known, but still open\)\./);
    assert.equal(checks[3].detail, 'Android 93.3% (75 verdicts).', 'case variants merged; a platform with 19 verdicts is not judged');
    assert.match(String(checks[4].detail), /1 test passes between 10% and 90% of its runs, so one green run of it is weak evidence: "Cart"\./);
    assert.deepEqual((section(r.spec, /Tests That Stand in the Way/).blocks[0] as Table).rows, [
      { test: 'Search', standing: 'Newly failing', runs: 8, failed: 6, prev: '9 of 9 passed' }, { test: 'Pay', standing: 'Fails every time (also before)', runs: 6, failed: 6, prev: '0 of 4 passed' }]);
    assert.match(String(section(r.spec, /Tests That Stand in the Way/).whatItMeans), /1 test broke between the two periods: start there, the change is recent\. 1 test cannot pass at present, since before this period/);
    const verdict = section(r.spec, /^Verdict$/).blocks[0] as Extract<Section['blocks'][number], { type: 'callout' }>;
    assert.equal(verdict.tone, 'risk');
    assert.match(verdict.text, /whether to release is a decision for the people who know what the failing tests cover/);
    assert.match(String(section(r.spec, /Failures by Classification/).whatItMeans), /Assertion/);
    assert.match(String(r.spec.source), /Checks: pass rate at or above 95%; no test that passed every run before and fails at least half now/);
    assert.match(renderReport(r.spec), /<h1>Release Readiness<\/h1>/);
  });

  it('ready, ready with risks, and no verdict from too few runs', () => {
    const ready = buildReleaseReadiness({ current: [{ values: ['Login'], counts: c(100) }], previous: [{ values: ['Login'], counts: c(50) }], platforms: [{ values: ['Android'], counts: c(100) }], classes: null, ...base, passRateGoal: 99 });
    assert.equal(ready.highlights[0], 'Ready against this report\'s checks: all 6 checks passed.');
    assert.match(String(section(ready.spec, /^Checks$/).whatItMeans), /No check fails\. The goal of 99% was given with the request\./);
    assert.equal(allSections(ready.spec).some((s) => /Stand in the Way/.test(s.title)), false);
    const risks = buildReleaseReadiness({ current: [{ values: ['Login'], counts: c(100) }], previous: null, platforms: [{ values: ['Android'], counts: c(100) }], classes: null, ...base });
    assert.equal(risks.highlights[0], 'Ready with risks against this report\'s checks: no check failed; 1 of 6 is at risk (newly failing tests).');
    assert.match(String((section(risks.spec, /^Checks$/).blocks[0] as Table).rows[1].detail), /No run in the previous 7 days to compare with/);
    const thin = buildReleaseReadiness({ current: [{ values: ['Login'], counts: c(9, 1) }], previous: null, platforms: null, classes: null, ...base });
    assert.equal(thin.spec.headline!.value, 'Not enough data');
    assert.match(thin.highlights[0], /Not enough data against this report's checks: 10 verdicts in the last 7 days: fewer than 20, too few for a verdict\./);
    assert.equal(allSections(thin.spec).some((s) => /^Checks$/.test(s.title)), false);
  });

  it('where scopes the counts of this period, is named on the report, and is refused by recipes that cannot filter', async () => {
    const now = Date.now();
    const startOf = (id: number) => new Date(now - (1000 - id) * 3 * 3_600_000).toISOString();
    const api = await startStubApi((req) => {
      if (req.path === '/api/v1/users/my-account-info') return accountInfo('Admin', 'Default');
      if (req.path === '/reporter/api/tests/list') {
        const f = (req.json.filter ?? []).find((x: { property: string }) => x.property === 'test_id');
        if (!f) return { count: 1, data: [{ test_id: 1000, start_time: startOf(1000) }] };
        const id = Math.max(1, Number(f.value));
        return id > 1000 ? { count: 0, data: [] } : { count: 1, data: [{ test_id: id, start_time: startOf(id) }] };
      }
      if (req.path === '/reporter/api/tests/grouped') {
        const groupBy = req.json.groupBy as string[];
        // As on the platform: a row carries every key that was grouped; the runs are stored as "IOS".
        const os = groupBy.includes('device.os') ? { 'device.os': 'IOS' } : {};
        if (groupBy[0] === 'name') return { count: 1, data: [{ name: 'Login', ...os, _count_: 40, passedCount: 40 }] };
        if (groupBy[0] === 'device.os') return { count: 1, data: [{ ...os, _count_: 40, passedCount: 40 }] };
        return { count: 0, data: [] };
      }
      return undefined;
    });
    const saved = { dir: process.env.MCP_REPORT_DIR, mode: process.env.MCP_DEPLOYMENT_MODE };
    process.env.MCP_DEPLOYMENT_MODE = 'docker';
    delete process.env.MCP_REPORT_DIR;
    const tools = await connectTools(registerReportTools);
    try {
      const r = await tools.call('create_release_readiness_report', { where: { platform: 'iOS', 'digitalai:build': '412' }, passRateGoal: 90 });
      assert.notEqual(r.res.isError, true, r.text);
      assert.match(r.text, /Report ready: release-readiness-\d{8}-\d{4}/);
      assert.match(r.text, /Scope: only runs where platform = iOS and build = 412\.\n/);
      assert.match(r.text, /Ready against this report's checks: all 6 checks passed\./);
      type Filter = Array<{ property: string; operator: string; value: unknown }>;
      const grouped = api.requests.filter((q) => q.path === '/reporter/api/tests/grouped').map((q) => q.json as { groupBy: string[]; filter: Filter });
      // The platform is matched whatever its case (the runs are stored as "IOS"); a build number has no case and is sent as written.
      const scopedCalls = grouped.filter((g) => g.filter.some((f) => f.property === 'device.os' && f.operator === 'contains' && f.value === 'ios') && g.filter.some((f) => f.property === 'digitalai:build' && f.operator === '=' && f.value === '412'));
      assert.equal(scopedCalls.length, 3, 'this period by test, platform and classification');
      assert.ok(scopedCalls.every((g) => g.groupBy.includes('device.os')), 'the platform is grouped too, to read its stored spelling');
      const before = grouped.find((g) => g.filter.some((f) => f.operator === '<'))!;
      assert.deepEqual(before.filter.map((f) => f.property), ['test_id', 'test_id'], 'the period before is the tests\' earlier runs, whatever the build');
      const html = String((r.res.content as unknown as Array<{ type: string; resource?: { text: string } }>).find((x) => x.type === 'resource')?.resource?.text);
      assert.match(html, /Only runs where platform = iOS and build = 412 are counted; the value is matched whatever its letter case\./);
      // exactCase: the filter goes out as written, with no extra grouping, and the report says how it matched.
      api.requests.length = 0;
      const exact = await tools.call('create_release_readiness_report', { where: { platform: 'iOS' }, exactCase: true });
      assert.notEqual(exact.res.isError, true, exact.text);
      assert.match(exact.text, /Scope: only runs where platform = iOS\. Only the exact spelling is counted: runs stored in another spelling \(upper or lower case\) are left out\./);
      const exactCalls = api.requests.filter((q) => q.path === '/reporter/api/tests/grouped').map((q) => q.json as { groupBy: string[]; filter: Filter });
      assert.ok(exactCalls.some((g) => g.groupBy.length === 1 && g.filter.some((f) => f.property === 'device.os' && f.operator === '=' && f.value === 'iOS')));
      assert.ok(!exactCalls.some((g) => g.filter.some((f) => f.operator === 'contains')));
      // keysAsWritten: a tenant's own "category" and "platform" columns are asked for by those names, not as the built-in keys.
      api.requests.length = 0;
      const custom = await tools.call('create_test_breakdown_report', { groupBy: ['category'], where: { platform: 'tablet' }, keysAsWritten: true });
      assert.notEqual(custom.res.isError, true, custom.text);
      const customCalls = api.requests.filter((q) => q.path === '/reporter/api/tests/grouped').map((q) => q.json as { groupBy: string[]; filter: Filter });
      assert.ok(customCalls.some((g) => g.groupBy[0] === 'category' && g.filter.some((f) => f.property === 'platform' && f.value === 'tablet')));
      assert.ok(!customCalls.some((g) => g.groupBy.includes('errorCategory') || g.filter.some((f) => f.property === 'device.os')));
      assert.match(custom.text, /Scope: only runs where platform = tablet\./);
      // A scope on the user counts mobile runs only (web runs keep the user in another column): the report says so.
      const mine = await tools.call('create_test_breakdown_report', { groupBy: ['platform'], where: { user: 'me@x.io' } });
      assert.notEqual(mine.res.isError, true, mine.text);
      assert.match(mine.text, /Scope: only runs where user = me@x\.io\. Web \(Selenium\) runs are not included: the platform records their user in a separate column\. get_grouped_test_reports with a user filter counts mobile and web runs together\./);
      const mineHtml = String((mine.res.content as unknown as Array<{ type: string; resource?: { text: string } }>).find((x) => x.type === 'resource')?.resource?.text);
      assert.match(mineHtml, /the value is matched whatever its letter case\. Web \(Selenium\) runs are not included: the platform records their user in a separate column\./);
      assert.doesNotMatch(mineHtml, /get_grouped_test_reports/, 'a tool name is for the AI, not for the report');
      const refused = await tools.call('create_report', { recipe: 'device-health', where: { platform: 'iOS' } });
      assert.equal(refused.res.isError, true);
      assert.match(refused.text, /where is for test-breakdown, test-trend, test-reliability, release-readiness; device-health does not take it\./);
      const long = await tools.call('create_report', { recipe: 'release-readiness', days: 90 });
      assert.match(long.text, /up to 31 days .* Scope it to a build with where/);
    } finally {
      await tools.close();
      await api.close();
      if (saved.dir === undefined) delete process.env.MCP_REPORT_DIR; else process.env.MCP_REPORT_DIR = saved.dir;
      if (saved.mode === undefined) delete process.env.MCP_DEPLOYMENT_MODE; else process.env.MCP_DEPLOYMENT_MODE = saved.mode;
    }
  });
});

describe('license usage (peak concurrent sessions against the license)', () => {
  const HOUR = 3_600_000;
  const D0 = Date.parse('2026-11-16T00:00:00Z');
  const s = (startH: number, hours: number, licenseType = 'Dedicated Devices', sessionType = 'Mobile execution', project = 'Alpha'): LicenseSession =>
    ({ start: D0 + startH * HOUR, end: D0 + (startH + hours) * HOUR, sessionType, licenseType, project });
  type Table = Extract<Section['blocks'][number], { type: 'table' }>;

  it('counts the most sessions open at once; a session that ends when another starts does not overlap it', () => {
    assert.deepEqual(peakConcurrency([s(0, 1), s(1, 1)]), { peak: 1, at: D0 });
    assert.deepEqual(peakConcurrency([s(0, 2), s(1, 2), s(1.5, 1)]), { peak: 3, at: D0 + 1.5 * HOUR });
    assert.deepEqual(peakConcurrency([]), { peak: 0, at: null });
    assert.deepEqual(peakConcurrency([{ start: 5, end: 5 }]), { peak: 0, at: null }, 'a session with no length holds no license');
  });

  it('peaks per license type against the licensed number, per day, by session type, hour and project', () => {
    const sessions = [
      s(10, 2), s(10.5, 2), s(11, 2), s(11.5, 1),                       // day 1: four at once at 11:30
      s(34, 1), s(34.5, 1),                                              // day 2: two at once
      s(10, 1, 'Browsers', 'Browsers', 'Beta'), s(12, 1, 'Browsers', 'Browsers', 'Beta'),
      s(40, 0.5, 'Dedicated Devices', 'Manual testing', 'Beta'),
    ];
    // Three days, the last one still running (as "today" is in a real report): it is drawn, and left out of "quietest full day".
    const r = buildLicenseUsage({ sessions, limits: { dedicatedDevices: 4, sharedDevices: 0, virtualDevices: 1000, browsers: 1000 }, from: D0, to: D0 + 3 * DAY - 1000, days: 3 });
    assert.deepEqual(r.highlights, [
      '9 sessions and 11.5 license hours in the last 3 days (UTC).',
      'Dedicated Devices: peak of 4 sessions at once of 4 licensed (100%), Nov. 16, 2026 at 11:00 UTC.',
      'Browsers: peak of 1 session at once of 1,000 licensed (under 1%), Nov. 16, 2026 at 10:00 UTC.',
      'By hours: Mobile execution 78%, Browsers 17%, Manual testing 4%.']);
    assert.deepEqual(r.spec.headline, { value: '4 of 4', label: 'Peak sessions at once, Dedicated Devices' });
    const peak = section(r.spec, /Peak Use Against the License/);
    assert.deepEqual(peak.blocks.filter((b) => b.type === 'meter').map((b) => [(b as { label: string }).label, (b as { value: number }).value, (b as { max: number }).max]), [['Dedicated Devices', 4, 4], ['Browsers', 1, 1000]]);
    assert.deepEqual((peak.blocks.at(-1) as Table).rows.map((x) => [x.type, x.sessions, x.hours, x.peak, x.limit, x.share]), [['Dedicated Devices', 7, 9.5, 4, 4, 100], ['Browsers', 2, 2, 1, 1000, 0]]);
    assert.match(String(peak.whatItMeans), /Dedicated Devices reached 100% of the licensed number: at that moment a further session had to wait or was refused\./);
    const days = section(r.spec, /Peak Sessions per Day/).blocks[0] as Extract<Section['blocks'][number], { type: 'line' }>;
    assert.deepEqual(days.categories, ['11/16', '11/17', '11/18']);
    assert.deepEqual(days.series.map((x) => [x.name, x.values]), [['Dedicated Devices', [4, 2, 0]], ['Browsers', [1, 0, 0]]]);
    assert.match(String(section(r.spec, /Peak Sessions per Day/).whatItMeans), /peaked at 4 on its busiest day and 2 on its quietest full day/);
    const hours = section(r.spec, /Busiest Hours of the Day/).blocks[0] as Extract<Section['blocks'][number], { type: 'bar' }>;
    assert.equal(hours.categories.length, 24);
    assert.equal(hours.series[0].values[10], 7, 'two device sessions, a browser session and the next day\'s two that start at 10:00 UTC');
    assert.match(String(section(r.spec, /Busiest Hours of the Day/).whatItMeans), /The busiest hour is 10:00 UTC\./);
    assert.deepEqual((section(r.spec, /By Project/).blocks[0] as Table).rows.map((x) => [x.project, x.sessions, x.hours, x.peak]), [['Alpha', 6, 9, 4], ['Beta', 3, 2.5, 1]]);
    assert.match(renderReport(r.spec), /<h1>License Usage<\/h1>/);
    const noLimits = buildLicenseUsage({ sessions, limits: null, from: D0, to: D0 + 2 * DAY - 1000, days: 2 });
    assert.match(noLimits.highlights[1], /^Dedicated Devices: peak of 4 sessions at once, Nov\. 16/);
    assert.match(String(section(noLimits.spec, /Peak Use Against the License/).whatItMeans), /The licensed numbers could not be read/);
    const empty = buildLicenseUsage({ sessions: [], limits: null, from: D0, to: D0 + DAY, days: 1 });
    assert.match(renderReport(empty.spec), /holds no session between/);
  });

  it('the tool reads the session report and the license record once each', async () => {
    const t = Date.now() - 2 * HOUR;
    const row = (start: number, mins: number, kind: string, license: string) => `${start},d,h,${start + mins * 60_000},d,h,0:${mins}:00,${mins / 60},7,ana,A,A,a@x.test,Alpha,${kind},${license},host,11,Pixel A,ser-a,Android,14,Pixel 8,Google,p`;
    const CSV = 'Session Start Timestamp,Session Start Date,Session Start Hour,Session End Timestamp,Session End Date,Session End Hour,Session Duration,Session Duration (in hours),User ID,Username,' +
      "User's first name,User's last name,User's email,Project,Session type,License type,Reservation Host,Device ID,Device Name,Device UDID,Device OS,Device OS Version,Device Model,Device Manufacturer,Product\n" +
      [row(t, 30, 'Mobile execution', 'Dedicated Devices'), row(t + 60_000, 30, 'Mobile execution', 'Dedicated Devices'), row(t, 6, 'Browsers', 'Browsers')].join('\n') + '\n';
    const api = await startStubApi((req) => {
      if (req.path === '/api/v2/license') return { dedicatedDevices: 10, sharedDevices: 0, virtualDevices: 5, browsers: 20 };
      if (req.path.startsWith('/api/v2/configuration/get-CSV-reports/0/0/') && decodeURIComponent(req.path).endsWith('License Usage')) return reply(200, CSV);
      return undefined;
    });
    const saved = { dir: process.env.MCP_REPORT_DIR, mode: process.env.MCP_DEPLOYMENT_MODE };
    process.env.MCP_DEPLOYMENT_MODE = 'docker';
    delete process.env.MCP_REPORT_DIR;
    const tools = await connectTools(registerReportTools);
    try {
      const r = await tools.call('create_license_usage_report', { days: 2 });
      assert.notEqual(r.res.isError, true, r.text);
      assert.match(r.text, /Report ready: license-usage-\d{8}-\d{4}/);
      assert.match(r.text, /3 sessions and 1\.1 license hours in the last 2 days \(UTC\)\./);
      assert.match(r.text, /Dedicated Devices: peak of 2 sessions at once of 10 licensed \(20%\)/);
      assert.match(r.text, /Browsers: peak of 1 session at once of 20 licensed \(5%\)/);
      const month = await tools.call('create_license_usage_report', { days: 30 });
      assert.notEqual(month.res.isError, true, 'a month is what people ask for');
      assert.match(month.text, /3 sessions and 1\.1 license hours in the last 30 days \(UTC\)\./);
      const long = await tools.call('create_report', { recipe: 'license-usage', days: 60 });
      assert.equal(long.res.isError, true);
      assert.match(long.text, /takes up to 31 days/);
      const one = await tools.call('create_report', { recipe: 'license-usage', projectName: 'Alpha' });
      assert.match(one.text, /license-usage covers every project/);
    } finally {
      await tools.close();
      await api.close();
      if (saved.dir === undefined) delete process.env.MCP_REPORT_DIR; else process.env.MCP_REPORT_DIR = saved.dir;
      if (saved.mode === undefined) delete process.env.MCP_DEPLOYMENT_MODE; else process.env.MCP_DEPLOYMENT_MODE = saved.mode;
    }
  });
});

describe('report wording (UAT 2026-11-25)', () => {
  const c = (passed: number, failed = 0) => ({ passed, failed, error: 0, incomplete: 0, skipped: 0, healed: 0, total: passed + failed });

  it('failure analysis: the no-device bucket is web or no-device runs, never "a device problem"', () => {
    const fails = [
      ...Array.from({ length: 9 }, () => run(1, 'Failed', 'Web checkout', { cause: 'Timeout', serial: null, deviceName: null })),
      run(0, 'Failed', 'Login', { deviceName: 'Pixel 8', serial: 'P' }), run(0, 'Failed', 'Login', { deviceName: 'Galaxy S24', serial: 'G' }),
      run(2, 'Failed', 'Login', { deviceName: 'iPhone 15', serial: 'I' }),
    ];
    const r = buildFailureAnalysis({ failures: fails, totalRuns: 40, from: T0, to: T0 + 2 * DAY, days: 3 });
    const means = String(section(r.spec, /Failures by Device$/).whatItMeans);
    assert.match(means, /^Most failures \(9 failures, 75%\) were in runs without a device: web \(browser\) tests, or runs that ended before a device was assigned\. Look at those tests and their causes, not at the devices\./);
    assert.doesNotMatch(means, /device problem/);
    assert.match(r.highlights.join(' '), /75% of failures were in runs without a device/);
  });

  it('failure analysis: causes that differ only in a session id are one row, quoted from their informative part', () => {
    const sid = (t: string) => `Could not start appium test. The test request with the provided session id: CLOUD-SID:2026-11-23_${t}-x timed out`;
    const wrapped = "Cannot start the 'com.example.app' application. Consider checking the driver's troubleshooting documentation. Original error: INSTALL_FAILED_VERSION_DOWNGRADE on this device";
    const fails = [
      run(0, 'Error', 'A', { deviceName: 'P', serial: 'P', cause: sid('15-01-46') }), run(1, 'Error', 'B', { deviceName: 'P', serial: 'P', cause: sid('14-59-45') }),
      run(1, 'Error', 'C', { deviceName: 'P', serial: 'P', cause: sid('09-00-01') }),
      run(2, 'Failed', 'D', { deviceName: 'P', serial: 'P', cause: wrapped }),
    ];
    const r = buildFailureAnalysis({ failures: fails, totalRuns: 10, from: T0, to: T0 + 2 * DAY, days: 3 });
    const rows = (section(r.spec, /Most Common Causes/).blocks[0] as Extract<Section['blocks'][number], { type: 'table' }>).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].n, 3);
    assert.equal(rows[1].cause, 'INSTALL_FAILED_VERSION_DOWNGRADE on this device');
  });

  it('device health: the KPI counts devices, not tests; "1 day", not "1 days"', () => {
    const dev = (name: string, status: string, age: number | null = null): DeviceRow => ({ name, serial: name, os: 'Android', model: 'M', status, statusAgeMin: age, region: 'US', agent: 'a' });
    const r = buildDeviceHealth({ devices: [dev('A', 'Available'), dev('B', 'Offline', 1500)], deviceCounts: [], failures: [], days: 7, now: T0 });
    const kpis = allSections(r.spec)[0].blocks[0] as Extract<Section['blocks'][number], { type: 'kpis' }>;
    assert.ok(kpis.items.some((k) => k.label === 'Devices failing far more often (last 7 days)'));
    assert.ok(!kpis.items.some((k) => /Failing tests/.test(k.label)));
    const table = section(r.spec, /Offline or in Error for More Than a Day/).blocks[0] as Extract<Section['blocks'][number], { type: 'table' }>;
    assert.equal(table.rows[0].age, '1 day');
  });

  it('test summary over one day: no "lowest day" and no "1 of 1 days"', () => {
    const runs = [...Array.from({ length: 9 }, () => run(0, 'Passed')), run(0, 'Failed')];
    const r = buildTestSummary({ runs, previous: null, failures: [], platforms: null, devicesUsed: null, from: T0, to: T0 + DAY - 1, days: 1, passRateGoal: 85 });
    const text = JSON.stringify(r.spec);
    assert.doesNotMatch(text, /lowest day|1 of 1 day/);
    assert.match(text, /That meets the 85% goal\./);
  });

  it('test names: a trailing device serial is an id, and no separator is left at the end', () => {
    assert.equal(testFamily('ResRel_Shared_Android_03R1KL'), 'ResRel_Shared_Android');
    assert.equal(testFamily('ResRel_Shared_iOS_98401C'), 'ResRel_Shared_iOS');
    assert.equal(testFamily('Container report - 2026-11-25'), 'Container report');
    assert.equal(testFamily('Checkout_Smoke'), 'Checkout_Smoke', 'a word is not an id');
    assert.equal(testFamily('Login_v2'), 'Login_v2');
    const rel = buildTestReliability({ current: [{ values: ['ResRel_Shared_Android_03R1KL'], counts: c(1) }, { values: ['ResRel_Shared_Android_048DGP'], counts: c(1) },
      { values: ['ResRel_Shared_Android_0A1B2C'], counts: c(1) }], previous: null, from: T0 - 6 * DAY, to: T0, days: 7 });
    assert.match(rel.highlights[0], /^1 test ran in the last 7 days/);
  });
});
