import { createReadStream } from 'fs';
import { writeFile } from 'fs/promises';
import FormData from 'form-data';
import { apiGet, apiDelete, apiPostForm, apiDownload } from './client.js';
import type { ApiResponse, RepositoryFile, RepositoryFileFilters } from '../types/digital-ai.js';

export async function listFiles(filters?: RepositoryFileFilters): Promise<RepositoryFile[]> {
  try {
    const params: Record<string, unknown> = {};
    if (filters?.projectId) params['projectId'] = filters.projectId;
    if (filters?.projectName) params['projectName'] = filters.projectName;
    if (filters?.uniqueName) params['uniqueName'] = filters.uniqueName;

    const res = await apiGet<ApiResponse<RepositoryFile[]>>('/api/v1/files', params);
    return res.data;
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
