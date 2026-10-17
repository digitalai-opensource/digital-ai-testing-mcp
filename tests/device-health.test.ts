/**
 * find_unhealthy_devices — the pure analysis (src/utils/device-health.ts) and the handler against a stub API.
 * Source of the idea: dai-continuous-testing/ddm_concept (repo scan 2026-10-16). Verified live the same day: 622 runs in
 * 72 h analysed in ~6 s; the reporter's device.serialNumber equals the device record's udid; tagging applied and removed;
 * the platform rejects tags with characters other than letters, digits and underscores.
 */
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { analyzeDeviceHealth, type RunRecord } from '../src/utils/device-health.js';
import { registerHealthTools } from '../src/tools/health-tools.js';
import { startStubApi, connectTools, accountInfo, type StubApi, type ToolClient } from './helpers/offline.js';

const NOW = Date.now();
const run = (serial: string | null, name: string, status: string, minutesAgo: number, extra: Partial<RunRecord> = {}): RunRecord => ({
  serial, name, status, start_time: new Date(NOW - minutesAgo * 60_000).toISOString(),
  deviceName: serial ? `Device ${serial}` : null, deviceOs: 'Android', cause: null, errorCategory: null, ...extra,
});

describe('analyzeDeviceHealth', () => {
  const records = [
    // BAD: fails login (which passes on GOOD) three times, once on infrastructure
    run('BAD', 'login', 'Failed', 1, { cause: 'no such element', errorCategory: 'assertion' }),
    run('BAD', 'login', 'Failed', 2, { cause: 'no such element', errorCategory: 'assertion' }),
    run('BAD', 'checkout', 'Error', 3, { cause: 'Could not find a connected Android device', errorCategory: 'device' }),
    run('BAD', 'search', 'Passed', 4),
    run('GOOD', 'login', 'Passed', 5),
    run('GOOD', 'checkout', 'Passed', 6),
    run('GOOD', 'search', 'Failed', 7, { cause: 'timeout', errorCategory: 'script' }),
    run('FEW', 'login', 'Failed', 8, { errorCategory: 'assertion' }),
    run(null, 'web smoke', 'Failed', 9),
  ];
  const { devices, baselineFailRatio, runsWithoutDevice } = analyzeDeviceHealth(records, { minRuns: 3, failRatioThreshold: 0.5 });
  const bad = devices.find((d) => d.serial === 'BAD')!;

  it('computes ratio, infrastructure share, categories and top causes per device', () => {
    assert.equal(bad.runs, 4);
    assert.equal(bad.failures, 3);
    assert.equal(bad.failRatio, 0.75);
    assert.equal(bad.infraShare, 0.333);
    assert.deepEqual(bad.categories, { assertion: 2, device: 1 });
    assert.deepEqual(bad.topCauses[0], { cause: 'no such element', count: 2 });
  });

  it('names tests that fail here but pass on another device', () => {
    assert.deepEqual(bad.failsOnlyHere.sort(), ['checkout', 'login']);
  });

  it('flags by ratio (with enough runs) and lists flagged devices first', () => {
    assert.equal(devices[0].serial, 'BAD');
    assert.equal(bad.flagged, true);
    assert.match(bad.reasons.join(' '), /fail ratio 75%/);
    assert.equal(devices.find((d) => d.serial === 'GOOD')!.flagged, false, '1 of 3 is under the threshold');
    const few = devices.find((d) => d.serial === 'FEW')!;
    assert.equal(few.failRatio, 1);
    assert.equal(few.flagged, false, 'one run is not enough evidence');
  });

  it('a flaky test that passes and fails on every device flags none of them', () => {
    const flaky = ['A', 'B'].flatMap((s) => [run(s, 'flaky', 'Passed', 1), run(s, 'flaky', 'Failed', 2), run(s, 'ok', 'Passed', 3)]);
    const out = analyzeDeviceHealth(flaky, { minRuns: 3, failRatioThreshold: 0.5 });
    for (const d of out.devices) {
      assert.deepEqual(d.failsOnlyHere, [], d.serial);
      assert.equal(d.flagged, false, d.serial);
    }
  });

  it('skips runs without a device and reports the baseline over device runs', () => {
    assert.equal(runsWithoutDevice, 1);
    assert.equal(baselineFailRatio, 0.625); // 5 of the 8 device runs
  });
});

