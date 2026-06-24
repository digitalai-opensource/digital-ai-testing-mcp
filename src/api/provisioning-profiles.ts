import { createReadStream } from 'fs';
import { writeFile } from 'fs/promises';
import FormData from 'form-data';
import { apiGet, apiDelete, apiPostForm, apiDownload } from './client.js';
import type { ApiResponse, ProvisioningProfile } from '../types/digital-ai.js';

export async function uploadProvisioningProfile(
  p12FilePath: string,
  password: string,
  mobileprovisionFilePath: string,
  notes?: string
): Promise<void> {
  try {
    const form = new FormData();
    form.append('p12file', createReadStream(p12FilePath));
    form.append('password', password);
    form.append('mobileprovisionfile', createReadStream(mobileprovisionFilePath));
    if (notes) form.append('notes', notes);

    await apiPostForm('/api/v1/provisioning-profiles', form);
  } catch (e) {
    throw new Error(`uploadProvisioningProfile failed: ${(e as Error).message}`);
  }
}

export async function getAllProvisioningProfiles(): Promise<ProvisioningProfile[]> {
  try {
    const res = await apiGet<ApiResponse<ProvisioningProfile[]>>('/api/v1/provisioning-profiles');
    return res.data;
  } catch (e) {
    throw new Error(`getAllProvisioningProfiles failed: ${(e as Error).message}`);
  }
}

export async function getProvisioningProfile(profileUUID: string): Promise<ProvisioningProfile> {
  try {
    const res = await apiGet<ApiResponse<ProvisioningProfile>>(
      `/api/v1/provisioning-profiles/${profileUUID}`
    );
    return res.data;
  } catch (e) {
    throw new Error(`getProvisioningProfile failed: ${(e as Error).message}`);
  }
}

export async function downloadProvisioningProfile(
  profileUUID: string,
  localPath: string
): Promise<void> {
  try {
    const data = await apiDownload(`/api/v1/provisioning-profiles/${profileUUID}/download`);
    await writeFile(localPath, data);
  } catch (e) {
    throw new Error(`downloadProvisioningProfile failed: ${(e as Error).message}`);
  }
}

export async function deleteProvisioningProfile(profileUUID: string): Promise<void> {
  try {
    await apiDelete(`/api/v1/provisioning-profiles/${profileUUID}`);
  } catch (e) {
    throw new Error(`deleteProvisioningProfile failed: ${(e as Error).message}`);
  }
}
