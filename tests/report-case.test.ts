/**
 * Letter case in test report values (src/utils/report-case.ts): which equality filters are matched whatever their case,
 * how the request is widened and the answer narrowed back, and how groups that differ only in case become one.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { loosePlan, mergeGroupRows } from '../src/utils/report-case.js';
import { groupedAnswer } from './helpers/offline.js';

// As a tenant stores them: one browser in two spellings, and another browser whose name contains the first.
const RUNS = [
  { browserName: 'chrome', 'test.framework': 'Selenium', status: 'Passed', n: 12 },
  { browserName: 'Chrome', 'test.framework': 'Playwright', status: 'Passed', n: 8 },
  { browserName: 'Chrome', 'test.framework': 'Playwright', status: 'Failed', n: 1 },
  { browserName: 'Chrome Beta', 'test.framework': 'Selenium', status: 'Passed', n: 5 },
  { browserName: 'firefox', 'test.framework': 'Selenium', status: 'Failed', n: 3 },
];
const total = (rows: Array<Record<string, unknown>>) => rows.reduce((a, r) => a + (r._count_ as number), 0);

describe('an equality filter on text is matched whatever its letter case', () => {
  it('the platform itself matches one spelling with "=" and ignores case with "contains" (what the stub stands for)', () => {
    const eq = (value: string) => total(groupedAnswer(RUNS, { filter: [{ property: 'browserName', operator: '=', value }] }).data);
    assert.deepEqual([eq('chrome'), eq('Chrome'), eq('CHROME')], [12, 9, 0]);
    assert.equal(total(groupedAnswer(RUNS, { filter: [{ property: 'browserName', operator: 'contains', value: 'CHROME' }] }).data), 26, 'contains also finds Chrome Beta');
  });

  it('sends "contains" with the key grouped as well, and keeps only the groups whose value equals the wanted one', () => {
    const plan = loosePlan(['test.framework'], [{ property: 'browserName', operator: '=', value: 'CHROME' }])!;
    assert.deepEqual(plan.groupBy, ['test.framework', 'browserName']);
    assert.deepEqual(plan.filter, [{ property: 'browserName', operator: 'contains', value: 'chrome' }]);
    const kept = plan.apply(groupedAnswer(RUNS, { groupBy: plan.groupBy, filter: plan.filter }).data);
    assert.equal(total(kept.rows), 21, 'both spellings of the browser, without the browser that only contains its name');
    assert.deepEqual(kept.matched, { browserName: ['Chrome', 'chrome'] });
    assert.ok(kept.rows.every((r) => !('browserName' in r)), 'the key that was added to read the spelling is taken out again');
    assert.deepEqual(kept.rows.map((r) => r['test.framework']).sort(), ['Playwright', 'Selenium']);
  });

  it('a key that is already grouped is not added twice and stays in the rows', () => {
    const plan = loosePlan(['browserName'], [{ property: 'browserName', operator: '=', value: 'Chrome' }])!;
    assert.deepEqual(plan.groupBy, ['browserName']);
    const kept = plan.apply(groupedAnswer(RUNS, { groupBy: plan.groupBy, filter: plan.filter }).data);
    assert.deepEqual(kept.rows.map((r) => [r.browserName, r._count_]).sort(), [['Chrome', 9], ['chrome', 12]]);
  });

  it('leaves alone what has no case to ignore: numbers, dates, versions, id bounds, other operators', () => {
    assert.equal(loosePlan(['name'], [
      { property: 'test_id', operator: '>=', value: 1200 },
      { property: 'digitalai:build', operator: '=', value: '412' },
      { property: 'date', operator: '=', value: '2026-11-22' },
      { property: 'device.version', operator: '=', value: '17.6' },
      { property: 'name', operator: 'contains', value: 'Login' },
      { property: 'success', operator: '=', value: true },
      { property: 'status_code', operator: '=', value: 'x1' },
      { property: 'accessibility_report', operator: '=', value: 'true' },
    ]), null);
    assert.equal(loosePlan(['name'], undefined), null);
    // Only the text equality changes; the id bound keeps its number and its place.
    const plan = loosePlan(undefined, [{ property: 'test_id', operator: '>=', value: 1200 }, { property: 'device.os', operator: '=', value: 'Android' }])!;
    assert.deepEqual(plan.filter, [{ property: 'test_id', operator: '>=', value: 1200 }, { property: 'device.os', operator: 'contains', value: 'android' }]);
    assert.deepEqual(plan.groupBy, ['device.os']);
  });

  it('two filters must both hold, and a value nothing matches keeps no row', () => {
    const plan = loosePlan(undefined, [{ property: 'browserName', operator: '=', value: 'chrome' }, { property: 'test.framework', operator: '=', value: 'PLAYWRIGHT' }])!;
    const kept = plan.apply(groupedAnswer(RUNS, { groupBy: plan.groupBy, filter: plan.filter }).data);
    assert.equal(total(kept.rows), 9);
    assert.deepEqual(kept.matched, { browserName: ['Chrome'], 'test.framework': ['Playwright'] });
    const none = loosePlan(undefined, [{ property: 'browserName', operator: '=', value: 'Chrom' }])!;
    const nothing = none.apply(groupedAnswer(RUNS, { groupBy: none.groupBy, filter: none.filter }).data);
    assert.deepEqual([nothing.rows.length, nothing.matched.browserName], [0, []], 'part of a value is not the value');
  });
});

describe('groups that differ only in letter case are one group', () => {
  const rows = () => [
    { browserName: 'chrome', status: 'Passed', _count_: 12, passedCount: 12 },
    { browserName: 'Chrome', status: 'Passed', _count_: 8, passedCount: 8 },
    { browserName: 'Chrome', status: 'Failed', _count_: 1, failedCount: 1 },
    { browserName: null, status: 'Passed', _count_: 4, passedCount: 4 },
  ];

  it('sums the counts, shows the spelling most runs have, and says which spellings became one', () => {
    const m = mergeGroupRows(rows(), ['browserName', 'status'], true);
    assert.deepEqual(m.rows, [
      { browserName: 'chrome', status: 'Passed', _count_: 20, passedCount: 20 },
      { browserName: 'chrome', status: 'Failed', _count_: 1, failedCount: 1 },
      { browserName: null, status: 'Passed', _count_: 4, passedCount: 4 },
    ]);
    assert.deepEqual(m.merged, { browserName: [['Chrome', 'chrome']] });
    const byBrowser = mergeGroupRows(rows(), ['browserName'], true);
    assert.deepEqual(byBrowser.rows.map((r) => [r.browserName, r._count_, r.passedCount, r.failedCount]), [['chrome', 21, 20, 1], [null, 4, 4, undefined]]);
  });

  it('the platform is always Android / iOS, whichever spelling has more runs', () => {
    const m = mergeGroupRows([{ 'device.os': 'ANDROID', _count_: 90 }, { 'device.os': 'Android', _count_: 10 }, { 'device.os': 'IOS', _count_: 5 }, { 'device.os': null, _count_: 7 }], ['device.os'], true);
    assert.deepEqual(m.rows, [{ 'device.os': 'Android', _count_: 100 }, { 'device.os': 'iOS', _count_: 5 }, { 'device.os': null, _count_: 7 }]);
    assert.deepEqual(m.merged, { 'device.os': [['ANDROID', 'Android']] });
  });

  it('with the exact case every stored spelling keeps its own row; rows that agree exactly are still summed', () => {
    const m = mergeGroupRows([...rows(), { browserName: 'chrome', status: 'Passed', _count_: 3, passedCount: 3 }], ['browserName', 'status'], false);
    assert.deepEqual(m.rows.map((r) => [r.browserName, r.status, r._count_]), [['chrome', 'Passed', 15], ['Chrome', 'Passed', 8], ['Chrome', 'Failed', 1], [null, 'Passed', 4]]);
    assert.deepEqual(m.merged, {});
  });

  it('a field that names a thing (a project) is never folded: two projects whose names differ only in case stay two rows', () => {
    const rows = [{ project: 'QA', browserName: 'Chrome', _count_: 4 }, { project: 'qa', browserName: 'chrome', _count_: 6 }, { project: 'QA', browserName: 'chrome', _count_: 1 }];
    const m = mergeGroupRows(rows, ['project', 'browserName'], true, ['project']);
    assert.deepEqual(m.rows, [{ project: 'QA', browserName: 'chrome', _count_: 5 }, { project: 'qa', browserName: 'chrome', _count_: 6 }]);
    assert.deepEqual(m.merged, { browserName: [['Chrome', 'chrome']] });
  });

  it('an empty value and no value are one row; with the exact case they stay apart', () => {
    const rows = [{ browserName: '', _count_: 1759 }, { browserName: null, _count_: 1651 }, { browserName: 'chrome', _count_: 12 }];
    assert.deepEqual(mergeGroupRows(rows, ['browserName'], true).rows, [{ browserName: null, _count_: 3410 }, { browserName: 'chrome', _count_: 12 }]);
    assert.equal(mergeGroupRows(rows, ['browserName'], false).rows.length, 3);
  });

  it('with no grouping, the rows are one total', () => {
    assert.deepEqual(mergeGroupRows([{ _count_: 12, passedCount: 12 }, { _count_: 9, passedCount: 8, failedCount: 1 }], [], true).rows, [{ _count_: 21, passedCount: 20, failedCount: 1 }]);
  });
});
