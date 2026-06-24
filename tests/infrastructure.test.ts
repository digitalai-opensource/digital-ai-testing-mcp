import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  getAgents, getAgentDevices,
  getRegions,
  getNvServers,
  getActiveSessions,
  getReporterProjects,
  getLicenseInfo,
} from './helpers/test-client.js';

// v2 API and reporter endpoints — these require Cloud Admin JWT.
// If the test environment uses a project API key these will throw; that is expected
// and the tests are designed to handle it gracefully.

async function tryOrSkip<T>(fn: () => Promise<T>, label: string): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (msg.includes('[403]') || msg.includes('[401]') || msg.includes('Forbidden') || msg.includes('Unauthorized')) {
      console.warn(`  SKIP: ${label} — requires Cloud Admin JWT (got auth error)`);
      return null;
    }
    throw e;
  }
}

describe('Agents API (v2 — Cloud Admin only)', () => {
  it('GET /api/v2/agents — returns array of agents', async () => {
    const agents = await tryOrSkip(() => getAgents(), 'getAgents');
    if (agents === null) return;
    assert.ok(Array.isArray(agents), 'Should return an array');
  });

  it('GET /api/v2/agents — each agent has required fields', async () => {
    const agents = await tryOrSkip(() => getAgents(), 'getAgents fields');
    if (!agents || agents.length === 0) return;
    const a = agents[0];
    assert.ok(typeof a.id === 'number', 'id should be a number');
    assert.ok(typeof a.name === 'string', 'name should be a string');
    // region is returned as an AgentRegion object {id, name, master, icon} — not a plain string
    assert.ok(
      typeof a.region === 'object' && a.region !== null &&
      typeof (a.region as Record<string, unknown>).name === 'string',
      'region should be an AgentRegion object with a string name field'
    );
    assert.ok(typeof a.available === 'boolean', 'available should be boolean');
    assert.ok(typeof a.enabled === 'boolean', 'enabled should be boolean');
    assert.ok(typeof a.devicesCount === 'number', 'devicesCount should be a number');
  });

  it('GET /api/v2/agents/{id}/devices — returns array', async () => {
    const agents = await tryOrSkip(() => getAgents(), 'getAgentDevices-setup');
    if (!agents || agents.length === 0) return;
    const devices = await tryOrSkip(() => getAgentDevices(agents[0].id), 'getAgentDevices');
    if (devices === null) return;
    assert.ok(Array.isArray(devices), 'Agent devices should be an array');
  });
});

describe('Regions API (v2 — Cloud Admin only)', () => {
  it('GET /api/v2/regions — returns array of regions', async () => {
    const regions = await tryOrSkip(() => getRegions(), 'getRegions');
    if (regions === null) return;
    assert.ok(Array.isArray(regions), 'Should return an array');
  });

  it('GET /api/v2/regions — each region has id, name, status', async () => {
    const regions = await tryOrSkip(() => getRegions(), 'getRegions fields');
    if (!regions || regions.length === 0) return;
    const r = regions[0];
    assert.ok(typeof r.id === 'number', 'id should be a number');
    assert.ok(typeof r.name === 'string', 'name should be a string');
    assert.ok(typeof r.status === 'string', 'status should be a string');
    assert.ok(typeof r.master === 'boolean', 'master should be boolean');
  });
});

describe('NV Servers API (v2 — Cloud Admin only)', () => {
  it('GET /api/v2/nv-servers — returns array', async () => {
    const servers = await tryOrSkip(() => getNvServers(), 'getNvServers');
    if (servers === null) return;
    assert.ok(Array.isArray(servers), 'Should return an array');
  });

  it('GET /api/v2/nv-servers — each server has id, name, region, status', async () => {
    const servers = await tryOrSkip(() => getNvServers(), 'getNvServers fields');
    if (!servers || servers.length === 0) return;
    const s = servers[0];
    assert.ok(typeof s.id === 'number', 'id should be a number');
    assert.ok(typeof s.name === 'string', 'name should be a string');
    // region is returned as an object {id, name, ...} from the v2 API — same pattern as agents
    const regionVal = s.region as unknown;
    assert.ok(
      (typeof regionVal === 'string' && (regionVal as string).length > 0) ||
      (typeof regionVal === 'object' && regionVal !== null &&
       typeof (regionVal as Record<string, unknown>).name === 'string'),
      'region should be a non-empty string or region object with a name field'
    );
    assert.ok(typeof s.status === 'string', 'status should be a string');
    assert.ok(typeof s.tunnelingConnected === 'boolean', 'tunnelingConnected should be boolean');
  });
});

describe('Active Sessions API (v2 — Cloud Admin JWT only)', () => {
  it('GET /api/v2/sessions — returns array', async () => {
    const sessions = await tryOrSkip(() => getActiveSessions(), 'getActiveSessions');
    if (sessions === null) return;
    assert.ok(Array.isArray(sessions), 'Should return an array');
  });

  it('GET /api/v2/sessions — session records have expected fields when non-empty', async () => {
    const sessions = await tryOrSkip(() => getActiveSessions(), 'getActiveSessions fields');
    if (!sessions || sessions.length === 0) return;
    const s = sessions[0];
    assert.ok(typeof s.sessionID === 'string', 'sessionID should be a string');
    assert.ok(typeof s.username === 'string', 'username should be a string');
    assert.ok(typeof s.productName === 'string', 'productName should be a string');
    assert.ok(typeof s.lastAliveTime === 'number', 'lastAliveTime should be a number');
  });
});

describe('Reporter Projects Storage API (Cloud Admin JWT only)', () => {
  it('GET /reporter/api/projects — returns array', async () => {
    const projects = await tryOrSkip(() => getReporterProjects(), 'getReporterProjects');
    if (projects === null) return;
    assert.ok(Array.isArray(projects), 'Should return an array');
  });

  it('GET /reporter/api/projects — each record has storage fields', async () => {
    const projects = await tryOrSkip(() => getReporterProjects(), 'getReporterProjects fields');
    if (!projects || projects.length === 0) return;
    const p = projects[0];
    assert.ok(typeof p.id === 'number', 'id should be a number');
    assert.ok(typeof p.name === 'string', 'name should be a string');
    assert.ok(typeof p.currentDiskStorageInMB === 'number', 'currentDiskStorageInMB should be a number');
    assert.ok(typeof p.diskStorageThresholdInMB === 'number', 'diskStorageThresholdInMB should be a number');
    assert.ok(p.usagePct >= 0, 'usagePct should be >= 0');
  });
});

describe('License Info API (v2 — Cloud Admin only)', () => {
  it('GET /api/v2/license — returns license limits object', async () => {
    const info = await tryOrSkip(() => getLicenseInfo(), 'getLicenseInfo');
    if (info === null) return;
    assert.ok(typeof info.dedicatedDevices === 'number', 'dedicatedDevices should be a number');
    assert.ok(typeof info.sharedDevices === 'number', 'sharedDevices should be a number');
    assert.ok(typeof info.virtualDevices === 'number', 'virtualDevices should be a number');
    assert.ok(typeof info.browsers === 'number', 'browsers should be a number');
    assert.ok(info.dedicatedDevices >= 0, 'dedicatedDevices should be >= 0');
    assert.ok(info.browsers >= 0, 'browsers should be >= 0');
  });
});
