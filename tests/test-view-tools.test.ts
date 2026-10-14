/**
 * Test-view tool handlers against a stub reporter (tests/test-views.test.ts covers the live API itself).
 *  - get_test_view says "not found" instead of a bare 404
 *  - create/update/delete return structured output; the delete guard names the view
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { registerTestViewTools } from '../src/tools/test-view-tools.js';
import { startStubApi, connectTools, reply, type StubApi, type ToolClient } from './helpers/offline.js';

let api: StubApi;
let tools: ToolClient;

beforeAll(async () => {
  api = await startStubApi((req) => {
    if (req.path === '/reporter/api/testView/205') return reply(404, {});
    if (req.path === '/reporter/api/testView/7' && req.method === 'GET') return { id: 7, name: 'Android by model', byKey: 'device.os', createdBy: 'u' };
    if (req.path === '/reporter/api/testView' && req.method === 'POST') return { id: 88, name: req.json.name, byKey: req.json.byKey, createdBy: 'u' };
    if (req.path === '/reporter/api/testView/7' && req.method === 'DELETE') return {};
    return undefined;
  });
  tools = await connectTools(registerTestViewTools);
});
afterAll(async () => { await tools.close(); await api.close(); });

describe('get_test_view', () => {
  it('says the view was not found', async () => {
    const { res, text } = await tools.call('get_test_view', { id: 205 });
    assert.equal(res.isError, true);
    assert.match(text, /Test view 205 not found — it may have been deleted/);
  });
});

describe('create_test_view / delete_test_view', () => {
  it('create returns structured output with the id; the delete guard and result name the view', async () => {
    const created = await tools.callJson('create_test_view', { name: 'By OS', byKey: 'device.os' });
    assert.deepEqual({ created: created.created, id: created.id }, { created: true, id: 88 });
    const guard = await tools.call('delete_test_view', { id: 7 });
    assert.notEqual(guard.res.isError, true);
    assert.match(guard.text, /test view "Android by model" \(ID 7\)/);
    const done = await tools.callJson('delete_test_view', { id: 7, confirmDeletion: true });
    assert.deepEqual(done, { deleted: true, id: 7, name: 'Android by model' });
  });
});
