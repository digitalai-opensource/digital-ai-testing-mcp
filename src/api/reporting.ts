import { writeFile } from 'fs/promises';
import AdmZip from 'adm-zip';
import { apiGet, apiPost, apiDownload, getActiveKeyType } from './client.js';
import type {
  TestReport,
  TestListRequest,
  TestListResponse,
  TestGroupRequest,
  TestFilterField,
  FailureBucket,
  FailureSummary,
} from '../types/digital-ai.js';

// The reporter API does not use the standard ApiResponse {status,data,code} envelope.
// List endpoints return {count, data} directly; single-resource endpoints return
// the object directly with camelCase fields — normalised to TestReport before returning.

// Properties that route through CSRF-protected middleware and fail regardless of auth type.
// Confirmed blocked on both JWT (Cloud Admin) and X-API-KEY (project user) tokens.
// Note: test_id was previously listed here but live testing confirmed it works fine.
const CSRF_BLOCKED_FILTER_PROPS = new Set(['start_time', 'create_time', 'uuid']);

// ALL sort fields are CSRF-blocked for project API keys (non-JWT).
// Cloud Admin JWT bypasses CSRF via Bearer mechanism; project keys do not.
// sort is silently stripped for project keys — callers must not rely on sorted order.

// Shape returned by GET /reporter/api/tests/{id} — camelCase, different from list shape
interface RawSingleTest {
  uuid: string;
  id: number;
  name: string;
  startTime: string;
  duration: number | null;
  status: string;
  success: boolean;
  count?: number;        // total sub-tests in a merged report (1 for a plain test)
  failedCount?: number;  // failed sub-tests in a merged report
  keyValuePairs?: Record<string, string | null | undefined>;
  testAttachments?: Array<{
    id: number;
    filePath: string;
    type: string;
    size: number;
    originalSize?: number;
    filenameToOpen?: string;
    originalFileName?: string | null;
  }>;
  steps?: Array<{
    name: string;
    status: string;
    duration?: number;
    subSteps?: Array<{ name: string; status: string }>;
  }>;
}

function normalizeSingleTest(raw: RawSingleTest): TestReport {
  const attachments = raw.testAttachments ?? [];
  const totalSize = attachments.reduce((sum, a) => sum + (a.originalSize ?? a.size ?? 0), 0);
  return {
    uuid: raw.uuid,
    test_id: raw.id,
    name: raw.name,
    status: raw.status as TestReport['status'],
    status_code: 0,
    success: raw.success,
    start_time: raw.startTime,
    create_time: raw.startTime,
    duration: raw.duration ?? null,
    project_id: 0,
    has_attachment: attachments.length > 0 ? 'Y' : 'N',
    attachment_count: attachments.length,
    attachments_size: totalSize,
    subTestCount: raw.count ?? undefined,
    failedSubTestCount: raw.failedCount ?? undefined,
    cause: raw.keyValuePairs?.cause ?? undefined,
    errorCategory: raw.keyValuePairs?.errorCategory ?? undefined,
    errorClassification: raw.keyValuePairs?.errorClassification ?? undefined,
    errorDetail: raw.keyValuePairs?.['error.object'] ?? undefined,
    testAttachments: attachments.map((a) => ({
      filePath: a.filenameToOpen ?? a.filePath,
      type: a.type,
      size: a.originalSize ?? a.size,
    })),
    steps: raw.steps?.map((s) => ({
      name: s.name,
      status: s.status,
      duration: s.duration,
      subSteps: s.subSteps?.map((ss) => ({ name: ss.name, status: ss.status })),
    })),
  };
}

// Retrieve a single test report by its numeric test_id.
// The UUID-based endpoint (/api/reports/{uuid}) does not exist in this API surface;
// this is the correct path for API-key authenticated single-record retrieval.
export async function getTestById(testId: number): Promise<TestReport> {
  try {
    const raw = await apiGet<RawSingleTest>(`/reporter/api/tests/${testId}`);
    return normalizeSingleTest(raw);
  } catch (e) {
    throw new Error(`getTestById failed: ${(e as Error).message}`);
  }
}

