import { createReadStream } from 'fs';
import { writeFile } from 'fs/promises';
import FormData from 'form-data';
import { createHash } from 'crypto';
import { apiGet, apiDelete, apiPostForm, apiDownload, getActiveUrl, getActiveAccessKey } from './client.js';
import type { ApiResponse, RepositoryFile, RepositoryFileFilters } from '../types/digital-ai.js';

/**
 * GET /api/v1/files ignores uniqueName / projectName / projectId (verified live 2026-10-16: a made-up value of each
 * still returned all 210 files), so every filter is applied here. Both name matches are exact, case-insensitive.
 */
export function filterRepositoryFiles(files: RepositoryFile[], filters: { projectName?: string; uniqueName?: string }): RepositoryFile[] {
  const eq = (a: string | null | undefined, b: string) => (a ?? '').toLowerCase() === b.toLowerCase();
  return files.filter((f) =>
    (!filters.uniqueName || eq(f.uniqueName, filters.uniqueName)) &&
    (!filters.projectName || eq(f.projectName, filters.projectName))
  );
}

/**
 * Short-lived cache of the full list. The platform ignores every filter, so each list_repository_files call fetched the
 * whole repository (210+ files on the dev tenant) — an agent filtering the same repository several times in a row paid
 * for it each time. Keyed by credential (a profile switch never sees another key's files). Cleared by this MCP's own
 * upload / update / delete. Files created elsewhere (another user, a generated upload command, a HAR/log/audio capture)
 * can be up to REPOSITORY_CACHE_TTL_MS old — which is why a uniqueName lookup that misses always re-fetches once, and
 * `fresh` bypasses the cache.
 */
export const REPOSITORY_CACHE_TTL_MS = 30_000;
let cache: { credential: string; at: number; files: RepositoryFile[] } | null = null;

function credentialFingerprint(): string {
  return createHash('sha256').update(`${getActiveUrl()}\0${getActiveAccessKey()}`).digest('hex');
}

export function invalidateRepositoryCache(): void {
  cache = null;
}

async function fetchAllFiles(fresh: boolean): Promise<{ files: RepositoryFile[]; fromCache: boolean }> {
  const credential = credentialFingerprint();
  if (!fresh && cache && cache.credential === credential && Date.now() - cache.at < REPOSITORY_CACHE_TTL_MS) {
    return { files: cache.files, fromCache: true };
  }
  const res = await apiGet<ApiResponse<RepositoryFile[]>>('/api/v1/files');
  cache = { credential, at: Date.now(), files: res.data ?? [] };
  return { files: cache.files, fromCache: false };
}

export async function listFiles(filters?: RepositoryFileFilters, opts: { fresh?: boolean } = {}): Promise<RepositoryFile[]> {
  try {
    const first = await fetchAllFiles(opts.fresh === true);
    let all = first.files;
    // A file just created outside this MCP may not be in a CACHED list yet — a named lookup that misses there checks
    // again (a list that was fetched just now is already current, so a miss in it is final).
    if (first.fromCache && filters?.uniqueName && filterRepositoryFiles(all, { uniqueName: filters.uniqueName }).length === 0) {
      all = (await fetchAllFiles(true)).files;
    }
    let projectName = filters?.projectName;
    if (filters?.projectId && !projectName) {
      // File records carry the project NAME only — resolve the id through the projects the caller can see.
      const projects = await apiGet<Array<{ id: number | string; name: string }>>('/api/v1/projects');
      const match = (Array.isArray(projects) ? projects : []).find((p) => String(p.id) === String(filters.projectId));
      if (!match) throw new Error(`project ${filters.projectId} is not visible to this credential — use projectName`);
      projectName = match.name;
    }
    return filterRepositoryFiles(all, { projectName, uniqueName: filters?.uniqueName });
  } catch (e) {
    throw new Error(`listFiles failed: ${(e as Error).message}`);
  }
}

export async function getFileInfo(fileId: number): Promise<RepositoryFile> {
  try {
    const res = await apiGet<ApiResponse<RepositoryFile>>(`/api/v1/files/${fileId}`);
    return res.data;
  } catch (e) {
    throw new Error(`getFileInfo failed: ${(e as Error).message}`);
  }
}

export async function uploadFile(
  localPath: string,
  params?: {
    uniqueName?: string;
    description?: string;
    projectId?: string;
    projectName?: string;
  }
): Promise<number> {
  try {
    const form = new FormData();
    form.append('file', createReadStream(localPath));
    if (params?.uniqueName) form.append('uniqueName', params.uniqueName);
    if (params?.description) form.append('description', params.description);
    if (params?.projectId) form.append('projectId', params.projectId);
    if (params?.projectName) form.append('projectName', params.projectName);

    const res = await apiPostForm<ApiResponse<number>>('/api/v1/files', form);
    invalidateRepositoryCache();
    return res.data;
  } catch (e) {
    throw new Error(`uploadFile failed: ${(e as Error).message}`);
  }
}

export async function downloadFile(fileId: number, localPath: string): Promise<void> {
  try {
    const data = await apiDownload(`/api/v1/files/${fileId}/download`);
    await writeFile(localPath, data);
  } catch (e) {
    throw new Error(`downloadFile failed: ${(e as Error).message}`);
  }
}

export async function updateFile(
  fileId: number,
  params: { localPath?: string; uniqueName?: string; description?: string }
): Promise<void> {
  try {
    const form = new FormData();
    if (params.localPath) form.append('file', createReadStream(params.localPath));
    if (params.uniqueName) form.append('uniqueName', params.uniqueName);
    if (params.description) form.append('description', params.description);

    await apiPostForm(`/api/v1/files/${fileId}`, form);
    invalidateRepositoryCache();
  } catch (e) {
    throw new Error(`updateFile failed: ${(e as Error).message}`);
  }
}

export async function deleteFile(fileId: number): Promise<void> {
  try {
    await apiDelete(`/api/v1/files/${fileId}`);
    invalidateRepositoryCache();
  } catch (e) {
    throw new Error(`deleteFile failed: ${(e as Error).message}`);
  }
}
