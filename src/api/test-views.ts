import { apiGet, apiPost, apiPut, apiDelete } from './client.js';
import type {
  TestView,
  TestViewSummary,
  TestViewListRequest,
  TestViewListResponse,
  CreateTestViewParams,
  UpdateTestViewParams,
} from '../types/digital-ai.js';

// The testView API does not use the standard ApiResponse envelope.
// The paginated /list endpoint returns {count, data} directly.

export async function getAllTestViews(): Promise<TestView[]> {
  try {
    return await apiGet<TestView[]>('/reporter/api/testView');
  } catch (e) {
    throw new Error(`getAllTestViews failed: ${(e as Error).message}`);
  }
}

export async function getTestViewById(id: number): Promise<TestView> {
  try {
    return await apiGet<TestView>(`/reporter/api/testView/${id}`);
  } catch (e) {
    throw new Error(`getTestViewById failed: ${(e as Error).message}`);
  }
}

export async function listTestViews(request: TestViewListRequest): Promise<TestViewListResponse> {
  try {
    return await apiPost<TestViewListResponse>('/reporter/api/testView/list', request);
  } catch (e) {
    throw new Error(`listTestViews failed: ${(e as Error).message}`);
  }
}

export async function getTestViewSummary(
  id: number,
  filter?: Record<string, string>
): Promise<TestViewSummary> {
  try {
    const params: Record<string, unknown> = {};
    if (filter) params['filter'] = JSON.stringify(filter);
    const res = await apiGet<{ data: TestViewSummary[] }>(
      `/reporter/api/testView/${id}:summary`,
      params
    );
    if (!res.data || res.data.length === 0) {
      throw new Error(`No summary data returned for test view ${id}`);
    }
    return res.data[0];
  } catch (e) {
    throw new Error(`getTestViewSummary failed: ${(e as Error).message}`);
  }
}

export async function createTestView(params: CreateTestViewParams): Promise<TestView> {
  try {
    return await apiPost<TestView>('/reporter/api/testView', params);
  } catch (e) {
    throw new Error(`createTestView failed: ${(e as Error).message}`);
  }
}

export async function updateTestView(params: UpdateTestViewParams): Promise<TestView> {
  try {
    return await apiPut<TestView>('/reporter/api/testView', params);
  } catch (e) {
    throw new Error(`updateTestView failed: ${(e as Error).message}`);
  }
}

export async function deleteTestView(id: number): Promise<void> {
  try {
    await apiDelete(`/reporter/api/testView/${id}`);
  } catch (e) {
    throw new Error(`deleteTestView failed: ${(e as Error).message}`);
  }
}
