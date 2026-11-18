/**
 * Update check — tells the user when a newer release of this server exists, with the update steps for the way THIS
 * process was installed (npm, npx, source checkout or Docker).
 *
 * The lookup itself is in src/api/update-check.ts (GitHub Releases, at most once per 24 h). This file is the pure part:
 * version comparison, the small state file that enforces the 24 h limits, install detection and the wording.
 *
 * How the user hears about it:
 *  1. One NOTICE per day, placed FIRST in the first successful tool result after the check (withNudge: a
 *     `_updateAvailable` field in a JSON payload, else a leading text item) — stderr is not shown by most clients and
 *     server instructions are fixed before the check has answered, so a tool result is the only channel that reaches
 *     the agent, and through it the user.
 *  2. A status line in get_server_info / check_connectivity for as long as the update is pending.
 *  3. A stderr line at startup (the client's MCP log).
 * MCP_UPDATE_CHECK=false turns all of it off: no request, no wrapper, no state file.
 *
 * The state file lives in the OS temp folder. A `docker run --rm` container starts with an empty one, so under Docker
 * the limits are per container start, not per day — the server cannot keep state there without a mounted volume.
 *
 * Nothing from the network or the state file reaches the notice except a version that matched STRICT_VERSION_RE:
 * the release URL and the commands are built here, never copied from a response.
 */
import { readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { getDeploymentMode } from './deployment-mode.js';
import { withNudge } from './remediation.js';

export const RELEASES_REPO = 'digitalai-opensource/digital-ai-testing-mcp';
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const STRICT_VERSION_RE = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** On unless MCP_UPDATE_CHECK is false/0/no/off. Read live, like getDeploymentMode, so tests can flip it. */
export function isUpdateCheckEnabled(): boolean {
  return !/^(false|0|no|off)$/i.test((process.env.MCP_UPDATE_CHECK ?? '').trim());
}

/** "2.3.3" / "v2.3.3" → [2, 3, 3]; anything else (pre-releases, "dev", free text) → null. */
export function parseVersion(v: unknown): [number, number, number] | null {
  const m = typeof v === 'string' ? STRICT_VERSION_RE.exec(v.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** "v2.4.0" → "2.4.0"; null when it is not a plain release version. */
export function normalizeVersion(v: unknown): string | null {
  const p = parseVersion(v);
  return p ? p.join('.') : null;
}

/** True only when both parse and `latest` is strictly higher. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// ── State file ───────────────────────────────────────────────────────────────

export interface UpdateState {
  /** When GitHub was last asked (epoch ms) — success or failure, so a blocked network is not retried on every start. */
  checkedAt?: number;
  /** Newest release seen. */
  latest?: string;
  /** When the notice was last delivered in a tool result, and for which release. */
  notifiedAt?: number;
  notifiedVersion?: string;
}

export function updateStateFile(): string {
  return join(tmpdir(), 'digital-ai-testing-mcp-update-check.json');
}

const time = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

/** Missing, unreadable or malformed → {}. Every field is validated: the temp folder is writable by other programs. */
export function readUpdateState(file: string = updateStateFile()): UpdateState {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const state: UpdateState = {};
    const checkedAt = time(raw.checkedAt);
    const notifiedAt = time(raw.notifiedAt);
    const latest = normalizeVersion(raw.latest);
    const notifiedVersion = normalizeVersion(raw.notifiedVersion);
    if (checkedAt) state.checkedAt = checkedAt;
    if (latest) state.latest = latest;
    if (notifiedAt) state.notifiedAt = notifiedAt;
    if (notifiedVersion) state.notifiedVersion = notifiedVersion;
    return state;
  } catch {
    return {};
  }
}

/** Best effort — a read-only temp folder only means the next start checks again. */
export function writeUpdateState(state: UpdateState, file: string = updateStateFile()): void {
  try {
    writeFileSync(file, JSON.stringify(state));
  } catch {
    // nothing to do
  }
}

/** Within the last 24 h. A timestamp in the future (clock change) counts as stale. */
export function isWithinInterval(at: number | undefined, now: number): boolean {
  return at !== undefined && now >= at && now - at < UPDATE_CHECK_INTERVAL_MS;
}

// ── How this process was installed → how to update it ────────────────────────

export type InstallKind = 'npm' | 'npx' | 'source' | 'docker';

/**
 * docker — any deployment mode but local (an unset mode is local outside a container). Under local, the path of the running code tells the rest:
 * npx runs from <npm cache>/_npx/…, an npm install from …/node_modules/digital-ai-testing-mcp/…, and anything else is a
 * source checkout (git clone + npm run build).
 */
export function installKind(modulePath: string = fileURLToPath(import.meta.url)): InstallKind {
  if (getDeploymentMode() !== 'local') return 'docker';
  const p = modulePath.replace(/\\/g, '/');
  if (p.includes('/_npx/')) return 'npx';
  if (p.includes('/node_modules/digital-ai-testing-mcp/')) return 'npm';
  return 'source';
}

const RESTART = 'restart your AI client or reconnect this MCP server';

export function updateSteps(kind: InstallKind = installKind()): string {
  switch (kind) {
    case 'npm':
      return `Run \`npm install -g digital-ai-testing-mcp@latest\`, then ${RESTART} (a server that is already running keeps its version).`;
    case 'npx':
      return (
        `${RESTART[0].toUpperCase()}${RESTART.slice(1)} — npx fetches the newest release when the server starts. ` +
        'If it still reports the old version, name the package `digital-ai-testing-mcp@latest` in the client configuration.'
      );
    case 'source':
      return `In the server's folder run \`git pull\`, \`npm ci\` and \`npm run build\`, then ${RESTART}.`;
    case 'docker':
      return (
        'Run `docker pull ghcr.io/digitalai-opensource/digital-ai-testing-mcp:latest` (image built from source: ' +
        `\`git pull\`, then \`docker build -t digital-ai-testing-mcp:latest .\`), then ${RESTART} — the next start uses the new image.`
      );
  }
}

export function releaseUrl(version: string): string {
  return `https://github.com/${RELEASES_REPO}/releases/tag/v${version}`;
}

/** The once-a-day notice, written for the agent to pass on. */
export function updateNotice(latest: string, current: string, kind: InstallKind = installKind()): string {
  return (
    `UPDATE AVAILABLE: digital-ai-testing-mcp v${latest} has been released; this server is v${current}. ` +
    'Tell the user once, after finishing their current request, and give them these steps (do not run them yourself unless asked): ' +
    `${updateSteps(kind)} Release notes: ${releaseUrl(latest)} ` +
    '(This notice appears at most once a day; MCP_UPDATE_CHECK=false turns the check off.)'
  );
}

// ── What the check found (per process) ───────────────────────────────────────

let available: { latest: string; current: string } | null = null;
let noticeSettled = false;

/** Called by runUpdateCheck: the newer release, or null when the server is up to date. */
export function setAvailableUpdate(latest: string | null, current: string): void {
  available = latest ? { latest, current } : null;
}

export function getAvailableUpdate(): { latest: string; current: string } | null {
  return available;
}

export function resetUpdateCheckForTests(): void {
  available = null;
  noticeSettled = false;
}

/** Status line for get_server_info / check_connectivity while an update is pending; null otherwise. */
export function updateStatusLine(): string | null {
  if (!available || !isUpdateCheckEnabled()) return null;
  return `Update available: v${available.latest} (running v${available.current}) — ${updateSteps()}`;
}

/**
 * The notice, if one is due: an update is known, this process has not decided yet, and no notice for this release was
 * delivered in the last 24 h (by any server process on this machine — the state file is shared). Decides once per
 * process, so the state file is read at most once and never when the server is up to date.
 */
export function takeUpdateNotice(opts: { now?: number; stateFile?: string } = {}): string | null {
  if (!available || noticeSettled) return null;
  noticeSettled = true;
  const now = opts.now ?? Date.now();
  const state = readUpdateState(opts.stateFile);
  if (state.notifiedVersion === available.latest && isWithinInterval(state.notifiedAt, now)) return null;
  writeUpdateState({ ...state, notifiedAt: now, notifiedVersion: available.latest }, opts.stateFile);
  return updateNotice(available.latest, available.current);
}

type Handler = (...a: unknown[]) => unknown;

/**
 * Wrap a tool callback so the first successful result after an update was found carries the notice. With nothing
 * pending — the usual case — the result is returned untouched (same object) after one boolean test. Errors are left
 * alone: a notice next to an error reads as its cause.
 */
export function withUpdateNotice(callback: Handler, opts: { stateFile?: string } = {}): Handler {
  return async (...a: unknown[]) => {
    const result = await callback(...a);
    if (!available || noticeSettled) return result;
    const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
    if (!r || r.isError || !Array.isArray(r.content)) return result;
    try {
      const notice = takeUpdateNotice(opts);
      return notice ? withNudge(r, notice, '_updateAvailable') : result;
    } catch {
      return result; // a notice must never break a working tool
    }
  };
}
