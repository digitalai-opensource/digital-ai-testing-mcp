import { writeFile } from 'fs/promises';
import { apiDownload } from './client.js';
import { USAGE_REPORT_TYPES, usageReportUtcMs, type UsageReportType } from '../utils/usage-report-guard.js';

// v2 API — Cloud Admin only. Confirmed live: a project-level key (Project Admin
// or Project User) gets a 403 "This endpoint requires Cloud Admin access", same
// as list_agents/list_regions/etc.

export interface UsageReportRequest {
  startDate: string; // "YYYY-MM-DD", inclusive
  endDate: string; // "YYYY-MM-DD", inclusive
  projectId?: number;
  userId?: number;
}

/** Path segments are project/user/startMs/endMs/objectType — 0 means "All" for project/user. */
export function buildUsageReportPath(reportType: UsageReportType, params: UsageReportRequest): string {
  const caps = USAGE_REPORT_TYPES[reportType];
  const startMs = usageReportUtcMs(params.startDate, 'start');
  const endMs = usageReportUtcMs(params.endDate, 'end');
  const projectSegment = params.projectId ?? 0;
  const userSegment = params.userId ?? 0;
  return `/api/v2/configuration/get-CSV-reports/${projectSegment}/${userSegment}/${startMs}/${endMs}/${encodeURIComponent(caps.wireValue)}`;
}

export async function downloadUsageReport(
  reportType: UsageReportType,
  params: UsageReportRequest,
  localPath: string
): Promise<{ bytes: number }> {
  try {
    const path = buildUsageReportPath(reportType, params);
    const data = await apiDownload(path);
    await writeFile(localPath, data);
    return { bytes: data.length };
  } catch (e) {
    throw new Error(`downloadUsageReport failed: ${(e as Error).message}`);
  }
}
