import { writeFile } from 'fs/promises';
import AdmZip from 'adm-zip';
import { apiGet, apiPost, apiDownload, apiDownloadRange, getActiveUrl } from './client.js';
import type { ReportRef } from '../utils/report-ref.js';
import { serverSortAvailable, markActiveServerSortRefused } from './access-level.js';
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
// Confirmed blocked for every credential type and role.
// Note: test_id was previously listed here but live testing confirmed it works fine.
const CSRF_BLOCKED_FILTER_PROPS = new Set(['start_time', 'create_time', 'uuid']);

// Server-side sort is ATTEMPTED for every role (validated live 2026-10-08: ProjectAdmin and User keys get
// results identical to a full scan; earlier notes said project roles were CSRF-blocked). If the platform
// refuses it, listTests retries without sort, remembers the refusal for that credential, and reports
// `sortApplied: false`. Callers that early-exit on sorted order MUST check `sortApplied`.

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
  projectName?: string;     // present on /reporter/api/reports/{uuid}
  sharingEnabled?: boolean; // public share links allowed for this report's project
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
    // status_code and project_id are not in the single-record response — they used to be filled with 0, which
    // contradicted the list record for the same test (UAT 2026-10-10). Omitted now; projectName is set below.
    success: raw.success,
    start_time: raw.startTime,
    create_time: raw.startTime,
    duration: raw.duration ?? null,
    has_attachment: attachments.length > 0 ? 'Y' : 'N',
    // Counts the attachment files themselves (matches list_test_attachments). The list record's attachment_count is
    // the platform's own figure and can be lower for the same test.
    attachment_count: attachments.length,
    attachments_size: totalSize,
    subTestCount: raw.count ?? undefined,
    failedSubTestCount: raw.failedCount ?? undefined,
    cause: raw.keyValuePairs?.cause ?? undefined,
    errorCategory: raw.keyValuePairs?.errorCategory ?? undefined,
    errorClassification: raw.keyValuePairs?.errorClassification ?? undefined,
    errorDetail: raw.keyValuePairs?.['error.object'] ?? undefined,
    // Which pool the mobile automation test actually ran on (platform 26.7+): "shared" or "dedicated".
    ...(raw.keyValuePairs?.['device.pool.actual'] ? { devicePool: String(raw.keyValuePairs['device.pool.actual']) } : {}),
    ...(raw.projectName ? { projectName: raw.projectName } : {}),
    ...(raw.sharingEnabled != null ? { sharingEnabled: raw.sharingEnabled } : {}),
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

// Retrieve a single test report by its UUID — GET /reporter/api/reports/{uuid} (verified live 2026-10-09 for Cloud
// Admin, ProjectAdmin and User keys). PREFER this over getTestById: UUIDs are global, while numeric test_ids collide
// across reporter scopes (see src/utils/report-ref.ts). A report in a project the key cannot see → 403.
export async function getTestByUuid(uuid: string): Promise<TestReport> {
  try {
    const raw = await apiGet<RawSingleTest>(`/reporter/api/reports/${encodeURIComponent(uuid)}`);
    return normalizeSingleTest(raw);
  } catch (e) {
    throw new Error(`getTestByUuid failed: ${(e as Error).message}`);
  }
}

// ─── AI Root Cause Analysis (platform 26.8+, premium) ────────────────────────
// Endpoints from the reporter UI bundle, verified live 2026-10-09:
//  - GET  /reporter/api/rca/info                  → { enabled, pollIntervalSec, jobTimeoutMins }
//  - GET  /reporter/api/reports/{uuid}/rca/status → { attemptCount, lastStatus, lastRcaId }
//  - POST /reporter/api/reports/{uuid}/rca/trigger (not wrapped: on the dev tenant every eligible trigger since 2026-10-06
//    fails upstream with 500 rca/submission-failed, and each failure burns one of only 3 attempts per test)
//  - results live in the report's keyValuePairs: rca.status (e.g. COMPLETED), rca.description (the hypothesis),
//    rca.evidence (JSON [{source, time, log, findings}]), rca.id
// Trigger refusals (403 problem types): framework-not-supported (only Appium Server / "Appium OSS" tests),
// already-completed, max-attempts-exceeded (3 failed attempts), service-not-available (RCA not enabled for the project).

export const RCA_MAX_ATTEMPTS = 3;

export interface RcaEvidence { source?: string; time?: string; log?: string; findings?: string }

