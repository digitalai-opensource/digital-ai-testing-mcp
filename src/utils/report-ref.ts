/**
 * Resolve a report reference — a UUID, a numeric test_id, or any reporter URL — to the identifier the API needs.
 *
 * Verified live (2026-10-09):
 *  - GET /reporter/api/reports/{uuid} returns the full report for every role. UUIDs are global: a project key asking
 *    for another project's report gets a clean 403 "no permission", never a different test.
 *  - Numeric test_ids are only unique per reporter scope. On the dev tenant test_id 20 is "Digital.ai Sample Login
 *    Test" for a project key and "Quick Start iOS Native Demo" for a Cloud Admin (no projectName). A numeric lookup
 *    can therefore silently return the WRONG test — prefer the UUID whenever one is available.
 *  - Sessions now print `/reporter/video-report/<uuid>`; 26.8 deprecated `html-report/index.html?test_id=N` in favour
 *    of `/reporter/html-report/<uuid>`. Older `/reporter/reporter/tests/<id>` links still exist in the wild.
 */

export const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export type ReportRef = { kind: 'uuid'; uuid: string } | { kind: 'testId'; testId: number };

/** Parse a UUID, a numeric id, or a report URL. A UUID anywhere in the input wins over a number. null = unrecognised. */
export function parseReportRef(input: string | number | null | undefined): ReportRef | null {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isInteger(input) && input > 0 ? { kind: 'testId', testId: input } : null;
  const s = input.trim();
  if (!s) return null;
  const uuid = s.match(UUID_PATTERN)?.[0];
  if (uuid) return { kind: 'uuid', uuid: uuid.toLowerCase() };
  if (/^\d+$/.test(s)) return { kind: 'testId', testId: Number(s) };
  const q = s.match(/[?&]test_id=(\d+)/i) ?? s.match(/\/tests\/(\d+)(?:[/?#]|$)/i) ?? s.match(/\/(\d+)\/?(?:[?#].*)?$/);
  return q ? { kind: 'testId', testId: Number(q[1]) } : null;
}
