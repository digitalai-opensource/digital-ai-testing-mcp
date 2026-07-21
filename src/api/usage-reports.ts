import { writeFile } from 'fs/promises';
import { apiDownload } from './client.js';
import { USAGE_REPORT_TYPES, usageReportUtcMs, type UsageReportType } from '../utils/usage-report-guard.js';
import { parseCsv } from '../utils/csv.js';
import { summarizeRows, type SummarizeOptions, type SummaryResult } from '../utils/usage-report-summary.js';

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

/** Fetches the raw CSV bytes without writing anything to disk. */
export async function fetchUsageReportCsv(reportType: UsageReportType, params: UsageReportRequest): Promise<Buffer> {
  const path = buildUsageReportPath(reportType, params);
  return apiDownload(path);
}

export async function downloadUsageReport(
  reportType: UsageReportType,
  params: UsageReportRequest,
  localPath: string
): Promise<{ bytes: number }> {
  try {
    const data = await fetchUsageReportCsv(reportType, params);
    await writeFile(localPath, data);
    return { bytes: data.length };
  } catch (e) {
    throw new Error(`downloadUsageReport failed: ${(e as Error).message}`);
  }
}

/**
 * Fetches the CSV into memory and aggregates it by a column — e.g. session
 * counts by username — without ever writing a file. Exists specifically so
 * this works from a client whose filesystem is not the MCP server's own
 * (see CLAUDE.md's "Usage Report CSV Exports" notes): no file crosses that
 * boundary at all, so there is nothing for the caller to fail to read back.
 */
export async function summarizeUsageReport(
  reportType: UsageReportType,
  params: UsageReportRequest,
  opts: SummarizeOptions
): Promise<SummaryResult> {
  try {
    const data = await fetchUsageReportCsv(reportType, params);
    const parsed = parseCsv(data.toString('utf8'));
    return summarizeRows(parsed, opts);
  } catch (e) {
    throw new Error(`summarizeUsageReport failed: ${(e as Error).message}`);
  }
}
