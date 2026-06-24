import { apiPost } from './client.js';
import type { ApiResponse } from '../types/digital-ai.js';

export async function createBackup(noApps?: boolean): Promise<{ message: string }> {
  try {
    const res = await apiPost<ApiResponse<{ message: string }>>('/api/v1/backups/new', {
      noApps: noApps ?? false,
    });
    return res.data;
  } catch (e) {
    throw new Error(`createBackup failed: ${(e as Error).message}`);
  }
}