describe('find_unhealthy_devices handler', () => {
  let api: StubApi;
  let tools: ToolClient;
  const ROWS = [
    ...[1, 2, 3].map((m) => ({ name: 'login', status: 'Failed', start_time: new Date(NOW - m * 60_000).toISOString(), 'device.serialNumber': 'ABC123', 'device.name': 'Pixel', cause: 'no such element', errorCategory: 'assertion' })),
    { name: 'login', status: 'Passed', start_time: new Date(NOW - 4 * 60_000).toISOString(), 'device.serialNumber': 'XYZ', 'device.name': 'Galaxy' },
    // Outside a 24 h window — must not be counted, and the scan stops at it (sorted data).
    { name: 'login', status: 'Failed', start_time: new Date(NOW - 48 * 3600_000).toISOString(), 'device.serialNumber': 'XYZ' },
  ];

  beforeAll(async () => {
    api = await startStubApi((req) => {
      if (req.path === '/api/v1/users/my-account-info') return accountInfo('Admin', 'Default');
      if (req.path === '/reporter/api/tests/list') return { count: null, data: (req.json.page ?? 1) === 1 ? ROWS : [] };
      if (req.path === '/api/v1/devices') return { status: 'SUCCESS', data: [{ id: '77', udid: 'abc123', deviceName: 'Pixel', displayStatus: 'Available', region: 'US1', tags: [] }], code: 'OK' };
      if (req.method === 'PUT' && req.path === '/api/v1/devices/77/tags/dirty') return { status: 'SUCCESS' };
      return undefined;
    });
    tools = await connectTools(registerHealthTools);
  });
  afterAll(async () => { await tools.close(); await api.close(); });
  beforeEach(() => { api.requests.length = 0; });

  it('flags the device, maps its serial to the device record, and respects the window', async () => {
    const j = await tools.callJson('find_unhealthy_devices', {});
    assert.equal(j.runsAnalysed, 4);
    const d = (j.devices as Array<Record<string, unknown>>)[0];
    assert.equal(d.serial, 'ABC123');
    assert.equal(d.flagged, true);
    assert.equal(d.deviceId, '77', 'serial matched case-insensitively to udid');
    assert.equal(d.status, 'Available');
    assert.deepEqual(d.failsOnlyHere, ['login']);
    const listCall = api.requests.find((r) => r.path === '/reporter/api/tests/list')!.json;
    assert.deepEqual(listCall.keys, ['device.serialNumber', 'device.name', 'device.os', 'cause', 'errorCategory']);
  });

  it('tag alone previews and changes nothing', async () => {
    const j = await tools.callJson('find_unhealthy_devices', { tag: 'dirty' });
    const tagging = j.tagging as { applied: boolean; note: string };
    assert.equal(tagging.applied, false);
    assert.match(tagging.note, /would be tagged "dirty" \(ABC123\)/);
    assert.equal(api.requests.some((r) => r.method === 'PUT'), false);
  });

  it('tag + confirmTagging tags the flagged devices', async () => {
    const j = await tools.callJson('find_unhealthy_devices', { tag: 'dirty', confirmTagging: true });
    const tagging = j.tagging as { applied: boolean; results: Array<{ ok: boolean }> };
    assert.equal(tagging.applied, true);
    assert.deepEqual(tagging.results.map((r) => r.ok), [true]);
    assert.ok(api.requests.some((r) => r.method === 'PUT' && r.path === '/api/v1/devices/77/tags/dirty'));
  });

  it('rejects a tag the platform would refuse', async () => {
    const { res, text } = await tools.call('find_unhealthy_devices', { tag: 'mcp-verify' });
    assert.equal(res.isError, true);
    assert.match(text, /letters, digits and underscores/);
  });
});
