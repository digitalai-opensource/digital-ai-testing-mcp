/**
 * Update check — the network half (see src/utils/update-check.ts for the rules and the wording).
 *
 * Asks GitHub for the newest published release of this server, at most once per 24 h per machine:
 *   1. GET https://api.github.com/repos/<repo>/releases/latest → `tag_name` (drafts and pre-releases are never "latest")
 *   2. if that fails (the unauthenticated API allows 60 requests an hour per IP — an office behind one address can
 *      exhaust it — or a proxy allows github.com but not api.github.com): GET https://github.com/<repo>/releases/latest
 *      without following the redirect and read the tag from its Location header.
 * Bare axios (honours HTTPS_PROXY like the rest of the server), short timeout, no credentials and nothing about the
 * user, tenant or machine in the request. runUpdateCheck never throws and is not awaited by startup.
 */
import axios from 'axios';
import {
  RELEASES_REPO,
  isNewerVersion,
  isUpdateCheckEnabled,
  isWithinInterval,
  normalizeVersion,
  parseVersion,
  readUpdateState,
  setAvailableUpdate,
  writeUpdateState,
} from '../utils/update-check.js';

const DEFAULT_TIMEOUT_MS = 5000;
const HEADERS = { 'User-Agent': 'digital-ai-testing-mcp-update-check' };

export interface UpdateCheckOptions {
  /** The running version (getServerVersion()). */
  current: string;
  now?: number;
  stateFile?: string;
  /** Overridable for tests. */
  apiUrl?: string;
  webUrl?: string;
  timeoutMs?: number;
}

/** The newest release version ("2.4.0"). Throws when neither source gives a plain release version. */
export async function fetchLatestReleaseVersion(opts: Pick<UpdateCheckOptions, 'apiUrl' | 'webUrl' | 'timeoutMs'> = {}): Promise<string> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const apiUrl = opts.apiUrl ?? `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
  const webUrl = opts.webUrl ?? `https://github.com/${RELEASES_REPO}/releases/latest`;
  let apiFailure: string;
  try {
    const res = await axios.get<{ tag_name?: unknown }>(apiUrl, { timeout, headers: { ...HEADERS, Accept: 'application/vnd.github+json' } });
    const version = normalizeVersion(res.data?.tag_name);
    if (version) return version;
    apiFailure = 'no release version in the API response';
  } catch (e) {
    apiFailure = (e as Error).message;
  }
  const res = await axios.get(webUrl, { timeout, headers: HEADERS, maxRedirects: 0, validateStatus: (s) => s >= 300 && s < 400 });
  const tag = /\/releases\/tag\/([^/?#]+)$/.exec(String(res.headers['location'] ?? ''))?.[1];
  const version = normalizeVersion(tag);
  if (!version) throw new Error(`no release version from GitHub (API: ${apiFailure}; redirect: ${String(res.headers['location'] ?? 'none')})`);
  return version;
}

export interface UpdateCheckResult {
  /**
   * disabled — MCP_UPDATE_CHECK=false; skipped — the running version is not a plain release version (a dev build or an
   * MCP_SERVER_VERSION override); cached — GitHub was asked less than 24 h ago; checked — asked now; failed — asked
   * now, no answer (the attempt still counts for the 24 h).
   */
  status: 'disabled' | 'skipped' | 'cached' | 'checked' | 'failed';
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

/**
 * Decide whether a newer release exists, asking GitHub only when the last attempt is more than 24 h old, and publish
 * the answer for the notice and the status line (setAvailableUpdate).
 */
export async function runUpdateCheck(opts: UpdateCheckOptions): Promise<UpdateCheckResult> {
  const { current } = opts;
  const none = (status: UpdateCheckResult['status']): UpdateCheckResult => ({ status, current, latest: null, updateAvailable: false });
  try {
    if (!isUpdateCheckEnabled()) return none('disabled');
    if (!parseVersion(current)) return none('skipped');
    const now = opts.now ?? Date.now();
    const state = readUpdateState(opts.stateFile);
    let latest = state.latest ?? null;
    let status: UpdateCheckResult['status'] = 'cached';
    if (!isWithinInterval(state.checkedAt, now)) {
      const fetched = await fetchLatestReleaseVersion(opts).catch(() => null);
      status = fetched ? 'checked' : 'failed';
      if (fetched) latest = fetched;
      // Re-read: another server process may have recorded a delivered notice while the request was in flight.
      writeUpdateState({ ...readUpdateState(opts.stateFile), checkedAt: now, ...(latest ? { latest } : {}) }, opts.stateFile);
    }
    const updateAvailable = latest !== null && isNewerVersion(latest, current);
    setAvailableUpdate(updateAvailable ? latest : null, current);
    return { status, current, latest, updateAvailable };
  } catch {
    return none('failed');
  }
}
