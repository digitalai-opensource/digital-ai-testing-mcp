import { createReadStream } from 'fs';
import { writeFile } from 'fs/promises';
import FormData from 'form-data';
import { apiGet, apiPost, apiPatch, apiPostForm, apiDownload } from './client.js';
import type {
  ApiResponse,
  Application,
  ApplicationFilters,
  UploadAppParams,
  AppPlugin,
} from '../types/digital-ai.js';

// These endpoints return resources directly — the Digital.ai API does not wrap them in the
// standard { status, data, code } ApiResponse envelope used by most other endpoints.
export async function getApplications(filters?: ApplicationFilters): Promise<Application[]> {
  try {
    const params: Record<string, unknown> = {};
    if (filters?.osType) params['osType'] = filters.osType;
    if (filters?.packageName) params['packageName'] = filters.packageName;
    if (filters?.mainActivity) params['mainActivity'] = filters.mainActivity;
    if (filters?.bundleIdentifier) params['bundleIdentifier'] = filters.bundleIdentifier;
    if (filters?.uniqueName) params['uniqueName'] = filters.uniqueName;
    if (filters?.buildVersion) params['buildVersion'] = filters.buildVersion;
    if (filters?.releaseVersion) params['releaseVersion'] = filters.releaseVersion;
    if (filters?.cameraSupport !== undefined) params['cameraSupport'] = filters.cameraSupport;
    if (filters?.networkCaptureSupport !== undefined)
      params['networkCaptureSupport'] = filters.networkCaptureSupport;
    if (filters?.isForSimulator !== undefined) params['isForSimulator'] = filters.isForSimulator;
    if (filters?.hasCustomKeystore !== undefined)
      params['hasCustomKeystore'] = filters.hasCustomKeystore;
    if (filters?.fileType) params['fileType'] = filters.fileType;
    if (filters?.autoTrustEnterpriseDeveloper !== undefined)
      params['autoTrustEnterpriseDeveloper'] = filters.autoTrustEnterpriseDeveloper;
    if (filters?.installMDM !== undefined) params['installMDM'] = filters.installMDM;

    return await apiGet<Application[]>('/api/v1/applications', params);
  } catch (e) {
    throw new Error(`getApplications failed: ${(e as Error).message}`);
  }
}

export async function getApplicationInfo(applicationId: number): Promise<Application> {
  try {
    return await apiGet<Application>(`/api/v1/applications/${applicationId}`);
  } catch (e) {
    throw new Error(`getApplicationInfo failed: ${(e as Error).message}`);
  }
}

export async function uploadApplication(
  filePath: string,
  params: UploadAppParams
): Promise<{ id: string; created: boolean; name?: string; buildVersion?: string; releaseVersion?: string }> {
  try {
    const form = new FormData();
    form.append('file', createReadStream(filePath));

    if (params.uniqueName) form.append('uniqueName', params.uniqueName);
    if (params.camera !== undefined) form.append('camera', String(params.camera));
    if (params.touchId !== undefined) form.append('touchId', String(params.touchId));
    if (params.project) form.append('project', params.project);
    if (params.uuid) form.append('uuid', params.uuid);
    if (params.fixKeychainAccess !== undefined)
      form.append('fixKeychainAccess', String(params.fixKeychainAccess));
    if (params.overrideEntitlements)
      form.append('overrideEntitlements', params.overrideEntitlements);
    if (params.allowResign !== undefined) form.append('allowResign', String(params.allowResign));
    if (params.signPlugins !== undefined) form.append('signPlugins', String(params.signPlugins));
    if (params.installMDM !== undefined) form.append('installMDM', String(params.installMDM));
    if (params.installAttributesMDM)
      form.append('installAttributesMDM', JSON.stringify(params.installAttributesMDM));
    if (params.autoTrustEnterpriseDeveloper !== undefined)
      form.append('autoTrustEnterpriseDeveloper', String(params.autoTrustEnterpriseDeveloper));
    if (params.networkCaptureSupport !== undefined)
      form.append('networkCaptureSupport', String(params.networkCaptureSupport));

    const res = await apiPostForm<ApiResponse<{ id: string; created: boolean; name?: string; buildVersion?: string; releaseVersion?: string }>>(
      '/api/v1/applications/new',
      form
    );
    return res.data;
  } catch (e) {
    throw new Error(`uploadApplication failed: ${(e as Error).message}`);
  }
}

