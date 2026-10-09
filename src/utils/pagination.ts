export const DEFAULT_MAX_RESULTS = 50;
export const ABSOLUTE_MAX_RESULTS = 500;

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  returned: number;
  truncated: boolean;
  truncationNotice: string | null;
}

export function applyMaxResults<T>(
  items: T[],
  maxResults: number = DEFAULT_MAX_RESULTS
): PaginatedResult<T> {
  const clamped = Math.min(Math.max(1, maxResults), ABSOLUTE_MAX_RESULTS);
  const total = items.length;
  const truncated = total > clamped;
  const returned = truncated ? clamped : total;

  return {
    items: truncated ? items.slice(0, clamped) : items,
    total,
    returned,
    truncated,
    truncationNotice: truncated
      ? `⚠️  Showing ${returned} of ${total} results. Use filters to narrow results, or increase maxResults (max ${ABSOLUTE_MAX_RESULTS}) to see more.`
      : null,
  };
}

export function appendTruncationNotice(text: string, result: PaginatedResult<unknown>): string {
  if (result.truncationNotice) {
    return `${text}\n\n${result.truncationNotice}`;
  }
  return text;
}

/**
 * Add pagination facts to a structured (JSON) payload so a list cut at maxResults never looks complete. UAT 2026-10-09
 * found list_available_browsers returning exactly 50 rows with no total and no truncation flag; most paged list tools
 * had the same gap (only their human text carried the notice). Existing keys are never overwritten — some payloads
 * already use `total` for something else.
 */
export function withPaging<S extends Record<string, unknown>>(structured: S, paged: Pick<PaginatedResult<unknown>, 'total' | 'returned' | 'truncated'>): S & { total?: number; returned?: number; truncated?: boolean } {
  const out: Record<string, unknown> = { ...structured };
  if (!('total' in out)) out.total = paged.total;
  if (!('returned' in out)) out.returned = paged.returned;
  if (!('truncated' in out)) out.truncated = paged.truncated;
  return out as S & { total?: number; returned?: number; truncated?: boolean };
}
