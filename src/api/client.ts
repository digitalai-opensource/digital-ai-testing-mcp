import axios, { type AxiosInstance } from 'axios';
import FormData from 'form-data';
import { listProfiles, getProfileCredentials } from '../utils/profile-loader.js';
import { authHeadersFor, authSchemeFor, peekAccessInfo, describeLevel, type AuthScheme } from '../utils/access-level.js';
import { extractApiErrorMessage } from '../utils/api-error.js';

export { formatDeviceTimestamp } from '../utils/timestamp.js';

function buildClient(baseURL: string, accessKey: string): AxiosInstance {
  // Key format decides ONLY the header scheme (JWTs: Bearer; 'aut_1_...' keys: X-API-KEY + Bearer,
  // for CSRF exemption on reporter mutations). It says nothing about privilege — a Cloud Admin can
  // hold either format. Role is resolved from the API: see src/utils/access-level.ts.
  _activeAuthScheme = authSchemeFor(accessKey);
  _activeKey = accessKey;

  const authHeaders = authHeadersFor(accessKey);

  const client = axios.create({
    baseURL: baseURL.replace(/\/$/, ''),
    timeout: Number(process.env.REQUEST_TIMEOUT_MS ?? 30000),
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
    },
  });

  client.interceptors.request.use((config) => {
    console.error(`[digital-ai-api] ${config.method?.toUpperCase()} ${config.url}`);
    return config;
  });

  client.interceptors.response.use(
    (response) => response,
    (error) => {
      throw toApiError(error.response?.status, error.response?.data, error.message);
    }
  );

  return client;
}

/**
 * The one place an HTTP failure becomes the `Digital.ai API Error [status]: <detail>` the tools report. `body` may be
 * any shape the platform sends (see api-error.ts); a 403 gets auth guidance APPENDED to the platform's own message,
 * never replacing it (e.g. "You have no permission to delete tests" is the actual diagnosis and must survive).
 */
function toApiError(status: number | undefined, body: unknown, fallback: string): Error {
  const rawMsg = extractApiErrorMessage(body, fallback);
  const hint = status === 403 ? build403Hint() : undefined;
  const msg = hint ? `${rawMsg} — ${hint}` : rawMsg;
  return new Error(`Digital.ai API Error [${status ?? 'unknown'}]: ${msg}`);
}

// ─── Active client state ──────────────────────────────────────────────────────
// Lazily initialised on the first API call from the default env vars.
// Call resetClient() to switch to a different named profile at runtime.

let _client: AxiosInstance | undefined;
let _activeProfileName = 'default';
let _activeUrl = '';
let _activeKey = '';
let _activeAuthScheme: AuthScheme = 'bearer+x-api-key';

/**
 * Build auth guidance for a 403. Returns undefined when the active credential is already known to be
 * Cloud Admin — the 403 then has some other cause, and a "switch to Cloud Admin" hint would mislead.
 * Reads only the access-level CACHE (never the network): this runs inside an axios error interceptor.
 */
function build403Hint(): string | undefined {
  const info = peekAccessInfo(_activeUrl, _activeKey);
  if (info?.level === 'cloud-admin') return undefined;

  const current = info
    ? `"${_activeProfileName}" (${describeLevel(info)})`
    : `"${_activeProfileName}"`;

  // Name a Cloud Admin profile only when one is already KNOWN to be (cache lookup, no network).
  const adminProfiles = listProfiles()
    .filter(p => p.name !== _activeProfileName)
    .filter(p => {
      const c = getProfileCredentials(p.name);
      return c !== undefined && peekAccessInfo(c.url, c.key)?.level === 'cloud-admin';
    })
    .map(p => p.name);

  const lines = [
    `This may require Cloud Admin access.`,
    `Current connection: ${current}.`,
  ];
  if (adminProfiles.length === 1) {
    lines.push(`💡 Switch to your Cloud Admin profile: switch_environment("${adminProfiles[0]}")`);
  } else if (adminProfiles.length > 1) {
    lines.push(`💡 Switch to a Cloud Admin profile — available: ${adminProfiles.map(n => `"${n}"`).join(', ')}. Call switch_environment("<name>").`);
  } else {
    lines.push(
      `💡 Call list_environments to see each profile's detected access level, then switch_environment to a Cloud Admin profile. ` +
        `If none is configured, add a Cloud Admin key to your .env and restart: DAI_PROFILE_ADMIN_URL=... / DAI_PROFILE_ADMIN_KEY=...`
    );
  }
  return lines.join(' ');
}

