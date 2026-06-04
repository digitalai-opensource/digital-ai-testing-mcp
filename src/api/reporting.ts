import { writeFile } from 'fs/promises';
import { apiGet, apiPost, apiDownload } from './client.js';
import type {
  TestReport,
  TestListRequest,
  TestListResponse,
  TestGroupRequest,
} from '../types/digital-ai.js';

// The reporter API does not use the standard ApiResponse {status,data,code} envelope.
// List endpoints return {count, data} directly; single-resource endpoints return
// the object directly with camelCase fields — normalised to TestReport before returning.

// Properties that route through CSRF-protected middleware and fail regardless of auth type.
// Confirmed blocked on both JWT (Cloud Admin) and X-API-KEY (project user) tokens.
// Sort by these fields works fine; only filter is blocked.
// Note: test_id was previously listed here but live testing confirmed it works fine.
const CSRF_BLOCKED_FILTER_PROPS = new Set(['start_time', 'create_time', 'uuid']);

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

export async function listTests(
  request: TestListRequest,
  projectId?: number,
  projectName?: string
): Promise<TestListResponse> {
  try {
    let finalRequest = request;

    if (request.filter && request.filter.length > 0) {
      // Check for CSRF-blocked filter properties before hitting the API.
      // These properties route through session-authenticated middleware and
      // return 401 CSRF errors for API-key callers regardless of headers sent.
      const blocked = [...new Set(
        request.filter
          .filter((f) => CSRF_BLOCKED_FILTER_PROPS.has(f.property))
          .map((f) => f.property)
      )];
      if (blocked.length > 0) {
        throw new Error(
          `Filter properties [${blocked.join(', ')}] are not supported via API key authentication — ` +
          `the Digital.ai reporter API routes these through CSRF-protected middleware. ` +
          `Supported filter properties: status, name, has_attachment, success. ` +
          `For date filtering, retrieve results without a date filter and filter by start_time in the returned data.`
        );
      }

      // Coerce 'success' filter value from string to boolean. The string form ("true")
      // routes through CSRF-checked middleware; the boolean form (true) bypasses it.
      const coercedFilter = request.filter.map((f) =>
        f.property === 'success' && typeof f.value === 'string'
          ? { ...f, value: f.value === 'true' }
          : f
      );
      finalRequest = { ...request, filter: coercedFilter };
    }

    const params: Record<string, unknown> = {};
    if (projectId !== undefined) params['projectId'] = projectId;
    if (projectName) params['projectName'] = projectName;
    return await apiPost<TestListResponse>('/reporter/api/tests/list', finalRequest, params);
  } catch (e) {
    throw new Error(`listTests failed: ${(e as Error).message}`);
  }
}

export async function getGroupedTests(
  request: TestGroupRequest,
  projectId?: number,
  projectName?: string
): Promise<unknown> {
  try {
    const params: Record<string, unknown> = {};
    if (projectId !== undefined) params['projectId'] = projectId;
    if (projectName) params['projectName'] = projectName;
    return await apiPost<unknown>('/reporter/api/tests/grouped', request, params);
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
    const params: Record<string, unknown> = {};
    if (projectId !== undefined) params['projectId'] = projectId;
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
    const params: Record<string, unknown> = {};
    if (projectId !== undefined) params['projectId'] = projectId;
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
