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
import { normalizeVirtualDevice, disambiguateByVersion } from '../src/api/virtual-devices.js';
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
let runningFixture: unknown[] | 'fail' = [];

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
    if (req.path === '/api/v2/test-requests/running') return runningFixture === 'fail' ? { other: true } : { runningTestRequests: runningFixture };
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

  it('templates that share a model get @version; a unique one is unchanged (verified live 2026-11-13)', () => {
    const t = [
      normalizeVirtualDevice({ id: 1, name: 'ModelKey[a]', os: 'ANDROID', deviceModel: 'pixel_4', osVersion: '13' }),
      normalizeVirtualDevice({ id: 2, name: 'ModelKey[b]', os: 'ANDROID', deviceModel: 'pixel_4', osVersion: '12' }),
      normalizeVirtualDevice({ id: 3, name: 'ModelKey[c]', os: 'ANDROID', deviceModel: 'pixel_7', osVersion: '14' }),
    ];
    const out = disambiguateByVersion(t);
    assert.equal(out[0].deviceQuery, "@os='android' and @emulator='true' and @model='pixel_4' and @version='13'");
    assert.equal(out[1].deviceQuery, "@os='android' and @emulator='true' and @model='pixel_4' and @version='12'");
    assert.equal(out[2].deviceQuery, "@os='android' and @emulator='true' and @model='pixel_7'");
    assert.ok(out.every((x) => !x.ambiguousQuery), 'every query is unique — nothing flagged');
  });

  it('flags a query that still matches another template (no osVersion, or same model + version)', () => {
    const t = [
      normalizeVirtualDevice({ id: 1, name: 'ModelKey[a]', os: 'ANDROID', deviceModel: 'pixel_4', osVersion: '13' }),
      normalizeVirtualDevice({ id: 2, name: 'ModelKey[b]', os: 'ANDROID', deviceModel: 'pixel_4' }),
      normalizeVirtualDevice({ id: 3, name: 'ModelKey[c]', os: 'ANDROID', deviceModel: 'pixel_6', osVersion: '14' }),
      normalizeVirtualDevice({ id: 4, name: 'ModelKey[d]', os: 'ANDROID', deviceModel: 'pixel_6', osVersion: '14' }),
    ];
    const out = disambiguateByVersion(t);
    assert.equal(out[0].ambiguousQuery, undefined, 'the versioned pixel_4 query is unique');
    assert.equal(out[1].ambiguousQuery, true);
    assert.match(out[1].queryNote!, /No OS version/);
    assert.equal(out[1].deviceQuery, "@os='android' and @emulator='true' and @model='pixel_4'");
    assert.equal(out[2].ambiguousQuery, true);
    assert.equal(out[3].ambiguousQuery, true);
    assert.match(out[2].queryNote!, /same model and OS version/);
  });

  it('flags a template whose name is a substring of another template name on the same OS (contains(@name) matches both)', () => {
    const out = disambiguateByVersion([
      normalizeVirtualDevice({ id: 1, imageName: 'iPhone 15', os: 'IOS', deviceModel: 'iPhone 15', osVersion: '17' }),
      normalizeVirtualDevice({ id: 2, imageName: 'iPhone 15 Pro', os: 'IOS', deviceModel: 'iPhone 15 Pro', osVersion: '17' }),
      normalizeVirtualDevice({ id: 3, imageName: 'iPhone 15', os: 'ANDROID', deviceModel: 'x', osVersion: '14' }),
    ]);
    assert.equal(out[0].ambiguousQuery, true);
    assert.match(out[0].queryNote!, /"iPhone 15 Pro"/);
    assert.equal(out[1].ambiguousQuery, undefined, 'the longer name is matched only by its own query');
    assert.equal(out[2].ambiguousQuery, undefined, 'another OS is a different query');
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

  it('an OCCUPIED tag is a do-not-use mark too (UAT 2026-11-13)', async () => {
    devicesFixture = [{ id: 1, deviceName: 'Galaxy A', deviceOs: 'Android', osVersion: '9.0', manufacturer: 'Samsung', model: 'A8', modelName: 'A8', tags: ['OCCUPIED', 'INTERNAL_TESTING'], displayStatus: 'Available', region: 'US1', agentName: 'a', bluetooth: null }, { id: 2, deviceName: 'Galaxy B', deviceOs: 'Android', osVersion: '12.0', manufacturer: 'Samsung', model: 'S20', modelName: 'S20', tags: [], displayStatus: 'Available', region: 'US1', agentName: 'a', bluetooth: null }];
    const j = await tools.callJson('find_available_device', { os: 'Android', preferRegions: [] });
    assert.equal((j.device as { id: number }).id, 2);
    assert.equal(j.skippedDoNotUse, 1);
  });

  it('includeDoNotUse: true considers them like any other device', async () => {
    devicesFixture = [{ id: 1, deviceName: 'iPad A', deviceOs: 'iOS', osVersion: '17.0', manufacturer: 'Apple', model: 'iPhone', modelName: 'iPhone', tags: ['DoNotTake'], displayStatus: 'Available', region: 'US1', agentName: 'a', bluetooth: null }, { id: 3, deviceName: 'iPhone C', deviceOs: 'iOS', osVersion: '17.0', manufacturer: 'Apple', model: 'iPhone', modelName: 'iPhone', tags: [], displayStatus: 'Available', region: 'US1', agentName: 'a', bluetooth: null }];
    const j = await tools.callJson('find_available_device', { os: 'iOS', preferRegions: [], includeDoNotUse: true });
    assert.equal((j.device as { id: number }).id, 1);
    assert.equal(j.skippedDoNotUse, undefined);
  });
});

