import { apiGet } from './client.js';

// GET /api/v2/test-requests/running — the platform's own list of running test requests (Appium/Selenium sessions,
// inspection sessions included). Verified live 2026-10-16: 200 for Cloud Admin, Project Admin and Project User. The
// LIST is scoped to what the caller may see (a project key saw none of another project's sessions) while
// totalRunningTestRequest counts every running request on the platform — so only the list is reported.
// Neighbouring /api/v2/test-requests/key returns the caller's access key: never call or expose it.

export interface RunningTestRequest {
  id: number;
  name: string;
  status: string;
  projectName: string | null;
  projectId: number | null;
  username: string | null;
  deviceName: string | null;
  deviceModel: string | null;
  deviceOs: string | null;
  deviceOsVersion: string | null;
  browser: string | null;
  executionType: string | null;
  appiumServerVersion: string | null;
  deviceQuery: string | null;
  sessionId: string | null;
  createdAt: string | null;
  startedAt: string | null;
}

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
const iso = (v: unknown) => (typeof v === 'number' && v > 0 ? new Date(v).toISOString() : null);

/** Field allow-list: only what a caller needs to identify the run — never pass the raw record through. */
export function normalizeRunningTestRequest(r: Raw): RunningTestRequest {
  return {
    id: Number(r.id),
    name: str(r.name) ?? '(unnamed)',
    status: str(r.status) ?? 'unknown',
    projectName: str(r.projectName),
    // A numeric string ("3") still counts — strict number-only matching would drop every run from a projectId filter.
    projectId: r.projectId != null && r.projectId !== '' && Number.isFinite(Number(r.projectId)) ? Number(r.projectId) : null,
    username: str(r.username),
    deviceName: str(r.deviceName),
    deviceModel: str(r.deviceModel),
    deviceOs: str(r.deviceOs),
    deviceOsVersion: str(r.deviceOsVersion),
    browser: str(r.browserNameAndVersion) ?? str(r.browserName),
    executionType: str(r.executionType),
    appiumServerVersion: str(r.appiumServerVersion),
    deviceQuery: str(r.searchQuery),
    sessionId: str(r.sessionId),
    createdAt: iso(r.createdAt),
    startedAt: iso(r.startedAt),
  };
}

export async function getRunningTestRequests(): Promise<RunningTestRequest[]> {
  try {
    const res = await apiGet<{ runningTestRequests?: Raw[] }>('/api/v2/test-requests/running');
    // A 200 without the list (another envelope, a proxy's HTML page) is not "nothing is running" — throw so the
    // caller falls back to the reporter heuristic instead of reporting an empty farm.
    if (!res || !Array.isArray(res.runningTestRequests)) throw new Error('unexpected response shape (no runningTestRequests list)');
    return res.runningTestRequests.map(normalizeRunningTestRequest);
  } catch (e) {
    throw new Error(`getRunningTestRequests failed: ${(e as Error).message}`);
  }
}
