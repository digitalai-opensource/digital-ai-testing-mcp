/**
 * Pull a human-readable message out of a Digital.ai error response body.
 *
 * Bodies vary by endpoint: `{ message }`, `{ status, code, data: "text" }`, `{ data: { message } }`,
 * `{ error }`, a bare string, or an HTML page. Interpolating an object directly produced
 * "Digital.ai API Error [403]: [object Object]" and lost the platform's real reason, so every
 * candidate goes through `describe()`, which only ever returns a string.
 */
const MAX_DETAIL_CHARS = 300;

function truncate(s: string): string {
  return s.length > MAX_DETAIL_CHARS ? `${s.slice(0, MAX_DETAIL_CHARS)}…` : s;
}

function describe(value: unknown, depth = 0): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    // An HTML error page carries no useful detail and would flood the message.
    if (/^<(!doctype|html)/i.test(trimmed)) return undefined;
    return truncate(trimmed);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'object' || depth > 2) return undefined;

  const obj = value as Record<string, unknown>;
  for (const field of ['message', 'error', 'errorMessage', 'description', 'detail', 'data']) {
    const found = describe(obj[field], depth + 1);
    if (found) return found;
  }
  try {
    const json = JSON.stringify(value);
    return json && json !== '{}' && json !== '[]' ? truncate(json) : undefined;
  } catch {
    return undefined;
  }
}

/** Best message for an axios error: the response body first, then axios's own message. */
export function extractApiErrorMessage(body: unknown, fallback?: string): string {
  return describe(body) ?? describe(fallback) ?? 'Unknown error';
}
