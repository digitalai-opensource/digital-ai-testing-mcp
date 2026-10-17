import { createReadStream } from 'fs';
import { writeFile } from 'fs/promises';
import FormData from 'form-data';
import { apiGet, apiDelete, apiPostForm, apiDownload } from './client.js';
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

export async function listFiles(filters?: RepositoryFileFilters): Promise<RepositoryFile[]> {
  try {
    const res = await apiGet<ApiResponse<RepositoryFile[]>>('/api/v1/files');
    let projectName = filters?.projectName;
    if (filters?.projectId && !projectName) {
      // File records carry the project NAME only — resolve the id through the projects the caller can see.
      const projects = await apiGet<Array<{ id: number | string; name: string }>>('/api/v1/projects');
      const match = (Array.isArray(projects) ? projects : []).find((p) => String(p.id) === String(filters.projectId));
      if (!match) throw new Error(`project ${filters.projectId} is not visible to this credential — use projectName`);
      projectName = match.name;
    }
    return filterRepositoryFiles(res.data ?? [], { projectName, uniqueName: filters?.uniqueName });
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
  } catch (e) {
    throw new Error(`updateFile failed: ${(e as Error).message}`);
  }
}

export async function deleteFile(fileId: number): Promise<void> {
  try {
    await apiDelete(`/api/v1/files/${fileId}`);
  } catch (e) {
    throw new Error(`deleteFile failed: ${(e as Error).message}`);
  }
}
