import { apiGet } from './client.js';
import type { ReporterProject } from '../types/digital-ai.js';

// Reporter API — Cloud Admin (JWT) only. Project keys receive 401.
// Returns per-project storage metrics (disk usage, test counts, quotas).

export async function getReporterProjects(): Promise<ReporterProject[]> {
  try {
    const res = await apiGet<ReporterProject[]>('/reporter/api/projects');
    return Array.isArray(res) ? res : [];
  } catch (e) {
    throw new Error(`getReporterProjects failed: ${(e as Error).message}`);
  }
}
