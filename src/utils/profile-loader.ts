/**
 * Environment profile loader.
 *
 * The default profile is always read from DIGITAL_AI_BASE_URL + DIGITAL_AI_ACCESS_KEY.
 * Named profiles follow the pattern:
 *
 *   DAI_PROFILE_{NAME}_URL=https://tenant.experitest.com/
 *   DAI_PROFILE_{NAME}_KEY=<access key>
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
 */

export interface EnvironmentProfile {
  name: string;
  url: string;
}

interface FullProfile extends EnvironmentProfile {
  key: string;
}

function loadProfiles(): Record<string, FullProfile> {
  const profiles: Record<string, FullProfile> = {};

  // Always include the default profile from the primary env vars.
  const defaultUrl = process.env.DIGITAL_AI_BASE_URL;
  const defaultKey = process.env.DIGITAL_AI_ACCESS_KEY;
  if (defaultUrl && defaultKey) {
    profiles['default'] = {
      name: 'default',
      url: defaultUrl.replace(/\/$/, ''),
      key: defaultKey,
    };
  }

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
    };
  }

  return profiles;
}

// Lazily initialised on first access — ensures dotenv has run before we read env vars.
let _profiles: Record<string, FullProfile> | null = null;

function getProfiles(): Record<string, FullProfile> {
  if (!_profiles) {
    _profiles = loadProfiles();
  }
  return _profiles;
}

/** All configured profiles without their keys — safe to surface in tool responses. */
export function listProfiles(): EnvironmentProfile[] {
  return Object.values(getProfiles()).map(({ name, url }) => ({ name, url }));
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
