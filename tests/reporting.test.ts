import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { listTests, getGroupedTests, getDistinctKeyValues, bucketFailures } from './helpers/test-client.js';
import type { TestReport } from '../src/types/digital-ai.js';

function fakeReport(id: number, name: string, fields: Partial<TestReport>): TestReport {
  return { test_id: id, name, ...fields } as unknown as TestReport;
}

describe('Reporting API', () => {
  it('POST /reporter/api/tests/list — returns object with data array', async () => {
    const result = await listTests({ limit: 10, page: 1, returnTotalCount: true });
    assert.ok(typeof result === 'object' && result !== null, 'Response should be an object');
    assert.ok(Array.isArray(result.data), 'result.data should be an array');
  });

  it('POST /reporter/api/tests/list — each report has uuid, name, status, duration', async () => {
    const result = await listTests({ limit: 5, page: 1 });
    for (const r of result.data.slice(0, 5)) {
      assert.ok(typeof r.uuid === 'string', 'uuid should be a string');
      assert.ok(typeof r.name === 'string', 'name should be a string');
      assert.ok(['Passed', 'Failed', 'Incomplete'].includes(r.status), `Unexpected status: ${r.status}`);
      assert.ok(typeof r.duration === 'number', 'duration should be a number');
    }
  });

  it('POST /reporter/api/tests/list — filter by status=Failed returns only failed tests', async () => {
    const result = await listTests({
      limit: 10,
      page: 1,
      filter: [{ property: 'status', operator: '=', value: 'Failed' }],
    });
    assert.ok(Array.isArray(result.data), 'result.data should be an array');
    for (const r of result.data) {
      assert.equal(r.status, 'Failed', `Expected Failed but got ${r.status}`);
    }
  });

  it('POST /reporter/api/tests/list — sort by start_time descending', async () => {
    const result = await listTests({
      limit: 5,
      page: 1,
      sort: [{ property: 'start_time', descending: true }],
    });
    assert.ok(Array.isArray(result.data), 'result.data should be an array');
    // Verify ordering if more than one result
    if (result.data.length > 1) {
      const times = result.data.map((r) => new Date(r.start_time).getTime());
      for (let i = 1; i < times.length; i++) {
        assert.ok(times[i - 1] >= times[i], 'Results should be in descending time order');
      }
    }
  });

  it('POST /reporter/api/tests/grouped — returns grouped result object', async () => {
    const result = await getGroupedTests({ pivotBy: ['status'], returnTotalCount: true });
    assert.ok(typeof result === 'object' && result !== null, 'Response should be an object');
  });

  it('POST /reporter/api/tests/distinct — returns distinct values for requested keys', async () => {
    const result = await getDistinctKeyValues(['status']);
    assert.ok(typeof result === 'object' && result !== null, 'Response should be an object');
  });
});

describe('bucketFailures (pure)', () => {
  const reports: TestReport[] = [
    fakeReport(1, 'Login A', { errorClassification: 'element_not_found', errorCategory: 'assertion' }),
    fakeReport(2, 'Login B', { errorClassification: 'element_not_found', errorCategory: 'assertion' }),
    fakeReport(3, 'Login C', { errorClassification: 'element_not_found', errorCategory: 'assertion' }),
    fakeReport(4, 'Checkout', { errorClassification: 'timeout', errorCategory: 'timeout' }),
    fakeReport(5, 'Search', {}), // no classification
  ];

  it('buckets by errorClassification, sorted by count descending', () => {
    const buckets = bucketFailures(reports, 'errorClassification');
    assert.equal(buckets[0].key, 'element_not_found');
    assert.equal(buckets[0].count, 3);
    assert.equal(buckets[1].key, 'timeout');
    assert.equal(buckets[1].count, 1);
  });

  it('collapses missing classification into a single "(unclassified)" bucket', () => {
    const buckets = bucketFailures(reports, 'errorClassification');
    const unclassified = buckets.find((b) => b.key === '(unclassified)');
    assert.ok(unclassified, 'expected an (unclassified) bucket');
    assert.equal(unclassified!.count, 1);
  });

  it('caps examples per bucket and records testId + name', () => {
    const buckets = bucketFailures(reports, 'errorClassification', 2);
    const top = buckets[0];
    assert.equal(top.examples.length, 2, 'examples capped at maxExamples');
    assert.deepEqual(top.examples[0], { testId: 1, name: 'Login A' });
  });

  it('groupBy "name" buckets each distinct name', () => {
    const buckets = bucketFailures(reports, 'name');
    assert.equal(buckets.length, 5, 'five distinct names → five buckets');
    assert.ok(buckets.every((b) => b.count === 1));
  });

  it('returns an empty array for no reports', () => {
    assert.deepEqual(bucketFailures([], 'errorClassification'), []);
  });
});
