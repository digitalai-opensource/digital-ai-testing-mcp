// Resolves how this MCP server process is being run, so tool descriptions and
// a handful of behavioral checks (see application-tools.ts's HOST_PATH_UNREACHABLE
// guard) can give the agent one correct answer instead of an unconditional
// Docker-only framing. Tool descriptions call it once at registration time;
// the function itself reads process.env on every call (see below).
import { existsSync } from 'node:fs';

export type DeploymentMode = 'docker' | 'local' | 'http';

let _inContainerOverride: boolean | undefined;

/** Test hook: pretend the process is (true) or is not (false) in a container; undefined = detect. */
export function setContainerOverrideForTests(v: boolean | undefined): void {
  _inContainerOverride = v;
}

/** A container marker file: Docker's /.dockerenv, Podman's /run/.containerenv. */
export function runningInContainer(): boolean {
  if (_inContainerOverride !== undefined) return _inContainerOverride;
  return existsSync('/.dockerenv') || existsSync('/run/.containerenv');
}

/**
 * MCP_DEPLOYMENT_MODE:
 * 'local' — server runs directly on the user's own machine (the npm package, a source checkout). Its filesystem IS
 *   the caller's.
 * 'docker' — server runs in a container or other remote/sandboxed host; its filesystem is NOT the caller's. The
 *   published image sets this explicitly (Dockerfile).
 * 'http' — reserved for a future HTTP-transport distribution; not yet implemented. Falls back to the cautious
 *   'docker' framing until it is.
 * Unset or empty → 'docker' inside a container, else 'local' (since 2.4.0; before, unset always meant 'docker', so
 *   every npm configuration had to set 'local'). An UNRECOGNIZED value (a typo) stays 'docker', the cautious framing.
 *
 * Reads process.env directly rather than caching — deployment mode doesn't change within a real process's lifetime,
 * so there's no hot-path cost to worry about, and staying uncached keeps this trivially testable under both modes in
 * the same test run.
 */
export function getDeploymentMode(): DeploymentMode {
  const raw = (process.env.MCP_DEPLOYMENT_MODE ?? '').trim().toLowerCase();
  if (raw === 'local') return 'local';
  if (raw === 'http') return 'http';
  if (raw === '') return runningInContainer() ? 'docker' : 'local';
  return 'docker';
}

/** True only when the server's filesystem is verifiably the caller's own machine. */
export function isLocalFilesystem(): boolean {
  return getDeploymentMode() === 'local';
}
