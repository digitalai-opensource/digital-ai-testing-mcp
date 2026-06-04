import { apiGet } from './client.js';
import type { LicenseInfo } from '../types/digital-ai.js';

// v2 API — Cloud Admin (JWT) only. Project keys receive 401.

export async function getLicenseInfo(): Promise<LicenseInfo> {
  try {
    return await apiGet<LicenseInfo>('/api/v2/license');
  } catch (e) {
    throw new Error(`getLicenseInfo failed: ${(e as Error).message}`);
  }
}
