import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TestReport } from '../types/digital-ai.js';
import { z } from 'zod';
import {
  getTestById,
  getScopedTest,
  getTestByUuid,
  shareTestReport,
  getRootCauseAnalysis,
  RCA_MAX_ATTEMPTS,
  getTestByReportApiId,
  listTests,
  listTestsSortedDesc,
  getGroupedTests,
  getGroupedTestsAllProjects,
  getDistinctKeyValues,
  deleteTests,
  downloadTestAttachments,
  downloadTestVideo,
  getTestVideoInfo,
  extractAttachmentLog,
  summarizeTestFailures,
} from '../api/reporting.js';
import { normaliseDeviceOs } from '../api/transactions.js';
import { REPORTER_PROJECT_ID_DESC, resolveReporterProjectName } from '../api/reporter-projects.js';
import { firstTestIdSince } from '../api/report-recipes.js';
import { loosePlan, mergeGroupRows } from '../utils/report-case.js';
import { addDays, dayStart, reportKey, KNOWN_REPORT_KEYS, REPORT_KEYS_HELP } from '../utils/report-recipes.js';
import { serverFsDownloadNotice, serverFsOutputParam, commandGeneratorNotice, localPlatformParamNotice } from '../utils/locality.js';
import { checkDeleteAllowed, serverSortAvailable } from '../api/access-level.js';
import { checkDestructiveGuard } from '../utils/destructive-guard.js';
import { validateOutputPath } from '../utils/path-guard.js';
import { buildDownloadCommand } from '../utils/download-command.js';
import {
  formatTestReport,
  formatTestReportList,
  formatCompactReportList,
  compactReport,
  formatFailureSummary,
  formatTestAttachments,
  formatGroupedTestReports,
  formatProjectTestSummary,
} from '../utils/response-formatter.js';
import { outputFormatParam, respond } from '../utils/output-format.js';
import { commandPayload } from '../utils/command-payload.js';
import { parseReportRef } from '../utils/report-ref.js';
import { selectLogLines, DEFAULT_LOG_CONTEXT, DEFAULT_LOG_MAX_CHARS } from '../utils/log-view.js';
import { getRunningTestRequests, type RunningTestRequest } from '../api/test-requests.js';
import { getAllProjects } from '../api/projects.js';
import { countsFromPivotRow, tallyStatuses, passRate, statusOutcome, unknownStatusCount, PASS_RATE_BASIS } from '../utils/test-status.js';

/**
 * Where does the lookback cutoff fall in the newest-first record order? Probes single records (limit 1, page = index+1)
 * instead of extrapolating a rate. Returns neededRecords (rounded up, 5% headroom) when the window fits under maxCap,
 * else fittingLookbackDays read from the record AT maxCap. About 10 tiny requests. Throws if the platform stops sorting.
 */
export async function measureTrendWindow(
  cutoffTs: number, scannedUpTo: number, maxCap: number, projectId?: number, projectName?: string,
): Promise<{ neededRecords?: number; fittingLookbackDays?: number }> {
  const at = async (index: number): Promise<number | null> => {
    const b = await listTests(
      { limit: 1, page: index + 1, returnTotalCount: false, sort: [{ property: 'start_time', descending: true }] },
      projectId, projectName,
    );
    if (b.sortApplied !== true) throw new Error('sort not applied');
    const r = b.data?.[0];
    return r ? new Date(r.start_time).getTime() : null;
  };
  const atCap = await at(maxCap - 1);
  if (atCap !== null && atCap >= cutoffTs) {
    return { fittingLookbackDays: Math.max(1, Math.floor((Date.now() - atCap) / 86_400_000)) };
  }
  // Records [0, scannedUpTo) are in the window; the record at hi is out of it (or past the end).
  let lo = scannedUpTo;
  let hi = maxCap - 1;
  while (hi - lo > 50) {
    const mid = Math.floor((lo + hi) / 2);
    const t = await at(mid);
    if (t !== null && t >= cutoffTs) lo = mid + 1; else hi = mid;
  }
  return { neededRecords: Math.min(maxCap, Math.ceil((hi * 1.05) / 500) * 500) };
}

/**
 * Names the project a delete runs in. A reporter projectId is resolved to a name before the delete, and reporter IDs
 * differ from the cloud IDs list_projects shows — the preview must say which project the id landed on, so a mixed-up
 * id is visible BEFORE confirmDeletion.
 */
const deleteScopeLabel = (projectName?: string): string => (projectName ? ` in project "${projectName}"` : '');

/**
 * A reporter project_id FILTER only matches inside the project the call is scoped to: for another project's id the
 * platform answers 0 records with no reason (verified live 2026-11-13 — project_id = 89 from the Default scope gave 0,
 * the same project by name 3.1M). An empty result with that filter therefore gets a note pointing at the parameters
 * that do scope the call (intake 2026-11-14: the projectId PARAMETER was fixed, the filter still answered silently).
 */
export function projectIdFilterNote(filter: Array<{ property: string }> | undefined, resultCount: number): string | undefined {
  if (resultCount > 0 || !filter?.some((f) => f.property === 'project_id')) return undefined;
  return 'Note: a project_id filter only matches inside the project this call is scoped to — for another project it ' +
    'returns nothing, as here. To query another project, drop the filter and pass projectId (the reporter project id) or projectName.';
}

/** A request still "Running" after this long is past the default test timeout (4 h) and is probably stuck. */
const STALE_RUNNING_MINUTES = 240;

/**
 * Web (Selenium) reports keep the user in the key "digitalai:user"; mobile reports use "user" (verified live 2026-11-22
 * on Default: user = <email> → 364 mobile reports and no web ones; digitalai:user = <email> → 110 web reports, 32 of them
 * Failed — a "delete my failed reports" cleanup had missed all 32). Grouping on digitalai:user DOES work (verified live
 * 2026-11-24: 56 groups, 55 with a value; an earlier note here said it could not), so a grouping by user also groups by
 * digitalai:user and files each web report under its own user (see get_grouped_test_reports).
 */
export function webUserNote(
  filter: Array<{ property: string; operator?: string; value?: unknown }> | undefined
): string | undefined {
  const userFilter = filter?.find((f) => f.property === 'user');
  const notes: string[] = [];
  if (userFilter && !filter?.some((f) => f.property === 'digitalai:user')) {
    notes.push(
      'Note: web (Selenium) reports keep the user in the key "digitalai:user", not "user", so this user filter matched ' +
      'mobile reports only. For the same user\'s web reports, run the query again with ' +
      `{"property":"digitalai:user","operator":"=","value":${JSON.stringify(userFilter.value ?? '<email>')}} instead of the user filter.`
    );
  }
  return notes.length ? notes.join(' ') : undefined;
}

/** Group rows get_grouped_test_reports returns unless maxGroups says otherwise: about 40 KB of answer. */
const DEFAULT_MAX_GROUPS = 500;
/** The most maxGroups can ask for. */
const MAX_GROUPS = 5000;

/**
 * A `user = <email>` filter rewritten for web reports (`digitalai:user = <email>`), or undefined when there is nothing to
 * add (no equality user filter, or the caller already filters on digitalai:user). The reporter cannot OR two keys, so
 * list_test_reports and get_grouped_test_reports run both queries and merge them — "my reports" includes web runs.
 */
export function webUserTwin<F extends { property: string; operator?: string }>(filter: F[] | undefined): F[] | undefined {
  if (!filter || filter.some((f) => f.property === 'digitalai:user')) return undefined;
  const i = filter.findIndex((f) => f.property === 'user' && (f.operator ?? '=') === '=');
  return i < 0 ? undefined : filter.map((f, j) => (j === i ? { ...f, property: 'digitalai:user' } : f));
}

/** Ascending/descending comparison with missing values LAST in both directions (they must not push real records off a page). */
function compareValues(a: unknown, b: unknown, descending: boolean): number {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
  const c = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
  return descending ? -c : c;
}

