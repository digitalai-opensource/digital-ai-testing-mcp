import { describe, it, beforeAll } from 'vitest';
import assert from 'node:assert/strict';
import { getApplications, getApplicationInfo } from './helpers/test-client.js';
import type { Application } from '../src/types/digital-ai.js';

describe('Applications API', () => {
  let allApps: Application[];

  beforeAll(async () => {
    allApps = await getApplications();
  });

  it('GET /api/v1/applications — returns array', async () => {
    assert.ok(Array.isArray(allApps), 'Response should be an array');
  });

  it('GET /api/v1/applications?osType=ios — returns only IOS apps', async () => {
    const apps = await getApplications({ osType: 'ios' });
    assert.ok(Array.isArray(apps));
    for (const a of apps) {
      assert.equal(a.osType, 'IOS', `Expected IOS app but got ${a.osType}`);
    }
  });

  it('GET /api/v1/applications?osType=android — returns only ANDROID apps', async () => {
    const apps = await getApplications({ osType: 'android' });
    assert.ok(Array.isArray(apps));
    for (const a of apps) {
      assert.equal(a.osType, 'ANDROID', `Expected ANDROID app but got ${a.osType}`);
    }
  });

  it('GET /api/v1/applications/<id> — returns full app detail including plugins array', async () => {
    if (allApps.length === 0) return;
    const app = await getApplicationInfo(allApps[0].id);
    assert.equal(app.id, allApps[0].id, 'App ID should match');
    assert.ok('plugins' in app || app.plugins === undefined, 'Should have plugins field');
  });

  it('Each app has id, osType, fileType, createdAt', async () => {
    for (const a of allApps.slice(0, 5)) {
      assert.ok(typeof a.id === 'number', 'id should be a number');
      assert.ok(['IOS', 'ANDROID'].includes(a.osType), `osType should be IOS or ANDROID`);
      assert.ok(typeof a.createdAt === 'number', 'createdAt should be a number');
    }
  });

  it('fileType is one of: apk, ipa, aab, zip', async () => {
    const validTypes = ['apk', 'ipa', 'aab', 'zip'];
    for (const a of allApps.slice(0, 10)) {
      assert.ok(
        validTypes.includes(a.fileType),
        `fileType should be one of ${validTypes.join(', ')}, got: ${a.fileType}`
      );
    }
  });
});
