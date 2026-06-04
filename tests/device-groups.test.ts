import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { getDeviceGroups, getDevicesInDeviceGroup } from './helpers/test-client.js';

describe('Device Groups API', () => {
  it('GET /api/v1/device-groups — returns a record/map of id→name', async () => {
    const groups = await getDeviceGroups();
    assert.ok(typeof groups === 'object' && !Array.isArray(groups), 'Response should be an object map');
    assert.ok(Object.keys(groups).length > 0, 'Should have at least one device group');
  });

  it('Default group exists in the response', async () => {
    const groups = await getDeviceGroups();
    const names = Object.values(groups);
    assert.ok(
      names.some((n) => n.toLowerCase().includes('default')),
      `Expected a "Default" group in ${names.join(', ')}`
    );
  });

  it('GET /api/v1/device-groups/<id>/devices — returns device array for Default group', async () => {
    const groups = await getDeviceGroups();
    const defaultEntry = Object.entries(groups).find(([, name]) =>
      name.toLowerCase().includes('default')
    );
    assert.ok(defaultEntry, 'Default group should exist');
    const [defaultId] = defaultEntry;
    const devices = await getDevicesInDeviceGroup(defaultId);
    assert.ok(Array.isArray(devices), 'Devices should be an array');
  });
});
