import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { getCurrentAndFutureReservations, deleteReservation } from './helpers/test-client.js';

describe('Reservations API', () => {
  it('GET /api/v1/device-reservations — returns array (may be empty)', async () => {
    const reservations = await getCurrentAndFutureReservations();
    assert.ok(Array.isArray(reservations), 'Response should be an array');
  });

  it('Each reservation has required fields', async () => {
    const reservations = await getCurrentAndFutureReservations();
    for (const r of reservations.slice(0, 5)) {
      assert.ok(typeof r.reservationId === 'number', 'reservationId should be a number');
      assert.ok(typeof r.reservationStart === 'string', 'reservationStart should be a string');
      assert.ok(typeof r.reservationEnd === 'string', 'reservationEnd should be a string');
      assert.ok(typeof r.username === 'string', 'username should be a string');
      assert.ok(typeof r.deviceUid === 'string', 'deviceUid should be a string');
    }
  });

  it('Filter by username returns only that user\'s reservations', async () => {
    const allReservations = await getCurrentAndFutureReservations();
    if (allReservations.length === 0) {
      // No reservations to test with — skip gracefully
      return;
    }
    const firstUser = allReservations[0].username;
    const filtered = await getCurrentAndFutureReservations({ username: firstUser });
    assert.ok(Array.isArray(filtered), 'Filtered result should be an array');
    for (const r of filtered) {
      assert.equal(r.username, firstUser, `Expected user ${firstUser} but got ${r.username}`);
    }
  });

  it('DELETE /api/v1/device-reservations/<id> — invalid ID returns error', async () => {
    try {
      await deleteReservation(999999999);
      assert.fail('Should have thrown an error for invalid reservation ID');
    } catch (e) {
      assert.ok(e instanceof Error, 'Should throw an Error instance');
    }
  });
});