function getClient(): AxiosInstance {
  if (!_client) {
    const baseURL = process.env.DIGITAL_AI_BASE_URL;
    const accessKey = process.env.DIGITAL_AI_ACCESS_KEY;
    if (!baseURL || !accessKey) {
      throw new Error('DIGITAL_AI_BASE_URL and DIGITAL_AI_ACCESS_KEY must be set');
    }
    _activeUrl = baseURL.replace(/\/$/, '');
    _client = buildClient(_activeUrl, accessKey);
  }
  return _client;
}

/**
 * Switch the active API connection to a different named profile.
 * All subsequent API calls will use the new credentials immediately.
 * Call list_environments to see available profiles, switch_environment to invoke.
 */
export function resetClient(url: string, key: string, profileName: string): void {
  _activeUrl = url.replace(/\/$/, '');
  _activeProfileName = profileName;
  _client = buildClient(_activeUrl, key);
  console.error(`[digital-ai-api] Switched to profile "${profileName}" — ${_activeUrl}`);
}

/** Returns the name of the currently active profile. */
export function getActiveProfileName(): string {
  return _activeProfileName;
}

/**
 * Returns how the active credential is PRESENTED (header scheme). Use this only to build auth
 * headers (e.g. generated curl commands). It is NOT a privilege check — for that, use
 * getAccessInfo() / checkDeleteAllowed() from './access-level.js', which ask the API.
 */
export function getActiveAuthScheme(): AuthScheme {
  // Lazy client: before the first API call _activeAuthScheme holds its default, so derive from the
  // credential directly (getActiveAccessKey falls back to env in that window).
  return _client ? _activeAuthScheme : authSchemeFor(getActiveAccessKey());
}

/** Returns the base URL of the currently active connection. */
export function getActiveUrl(): string {
  // Return cached value if the client was already initialised, otherwise read env.
  return _activeUrl || (process.env.DIGITAL_AI_BASE_URL ?? '').replace(/\/$/, '');
}

/**
 * Returns the access key of the currently active connection.
 *
 * This is the ONLY sanctioned way for other modules to obtain the credential.
 * Never read process.env.DIGITAL_AI_ACCESS_KEY outside this file and
 * profile-loader.ts — env vars reflect the DEFAULT profile and ignore
 * switch_environment, which leaks the wrong credential into generated
 * artifacts (boilerplate, rdb scripts) and WebDriver sessions.
 */
export function getActiveAccessKey(): string {
  return _activeKey || (process.env.DIGITAL_AI_ACCESS_KEY ?? '');
}

// ─── Retry for read operations ────────────────────────────────────────────────
// Multi-page scans (listTestsSortedDesc's fallback scan, delete_test_reports_before_date) make
// many serial calls; one transient failure should not discard the whole scan.
// Only reads are retried — GETs are idempotent, and the reporter's POST-based
// list/aggregate endpoints below are reads despite the verb. Mutating POSTs
// (delete, create, install) are never retried.

const RETRYABLE_POST_PATHS = new Set([
  '/reporter/api/tests/list',
  '/reporter/api/tests/grouped',
  '/reporter/api/tests/distinct',
  '/reporter/api/transactions/list',
  '/reporter/api/testView/list',
]);

const TRANSIENT_STATUS_RE = /\[(429|500|502|503|504|unknown)\]/;
// axios reports an AbortSignal that fired as `[unknown]: canceled` — a deliberate deadline, not a transient fault.
const CANCELED_RE = /\bcancel(l)?ed\b/i;

async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = (e as Error).message;
      if (attempt >= retries || !TRANSIENT_STATUS_RE.test(msg) || CANCELED_RE.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

// ─── API helpers ──────────────────────────────────────────────────────────────

export async function apiGet<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const res = await withRetry(() => getClient().get<T>(path, { params }));
  return res.data;
}

