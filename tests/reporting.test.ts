import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { listTests, getGroupedTests, getDistinctKeyValues } from './helpers/test-client.js';

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
