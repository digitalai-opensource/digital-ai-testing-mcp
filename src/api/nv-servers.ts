import { apiGet } from './client.js';
import type { NvServer } from '../types/digital-ai.js';

// v2 API — Cloud Admin (JWT) only. Project API keys receive 403 Forbidden.

export async function getNvServers(): Promise<NvServer[]> {
  try {
    const res = await apiGet<NvServer[]>('/api/v2/nv-servers');
    return Array.isArray(res) ? res : [];
  } catch (e) {
    throw new Error(`getNvServers failed: ${(e as Error).message}`);
  }
}

export async function getNvServer(nvServerId: number): Promise<NvServer> {
  try {
    return await apiGet<NvServer>(`/api/v2/nv-servers/${nvServerId}`);
  } catch (e) {
    throw new Error(`getNvServer failed: ${(e as Error).message}`);
  }
}