export interface RootCauseAnalysis {
  uuid: string;
  testId: number;
  name: string;
  testStatus: string;
  framework: string | null;
  projectName: string | null;
  serviceEnabled: boolean | null;
  /** Normalized lower-case: completed | queued | running | failed | timeout | submission_failed | none. */
  status: string;
  attemptCount: number | null;
  attemptsRemaining: number | null;
  rcaId: string | null;
  hypothesis: string | null;
  evidence: RcaEvidence[];
  /** The reporter's (non-RCA) AI error classification, when present. */
  classification: { errorCategory?: string; errorClassification?: string; cause?: string };
  /** Why a trigger would be refused, when that can be told from the record. */
  ineligibleReason: string | null;
}

/** Pure: assemble the analysis view from a raw report + the two RCA endpoints. Unit-tested with live-shaped fixtures. */
export function buildRootCauseAnalysis(
  raw: { uuid: string; id: number; name: string; status: string; projectName?: string; keyValuePairs?: Record<string, unknown> },
  rcaStatus: { attemptCount?: number; lastStatus?: string | null; lastRcaId?: string | null } | null,
  info: { enabled?: boolean } | null
): RootCauseAnalysis {
  const kv = raw.keyValuePairs ?? {};
  const s = (k: string) => (kv[k] == null || kv[k] === '' ? undefined : String(kv[k]));
  let evidence: RcaEvidence[] = [];
  const ev = s('rca.evidence');
  if (ev) {
    try { const parsed = JSON.parse(ev); if (Array.isArray(parsed)) evidence = parsed as RcaEvidence[]; } catch { evidence = [{ findings: ev }]; }
  }
  const status = (s('rca.status') ?? rcaStatus?.lastStatus ?? 'none').toLowerCase();
  const attempts = typeof rcaStatus?.attemptCount === 'number' ? rcaStatus.attemptCount : null;
  const framework = s('test.framework') ?? null;
  let ineligibleReason: string | null = null;
  if (status === 'completed') ineligibleReason = 'An analysis already completed for this report (re-running is not allowed).';
  else if (raw.status === 'Passed' || raw.status === 'Healed') ineligibleReason = 'The test passed — there is nothing to analyse.';
  else if (framework && !/appium/i.test(framework)) ineligibleReason = `RCA only supports Appium Server (Appium OSS) tests; this report's framework is ${framework}.`;
  else if (attempts != null && attempts >= RCA_MAX_ATTEMPTS && status !== 'queued' && status !== 'running') {
    ineligibleReason = `All ${RCA_MAX_ATTEMPTS} attempts are used — a cloud administrator must reset them.`;
  } else if (info?.enabled === false) ineligibleReason = 'RCA is not enabled on this cloud.';
  return {
    uuid: raw.uuid,
    testId: raw.id,
    name: raw.name,
    testStatus: raw.status,
    framework,
    projectName: raw.projectName ?? null,
    serviceEnabled: typeof info?.enabled === 'boolean' ? info.enabled : null,
    status,
    attemptCount: attempts,
    attemptsRemaining: attempts == null ? null : Math.max(0, RCA_MAX_ATTEMPTS - attempts),
    rcaId: s('rca.id') ?? rcaStatus?.lastRcaId ?? null,
    hypothesis: s('rca.description') ?? null,
    evidence,
    classification: {
      ...(s('errorCategory') ? { errorCategory: s('errorCategory') } : {}),
      ...(s('errorClassification') ? { errorClassification: s('errorClassification') } : {}),
      ...(s('cause') ? { cause: s('cause') } : {}),
    },
    ineligibleReason,
  };
}

/** One fetch of the raw report (by UUID or numeric id — the single-record GET carries the UUID either way), then the RCA endpoints. */
export async function getRootCauseAnalysis(ref: ReportRef): Promise<RootCauseAnalysis> {
  try {
    const raw = await apiGet<{ uuid: string; id: number; name: string; status: string; projectName?: string; keyValuePairs?: Record<string, unknown> }>(
      ref.kind === 'uuid' ? `/reporter/api/reports/${encodeURIComponent(ref.uuid)}` : `/reporter/api/tests/${ref.testId}`
    );
    const uuid = raw.uuid;
    // Status and info are best-effort: a report is still worth showing when the RCA service endpoints are unavailable.
    const [rcaStatus, info] = await Promise.all([
      apiGet<{ attemptCount?: number; lastStatus?: string | null; lastRcaId?: string | null }>(`/reporter/api/reports/${encodeURIComponent(uuid)}/rca/status`).catch(() => null),
      apiGet<{ enabled?: boolean }>('/reporter/api/rca/info').catch(() => null),
    ]);
    return buildRootCauseAnalysis(raw, rcaStatus, info);
  } catch (e) {
    throw new Error(`getRootCauseAnalysis failed: ${(e as Error).message}`);
  }
}

