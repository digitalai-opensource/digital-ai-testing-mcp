import { apiGet, apiPost, apiPut, apiDelete } from './client.js';
import type {
  ApiResponse,
  Project,
  ProjectUser,
  AutomationProperty,
  ProjectAdminDetail,
  Device,
} from '../types/digital-ai.js';

// Returns the array directly — no ApiResponse envelope (unlike most other endpoints).
export async function getAllProjects(): Promise<Project[]> {
  try {
    return await apiGet<Project[]>('/api/v1/projects');
  } catch (e) {
    throw new Error(`getAllProjects failed: ${(e as Error).message}`);
  }
}

export async function createProject(params: {
  name: string;
  deviceGroupId?: string;
  appiumOSS?: boolean;
}): Promise<{ id: string; projects: string }> {
  try {
    // The /api/v1/projects/new endpoint expects query parameters, not a JSON body.
    // Response: { id: string, projects: "Project added successfully" }
    const qp: Record<string, unknown> = { name: params.name };
    if (params.deviceGroupId !== undefined) qp['deviceGroupId'] = params.deviceGroupId;
    if (params.appiumOSS !== undefined) qp['appiumOSS'] = params.appiumOSS;
    const res = await apiPost<ApiResponse<{ id: string; projects: string }>>('/api/v1/projects/new', undefined, qp);
    return res.data;
  } catch (e) {
    throw new Error(`createProject failed: ${(e as Error).message}`);
  }
}

export async function deleteProject(id: number, deleteUsers?: boolean): Promise<void> {
  try {
    await apiPost(`/api/v1/projects/${id}/delete`, { deleteUsers: deleteUsers ?? false });
  } catch (e) {
    throw new Error(`deleteProject failed: ${(e as Error).message}`);
  }
}

export async function getUsersInProject(id: number): Promise<ProjectUser[]> {
  try {
    const res = await apiGet<ApiResponse<ProjectUser[]>>(`/api/v1/projects/${id}/users`);
    return res.data;
  } catch (e) {
    throw new Error(`getUsersInProject failed: ${(e as Error).message}`);
  }
}

export async function assignUserToProject(
  projectId: number,
  userId: number,
  role?: 'User' | 'ProjectAdmin'
): Promise<void> {
  try {
    // /new endpoints expect query params, not a JSON body.
    await apiPost(`/api/v1/projects/${projectId}/users/${userId}/new`, undefined, role ? { role } : undefined);
  } catch (e) {
    throw new Error(`assignUserToProject failed: ${(e as Error).message}`);
  }
}

export async function unassignUserFromProject(
  projectId: number,
  userId: number
): Promise<void> {
  try {
    await apiPost(`/api/v1/projects/${projectId}/users/${userId}/delete`);
  } catch (e) {
    throw new Error(`unassignUserFromProject failed: ${(e as Error).message}`);
  }
}

export async function getProjectTokens(id: number): Promise<unknown> {
  try {
    const res = await apiGet<ApiResponse<unknown>>(`/api/v1/projects/${id}/tokens`);
    return res.data;
  } catch (e) {
    throw new Error(`getProjectTokens failed: ${(e as Error).message}`);
  }
}

export async function setProjectTokens(
  id: number,
  tokenMode: boolean,
  amend?: string
): Promise<void> {
  try {
    await apiPost(`/api/v1/projects/${id}/tokens`, { tokenMode, amend });
  } catch (e) {
    throw new Error(`setProjectTokens failed: ${(e as Error).message}`);
  }
}

export async function getWebCleanup(id: number): Promise<boolean> {
  try {
    const res = await apiGet<ApiResponse<boolean>>(`/api/v1/projects/${id}/web-cleanup`);
    return res.data;
  } catch (e) {
    throw new Error(`getWebCleanup failed: ${(e as Error).message}`);
  }
}

export async function setWebCleanup(id: number, enable: boolean): Promise<void> {
  try {
    await apiPost(`/api/v1/projects/${id}/web-cleanup`, { enable });
  } catch (e) {
    throw new Error(`setWebCleanup failed: ${(e as Error).message}`);
  }
}

export async function getWebhookCleanup(id: number): Promise<boolean> {
  try {
    const res = await apiGet<ApiResponse<boolean>>(`/api/v1/projects/${id}/web-hook-cleanup`);
    return res.data;
  } catch (e) {
    throw new Error(`getWebhookCleanup failed: ${(e as Error).message}`);
  }
}

export async function setWebhookCleanup(id: number, enable: boolean): Promise<void> {
  try {
    await apiPost(`/api/v1/projects/${id}/web-hook-cleanup`, { enable });
  } catch (e) {
    throw new Error(`setWebhookCleanup failed: ${(e as Error).message}`);
  }
}

export async function getMaxReservations(id: number): Promise<number> {
  try {
    const res = await apiGet<ApiResponse<number>>(`/api/v1/projects/${id}/max-reservations`);
    return res.data;
  } catch (e) {
    throw new Error(`getMaxReservations failed: ${(e as Error).message}`);
  }
}

