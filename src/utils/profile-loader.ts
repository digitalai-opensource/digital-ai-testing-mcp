/**
 * Connection profile loader — environment variables plus the local credential store.
 *
 * Environment (always wins):
 *   DIGITAL_AI_BASE_URL + DIGITAL_AI_ACCESS_KEY      → profile "default", the starting connection
 *   DAI_PROFILE_{NAME}_URL + DAI_PROFILE_{NAME}_KEY  → profile "{name}"
 *
 * Credential store (src/utils/credential-store.ts, off with MCP_CREDENTIAL_STORE=off): its profiles are added under
 * their own names, except a name the environment already defines (that store entry is "shadowed" and ignored). The
 * store's default profile is the starting connection only when the environment sets NEITHER default variable; if it
 * sets only one, the server reports the missing one (setup mode) instead of quietly mixing sources.
 *
 * Key format is NOT a privilege indicator (a Cloud Admin may hold either an eyJ... JWT or a short
 * aut_1_... key). A profile's access level is resolved from the API — see src/api/access-level.ts.
 *
 * Profile names are case-insensitive and normalised to lowercase internally.
 * Examples:
 *   DAI_PROFILE_PRODUCTION_URL / DAI_PROFILE_PRODUCTION_KEY  → "production"
 *   DAI_PROFILE_QA_TEAM_URL   / DAI_PROFILE_QA_TEAM_KEY     → "qa_team"
 *
 * Profiles are scanned on first access. Because ES module imports are evaluated
 * before statement-level code in the importer (i.e. before dotenv.config() runs),
 * eager evaluation at module load time would see empty env vars. The lazy singleton
 * below ensures env vars are read only when the first profile function is called,
 * by which point dotenv has already populated process.env.
 *
 * Credentials are read only here (env and store) and handed out only to src/api/client.ts and access-level.ts.
 */
import { readStore, type StoreReadResult } from './credential-store.js';

export type ProfileSource = 'env' | 'store';

export interface EnvironmentProfile {
  name: string;
  url: string;
  source: ProfileSource;
}

interface FullProfile extends EnvironmentProfile {
  key: string;
}

interface Loaded {
  profiles: Record<string, FullProfile>;
  store: StoreReadResult;
  /** Store profiles ignored because the environment defines the same name. */
  shadowed: string[];
}

const DEFAULT_VARS = ['DIGITAL_AI_BASE_URL', 'DIGITAL_AI_ACCESS_KEY'] as const;

function envDefault(): { url: string; key: string } | undefined {
  const url = process.env.DIGITAL_AI_BASE_URL?.trim();
  const key = process.env.DIGITAL_AI_ACCESS_KEY?.trim();
  return url && key ? { url: url.replace(/\/$/, ''), key } : undefined;
}

function loadProfiles(): Loaded {
  const profiles: Record<string, FullProfile> = {};

  // Always include the default profile from the primary env vars.
  const def = envDefault();
  if (def) profiles['default'] = { name: 'default', source: 'env', ...def };

  // Scan for DAI_PROFILE_*_URL pattern.
  for (const [envKey, value] of Object.entries(process.env)) {
    if (!value) continue;
    const match = envKey.match(/^DAI_PROFILE_(.+?)_URL$/);
    if (!match) continue;
    const rawName = match[1];
    const profileName = rawName.toLowerCase();
    const apiKey = process.env[`DAI_PROFILE_${rawName}_KEY`];
    if (!apiKey) continue;
    profiles[profileName] = {
      name: profileName,
      url: value.replace(/\/$/, ''),
      key: apiKey,
      source: 'env',
    };
  }

  const store = readStore();
  const shadowed: string[] = [];
  for (const [name, p] of Object.entries(store.profiles)) {
    if (name in profiles) shadowed.push(name);
    else profiles[name] = { name, url: p.url, key: p.key, source: 'store' };
  }

  return { profiles, store, shadowed };
}

// Lazily initialised on first access — ensures dotenv has run before we read env vars.
let _loaded: Loaded | null = null;

function getLoaded(): Loaded {
  if (!_loaded) _loaded = loadProfiles();
  return _loaded;
}

function getProfiles(): Record<string, FullProfile> {
  return getLoaded().profiles;
}

/** Test helper: forget the cached profiles so the next call re-reads env and store. */
export function resetProfilesForTests(): void {
  _loaded = null;
}