/** Two report lists, each in `sort` order (default newest first), as one: de-duplicated by uuid, same order. */
export function mergeReportLists(
  a: TestReport[],
  b: TestReport[],
  sort?: Array<{ property: string; descending: boolean }>
): TestReport[] {
  const { property, descending } = sort?.[0] ?? { property: 'start_time', descending: true };
  const seen = new Set<string>();
  const unique = [...a, ...b].filter((r) => {
    const rec = r as unknown as Record<string, unknown>;
    const id = String(rec.uuid ?? rec.test_id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return unique.sort((x, y) =>
    compareValues((x as unknown as Record<string, unknown>)[property], (y as unknown as Record<string, unknown>)[property], descending)
  );
}

function mergedUserNote(mobile: number | null | undefined, web: number | null | undefined, counted: boolean): string {
  const n = (v: number | null | undefined) => (v == null ? '?' : String(v));
  return `The user filter covered mobile AND web reports: web (Selenium) reports keep the user in "digitalai:user", so both ` +
    `were queried and merged (${counted ? 'matching' : 'found'}: ${n(mobile)} through "user", ${n(web)} through "digitalai:user").`;
}

/** When the caller asks for the "user" key, also fetch "digitalai:user" and show it as user on web records. */
function withWebUserKey(keys: string[] | undefined): string[] | undefined {
  return keys?.includes('user') && !keys.includes('digitalai:user') ? [...keys, 'digitalai:user'] : keys;
}
function fillWebUser(reports: TestReport[], keys: string[] | undefined): TestReport[] {
  if (!keys?.includes('user')) return reports;
  return reports.map((r) => {
    const rec = r as unknown as Record<string, unknown>;
    return rec.user == null && rec['digitalai:user'] != null ? ({ ...rec, user: rec['digitalai:user'] } as unknown as TestReport) : r;
  });
}

export function registerReportingTools(server: McpServer): void {
  // ─── get_test_report ───────────────────────────────────────────────────────

  server.tool(
    'get_test_report',
    'Retrieve a full test execution report by UUID, numeric test ID, or the report URL printed in tearDown (digitalai:reportUrl — e.g. .../reporter/video-report/<uuid>). ' +
    'Provide ONE of uuid, testId or reportUrl. PREFER uuid (or the report URL): UUIDs are global, while numeric test IDs are only unique per project and can resolve to a different test in another project. ' +
    'uuid and test_id are both returned by list_test_reports and find_latest_test_for_name. ' +
    'The single report has projectName but no status_code/project_id (those exist only on list records); its attachment_count ' +
    'counts the attachment files (as list_test_attachments does), which can be higher than the list record\'s figure. ' +
    'NOTE: Step-level detail is not available on this endpoint — the backend API does not support it here. ' +
    'To get steps, use get_test_by_report_id with the report_api_id from a live session. ' +
    'For failure diagnosis use the cause/errorCategory/errorDetail fields in this response, or get_test_log for the full Appium log.',
    {
      uuid: z.string().optional().describe('The test execution UUID (uuid field from list results). Preferred — globally unique.'),
      testId: z.number().int().optional().describe('The numeric test ID (test_id field from list results, e.g. 377918). Unique only within a project — prefer uuid.'),
      reportUrl: z.string().optional().describe('The report URL printed by tearDown (digitalai:reportUrl), e.g. .../reporter/video-report/<uuid> or an older ...?test_id=<n> link. The identifier is extracted automatically.'),
      outputFormat: outputFormatParam,
    },
    async ({ uuid, testId, reportUrl, outputFormat }) => {
      const given = [uuid, testId, reportUrl].filter((v) => v != null && v !== '').length;
      if (given === 0) {
        return { content: [{ type: 'text', text: 'Provide one of uuid, testId or reportUrl.' }], isError: true };
      }
      if (given > 1) {
        return { content: [{ type: 'text', text: 'Provide only ONE of uuid, testId or reportUrl — they could point at different reports.' }], isError: true };
      }
      const ref = parseReportRef(uuid ?? reportUrl ?? testId);
      if (!ref) {
        return {
          content: [{ type: 'text', text: `Could not find a report UUID or numeric test ID in: ${uuid ?? reportUrl}. Use list_test_reports or find_latest_test_for_name to look the test up.` }],
          isError: true,
        };
      }

      try {
        const report = ref.kind === 'uuid' ? await getTestByUuid(ref.uuid) : await getTestById(ref.testId);
        return respond(outputFormat, report, formatTestReport(report));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── share_test_report ─────────────────────────────────────────────────────

  server.tool(
    'share_test_report',
    'Create a PUBLIC link to a test report that anyone can open WITHOUT logging in — the report page, its data (including ' +
    'key-value pairs/capabilities) and its video. Links expire 14 days after first creation; sharing the same report again ' +
    'returns the same link and does NOT extend it. There is no revoke: the only way to disable a link early is to delete the ' +
    'report (delete_test_reports). Requires confirmPublicShare: true — without it, this returns a preview of what would be ' +
    'exposed and shares nothing. Only share when the user explicitly asked for a public/shareable link. ' +
    'Fails if public sharing is disabled for the report\'s project.',
    {
      uuid: z.string().optional().describe('Test execution UUID (uuid field from list_test_reports / get_test_report).'),
      reportUrl: z.string().optional().describe('The report URL (e.g. .../reporter/video-report/<uuid>). Must contain the UUID.'),
      confirmPublicShare: z
        .boolean()
        .optional()
        .describe('Must be true to create the public link. Omit to preview what would be shared.'),
      outputFormat: outputFormatParam,
    },
    async ({ uuid, reportUrl, confirmPublicShare, outputFormat }) => {
      if ((uuid ? 1 : 0) + (reportUrl ? 1 : 0) !== 1) {
        return { content: [{ type: 'text', text: 'Provide exactly one of uuid or reportUrl.' }], isError: true };
      }
      const ref = parseReportRef(uuid ?? reportUrl);
      if (ref?.kind !== 'uuid') {
        return {
          content: [{ type: 'text', text: 'Sharing needs the report UUID (numeric test IDs are not accepted). Get it from list_test_reports or get_test_report (uuid field), or pass the .../video-report/<uuid> URL.' }],
          isError: true,
        };
      }
      try {
        // Fetch first: confirms the report exists and is visible to this credential, and shows what would be exposed.
        const report = await getTestByUuid(ref.uuid);
        const what = `"${report.name}" (${report.status}, ${report.start_time}${report.projectName ? `, project ${report.projectName}` : ''})`;
        if (report.sharingEnabled === false) {
          return {
            content: [{ type: 'text', text: `Public sharing is disabled for ${what}'s project. A project admin must enable report sharing in the Reporter project settings first.` }],
            isError: true,
          };
        }
        if (confirmPublicShare !== true) {
          return {
            content: [{
              type: 'text',
              text:
                `⚠️  Preview — nothing has been shared.\n\n` +
                `This would create a PUBLIC link to ${what}. Anyone with the link can, without logging in:\n` +
                `  • open the report page and its video\n` +
                `  • read the report data, including all key-value pairs / capabilities\n` +
                `The link lasts 14 days and cannot be revoked except by deleting the report.\n\n` +
                `To proceed, call share_test_report again with confirmPublicShare: true.`,
            }],
          };
        }
        const share = await shareTestReport(ref.uuid);
        const structured = { uuid: ref.uuid, testId: report.test_id, name: report.name, publicUrl: share.publicUrl, expires: share.expires };
        const human =
          `🔗 Public link for ${what}:\n${share.publicUrl}\n\n` +
          `Expires: ${share.expires} (14 days after it was first shared — re-sharing does not extend it).\n` +
          `Anyone with this link can view the report, its data and its video without logging in. ` +
          `To disable it early, delete the report (delete_test_reports).`;
        return respond(outputFormat, structured, human);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── get_root_cause_analysis ───────────────────────────────────────────────

  server.tool(
    'get_root_cause_analysis',
    'Read the platform\'s AI Root Cause Analysis for a failed test report: the hypothesis, the supporting evidence ' +
    '(log lines with source, time and findings), the analysis status and attempts used, plus the reporter\'s own error ' +
    'classification (errorCategory / errorClassification / cause). Read-only — it never starts an analysis. ' +
    'Analyses are started from the video report in the Reporter UI; they cover Appium tests only (Appium Server; Appium Grid from platform 26.9) and allow ' +
    '3 failed attempts per test. ineligibleReason explains when an analysis cannot be run. ' +
    'To find analysed reports: list_test_reports with filter rca.status = COMPLETED. The framework shown comes from the ' +
    'report key test.framework — filter list_test_reports on that key (e.g. "Appium Grid") to find candidate reports.',
    {
      uuid: z.string().optional().describe('Test execution UUID. Preferred.'),
      reportUrl: z.string().optional().describe('Report URL (e.g. .../reporter/video-report/<uuid>).'),
      testId: z.number().int().optional().describe('Numeric test id — unique only within a project; prefer uuid.'),
      outputFormat: outputFormatParam,
    },
    async ({ uuid, reportUrl, testId, outputFormat }) => {
      if ([uuid, reportUrl, testId].filter((v) => v != null && v !== '').length !== 1) {
        return { content: [{ type: 'text', text: 'Provide exactly one of uuid, reportUrl or testId.' }], isError: true };
      }
      try {
        const ref = parseReportRef(uuid ?? reportUrl ?? testId);
        if (!ref) return { content: [{ type: 'text', text: `Could not find a report UUID or test id in: ${uuid ?? reportUrl}.` }], isError: true };
        const a = await getRootCauseAnalysis(ref);
        const lines = [
          `🔎 Root Cause Analysis — "${a.name}" (${a.testStatus}${a.framework ? `, ${a.framework}` : ''}${a.projectName ? `, project ${a.projectName}` : ''})`,
          `   Status: ${a.status}` +
            (a.attemptCount != null ? ` · attempts used ${a.attemptCount}/${RCA_MAX_ATTEMPTS}` : '') +
            (a.serviceEnabled === false ? ' · RCA disabled on this cloud' : ''),
        ];
        if (a.hypothesis) lines.push('', `   Hypothesis: ${a.hypothesis}`);
        if (a.evidence.length) {
          lines.push('', '   Evidence:');
          for (const e of a.evidence) {
            lines.push(`     • ${[e.source, e.time].filter(Boolean).join(' @ ')}`);
            if (e.log) lines.push(`       log: ${e.log}`);
            if (e.findings) lines.push(`       → ${e.findings}`);
          }
        }
        if (!a.hypothesis && a.status !== 'completed') {
          lines.push('', a.status === 'none'
            ? '   No analysis has been run for this report.'
            : `   No result: the last analysis attempt ended "${a.status}".`);
        }
        const c = a.classification;
        if (c.errorCategory || c.errorClassification || c.cause) {
          lines.push('', `   Reporter classification: ${[c.errorCategory, c.errorClassification].filter(Boolean).join(' / ')}${c.cause ? ` — ${c.cause}` : ''}`);
        }
        if (a.ineligibleReason) lines.push('', `   ℹ️  ${a.ineligibleReason}`);
        return respond(outputFormat, a, lines.join('\n'));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── get_test_by_report_id ─────────────────────────────────────────────────

  server.tool(
    'get_test_by_report_id',
    'Retrieve a test execution report using the report_api_id returned when starting a manual or web-control test session. CRITICAL: report_api_id is NOT the same as test_id (integer) or uuid (hex UUID). It is a separate opaque string returned only by create_mobile_manual_test, start_manual_test_session, or start_device_web_control. This only works AFTER the session has fully ended AND a tester actually executed it — allow up to 60 seconds after session close. A session that was created but never opened/executed produces NO report and its report_api_id stays 404 permanently. ' +
    'Unlike get_test_report (numeric ID), THIS endpoint supports includeSteps — but the steps array is only populated for tests that logged steps (manual sessions a tester ran, or scripted tests calling the reporter step API). An empty/absent steps array means the test logged no steps, NOT that the tool is broken.',
    {
      reportApiId: z
        .string()
        .describe('The report_api_id string returned by the session-start API (create_mobile_manual_test, start_manual_test_session, or start_device_web_control). NOT the numeric test_id or UUID.'),
      includeSteps: z
        .boolean()
        .optional()
        .describe('If true, steps and sub-steps are included in the response. Default: false.'),
      outputFormat: outputFormatParam,
    },
    async ({ reportApiId, includeSteps, outputFormat }) => {
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (/^\d+$/.test(reportApiId)) {
        return {
          content: [{ type: 'text', text: `Error: "${reportApiId}" is a numeric test_id, not a report_api_id. Use get_test_report(testId: ${reportApiId}) instead. The report_api_id is a separate identifier returned only when starting a session via create_mobile_manual_test or start_manual_test_session.` }],
          isError: true,
        };
      }
      if (UUID_RE.test(reportApiId)) {
        return {
          content: [{ type: 'text', text: `Error: "${reportApiId}" is a test UUID, not a report_api_id. Use get_test_report(uuid: "${reportApiId}") instead. The report_api_id is a different identifier returned only when starting a manual or web-control session.` }],
          isError: true,
        };
      }
      try {
        const report = await getTestByReportApiId(reportApiId, includeSteps ?? false);
        return respond(outputFormat, report, formatTestReport(report));
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
          return {
            content: [{ type: 'text', text: `Error: No test found for report_api_id "${reportApiId}". Possible reasons:\n1. The session is still active — the reporter record is created only after the session ends (allow up to 60 seconds).\n2. This is not a valid report_api_id. The report_api_id is returned by create_mobile_manual_test, start_manual_test_session, or start_device_web_control — it is NOT the numeric test_id or UUID.` }],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ─── list_test_reports ─────────────────────────────────────────────────────

  server.tool(
    'list_test_reports',
    'Search and list test execution reports. Supports filtering, sorting, and pagination. Results are newest first ' +
    '(start_time descending) unless you pass sort. ' +
    'For date-range filtering use startDate/endDate — server-side start_time filtering is CSRF-blocked. ' +
    'When the user asks for "my reports" / "reports linked to my account", filter by user immediately: ' +
    '[{"property":"user","operator":"=","value":"<email from get_my_account_info>"}] — do not return a global count first. ' +
    'A user = <email> filter covers mobile AND web reports: web (Selenium) reports keep the user in "digitalai:user", so the ' +
    'tool also runs the query on that key and merges the results (the note gives both counts; one query is enough). ' +
    'Scoped to a project if projectId or projectName is provided. ' +
    'NOTE: the list response does NOT include failure diagnostics — the cause, errorCategory, and errorDetail fields are only returned by get_test_report (single-record). ' +
    'To diagnose why a listed test failed, call get_test_report with its test_id, or get_test_log for the full Appium log. ' +
    'For "why are my tests failing?" across many failures, use summarize_test_failures — it buckets failures by error classification in one call. ' +
    'SPEED: built-in filters (status, name, test_id, success, test.framework) and project scoping answer in well under a second; ' +
    'a filter on a CUSTOM key (e.g. rca.status, test.run.id, a report key) or searchValue can take 5–40 s on a large reporter ' +
    '(measured live on ~40k records) — combine it with a built-in filter where you can, and do not repeat it to "retry". ' +
    'Use fields: "compact" for lists you only scan (about half the size).',
    {
      fields: z
        .enum(['full', 'compact'])
        .optional()
        .describe(
          '"full" (default): every column of each record. "compact": only test_id, uuid, name, status, start_time, ' +
          'duration plus the keys you asked for — about half the size; use it for scanning or counting, then ' +
          'get_test_report for the records that matter.'
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Number of results to return (default: 50, max: 500).'),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Page number, starting at 1. Default: 1. Ignored when startDate/endDate are provided.'),
      searchValue: z
        .string()
        .optional()
        .describe('Case-insensitive substring search across test names (separate from filter[]).'),
      filter: z
        .array(
          z.object({
            property: z.string().describe(
              'Field to filter on. Confirmed working: ' +
              '"status" (Passed/Failed/Incomplete/Skipped/Error/Healed), ' +
              '"name", ' +
              '"user" (email, exact match — for "my reports" use the email from get_my_account_info; with "=" it also matches web reports through digitalai:user), ' +
              '"digitalai:user" (the key web/Selenium reports keep the user in — filter on it only for web reports alone), ' +
              '"has_attachment" ("Y"/"N"), ' +
              '"success" (boolean true/false), ' +
              '"accessibility_report" (JSON boolean true/false, NOT the string "true" — that 400s; true = runs with an Axe accessibility scan), ' +
              '"test_id" (number), ' +
              '"project_id" (number — matches only INSIDE the project the call is scoped to; for another project it ' +
              'returns 0 records, so pass the projectId or projectName parameter instead), ' +
              '"device.os" ("Android"/"iOS" — case-sensitive), ' +
              '"test.framework" (exact, case-sensitive: "Appium Server", "Appium Grid", "Selenium", "Espresso", "XCUITest", ' +
              '"Maestro", "Playwright", "Cypress", "Mobile Studio Manual", … — get_distinct_test_key_values(["test.framework"]) ' +
              'lists what this cloud has; the key is test.framework, not "framework"), ' +
              '"test.run.id" (the run id from execute_test_run / execute_playwright_run), ' +
              '"rca.status" (e.g. "COMPLETED" — reports with a finished root-cause analysis), ' +
              '"duration" (milliseconds), ' +
              '"attachment_count", ' +
              '"attachments_size" (bytes), ' +
              '"status_code". ' +
              'CSRF-blocked (use startDate/endDate instead): "start_time", "create_time", "uuid".'
            ),
            operator: z.string().describe(
              'Comparison operator. Supported: "=" (equality), ">" ">=" "<" "<=" (numeric/date), "contains" (substring for name). ' +
              'CSRF-blocked operators: "!=", "like", "startsWith", "in". ' +
              'Note: "success" must use boolean value with "="; string "true" is CSRF-blocked.'
            ),
            value: z.union([z.string(), z.number(), z.boolean()]).describe(
              'Filter value. Use boolean true/false for "success" and "accessibility_report", numbers for numeric fields, strings for text fields.'
            ),
          })
        )
        .optional()
        .describe(
          'Server-side filters. Multiple filters are ANDed. ' +
          'Example: [{"property":"status","operator":"=","value":"Failed"},{"property":"device.os","operator":"=","value":"Android"}]'
        ),
      sort: z
        .array(
          z.object({
            property: z.string().describe('Field to sort by, e.g. "start_time".'),
            descending: z.boolean().describe('True for descending order.'),
          })
        )
        .optional()
        .describe('Sort order. Example: [{"property":"start_time","descending":true}].'),
      keys: z
        .array(z.string())
        .optional()
        .describe(
          'Custom key names to add to each record, e.g. ["device.os", "browser"]. Built-in columns (name, status, start_time, duration, test_id, uuid, …) are always returned — do not list them. Omit to get only the built-in columns (no custom keys at all). Asking for "user" also fills it from "digitalai:user" on web reports.'
        ),
      returnTotalCount: z
        .boolean()
        .optional()
        .describe('If true, the response includes the total matching count. Works with startDate/endDate too: the scan continues past limit to count all in-range records (up to 5000 scanned; totalCapped: true indicates the count was truncated). For a count-only query, combine with limit: 1.'),
      startDate: z
        .string()
        .optional()
        .describe('ISO 8601 start of date range, e.g. "2025-01-01T00:00:00Z". Applied client-side — do NOT also add start_time to filter[].'),
      endDate: z
        .string()
        .optional()
        .describe('ISO 8601 end of date range, e.g. "2025-06-01T00:00:00Z". Defaults to now when startDate is provided.'),
      projectId: z.number().int().optional().describe(REPORTER_PROJECT_ID_DESC),
      projectName: z.string().optional().describe('Scope results to this project name.'),
      outputFormat: outputFormatParam,
    },
    async ({ fields, limit, page, searchValue, filter, sort, keys, returnTotalCount, startDate, endDate, projectId, projectName, outputFormat }) => {
      try {
        const targetLimit = limit ?? 50;
        const compact = fields === 'compact';
        const twin = webUserTwin(filter);
        const requestKeys = withWebUserKey(keys);
        const shape = (rs: TestReport[]) => {
          const filled = fillWebUser(rs, keys);
          return compact ? filled.map((r) => compactReport(r, keys)) : filled;
        };
        const render = (rs: TestReport[]) => {
          const filled = fillWebUser(rs, keys);
          return compact ? formatCompactReportList(filled, keys) : formatTestReportList(filled);
        };

        if (startDate || endDate) {
          // Client-side date filtering — server-side start_time filter is CSRF-blocked for all key types.
          // Fetch sorted descending so we can stop as soon as we pass the startDate cutoff. If the platform
          // refuses sort for this credential the response says so (sortApplied=false) and we scan every page.
          const startTs = startDate ? new Date(startDate).getTime() : 0;
          const endTs = endDate ? new Date(endDate).getTime() : Date.now();
          // When a total is requested, keep scanning past targetLimit to count
          // all in-range records (up to maxScan) instead of stopping at the limit.
          const wantTotal = returnTotalCount ?? false;
          const maxScan = 5000;
          const scanRange = async (scanFilter: typeof filter) => {
            const matched: TestReport[] = [];
            let matchedCount = 0;
            let scanned = 0;
            let countCapped = false;
            let fetchPage = 1;
            let done = false;

            while (!done && (wantTotal || matched.length < targetLimit)) {
              const wantSort = serverSortAvailable();
              const batch = await listTests(
                {
                  limit: 500,
                  page: fetchPage,
                  returnTotalCount: false,
                  ...(wantSort && { sort: [{ property: 'start_time', descending: true }] }),
                  ...(searchValue && { searchValue }),
                  ...(scanFilter && { filter: scanFilter }),
                  ...(requestKeys && { keys: requestKeys }),
                },
                projectId,
                projectName
              );
              if (wantSort && batch.sortApplied === false && fetchPage > 1) {
                // Sort refused partway through a sorted scan: unsorted page N is not a continuation of sorted
                // pages 1..N-1. Restart from page 1 — the refusal is remembered, so the rescan is unsorted throughout.
                matched.length = 0;
                matchedCount = 0;
                scanned = 0;
                fetchPage = 1;
                continue;
              }
              const records = batch.data ?? [];
              if (records.length === 0) break;
              scanned += records.length;
              const isSortedFetch = batch.sortApplied === true;

              for (const r of records) {
                const t = new Date(r.start_time).getTime();
                // Early-exit is only valid when results are sorted descending by start_time.
                if (isSortedFetch && t < startTs) { done = true; break; }
                if (t >= startTs && t <= endTs) {
                  matchedCount++;
                  if (matched.length < targetLimit) matched.push(r);
                  if (!wantTotal && matched.length >= targetLimit) { done = true; break; }
                }
              }
              if (records.length < 500) done = true;
              if (!done && scanned >= maxScan) { countCapped = true; done = true; }
              fetchPage++;
            }
            return { matched, matchedCount, countCapped };
          };
          // A user filter also runs as digitalai:user (web reports) and the two scans are merged newest first.
          const [own, web] = await Promise.all([scanRange(filter), twin ? scanRange(twin) : undefined]);
          const matched = web ? mergeReportLists(own.matched, web.matched).slice(0, targetLimit) : own.matched;
          const matchedCount = own.matchedCount + (web?.matchedCount ?? 0);
          const countCapped = own.countCapped || !!web?.countCapped;
          const userNote = web ? mergedUserNote(own.matchedCount, web.matchedCount, wantTotal) : webUserNote(filter);

          const rangeLabel = `${startDate ?? 'beginning'} → ${endDate ?? 'now'}`;
          const totalLine = wantTotal
            ? `Total matching: ${matchedCount}${countCapped ? `+ (count capped after scanning ${maxScan} records — narrow the range for an exact total)` : ''}\n`
            : '';
          const header = matched.length === 0
            ? `${totalLine}No tests found in range ${rangeLabel} (date filter applied client-side).`
            : `${totalLine}${matched.length} test(s) shown for range ${rangeLabel} (date filter applied client-side):\n`;
          const rangeNote = [projectIdFilterNote(filter, matched.length), userNote].filter(Boolean).join('\n\n') || undefined;
          return respond(
            outputFormat,
            {
              reports: shape(matched),
              ...(wantTotal && { total: matchedCount, totalCapped: countCapped }),
              ...(rangeNote && { note: rangeNote }),
            },
            header + (matched.length > 0 ? '\n' + render(matched) : '') + (rangeNote ? `\n\n${rangeNote}` : '')
          );
        }

        const request = {
          limit: targetLimit,
          page: page ?? 1,
          returnTotalCount: returnTotalCount ?? true,
          ...(searchValue && { searchValue }),
          ...(filter && { filter }),
          ...(sort && { sort }),
          ...(requestKeys && { keys: requestKeys }),
        };
        // No sort given → newest first. Unsorted, the platform answered in storage order: "limit: 5" on a project that ran
        // ~10k tests that day returned records from July and August (UAT 2026-11-14). Measured live the same day: the
        // sorted request worked with every filter shape tried (plain, has_attachment, searchValue (+keys), custom key,
        // status) and cost 1–1.5 s more. If the sorted request fails for any reason, the caller's unsorted request runs.
        const defaultSort = !sort && serverSortAvailable();
        type ListResult = Awaited<ReturnType<typeof listTests>>;
        const fetchList = async (req: typeof request): Promise<ListResult> => {
          try {
            return await listTests(defaultSort ? { ...req, sort: [{ property: 'start_time', descending: true }] } : req, projectId, projectName);
          } catch (e) {
            if (!defaultSort) throw e;
            return { ...(await listTests(req, projectId, projectName)), sortApplied: false };
          }
        };
        // A user filter also runs as digitalai:user (web reports): both lists are fetched down to the requested page and
        // merged in sort order. Deeper than 500 records per side cannot be merged in one request each — then the note
        // gives the second query to run instead.
        const pageNo = page ?? 1;
        const mergeUsers = !!twin && pageNo * targetLimit <= 500;
        let result: ListResult;
        let userNote: string | undefined;
        if (mergeUsers) {
          const want = { ...request, limit: pageNo * targetLimit, page: 1 };
          const [own, web] = await Promise.all([fetchList(want), fetchList({ ...want, filter: twin })]);
          const data = mergeReportLists(own.data ?? [], web.data ?? [], sort).slice((pageNo - 1) * targetLimit, pageNo * targetLimit);
          result = {
            ...own,
            data,
            count: own.count != null && web.count != null ? own.count + web.count : undefined,
            sortApplied: own.sortApplied === false || web.sortApplied === false ? false : own.sortApplied,
          };
          userNote = mergedUserNote(own.count, web.count, own.count != null && web.count != null);
        } else {
          result = await fetchList(request);
          userNote = webUserNote(filter);
        }
        const reports = result.data ?? [];
        const countLine = result.count !== undefined ? `Total matching: ${result.count}\n\n` : '';
        // A requested sort the platform refused must never be presented as sorted output.
        const sortRefused = !!sort && result.sortApplied === false;
        const sortWarning = sortRefused
          ? 'The platform refused server-side sort for this credential — these results are in platform order, NOT the order requested. ' +
            'For newest-first results use find_latest_test_for_name / list_active_test_executions, or pass startDate/endDate (scanned and ordered client-side).'
          : undefined;
        const emptyNote = [projectIdFilterNote(filter, reports.length), userNote].filter(Boolean).join('\n\n') || undefined;
        return respond(
          outputFormat,
          { reports: shape(reports), total: result.count, ...(sortRefused && { sortApplied: false, warning: sortWarning }), ...(emptyNote && { note: emptyNote }) },
          (sortWarning ? `⚠️  ${sortWarning}\n\n` : '') + countLine + render(reports) + (emptyNote ? `\n\n${emptyNote}` : '')
        );
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── get_grouped_test_reports ──────────────────────────────────────────────

  server.tool(
    'get_grouped_test_reports',
    'Get test report counts grouped by field values. Returns one row per unique value combination. ' +
    'Use groupBy to specify which fields to group on — e.g. ["device.os"] returns one row per OS. ' +
    'Use pivotBy to add per-status columns (passedCount, failedCount, etc.) instead of separate rows. ' +
    'Useful for dashboards: pass/fail by OS, by test name, by environment, etc. ' +
    'Shared vs dedicated devices: groupBy ["device.pool.actual"] with pivotBy ["status"] (platform 26.7+; null = not recorded, e.g. browser tests or older runs). ' +
    'Note: null OS values represent browser/Selenium sessions. ' +
    'LETTER CASE is ignored by default: an "=" filter on text counts every stored spelling ("chrome" finds Chrome and chrome), and group values ' +
    'that differ only in case are one row (the platform always as Android / iOS, so at most 3 rows: Android, iOS, null). exactCase: true turns both off. ' +
    'TIME RANGE: days (the last N days) or startDate / endDate limit the counts to runs of that range, exactly; a filter on start_time is not possible. ' +
    'For a finished report of the same counts use create_test_breakdown_report.',
    {
      groupBy: z
        .array(z.string())
        .optional()
        .describe(
          'Fields to group results by, e.g. ["device.os"], ["status"], or ["device.os","status"] for multi-dimensional grouping. ' +
          'Each unique value combination becomes one row. Omit to get a single aggregate row for the entire dataset. ' +
          `Keys: ${REPORT_KEYS_HELP}. The plain word in brackets is accepted in place of the key.`
        ),
      pivotBy: z
        .array(z.enum(['success', 'status']))
        .optional()
        .describe(
          'Add per-status count columns to each group row: "status" adds passedCount/failedCount/etc., "success" adds true/false split.'
        ),
      filter: z
        .array(z.object({
          property: z.string(),
          operator: z.string(),
          value: z.union([z.string(), z.number(), z.boolean()]),
        }))
        .optional()
        .describe('Scope the aggregation to matching records. Same filter syntax as list_test_reports; property takes the keys listed under groupBy, e.g. ' +
          '[{"property": "test.framework", "operator": "=", "value": "Appium Server"}]. Here "=" on a text value ignores letter case. get_distinct_test_key_values lists the values a key holds.'),
      keysAsWritten: z.boolean().optional().describe('true: send every key exactly as written. For a custom column whose name is one of the plain words (a column named "category", "platform" or "device"), which is otherwise read as the built-in key. Default false.'),
      maxGroups: z.number().int().min(1).max(MAX_GROUPS).optional()
        .describe('Most group rows to return (default 500). When there are more, the groups with the most runs are returned and the answer says how many were left out; count and totalRecords still cover every group.'),
      exactCase: z.boolean().optional()
        .describe('true: match "=" filters and group values by the exact spelling the platform stores ("Chrome" and "chrome" stay apart). Default false: letter case is ignored.'),
      days: z.number().int().min(1).max(365).optional()
        .describe('Only runs of the last N days (whole days, today included). The server finds the first run of the range and counts from it, so the counts are exact. Not with startDate or allProjects.'),
      startDate: z.string().optional()
        .describe('Only runs started at or after this time, ISO 8601 ("2026-11-18" or "2026-11-18T00:00:00Z"). Not with days or allProjects.'),
      endDate: z.string().optional()
        .describe('Only runs started before this time, ISO 8601. Usually with startDate. Not with allProjects.'),
      returnTotalCount: z
        .boolean()
        .optional()
        .describe('If true, adds totalRecords — the number of test records across all groups (the response\x27s count is the number of groups).'),
      projectId: z.number().int().optional().describe(REPORTER_PROJECT_ID_DESC),
      projectName: z.string().optional().describe('Scope to this project name. Without projectName, projectId or allProjects the answer covers the access key\'s OWN project only (the answer\'s scope field says so).'),
      allProjects: z.boolean().optional().describe('Run the query for EVERY reporter project this key can see (Cloud Admin: the whole instance) and add a "project" column to each row; about 15 s for 85 projects. For all-time counts by project, user and status as a finished report, use create_test_inventory_report.'),
      outputFormat: outputFormatParam,
    },
    async ({ groupBy: writtenGroupBy, pivotBy, filter: writtenFilter, keysAsWritten, maxGroups, exactCase, days, startDate, endDate, returnTotalCount, projectId, projectName, allProjects, outputFormat }) => {
      try {
        // The plain words (platform, framework, model …) are read as the platform's keys, as the report tools read them.
        // keysAsWritten: a tenant's own column can carry one of those words as its name (addTestProperty("category", …));
        // read as the built-in key it could not be reached under any spelling.
        const keyOf = (k: string) => (keysAsWritten ? k.trim() : reportKey(k));
        const askedGroupBy = writtenGroupBy?.map(keyOf);
        const askedFilter = writtenFilter?.map((f) => ({ ...f, property: keyOf(f.property) }));
        const readAs = Object.fromEntries([...(writtenGroupBy ?? []), ...(writtenFilter ?? []).map((f) => f.property)].filter((k) => keyOf(k) !== k.trim()).map((k) => [k, keyOf(k)]));
        if (allProjects && (projectId !== undefined || projectName)) {
          return { content: [{ type: 'text', text: 'Error: allProjects covers every project; leave out projectId and projectName, or leave out allProjects.' }], isError: true };
        }
        // A time range. The reporter cannot filter on start_time, but test ids grow with time: the first run of the range
        // is found by its id and the counts are bounded by ids, so they are exact (see firstTestIdSince). An agent asked for
        // "the last 7 days" tried days, fromDate, startDate, since, lastDays … on this tool, eight refused calls (2026-11-25).
        let filter = askedFilter;
        let range: string | undefined;
        if (days !== undefined || startDate || endDate) {
          const fail = (text: string) => ({ content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true });
          if (allProjects) return fail('a time range needs one project (test ids are counted per project): leave out allProjects, or leave out days / startDate / endDate.');
          if (days !== undefined && startDate) return fail('give days or startDate, not both.');
          const now = Date.now();
          const from = days !== undefined ? dayStart(addDays(now, -(days - 1))) : startDate ? Date.parse(startDate) : undefined;
          const to = endDate ? Date.parse(endDate) : undefined;
          if (Number.isNaN(from) || Number.isNaN(to)) return fail('startDate and endDate take ISO 8601, for example "2026-11-18" or "2026-11-18T00:00:00Z".');
          if (from !== undefined && to !== undefined && to <= from) return fail('endDate must be after startDate.');
          const inProject = projectName ?? (projectId !== undefined ? await resolveReporterProjectName(projectId, undefined) : undefined);
          const [minId, maxId] = await Promise.all([
            from !== undefined ? firstTestIdSince(from, inProject) : Promise.resolve(undefined),
            to !== undefined ? firstTestIdSince(to, inProject) : Promise.resolve(undefined)]);
          const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z');
          range = `runs started ${from !== undefined ? `from ${iso(from)}` : ''}${from !== undefined && to !== undefined ? ' ' : ''}${to !== undefined ? `before ${iso(to)}` : ''}` +
            `${days !== undefined ? ` (the last ${days} day${days === 1 ? '' : 's'}, in the server's time zone)` : ''}`;
          if (from !== undefined && minId === null) {
            // No run started at or after the range's first moment.
            const empty = { scope: projectName ? `project ${projectName}` : projectId !== undefined ? `reporter project ${projectId}` : 'the access key\'s own project', range, count: 0, data: [], totalRecords: 0 };
            return respond(outputFormat, empty, `No test run in this range (${range}).`);
          }
          // A null upper id means no run started at or after endDate: nothing to cut off.
          filter = [...(askedFilter ?? []),
            ...(minId != null ? [{ property: 'test_id', operator: '>=', value: minId }] : []),
            ...(maxId != null ? [{ property: 'test_id', operator: '<', value: maxId }] : [])];
        }
        // Web (Selenium) reports keep the user in digitalai:user: a grouping by user asks for both keys and files each row
        // under whichever it has, so web reports are counted under their user and not in one null row.
        const bothUserKeys = !!askedGroupBy?.includes('user') && !askedGroupBy.includes('digitalai:user') && !webUserTwin(filter);
        const groupBy = bothUserKeys ? [...askedGroupBy!, 'digitalai:user'] : askedGroupBy;
        const request = {
          ...(groupBy && { groupBy }),
          ...(pivotBy && { pivotBy }),
          ...(filter && { filter }),
          returnTotalCount: returnTotalCount ?? true,
        };
        type Grouped = { count?: number | null; data?: Array<Record<string, unknown>> };
        // A user filter also runs as digitalai:user (web reports keep the user there) and the rows are summed per group.
        const twin = webUserTwin(filter);
        let across: { projects: string[]; failed: Array<{ project: string; error: string }> } | undefined;
        // The platform's "=" matches one spelling only (browserName = "chrome" 1,243 runs, = "Chrome" 809, live 2026-11-25).
        // By default the filter is sent as "contains" (which ignores case), the key is grouped as well, and only the groups
        // whose value equals the wanted one, case aside, are kept (see report-case.ts).
        const matchedSpellings: Record<string, string[]> = {};
        const run = async (req: typeof request): Promise<Grouped> => {
          const plan = exactCase ? null : loosePlan(req.groupBy, req.filter);
          const sent = plan ? { ...req, groupBy: plan.groupBy, filter: plan.filter } : req;
          let res: Grouped;
          if (!allProjects) res = await getGroupedTests(sent, projectId, projectName) as Grouped;
          else {
            const r = await getGroupedTestsAllProjects(sent);
            across = { projects: r.projects, failed: [...(across?.failed ?? []), ...r.failed] };
            res = { count: r.rows.length, data: r.rows };
          }
          if (!plan) return res;
          const kept = plan.apply(res.data ?? []);
          for (const [k, v] of Object.entries(kept.matched)) matchedSpellings[k] = [...new Set([...(matchedSpellings[k] ?? []), ...v])].sort();
          return { ...res, data: kept.rows };
        };
        // With the case ignored, the web query also groups by digitalai:user in a grouping by user, so each web row is
        // filed under the spelling the platform STORES and not under the one the caller wrote (which then showed up as
        // a merged "spelling" no run has). The loosened filter groups that key anyway, so the request is the same.
        const groupsUser = !!groupBy?.includes('user');
        const keepWebUser = groupsUser && !exactCase && !groupBy!.includes('digitalai:user');
        const [own, web] = await Promise.all([run(request),
          twin ? run({ ...request, filter: twin, ...(keepWebUser && { groupBy: [...groupBy!, 'digitalai:user'] }) }) : undefined]);
        let result: Grouped = own;
        let userNote: string | undefined;
        if (web) {
          const userValue = filter?.find((f) => f.property === 'user')?.value;
          // Web rows have no "user" value; a grouping by user files them under the filtered user, where they belong.
          const webRows = (web.data ?? []).map((r) => {
            if (!groupsUser) return r;
            if (!keepWebUser) return { ...r, user: userValue };
            const { ['digitalai:user']: webUser, ...rest } = r;
            return { ...rest, user: webUser ?? userValue };
          });
          const records = (rows: Array<Record<string, unknown>> | undefined) =>
            (rows ?? []).reduce((n, r) => n + (typeof r['_count_'] === 'number' ? (r['_count_'] as number) : 0), 0);
          userNote = mergedUserNote(records(own.data), records(webRows), true);
          result = { ...own, data: [...(own.data ?? []), ...webRows] };
        } else {
          userNote = webUserNote(filter);
          if (bothUserKeys && Array.isArray(result?.data)) {
            let webRows = 0;
            result = { ...result, data: result.data.map((row) => {
              const { ['digitalai:user']: webUser, ...rest } = row;
              if (rest['user'] == null && webUser != null) { webRows++; return { ...rest, user: webUser }; }
              return rest;
            }) };
            if (webRows) userNote = [userNote, 'Web (Selenium) reports are counted under their user: they keep it in "digitalai:user", which was grouped as well and merged into the user column.'].filter(Boolean).join(' ');
          }
        }

        // One row per group. Values that differ only in letter case are one group (ANDROID / Android, Chrome / chrome),
        // shown in the spelling most runs have; exactCase keeps them apart. The same merge sums the mobile and web rows of
        // a user filter and the spellings a loosened filter matched. Keyed on EVERY group-by field: keying on the OS alone
        // once collapsed ["device.os","status"] into one row per OS.
        const fields = [...(allProjects ? ['project'] : []), ...(askedGroupBy ?? [])];
        const loosened = Object.keys(matchedSpellings).length > 0;
        let spellingsMerged: Record<string, string[][]> = {};
        if ((!exactCase || web || bothUserKeys) && Array.isArray(result?.data)) {
          // A project is named, not spelled by a test client: two projects whose names differ only in case stay two rows.
          const m = mergeGroupRows(result.data, fields, !exactCase, allProjects ? ['project'] : []);
          spellingsMerged = m.merged;
          // A question with no grouping is answered with one row, also when nothing matched.
          const rows = !m.rows.length && !fields.length && loosened ? [{ _count_: 0 }] : m.rows;
          // `count` is the number of groups: after merging it must describe the rows actually returned (UAT 2026-10-09:
          // count 5 with 3 rows).
          result = { ...result, data: rows, ...(result.count != null ? { count: rows.length } : {}) };
        }
        // The platform's `count` is the number of GROUPS; it returns no record total even when asked. Compute it from
        // the per-group _count_ so returnTotalCount does what it says (UAT 2026-10-10 run 3).
        const runsIn = (rows: Array<Record<string, unknown>>) => rows.reduce((n, row) => n + (typeof row['_count_'] === 'number' ? (row['_count_'] as number) : 0), 0);
        const everyGroup = Array.isArray(result?.data) ? result.data : null;
        const totalRecords = everyGroup ? runsIn(everyGroup) : 0;
        // A grouping by test name returns one group per name, and names carry run ids: 60,208 rows / 4.5 MB for 30 days,
        // and for all dates the answer could not even be formatted (live 2026-11-25). Return the largest groups and say
        // how many were left out; the totals are still those of every group.
        const cap = maxGroups ?? DEFAULT_MAX_GROUPS;
        let cutNote: string | undefined;
        if (everyGroup && everyGroup.length > cap) {
          const shown = [...everyGroup].sort((a, b) => runsIn([b]) - runsIn([a])).slice(0, cap);
          const n = (x: number) => x.toLocaleString('en-US');
          cutNote = `${n(everyGroup.length)} groups: ${cap === 1 ? 'the one with the most runs is returned' : `the ${n(cap)} with the most runs are returned`} (${n(runsIn(shown))} of ${n(totalRecords)} runs). ` +
            `To see the rest, narrow the question (days, a filter)${cap < MAX_GROUPS ? ` or raise maxGroups (up to ${n(MAX_GROUPS)})` : ''}.` +
            (askedGroupBy?.includes('name') ? ' Test names often differ only in run ids or dates: create_test_breakdown_report with groupBy ["test"] counts those as one test.' : '');
          result = { ...result, data: shown };
          // Spellings merged in a group that was left out say nothing about the rows returned, and there can be very many.
          const returned = (f: string) => new Set(shown.map((r) => r[f]).filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase()));
          spellingsMerged = Object.fromEntries(Object.entries(spellingsMerged)
            .map(([f, lists]) => { const values = returned(f); return [f, lists.filter((list) => values.has(list[0].toLowerCase()))] as const; })
            .filter(([, lists]) => lists.length));
        }
        // Say what the case-blind matching did, only where it changed the answer: a filter that matched another spelling
        // than the one written (or several), and group values that were merged.
        const writtenValue = (k: string) => String((filter ?? []).find((f) => f.property === (k === 'digitalai:user' && !filter?.some((x) => x.property === k) ? 'user' : k) && (f.operator ?? '=') === '=')?.value ?? '');
        const filterMatched = Object.fromEntries(Object.entries(matchedSpellings).filter(([k, v]) => v.length > 1 || (v.length === 1 && v[0] !== writtenValue(k))));
        const caseInfo = {
          ...(Object.keys(filterMatched).length ? { filterMatched } : {}),
          ...(Object.keys(spellingsMerged).length ? { spellingsMerged } : {}),
        };
        const caseNote = Object.keys(caseInfo).length ? 'Letter case was ignored (exactCase: true counts each stored spelling on its own).' : undefined;

        let payload: object = result;
        if (returnTotalCount === true && everyGroup) payload = { ...result, totalRecords };
        if (cutNote) payload = { ...payload, groupsReturned: cap, groupsCut: cutNote };
        // A key no run has a value for comes back as one group with nothing in it: say so, and which keys exist.
        // Judged from EVERY group, not the rows returned: the largest groups of a custom column are often the runs
        // without it, and cut to those the answer said no run has a value while the smaller groups did.
        const rowsOut = everyGroup ?? [];
        const emptyKeys = (askedGroupBy ?? []).filter((k) => !KNOWN_REPORT_KEYS.includes(k) && rowsOut.length > 0 && rowsOut.every((r) => r[k] == null));
        const keyNote = emptyKeys.length ? `No run has a value for ${emptyKeys.map((k) => `"${k}"`).join(', ')}. Keys the platform groups by: ${REPORT_KEYS_HELP}.` : undefined;
        if (keyNote) userNote = [userNote, keyNote].filter(Boolean).join(' ');
        if (userNote) payload = { ...payload, note: userNote };
        if (caseNote) payload = { ...payload, ...caseInfo, caseNote };
        // Named with its way out: a tenant's own column of that name is reached with keysAsWritten.
        if (Object.keys(readAs).length) payload = { keysReadAs: readAs, keysReadAsNote: 'Plain words were read as the built-in keys. For a custom column with one of these names, add keysAsWritten: true.', ...payload };
        // Say which projects the numbers cover: a query with no project answers for the key's own project only, and an
        // agent took that for the instance total (829,454 of 4.0 million, 2026-11-24).
        const scope = across ? `all ${across.projects.length} reporter projects this access key can see`
          : projectName ? `project ${projectName}` : projectId !== undefined ? `reporter project ${projectId}`
            : 'the access key\'s own project ONLY, not the whole instance (allProjects: true covers every project; create_test_inventory_report builds the all-time report)';
        payload = { scope, ...(range ? { range } : {}), ...(across ? { projectsQueried: across.projects.length, ...(across.failed.length ? { projectsFailed: across.failed } : {}) } : {}), ...payload };

        return respond(outputFormat, payload, `Scope: ${scope}.${range ? `\nRange: ${range}.` : ''}\n\n` + formatGroupedTestReports(result) + (userNote ? `\n\n${userNote}` : '') + (caseNote ? `\n\n${caseNote}${Object.entries(filterMatched).map(([k, v]) => ` ${k} matched ${v.map((y) => `"${y}"`).join(', ')}.`).join('')}` : '') + (cutNote ? `\n\n${cutNote}` : '') +
          (across?.failed.length ? `\n\n⚠️ ${across.failed.length} project(s) did not answer and are not counted: ${across.failed.map((f) => f.project).join(', ')}.` : ''));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── get_distinct_test_key_values ──────────────────────────────────────────

  server.tool(
    'get_distinct_test_key_values',
    'Return every distinct value recorded for one or more test report keys. Useful for discovering what devices, browsers, environments, or other dimensions appear in test history. NOTE: this tool requires browser session authentication on some platforms — if you receive a CSRF/401 error, the endpoint is not accessible via API key on your deployment. Use get_grouped_test_reports with the same keys as groupBy as an alternative.',
    {
      keys: z
        .array(z.string())
        .min(1)
        .optional()
        .describe(`Key names. Omit for the main ones (platform, framework, browser, device pool). Keys: ${REPORT_KEYS_HELP}. The plain word in brackets is accepted in place of the key.`),
      keysAsWritten: z.boolean().optional().describe('true: send every key exactly as written. For a custom column whose name is one of the plain words (a column named "category", "platform" or "device"), which is otherwise read as the built-in key. Default false.'),
      projectId: z.number().int().optional().describe(REPORTER_PROJECT_ID_DESC),
      projectName: z.string().optional().describe('Scope to this project name.'),
      outputFormat: outputFormatParam,
    },
    async ({ keys: writtenKeys, keysAsWritten, projectId, projectName, outputFormat }) => {
      try {
        // No keys: the main ones, so "what can I filter by?" is one call and not a refusal.
        const keys = [...new Set((writtenKeys ?? ['device.os', 'test.framework', 'browserName', 'device.pool.actual']).map((k) => (keysAsWritten ? k.trim() : reportKey(k))))];
        const raw = await getDistinctKeyValues(keys, projectId, projectName);
        // Values come back in every spelling a client sent (ANDROID / Android, Chrome / chrome). Fold the case variants
        // the same way get_grouped_test_reports does, so the two tools agree (UAT 2026-10-10) and a value is listed once:
        // filters match it in any case. The platform's own spellings are kept under rawValues.
        const result: Record<string, unknown> = { ...raw };
        const rawValuesOf: Record<string, unknown[]> = {};
        for (const key of Object.keys(raw)) {
          const stored = (raw as Record<string, unknown>)[key];
          if (!Array.isArray(stored)) continue;
          const first = new Map<string, unknown>();
          for (const v of stored) {
            const shown = key === 'device.os' && v != null ? normaliseDeviceOs(String(v)) : v;
            const id = typeof shown === 'string' ? shown.toLowerCase() : JSON.stringify(shown ?? null);
            if (!first.has(id)) first.set(id, shown);
          }
          if (first.size !== stored.length) { result[key] = [...first.values()]; rawValuesOf[key] = stored; }
        }
        if (Object.keys(rawValuesOf).length) result.rawValues = rawValuesOf;
        const lines: string[] = [];
        for (const key of Object.keys(raw)) {
          const rawValues = result[key];
          lines.push(`${key}:`);
          const values = Array.isArray(rawValues)
            ? rawValues
            : rawValues != null
            ? [String(rawValues)]
            : [];
          if (values.length === 0) {
            lines.push('  (no values recorded)');
          } else {
            for (const v of values) lines.push(`  • ${v}`);
          }
        }
        const none = keys.filter((k) => { const v = (raw as Record<string, unknown>)[k]; return v == null || (Array.isArray(v) && v.filter((x) => x != null && x !== '').length === 0); });
        const note = none.length ? `No value is recorded for ${none.map((k) => `"${k}"`).join(', ')}. Keys the platform keeps: ${REPORT_KEYS_HELP}.` : undefined;
        if (note) { result.note = note; lines.push('', note); }
        return respond(outputFormat, result, lines.join('\n') || 'No values found.');
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.startsWith('PLATFORM_LIMITATION:')) {
          return {
            content: [{ type: 'text', text: `⚠️ Platform limitation: This endpoint requires browser session authentication and is not available via API key on this deployment.\n\nAlternative: use get_grouped_test_reports with the same keys as groupBy to enumerate their value combinations.` }],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ─── delete_test_reports ───────────────────────────────────────────────────

  server.tool(
    'delete_test_reports',
    'Permanently delete one or more test execution records by their numeric IDs. This cannot be undone. Requires confirmDeletion: true. Cloud Admin can always delete; a project-level key only when its project\x27s allowUsersDeleteTests setting is on (otherwise the tool refuses up front and explains how to get it enabled). PREFERRED cleanup method whenever the IDs are already known (e.g. from a filtered list_test_reports call) — more precise than name or date matching.',
    {
      ids: z
        .array(z.number().int())
        .min(1)
        .describe('Array of numeric test IDs to delete, e.g. [5, 67, 100].'),
      confirmDeletion: z
        .boolean()
        .optional()
        .describe('Must be true to confirm the permanent deletion.'),
      projectId: z.number().int().optional().describe(REPORTER_PROJECT_ID_DESC),
      projectName: z.string().optional().describe('Exact project name (from list_projects) to scope the delete to a specific reporter instance.'),
    },
    async ({ ids, confirmDeletion, projectId, projectName }) => {
      // Resolve a reporter projectId to its name FIRST: the gate (and the delete) must look at the project the
      // records are in, not the default scope.
      try {
        projectName = await resolveReporterProjectName(projectId, projectName);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
      const denied = await checkDeleteAllowed(projectName);
      if (denied) {
        return { content: [{ type: 'text', text: denied }], isError: true };
      }

      if (confirmDeletion !== true) {
        if (ids.length <= 50) {
          // Fetch details for all IDs so the guard shows a human-readable preview.
          // If any ID cannot be resolved, block the deletion entirely rather than
          // silently deleting records the caller cannot verify.
          // GET /tests/{id} always answers from the default reporter scope, so with a project the preview reads the
          // records through the project-scoped list — the same scope the delete runs in. Otherwise the preview could
          // show the Default project's report N while the confirmed delete removes the other project's report N.
          const results = await Promise.allSettled(ids.map(id => projectName ? getScopedTest(id, projectName) : getTestById(id)));
          const failedIndices = results.reduce<number[]>(
            (acc, r, i) => (r.status === 'rejected' ? [...acc, i] : acc),
            []
          );

          if (failedIndices.length > 0) {
            const failedIds = failedIndices.map(i => ids[i]).join(', ');
            return {
              content: [{
                type: 'text',
                text:
                  `⛔ Cannot preview deletion: ${failedIndices.length} of the requested ID(s) could not be resolved ` +
                  `in ${projectName ? `project "${projectName}"` : 'the current reporter scope'}: [${failedIds}].\n\n` +
                  `Verify these IDs exist and are accessible with the active credentials. ` +
                  `If they belong to a different project, switch to that project's profile ` +
                  `with switch_environment() and retry.\n\nNo changes were made.`,
              }],
              isError: true,
            };
          }

          const rows = results.map((r) => {
            const t = (r as PromiseFulfilledResult<TestReport>).value;
            const date = t.start_time ? t.start_time.substring(0, 19).replace('T', ' ') : '—';
            return `  ${String(t.test_id).padEnd(10)} ${(t.status ?? '').padEnd(12)} ${date.padEnd(20)} ${t.name ?? ''}`;
          });
          const header = `  ${'ID'.padEnd(10)} ${'Status'.padEnd(12)} ${'Start (UTC)'.padEnd(20)} Name`;
          const sep = `  ${'-'.repeat(9)} ${'-'.repeat(11)} ${'-'.repeat(19)} ${'-'.repeat(30)}`;
          const table = [header, sep, ...rows].join('\n');

          const guard = checkDestructiveGuard(confirmDeletion, `Delete ${ids.length} test report(s)${deleteScopeLabel(projectName)}`);
          return { content: [{ type: 'text', text: `${guard}\n\nRecords that would be deleted:\n${table}` }] };
        }

        // >50 IDs — skip detail fetch, return guard with ID list
        const guard = checkDestructiveGuard(confirmDeletion, `Delete ${ids.length} test report(s)${deleteScopeLabel(projectName)}: [${ids.join(', ')}]`);
        return { content: [{ type: 'text', text: guard! }] };
      }

      try {
        await deleteTests(ids, projectId, projectName);
        return {
          content: [{ type: 'text', text: `✅ Successfully deleted ${ids.length} test report(s)${deleteScopeLabel(projectName)}.` }],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── delete_test_reports_by_name ──────────────────────────────────────────

  server.tool(
    'delete_test_reports_by_name',
    'Find and permanently delete test execution records matching a name. Accepts exact match (name) or substring match (nameContains). Searches across all pages. Show a preview first via confirmDeletion: false, then re-call with confirmDeletion: true to execute. If you already have the numeric IDs (e.g. from a filtered list_test_reports call), use delete_test_reports instead — no name-matching ambiguity. Cloud Admin can always delete; a project-level key only when its project\x27s allowUsersDeleteTests setting is on (otherwise the tool refuses up front and explains how to get it enabled). IMPORTANT: always pass projectName (exact project name from list_projects) when using Cloud Admin access — without it the search spans the default reporter scope and tests from separate project reporter instances will not appear. A reporter projectId is resolved to its project name.',
    {
      name: z
        .string()
        .optional()
        .describe('Exact test name to match. Use this or nameContains, not both.'),
      nameContains: z
        .string()
        .optional()
        .describe('Case-insensitive substring to match against test names. Use this or name, not both.'),
      confirmDeletion: z
        .boolean()
        .optional()
        .describe('Set true to execute the deletion. Omit or false to preview matching records without deleting.'),
      maxPreviewResults: z
        .number()
        .int()
        .optional()
        .describe('Maximum records to show in preview (confirmDeletion: false). Defaults to 50. The deletion itself (confirmDeletion: true) always processes all matching records regardless of this limit.'),
      projectId: z.number().int().optional().describe(REPORTER_PROJECT_ID_DESC),
      projectName: z.string().optional().describe('Exact project name (from list_projects) to scope the search. Required when the target project has its own reporter instance separate from the default scope.'),
    },
    async ({ name, nameContains, confirmDeletion, maxPreviewResults, projectId, projectName }) => {
      // Resolve a reporter projectId to its name FIRST: the gate (and the delete) must look at the project the
      // records are in, not the default scope.
      try {
        projectName = await resolveReporterProjectName(projectId, projectName);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
      const denied = await checkDeleteAllowed(projectName);
      if (denied) {
        return { content: [{ type: 'text', text: denied }], isError: true };
      }
      try {
        if (!name && !nameContains) {
          return { content: [{ type: 'text', text: 'Error: provide either name (exact) or nameContains (substring).' }], isError: true };
        }
        if (name && nameContains) {
          return { content: [{ type: 'text', text: 'Error: provide either name or nameContains, not both.' }], isError: true };
        }

        const filter = name
          ? [{ property: 'name', operator: '=' as const, value: name }]
          : [{ property: 'name', operator: 'contains' as const, value: nameContains! }];

        // Preview: newest matches first with the exact total (debug-mode intake 2026-10-19 — the old preview listed scan
        // order and said "50+", so the user could not see how many records confirmDeletion would remove).
        const isPreview = !confirmDeletion;
        const previewCap = maxPreviewResults ?? 50;
        if (isPreview) {
          const newest = await listTestsSortedDesc({ limit: previewCap, page: 1, returnTotalCount: true, filter }, projectId, projectName);
          const rows = newest.data ?? [];
          if (rows.length === 0) {
            const criterion = name ? `name = "${name}"` : `name contains "${nameContains}"`;
            return { content: [{ type: 'text', text: `No test reports found matching ${criterion}.` }] };
          }
          const total = typeof newest.count === 'number' && newest.count >= rows.length ? newest.count : rows.length;
          const guard = checkDestructiveGuard(false, `Delete ${total} test report(s) matching "${name ?? nameContains}"${deleteScopeLabel(projectName)}`)!;
          const lines = rows.map((r) => `  ${r.test_id}: ${r.name} (${r.start_time?.slice(0, 10) ?? '?'})`);
          const more = total > rows.length
            ? `\n\n⚠️ Showing the newest ${rows.length} of ${total} matches. confirmDeletion: true deletes all ${total}; narrow nameContains to delete fewer.`
            : '';
          return {
            content: [{ type: 'text', text: `${guard}\n\nMatching records: ${total} in total, newest first:\n${lines.join('\n')}${more}` }],
          };
        }

        const allIds: number[] = [];
        const previewNames: string[] = [];
        let truncated = false;
        let page = 1;

        outer: while (true) {
          const batch = await listTests({ limit: 500, page, returnTotalCount: false, filter }, projectId, projectName);
          const records = batch.data ?? [];
          for (const r of records) {
            allIds.push(r.test_id);
            previewNames.push(`  ${r.test_id}: ${r.name} (${r.start_time?.slice(0, 10) ?? '?'})`);
            if (isPreview && allIds.length >= previewCap) {
              truncated = true;
              break outer;
            }
          }
          if (records.length < 500) break;
          page++;
        }

        if (allIds.length === 0) {
          const criterion = name ? `name = "${name}"` : `name contains "${nameContains}"`;
          return { content: [{ type: 'text', text: `No test reports found matching ${criterion}.` }] };
        }

        const countDesc = truncated ? `${previewCap}+ (preview capped at ${previewCap})` : `${allIds.length}`;
        const guard = checkDestructiveGuard(confirmDeletion, `Delete ${countDesc} test report(s) matching "${name ?? nameContains}"${deleteScopeLabel(projectName)}`);
        if (guard) {
          const truncationNote = truncated
            ? `\n\n⚠️ Showing first ${previewCap} of ${previewCap}+ matches. Re-run with confirmDeletion: true to delete all matches, or use a more specific nameContains value to narrow the search.`
            : '';
          return {
            content: [{
              type: 'text',
              text: `${guard}\n\nMatching records (${truncated ? `first ${previewCap} shown` : allIds.length}):\n${previewNames.join('\n')}${truncationNote}`,
            }],
          };
        }

        await deleteTests(allIds, projectId, projectName);
        return {
          content: [{ type: 'text', text: `✅ Deleted ${allIds.length} test report(s) matching "${name ?? nameContains}"${deleteScopeLabel(projectName)}.` }],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── download_test_attachments ─────────────────────────────────────────────

  server.tool(
    'download_test_attachments',
    'Download all attachments for a test execution as a ZIP file.' + serverFsDownloadNotice() +
    ' Use get_test_log instead to retrieve log content directly without a file download.',
    {
      uuid: z.string().describe('The test execution UUID.'),
      localPath: z.string().describe(serverFsOutputParam()),
    },
    async ({ uuid, localPath }) => {
      const pathErr = validateOutputPath(localPath);
      if (pathErr) return { content: [{ type: 'text', text: `Error: ${pathErr}` }], isError: true };
      try {
        await downloadTestAttachments(uuid, localPath);
        return {
          content: [{ type: 'text', text: `✅ Attachments downloaded to: ${localPath}` }],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── download_test_video ───────────────────────────────────────────────────

  server.tool(
    'download_test_video',
    'Download only the session video (.mp4) of a test execution — no ZIP, no logs — or just one byte range of it. ' +
    'infoOnly: true returns the size without downloading. Byte ranges let you fetch a large recording in pieces, resume ' +
    'a cut-off download, or grab the start/end of a long session. Use download_test_attachments when you also need the logs.' +
    serverFsDownloadNotice(),
    {
      report: z.string().describe('Report UUID (preferred — numeric ids collide across projects), numeric test id, or the report URL (e.g. .../reporter/video-report/<uuid>).'),
      localPath: z.string().optional().describe('Where to write the .mp4 (required unless infoOnly). ' + serverFsOutputParam()),
      infoOnly: z.boolean().optional().describe('Return the video size and type without downloading it.'),
      startByte: z.number().int().min(0).optional().describe('First byte of a partial download (0-based). With endByte for a fixed range; alone for "from here to the end" (e.g. resuming).'),
      endByte: z.number().int().min(0).optional().describe('Last byte of a partial download, inclusive. Needs startByte.'),
      lastBytes: z.number().int().min(1).optional().describe('Download only the final N bytes. Do not combine with startByte/endByte.'),
      outputFormat: outputFormatParam,
    },
    async ({ report, localPath, infoOnly, startByte, endByte, lastBytes, outputFormat }) => {
      const ref = parseReportRef(report);
      if (!ref) return { content: [{ type: 'text', text: `Error: "${report}" is not a report UUID, numeric test id or report URL.` }], isError: true };
      const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true });
      if (lastBytes != null && (startByte != null || endByte != null)) return fail('use either lastBytes or startByte/endByte, not both.');
      if (endByte != null && startByte == null) return fail('endByte needs startByte.');
      if (startByte != null && endByte != null && endByte < startByte) return fail('endByte must not be before startByte.');
      const range =
        lastBytes != null ? `bytes=-${lastBytes}` : startByte != null ? `bytes=${startByte}-${endByte ?? ''}` : undefined;
      const idNote = ref.kind === 'testId' ? ' Numeric ids are only unique per project — prefer the UUID.' : '';
      try {
        if (infoOnly) {
          const info = await getTestVideoInfo(ref);
          const mb = info.totalBytes != null ? `${(info.totalBytes / (1024 * 1024)).toFixed(1)} MB` : 'unknown size';
          return respond(outputFormat, { ...info, rangeRequests: true }, `🎬 Video: ${mb} (${info.totalBytes ?? '?'} bytes, ${info.contentType ?? 'unknown type'}). Byte ranges are supported.${idNote}`);
        }
        if (!localPath) return fail('localPath is required unless infoOnly is true.');
        const pathErr = validateOutputPath(localPath);
        if (pathErr) return fail(pathErr);
        const r = await downloadTestVideo(ref, localPath, range);
        const what = r.partial ? `bytes ${r.contentRange?.replace(/^bytes\s*/, '') ?? range}` : 'full video';
        return respond(
          outputFormat,
          { ...r, localPath },
          `✅ ${what} (${r.bytesWritten} bytes${r.totalBytes != null ? ` of ${r.totalBytes}` : ''}) written to: ${localPath}` +
            (r.partial ? '\nA partial file is a fragment, not a playable video on its own unless it starts at byte 0 and the player tolerates truncation.' : '') +
            idNote
        );
      } catch (e) {
        const msg = (e as Error).message;
        if (/\[416\]/.test(msg)) return fail(`the requested range is outside the video. Call with infoOnly: true to get its size. (${msg})`);
        return fail(msg);
      }
    }
  );

  // ─── get_test_attachments_download_command ─────────────────────────────────

  server.tool(
    'get_test_attachments_download_command',
    'Generates a ready-to-run curl or PowerShell command for downloading a test execution\'s full attachment ZIP (session video .mp4, Appium/device logs) directly to the user\'s local machine. ' +
    commandGeneratorNotice('download_test_attachments', 'download') + ' ' +
    'For text logs only, get_test_log is simpler (returns log text inline, no command). This is the path for the BINARY artifacts (video).\n\n' +
    'WARNING: The generated command embeds the active access key in plaintext. Instruct the user to run it immediately and not save or share the output.',
    {
      uuid: z.string().describe('Test execution UUID (uuid field from get_test_report or list_test_reports).'),
      localPath: z.string().optional().describe('Path on the user\'s local machine to save the file. Default: "test-attachments.zip" (or "test-video.mp4" for artifact "video") in the current directory.'),
      artifact: z
        .enum(['zip', 'video'])
        .optional()
        .default('zip')
        .describe('"zip" (default): the full attachment ZIP (video + logs). "video": only the session .mp4 — smaller, no unzip.'),
      localPlatform: z.enum(['windows', 'macos', 'linux']).describe('Platform of the machine that will run the command. ' + localPlatformParamNotice()),
      outputFormat: outputFormatParam,
    },
    async ({ uuid, localPath, artifact, localPlatform, outputFormat }) => {
      const video = artifact === 'video';
      const result = buildDownloadCommand({
        path: `/reporter/api/reports/${uuid}/${video ? 'video' : 'attachments'}`,
        localPath: localPath ?? (video ? 'test-video.mp4' : 'test-attachments.zip'),
        localPlatform,
        notes: [video ? 'The downloaded file is the session video (.mp4).' : 'The downloaded file is a ZIP — unzip it to access the .mp4 video and the appium/device/ws logs.'],
      });
      return respond(outputFormat, commandPayload(result), result.humanText);
    }
  );

  // ─── get_test_log ──────────────────────────────────────────────────────────

  server.tool(
    'get_test_log',
    'Retrieve log content from a test execution directly as text — no file download required. ' +
    'Fetches the attachment ZIP and extracts the requested log in memory, returning the tail. ' +
    'Use this to diagnose test failures when get_test_report shows cause/errorDetail but you need the full Appium trace. ' +
    'Appium log lines are long (a few hundred lines can be 80k+ characters): try `contains` first (e.g. the failing ' +
    'locator, "Exception", "error") — it returns only matching lines with context. Output is capped at maxChars, keeping the end. ' +
    'Requires the test execution UUID (uuid field from get_test_report or list_test_reports).',
    {
      uuid: z.string().describe('Test execution UUID (uuid field from get_test_report or list_test_reports).'),
      logType: z
        .enum(['appium', 'device', 'ws'])
        .optional()
        .default('appium')
        .describe("Which log file to extract: 'appium' (default) — Appium server log with test steps and errors; 'device' — on-device logcat; 'ws' — WebSocket/network bridge log. If the report has only one log, that one is returned (the header says so); browser reports have none."),
      maxLines: z
        .number()
        .int()
        .optional()
        .default(200)
        .describe('Number of lines to return from the END of the log. With contains: the number of MATCHES from the end (their context lines are extra). Default: 200.'),
      contains: z
        .string()
        .min(1)
        .optional()
        .describe('Case-insensitive substring. Returns only matching lines plus `context` lines either side ("--" separates groups).'),
      context: z
        .number()
        .int()
        .min(0)
        .max(50)
        .optional()
        .default(DEFAULT_LOG_CONTEXT)
        .describe(`Lines of context around each contains match. Default: ${DEFAULT_LOG_CONTEXT}.`),
      maxChars: z
        .number()
        .int()
        .min(1000)
        .max(200_000)
        .optional()
        .default(DEFAULT_LOG_MAX_CHARS)
        .describe(`Hard ceiling on returned characters; whole lines are kept from the end. Default: ${DEFAULT_LOG_MAX_CHARS}.`),
    },
    async ({ uuid, logType, maxLines, contains, context, maxChars }) => {
      try {
        const { filename, content, fellBackFrom } = await extractAttachmentLog(uuid, logType ?? 'appium');
        const view = selectLogLines(content, { maxLines: maxLines ?? 200, contains, context, maxChars });
        const parts = [`${filename} — ${view.totalLines} lines`];
        if (fellBackFrom) parts.unshift(`no ${fellBackFrom} log in this report — showing its only log instead`);
        if (contains !== undefined) parts.push(`${view.matches} line(s) contain "${contains}"`);
        // With contains the budget counts MATCHES and whole groups are kept: "66 line(s) contain … showing the last 56"
        // read as 56 of the 66 matching lines when it was 21 matches in 56 lines (UAT 2026-11-24).
        if (contains !== undefined && view.shownMatches !== undefined) {
          parts.push(`showing ${view.truncated ? 'the last ' : ''}${view.shownMatches} match(es) (${view.shownLines} lines with context)`);
        } else {
          parts.push(view.truncated ? `showing the last ${view.shownLines}` : `showing ${view.shownLines}`);
        }
        if (view.charCapped) parts.push(`cut at maxChars=${maxChars ?? DEFAULT_LOG_MAX_CHARS} — narrow with contains or lower maxLines`);
        const header = `[${parts.join(' — ')}]\n\n`;
        return { content: [{ type: 'text', text: header + view.text }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── summarize_test_failures ───────────────────────────────────────────────

  server.tool(
    'summarize_test_failures',
    'Answer "why are my tests failing?" in one call: buckets failed tests by error classification and returns the breakdown (e.g. "44 failures: 38 element_not_found, 6 timeout"). ' +
    'For a finished report file the user asked for, use create_report instead. ' +
    'Use this instead of fanning out get_test_report manually across many failures. ' +
    'Fast: the classification is read straight from the report list (200 failures in ~1.5 s). ' +
    'Scope with startDate/endDate (client-side window), projectName/projectId, and nameFilter (substring on test name).',
    {
      startDate: z.string().optional().describe('ISO 8601 start of window, e.g. "2026-06-01T00:00:00Z". Omit for all-time (bounded by maxReports).'),
      endDate: z.string().optional().describe('ISO 8601 end of window. Defaults to now.'),
      groupBy: z
        .enum(['errorClassification', 'errorCategory', 'name'])
        .optional()
        .default('errorClassification')
        .describe("Dimension to bucket by: 'errorClassification' (default, e.g. element_not_found), 'errorCategory' (e.g. assertion, device, network), or 'name'."),
      nameFilter: z.string().optional().describe('Only include failures whose test name contains this substring (e.g. "Login").'),
      maxReports: z.number().int().min(1).max(1000).optional().default(200).describe('Cap on failures analyzed (fan-out bound). Default 200. capped:true in the result means more failures exist beyond this.'),
      projectId: z.number().int().optional().describe(REPORTER_PROJECT_ID_DESC),
      projectName: z.string().optional().describe('Scope to a project by name.'),
      outputFormat: outputFormatParam,
    },
    async ({ startDate, endDate, groupBy, nameFilter, maxReports, projectId, projectName, outputFormat }) => {
      try {
        const summary = await summarizeTestFailures({
          startDate, endDate, groupBy, nameFilter, maxReports, projectId, projectName,
        });
        return respond(outputFormat, summary, formatFailureSummary(summary));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── list_test_attachments ─────────────────────────────────────────────────

  server.tool(
    'list_test_attachments',
    'Show attachment metadata (file names, types, sizes) for a test execution. Takes the uuid (preferred — globally unique) or the numeric testId. Call this before download_test_attachments to confirm attachments exist — download_test_attachments then takes the uuid shown in the output.',
    {
      uuid: z.string().optional().describe('Test execution UUID (uuid field from list_test_reports). Preferred.'),
      testId: z.number().int().optional().describe('Numeric test ID (test_id from list_test_reports). Unique only within a project — prefer uuid.'),
      outputFormat: outputFormatParam,
    },
    async ({ uuid, testId, outputFormat }) => {
      if ((uuid ? 1 : 0) + (testId != null ? 1 : 0) !== 1) {
        return { content: [{ type: 'text', text: 'Provide exactly one of uuid or testId.' }], isError: true };
      }
      try {
        const report = uuid ? await getTestByUuid(uuid) : await getTestById(testId!);
        const structured = {
          testId: report.test_id,
          uuid: report.uuid,
          hasAttachments: report.has_attachment === 'Y',
          count: report.attachment_count,
          sizeBytes: report.attachments_size,
          attachments: report.testAttachments ?? [],
        };
        return respond(outputFormat, structured, formatTestAttachments(report));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── find_latest_test_for_name ─────────────────────────────────────────────

  server.tool(
    'find_latest_test_for_name',
    'Return the most recent execution record for a test by name. Answers "did the last run of X pass?" without requiring a full list_test_reports query.',
    {
      name: z.string().describe('Exact or partial test name to search for.'),
      projectId: z.number().int().optional().describe(REPORTER_PROJECT_ID_DESC),
      projectName: z.string().optional().describe('Scope to this project name.'),
      outputFormat: outputFormatParam,
    },
    async ({ name, projectId, projectName, outputFormat }) => {
      try {
        // listTestsSortedDesc returns newest-first for every role (server sort, or a capped client-side scan + sort
        // if the platform refuses it) — a plain sorted listTests call would silently return an arbitrary record
        // instead of the latest when sort is refused.
        const result = await listTestsSortedDesc(
          { limit: 1, page: 1, searchValue: name },
          projectId,
          projectName
        );
        if (!result.data || result.data.length === 0) {
          return respond(outputFormat, { found: false }, `No test found matching "${name}".`);
        }
        return respond(outputFormat, result.data[0], formatTestReport(result.data[0]));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── get_project_test_summary ──────────────────────────────────────────────

  server.tool(
    'get_project_test_summary',
    'Return a pass/fail summary for a project (for a finished report file, use create_report instead). Status counts cover all six reporter statuses (Passed, Failed, Error, Incomplete, Skipped, Healed) and are all-time totals — the reporter API does not support date-range filtering for aggregate counts. Error = the test ended abnormally (crash, infrastructure, session ended early — since platform 26.9 these are no longer Incomplete). Pass rate = (Passed+Healed)/(Passed+Healed+Failed+Error). Top failing and top erroring test names are filtered to the requested time window client-side from the most recent 200 of each.',
    {
      startDate: z
        .string()
        .optional()
        .describe('ISO 8601 start of the window for top-failure names, e.g. "2025-01-01T00:00:00Z". Defaults to 48 hours ago if omitted.'),
      endDate: z
        .string()
        .optional()
        .describe('ISO 8601 end of the window. Defaults to now if omitted.'),
      projectId: z.number().int().optional().describe(REPORTER_PROJECT_ID_DESC),
      projectName: z.string().optional().describe('Scope to this project name.'),
      outputFormat: outputFormatParam,
    },
    async ({ startDate, endDate, projectId, projectName, outputFormat }) => {
      try {
        const defaultStart = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        const resolvedStart = startDate ?? defaultStart;

        // All six status counts in ONE call: grouped with pivotBy ["status"] and no groupBy returns a single row
        // { passedCount, failedCount, errorCount, incompleteCount, skippedCount, healedCount, _count_ } (verified live
        // 2026-10-09). The previous per-status listTests calls only asked for Passed/Failed/Incomplete, so Error,
        // Skipped and Healed never reached the total — and since 26.9 every crash/infrastructure abort is Error.
        // Recent Failed and Error records are fetched alongside for the windowed top-N names.
        const recent = (status: 'Failed' | 'Error') =>
          listTestsSortedDesc(
            { limit: 200, page: 1, returnTotalCount: false, filter: [{ property: 'status', operator: '=', value: status }] },
            projectId, projectName
          );
        const [grouped, failedResult, errorResult, byPool] = await Promise.all([
          getGroupedTests({ pivotBy: ['status'] }, projectId, projectName) as Promise<{ data?: Array<Record<string, unknown>> }>,
          recent('Failed'),
          recent('Error'),
          // device.pool.actual (platform 26.7+): which pool each mobile automation test actually ran on. Shared-device
          // flakiness is a common question; one grouped call answers it. Best-effort — the summary stands without it.
          (getGroupedTests({ groupBy: ['device.pool.actual'], pivotBy: ['status'] }, projectId, projectName) as Promise<{ data?: Array<Record<string, unknown>> }>).catch(() => null),
        ]);
        const counts = countsFromPivotRow(grouped?.data?.[0]);
        const devicePools = (byPool?.data ?? [])
          .filter((r) => r['device.pool.actual'] != null) // null = not recorded (non-mobile tests, or before 26.7)
          .map((r) => { const c = countsFromPivotRow(r); return { pool: String(r['device.pool.actual']), total: c.total, failed: c.failed, error: c.error, passRate: passRate(c) }; })
          .sort((a, b) => b.total - a.total);

        // Apply the date window client-side on the most recent 200 of each
        // (start_time filter via API key triggers CSRF — filter locally instead).
        const endTs = endDate ? new Date(endDate).getTime() : Date.now();
        const startTs = new Date(resolvedStart).getTime();
        const topNames = (records: TestReport[]) => {
          const nameCounts: Record<string, number> = {};
          for (const r of records) {
            const t = new Date(r.start_time).getTime();
            if (t >= startTs && t <= endTs) nameCounts[r.name] = (nameCounts[r.name] ?? 0) + 1;
          }
          return Object.entries(nameCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([name, count]) => `${name} (${count}x)`);
        };
        const topFailures = topNames(failedResult.data ?? []);
        const topErrors = topNames(errorResult.data ?? []);

        const windowLabel = endDate
          ? `${resolvedStart} → ${endDate}`
          : startDate
          ? `${resolvedStart} → now`
          : `last 48 hours`;

        const unknown = unknownStatusCount(counts);
        const structured = {
          ...counts,
          ...(unknown > 0 ? { otherStatus: unknown } : {}),
          passRate: passRate(counts),
          passRateBasis: PASS_RATE_BASIS,
          topFailures,
          topErrors,
          window: windowLabel,
          ...(devicePools.length ? { byDevicePool: devicePools } : {}),
        };

        const poolLines = devicePools.length
          ? ['', '   By device pool (mobile automation, platform 26.7+):', ...devicePools.map((p) => `     ${p.pool.padEnd(10)} ${String(p.total).padStart(8)} tests · pass rate ${p.passRate == null ? 'n/a' : `${p.passRate}%`} · ${p.failed} failed · ${p.error} error`)]
          : [];
        return respond(outputFormat, structured, formatProjectTestSummary(counts, windowLabel, topFailures, topErrors) + poolLines.join('\n'));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── delete_test_reports_before_date ──────────────────────────────────────

  server.tool(
    'delete_test_reports_before_date',
    'Permanently delete all test execution records started before a given date. Fetches matching IDs automatically then deletes them. Requires confirmDeletion: true. This cannot be undone. Cloud Admin can always delete; a project-level key only when its project\x27s allowUsersDeleteTests setting is on (otherwise the tool refuses up front and explains how to get it enabled).',
    {
      beforeDate: z
        .string()
        .describe('ISO 8601 cutoff date. All tests with start_time before this date will be deleted, e.g. "2024-01-01T00:00:00Z".'),
      confirmDeletion: z
        .boolean()
        .optional()
        .describe('Must be true to confirm the permanent deletion. Omit or set false to preview what would be deleted.'),
      projectId: z.number().int().optional().describe(REPORTER_PROJECT_ID_DESC),
      projectName: z.string().optional().describe('Scope to this project name.'),
    },
    async ({ beforeDate, confirmDeletion, projectId, projectName }) => {
      // Resolve a reporter projectId to its name FIRST: the gate (and the delete) must look at the project the
      // records are in, not the default scope.
      try {
        projectName = await resolveReporterProjectName(projectId, projectName);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
      const denied = await checkDeleteAllowed(projectName);
      if (denied) {
        return { content: [{ type: 'text', text: denied }], isError: true };
      }
      try {
        // The reporter API does not support start_time filter via API key (CSRF restriction).
        // Fetch all records page by page and apply the date filter client-side.
        const cutoff = new Date(beforeDate).getTime();
        const allIds: number[] = [];
        let page = 1;
        while (true) {
          const batch = await listTests(
            { limit: 500, page, returnTotalCount: false },
            projectId,
            projectName
          );
          for (const r of batch.data ?? []) {
            if (new Date(r.start_time).getTime() < cutoff) allIds.push(r.test_id);
          }
          if ((batch.data ?? []).length < 500) break;
          page++;
        }

        if (allIds.length === 0) {
          return { content: [{ type: 'text', text: `No test reports found before ${beforeDate}.` }] };
        }

        const guard = checkDestructiveGuard(
          confirmDeletion,
          `Delete ${allIds.length} test report(s) started before ${beforeDate}${deleteScopeLabel(projectName)}`
        );
        if (guard) {
          return {
            content: [{ type: 'text', text: `${guard}\n\nPreview: ${allIds.length} record(s) would be deleted (IDs ${allIds[0]}…${allIds[allIds.length - 1]}).` }],
          };
        }

        await deleteTests(allIds, projectId, projectName);
        return {
          content: [{ type: 'text', text: `✅ Deleted ${allIds.length} test report(s) started before ${beforeDate}${deleteScopeLabel(projectName)}.` }],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── list_active_test_executions ──────────────────────────────────────────

  server.tool(
    'list_active_test_executions',
    'Returns currently-running test executions — answers "what is running right now?". Reads the platform\'s live list of ' +
    'running test requests (name, project, device, user, start time, execution type, Appium version, device query). ' +
    'If that list is unavailable it falls back to the reporter heuristic (Incomplete reports with no duration, within ' +
    'maxAgeHours); the response says which source was used. Each role sees the runs it may see.',
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe('Maximum number of active executions to return (default: 50).'),
      maxAgeHours: z
        .number()
        .min(1)
        .max(168)
        .optional()
        .default(12)
        .describe('Fallback (reporter heuristic) only: ignore Incomplete records that started longer ago than this — they are abandoned or never-finalised runs, not running ones (default 12; test runs time out after 4 h by default).'),
      projectId: z.number().int().optional().describe(
        'CLOUD project ID (as get_server_info / list_projects show) — matched against the platform\'s live list. ' +
        'The reporter fallback (whose IDs differ) is scoped by the matching project name instead.'),
      projectName: z.string().optional().describe('Scope to this project name.'),
      outputFormat: outputFormatParam,
    },
    async ({ limit, maxAgeHours, projectId, projectName, outputFormat }) => {
      // Primary source: the platform's live list. Anything wrong with it (older platform, network) → the heuristic below.
      let live: RunningTestRequest[] | null = null;
      let liveError: string | undefined;
      try {
        live = await getRunningTestRequests();
      } catch (e) {
        liveError = (e as Error).message;
      }
      if (live) {
        // Here projectId is the CLOUD project id — the live list carries that one.
        const scoped = live.filter((r) =>
          (projectName === undefined || (r.projectName ?? '').toLowerCase() === projectName.toLowerCase()) &&
          (projectId === undefined || r.projectId === projectId));
        // The live list keeps requests the platform never closed: five health checks "Running" for 48 hours sat beside
        // runs started minutes ago (UAT 2026-11-24). Tests time out after 4 h by default, so anything older is marked.
        const nowMs = Date.now();
        const aged = scoped.map((r) => {
          const since = Date.parse(r.startedAt ?? r.createdAt ?? '');
          const runningMinutes = Number.isFinite(since) ? Math.max(0, Math.floor((nowMs - since) / 60_000)) : null;
          return { ...r, runningMinutes, ...(runningMinutes != null && runningMinutes > STALE_RUNNING_MINUTES ? { possiblyStale: true } : {}) };
        });
        const staleCount = aged.filter((r) => 'possiblyStale' in r).length;
        const shown = aged.slice(0, limit ?? 50);
        const staleNote = staleCount ? `${staleCount} of these ${staleCount === 1 ? 'has' : 'have'} been "Running" for more than 4 hours (the default test timeout) and ${staleCount === 1 ? 'is' : 'are'} probably stuck, not running: marked possiblyStale.` : undefined;
        const structured = { source: 'running-test-requests', count: shown.length, total: scoped.length, ...(staleNote ? { staleCount, note: staleNote } : {}), executions: shown };
        if (shown.length === 0) {
          return respond(outputFormat, structured, `No test executions are running${projectName || projectId ? ' in that project' : ''} (platform's live list).`);
        }
        const now = Date.now();
        const lines = [`🔴 Running test executions (${shown.length}${scoped.length > shown.length ? ` of ${scoped.length}` : ''}) — platform's live list:\n`];
        for (const r of shown) {
          const since = r.startedAt ?? r.createdAt;
          const elapsed = since ? Math.max(0, Math.floor((now - Date.parse(since)) / 1000)) : null;
          lines.push(
            `  • ${r.name}   [${r.status}${r.executionType ? `, ${r.executionType}` : ''}]`,
            `    Project: ${r.projectName ?? '?'}   User: ${r.username ?? '?'}`,
            `    Device: ${r.deviceName ?? r.browser ?? '?'}${r.deviceOs ? ` (${r.deviceOs} ${r.deviceOsVersion ?? ''})` : ''}${r.appiumServerVersion ? `   Appium ${r.appiumServerVersion}` : ''}`,
            `    Started: ${since ?? '?'}${elapsed !== null ? `   Elapsed: ${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : ''}${'possiblyStale' in r ? '   ⚠️ probably stuck (over 4 h)' : ''}`,
            ''
          );
        }
        if (staleNote) lines.push(`⚠️ ${staleNote}`);
        return respond(outputFormat, structured, lines.join('\n'));
      }

      try {
        // The reporter cannot scope by the CLOUD projectId (its ids differ) — map it to the project name, which both
        // sides share, so a projectId-only call is not silently answered for every project.
        let fallbackProjectName = projectName;
        if (!fallbackProjectName && projectId !== undefined) {
          const project = (await getAllProjects()).find((p) => Number(p.id) === projectId);
          if (!project) {
            return { content: [{ type: 'text' as const, text: `Error: cloud project ID ${projectId} was not found in list_projects — pass projectName instead.` }], isError: true };
          }
          fallbackProjectName = project.name;
        }
        // Fallback: active executions are Incomplete records with null duration.
        // We fetch more than needed since not all Incomplete records are still running.
        const result = await listTestsSortedDesc(
          {
            limit: Math.min((limit ?? 50) * 4, 500),
            page: 1,
            returnTotalCount: false,
            filter: [{ property: 'status', operator: '=', value: 'Incomplete' }],
          },
          undefined, // projectId here is the cloud id — the reporter's ids differ; scoped by name instead
          fallbackProjectName
        );

        // Incomplete + null duration also matches runs that were abandoned or never finalised — the UAT (2026-10-09)
        // found every "active" execution was 3+ days old. Anything older than maxAgeHours is not running now.
        const ageCutoff = Date.now() - (maxAgeHours ?? 12) * 3600_000;
        const unfinished = (result.data ?? []).filter(r => r.duration === null);
        const recent = unfinished.filter(r => new Date(r.start_time).getTime() >= ageCutoff);
        const staleExcluded = unfinished.length - recent.length;
        const active = recent.slice(0, limit ?? 50);
        const staleNote = staleExcluded > 0
          ? ` ${staleExcluded} older Incomplete record(s) were ignored as stale (started more than ${maxAgeHours ?? 12} h ago — abandoned or never finalised).`
          : '';

        const fallbackNote = ` (The platform's live list was unavailable — ${liveError} — so this is the reporter heuristic.)`;
        if (active.length === 0) {
          return respond(outputFormat, { source: 'reporter-heuristic', count: 0, executions: [], staleExcluded, maxAgeHours: maxAgeHours ?? 12 }, `No active test executions found.${staleNote}${fallbackNote}`);
        }

        const structured = {
          source: 'reporter-heuristic',
          staleExcluded,
          maxAgeHours: maxAgeHours ?? 12,
          count: active.length,
          executions: active.map(r => ({
            testId: r.test_id,
            uuid: r.uuid,
            name: r.name,
            startTime: r.start_time,
            projectId: r.project_id,
          })),
        };

        const now = Date.now();
        const lines: string[] = [`🔴 Active test executions (${active.length}):\n`];
        for (const r of active) {
          const elapsedMs = now - new Date(r.start_time).getTime();
          const elapsedMin = Math.floor(elapsedMs / 60000);
          const elapsedSec = Math.floor((elapsedMs % 60000) / 1000);
          lines.push(
            `  • ${r.name}`,
            `    Test ID: ${r.test_id}   UUID: ${r.uuid}`,
            `    Started: ${r.start_time}   Elapsed: ${elapsedMin}m ${elapsedSec}s`,
            `    Project: ${r.project_id}`,
            ''
          );
        }
        lines.push(`Note: "active" is inferred from Incomplete status + null duration within the last ${maxAgeHours ?? 12} h. A test that finished very recently may appear here until the reporter updates.${staleNote}${fallbackNote}`);
        return respond(outputFormat, structured, lines.join('\n'));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── get_failure_rate_by_app_version ──────────────────────────────────────

  server.tool(
    'get_failure_rate_by_app_version',
    'Show pass/fail breakdown grouped by app version key. Requires that test runs record an app version in their key-value metadata. The versionKey parameter should match whatever key your test framework writes (e.g. "appVersion", "buildNumber", "releaseVersion").',
    {
      versionKey: z
        .string()
        .default('appVersion')
        .describe('The test report metadata key that holds the app version, e.g. "appVersion" or "buildNumber".'),
      projectId: z.number().int().optional().describe(REPORTER_PROJECT_ID_DESC),
      projectName: z.string().optional().describe('Scope to this project name.'),
      outputFormat: outputFormatParam,
    },
    async ({ versionKey, projectId, projectName, outputFormat }) => {
      try {
        const result = await getGroupedTests(
          { groupBy: [versionKey], pivotBy: ['status'], returnTotalCount: true },
          projectId,
          projectName
        );
        return respond(outputFormat, result as object, formatGroupedTestReports(result));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── get_test_stability_report ────────────────────────────────────────────

  server.tool(
    'get_test_stability_report',
    'Show the execution history of a named test: last N runs in chronological order, ' +
    'individual pass/fail, overall pass rate, and a sparkline trend. ' +
    'Use this to decide whether a failing test is a new regression or a recurring unstable test.',
    {
      testName: z.string().describe('Exact or partial test name to look up.'),
      maxRuns: z.number().int().min(1).max(200).optional().default(20)
        .describe('Number of most-recent runs to retrieve (default: 20, max: 200).'),
      projectId: z.number().int().optional().describe(REPORTER_PROJECT_ID_DESC),
      projectName: z.string().optional().describe('Scope to this project name.'),
      outputFormat: outputFormatParam,
    },
    async ({ testName, maxRuns, projectId, projectName, outputFormat }) => {
      try {
        const result = await listTestsSortedDesc(
          {
            limit: maxRuns,
            page: 1,
            filter: [{ property: 'name', operator: 'contains', value: testName }],
            returnTotalCount: false,
          },
          projectId,
          projectName
        );
        const runs = result.data ?? [];
        if (runs.length === 0) {
          return respond(outputFormat, { found: false }, `No executions found for test name containing "${testName}".`);
        }

        // Classify by status, not `success` — success is false for Healed (verified live), true only for Passed.
        const c = tallyStatuses(runs);
        const passed = c.passed + c.healed;
        const failed = c.failed;
        const error  = c.error;
        const other  = runs.length - passed - failed - error;
        const rate = passRate(c);

        // Sparkline: ✅ = Passed/Healed, ❌ = Failed, 💥 = Error, ⚠️ = other — newest last
        const icon = (s: string) => (s === 'Error' ? '💥' : ({ pass: '✅', fail: '❌', other: '⚠️' } as const)[statusOutcome(s)]);
        const spark = [...runs].reverse().map(r => icon(r.status)).join(' ');

        // Consecutive streak from the most recent run
        const latestStatus = runs[0].status;
        let streak = 0;
        for (const r of runs) {
          if (r.status === latestStatus) streak++;
          else break;
        }
        const streakLabel = streak > 1 ? ` (${streak} in a row)` : '';

        const structured = {
          testName: runs[0].name,
          runs: runs.length,
          passed, failed, error, other,
          passRate: rate,
          passRateBasis: PASS_RATE_BASIS,
          latestStatus: runs[0].status,
          latestRun: runs[0].start_time,
          streak,
          history: runs.map(r => ({
            testId: r.test_id,
            status: r.status,
            startTime: r.start_time,
            durationMs: r.duration,
          })),
        };

        const lines = [
          `📋 Stability report: "${runs[0].name}"`,
          `   Runs examined: ${runs.length}  |  Pass rate: ${rate == null ? 'n/a' : `${rate}%`}  |  Latest: ${runs[0].status}${streakLabel}`,
          `   ${passed} passed · ${failed} failed · ${error} error · ${other} other`,
          ``,
          `   Trend (oldest → newest):`,
          `   ${spark}`,
          ``,
          `   Most recent ${Math.min(5, runs.length)} runs:`,
          ...runs.slice(0, 5).map(r => {
            const dur = r.duration != null ? `${(r.duration / 1000).toFixed(1)}s` : 'n/a';
            return `     ${icon(r.status)} ${r.status} — ${r.start_time} (${dur})`;
          }),
        ];
        return respond(outputFormat, structured, lines.join('\n'));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── get_cross_platform_divergence ────────────────────────────────────────

  server.tool(
    'get_cross_platform_divergence',
    'Find tests that behave differently on Android vs iOS — passing consistently on one platform ' +
    'while failing on the other. Use this to detect platform-conditional bugs, ' +
    'missing device-specific handling, or OS API differences affecting test stability. ' +
    'Results sorted by divergence magnitude (largest gap first).',
    {
      minRunsPerPlatform: z.number().int().min(1).optional().default(3)
        .describe('Minimum runs on each platform to include a test in the comparison (default: 3). Filters out tests barely run on one OS.'),
      minDivergencePct: z.number().min(0).max(100).optional().default(20)
        .describe('Minimum pass-rate gap (percentage points) to flag as divergent (default: 20).'),
      projectId: z.number().int().optional().describe(REPORTER_PROJECT_ID_DESC),
      projectName: z.string().optional().describe('Scope to this project name.'),
      outputFormat: outputFormatParam,
    },
    async ({ minRunsPerPlatform, minDivergencePct, projectId, projectName, outputFormat }) => {
      try {
        const raw = await getGroupedTests(
          { groupBy: ['name', 'device.os'], pivotBy: ['status'], returnTotalCount: false },
          projectId,
          projectName
        ) as { count: number | null; data: Array<Record<string, unknown>> };

        const rows = Array.isArray(raw) ? raw : (raw.data ?? []);

        // Build a map: testName → {Android: {rate, total}, iOS: {rate, total}}. Rate uses the shared definition
        // ((Passed+Healed)/(Passed+Healed+Failed+Error)) so a run that never reached a verdict doesn't count as a fail.
        type PlatformStat = { rate: number; total: number };
        const map: Record<string, { Android?: PlatformStat; iOS?: PlatformStat }> = {};

        for (const row of rows) {
          const name = String(row['name'] ?? '');
          const os   = String(row['device.os'] ?? '');
          if (!name || (os !== 'Android' && os !== 'iOS')) continue;

          const c = countsFromPivotRow(row);
          if (!map[name]) map[name] = {};
          map[name][os as 'Android' | 'iOS'] = { rate: passRate(c) ?? 0, total: c.total };
        }

        // Find divergent tests
        const divergent = Object.entries(map)
          .filter(([, platforms]) => {
            const a = platforms.Android;
            const i = platforms.iOS;
            return a && i && a.total >= minRunsPerPlatform && i.total >= minRunsPerPlatform;
          })
          .map(([name, platforms]) => {
            const a = platforms.Android!;
            const i = platforms.iOS!;
            const androidPct = a.rate;
            const iosPct     = i.rate;
            return {
              name,
              androidPassRate: parseFloat(androidPct.toFixed(1)),
              androidRuns: a.total,
              iosPassRate: parseFloat(iosPct.toFixed(1)),
              iosRuns: i.total,
              divergencePct: parseFloat(Math.abs(androidPct - iosPct).toFixed(1)),
              failingOn: androidPct < iosPct ? 'Android' : 'iOS',
            };
          })
          .filter(t => t.divergencePct >= minDivergencePct)
          .sort((a, b) => b.divergencePct - a.divergencePct);

        const structured = { found: divergent.length, minRunsPerPlatform, minDivergencePct, divergentTests: divergent };

        if (divergent.length === 0) {
          return respond(outputFormat, structured,
            `No tests found with ≥${minDivergencePct}pp divergence between Android and iOS (min ${minRunsPerPlatform} runs each platform).`);
        }

        const lines = [
          `🔀 Cross-platform divergence (${divergent.length} tests with ≥${minDivergencePct}pp gap):\n`,
          ...divergent.slice(0, 20).map(t =>
            `  ❗ "${t.name}"\n` +
            `     Android: ${t.androidPassRate}% pass (${t.androidRuns} runs)  ` +
            `iOS: ${t.iosPassRate}% pass (${t.iosRuns} runs)  ` +
            `Gap: ${t.divergencePct}pp — failing more on ${t.failingOn}`
          ),
          divergent.length > 20 ? `\n  … and ${divergent.length - 20} more` : '',
        ].filter(Boolean);
        return respond(outputFormat, structured, lines.join('\n'));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── get_daily_execution_trend ────────────────────────────────────────────

  server.tool(
    'get_daily_execution_trend',
    'Show test execution counts and pass rates bucketed by day or week. ' +
    'For a finished report file the user asked for, use create_report instead. ' +
    'Use this to detect volume drops (CI stopped running tests), quality degradation over a sprint, ' +
    'or spikes in failures following a deployment. ' +
    'Fetches records sorted newest-first and stops at maxRecords OR lookbackDays, whichever comes first.',
    {
      lookbackDays: z.number().int().min(1).max(365).optional().default(30)
        .describe('How many days back to analyse (default: 30). Scanning stops as soon as this boundary is crossed.'),
      maxRecords: z.number().int().min(100).max(25000).optional().default(5000)
        .describe('Hard cap on records fetched to protect against very large datasets (default: 5 000, max: 25 000). Increase if your project runs >165 tests/day and lookbackDays > 30.'),
      bucketBy: z.enum(['day', 'week']).optional().default('day')
        .describe('"day" (default) or "week". Weekly buckets are cleaner for 90-day views.'),
      projectId: z.number().int().optional().describe(REPORTER_PROJECT_ID_DESC),
      projectName: z.string().optional().describe('Scope to this project name.'),
      outputFormat: outputFormatParam,
    },
    async ({ lookbackDays, maxRecords, bucketBy, projectId, projectName, outputFormat }) => {
      try {
        const cutoffTs = Date.now() - lookbackDays * 86400000;
        const records: Array<{ status: string; start_time: string }> = [];
        let fetchPage = 1;
        let scanned = 0;
        let scanCapped = false;
        let done = false;
        let lastSorted = false;

        while (!done && records.length < maxRecords) {
          const wantSort = serverSortAvailable();
          const batch = await listTests(
            { limit: 500, page: fetchPage, returnTotalCount: false,
              ...(wantSort && { sort: [{ property: 'start_time', descending: true }] }) },
            projectId, projectName
          );
          if (wantSort && batch.sortApplied === false && fetchPage > 1) {
            // Sort refused partway through: unsorted page N is not a continuation of sorted pages 1..N-1.
            records.length = 0;
            scanned = 0;
            fetchPage = 1;
            continue;
          }
          const rows = batch.data ?? [];
          if (rows.length === 0) break;
          scanned += rows.length;
          const isSorted = batch.sortApplied === true;
          lastSorted = isSorted;

          for (const r of rows) {
            const ts = new Date(r.start_time).getTime();
            // Early-exit is only valid on server-sorted data; otherwise skip out-of-window rows and keep scanning.
            if (ts < cutoffTs) { if (isSorted) { done = true; break; } continue; }
            records.push({ status: r.status, start_time: r.start_time });
            // The record cap ended the scan before the cutoff was reached: older days in the window were never read.
            // (UAT 2026-10-09: a 14-day trend stopped at 5,000 records on day 6 and reported scanCapped: false.)
            if (records.length >= maxRecords) { scanCapped = true; done = true; break; }
          }
          if (rows.length < 500) done = true;
          // Unsorted fallback has no early-exit: maxRecords bounds the rows FETCHED (as documented), and the
          // caller is told the window may be incomplete.
          if (!done && !isSorted && scanned >= maxRecords) { scanCapped = true; done = true; }
          fetchPage++;
        }

        if (records.length === 0) {
          return respond(outputFormat, { buckets: [] },
            `No test executions found in the last ${lookbackDays} days.`);
        }

        // Bucket by day or week
        const bucketKey = (isoDate: string): string => {
          const d = new Date(isoDate);
          if (bucketBy === 'week') {
            // ISO week start (Monday)
            const day = d.getUTCDay() || 7;
            const monday = new Date(d);
            monday.setUTCDate(d.getUTCDate() - (day - 1));
            return monday.toISOString().slice(0, 10);
          }
          return d.toISOString().slice(0, 10);
        };

        const grouped: Record<string, Array<{ status?: string | null }>> = {};
        for (const r of records) (grouped[bucketKey(r.start_time)] ??= []).push(r);
        // passed = Passed + Healed; Error (abnormal end — crash/infrastructure, 26.9+) is its own column, not "other".
        const buckets: Record<string, { total: number; passed: number; failed: number; error: number; other: number; passRate: number | null }> = {};
        for (const [key, rs] of Object.entries(grouped)) {
          const c = tallyStatuses(rs);
          const passed = c.passed + c.healed;
          buckets[key] = { total: c.total, passed, failed: c.failed, error: c.error, other: c.total - passed - c.failed - c.error, passRate: passRate(c) };
        }

        const sorted = Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b));
        // Earliest record actually read — when the scan was capped, days before this are missing, not empty.
        const coveredFrom = records.reduce((min, r) => (r.start_time < min ? r.start_time : min), records[0].start_time);
        // When capped, extrapolate from the observed rate so the caller gets a concrete next step (UAT 2026-10-10: a
        // 14-day request covered 6 days and the agent had to guess what to change).
        const MAX_RECORDS = 25_000;
        const coveredDays = Math.max((Date.now() - new Date(coveredFrom).getTime()) / 86_400_000, 1 / 24);
        const estimatedNeeded = Math.ceil((records.length / coveredDays) * lookbackDays * 1.1 / 500) * 500;
        // On sorted data, MEASURE where the cutoff falls instead of extrapolating: a rate taken from the newest days
        // missed a burst (UAT 2026-11-13 run 2 — the suggested 15,500 fell short because one older day had ~10k runs).
        const measured = scanCapped && lastSorted
          ? await measureTrendWindow(cutoffTs, maxRecords, MAX_RECORDS, projectId, projectName).catch(() => null)
          : null;
        const fittingLookbackDays = !scanCapped ? null
          : measured ? (measured.fittingLookbackDays ?? null)
          : estimatedNeeded > MAX_RECORDS ? Math.max(1, Math.floor((MAX_RECORDS / (records.length / coveredDays)) / 1.1)) : null;
        // Only a maxRecords that covers the window, and never the one that was just used: when even 25,000 does not cover
        // it, the shorter lookback is the only next step (UAT 2026-11-25: 25,000 was suggested again after 25,000 fell short).
        const coveringMaxRecords = !scanCapped || fittingLookbackDays != null ? null
          : measured?.neededRecords ?? Math.min(estimatedNeeded, MAX_RECORDS);
        const suggestedMaxRecords = coveringMaxRecords != null && coveringMaxRecords > maxRecords ? coveringMaxRecords : null;
        const suggestionBasis = measured ? 'measured' : 'estimated from the rate observed so far';
        const structured = {
          bucketBy,
          lookbackDays,
          recordsScanned: records.length,
          cappedAt: records.length >= maxRecords ? maxRecords : null,
          // true whenever maxRecords ended the scan before the lookback window was fully covered
          scanCapped,
          windowComplete: !scanCapped,
          coveredFrom: scanCapped ? coveredFrom : new Date(cutoffTs).toISOString(),
          ...(scanCapped
            ? {
                missingRange: { from: new Date(cutoffTs).toISOString(), to: coveredFrom },
                ...(suggestedMaxRecords != null ? { suggestedMaxRecords } : {}),
                suggestionBasis,
                ...(fittingLookbackDays != null ? { fittingLookbackDays } : {}),
              }
            : {}),
          buckets: sorted.map(([date, b]) => ({
            date,
            total: b.total,
            passed: b.passed,
            failed: b.failed,
            error: b.error,
            other: b.other,
            passRate: b.passRate,
          })),
          passRateBasis: PASS_RATE_BASIS,
        };

        const lines = [
          `📅 Test execution trend (${bucketBy === 'week' ? 'weekly' : 'daily'}, last ${lookbackDays} days — ${records.length} records scanned)\n`,
          `  ${'Date'.padEnd(12)} ${'Total'.padStart(6)} ${'Passed'.padStart(7)} ${'Failed'.padStart(7)} ${'Error'.padStart(7)} ${'Pass%'.padStart(7)}`,
          `  ${'─'.repeat(52)}`,
          ...sorted.map(([date, b]) => {
            const pct = b.passRate == null ? '—' : b.passRate.toFixed(1);
            return `  ${date.padEnd(12)} ${String(b.total).padStart(6)} ${String(b.passed).padStart(7)} ${String(b.failed).padStart(7)} ${String(b.error).padStart(7)} ${pct.padStart(7)}`;
          }),
          `\n  Passed includes Healed. Pass% = (Passed+Healed)/(Passed+Healed+Failed+Error).`,
        ];
        if (scanCapped) {
          lines.push(
            `\n  ⚠️  INCOMPLETE WINDOW: the scan stopped at maxRecords (${maxRecords}) and only covers ${coveredFrom.slice(0, 10)} onward — ` +
            `days before that are MISSING from this trend, not days with zero executions. ` +
            (fittingLookbackDays != null
              ? `At this project's rate even the 25,000 maximum won't cover ${lookbackDays} days — use lookbackDays: ${fittingLookbackDays} with maxRecords: 25000, or bucketBy "week" over several shorter calls. ` +
                'create_test_trend_report counts any range exactly, without this limit.'
              : suggestedMaxRecords != null
                ? `Re-run with maxRecords: ${suggestedMaxRecords} to cover the full ${lookbackDays}-day window (${suggestionBasis}).`
                : `A shorter lookbackDays fits; create_test_trend_report counts any range exactly, without this limit.`)
          );
        }
        return respond(outputFormat, structured, lines.join('\n'));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
