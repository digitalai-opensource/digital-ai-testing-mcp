import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { getAllTestViews, listTestViews } from './helpers/test-client.js';

describe('Test Views API', () => {
  it('GET /reporter/api/testView — returns array', async () => {
    const views = await getAllTestViews();
    assert.ok(Array.isArray(views), 'Response should be an array');
  });

  it('GET /reporter/api/testView — each view has id, name, byKey, createdBy', async () => {
    const views = await getAllTestViews();
    for (const v of views.slice(0, 5)) {
      assert.ok(typeof v.id === 'number', 'id should be a number');
      assert.ok(typeof v.name === 'string', 'name should be a string');
      assert.ok(typeof v.byKey === 'string', 'byKey should be a string');
      assert.ok(typeof v.createdBy === 'string', 'createdBy should be a string');
      assert.ok(typeof v.showInDashboard === 'boolean', 'showInDashboard should be a boolean');
    }
  });

  it('POST /reporter/api/testView/list — returns object with count and data', async () => {
    const result = await listTestViews({ limit: 10, page: 1 });
    assert.ok(typeof result === 'object' && result !== null, 'Response should be an object');
    assert.ok(Array.isArray(result.data), 'result.data should be an array');
    assert.ok(typeof result.count === 'number', 'result.count should be a number');
  });

  it('POST /reporter/api/testView/list — pagination limit is respected', async () => {
    const result = await listTestViews({ limit: 2, page: 1 });
    assert.ok(result.data.length <= 2, 'Should return no more than the requested limit');
  });
});
