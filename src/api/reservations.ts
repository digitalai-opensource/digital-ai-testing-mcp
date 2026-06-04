import { apiGet, apiPost, apiDelete } from './client.js';
import { parseApiDate } from '../utils/timestamp.js';
import type {
  ApiResponse,
  DeviceReservation,
  ReservationFilters,
  AddReservationParams,
} from '../types/digital-ai.js';

export async function getCurrentAndFutureReservations(
  filters?: ReservationFilters
): Promise<DeviceReservation[]> {
  try {
    // Only pass confirmed-working server-side params. Others (project name, deviceUid array,
    // start/end date) are silently ignored or cause 400 errors when passed to the API.
    const params: Record<string, unknown> = {};
    if (filters?.username) params['username'] = filters.username;
    if (filters?.projectId !== undefined) params['projectId'] = filters.projectId;
    if (filters?.deviceId !== undefined) params['deviceId'] = filters.deviceId;
    if (filters?.serialNumber) params['serialNumber'] = filters.serialNumber;

    const res = await apiGet<ApiResponse<DeviceReservation[]>>(
      '/api/v1/device-reservations',
      params
    );

    let data = res.data ?? [];

    // Apply client-side filters that the server doesn't support.
    if (filters?.project) {
      const q = filters.project.toLowerCase();
      data = data.filter(r => r.project.toLowerCase().includes(q));
    }
    if (filters?.deviceUid && filters.deviceUid.length > 0) {
      const uids = new Set(filters.deviceUid.map(u => u.toLowerCase()));
      data = data.filter(r => uids.has(r.deviceUid.toLowerCase()));
    }
    if (filters?.start) {
      const startTs = new Date(filters.start).getTime();
      data = data.filter(r => parseApiDate(r.reservationEnd).getTime() >= startTs);
    }
    if (filters?.end) {
      const endTs = new Date(filters.end).getTime();
      data = data.filter(r => parseApiDate(r.reservationStart).getTime() <= endTs);
    }

    return data;
  } catch (e) {
    throw new Error(`getCurrentAndFutureReservations failed: ${(e as Error).message}`);
  }
}

export async function deleteReservation(reservationId: number): Promise<void> {
  try {
    await apiDelete(`/api/v1/device-reservations/${reservationId}`);
  } catch (e) {
    throw new Error(`deleteReservation failed: ${(e as Error).message}`);
  }
}

export async function addReservation(
  params: AddReservationParams
): Promise<Array<{ message: string; reservationId: number; deviceUid: string }>> {
  try {
    const res = await apiPost<
      ApiResponse<Array<{ message: string; reservationId: number; deviceUid: string }>>
    >('/api/v1/device-reservations', params);
    return res.data;
  } catch (e) {
    throw new Error(`addReservation failed: ${(e as Error).message}`);
  }
}
