import { apiGet } from './client.js';
import type { ActiveSession } from '../types/digital-ai.js';

// v2 API — Cloud Admin only. Project-level roles are refused (401/403).

export async function getActiveSessions(): Promise<ActiveSession[]> {
  try {
    const res = await apiGet<ActiveSession[]>('/api/v2/sessions');
    return Array.isArray(res) ? res : [];
  } catch (e) {
    throw new Error(`getActiveSessions failed: ${(e as Error).message}`);
  }
}
