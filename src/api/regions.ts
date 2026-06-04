import { apiGet } from './client.js';
import type { Region, RegionTopology } from '../types/digital-ai.js';

// v2 API — Cloud Admin (JWT) only. Project API keys receive 403 Forbidden.

export async function getRegions(): Promise<Region[]> {
  try {
    const res = await apiGet<Region[]>('/api/v2/regions');
    return Array.isArray(res) ? res : [];
  } catch (e) {
    throw new Error(`getRegions failed: ${(e as Error).message}`);
  }
}

export async function getRegionTopology(regionId: number): Promise<RegionTopology> {
  try {
    return await apiGet<RegionTopology>(`/api/v2/regions/${regionId}`);
  } catch (e) {
    throw new Error(`getRegionTopology failed: ${(e as Error).message}`);
  }
}