export async function uploadApplicationFromUrl(
  url: string,
  params: UploadAppParams
): Promise<{ id: string; created: boolean; name?: string; buildVersion?: string; releaseVersion?: string }> {
  try {
    const body: Record<string, unknown> = { url, ...params };
    const res = await apiPost<ApiResponse<{ id: string; created: boolean; name?: string; buildVersion?: string; releaseVersion?: string }>>(
      '/api/v1/applications/new-from-url',
      body
    );
    return res.data;
  } catch (e) {
    throw new Error(`uploadApplicationFromUrl failed: ${(e as Error).message}`);
  }
}

export async function deleteApplication(applicationId: number): Promise<void> {
  try {
    await apiPost(`/api/v1/applications/${applicationId}/delete`);
  } catch (e) {
    throw new Error(`deleteApplication failed: ${(e as Error).message}`);
  }
}

export async function updateApplicationPlugins(
  applicationId: number,
  plugins: AppPlugin[]
): Promise<AppPlugin[]> {
  try {
    const res = await apiPatch<{ plugins: AppPlugin[] }>(
      `/api/v1/applications/${applicationId}`,
      { plugins }
    );
    return res.plugins;
  } catch (e) {
    throw new Error(`updateApplicationPlugins failed: ${(e as Error).message}`);
  }
}

export async function installApplication(
  applicationId: number,
  options: {
    deviceId?: string;
    devicesList?: string;
    allDevices?: boolean;
    instrument?: boolean;
    keepData?: boolean;
  }
): Promise<Record<string, string>> {
  try {
    const res = await apiPost<ApiResponse<Record<string, string>>>(
      `/api/v1/applications/${applicationId}/install`,
      options
    );
    return res.data;
  } catch (e) {
    throw new Error(`installApplication failed: ${(e as Error).message}`);
  }
}

export async function uninstallApplication(
  applicationId: number,
  options: { deviceId?: string; devicesList?: string; allDevices?: boolean }
): Promise<Record<string, string>> {
  try {
    const res = await apiPost<ApiResponse<Record<string, string>>>(
      `/api/v1/applications/${applicationId}/uninstall`,
      options
    );
    return res.data;
  } catch (e) {
    throw new Error(`uninstallApplication failed: ${(e as Error).message}`);
  }
}

export async function uninstallApplicationByPackage(
  deviceId: string,
  packageName: string
): Promise<void> {
  try {
    await apiPost('/api/v1/applications/uninstall-by-packageName', { deviceId, packageName });
  } catch (e) {
    throw new Error(`uninstallApplicationByPackage failed: ${(e as Error).message}`);
  }
}

export async function uninstallApplicationByPackageFromDevices(
  devicesList: string,
  packageName: string
): Promise<void> {
  try {
    await apiPost('/api/v1/applications/uninstall-by-packageName-devices', {
      devicesList,
      packageName,
    });
  } catch (e) {
    throw new Error(`uninstallApplicationByPackageFromDevices failed: ${(e as Error).message}`);
  }
}

export async function extractLanguageFiles(
  applicationId: number,
  localPath: string
): Promise<void> {
  try {
    const data = await apiDownload(`/api/v1/applications/${applicationId}/language-file`);
    await writeFile(localPath, data);
  } catch (e) {
    throw new Error(`extractLanguageFiles failed: ${(e as Error).message}`);
  }
}
