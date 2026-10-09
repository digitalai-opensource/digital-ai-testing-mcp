/**
 * Access level — what the active credential is ALLOWED to do, as reported by the API.
 *
 * Key FORMAT says nothing about privilege. Digital.ai 24.11 moved newly generated access keys to a
 * different token format, so a Cloud Admin can hold a short `aut_1_...` key (confirmed live: it
 * passes /api/v2/license, /api/v2/agents, /api/v2/regions and reporter deletes), while older keys
 * are `eyJ...` JWTs. Role is therefore resolved from `GET /api/v1/users/my-account-info`
 * (`Admin` | `ProjectAdmin` | `User`) by `src/api/access-level.ts` — never from the key's prefix.
 *
 * This file is pure (no network, no client import) so `client.ts` can use it without a cycle.
 */
import { createHash } from 'node:crypto';

export type AccessLevel =
  | 'cloud-admin'
  | 'project-admin'
  | 'project-user'
  /** Confirmed NOT Cloud Admin (v2 endpoints refuse it) but the exact project role is unrecognised. */
  | 'project-limited'
  /** Could not be determined (network failure, bad key). Gates FAIL OPEN — the API's own 401/403 decides. */
  | 'unknown';

export interface AccessInfo {
  level: AccessLevel;
  /** Raw `role` string from my-account-info, when it was obtained. */
  role?: string;
  /** The credential's own project (my-account-info `project.name`) — the scope reporter calls hit by default. */
  projectName?: string;
  /** `role`: mapped from my-account-info. `probe`: role unrecognised, decided by a Cloud-Admin-only endpoint. */
  source: 'role' | 'probe' | 'unresolved';
}

/**
 * Probe timeout from ACCESS_PROBE_TIMEOUT_MS. `Number()` alone turns "8s" into NaN and "" into 0, both of
 * which axios treats as "no timeout" — silently defeating the dead-host guarantee. Anything that is not a
 * positive finite number falls back to the default.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 8000;
export function parseProbeTimeout(raw: string | undefined, fallback = DEFAULT_PROBE_TIMEOUT_MS): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Map the raw my-account-info `role` to a level. Anything unrecognised is 'unknown' (caller then probes). */
export function levelFromRole(role: string | undefined): AccessLevel {
  switch (role) {
    case 'Admin':
      return 'cloud-admin';
    case 'ProjectAdmin':
      return 'project-admin';
    case 'User':
      return 'project-user';
    default:
      return 'unknown';
  }
}

/** True only when the level is POSITIVELY known to be below Cloud Admin ('unknown' is not). */
export function isKnownNotCloudAdmin(level: AccessLevel): boolean {
  return level === 'project-admin' || level === 'project-user' || level === 'project-limited';
}

export function describeLevel(info: AccessInfo): string {
  switch (info.level) {
    case 'cloud-admin':
      return 'Cloud Admin — full access';
    case 'project-admin':
      return 'Project Admin — scoped to one project (v2 infrastructure tools return 403)';
    case 'project-user':
      return 'Project User — scoped to one project, read/test operations (v2 infrastructure tools return 403)';
    case 'project-limited':
      return `project-level access (role "${info.role ?? 'unrecognised'}") — v2 infrastructure tools return 403`;
    default:
      return 'access level could not be determined';
  }
}

// ─── Auth header scheme ───────────────────────────────────────────────────────
// This IS legitimately format-dependent: it is about how the credential is presented, not what it may do.
// JWTs authenticate via Bearer only. Short `aut_1_...` keys additionally need X-API-KEY for CSRF
// exemption on reporter mutation endpoints.

export type AuthScheme = 'bearer' | 'bearer+x-api-key';

export function authSchemeFor(key: string): AuthScheme {
  return key.startsWith('eyJ') ? 'bearer' : 'bearer+x-api-key';
}

export function authHeadersFor(key: string): Record<string, string> {
  return authSchemeFor(key) === 'bearer'
    ? { Authorization: `Bearer ${key}` }
    : { 'X-API-KEY': key, Authorization: `Bearer ${key}` };
}

// ─── Cache ────────────────────────────────────────────────────────────────────
// Keyed by a hash of (url, key), so switching profiles or regenerating a key can never serve a stale
// answer. A TTL covers role changes on an unchanged key. 'unknown' is never cached (retry next call).

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { info: AccessInfo; at: number }>();

/** Stable per-credential key for caches — a hash, so the raw credential never sits in a Map key. */
export function credentialFingerprint(url: string, key: string): string {
  return createHash('sha256').update(`${url.replace(/\/$/, '')}\n${key}`).digest('hex');
}
const fingerprint = credentialFingerprint;

export function peekAccessInfo(url: string, key: string): AccessInfo | undefined {
  const hit = cache.get(fingerprint(url, key));
  if (!hit || Date.now() - hit.at > TTL_MS) return undefined;
  return hit.info;
}

export function rememberAccessInfo(url: string, key: string, info: AccessInfo): void {
  if (info.level === 'unknown') return;
  cache.set(fingerprint(url, key), { info, at: Date.now() });
}

// ─── Server-side sort availability ────────────────────────────────────────────
// Digital.ai has changed which roles may use reporter sort before (live probes on 2026-10-08 showed
// ProjectAdmin and User keys sorting correctly; earlier notes said it was CSRF-blocked). So sort is
// ATTEMPTED for every role, and a credential is only marked "refused" after the platform rejected a
// sorted request AND the same request without sort succeeded (so a bad key is never mistaken for it).

const sortRefused = new Set<string>();

export function isServerSortRefused(url: string, key: string): boolean {
  return sortRefused.has(fingerprint(url, key));
}

export function markServerSortRefused(url: string, key: string): void {
  sortRefused.add(fingerprint(url, key));
}

export function clearAccessInfoCache(): void {
  cache.clear();
  sortRefused.clear();
}

// ─── Test seam ────────────────────────────────────────────────────────────────
// tests/tools.test.ts drives handlers against an unreachable host, so the real resolver can never
// succeed there. Setting an override makes getAccessInfo() return it without any HTTP.

let override: AccessInfo | null = null;

export function setAccessLevelOverrideForTests(level: AccessLevel | null): void {
  override = level === null ? null : { level, source: 'role' };
}

export function getAccessLevelOverride(): AccessInfo | null {
  return override;
}