export async function setMaxReservations(id: number, max: number): Promise<void> {
  try {
    await apiPost(`/api/v1/projects/${id}/max-reservations`, { maxReservations: max });
  } catch (e) {
    throw new Error(`setMaxReservations failed: ${(e as Error).message}`);
  }
}

export async function getMaxQueuedTests(id: number): Promise<number> {
  try {
    const res = await apiGet<ApiResponse<number>>(`/api/v1/projects/${id}/max-queued-tests`);
    return res.data;
  } catch (e) {
    throw new Error(`getMaxQueuedTests failed: ${(e as Error).message}`);
  }
}

export async function setMaxQueuedTests(id: number, max: number): Promise<void> {
  try {
    await apiPost(`/api/v1/projects/${id}/max-queued-tests`, { maxQueuedTests: max });
  } catch (e) {
    throw new Error(`setMaxQueuedTests failed: ${(e as Error).message}`);
  }
}

export async function getProjectNotes(id: number): Promise<string | null> {
  try {
    const res = await apiGet<ApiResponse<string | null>>(`/api/v1/projects/${id}/notes`);
    return res.data;
  } catch (e) {
    throw new Error(`getProjectNotes failed: ${(e as Error).message}`);
  }
}

export async function setProjectNotes(id: number, notes: string): Promise<void> {
  try {
    // notes endpoint expects query param, not a JSON body.
    await apiPost(`/api/v1/projects/${id}/notes`, undefined, { notes });
  } catch (e) {
    throw new Error(`setProjectNotes failed: ${(e as Error).message}`);
  }
}

export async function deleteProjectNotes(id: number): Promise<void> {
  try {
    await apiDelete(`/api/v1/projects/${id}/notes`);
  } catch (e) {
    throw new Error(`deleteProjectNotes failed: ${(e as Error).message}`);
  }
}

export async function getProjectCreatedAt(id: number, currentTimestamp: string): Promise<number> {
  try {
    const res = await apiGet<ApiResponse<number>>(
      `/api/v1/projects/${id}/created-at`,
      { current_timestamp: currentTimestamp }
    );
    return res.data;
  } catch (e) {
    throw new Error(`getProjectCreatedAt failed: ${(e as Error).message}`);
  }
}

export async function getProjectDevices(id: number): Promise<Device[]> {
  try {
    const res = await apiGet<ApiResponse<Device[]>>(`/api/v1/projects/${id}/devices`);
    return res.data;
  } catch (e) {
    throw new Error(`getProjectDevices failed: ${(e as Error).message}`);
  }
}

export async function setTelephonyStatus(
  id: number,
  allowCalls: boolean,
  allowSMS: boolean
): Promise<void> {
  try {
    await apiPost(`/api/v1/projects/${id}/allow-telephony`, { allowCalls, allowSMS });
  } catch (e) {
    throw new Error(`setTelephonyStatus failed: ${(e as Error).message}`);
  }
}

export async function getMaxConcurrentBrowserSessions(id: number): Promise<number> {
  try {
    const res = await apiGet<ApiResponse<number>>(
      `/api/v1/projects/${id}/max-concurrent-browser`
    );
    return res.data;
  } catch (e) {
    throw new Error(`getMaxConcurrentBrowserSessions failed: ${(e as Error).message}`);
  }
}

export async function setMaxConcurrentBrowserSessions(
  id: number,
  max: number
): Promise<void> {
  try {
    await apiPost(`/api/v1/projects/${id}/max-concurrent-browser`, { max });
  } catch (e) {
    throw new Error(`setMaxConcurrentBrowserSessions failed: ${(e as Error).message}`);
  }
}

export async function getAutomationProperties(
  projectId?: number
): Promise<AutomationProperty[]> {
  try {
    const params: Record<string, unknown> = {};
    if (projectId !== undefined) params['projectId'] = projectId;
    const res = await apiGet<ApiResponse<AutomationProperty[]>>(
      '/api/v1/projects/automationProperties',
      params
    );
    return res.data;
  } catch (e) {
    throw new Error(`getAutomationProperties failed: ${(e as Error).message}`);
  }
}

export async function assignApplicationToProject(
  projectId: number,
  appId: number
): Promise<void> {
  try {
    await apiPut(`/api/v1/projects/${projectId}/application/${appId}/assign`);
  } catch (e) {
    throw new Error(`assignApplicationToProject failed: ${(e as Error).message}`);
  }
}

// v2 API — Cloud Admin JWT only. Returns the full project detail including
// 35+ configuration fields not available in the v1 list endpoint:
// license limits per type, cleanup flags, reservation settings, feature flags.
export async function getProjectAdminDetail(projectId: number): Promise<ProjectAdminDetail> {
  try {
    return await apiGet<ProjectAdminDetail>(`/api/v2/projects/${projectId}`);
  } catch (e) {
    throw new Error(`getProjectAdminDetail failed: ${(e as Error).message}`);
  }
}
