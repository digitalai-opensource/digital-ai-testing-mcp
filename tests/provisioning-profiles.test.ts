import { describe, it, beforeAll } from 'vitest';
import assert from 'node:assert/strict';
import { getAllProvisioningProfiles, getProvisioningProfile } from './helpers/test-client.js';
import type { ProvisioningProfile } from '../src/types/digital-ai.js';

describe('Provisioning Profiles API', () => {
  let allProfiles: ProvisioningProfile[];

  beforeAll(async () => {
    allProfiles = await getAllProvisioningProfiles();
  });

  it('GET /api/v1/provisioning-profiles — returns array (may be empty if no iOS profiles)', async () => {
    assert.ok(Array.isArray(allProfiles), 'Response should be an array');
  });

  it('Each profile has profileUUID, profileName, expirationDate, applicationPrefix', async () => {
    for (const p of allProfiles.slice(0, 5)) {
      assert.ok(typeof p.profileUUID === 'string', 'profileUUID should be a string');
      assert.ok(typeof p.profileName === 'string', 'profileName should be a string');
      assert.ok(typeof p.expirationDate === 'string', 'expirationDate should be a string');
      assert.ok(typeof p.applicationPrefix === 'string', 'applicationPrefix should be a string');
    }
  });

  it('If profiles exist: GET /api/v1/provisioning-profiles/<uuid> returns matching profile', async () => {
    if (allProfiles.length === 0) return;
    const profile = await getProvisioningProfile(allProfiles[0].profileUUID);
    assert.equal(
      profile.profileUUID,
      allProfiles[0].profileUUID,
      'Profile UUID should match'
    );
    assert.equal(
      profile.profileName,
      allProfiles[0].profileName,
      'Profile name should match'
    );
  });
});
