/**
 * Reporter test statuses — one definition of the status set, how each counts, and the pass rate.
 *
 * Verified live (2026-10-09) on POST /reporter/api/tests/grouped with pivotBy ["status"]: the reporter has SIX statuses,
 * not three. Tools that hardcoded Passed/Failed/Incomplete silently dropped the rest — on the dev tenant ~27k Error
 * records (the second-largest failure bucket) never appeared in any summary. Platform 26.9 made this worse: tests
 * interrupted by a client crash or an infrastructure problem now end as Error ("Device Session ended before test
 * completion") instead of Incomplete.
 *
 * status_code values observed live: Healed=5, Error=4, Skipped=3. `success` is FALSE for Healed (and for Error and
 * Skipped), so `success` alone is not a reliable "passed" signal — classify by status.
 */

export const TEST_STATUSES = ['Passed', 'Failed', 'Error', 'Incomplete', 'Skipped', 'Healed'] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

/** Passed outright, or passed after self-healing a locator. */
export const PASSING_STATUSES: readonly TestStatus[] = ['Passed', 'Healed'];
/** Failed an assertion (Failed) or ended abnormally — crash, infrastructure, session ended early (Error). */
export const FAILING_STATUSES: readonly TestStatus[] = ['Failed', 'Error'];

export const PASS_RATE_BASIS =
  '(Passed + Healed) / (Passed + Healed + Failed + Error). Incomplete (still running, or ended without a verdict) and Skipped are excluded.';

export type StatusOutcome = 'pass' | 'fail' | 'other';

export function statusOutcome(status: string | null | undefined): StatusOutcome {
  if ((PASSING_STATUSES as readonly string[]).includes(status ?? '')) return 'pass';
  if ((FAILING_STATUSES as readonly string[]).includes(status ?? '')) return 'fail';
  return 'other';
}

export interface StatusCounts {
  passed: number;
  failed: number;
  error: number;
  incomplete: number;
  skipped: number;
  healed: number;
  /** Every record, including any status this code does not know yet. */
  total: number;
}

export function emptyStatusCounts(): StatusCounts {
  return { passed: 0, failed: 0, error: 0, incomplete: 0, skipped: 0, healed: 0, total: 0 };
}

/**
 * Counts from a reporter pivot row — the shape returned by both POST /reporter/api/tests/grouped (pivotBy ["status"])
 * and GET /reporter/api/testView/{id}/summary: { passedCount, failedCount, incompleteCount, skippedCount, errorCount,
 * healedCount, _count_ }. Missing columns count as 0; `total` prefers the server's `_count_` so a status added later
 * still shows up in the total even before this code learns its name.
 */
export function countsFromPivotRow(row: Record<string, unknown> | null | undefined): StatusCounts {
  const n = (k: string) => {
    const v = Number(row?.[k] ?? 0);
    return Number.isFinite(v) ? v : 0;
  };
  const c: StatusCounts = {
    passed: n('passedCount'),
    failed: n('failedCount'),
    error: n('errorCount'),
    incomplete: n('incompleteCount'),
    skipped: n('skippedCount'),
    healed: n('healedCount'),
    total: 0,
  };
  const known = c.passed + c.failed + c.error + c.incomplete + c.skipped + c.healed;
  c.total = row?.['_count_'] != null ? Math.max(n('_count_'), known) : known;
  return c;
}

/** Tally a list of records (each with a `status`) — for client-side buckets over list results. */
export function tallyStatuses(records: Array<{ status?: string | null }>): StatusCounts {
  const c = emptyStatusCounts();
  for (const r of records) {
    c.total++;
    switch (r.status) {
      case 'Passed': c.passed++; break;
      case 'Failed': c.failed++; break;
      case 'Error': c.error++; break;
      case 'Incomplete': c.incomplete++; break;
      case 'Skipped': c.skipped++; break;
      case 'Healed': c.healed++; break;
      default: break; // unknown status: in total only
    }
  }
  return c;
}

/** Pass rate in percent (1 decimal) over decided outcomes — see PASS_RATE_BASIS. null when nothing has a verdict. */
export function passRate(c: StatusCounts): number | null {
  const pass = c.passed + c.healed;
  const decided = pass + c.failed + c.error;
  return decided > 0 ? Math.round((pass / decided) * 1000) / 10 : null;
}

/** Records not covered by the six known statuses (non-zero only if the platform adds a status). */
export function unknownStatusCount(c: StatusCounts): number {
  return Math.max(0, c.total - (c.passed + c.failed + c.error + c.incomplete + c.skipped + c.healed));
}
