import { describe, it, beforeAll } from 'vitest';
import assert from 'node:assert/strict';
import { getAllDevices, getDevicesByQuery, getDevice, getDeviceTags } from './helpers/test-client.js';
import { assertNonEmpty, assertDefined } from './helpers/test-client.js';
import type { Device } from '../src/types/digital-ai.js';

describe('Devices API', () => {
  let firstDevice: Device;

  beforeAll(async () => {
    const devices = await getAllDevices();
    assertNonEmpty(devices, 'devices list');
    firstDevice = devices[0];
  });

  it('GET /api/v1/devices — returns array of devices', async () => {
    const devices = await getAllDevices();
    assert.ok(Array.isArray(devices), 'Response should be an array');
    assert.ok(devices.length > 0, 'Should have at least one device');
  });

  it('Each device has required fields', async () => {
    const devices = await getAllDevices();
    for (const d of devices.slice(0, 5)) {
      assertDefined(d.id, 'device.id');
      assertDefined(d.deviceOs, 'device.deviceOs');
      assertDefined(d.currentStatus, 'device.currentStatus');
      assert.ok(
        ['Android', 'iOS'].includes(d.deviceOs),
        `deviceOs should be Android or iOS, got ${d.deviceOs}`
      );
    }
  });

  it('GET /api/v1/devices?query= — filters Android devices', async () => {
    const devices = await getDevicesByQuery("@os='android'");
    assert.ok(Array.isArray(devices));
    for (const d of devices) {
      assert.equal(d.deviceOs, 'Android', `Expected Android device but got ${d.deviceOs}`);
    }
  });

  it('GET /api/v1/devices?query= — filters iOS devices', async () => {
    const devices = await getDevicesByQuery("@os='ios'");
    assert.ok(Array.isArray(devices));
    for (const d of devices) {
      assert.equal(d.deviceOs, 'iOS', `Expected iOS device but got ${d.deviceOs}`);
    }
  });

  it('GET /api/v1/devices?query= — empty query returns all devices', async () => {
    const all = await getAllDevices();
    const queried = await getDevicesByQuery('');
    assert.equal(queried.length, all.length, 'Empty query should return same count as all devices');
  });

  it('GET /api/v1/devices/<id> — returns device detail for first device', async () => {
    const detail = await getDevice(firstDevice.id);
    assertDefined(detail, 'device detail');
    assert.equal(detail.id, firstDevice.id, 'Device ID should match');
    assert.ok(detail.agentName !== undefined, 'Detail should include agentName');
  });

  it('GET /api/v1/devices/<id>/tags — returns tags array', async () => {
    const tags = await getDeviceTags(firstDevice.id);
    assert.ok(Array.isArray(tags), 'Tags should be an array');
  });

  it('GET /api/v1/devices/<id> — invalid ID returns error', async () => {
    try {
      await getDevice('999999999');
      assert.fail('Should have thrown an error for invalid device ID');
    } catch (e) {
      assert.ok(e instanceof Error, 'Should throw an Error instance');
    }
  });
});
