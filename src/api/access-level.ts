/**
 * Resolve the access level of a credential FROM THE API — never from the key's format.
 *
 *   1. GET /api/v1/users/my-account-info  → `role`: Admin | ProjectAdmin | User   (verified live)
 *   2. Only if the role string is unrecognised: GET /api/v2/license (Cloud Admin only; project-level
 *      keys get 401/403) decides cloud-admin vs project-limited.
 *
 * Uses a bare axios call rather than the shared client so it works for ANY profile's credentials
 * (list_environments) and cannot recurse through the 403-hint interceptor. A short timeout keeps a dead
 * host from stalling every gate. Failures resolve to 'unknown', and gates FAIL OPEN on 'unknown': the
 * API's own 401/403 then decides, which is strictly better than guessing from a key prefix.
 *
 * Callers that already hold a my-account-info body (get_server_info, switch_environment) prime the cache
 * with primeAccessInfoFromAccount() so the same endpoint is not fetched twice.
 */
import axios from 'axios';
import { getActiveAccessKey, getActiveUrl } from './client.js';
import { getReporterProjects } from './reporter-projects.js';
import { getProfileCredentials } from '../utils/profile-loader.js';
import type { MyAccountInfo } from '../types/digital-ai.js';
import {
  authHeadersFor,
  credentialFingerprint,
  getAccessLevelOverride,
  isKnownNotCloudAdmin,
  isServerSortRefused,
  markServerSortRefused,
  levelFromRole,
  parseProbeTimeout,
  peekAccessInfo,
  rememberAccessInfo,
  type AccessInfo,
  type AccessLevel,
} from '../utils/access-level.js';

const PROBE_TIMEOUT_MS = parseProbeTimeout(process.env.ACCESS_PROBE_TIMEOUT_MS);

async function probeStatus(url: string, key: string, path: string): Promise<{ status: number; data: unknown } | undefined> {
  try {
    const res = await axios.get(url.replace(/\/$/, '') + path, {
      headers: authHeadersFor(key),
      timeout: PROBE_TIMEOUT_MS,
      validateStatus: () => true,
    });
    return { status: res.status, data: res.data };
  } catch {
    return undefined; // network failure / timeout
  }
}

// Concurrent callers for the same credential (list_environments across profiles sharing a key, or two
// gates racing) share one in-flight resolution instead of each probing.
const inFlight = new Map<string, Promise<AccessInfo>>();

/** Resolve (and cache) the access level for an explicit url + key. */
export async function resolveAccessInfo(url: string, key: string): Promise<AccessInfo> {
  const cached = peekAccessInfo(url, key);
  if (cached) return cached;

  const fp = credentialFingerprint(url, key);
  const pending = inFlight.get(fp);
  if (pending) return pending;

  const task = resolveUncached(url, key).finally(() => inFlight.delete(fp));
  inFlight.set(fp, task);
  return task;
}

async function resolveUncached(url: string, key: string): Promise<AccessInfo> {
  const acct = await probeStatus(url, key, '/api/v1/users/my-account-info');
  let role: string | undefined;
  let projectName: string | undefined;
  if (acct?.status === 200) {
    const body = acct.data as { data?: { role?: unknown; project?: { name?: unknown } } } | undefined;
    if (typeof body?.data?.role === 'string') role = body.data.role;
    if (typeof body?.data?.project?.name === 'string') projectName = body.data.project.name;
  }

  const fromRole = levelFromRole(role);
  if (fromRole !== 'unknown') {
    const info: AccessInfo = { level: fromRole, role, projectName, source: 'role' };
    rememberAccessInfo(url, key, info);
    return info;
  }

  // Role absent or unrecognised: ask a Cloud-Admin-only endpoint. Only worth doing if we reached the
  // server at all and authenticated (an unreachable host or a rejected key stays 'unknown').
  if (acct && acct.status === 200) {
    const lic = await probeStatus(url, key, '/api/v2/license');
    let level: AccessLevel = 'unknown';
    if (lic?.status === 200) level = 'cloud-admin';
    else if (lic?.status === 401 || lic?.status === 403) level = 'project-limited';
    const info: AccessInfo = { level, role, projectName, source: level === 'unknown' ? 'unresolved' : 'probe' };
    rememberAccessInfo(url, key, info);
    return info;
  }

  return { level: 'unknown', role, projectName, source: 'unresolved' };
}

