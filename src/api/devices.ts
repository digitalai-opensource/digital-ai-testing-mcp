import { writeFile } from 'fs/promises';
import { apiGet, apiPost, apiPut, apiDelete, apiDownload } from './client.js';
import type {
  ApiResponse,
  Device,
  EditDeviceParams,
  DeviceReservationEntry,
  ManualTestStep,
} from '../types/digital-ai.js';

export async function getAllDevices(): Promise<Device[]> {
  try {
    const res = await apiGet<ApiResponse<Device[]>>('/api/v1/devices');
    return res.data;
  } catch (e) {
    throw new Error(`getAllDevices failed: ${(e as Error).message}`);
  }
}

export async function getDevicesByQuery(query: string): Promise<Device[]> {
  try {
    const params = query ? { query } : {};
    const res = await apiGet<ApiResponse<Device[]>>('/api/v1/devices', params);
    return res.data;
  } catch (e) {
    throw new Error(`getDevicesByQuery failed: ${(e as Error).message}`);
  }
}

export async function getDevice(deviceId: string): Promise<Device> {
  try {
    const res = await apiGet<ApiResponse<Device>>(`/api/v1/devices/${deviceId}`);
    return res.data;
  } catch (e) {
    throw new Error(`getDevice failed: ${(e as Error).message}`);
  }
}

export async function editDevice(deviceId: string, params: EditDeviceParams): Promise<void> {
  try {
    await apiPost(`/api/v1/devices/${deviceId}`, params);
  } catch (e) {
    throw new Error(`editDevice failed: ${(e as Error).message}`);
  }
}

export async function getDeviceReservations(
  deviceId: string,
  start: string,
  end: string,
  currentTimestamp: string
): Promise<DeviceReservationEntry[]> {
  try {
    const res = await apiGet<ApiResponse<DeviceReservationEntry[]>>(
      `/api/v1/devices/${deviceId}/reservations`,
      { start, end, current_timestamp: currentTimestamp }
    );
    return res.data;
  } catch (e) {
    throw new Error(`getDeviceReservations failed: ${(e as Error).message}`);
  }
}

export async function reserveDevice(
  deviceId: string,
  start: string,
  end: string,
  clientCurrentTimestamp: string,
  userId?: string,
  projectId?: string,
  notes?: string
): Promise<{ reservationId: number }> {
  try {
    // Endpoint expects query parameters, not a JSON body.
    const qp: Record<string, unknown> = { start, end, clientCurrentTimestamp };
    if (userId) qp['userId'] = userId;
    if (projectId) qp['projectId'] = projectId;
    if (notes) qp['notes'] = notes;
    const res = await apiPost<ApiResponse<{ reservationId: number }>>(
      `/api/v1/devices/${deviceId}/reservations/new`,
      undefined,
      qp
    );
    return res.data;
  } catch (e) {
    throw new Error(`reserveDevice failed: ${(e as Error).message}`);
  }
}

export async function reserveMultipleDevices(
  devicesList: string,
  start: string,
  end: string,
  clientCurrentTimestamp: string,
  userId?: string,
  projectId?: string,
  notes?: string
): Promise<Record<string, string>> {
  try {
    // Endpoint expects query parameters, not a JSON body.
    const qp: Record<string, unknown> = { devicesList, start, end, clientCurrentTimestamp };
    if (userId) qp['userId'] = userId;
    if (projectId) qp['projectId'] = projectId;
    if (notes) qp['notes'] = notes;
    const res = await apiPost<ApiResponse<Record<string, string>>>(
      '/api/v1/devices/reservations/new',
      undefined,
      qp
    );
    return res.data;
  } catch (e) {
    throw new Error(`reserveMultipleDevices failed: ${(e as Error).message}`);
  }
}

export async function releaseDevice(deviceId: string): Promise<void> {
  try {
    await apiPost(`/api/v1/devices/${deviceId}/release`);
  } catch (e) {
    throw new Error(`releaseDevice failed: ${(e as Error).message}`);
  }
}

export async function rebootDevice(deviceId: string): Promise<void> {
  try {
    await apiPost(`/api/v1/devices/${deviceId}/reboot`);
  } catch (e) {
    throw new Error(`rebootDevice failed: ${(e as Error).message}`);
  }
}

