/**
 * Access-level resolution — role comes from the API, never from the key's format.
 *
 * Runs against a local HTTP server standing in for the platform, so it needs no .env and no live API.
 * Regression target: the old code treated `eyJ...` as Cloud Admin and everything else as project-level,
 * which broke once Digital.ai 24.11 started issuing short `aut_1_...` keys to Cloud Admins too.
 */
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { resolveAccessInfo } from '../src/api/access-level.js';
import {
  levelFromRole,
  isKnownNotCloudAdmin,
  authSchemeFor,
  authHeadersFor,
  clearAccessInfoCache,
  parseProbeTimeout,
  DEFAULT_PROBE_TIMEOUT_MS,
} from '../src/utils/access-level.js';

interface Fake {
  /** my-account-info → [status, role]; role undefined = body without a role */
  account: [number, string | undefined];
  /** /api/v2/license status */
  license: number;
  hits: { account: number; license: number };
  lastHeaders: http.IncomingHttpHeaders | null;
}

const fake: Fake = { account: [200, 'Admin'], license: 200, hits: { account: 0, license: 0 }, lastHeaders: null };
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    fake.lastHeaders = req.headers;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/users/my-account-info') {
      fake.hits.account++;
      res.statusCode = fake.account[0];
      res.end(JSON.stringify(fake.account[1] === undefined ? { status: 'SUCCESS', data: {} } : { status: 'SUCCESS', data: { role: fake.account[1], project: { id: 2, name: 'Default' } } }));
    } else if (req.url === '/api/v2/license') {
      fake.hits.license++;
      res.statusCode = fake.license;
      res.end(JSON.stringify({ browsers: 1 }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  clearAccessInfoCache();
  fake.account = [200, 'Admin'];
  fake.license = 200;
  fake.hits = { account: 0, license: 0 };
  fake.lastHeaders = null;
});

const SHORT_KEY = 'aut_1_unit_test_key';
const JWT_KEY = 'eyJunit.test.jwt';

describe('levelFromRole', () => {
  it('maps the three platform roles', () => {
    assert.equal(levelFromRole('Admin'), 'cloud-admin');
    assert.equal(levelFromRole('ProjectAdmin'), 'project-admin');
    assert.equal(levelFromRole('User'), 'project-user');
  });

  it('treats anything else as unknown rather than guessing', () => {
    assert.equal(levelFromRole(undefined), 'unknown');
    assert.equal(levelFromRole('SuperUser'), 'unknown');
    assert.equal(levelFromRole('admin'), 'unknown'); // case-sensitive on purpose: unrecognised → probe
  });
});

describe('isKnownNotCloudAdmin', () => {
  it('is true only for positively-known lower levels; unknown is NOT "not admin"', () => {
    assert.equal(isKnownNotCloudAdmin('project-admin'), true);
    assert.equal(isKnownNotCloudAdmin('project-user'), true);
    assert.equal(isKnownNotCloudAdmin('project-limited'), true);
    assert.equal(isKnownNotCloudAdmin('cloud-admin'), false);
    assert.equal(isKnownNotCloudAdmin('unknown'), false);
  });
});

describe('resolveAccessInfo — role comes from the API, not the key', () => {
  it('short aut_1_ key + role Admin → cloud-admin (the regression)', async () => {
    fake.account = [200, 'Admin'];
    const info = await resolveAccessInfo(baseUrl, SHORT_KEY);
    assert.equal(info.level, 'cloud-admin');
    assert.equal(info.source, 'role');
    assert.equal(fake.hits.license, 0, 'a recognised role must not trigger the license probe');
  });

  it('JWT-format key + role User → project-user (format grants nothing)', async () => {
    fake.account = [200, 'User'];
    assert.equal((await resolveAccessInfo(baseUrl, JWT_KEY)).level, 'project-user');
  });

  it('role ProjectAdmin → project-admin', async () => {
    fake.account = [200, 'ProjectAdmin'];
    assert.equal((await resolveAccessInfo(baseUrl, SHORT_KEY)).level, 'project-admin');
  });

  it('unrecognised role + license 200 → cloud-admin via probe', async () => {
    fake.account = [200, 'TenantOwner'];
    fake.license = 200;
    const info = await resolveAccessInfo(baseUrl, SHORT_KEY);
    assert.equal(info.level, 'cloud-admin');
    assert.equal(info.source, 'probe');
    assert.equal(info.role, 'TenantOwner');
  });

  it('unrecognised role + license 403 → project-limited via probe', async () => {
    fake.account = [200, 'TenantOwner'];
    fake.license = 403;
    const info = await resolveAccessInfo(baseUrl, SHORT_KEY);
    assert.equal(info.level, 'project-limited');
    assert.equal(info.source, 'probe');
  });

  it('missing role + license 401 → project-limited', async () => {
    fake.account = [200, undefined];
    fake.license = 401;
    assert.equal((await resolveAccessInfo(baseUrl, SHORT_KEY)).level, 'project-limited');
  });

  it('rejected key (401 on account-info) → unknown, and does not probe further', async () => {
    fake.account = [401, undefined];
    const info = await resolveAccessInfo(baseUrl, SHORT_KEY);
    assert.equal(info.level, 'unknown');
    assert.equal(fake.hits.license, 0);
  });

  it('unreachable host → unknown (gates then fail open)', async () => {
    const info = await resolveAccessInfo('http://127.0.0.1:1', SHORT_KEY);
    assert.equal(info.level, 'unknown');
    assert.equal(info.source, 'unresolved');
  });

  it('unknown is never cached — a later call retries and can succeed', async () => {
    fake.account = [401, undefined];
    assert.equal((await resolveAccessInfo(baseUrl, SHORT_KEY)).level, 'unknown');
    fake.account = [200, 'Admin'];
    assert.equal((await resolveAccessInfo(baseUrl, SHORT_KEY)).level, 'cloud-admin');
  });
});

describe('parseProbeTimeout — a bad env value must never disable the timeout', () => {
  it('accepts a positive number', () => {
    assert.equal(parseProbeTimeout('2500'), 2500);
  });
  it('falls back for unset, blank, non-numeric, zero and negative values', () => {
    for (const bad of [undefined, '', '   ', '8s', 'NaN', '0', '-5', 'Infinity']) {
      assert.equal(parseProbeTimeout(bad), DEFAULT_PROBE_TIMEOUT_MS, `value ${JSON.stringify(bad)}`);
    }
  });
});

describe('resolveAccessInfo captures the credential\'s own project', () => {
  it('projectName comes from my-account-info in the same request as the role', async () => {
    const info = await resolveAccessInfo(baseUrl, SHORT_KEY);
    assert.equal(info.projectName, 'Default');
    assert.equal(fake.hits.account, 1);
  });
});

describe('resolveAccessInfo caching', () => {
  it('concurrent callers for the same credential share ONE in-flight probe', async () => {
    const results = await Promise.all([
      resolveAccessInfo(baseUrl, SHORT_KEY),
      resolveAccessInfo(baseUrl, SHORT_KEY),
      resolveAccessInfo(baseUrl, SHORT_KEY),
    ]);
    assert.ok(results.every((r) => r.level === 'cloud-admin'));
    assert.equal(fake.hits.account, 1, 'each concurrent caller issued its own probe');
  });

  it('serves a resolved level from cache (one account-info call for repeated resolution)', async () => {
    await resolveAccessInfo(baseUrl, SHORT_KEY);
    await resolveAccessInfo(baseUrl, SHORT_KEY);
    await resolveAccessInfo(baseUrl, SHORT_KEY);
    assert.equal(fake.hits.account, 1);
  });

  it('is keyed per credential — a regenerated or switched key is never served a stale answer', async () => {
    fake.account = [200, 'Admin'];
    assert.equal((await resolveAccessInfo(baseUrl, SHORT_KEY)).level, 'cloud-admin');
    fake.account = [200, 'User'];
    assert.equal((await resolveAccessInfo(baseUrl, 'aut_1_a_different_key')).level, 'project-user');
    // the first credential's cached answer is untouched
    assert.equal((await resolveAccessInfo(baseUrl, SHORT_KEY)).level, 'cloud-admin');
  });
});

describe('auth scheme is the one legitimately format-dependent thing', () => {
  it('JWT → Bearer only; short key → Bearer + X-API-KEY (CSRF exemption on reporter mutations)', () => {
    assert.equal(authSchemeFor(JWT_KEY), 'bearer');
    assert.deepEqual(authHeadersFor(JWT_KEY), { Authorization: `Bearer ${JWT_KEY}` });
    assert.equal(authSchemeFor(SHORT_KEY), 'bearer+x-api-key');
    assert.deepEqual(authHeadersFor(SHORT_KEY), { 'X-API-KEY': SHORT_KEY, Authorization: `Bearer ${SHORT_KEY}` });
  });

  it('the probe sends the same headers the real client would', async () => {
    await resolveAccessInfo(baseUrl, SHORT_KEY);
    assert.equal(fake.lastHeaders?.['x-api-key'], SHORT_KEY);
    assert.equal(fake.lastHeaders?.authorization, `Bearer ${SHORT_KEY}`);
  });
});