export async function apiPost<T>(path: string, data?: unknown, params?: Record<string, unknown>): Promise<T> {
  const res = RETRYABLE_POST_PATHS.has(path)
    ? await withRetry(() => getClient().post<T>(path, data, { params }))
    : await getClient().post<T>(path, data, { params });
  return res.data;
}

export async function apiPut<T>(path: string, data?: unknown, params?: Record<string, unknown>): Promise<T> {
  const res = await getClient().put<T>(path, data, { params });
  return res.data;
}

export async function apiPatch<T>(path: string, data?: unknown): Promise<T> {
  const res = await getClient().patch<T>(path, data);
  return res.data;
}

export async function apiDelete<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const res = await getClient().delete<T>(path, { params });
  return res.data;
}

export async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  const res = await getClient().post<T>(path, form, {
    headers: form.getHeaders(),
    timeout: Number(process.env.UPLOAD_TIMEOUT_MS ?? 120000),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return res.data;
}

export async function apiPutForm<T>(path: string, form: FormData): Promise<T> {
  const res = await getClient().put<T>(path, form, {
    headers: form.getHeaders(),
    timeout: Number(process.env.UPLOAD_TIMEOUT_MS ?? 120000),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return res.data;
}

/**
 * Binary GET, retried on transient failures. Optional `signal` adds a WALL-CLOCK deadline: axios's `timeout` is an
 * idle timeout, so a response that keeps streaming for minutes never trips it. An aborted request surfaces as
 * `Digital.ai API Error [unknown]: canceled` (not retried — see CANCELED_RE). Usage-report CSVs use apiDownloadStream.
 */
export async function apiDownload(path: string, opts: { signal?: AbortSignal } = {}): Promise<Buffer> {
  const res = await withRetry(() => getClient().get<Buffer>(path, { responseType: 'arraybuffer', signal: opts.signal }));
  return Buffer.from(res.data);
}

/** Longest error body worth reading off a failed stream response — a platform error message, never a report. */
const MAX_STREAM_ERROR_BODY_BYTES = 64 * 1024;

/**
 * Binary GET as a Node stream, for responses worth abandoning part-way (a usage-report CSV whose first section is the
 * answer). The request (headers) phase is retried like any read; once bytes flow nothing is retried. Caller destroys
 * the stream to stop.
 *
 * Every status resolves here (`validateStatus`) because on a failure axios's `response.data` is the body STREAM, and the
 * interceptor can't read a message out of a stream — the 403 "This endpoint requires Cloud Admin access" was lost that
 * way. The body is read here and turned into the same `Digital.ai API Error` the interceptor builds.
 */
export async function apiDownloadStream(path: string, opts: { signal?: AbortSignal } = {}): Promise<NodeJS.ReadableStream> {
  const res = await withRetry(async () => {
    const r = await getClient().get<NodeJS.ReadableStream>(path, { responseType: 'stream', signal: opts.signal, validateStatus: () => true });
    if (r.status < 400) return r;
    throw toApiError(r.status, await readStreamPrefix(r.data, MAX_STREAM_ERROR_BODY_BYTES), `Request failed with status code ${r.status}`);
  });
  return res.data;
}

/** Collects up to `max` bytes of a stream, then destroys it. Never throws — an unreadable error body is just no detail. */
function readStreamPrefix(stream: NodeJS.ReadableStream, max: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = () => resolve(Buffer.concat(chunks));
    stream.on('data', (chunk: Buffer) => {
      if (size >= max) return;
      chunks.push(chunk.subarray(0, max - size));
      size += chunk.length;
      if (size >= max) (stream as unknown as { destroy: () => void }).destroy();
    });
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', finish);
  });
}

/** GET with an optional HTTP Range header ("bytes=0-1023", "bytes=-100", "bytes=1000-"). Read-only, so retried. */
export async function apiDownloadRange(
  path: string,
  range?: string
): Promise<{ data: Buffer; status: number; contentType?: string; contentRange?: string }> {
  const res = await withRetry(() =>
    getClient().get<Buffer>(path, { responseType: 'arraybuffer', ...(range ? { headers: { Range: range } } : {}), maxContentLength: Infinity })
  );
  const header = (name: string) => {
    const v = res.headers[name];
    return v == null ? undefined : String(v);
  };
  return { data: Buffer.from(res.data), status: res.status, contentType: header('content-type'), contentRange: header('content-range') };
}
