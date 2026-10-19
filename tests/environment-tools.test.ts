/**
 * switch_environment / list_environments handlers (profile aliases resolve by DETECTED role, not profile name).
 *  - "admin" matching a same-named profile that is not Cloud Admin says so and points at the "cloud admin" alias
 * tests/access-level.test.ts covers the role resolver itself.
 */
import { describe, it, beforeAll, afterAll, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { setAccessLevelOverrideForTests } from '../src/utils/access-level.js';
import { registerMetaTools } from '../src/tools/meta-tools.js';
import { startStubApi, connectTools, accountInfo, type StubApi, type ToolClient } from './helpers/offline.js';

const ORIGINAL = { url: process.env.DAI_PROFILE_ADMIN_URL, key: process.env.DAI_PROFILE_ADMIN_KEY };
let api: StubApi;
let tools: ToolClient;

beforeAll(async () => {
  api = await startStubApi((req) => (req.path === '/api/v1/users/my-account-info' ? accountInfo('ProjectAdmin', 'Mobile QA') : undefined));
  // A profile literally named "admin" (as in the dev .env), holding a Project Admin key.
  process.env.DAI_PROFILE_ADMIN_URL = api.baseUrl;
  process.env.DAI_PROFILE_ADMIN_KEY = 'aut_1_project_admin_key';
  tools = await connectTools(registerMetaTools);
});
afterAll(async () => {
  for (const [k, v] of [['DAI_PROFILE_ADMIN_URL', ORIGINAL.url], ['DAI_PROFILE_ADMIN_KEY', ORIGINAL.key]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await tools.close();
  await api.close();
});
afterEach(() => setAccessLevelOverrideForTests(null));

describe('switch_environment', () => {
  it('"admin" matching a same-named Project Admin profile says so', async () => {
    setAccessLevelOverrideForTests('project-admin');
    const { text } = await tools.call('switch_environment', { profileName: 'admin' });
    assert.match(text, /Switched from .* to "admin"/);
    assert.match(text, /matched a profile by that exact name, which is not Cloud Admin.*switch_environment\("cloud admin"\)/);
  });
});

describe('switch_environment to the profile already active (intake 2026-10-19)', () => {
  it('answers "Already on" instead of "Switched from X to X"', async () => {
    setAccessLevelOverrideForTests('project-admin');
    await tools.call('switch_environment', { profileName: 'admin' });
    const { text } = await tools.call('switch_environment', { profileName: 'admin' });
    assert.match(text, /^Already on "admin"/);
    assert.doesNotMatch(text, /Switched from/);
  });
});