export async function resetDeviceUsb(deviceId: string): Promise<void> {
  try {
    await apiPost(`/api/v1/devices/${deviceId}/resetusb`);
  } catch (e) {
    throw new Error(`resetDeviceUsb failed: ${(e as Error).message}`);
  }
}

export async function downloadIosAppContainer(
  deviceId: string,
  bundleId: string,
  localPath: string
): Promise<void> {
  try {
    const data = await apiDownload(`/api/v1/devices/${deviceId}/app-container/${bundleId}`);
    await writeFile(localPath, data);
  } catch (e) {
    throw new Error(`downloadIosAppContainer failed: ${(e as Error).message}`);
  }
}

export async function startDeviceWebControl(
  deviceId: string,
  type: 0 | 1 | 2 | 3,
  emulatorInstanceName?: string
): Promise<{ deviceId: number; regularLink: string; externalLink: string | null }> {
  try {
    const body: Record<string, unknown> = { type };
    if (emulatorInstanceName) body['emulatorInstanceName'] = emulatorInstanceName;
    const res = await apiPut<ApiResponse<{ deviceId: number; regularLink: string; externalLink: string | null }>>(
      `/api/v1/devices/${deviceId}/web-control`,
      body
    );
    return res.data;
  } catch (e) {
    throw new Error(`startDeviceWebControl failed: ${(e as Error).message}`);
  }
}

// Both openMobileStudio and createMobileManualTest POST to the same endpoint.
// The API distinguishes them by payload shape: the presence of testName+testSteps
// triggers structured test mode and returns a report_api_id; without them the
// API returns only a session link. This matches the browser API pattern
// (startWebControlWithTemplate vs startWebControlSession in browsers.ts).
export async function openMobileStudio(deviceQuery: string): Promise<{ link: string }> {
  try {
    const res = await apiPost<ApiResponse<{ link: string }>>(
      '/api/v1/devices/web-control',
      { deviceQuery }
    );
    return res.data;
  } catch (e) {
    throw new Error(`openMobileStudio failed: ${(e as Error).message}`);
  }
}

export async function createMobileManualTest(
  deviceQuery: string,
  testName: string,
  testSteps: ManualTestStep[]
): Promise<{ link: string; report_api_id: string }> {
  try {
    const res = await apiPost<ApiResponse<{ link: string; report_api_id: string }>>(
      '/api/v1/devices/web-control',
      { deviceQuery, testName, testSteps }
    );
    return res.data;
  } catch (e) {
    throw new Error(`createMobileManualTest failed: ${(e as Error).message}`);
  }
}

export async function getDeviceTags(deviceId: string): Promise<string[]> {
  try {
    const res = await apiGet<ApiResponse<string[]>>(`/api/v1/devices/${deviceId}/tags`);
    return res.data;
  } catch (e) {
    throw new Error(`getDeviceTags failed: ${(e as Error).message}`);
  }
}

export async function addDeviceTag(deviceId: string, tagValue: string): Promise<void> {
  try {
    await apiPut(`/api/v1/devices/${deviceId}/tags/${tagValue}`);
  } catch (e) {
    throw new Error(`addDeviceTag failed: ${(e as Error).message}`);
  }
}

export async function removeDeviceTag(deviceId: string, tagValue: string): Promise<void> {
  try {
    await apiDelete(`/api/v1/devices/${deviceId}/tags/${tagValue}`);
  } catch (e) {
    throw new Error(`removeDeviceTag failed: ${(e as Error).message}`);
  }
}

export async function removeAllDeviceTags(deviceId: string): Promise<void> {
  try {
    await apiDelete(`/api/v1/devices/${deviceId}/tags`);
  } catch (e) {
    throw new Error(`removeAllDeviceTags failed: ${(e as Error).message}`);
  }
}

export async function getDeviceCaCertificates(deviceId: string): Promise<string[]> {
  try {
    const res = await apiGet<ApiResponse<string[]>>(`/api/v1/devices/${deviceId}/cacerts`);
    return res.data;
  } catch (e) {
    throw new Error(`getDeviceCaCertificates failed: ${(e as Error).message}`);
  }
}
