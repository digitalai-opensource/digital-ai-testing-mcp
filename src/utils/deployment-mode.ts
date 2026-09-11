// Resolves how this MCP server process is being run, so tool descriptions and
// a handful of behavioral checks (see application-tools.ts's HOST_PATH_UNREACHABLE
// guard) can give the agent one correct answer instead of an unconditional
// Docker-only framing. Read once at startup — deployment mode cannot change
// mid-process, so there is no reason to re-read process.env per call.
export type DeploymentMode = 'docker' | 'local' | 'http';

/**
 * 'docker' (default) — server runs in a container or other remote/sandboxed
 *   host; its filesystem is NOT the caller's. This is the safe default for
 *   any unset or unrecognized value, so existing Docker/GHCR deployments see
 *   no behavior change.
 * 'local' — server runs directly on the user's own machine (the npm
 *   package's install path). Its filesystem IS the caller's.
 * 'http' — reserved for a future HTTP-transport distribution; not yet
 *   implemented. Falls back to the cautious 'docker' framing until it is.
 *
 * Reads process.env directly rather than caching — deployment mode doesn't
 * change within a real process's lifetime, so there's no hot-path cost to
 * worry about, and staying uncached keeps this trivially testable under both
 * modes in the same test run.
 */
export function getDeploymentMode(): DeploymentMode {
  const raw = (process.env.MCP_DEPLOYMENT_MODE ?? '').trim().toLowerCase();
  return raw === 'local' ? 'local' : raw === 'http' ? 'http' : 'docker';
}

/** True only when the server's filesystem is verifiably the caller's own machine. */
export function isLocalFilesystem(): boolean {
  return getDeploymentMode() === 'local';
}
