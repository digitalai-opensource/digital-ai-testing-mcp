import { apiGet, apiPost, apiPut, apiDelete } from './client.js';
import type {
  ApiResponse,
  CreateDeviceGroupParams,
  EditDeviceGroupParams,
  DeviceGroupV2,
  Project,
  Device,
} from '../types/digital-ai.js';

// v2 endpoint returns an array with richer fields than the v1 id→name dict.
// Cloud Admin (JWT) only — project keys receive 403.
export async function getDeviceGroupsV2(): Promise<DeviceGroupV2[]> {
  try {
    const res = await apiGet<DeviceGroupV2[]>('/api/v2/device-groups');
    return Array.isArray(res) ? res : [];
  } catch (e) {
    throw new Error(`getDeviceGroupsV2 failed: ${(e as Error).message}`);
  }
}

export async function createDeviceGroup(
  params: CreateDeviceGroupParams
): Promise<{ id: string }> {
  try {
    // Creation endpoints expect query params, not a JSON body.
    const qp: Record<string, unknown> = { name: params.name };
    if (params.acceptNewDevices !== undefined) qp['acceptNewDevices'] = params.acceptNewDevices;
    const res = await apiPost<ApiResponse<{ id: string }>>('/api/v1/device-groups/new', undefined, qp);
    return res.data;
  } catch (e) {
    throw new Error(`createDeviceGroup failed: ${(e as Error).message}`);
  }
}

export async function getDeviceGroups(): Promise<Record<string, string>> {
  try {
    const res = await apiGet<ApiResponse<Record<string, string>>>('/api/v1/device-groups');
    return res.data;
  } catch (e) {
    throw new Error(`getDeviceGroups failed: ${(e as Error).message}`);
  }
}

export async function editDeviceGroup(
  groupId: string,
  params: EditDeviceGroupParams
): Promise<void> {
  try {
    await apiPut(`/api/v1/device-groups/${groupId}`, params);
  } catch (e) {
    throw new Error(`editDeviceGroup failed: ${(e as Error).message}`);
  }
}

export async function deleteDeviceGroup(groupId: string): Promise<void> {
  try {
    await apiDelete(`/api/v1/device-groups/${groupId}`);
  } catch (e) {
    throw new Error(`deleteDeviceGroup failed: ${(e as Error).message}`);
  }
}

export async function getProjectsInDeviceGroup(groupId: string): Promise<Project[]> {
  try {
    const res = await apiGet<ApiResponse<Project[]>>(
      `/api/v1/device-groups/${groupId}/projects`
    );
    return res.data;
  } catch (e) {
    throw new Error(`getProjectsInDeviceGroup failed: ${(e as Error).message}`);
  }
}

export async function getDevicesInDeviceGroup(groupId: string): Promise<Device[]> {
  try {
    const res = await apiGet<ApiResponse<Device[]>>(
      `/api/v1/device-groups/${groupId}/devices`
    );
    return res.data;
  } catch (e) {
    throw new Error(`getDevicesInDeviceGroup failed: ${(e as Error).message}`);
  }
}

export async function addDevicesToDeviceGroup(
  groupId: string,
  deviceIds: string[]
): Promise<void> {
  try {
    // The PUT endpoint expects deviceIdList as a query param, not a JSON body.
    await apiPut(`/api/v1/device-groups/${groupId}/devices/`, undefined, {
      deviceIdList: deviceIds.join(','),
    });
  } catch (e) {
    throw new Error(`addDevicesToDeviceGroup failed: ${(e as Error).message}`);
  }
}

export async function removeDevicesFromDeviceGroup(
  groupId: string,
  deviceIds: string[]
): Promise<void> {
  try {
    await apiDelete(`/api/v1/device-groups/${groupId}/devices/`, {
      deviceIdList: deviceIds.join(','),
    });
  } catch (e) {
    throw new Error(`removeDevicesFromDeviceGroup failed: ${(e as Error).message}`);
  }
}

export async function assignDeviceGroupToProject(
  projectId: string,
  deviceGroupId: string
): Promise<void> {
  try {
    await apiPut(`/api/v1/projects/${projectId}/device-groups/`, { deviceGroupId });
  } catch (e) {
    throw new Error(`assignDeviceGroupToProject failed: ${(e as Error).message}`);
  }
}

export async function unassignDeviceGroupFromProject(
  projectId: string,
  deviceGroupId: string
): Promise<void> {
  try {
    await apiDelete(`/api/v1/projects/${projectId}/device-groups/`, { deviceGroupId });
  } catch (e) {
    throw new Error(`unassignDeviceGroupFromProject failed: ${(e as Error).message}`);
  }
}
