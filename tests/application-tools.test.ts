/**
 * Application tool handlers against a stub API (tests/api/applications.test.ts covers the live API itself).
 *  - nameContains matches the package / bundle id and internal name, not only the display name: the Android ExperiBank
 *    demo is "SeeTestDemoApp" by display name (fidelity eval 2026-10-14 — the agent concluded no Android ExperiBank existed)
 *  - the list output carries the identifier so the agent can recognise an app by package
 *  - osType accepts the platform's own spelling ("ANDROID")
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { registerApplicationTools } from '../src/tools/application-tools.js';
import { startStubApi, connectTools, type StubApi, type ToolClient } from './helpers/offline.js';

const app = (id: number, applicationName: string, name: string, osType: 'IOS' | 'ANDROID', ids: { packageName?: string; bundleIdentifier?: string }) => ({
  id, applicationName, name, osType, version: '1', buildVersion: '1', releaseVersion: '1.0', fileType: osType === 'IOS' ? 'ipa' : 'apk',
  createdAt: 1_700_000_000_000 + id, createdAtFormatted: '2026-10-01 00:00:00', isForSimulator: false, cameraSupport: false, networkCaptureSupport: false,
  projectsInfo: [{ id: 1, name: 'Default' }], ...ids,
});
const APPS = [
  app(1, 'SeeTestDemoApp', 'com.experitest.ExperiBank/.LoginActivity', 'ANDROID', { packageName: 'com.experitest.ExperiBank' }),
  app(2, 'ExperiBank', 'ExperiBank', 'IOS', { bundleIdentifier: 'com.experitest.ExperiBank' }),
  app(3, 'DAI Bank', 'com.daibank.mobile/.MainActivity', 'ANDROID', { packageName: 'com.daibank.mobile' }),
];

let api: StubApi;
let tools: ToolClient;

beforeAll(async () => {
  api = await startStubApi((req) => {
    if (req.path !== '/api/v1/applications') return undefined;
    const os = req.query.get('osType')?.toUpperCase();
    return APPS.filter((a) => !os || a.osType === os); // the real endpoint returns the array directly, no envelope
  });
  tools = await connectTools(registerApplicationTools);
});
afterAll(async () => { await tools.close(); await api.close(); });

describe('list_applications nameContains', () => {
  it('finds an app by its package name when the display name differs, and reports the identifier', async () => {
    const j = await tools.callJson('list_applications', { nameContains: 'ExperiBank', osType: 'android' });
    const apps = j.applications as Array<{ id: number; name: string; identifier: string | null }>;
    assert.deepEqual(apps.map((a) => a.id), [1]);
    assert.equal(apps[0].name, 'SeeTestDemoApp');
    assert.equal(apps[0].identifier, 'com.experitest.ExperiBank');
  });

  it('still matches the display name, across both platforms', async () => {
    const j = await tools.callJson('list_applications', { nameContains: 'experibank' });
    assert.deepEqual((j.applications as Array<{ id: number }>).map((a) => a.id).sort(), [1, 2]);
  });

  it("accepts the platform's own OS spelling and the human output shows the identifier", async () => {
    const { res, text } = await tools.call('list_applications', { nameContains: 'bank', osType: 'ANDROID', outputFormat: 'human' });
    assert.notEqual(res.isError, true, text);
    assert.match(text, /Found 2 application/);
    assert.match(text, /SeeTestDemoApp \(ID 1\).*com\.experitest\.ExperiBank/);
  });
});