/**
 * Seed the cache for the ACTIVE credential from a my-account-info body the caller already fetched through
 * the main client. Only a recognised role is primed; an unrecognised one is left for the resolver's probe.
 */
export function primeAccessInfoFromAccount(me: MyAccountInfo): void {
  const level = levelFromRole(me.role);
  if (level === 'unknown') return;
  rememberAccessInfo(getActiveUrl(), getActiveAccessKey(), {
    level,
    role: me.role,
    projectName: me.project?.name,
    source: 'role',
  });
}

/** Access level of the ACTIVE profile (honours switch_environment). */
export async function getAccessInfo(): Promise<AccessInfo> {
  const forced = getAccessLevelOverride();
  if (forced) return forced;
  const url = getActiveUrl();
  const key = getActiveAccessKey();
  if (!url || !key) return { level: 'unknown', source: 'unresolved' };
  return resolveAccessInfo(url, key);
}

/**
 * Cache-only view of the active profile's access level — NEVER touches the network. For callers that must
 * stay offline (command generators the user reaches for precisely when the server is unreachable).
 * Returns undefined when nothing is known yet.
 */
export function peekActiveAccessInfo(): AccessInfo | undefined {
  const forced = getAccessLevelOverride();
  if (forced) return forced;
  return peekAccessInfo(getActiveUrl(), getActiveAccessKey());
}

/** Access level of a NAMED profile, using that profile's own credentials. */
export async function resolveProfileAccess(profileName: string): Promise<AccessInfo> {
  const creds = getProfileCredentials(profileName);
  if (!creds) return { level: 'unknown', source: 'unresolved' };
  return resolveAccessInfo(creds.url, creds.key);
}

/**
 * Gate for reporter DELETES. Cloud Admin (and an undeterminable level) always proceeds.
 *
 * Project-level roles are refused up front ONLY when the project the delete will actually hit has a
 * readable `allowUsersDeleteTests === false` — verified live: with it false, Cloud Admin deleted fine
 * while ProjectAdmin and User both got 403 "You have no permission to delete tests". A ProjectAdmin key
 * can read its own project's flag via GET /reporter/api/projects; a User key sees an empty list.
 *
 * Which project is "the one the delete will hit":
 *   - `projectName` given → exactly that project. If it is not in the visible list we do NOT substitute
 *     another one; the call proceeds and the platform decides.
 *   - no `projectName` → the credential's own project (reporter calls default to that scope; a numeric
 *     projectId is ignored by the reporter delete endpoint, so it cannot redirect the delete elsewhere).
 *     If that is not visible and exactly one project is, that one.
 * When the flag is true or unreadable the call proceeds (whether a project role succeeds once the flag is
 * true is NOT verified). Returns the refusal text, or null to proceed.
 */
export async function checkDeleteAllowed(projectName?: string): Promise<string | null> {
  const info = await getAccessInfo();
  if (!isKnownNotCloudAdmin(info.level)) return null;

  let projects: Awaited<ReturnType<typeof getReporterProjects>> = [];
  try {
    projects = await getReporterProjects();
  } catch {
    // unreadable — let the platform decide
  }

  let target;
  if (projectName) {
    target = projects.find((p) => p.name === projectName);
  } else {
    target = info.projectName ? projects.find((p) => p.name === info.projectName) : undefined;
    if (!target && projects.length === 1) target = projects[0];
  }

  if (target?.allowUsersDeleteTests === false) {
    return (
      `Error: Reporter deletes are disabled for project "${target.name}" — its allowUsersDeleteTests setting is false, ` +
      `and only a Cloud Admin can delete while it is false (the platform answers ${info.level === 'project-admin' ? 'a Project Admin' : 'a project-level role'} with 403 "You have no permission to delete tests"). ` +
      `Ask a Cloud Admin to set allowUsersDeleteTests to true for this project, or use list_environments / switch_environment() to a Cloud Admin profile.`
    );
  }
  return null;
}

/**
 * True unless the platform has already refused server-side sort for the ACTIVE credential. Sort is
 * attempted for every role and falls back automatically (see listTests) — role is deliberately NOT
 * consulted, because which roles may sort is a platform behavior that has changed before.
 */
export function serverSortAvailable(): boolean {
  return !isServerSortRefused(getActiveUrl(), getActiveAccessKey());
}

/** Record that the platform refused sort for the ACTIVE credential. */
export function markActiveServerSortRefused(): void {
  markServerSortRefused(getActiveUrl(), getActiveAccessKey());
}