// Retrieve a test report using the report_api_id returned when a manual or
// web-control session is created. This is NOT the same as the numeric test_id
// from list results — report_api_id only exists on session-created tests.
export async function getTestByReportApiId(
  reportApiId: string,
  includeSteps = false
): Promise<TestReport> {
  try {
    const raw = await apiGet<RawSingleTest>('/reporter/api/tests', {
      report_api_id: reportApiId,
      includeSteps,
    });
    return normalizeSingleTest(raw);
  } catch (e) {
    throw new Error(`getTestByReportApiId failed: ${(e as Error).message}`);
  }
}

// Reject CSRF-blocked filter properties before hitting the API and coerce the
// 'success' value from string to boolean (the string form routes through
// CSRF-checked middleware; the boolean form bypasses it). Shared by listTests
// and getGroupedTests — both endpoints accept the same filter syntax.
function sanitizeReporterFilter(filter: TestFilterField[]): TestFilterField[] {
  const blocked = [...new Set(
    filter
      .filter((f) => CSRF_BLOCKED_FILTER_PROPS.has(f.property))
      .map((f) => f.property)
  )];
  if (blocked.length > 0) {
    throw new Error(
      `Filter properties [${blocked.join(', ')}] are not supported via API key authentication — ` +
      `the Digital.ai reporter API routes these through CSRF-protected middleware. ` +
      `Supported filter properties: status, name, user, has_attachment, success, test_id, project_id, device.os, duration, attachment_count, attachments_size, status_code. ` +
      `For date filtering, use the startDate/endDate parameters instead.`
    );
  }
  return filter.map((f) =>
    f.property === 'success' && typeof f.value === 'string'
      ? { ...f, value: f.value === 'true' }
      : f
  );
}

export async function listTests(
  request: TestListRequest,
  projectId?: number,
  projectName?: string
): Promise<TestListResponse> {
  try {
    let finalRequest = request;

    if (request.filter && request.filter.length > 0) {
      finalRequest = { ...request, filter: sanitizeReporterFilter(request.filter) };
    }

    // Sort params are CSRF-blocked for project-level keys — silently strip so callers don't fail.
    // Date-range pagination in reporting-tools.ts must not rely on sorted order for project keys.
    if (getActiveKeyType() !== 'jwt' && finalRequest.sort && finalRequest.sort.length > 0) {
      finalRequest = { ...finalRequest, sort: undefined };
    }

    // projectId (numeric) is CSRF-blocked on all reporter endpoints — only projectName works.
    const params: Record<string, unknown> = {};
    if (projectName) params['projectName'] = projectName;
    return await apiPost<TestListResponse>('/reporter/api/tests/list', finalRequest, params);
  } catch (e) {
    throw new Error(`listTests failed: ${(e as Error).message}`);
  }
}

// Fetch tests reliably sorted by start_time descending regardless of key type.
// JWT: single sorted call (fast path). Project keys: sort is CSRF-blocked and
// silently stripped by listTests, so an unsorted first page is NOT the most
// recent — scan all pages (up to maxScan records), sort client-side, and trim
// to the requested limit. Callers that need "latest"/"most recent" semantics
// must use this instead of passing sort to listTests directly.
export async function listTestsSortedDesc(
  request: TestListRequest,
  projectId?: number,
  projectName?: string,
  maxScan = 5000
): Promise<TestListResponse & { scanCapped?: boolean }> {
  if (getActiveKeyType() === 'jwt') {
    return listTests(
      { ...request, sort: [{ property: 'start_time', descending: true }] },
      projectId,
      projectName
    );
  }
  const limit = request.limit ?? 50;
  const all: TestReport[] = [];
  let page = 1;
  let scanCapped = false;
  while (true) {
    const batch = await listTests(
      { ...request, limit: 500, page, sort: undefined, returnTotalCount: false },
      projectId,
      projectName
    );
    const records = batch.data ?? [];
    all.push(...records);
    if (records.length < 500) break;
    if (all.length >= maxScan) {
      scanCapped = true;
      break;
    }
    page++;
  }
  all.sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());
  return { count: all.length, data: all.slice(0, limit), scanCapped };
}

export type FailureGroupBy = 'errorClassification' | 'errorCategory' | 'name';

