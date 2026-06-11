import axios, { type AxiosInstance } from 'axios';
import FormData from 'form-data';
import { listProfiles } from '../utils/profile-loader.js';

export { formatDeviceTimestamp } from '../utils/timestamp.js';

function buildClient(baseURL: string, accessKey: string): AxiosInstance {
  // JWT tokens (Cloud Admin) start with 'eyJ' and authenticate via Bearer only.
  // Project/user API keys ('aut_1_...') need X-API-KEY for CSRF exemption on
  // reporter mutation endpoints, and Bearer for standard endpoints.
  const isJwt = accessKey.startsWith('eyJ');
  _activeKeyType = isJwt ? 'jwt' : 'api-key';
  _activeKey = accessKey;

  const authHeaders = isJwt
    ? { Authorization: `Bearer ${accessKey}` }
    : { 'X-API-KEY': accessKey, Authorization: `Bearer ${accessKey}` };

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
      const status = error.response?.status ?? 'unknown';
      const rawMsg =
        error.response?.data?.message ??
        error.response?.data?.data ??
        error.message ??
        'Unknown error';

      // Enrich 403 responses with auth guidance and environment-switching hints.
      const msg = status === 403
        ? build403Hint()
        : rawMsg;

      throw new Error(`Digital.ai API Error [${status}]: ${msg}`);
    }
  );

  return client;
}

// ─── Active client state ──────────────────────────────────────────────────────
// Lazily initialised on the first API call from the default env vars.
// Call resetClient() to switch to a different named profile at runtime.

let _client: AxiosInstance | undefined;
let _activeProfileName = 'default';
let _activeUrl = '';
let _activeKey = '';
let _activeKeyType: 'jwt' | 'api-key' = 'api-key';

/** Build a human-readable auth guidance message for 403 responses. */
function build403Hint(): string {
  const profiles = listProfiles();
  const current = profiles.find(p => p.name === _activeProfileName);
  const currentLabel = current
    ? `"${current.name}" (${current.keyType === 'jwt' ? 'Cloud Admin JWT' : 'project API key — limited access'})`
    : `"${_activeProfileName}"`;

  const lines = [
    `This endpoint requires Cloud Admin JWT access.`,
    `Current connection: ${currentLabel}.`,
  ];

  if (_activeKeyType === 'api-key') {
    const jwtProfiles = profiles.filter(p => p.keyType === 'jwt' && p.name !== _activeProfileName);
    if (jwtProfiles.length === 1) {
      lines.push(`💡 Switch to your Cloud Admin profile: switch_environment("${jwtProfiles[0].name}")`);
    } else if (jwtProfiles.length > 1) {
      const names = jwtProfiles.map(p => `"${p.name}"`).join(', ');
      lines.push(`💡 Switch to a Cloud Admin profile — available: ${names}. Call switch_environment("<name>").`);
    } else {
      lines.push(`💡 No Cloud Admin profiles configured. Add DAI_PROFILE_ADMIN_KEY=eyJ... to your .env and restart.`);
    }
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

/** Returns the auth type of the currently active connection. */
export function getActiveKeyType(): 'jwt' | 'api-key' {
  // The Axios client is lazy-initialised — before the first API call,
  // _activeKeyType still holds its default. Derive from env in that window so
  // pre-flight auth gates (delete tools, canDeleteReport) don't misclassify
  // a JWT profile as a project key on the first tool call of a session.
  if (!_client) {
    return (process.env.DIGITAL_AI_ACCESS_KEY ?? '').startsWith('eyJ') ? 'jwt' : 'api-key';
  }
  return _activeKeyType;
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
// Multi-page scans (listTestsSortedDesc, delete_test_reports_before_date) make
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

async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || !TRANSIENT_STATUS_RE.test((e as Error).message)) throw e;
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

export async function apiDownload(path: string): Promise<Buffer> {
  const res = await withRetry(() => getClient().get<Buffer>(path, { responseType: 'arraybuffer' }));
  return Buffer.from(res.data);
}
