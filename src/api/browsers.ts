import { apiGet, apiPost, apiPut } from './client.js';
import type { ApiResponse, Browser, ManualTestStep } from '../types/digital-ai.js';

// Uses the standard ApiResponse wrapper ({ status, data, code }) — unlike /api/v1/applications
// and /api/v1/projects which return their arrays directly. Keep res.data here.
export async function getAllBrowsers(): Promise<Browser[]> {
  try {
    const res = await apiGet<ApiResponse<Browser[]>>('/api/v1/browsers');
    return res.data;
  } catch (e) {
    throw new Error(`getAllBrowsers failed: ${(e as Error).message}`);
  }
}

export async function startWebControlSession(params: {
  browserName?: string;
  browserVersion?: string;
  os?: string;
}): Promise<{ regularLink: string }> {
  try {
    const res = await apiPut<ApiResponse<{ regularLink: string }>>(
      '/api/v1/browsers/web-control',
      params
    );
    return res.data;
  } catch (e) {
    throw new Error(`startWebControlSession failed: ${(e as Error).message}`);
  }
}

export async function startWebControlWithTemplate(params: {
  testName: string;
  testSteps: ManualTestStep[];
  browserName?: string;
  browserVersion?: string;
  osName?: string;
}): Promise<{ link: string; report_api_id: string }> {
  try {
    const res = await apiPost<ApiResponse<{ link: string; report_api_id: string }>>(
      '/api/v1/browsers/web-control',
      params
    );
    return res.data;
  } catch (e) {
    throw new Error(`startWebControlWithTemplate failed: ${(e as Error).message}`);
  }
}
