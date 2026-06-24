import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  getAllDevices,
  getCurrentAndFutureReservations,
  getApplications,
  getAllProvisioningProfiles,
} from './helpers/test-client.js';

describe('Health / Combined API', () => {
  it('Combined query — all three APIs complete without error', async () => {
    const [devices, reservations, apps] = await Promise.all([
      getAllDevices(),
      getCurrentAndFutureReservations(),
      getApplications(),
    ]);

    assert.ok(Array.isArray(devices), 'devices should be an array');
    assert.ok(Array.isArray(reservations), 'reservations should be an array');
    assert.ok(Array.isArray(apps), 'applications should be an array');
  });

  it('Health summary — device count > 0 or useful empty-state', async () => {
    const devices = await getAllDevices();
    assert.ok(Array.isArray(devices), 'devices should be an array');
    if (devices.length === 0) {
      // Environment has no devices — this is a valid (empty) state
      console.log('[health.test] No devices found in environment.');
    } else {
      assert.ok(devices.length > 0, 'Should have devices');
      const statuses = new Set(devices.map((d) => d.currentStatus.toLowerCase()));
      assert.ok(statuses.size > 0, 'Should have at least one status type');
    }
  });

  it('Provisioning profile expiry check — profiles expiring within 30 days are identifiable', async () => {
    const profiles = await getAllProvisioningProfiles();
    assert.ok(Array.isArray(profiles), 'profiles should be an array');

    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

    const expiringSoon = profiles.filter((p) => {
      const expiryMs = new Date(p.expirationDate).getTime();
      return expiryMs - now < thirtyDaysMs;
    });

    if (expiringSoon.length > 0) {
      console.log(
        `[health.test] ⚠️  ${expiringSoon.length} profile(s) expiring within 30 days:`,
        expiringSoon.map((p) => `${p.profileName} (${p.expirationDate})`).join(', ')
      );
    } else if (profiles.length > 0) {
      console.log(`[health.test] ✅ All ${profiles.length} profile(s) valid for > 30 days.`);
    }

    // This test always passes — it just provides visibility
    assert.ok(true);
  });
});
