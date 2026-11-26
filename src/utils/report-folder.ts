/**
 * Where finished reports are saved when the user names no path, as one line for get_server_info. The folder was visible
 * only in `setup doctor`, so an agent could not tell in advance why a report did not land in the workspace folder
 * (a report folder set with setup outranks it; UAT 2026-11-24).
 */
import { getDeploymentMode } from './deployment-mode.js';
import { readReportDirSetting } from './credential-store.js';

/** The configured report folder and where the setting comes from, or null when none is set. */
export function configuredReportFolder(): { dir: string; source: 'env' | 'setup' } | null {
  const env = process.env.MCP_REPORT_DIR?.trim();
  if (env) return { dir: env, source: 'env' }; // also under Docker: a mounted volume the user set up
  const stored = getDeploymentMode() === 'local' ? readReportDirSetting() : {};
  return stored.dir ? { dir: stored.dir, source: 'setup' } : null;
}

export function reportFolderStatusLine(): string {
  const set = configuredReportFolder();
  if (set) return `Report folder: ${set.dir} (${set.source === 'env' ? 'MCP_REPORT_DIR' : 'set with setup'})`;
  return getDeploymentMode() === 'local'
    ? 'Report folder: not set (reports go to the folder the client shares, else a temporary file; set one with setup reports <folder>)'
    : 'Report folder: not set (reports come back to the agent; MCP_REPORT_DIR names a mounted folder)';
}
