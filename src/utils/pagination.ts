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
