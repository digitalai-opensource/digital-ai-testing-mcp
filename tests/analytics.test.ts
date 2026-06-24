import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { listTests, getGroupedTests } from './helpers/test-client.js';

// Tests for the analytics tools' underlying API operations.
// The tools themselves (get_test_stability_report, get_cross_platform_divergence,
// get_daily_execution_trend) are thin wrappers over these API functions.

describe('Analytics — test stability foundations', () => {
  it('listTests with name contains filter returns matching records', async () => {
    // Get any test name to search for
    const seed = await listTests({ limit: 1, page: 1, returnTotalCount: false });
    if (!seed.data || seed.data.length === 0) return;
    const testName = seed.data[0].name.slice(0, 10); // first 10 chars as substring

    const result = await listTests({
      limit: 10, page: 1,
      filter: [{ property: 'name', operator: 'contains', value: testName }],
      sort: [{ property: 'start_time', descending: true }],
    });
    assert.ok(Array.isArray(result.data), 'data should be an array');
    for (const r of result.data) {
      assert.ok(
        r.name.toLowerCase().includes(testName.toLowerCase()),
        `Expected name to contain "${testName}" but got "${r.name}"`
      );
    }
  });

  it('listTests sorted descending by start_time is ordered newest-first', async () => {
    const result = await listTests({
      limit: 10, page: 1, returnTotalCount: false,
      sort: [{ property: 'start_time', descending: true }],
    });
    if (!result.data || result.data.length < 2) return;
    const times = result.data.map(r => new Date(r.start_time).getTime());
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i - 1] >= times[i], `Result ${i - 1} should be newer than result ${i}`);
    }
  });

  it('listTests returns records with parseable start_time dates', async () => {
    const result = await listTests({ limit: 5, page: 1 });
    if (!result.data) return;
    for (const r of result.data) {
      const ts = new Date(r.start_time).getTime();
      assert.ok(!isNaN(ts), `start_time "${r.start_time}" should be a valid date`);
    }
  });
});

describe('Analytics — cross-platform divergence foundations', () => {
  it('getGroupedTests with groupBy device.os returns OS-level rows', async () => {
    const result = await getGroupedTests({
      groupBy: ['device.os'],
      pivotBy: ['status'],
      returnTotalCount: false,
    }) as { data?: Array<Record<string, unknown>> };
    const rows = result?.data ?? (Array.isArray(result) ? result : []);
    assert.ok(Array.isArray(rows), 'grouped result should contain an array');
    // Each row should have a device.os field
    for (const row of rows) {
      assert.ok('device.os' in row || row['device.os'] !== undefined || row['device.os'] === null,
        'Each row should have a device.os field');
    }
  });

  it('getGroupedTests with groupBy ["name","device.os"] returns multi-field rows', async () => {
    const result = await getGroupedTests({
      groupBy: ['name', 'device.os'],
      pivotBy: ['status'],
      returnTotalCount: false,
    }) as { count: null; data?: Array<Record<string, unknown>> };
    const rows = result?.data ?? (Array.isArray(result) ? result : []);
    assert.ok(Array.isArray(rows), 'multi-field grouped result should be an array');
    if (rows.length > 0) {
      const first = rows[0];
      assert.ok('name' in first, 'Row should have a name field');
    }
  });

  it('getGroupedTests pivotBy status rows have passedCount and failedCount fields', async () => {
    const result = await getGroupedTests({
      groupBy: ['device.os'],
      pivotBy: ['status'],
      returnTotalCount: false,
    }) as { data?: Array<Record<string, unknown>> };
    const rows = result?.data ?? (Array.isArray(result) ? result : []);
    for (const row of rows.slice(0, 3)) {
      assert.ok('passedCount' in row, 'Row should have passedCount');
      assert.ok('failedCount' in row, 'Row should have failedCount');
      assert.ok('_count_' in row, 'Row should have _count_');
      assert.ok(typeof row['_count_'] === 'number', '_count_ should be a number');
    }
  });
});

describe('Analytics — daily trend foundations', () => {
  it('listTests returns records with ISO 8601 start_time for bucketing', async () => {
    const result = await listTests({
      limit: 20, page: 1,
      sort: [{ property: 'start_time', descending: true }],
    });
    if (!result.data || result.data.length === 0) return;
    for (const r of result.data) {
      const d = new Date(r.start_time);
      assert.ok(!isNaN(d.getTime()), `start_time "${r.start_time}" must be valid ISO 8601`);
      const dateStr = d.toISOString().slice(0, 10);
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(dateStr), `Date bucket "${dateStr}" should be YYYY-MM-DD`);
    }
  });

  it('listTests status field is one of the expected values', async () => {
    const VALID = new Set(['Passed', 'Failed', 'Incomplete', 'Skipped', 'Error', 'Healed']);
    const result = await listTests({ limit: 20, page: 1 });
    if (!result.data) return;
    for (const r of result.data) {
      assert.ok(VALID.has(r.status), `Unexpected status value: "${r.status}"`);
    }
  });
});