export interface ReportShare {
  /** Public link — opens the report (page, data, video) with NO authentication. */
  publicUrl: string;
  token: string;
  /** ISO timestamp — exactly 14 days after the share was first created. */
  expires: string;
}

/**
 * Create (or return the existing) public share link for a report — POST /reporter/api/reports/{uuid}/share
 * (platform 26.5; endpoint found in the reporter UI bundle, verified live 2026-10-09):
 *  - the response is { testReportShare: <token>, expires: <ISO> }; the link is <base>/reporter/html-report/public/<token>
 *  - re-sharing is idempotent — the same token and expiry come back, so the 14-day window is NOT extended
 *  - unauthenticated readers get the report page, its JSON (/reporter/api/public/reports/<token>, incl. keyValuePairs)
 *    and its video
 *  - there is no revoke endpoint: deleting the report makes the link 404
 *  - 400 = sharing disabled for the project (reporter project setting reportSharingEnabled)
 */
export async function shareTestReport(uuid: string): Promise<ReportShare> {
  try {
    const res = await apiPost<{ testReportShare: string; expires: string }>(`/reporter/api/reports/${encodeURIComponent(uuid)}/share`);
    if (!res?.testReportShare) throw new Error('the platform returned no share token');
    return {
      publicUrl: `${getActiveUrl().replace(/\/+$/, '')}/reporter/html-report/public/${res.testReportShare}`,
      token: res.testReportShare,
      expires: res.expires,
    };
  } catch (e) {
    const msg = (e as Error).message;
    if (/\[400\]/.test(msg)) {
      throw new Error(`shareTestReport failed: public sharing is disabled for this report's project — a project admin must enable report sharing in the Reporter project settings. (${msg})`);
    }
    throw new Error(`shareTestReport failed: ${msg}`);
  }
}

// Retrieve a single test report by its numeric test_id. The id is resolved in the CREDENTIAL'S reporter scope — the
// same number can be a different test in another project. Use getTestByUuid when the UUID is known.
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

    const wantsSort = !!(finalRequest.sort && finalRequest.sort.length > 0);
    // A credential the platform already refused sort for skips straight to the unsorted request.
    if (wantsSort && !serverSortAvailable()) {
      finalRequest = { ...finalRequest, sort: undefined };
    }

    // projectId (numeric) is CSRF-blocked on all reporter endpoints — only projectName works.
    const params: Record<string, unknown> = {};
    if (projectName) params['projectName'] = projectName;
    const post = (body: TestListRequest) => apiPost<TestListResponse>('/reporter/api/tests/list', body, params);

    try {
      const res = await post(finalRequest);
      return wantsSort ? { ...res, sortApplied: finalRequest.sort !== undefined } : res;
    } catch (e) {
      // Sort refused (401/403)? Retry without it. Only REMEMBER the refusal if the unsorted retry succeeds —
      // if it fails too, this was a genuine auth/network problem and the original error stands.
      if (finalRequest.sort !== undefined && /\[(401|403)\]/.test((e as Error).message)) {
        const res = await post({ ...finalRequest, sort: undefined });
        markActiveServerSortRefused();
        return { ...res, sortApplied: false };
      }
      throw e;
    }
  } catch (e) {
    throw new Error(`listTests failed: ${(e as Error).message}`);
  }
}