// Pure aggregation — no network, unit-tested with fixtures. Buckets failed test
// reports by a dimension, counts each, and keeps a few examples per bucket.
// Empty/missing dimension values collapse into a single '(unclassified)' bucket.
export function bucketFailures(
  reports: TestReport[],
  groupBy: FailureGroupBy,
  maxExamples = 3
): FailureBucket[] {
  const map = new Map<string, FailureBucket>();
  for (const r of reports) {
    const raw = r[groupBy];
    const key = raw == null || raw === '' ? '(unclassified)' : String(raw);
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { key, count: 0, examples: [] };
      map.set(key, bucket);
    }
    bucket.count++;
    if (bucket.examples.length < maxExamples) {
      bucket.examples.push({ testId: r.test_id, name: r.name });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

// Summarize WHY tests failed by bucketing them on a dimension. The reporter LIST
// endpoint does not carry errorClassification/errorCategory (confirmed live), so
// bucketing on those requires a single-record fetch per failed test (N+1). The
// fan-out is bounded by maxReports; groupBy:'name' needs no detail (name is on the
// list record) and skips the fan-out entirely.
export async function summarizeTestFailures(opts: {
  startDate?: string;
  endDate?: string;
  projectId?: number;
  projectName?: string;
  nameFilter?: string;
  groupBy?: FailureGroupBy;
  maxReports?: number;
}): Promise<FailureSummary> {
  try {
    const groupBy = opts.groupBy ?? 'errorClassification';
    const maxReports = opts.maxReports ?? 200;

    const filter: TestFilterField[] = [{ property: 'status', operator: '=', value: 'Failed' }];
    if (opts.nameFilter) filter.push({ property: 'name', operator: 'contains', value: opts.nameFilter });

    // Same window-scan strategy as list_test_reports: start_time filtering is
    // CSRF-blocked, so fetch (sorted desc for JWT to allow early-exit) and filter
    // the date window client-side.
    const isSorted = getActiveKeyType() === 'jwt';
    const startTs = opts.startDate ? new Date(opts.startDate).getTime() : 0;
    const endTs = opts.endDate ? new Date(opts.endDate).getTime() : Date.now();

    const collected: TestReport[] = [];
    let page = 1;
    let scanned = 0;
    let done = false;
    const maxScan = 5000;

    while (!done && collected.length < maxReports) {
      const batch = await listTests(
        {
          limit: 500,
          page,
          returnTotalCount: false,
          filter,
          ...(isSorted && { sort: [{ property: 'start_time', descending: true }] }),
        },
        opts.projectId,
        opts.projectName
      );
      const recs = batch.data ?? [];
      if (recs.length === 0) break;
      scanned += recs.length;
      for (const r of recs) {
        const t = new Date(r.start_time).getTime();
        if (isSorted && t < startTs) { done = true; break; }
        if (t >= startTs && t <= endTs) {
          collected.push(r);
          if (collected.length >= maxReports) { done = true; break; }
        }
      }
      if (recs.length < 500) done = true;
      if (!done && scanned >= maxScan) { done = true; }
      page++;
    }

    // Only errorClassification/errorCategory require the per-test detail fetch.
    // Tolerate per-report failures (a deleted/unreadable report must not abort the
    // whole summary) — skip and count them, mirroring bulk_install_to_group.
    const needsDetail = groupBy === 'errorClassification' || groupBy === 'errorCategory';
    let classified = collected;
    let fetchFailures = 0;
    if (needsDetail) {
      classified = [];
      for (const summary of collected) {
        try {
          classified.push(await getTestById(summary.test_id));
        } catch {
          fetchFailures++;
        }
      }
    }

    return {
      totalFailures: collected.length,
      detailsFetched: needsDetail ? classified.length : 0,
      fetchFailures,
      capped: collected.length >= maxReports,
      groupBy,
      buckets: bucketFailures(classified, groupBy),
    };
  } catch (e) {
    throw new Error(`summarizeTestFailures failed: ${(e as Error).message}`);
  }
}

export async function getGroupedTests(
  request: TestGroupRequest,
  projectId?: number,
  projectName?: string
): Promise<unknown> {
  try {
    let finalRequest = request;
    if (request.filter && request.filter.length > 0) {
      finalRequest = { ...request, filter: sanitizeReporterFilter(request.filter) };
    }
    // projectId (numeric) is CSRF-blocked on reporter endpoints — use projectName only.
    const params: Record<string, unknown> = {};
    if (projectName) params['projectName'] = projectName;
    return await apiPost<unknown>('/reporter/api/tests/grouped', finalRequest, params);
  } catch (e) {
    throw new Error(`getGroupedTests failed: ${(e as Error).message}`);
  }
}

// The /reporter/api/tests/distinct endpoint returns distinct value combinations
// for the requested keys as an array of objects: { count, data: [{key: val}, ...] }.
// It is NOT a Record<key, string[]> — we extract per-key distinct values client-side.
export async function getDistinctKeyValues(
  keys: string[],
  projectId?: number,
  projectName?: string
): Promise<Record<string, string[]>> {
  try {
    // projectId (numeric) is CSRF-blocked on reporter endpoints — use projectName only.
    const params: Record<string, unknown> = {};
    if (projectName) params['projectName'] = projectName;
    const raw = await apiPost<{ count: number | null; data: Record<string, unknown>[] }>(
      '/reporter/api/tests/distinct',
      { keys },
      params
    );
    // Extract distinct values per key from the returned rows.
    const result: Record<string, string[]> = {};
    for (const key of keys) {
      const seen = new Set<string>();
      for (const row of raw.data ?? []) {
        const v = row[key];
        if (v != null) seen.add(String(v));
      }
      result[key] = [...seen].sort();
    }
    return result;
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('[401]') || msg.toLowerCase().includes('csrf')) {
      throw new Error(
        'PLATFORM_LIMITATION: The distinct-key-values endpoint requires browser session authentication ' +
        'on this platform. It is not accessible via API key on your deployment. ' +
        'Use get_grouped_test_reports with a keys array as an alternative.'
      );
    }
    throw new Error(`getDistinctKeyValues failed: ${msg}`);
  }
}

export async function deleteTests(
  ids: number[],
  projectId?: number,
  projectName?: string
): Promise<void> {
  try {
    // projectId (numeric) is CSRF-blocked on reporter endpoints — use projectName only.
    const params: Record<string, unknown> = {};
    if (projectName) params['projectName'] = projectName;
    await apiPost('/reporter/api/tests/delete', ids, params);
  } catch (e) {
    throw new Error(`deleteTests failed: ${(e as Error).message}`);
  }
}

export async function extractAttachmentLog(
  uuid: string,
  logType: 'appium' | 'device' | 'ws'
): Promise<{ filename: string; content: string; totalLines: number }> {
  try {
    const data = await apiDownload(`/reporter/api/reports/${uuid}/attachments`);
    const zip = new AdmZip(data);
    const logEntries = zip.getEntries().filter((e) => !e.isDirectory && e.entryName.endsWith('.log'));

    const matchers: Record<string, (name: string) => boolean> = {
      appium: (n) => n.includes('appium-server') || n.includes('appium'),
      device: (n) => n.includes('device') && !n.includes('ws') && !n.includes('tcp'),
      ws: (n) => n.includes('ws_on_device') || n.includes('tcp_to_ws'),
    };
    const entry = logEntries.find((e) => matchers[logType](e.entryName.toLowerCase()));

    if (!entry) {
      const available = logEntries.map((e) => e.entryName).join(', ');
      throw new Error(`No ${logType} log found in attachments ZIP. Available log files: ${available || 'none'}`);
    }

    const content = entry.getData().toString('utf8');
    return { filename: entry.entryName, content, totalLines: content.split('\n').length };
  } catch (e) {
    throw new Error(`extractAttachmentLog failed: ${(e as Error).message}`);
  }
}

export async function downloadTestAttachments(uuid: string, localPath: string): Promise<void> {
  try {
    const data = await apiDownload(`/reporter/api/reports/${uuid}/attachments`);
    await writeFile(localPath, data);
  } catch (e) {
    throw new Error(`downloadTestAttachments failed: ${(e as Error).message}`);
  }
}
