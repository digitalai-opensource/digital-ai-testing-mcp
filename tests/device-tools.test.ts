/**
 * Device tool handlers against a stub API (tests/api/devices.test.ts covers the live API itself).
 * Regression target — debug-mode intake 2026-10-16 (3 notes, 2 sessions, 13 wasted calls): idle emulator/simulator
 * templates are not devices, so list_devices returned 0 and agents guessed template names from test history.
 *  - list_virtual_device_templates reads /api/v2/virtual-devices/load and normalises both record schemas seen live
 *    (imageName on one platform version; only a "ModelKey[...]" name on another)
 *  - each template carries a usable deviceQuery (contains(@name) when the name is known, else @model)
 *  - list_devices says why an @emulator='true' query found nothing
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { registerDeviceTools } from '../src/tools/device-tools.js';
import { normalizeVirtualDevice } from '../src/api/virtual-devices.js';
import { startStubApi, connectTools, accountInfo, type StubApi, type ToolClient } from './helpers/offline.js';

const TEMPLATES = [
  // Newer schema: exact template name
  { id: 1, imageName: 'iPhone 17-English', os: 'IOS', deviceModel: 'iPhone 17', osVersion: '27.0', category: 'PHONE', screenWidth: 1179, screenHeight: 2556, status: 'AVAILABLE' },
  // Older schema: only a ModelKey debug string
  { id: 2, name: 'ModelKey[osVersion=15, model=Samsung S25]', os: 'ANDROID', deviceModel: 'Samsung S25', osVersion: '15', category: 'PHONE', status: 'UNAVAILABLE' },
  { id: 3, name: 'ModelKey[osVersion=26.3.1, model=iPhone 17e]', os: 'IOS', deviceModel: 'iPhone 17e', osVersion: '26.3.1', category: 'PHONE', status: 'AVAILABLE' },
];

// A full page that comes back identical for every `skip`, with no totalCount — the worst case for the paging loop.
const FULL_PAGE = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, name: 'ModelKey[x]', os: 'ANDROID', deviceModel: `M${i}` }));
let ignoreSkip = false;
let devicesFixture: unknown[] = [];

let api: StubApi;
let tools: ToolClient;

beforeAll(async () => {
  api = await startStubApi((req) => {
    if (req.path === '/api/v1/users/my-account-info') return accountInfo('User', 'Default');
    if (req.path === '/api/v2/virtual-devices/load') {
      if (ignoreSkip) return { data: FULL_PAGE };
      const q = JSON.parse(req.query.get('jsonQuery') ?? '{}');
      return { data: TEMPLATES.slice(q.skip, q.skip + q.take), totalCount: TEMPLATES.length };
    }
    if (req.path === '/api/v1/devices') return { status: 'SUCCESS', data: devicesFixture, code: 'OK' };
    return undefined;
  });
  tools = await connectTools(registerDeviceTools);
});
afterAll(async () => { await tools.close(); await api.close(); });

describe('list_virtual_device_templates', () => {
  it('normalises both schemas and builds a deviceQuery for each', async () => {
    const j = await tools.callJson('list_virtual_device_templates', {});
    const t = j.templates as Array<Record<string, unknown>>;
    assert.equal(t.length, 3);
    const named = t.find((x) => x.id === 1)!;
    assert.equal(named.templateName, 'iPhone 17-English');
    assert.equal(named.os, 'iOS');
    assert.equal(named.screen, '1179x2556');
    assert.equal(named.deviceQuery, "@os='ios' and @emulator='true' and contains(@name,'iPhone 17-English')");
    const modelKey = t.find((x) => x.id === 2)!;
    assert.equal(modelKey.templateName, null, 'a ModelKey[...] string is not a template name');
    assert.equal(modelKey.deviceQuery, "@os='android' and @emulator='true' and @model='Samsung S25'");
  });

  it('sends no server-side sort or selector (the field names differ between platform versions)', async () => {
    await tools.callJson('list_virtual_device_templates', {});
    const q = JSON.parse(api.requests.filter((r) => r.path === '/api/v2/virtual-devices/load').at(-1)!.query.get('jsonQuery')!);
    assert.equal('sort' in q, false);
    assert.equal('select' in q, false);
  });

  it('filters by os, status and nameContains client-side', async () => {
    const ios = await tools.callJson('list_virtual_device_templates', { os: 'iOS', status: 'AVAILABLE' });
    assert.deepEqual((ios.templates as Array<{ id: number }>).map((x) => x.id).sort(), [1, 3]);
    const byName = await tools.callJson('list_virtual_device_templates', { nameContains: 'english' });
    assert.deepEqual((byName.templates as Array<{ id: number }>).map((x) => x.id), [1]);
    const byModel = await tools.callJson('list_virtual_device_templates', { nameContains: 's25' });
    assert.deepEqual((byModel.templates as Array<{ id: number }>).map((x) => x.id), [2]);
  });

  it('normalizeVirtualDevice keeps a real name when imageName is absent, and escapes apostrophes in the query', () => {
    assert.equal(normalizeVirtualDevice({ id: 9, name: 'Pixel 9-French', os: 'ANDROID', deviceModel: 'Pixel 9' }).templateName, 'Pixel 9-French');
    const quoted = normalizeVirtualDevice({ id: 10, imageName: "Joe's Pixel", os: 'ANDROID', deviceModel: "O'Brien 9" });
    assert.equal(quoted.deviceQuery, "@os='android' and @emulator='true' and contains(@name,'Joe\\'s Pixel')");
    assert.equal(normalizeVirtualDevice({ id: 11, name: 'ModelKey[x]', os: 'IOS', deviceModel: "O'Brien 9" }).deviceQuery, "@os='ios' and @emulator='true' and @model='O\\'Brien 9'");
  });

  it('stops paging when a page brings no new ids (a platform that ignores skip)', async () => {
    ignoreSkip = true;
    api.requests.length = 0;
    try {
      const j = await tools.callJson('list_virtual_device_templates', { maxResults: 500 });
      assert.equal(j.total, 500, 'the 500 rows are returned once, not MAX_PAGES times');
      assert.equal(api.requests.filter((r) => r.path === '/api/v2/virtual-devices/load').length, 2, 'one page, one duplicate page, then stop');
    } finally {
      ignoreSkip = false;
    }
  });
});

describe('list_devices with an emulator query', () => {
  it('explains that idle templates are not devices when nothing is found', async () => {
    const j = await tools.callJson('list_devices', { query: "@os='android' and @emulator='true'" });
    assert.match(String(j.note), /list_virtual_device_templates/);
    const plain = await tools.callJson('list_devices', { query: "@os='android'" });
    assert.equal('note' in plain, false);
  });
});

describe('find_available_device skips devices marked do-not-use (intake 2026-10-19)', () => {
  afterAll(() => { devicesFixture = []; });

  it('passes over a tagged device and a device whose name says so, and reports how many were skipped', async () => {
    devicesFixture = [{ id: 1, deviceName: 'iPad A', deviceOs: 'iOS', osVersion: '17.0', manufacturer: 'Apple', model: 'iPhone', modelName: 'iPhone', tags: ['Team_X', 'DoNotTake'], displayStatus: 'Available', region: 'US1', agentName: 'a', bluetooth: null }, { id: 2, deviceName: 'iPhone DO NOT USE', deviceOs: 'iOS', osVersion: '17.0', manufacturer: 'Apple', model: 'iPhone', modelName: 'iPhone', tags: [], displayStatus: 'Available', region: 'US1', agentName: 'a', bluetooth: null }, { id: 3, deviceName: 'iPhone C', deviceOs: 'iOS', osVersion: '17.0', manufacturer: 'Apple', model: 'iPhone', modelName: 'iPhone', tags: ['POC'], displayStatus: 'Available', region: 'US1', agentName: 'a', bluetooth: null }];
    const j = await tools.callJson('find_available_device', { os: 'iOS', preferRegions: [] });
    assert.equal((j.device as { id: number }).id, 3);
    assert.equal(j.skippedDoNotUse, 2);
  });

  it('falls back to a do-not-use device only when nothing else is free, with a warning', async () => {
    devicesFixture = [{ id: 1, deviceName: 'iPhone A', deviceOs: 'iOS', osVersion: '17.0', manufacturer: 'Apple', model: 'iPhone', modelName: 'iPhone', tags: ['DONTTAKE'], displayStatus: 'Available', region: 'US1', agentName: 'a', bluetooth: null }];
    const j = await tools.callJson('find_available_device', { os: 'iOS', preferRegions: [] });
    assert.equal((j.device as { id: number }).id, 1);
    assert.match(String(j.doNotUseWarning), /set aside by another team/);
  });

  it('includeDoNotUse: true considers them like any other device', async () => {
    devicesFixture = [{ id: 1, deviceName: 'iPad A', deviceOs: 'iOS', osVersion: '17.0', manufacturer: 'Apple', model: 'iPhone', modelName: 'iPhone', tags: ['DoNotTake'], displayStatus: 'Available', region: 'US1', agentName: 'a', bluetooth: null }, { id: 3, deviceName: 'iPhone C', deviceOs: 'iOS', osVersion: '17.0', manufacturer: 'Apple', model: 'iPhone', modelName: 'iPhone', tags: [], displayStatus: 'Available', region: 'US1', agentName: 'a', bluetooth: null }];
    const j = await tools.callJson('find_available_device', { os: 'iOS', preferRegions: [], includeDoNotUse: true });
    assert.equal((j.device as { id: number }).id, 1);
    assert.equal(j.skippedDoNotUse, undefined);
  });
});
