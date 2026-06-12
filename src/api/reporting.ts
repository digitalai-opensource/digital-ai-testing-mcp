import { writeFile } from 'fs/promises';
import { apiGet, apiPost, apiDownload, getActiveKeyType } from './client.js';
import type {
  TestReport,
  TestListRequest,
  TestListResponse,
  TestGroupRequest,
  TestFilterField,
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
  keyValuePairs?: Record<string, unknown>;
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
export async function getTestById(testId: number, includeSteps = false): Promise<TestReport> {
  try {
    const raw = await apiGet<RawSingleTest>(`/reporter/api/tests/${testId}`, { includeSteps });
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

    // Sort params are CSRF-blocked for project API keys — silently strip so callers don't fail.
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

export async function downloadTestAttachments(uuid: string, localPath: string): Promise<void> {
  try {
    const data = await apiDownload(`/reporter/api/reports/${uuid}/attachments`);
    await writeFile(localPath, data);
  } catch (e) {
    throw new Error(`downloadTestAttachments failed: ${(e as Error).message}`);
  }
}