describe('release_orphaned_sessions — a device running a test is busy, not orphaned (UAT 2026-11-13)', () => {
  afterAll(() => { devicesFixture = []; runningFixture = []; });
  const LONG = (id: string, name: string) => ({ id, deviceName: name, deviceOs: 'Android', osVersion: '13.0', displayStatus: 'In Use', statusAgeInMinutes: '3090', currentUser: 'ci', agentName: 'a', agentIp: '1', tags: [] });

  it('lists a long-"In Use" device with a running test as busy and never offers it for release', async () => {
    devicesFixture = [LONG('1', 'Vivo CI'), LONG('2', 'Pixel Forgotten')];
    runningFixture = [{ id: 7, name: 'ci test', status: 'RUNNING', deviceName: 'Vivo CI', startedAt: Date.now() - 120_000 }];
    const r = await tools.call('release_orphaned_sessions', { maxAgeHours: 4 });
    assert.match(r.text, /Devices that would be released:\n {2}• Pixel Forgotten/);
    assert.match(r.text, /Busy, NOT orphaned[\s\S]*Vivo CI/);
    assert.doesNotMatch(r.text.split('Busy, NOT orphaned')[0], /Vivo CI/);
  });

  it('matches by device ID: of two devices with the same name, only the one running a test is busy (review 2026-11-13)', async () => {
    devicesFixture = [{ ...LONG('11', 'Galaxy S22'), udid: 'UDID-11' }, { ...LONG('12', 'Galaxy S22'), udid: 'UDID-12' }];
    // Live record shape: deviceId is the device record's id, deviceUid its serial (verified 2026-11-13).
    runningFixture = [{ id: 8, name: 'ci', status: 'RUNNING', deviceName: 'Galaxy S22', deviceId: 11, deviceUid: 'UDID-11', startedAt: Date.now() - 60_000 }];
    const j = await tools.callJson('release_orphaned_sessions', { maxAgeHours: 4, confirmDeletion: true });
    assert.deepEqual((j.busy as Array<{ id: string }>).map((b) => b.id), ['11']);
    assert.deepEqual((j.results as Array<{ id: string }>).map((x) => x.id), ['12'], 'only the real orphan is released');
  });

  it('falls back to the serial when a running record has no deviceId', async () => {
    devicesFixture = [{ ...LONG('21', 'Pixel A'), udid: 'SER-21' }, { ...LONG('22', 'Pixel B'), udid: 'SER-22' }];
    runningFixture = [{ id: 9, name: 'ci', status: 'RUNNING', deviceName: 'renamed', deviceUid: 'SER-22', startedAt: Date.now() }];
    const r = await tools.call('release_orphaned_sessions', { maxAgeHours: 4 });
    assert.match(r.text, /Devices that would be released:\n {2}• Pixel A/);
    assert.match(r.text, /Busy, NOT orphaned[\s\S]*Pixel B/);
  });

  it('warns when the running-test list cannot be read, and still previews', async () => {
    devicesFixture = [LONG('2', 'Pixel Forgotten')];
    runningFixture = 'fail';
    const r = await tools.call('release_orphaned_sessions', { maxAgeHours: 4 });
    assert.match(r.text, /Pixel Forgotten/);
    assert.match(r.text, /Could not read the running-test list/);
  });
});

describe('get_device_health_summary — the status buckets add up to the total (UAT 2026-11-13)', () => {
  afterAll(() => { devicesFixture = []; });
  it('counts In Use and other statuses (Error, Unauthorized) explicitly', async () => {
    const d = (id: string, status: string) => ({ id, deviceName: `D${id}`, deviceOs: 'Android', osVersion: '13.0', displayStatus: status, statusAgeInMinutes: '5', agentName: 'a', agentIp: '1', tags: [] });
    devicesFixture = [d('1', 'Available'), d('2', 'Offline'), d('3', 'In Use'), d('4', 'Error'), d('5', 'Unauthorized'), d('6', 'Reserved')];
    const j = await tools.callJson('get_device_health_summary', {});
    assert.equal(j.available, 1); assert.equal(j.offline, 1); assert.equal(j.reserved, 1); assert.equal(j.inUse, 1); assert.equal(j.other, 2);
    assert.equal((j.available as number) + (j.offline as number) + (j.reserved as number) + (j.inUse as number) + (j.other as number), j.analyzed);
    assert.deepEqual(j.byStatus, { Available: 1, Offline: 1, 'In Use': 1, Error: 1, Unauthorized: 1, Reserved: 1 });
    const h = await tools.call('get_device_health_summary', { outputFormat: 'human' });
    assert.match(h.text, /In Use: +1/);
    assert.match(h.text, /Other: +2 \(error 1, unauthorized 1\)/);
  });
});
