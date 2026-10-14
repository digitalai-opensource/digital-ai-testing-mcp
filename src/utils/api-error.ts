/**
 * Pull a human-readable message out of a Digital.ai error response body.
 *
 * Bodies vary by endpoint: `{ message }`, `{ status, code, data: "text" }`, `{ data: { message } }`,
 * `{ error }`, `[ { message } ]` validation lists, a bare string, an HTML page, or — for
 * `responseType: 'arraybuffer'` downloads — a Buffer. Interpolating an object directly produced
 * "Digital.ai API Error [403]: [object Object]" and lost the platform's real reason, so every
 * candidate goes through `describe()`, which only ever returns a string.
 */
const MAX_DETAIL_CHARS = 300;

const MESSAGE_FIELDS = ['message', 'error', 'errorMessage', 'description', 'detail', 'data'] as const;

function truncate(s: string): string {
  return s.length > MAX_DETAIL_CHARS ? `${s.slice(0, MAX_DETAIL_CHARS)}…` : s;
}

function isBinary(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

/** Decode a binary body as UTF-8 and try to read it as JSON, so download errors get the same treatment. */
function decodeBinary(value: ArrayBuffer | ArrayBufferView): unknown {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  // Cap the decode — a multi-MB binary body is never an error message.
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4096));
  if (/[\u0000�]/.test(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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
  // Primitives in an envelope (`error: true`, `code: 403`) are flags, not messages.
  if (typeof value !== 'object' || depth > 2) return undefined;
  if (isBinary(value)) return describe(decodeBinary(value), depth);

  if (Array.isArray(value)) {
    // Validation-error lists: `[ { field, message }, … ]` — join the messages, else dump the first item.
    const messages = value.map((item) => describe(item, depth + 1)).filter((m): m is string => !!m);
    return messages.length ? truncate(messages.join('; ')) : undefined;
  }

  const obj = value as Record<string, unknown>;
  for (const field of MESSAGE_FIELDS) {
    const found = describe(obj[field], depth + 1);
    if (found) return found;
  }
  try {
    const json = JSON.stringify(value);
    return json && json !== '{}' ? truncate(json) : undefined;
  } catch {
    return undefined;
  }
}

/** Best message for an axios error: the response body first, then axios's own message. */
export function extractApiErrorMessage(body: unknown, fallback?: string): string {
  return describe(body) ?? describe(fallback) ?? 'Unknown error';
}
