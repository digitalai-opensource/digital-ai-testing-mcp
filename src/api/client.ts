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
  return _activeKeyType;
}

/** Returns the base URL of the currently active connection. */
export function getActiveUrl(): string {
  // Return cached value if the client was already initialised, otherwise read env.
  return _activeUrl || (process.env.DIGITAL_AI_BASE_URL ?? '').replace(/\/$/, '');
}

// ─── API helpers ──────────────────────────────────────────────────────────────

export async function apiGet<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const res = await getClient().get<T>(path, { params });
  return res.data;
}

export async function apiPost<T>(path: string, data?: unknown, params?: Record<string, unknown>): Promise<T> {
  const res = await getClient().post<T>(path, data, { params });
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
  const res = await getClient().get<Buffer>(path, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}