// Fetch tests reliably sorted by start_time descending regardless of role.
// Fast path: one server-sorted call. If the platform refuses sort for this credential, an unsorted
// first page is NOT the most recent — scan all pages (up to maxScan records), sort client-side, and
// trim to the requested limit. Callers that need "latest"/"most recent" semantics
// must use this instead of passing sort to listTests directly.
export async function listTestsSortedDesc(
  request: TestListRequest,
  projectId?: number,
  projectName?: string,
  maxScan = 5000
): Promise<TestListResponse & { scanCapped?: boolean }> {
  if (serverSortAvailable()) {
    const sorted = await listTests(
      { ...request, sort: [{ property: 'start_time', descending: true }] },
      projectId,
      projectName
    );
    if (sorted.sortApplied) return sorted;
    // Refused just now (and remembered) — fall through to the client-side scan.
  }
  const limit = request.limit ?? 50;
  const all: TestReport[] = [];
  let page = 1;
  let scanCapped = false;
  // The scan is capped, so its length is NOT the total. When the caller asked for a total, take it from the server
  // on page 1 (unsorted counts are fine) — reporting the capped scan length as `count` made get_project_test_summary
  // print exactly "failed: 5000" for a tenant with 29k failures.
  let serverTotal: number | undefined;
  while (true) {
    const batch = await listTests(
      { ...request, limit: 500, page, sort: undefined, returnTotalCount: page === 1 && request.returnTotalCount === true },
      projectId,
      projectName
    );
    if (page === 1 && request.returnTotalCount === true && typeof batch.count === 'number') serverTotal = batch.count;
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
  return { count: serverTotal ?? all.length, data: all.slice(0, limit), scanCapped };
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
    // CSRF-blocked, so fetch (server-sorted desc when the platform allows it, to enable early-exit)
    // and filter the date window client-side.
    const startTs = opts.startDate ? new Date(opts.startDate).getTime() : 0;
    const endTs = opts.endDate ? new Date(opts.endDate).getTime() : Date.now();

    const collected: TestReport[] = [];
    let page = 1;
    let scanned = 0;
    let done = false;
    const maxScan = 5000;

    while (!done && collected.length < maxReports) {
      const wantSort = serverSortAvailable();
      const batch = await listTests(
        {
          limit: 500,
          page,
          returnTotalCount: false,
          filter,
          ...(wantSort && { sort: [{ property: 'start_time', descending: true }] }),
        },
        opts.projectId,
        opts.projectName
      );
      if (wantSort && batch.sortApplied === false && page > 1) {
        // Sort was refused partway through a sorted scan. Unsorted page N is NOT a continuation of sorted
        // pages 1..N-1 — restart from page 1 (the refusal is now remembered, so the rescan is unsorted throughout).
        collected.length = 0;
        scanned = 0;
        page = 1;
        continue;
      }
      const recs = batch.data ?? [];
      if (recs.length === 0) break;
      scanned += recs.length;
      const isSorted = batch.sortApplied === true; // early-exit only when the server really sorted
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

/**
 * Session video, without the rest of the attachment ZIP. Verified live 2026-10-09: GET /reporter/api/reports/{uuid}/video
 * and /reporter/api/tests/{id}/video both serve video/mp4 with Accept-Ranges: bytes — "bytes=0-0" → 206 with
 * Content-Range "bytes 0-0/<total>", suffix ("bytes=-100") and open ("bytes=1000-") ranges work, an out-of-bounds
 * range → 416, an unknown UUID → 404. The report's `videos` field is NOT a reliable "has video" signal (null on a
 * report whose video endpoint served 627 KB), so ask the endpoint. Prefer the UUID: numeric ids collide across projects.
 */
export function testVideoPath(ref: ReportRef): string {
  return ref.kind === 'uuid' ? `/reporter/api/reports/${ref.uuid}/video` : `/reporter/api/tests/${ref.testId}/video`;
}

export interface TestVideoInfo {
  totalBytes: number | null;
  contentType: string | null;
}

/** Total size and type from a one-byte range request — no full download. */
export async function getTestVideoInfo(ref: ReportRef): Promise<TestVideoInfo> {
  try {
    const res = await apiDownloadRange(testVideoPath(ref), 'bytes=0-0');
    const total = res.contentRange?.match(/\/(\d+)\s*$/)?.[1];
    return { totalBytes: total ? Number(total) : res.status === 200 ? res.data.length : null, contentType: res.contentType ?? null };
  } catch (e) {
    throw new Error(`getTestVideoInfo failed: ${(e as Error).message}`);
  }
}

export interface TestVideoDownload {
  bytesWritten: number;
  totalBytes: number | null;
  partial: boolean;
  contentRange: string | null;
  contentType: string | null;
}

/** Download the whole video, or one byte range of it ("bytes=0-1048575", "bytes=-100", "bytes=1000-"). */
export async function downloadTestVideo(ref: ReportRef, localPath: string, range?: string): Promise<TestVideoDownload> {
  try {
    const res = await apiDownloadRange(testVideoPath(ref), range);
    if (res.contentType && !/^video\//i.test(res.contentType)) {
      throw new Error(`expected a video but got ${res.contentType} — this report may have no recording`);
    }
    await writeFile(localPath, res.data);
    const total = res.contentRange?.match(/\/(\d+)\s*$/)?.[1];
    return {
      bytesWritten: res.data.length,
      totalBytes: total ? Number(total) : res.status === 200 ? res.data.length : null,
      partial: res.status === 206,
      contentRange: res.contentRange ?? null,
      contentType: res.contentType ?? null,
    };
  } catch (e) {
    throw new Error(`downloadTestVideo failed: ${(e as Error).message}`);
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
