import { apiGet, apiPost, apiPut } from './client.js';
import type {
  ApiResponse,
  User,
  CreateUserParams,
  ProjectAssignment,
  MyAccountInfo,
} from '../types/digital-ai.js';

export async function getUsers(): Promise<User[]> {
  try {
    const res = await apiGet<ApiResponse<User[]>>('/api/v1/users');
    return res.data;
  } catch (e) {
    throw new Error(`getUsers failed: ${(e as Error).message}`);
  }
}

export async function createUser(
  params: CreateUserParams
): Promise<{ id: string; password: string; users: string }> {
  try {
    // The /api/v1/users/new endpoint expects query parameters, not a JSON body.
    // Response fields: id (string), password (notification HTML), users (status message).
    const qp: Record<string, unknown> = { ...params };
    const res = await apiPost<ApiResponse<{ id: string; password: string; users: string }>>(
      '/api/v1/users/new',
      undefined,
      qp
    );
    return res.data;
  } catch (e) {
    throw new Error(`createUser failed: ${(e as Error).message}`);
  }
}

export async function deleteUser(userId: number): Promise<void> {
  try {
    await apiPost(`/api/v1/users/${userId}/delete`);
  } catch (e) {
    throw new Error(`deleteUser failed: ${(e as Error).message}`);
  }
}

export async function getMyAccountInfo(): Promise<MyAccountInfo> {
  try {
    const res = await apiGet<ApiResponse<MyAccountInfo>>('/api/v1/users/my-account-info');
    return res.data;
  } catch (e) {
    throw new Error(`getMyAccountInfo failed: ${(e as Error).message}`);
  }
}

export async function assignUserToProjects(
  userId: number,
  assignments: ProjectAssignment[]
): Promise<User> {
  try {
    const res = await apiPost<ApiResponse<User>>(
      `/api/v1/users/${userId}/projects/assign`,
      assignments
    );
    return res.data;
  } catch (e) {
    throw new Error(`assignUserToProjects failed: ${(e as Error).message}`);
  }
}

export async function unassignUserFromProjects(
  userId: number,
  projectIds: number[]
): Promise<void> {
  try {
    await apiPost(`/api/v1/users/${userId}/projects/unassign`, projectIds);
  } catch (e) {
    throw new Error(`unassignUserFromProjects failed: ${(e as Error).message}`);
  }
}

export async function setUserTags(userId: number, tags: string[]): Promise<void> {
  try {
    await apiPut(`/api/v1/users/${userId}/tags`, tags);
  } catch (e) {
    throw new Error(`setUserTags failed: ${(e as Error).message}`);
  }
}

export async function getUserTags(userId: number): Promise<string[]> {
  try {
    // GET /api/v1/users/{id}/tags returns 405 — tags are only available from
    // the full user list. Fetch all users and find the matching record.
    const res = await apiGet<ApiResponse<User[]>>('/api/v1/users');
    const user = (res.data ?? []).find(u => u.id === userId);
    return user?.tags ?? [];
  } catch (e) {
    throw new Error(`getUserTags failed: ${(e as Error).message}`);
  }
}