/** All configured profiles without their keys — safe to surface in tool responses. */
export function listProfiles(): EnvironmentProfile[] {
  return Object.values(getProfiles()).map(({ name, url, source }) => ({ name, url, source }));
}

/** Retrieve a profile's full credentials by name (case-insensitive). */
export function getProfileCredentials(name: string): { url: string; key: string } | undefined {
  const p = getProfiles()[name.toLowerCase()];
  return p ? { url: p.url, key: p.key } : undefined;
}

/** Check whether a named profile exists. */
export function profileExists(name: string): boolean {
  return name.toLowerCase() in getProfiles();
}

/** Number of configured profiles (including default). */
export function profileCount(): number {
  return Object.keys(getProfiles()).length;
}

/** The store profile that starts the session when the environment sets neither default variable. */
function storeStartingName(): string | undefined {
  if (DEFAULT_VARS.some((k) => process.env[k]?.trim())) return undefined;
  const { profiles, store } = getLoaded();
  // A default that names a profile the environment also defines starts on the environment's version (env wins).
  if (store.defaultProfile && store.defaultProfile in profiles) return store.defaultProfile;
  // No "default" at all and exactly one store profile: that one. A "default" that names a broken profile never
  // falls through to another one.
  const defaultGiven = store.skipped.some((s) => s.name === '(default)');
  const fromStore = Object.values(profiles).filter((p) => p.source === 'store');
  if (!store.defaultProfile && !defaultGiven && fromStore.length === 1) return fromStore[0].name;
  return undefined;
}

/**
 * The connection the server starts on — for src/api/client.ts only (it carries the key). The environment's default
 * is read live, exactly as before the store existed; the store is consulted only when neither default variable is set.
 */
export function getStartingProfile(): { name: string; url: string; key: string; source: ProfileSource } | undefined {
  const def = envDefault();
  if (def) return { name: 'default', source: 'env', ...def };
  const name = storeStartingName();
  const p = name ? getProfiles()[name] : undefined;
  return p ? { name: p.name, url: p.url, key: p.key, source: p.source } : undefined;
}

/** Same as getStartingProfile, without the key — safe for logs and tool output. */
export function describeStartingProfile(): EnvironmentProfile | undefined {
  const p = getStartingProfile();
  return p ? { name: p.name, url: p.url, source: p.source } : undefined;
}

export interface StartupCredentialProblem {
  /** Environment variables to name in the setup instructions. */
  missing: string[];
  /** Why the credential store did not supply a starting connection, when it exists. Never contains a key. */
  storeNote?: string;
}

/**
 * Null when the server has a starting connection. Otherwise what is missing — used at startup to decide whether the
 * server runs normally or in setup mode (src/utils/setup-guidance.ts). Checks presence only; never returns a value.
 */
export function startupCredentialProblem(): StartupCredentialProblem | null {
  const missing = DEFAULT_VARS.filter((k) => !process.env[k]?.trim());
  // Exactly one default variable set: report it rather than fall back to the store behind the user's back.
  if (missing.length === 1) return { missing };
  if (getStartingProfile()) return null;

  const { profiles, store } = getLoaded();
  let storeNote: string | undefined;
  if (store.error) {
    storeNote = `The credential store at ${store.path} could not be used: ${store.error}.`;
  } else if (store.exists) {
    const names = Object.values(profiles).filter((p) => p.source === 'store').map((p) => p.name);
    storeNote =
      names.length === 0
        ? `The credential store at ${store.path} has no usable profile.`
        : `The credential store at ${store.path} has profiles (${names.join(', ')}) but no usable "default" naming the one to start with.`;
  }
  if (storeNote && store.skipped.length > 0) {
    storeNote += ' Skipped: ' + store.skipped.map((s) => `${s.name} — ${s.reason}`).join('; ') + '.';
  }
  return { missing: [...DEFAULT_VARS], storeNote };
}

export interface StoreStatus {
  enabled: boolean;
  path: string;
  exists: boolean;
  error?: string;
  skipped: Array<{ name: string; reason: string }>;
  shadowed: string[];
}

/** The credential store's state, without keys — for list_environments. */
export function getStoreStatus(): StoreStatus {
  const { store, shadowed } = getLoaded();
  return { enabled: store.enabled, path: store.path, exists: store.exists, error: store.error, skipped: store.skipped, shadowed };
}
