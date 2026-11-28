/**
 * Runs of tests generated from an app exploration (stage 3), found in the reporter by their report key
 * digitalai:explorationRun (column "explorationRun") and the flow each test records (column "explorationFlow").
 * Verified live 2026-11-27: a filter on the custom column over a whole project timed out after 30 s; bounded by the first
 * test id since the exploration (firstTestIdSince) it answered in about 3.5 s.
 */
import { listTests } from './reporting.js';
import { firstTestIdSince } from './report-recipes.js';

export interface ExplorationRun { testId: number; flow?: string; status: string; startTime?: string; name: string }

/** The runs carrying this exploration's key since `sinceMs`, newest first (at most `limit`). */
export async function explorationRuns(jobId: string, sinceMs: number, limit = 200): Promise<ExplorationRun[]> {
  const first = await firstTestIdSince(sinceMs);
  if (first === null) return [];
  const res = await listTests({
    filter: [{ property: 'test_id', operator: '>=', value: first }, { property: 'explorationRun', operator: '=', value: jobId }],
    keys: ['explorationFlow'], limit,
  });
  const rows = (res.data ?? []) as unknown as Array<Record<string, unknown>>;
  return rows
    .map((t) => ({
      testId: Number(t.test_id), status: String(t.status ?? ''), name: String(t.name ?? ''),
      ...(t.explorationFlow ? { flow: String(t.explorationFlow) } : {}),
      ...(t.start_time ? { startTime: String(t.start_time) } : {}),
    }))
    .sort((a, b) => b.testId - a.testId);
}
