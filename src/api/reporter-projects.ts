import { apiGet } from './client.js';
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
