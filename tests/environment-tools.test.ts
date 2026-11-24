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

const PROFILE_VARS = ['DAI_PROFILE_ADMIN_URL', 'DAI_PROFILE_ADMIN_KEY', 'DAI_PROFILE_GRIDUSER_URL', 'DAI_PROFILE_GRIDUSER_KEY', 'DAI_PROFILE_USER_URL', 'DAI_PROFILE_USER_KEY'];
const ORIGINAL = Object.fromEntries(PROFILE_VARS.map((k) => [k, process.env[k]]));
let api: StubApi;
let tools: ToolClient;

beforeAll(async () => {
  // The role is answered per credential, as the platform does: the admin key is a Project Admin, the others Project Users.
  api = await startStubApi((req) => {
    if (req.path !== '/api/v1/users/my-account-info') return undefined;
    const sent = `${req.headers.authorization ?? ''} ${req.headers['x-api-key'] ?? ''}`;
    return sent.includes('project_admin') ? accountInfo('ProjectAdmin', 'Mobile QA') : accountInfo('User', 'Mobile QA');
  });
  // A profile literally named "admin" (as in the dev .env), holding a Project Admin key, and two Project User profiles.
  process.env.DAI_PROFILE_ADMIN_URL = api.baseUrl;
  process.env.DAI_PROFILE_ADMIN_KEY = 'aut_1_project_admin_key';
  process.env.DAI_PROFILE_GRIDUSER_URL = api.baseUrl;
  process.env.DAI_PROFILE_GRIDUSER_KEY = 'aut_1_grid_user_key';
  process.env.DAI_PROFILE_USER_URL = api.baseUrl;
  process.env.DAI_PROFILE_USER_KEY = 'aut_1_plain_user_key';
  tools = await connectTools(registerMetaTools);
});
afterAll(async () => {
  for (const [k, v] of Object.entries(ORIGINAL)) {
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

describe('switch_environment role aliases narrow by the DETECTED role (UAT 2026-11-14)', () => {
  it('"project admin" goes straight to the one Project Admin profile; "project user" and "project" still ask', async () => {
    setAccessLevelOverrideForTests(null);
    const admin = await tools.call('switch_environment', { profileName: 'project admin' });
    assert.match(admin.text, /"admin"/);
    assert.doesNotMatch(admin.text, /Multiple project profiles/);
    assert.doesNotMatch(admin.text, /griduser/);

    const users = await tools.call('switch_environment', { profileName: 'project user' });
    assert.match(users.text, /Multiple project profiles found: "griduser", "user"/);
    assert.doesNotMatch(users.text, /"admin"/);

    const any = await tools.call('switch_environment', { profileName: 'project' });
    assert.match(any.text, /Multiple project profiles found: "admin", "griduser", "user"/);
  });
});

describe('check_connectivity example prompts (a bare list was summarised away)', () => {
  it('are an instruction to show them, include the usage prompt only for a Cloud Admin, and appear once per run', async () => {
    const { connectivityExamples, resetConnectivityExamplesForTests } = await import('../src/tools/meta-tools.js');
    resetConnectivityExamplesForTests();
    const first = connectivityExamples('Admin');
    assert.match(first.join('\n'), /Show the user these example prompts as a short list, word for word/);
    assert.match(first.join('\n'), /usage summary for project/);
    assert.deepEqual(connectivityExamples('Admin'), [], 'shown once');
    resetConnectivityExamplesForTests();
    assert.doesNotMatch(connectivityExamples('User').join('\n'), /usage summary/);
    resetConnectivityExamplesForTests();
  });
});
