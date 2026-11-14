import { apiGet, getActiveUrl, getActiveAccessKey } from './client.js';
import { credentialFingerprint } from '../utils/access-level.js';
import type { ReporterProject } from '../types/digital-ai.js';

// Reporter API. Cloud Admin sees every project; a Project Admin sees its own project; a Project User gets an
// empty list (verified live). Includes the per-project allowUsersDeleteTests flag.
// Returns per-project storage metrics (disk usage, test counts, quotas).

export async function getReporterProjects(): Promise<ReporterProject[]> {
  try {
    const res = await apiGet<ReporterProject[]>('/reporter/api/projects');
    return Array.isArray(res) ? res : [];
  } catch (e) {
    throw new Error(`getReporterProjects failed: ${(e as Error).message}`);
  }
}

/** Shared parameter text for every reporter tool's projectId. */
export const REPORTER_PROJECT_ID_DESC =
  'REPORTER project ID — the project_id on a report record, or the id from get_reporter_project_storage. It is NOT the ' +
  'cloud project ID that get_server_info / check_connectivity / list_projects show (the two differ: the Default project ' +
  'was 2 there and 1 in the reporter). Resolved to the project name before the call; prefer projectName.';

const nameCache = new Map<string, { at: number; names: Map<number, string> }>();
/** In-flight lookups per credential, so parallel reporter calls on a cold cache share one /reporter/api/projects fetch. */
const inflight = new Map<string, Promise<Map<number, string>>>();
const CACHE_MS = 10 * 60_000;

/**
 * The reporter scopes by projectName only: a numeric projectId query param is CSRF-blocked, and a project_id FILTER only
 * filters inside the current reporter context (verified live 2026-11-13 — project_id = 89 from the Default context gave
 * 0 records, projectName "DigitalSSO" gave 3.1M). So a reporter projectId is mapped to its name through
 * /reporter/api/projects. projectName wins when both are given. Throws when the id cannot be resolved — silently
 * ignoring it (the old behaviour) answered for the wrong project.
 */
export async function resolveReporterProjectName(projectId?: number, projectName?: string): Promise<string | undefined> {
  if (projectName || projectId === undefined) return projectName;
  const cacheKey = credentialFingerprint(getActiveUrl(), getActiveAccessKey() ?? '');
  let names = nameCache.get(cacheKey)?.names;
  const fresh = (nameCache.get(cacheKey)?.at ?? 0) > Date.now() - CACHE_MS;
  if (!names || !fresh || !names.has(projectId)) {
    let pending = inflight.get(cacheKey);
    if (!pending) {
      pending = getReporterProjects()
        .then((projects) => {
          const m = new Map(projects.map((p) => [Number(p.id), String(p.name)] as [number, string]));
          nameCache.set(cacheKey, { at: Date.now(), names: m });
          return m;
        })
        .finally(() => inflight.delete(cacheKey));
      inflight.set(cacheKey, pending);
    }
    names = await pending;
  }
  const name = names.get(projectId);
  if (!name) {
    throw new Error(
      `Reporter project ID ${projectId} is not one this credential can see in the reporter ` +
      `(${names.size} visible). Pass projectName instead — note the reporter's project IDs differ from the cloud ` +
      'project IDs that get_server_info and list_projects show.'
    );
  }
  return name;
}

/** Test seam. */
export function clearReporterProjectNameCacheForTests(): void {
  nameCache.clear();
  inflight.clear();
}
