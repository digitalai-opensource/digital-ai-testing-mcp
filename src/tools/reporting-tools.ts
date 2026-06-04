import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TestReport } from '../types/digital-ai.js';
import { z } from 'zod';
import {
  getTestById,
  getTestByReportApiId,
  listTests,
  getGroupedTests,
  getDistinctKeyValues,
  deleteTests,
  downloadTestAttachments,
} from '../api/reporting.js';
import { checkDestructiveGuard } from '../utils/destructive-guard.js';
import { validateOutputPath } from '../utils/path-guard.js';
import {
  formatTestReport,
  formatTestReportList,
  formatTestAttachments,
  formatGroupedTestReports,
  formatProjectTestSummary,
} from '../utils/response-formatter.js';
import { outputFormatParam, respond } from '../utils/output-format.js';

export function registerReportingTools(server: McpServer): void {
  // ─── get_test_report ───────────────────────────────────────────────────────

  server.tool(
    'get_test_report',
    'Retrieve a full test execution report by its numeric test ID or by the report URL printed in tearDown (digitalai:reportUrl capability). ' +
    'Provide either testId OR reportUrl — reportUrl is parsed to extract the numeric test ID automatically. ' +
    'The test ID (test_id field) is also returned by list_test_reports and find_latest_test_for_name.',
    {
      testId: z.number().int().optional().describe('The numeric test ID (test_id field from list results, e.g. 377918). Provide this OR reportUrl.'),
      reportUrl: z.string().optional().describe('The report URL printed by tearDown (digitalai:reportUrl capability value). The numeric test ID is extracted automatically.'),
      includeSteps: z.boolean().optional().describe('If true, include step-level detail. Default: false.'),
      outputFormat: outputFormatParam,
    },
    async ({ testId, reportUrl, includeSteps, outputFormat }) => {
      let resolvedId = testId;

      if (!resolvedId && reportUrl) {
        const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
        const numericMatch = reportUrl.match(/\/(\d+)\/?(?:\?.*)?$/);
        if (numericMatch) {
          resolvedId = parseInt(numericMatch[1], 10);
        } else if (UUID_RE.test(reportUrl)) {
          return {
            content: [{
              type: 'text',
              text: `The report URL contains a UUID, not a numeric test ID. The Digital.ai reporter API does not support UUID-based lookup.\n\n` +
                `Use the numeric test ID from the "Report Test ID" line printed in tearDown (digitalai:reportTestId capability):\n` +
                `  get_test_report(testId: <the number from "Report Test ID">)\n\n` +
                `Or find it via: list_test_reports or find_latest_test_for_name.`,
            }],
            isError: true,
          };
        } else {
          return {
            content: [{ type: 'text', text: `Could not extract a numeric test ID from the report URL: ${reportUrl}. Provide testId directly instead.` }],
            isError: true,
          };
        }
      }

      if (!resolvedId) {
        return {
          content: [{ type: 'text', text: 'Provide either testId or reportUrl.' }],
          isError: true,
        };
      }

      try {
        const report = await getTestById(resolvedId, includeSteps ?? false);
        return respond(outputFormat, report, formatTestReport(report));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── get_test_by_report_id ─────────────────────────────────────────────────

  server.tool(
    'get_test_by_report_id',
    'Retrieve a test execution report using the report_api_id returned when starting a manual or web-control test session. CRITICAL: report_api_id is NOT the same as test_id (integer) or uuid (hex UUID). It is a separate opaque string returned only by create_mobile_manual_test, start_manual_test_session, or start_device_web_control. This only works AFTER the session has fully ended — allow up to 60 seconds after session close.',
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
          content: [{ type: 'text', text: `Error: "${reportApiId}" is a test UUID, not a report_api_id. There is no API endpoint to look up a test by UUID — use get_test_report(testId: <numeric_id>) instead. Find the numeric test_id via list_test_reports or find_latest_test_for_name. The report_api_id is a different identifier returned only when starting a manual or web-control session.` }],
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
    'Search and list test execution reports. Supports filtering, sorting, and pagination. ' +
    'For date-range filtering use startDate/endDate — server-side start_time filtering is CSRF-blocked. ' +
    'Scoped to a project if projectId or projectName is provided.',
    {
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
              '"has_attachment" ("Y"/"N"), ' +
              '"success" (boolean true/false), ' +
              '"test_id" (number), ' +
              '"project_id" (number), ' +
              '"device.os" ("Android"/"iOS" — case-sensitive), ' +
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
              'Filter value. Use boolean true/false for "success", numbers for numeric fields, strings for text fields.'
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
          'Key names to include in the response, e.g. ["device.os", "browser"]. Omit to return all keys.'
        ),
      returnTotalCount: z
        .boolean()
        .optional()
        .describe('If true, the response includes the total matching count. Ignored when startDate/endDate are provided.'),
      startDate: z
        .string()
        .optional()
        .describe('ISO 8601 start of date range, e.g. "2025-01-01T00:00:00Z". Applied client-side — do NOT also add start_time to filter[].'),
      endDate: z
        .string()
        .optional()
        .describe('ISO 8601 end of date range, e.g. "2025-06-01T00:00:00Z". Defaults to now when startDate is provided.'),
      projectId: z.number().int().optional().describe('Scope results to this project ID.'),
      projectName: z.string().optional().describe('Scope results to this project name.'),
      outputFormat: outputFormatParam,
    },
    async ({ limit, page, searchValue, filter, sort, keys, returnTotalCount, startDate, endDate, projectId, projectName, outputFormat }) => {
      try {
        const targetLimit = limit ?? 50;

        if (startDate || endDate) {
          // Client-side date filtering. Server-side start_time filter is blocked for API key auth.
          // Fetch pages sorted descending so we can stop as soon as we pass the startDate cutoff.
          const startTs = startDate ? new Date(startDate).getTime() : 0;
          const endTs = endDate ? new Date(endDate).getTime() : Date.now();
          const matched: TestReport[] = [];
          let fetchPage = 1;
          let done = false;

          while (!done && matched.length < targetLimit) {
            const batch = await listTests(
              {
                limit: 500,
                page: fetchPage,
                returnTotalCount: false,
                sort: [{ property: 'start_time', descending: true }],
                ...(searchValue && { searchValue }),
                ...(filter && { filter }),
                ...(keys && { keys }),
              },
              projectId,
              projectName
            );
            const records = batch.data ?? [];
            if (records.length === 0) break;

            for (const r of records) {
              const t = new Date(r.start_time).getTime();
              if (t < startTs) { done = true; break; }
              if (t <= endTs) {
                matched.push(r);
                if (matched.length >= targetLimit) { done = true; break; }
              }
            }
            if (records.length < 500) done = true;
            fetchPage++;
          }

          const rangeLabel = `${startDate ?? 'beginning'} → ${endDate ?? 'now'}`;
          const header = matched.length === 0
            ? `No tests found in range ${rangeLabel} (date filter applied client-side).`
            : `${matched.length} test(s) in range ${rangeLabel} (date filter applied client-side):\n`;
          return respond(
            outputFormat,
            { reports: matched },
            header + (matched.length > 0 ? '\n' + formatTestReportList(matched) : '')
          );
        }

        const request = {
          limit: targetLimit,
          page: page ?? 1,
          returnTotalCount: returnTotalCount ?? true,
          ...(searchValue && { searchValue }),
          ...(filter && { filter }),
          ...(sort && { sort }),
          ...(keys && { keys }),
        };
        const result = await listTests(request, projectId, projectName);
        const reports = result.data ?? [];
        const countLine = result.count !== undefined ? `Total matching: ${result.count}\n\n` : '';
        return respond(
          outputFormat,
          { reports, total: result.count },
          countLine + formatTestReportList(reports)
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
    'Note: null OS values represent browser/Selenium sessions. ' +
    'When groupBy includes "device.os", the MCP normalises case variants ("ANDROID"/"IOS") to ' +
    '"Android"/"iOS" and merges their counts, so you always receive at most 3 rows: Android, iOS, null.',
    {
      groupBy: z
        .array(z.string())
        .optional()
        .describe(
          'Fields to group results by, e.g. ["device.os"], ["status"], or ["device.os","status"] for multi-dimensional grouping. ' +
          'Each unique value combination becomes one row. Omit to get a single aggregate row for the entire dataset.'
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
        .describe('Scope the aggregation to matching records. Same filter syntax as list_test_reports.'),
      returnTotalCount: z
        .boolean()
        .optional()
        .describe('If true, includes total record count across all groups.'),
      projectId: z.number().int().optional().describe('Scope to this project ID.'),
      projectName: z.string().optional().describe('Scope to this project name.'),
      outputFormat: outputFormatParam,
    },
    async ({ groupBy, pivotBy, filter, returnTotalCount, projectId, projectName, outputFormat }) => {
      try {
        const request = {
          ...(groupBy && { groupBy }),
          ...(pivotBy && { pivotBy }),
          ...(filter && { filter }),
          returnTotalCount: returnTotalCount ?? true,
        };
        let result = await getGroupedTests(request, projectId, projectName) as { count?: number | null; data?: Array<Record<string, unknown>> };

        // Normalise device.os case variants ("ANDROID"/"IOS") to canonical form and
        // merge their counts so consumers see at most 3 rows: Android, iOS, null.
        if (groupBy?.includes('device.os') && Array.isArray(result?.data)) {
          const OS_NORM: Record<string, string> = { android: 'Android', ios: 'iOS' };
          const merged: Record<string, Record<string, unknown>> = {};
          for (const row of result.data) {
            const rawOs = row['device.os'];
            const normOs = rawOs == null ? null : (OS_NORM[(String(rawOs)).toLowerCase()] ?? String(rawOs));
            const key = normOs ?? '__null__';
            if (!merged[key]) {
              merged[key] = { ...row, 'device.os': normOs };
            } else {
              // Sum all numeric count fields
              for (const [k, v] of Object.entries(row)) {
                if (typeof v === 'number' && k !== 'device.os') {
                  merged[key][k] = ((merged[key][k] as number) ?? 0) + v;
                }
              }
            }
          }
          result = { ...result, data: Object.values(merged) };
        }

        return respond(outputFormat, result as object, formatGroupedTestReports(result));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── get_distinct_test_key_values ──────────────────────────────────────────

  server.tool(
    'get_distinct_test_key_values',
    'Return every distinct value recorded for one or more test report keys. Useful for discovering what devices, browsers, environments, or other dimensions appear in test history. NOTE: this tool requires browser session authentication on some platforms — if you receive a CSRF/401 error, the endpoint is not accessible via API key on your deployment. Use get_grouped_test_reports with a keys array as an alternative.',
    {
      keys: z
        .array(z.string())
        .min(1)
        .describe('One or more key names, e.g. ["device.os", "browser", "environment"].'),
      projectId: z.number().int().optional().describe('Scope to this project ID.'),
      projectName: z.string().optional().describe('Scope to this project name.'),
      outputFormat: outputFormatParam,
    },
    async ({ keys, projectId, projectName, outputFormat }) => {
      try {
        const result = await getDistinctKeyValues(keys, projectId, projectName);
        const lines: string[] = [];
        for (const [key, rawValues] of Object.entries(result)) {
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
        return respond(outputFormat, result, lines.join('\n') || 'No values found.');
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.startsWith('PLATFORM_LIMITATION:')) {
          return {
            content: [{ type: 'text', text: `⚠️ Platform limitation: This endpoint requires browser session authentication and is not available via API key on this deployment.\n\nAlternative: use get_grouped_test_reports with a keys array to enumerate value combinations for the same keys.` }],
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
    'Permanently delete one or more test execution records by their numeric IDs. This cannot be undone. Requires confirmDeletion: true.',
    {
      ids: z
        .array(z.number().int())
        .min(1)
        .describe('Array of numeric test IDs to delete, e.g. [5, 67, 100].'),
      confirmDeletion: z
        .boolean()
        .optional()
        .describe('Must be true to confirm the permanent deletion.'),
      projectId: z.number().int().optional().describe('Scope to this project ID.'),
      projectName: z.string().optional().describe('Scope to this project name.'),
    },
    async ({ ids, confirmDeletion, projectId, projectName }) => {
      const guard = checkDestructiveGuard(confirmDeletion, `Delete ${ids.length} test report(s): [${ids.join(', ')}]`);
      if (guard) return { content: [{ type: 'text', text: guard }] };
      try {
        await deleteTests(ids, projectId, projectName);
        return {
          content: [{ type: 'text', text: `✅ Successfully deleted ${ids.length} test report(s).` }],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── download_test_attachments ─────────────────────────────────────────────

  server.tool(
    'download_test_attachments',
    'Download all attachments for a test execution as a ZIP file. The file is saved to the specified local path.',
    {
      uuid: z.string().describe('The test execution UUID.'),
      localPath: z
        .string()
        .describe('Absolute local path where the ZIP file will be saved, e.g. "/tmp/test-attachments.zip".'),
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

  // ─── list_test_attachments ─────────────────────────────────────────────────

  server.tool(
    'list_test_attachments',
    'Show attachment metadata (file names, types, sizes) for a test execution. Takes the numeric testId (integer), NOT the uuid string. Call this before download_test_attachments to confirm attachments exist — download_test_attachments then takes the uuid shown in the output.',
    {
      testId: z.number().int().describe('Numeric test ID (the test_id integer from list_test_reports or find_latest_test_for_name — NOT the uuid string).'),
      outputFormat: outputFormatParam,
    },
    async ({ testId, outputFormat }) => {
      try {
        const report = await getTestById(testId);
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
      projectId: z.number().int().optional().describe('Scope to this project ID.'),
      projectName: z.string().optional().describe('Scope to this project name.'),
      outputFormat: outputFormatParam,
    },
    async ({ name, projectId, projectName, outputFormat }) => {
      try {
        const result = await listTests(
          { limit: 1, page: 1, searchValue: name, sort: [{ property: 'start_time', descending: true }] },
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
    'Return a human-readable pass/fail summary for a project. Overall status counts (Passed/Failed/Incomplete) are all-time totals — the reporter API does not support date-range filtering for aggregate counts. Top failing test names are filtered to the requested time window client-side from the most recent 200 failures.',
    {
      startDate: z
        .string()
        .optional()
        .describe('ISO 8601 start of the window for top-failure names, e.g. "2025-01-01T00:00:00Z". Defaults to 48 hours ago if omitted.'),
      endDate: z
        .string()
        .optional()
        .describe('ISO 8601 end of the window. Defaults to now if omitted.'),
      projectId: z.number().int().optional().describe('Scope to this project ID.'),
      projectName: z.string().optional().describe('Scope to this project name.'),
      outputFormat: outputFormatParam,
    },
    async ({ startDate, endDate, projectId, projectName, outputFormat }) => {
      try {
        const defaultStart = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        const resolvedStart = startDate ?? defaultStart;

        // Fetch per-status counts + recent failures in parallel.
        // The grouped endpoint returns empty data[] without grouping keys, so we
        // use per-status listTests calls with returnTotalCount which reliably works.
        const [passedResult, failedResult, incompleteResult] = await Promise.all([
          listTests(
            { limit: 1, page: 1, returnTotalCount: true, filter: [{ property: 'status', operator: '=', value: 'Passed' }] },
            projectId, projectName
          ),
          listTests(
            { limit: 200, page: 1, returnTotalCount: true, filter: [{ property: 'status', operator: '=', value: 'Failed' }], sort: [{ property: 'start_time', descending: true }] },
            projectId, projectName
          ),
          listTests(
            { limit: 1, page: 1, returnTotalCount: true, filter: [{ property: 'status', operator: '=', value: 'Incomplete' }] },
            projectId, projectName
          ),
        ]);

        const passed = passedResult.count ?? 0;
        const failed = failedResult.count ?? 0;
        const incomplete = incompleteResult.count ?? 0;
        const total = passed + failed + incomplete;

        // Apply date window client-side on the most recent 200 failures
        // (start_time filter via API key triggers CSRF — filter locally instead).
        const endTs = endDate ? new Date(endDate).getTime() : Date.now();
        const startTs = new Date(resolvedStart).getTime();
        const windowedFailures = (failedResult.data ?? []).filter((r) => {
          const t = new Date(r.start_time).getTime();
          return t >= startTs && t <= endTs;
        });

        const nameCounts: Record<string, number> = {};
        for (const r of windowedFailures) {
          nameCounts[r.name] = (nameCounts[r.name] ?? 0) + 1;
        }
        const topFailures = Object.entries(nameCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([name, count]) => `${name} (${count}x)`);

        const statusCounts = { Passed: passed, Failed: failed, Incomplete: incomplete };
        const windowLabel = endDate
          ? `${resolvedStart} → ${endDate}`
          : startDate
          ? `${resolvedStart} → now`
          : `last 48 hours`;

        const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0.0';
        const structured = {
          total,
          passed,
          failed,
          incomplete,
          passRate: parseFloat(passRate),
          topFailures,
          window: windowLabel,
        };

        return respond(outputFormat, structured, formatProjectTestSummary(statusCounts, total, windowLabel, topFailures));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── delete_test_reports_before_date ──────────────────────────────────────

  server.tool(
    'delete_test_reports_before_date',
    'Permanently delete all test execution records started before a given date. Fetches matching IDs automatically then deletes them. Requires confirmDeletion: true. This cannot be undone.',
    {
      beforeDate: z
        .string()
        .describe('ISO 8601 cutoff date. All tests with start_time before this date will be deleted, e.g. "2024-01-01T00:00:00Z".'),
      confirmDeletion: z
        .boolean()
        .optional()
        .describe('Must be true to confirm the permanent deletion. Omit or set false to preview what would be deleted.'),
      projectId: z.number().int().optional().describe('Scope to this project ID.'),
      projectName: z.string().optional().describe('Scope to this project name.'),
    },
    async ({ beforeDate, confirmDeletion, projectId, projectName }) => {
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
          `Delete ${allIds.length} test report(s) started before ${beforeDate}`
        );
        if (guard) {
          return {
            content: [{ type: 'text', text: `${guard}\n\nPreview: ${allIds.length} record(s) would be deleted (IDs ${allIds[0]}…${allIds[allIds.length - 1]}).` }],
          };
        }

        await deleteTests(allIds, projectId, projectName);
        return {
          content: [{ type: 'text', text: `✅ Deleted ${allIds.length} test report(s) started before ${beforeDate}.` }],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── list_active_test_executions ──────────────────────────────────────────

  server.tool(
    'list_active_test_executions',
    'Returns currently-running test executions. Active tests appear in the reporter as Incomplete status with no duration value. This tool encapsulates that heuristic so you don\'t need to compose list_test_reports filters manually. Useful for answering "what is running right now?"',
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe('Maximum number of active executions to return (default: 50).'),
      projectId: z.number().int().optional().describe('Scope to this project ID.'),
      projectName: z.string().optional().describe('Scope to this project name.'),
      outputFormat: outputFormatParam,
    },
    async ({ limit, projectId, projectName, outputFormat }) => {
      try {
        // Active executions are Incomplete records with null duration.
        // We fetch more than needed since not all Incomplete records are still running.
        const result = await listTests(
          {
            limit: Math.min((limit ?? 50) * 4, 500),
            page: 1,
            returnTotalCount: false,
            filter: [{ property: 'status', operator: '=', value: 'Incomplete' }],
            sort: [{ property: 'start_time', descending: true }],
          },
          projectId,
          projectName
        );

        const active = (result.data ?? []).filter(r => r.duration === null).slice(0, limit ?? 50);

        if (active.length === 0) {
          return respond(outputFormat, { count: 0, executions: [] }, 'No active test executions found. All Incomplete records have finished reporting.');
        }

        const structured = {
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
        lines.push('Note: "active" is inferred from Incomplete status + null duration. A test that finished very recently may appear here until the reporter updates.');
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
      projectId: z.number().int().optional().describe('Scope to this project ID.'),
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
      projectId: z.number().int().optional().describe('Scope to this project ID.'),
      projectName: z.string().optional().describe('Scope to this project name.'),
      outputFormat: outputFormatParam,
    },
    async ({ testName, maxRuns, projectId, projectName, outputFormat }) => {
      try {
        const result = await listTests(
          {
            limit: maxRuns,
            page: 1,
            filter: [{ property: 'name', operator: 'contains', value: testName }],
            sort: [{ property: 'start_time', descending: true }],
            returnTotalCount: false,
          },
          projectId,
          projectName
        );
        const runs = result.data ?? [];
        if (runs.length === 0) {
          return respond(outputFormat, { found: false }, `No executions found for test name containing "${testName}".`);
        }

        const passed = runs.filter(r => r.status === 'Passed' || r.success).length;
        const failed = runs.filter(r => r.status === 'Failed').length;
        const other  = runs.length - passed - failed;
        const passRate = runs.length > 0 ? ((passed / runs.length) * 100).toFixed(1) : '0.0';

        // Sparkline: ✅ = Passed, ❌ = Failed, ⚠️ = other — newest last
        const spark = [...runs].reverse().map(r => {
          if (r.status === 'Passed' || r.success) return '✅';
          if (r.status === 'Failed') return '❌';
          return '⚠️';
        }).join(' ');

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
          passed, failed, other,
          passRate: parseFloat(passRate),
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
          `   Runs examined: ${runs.length}  |  Pass rate: ${passRate}%  |  Latest: ${runs[0].status}${streakLabel}`,
          `   ${passed} passed · ${failed} failed · ${other} other`,
          ``,
          `   Trend (oldest → newest):`,
          `   ${spark}`,
          ``,
          `   Most recent ${Math.min(5, runs.length)} runs:`,
          ...runs.slice(0, 5).map(r => {
            const dur = r.duration != null ? `${(r.duration / 1000).toFixed(1)}s` : 'n/a';
            const icon = r.status === 'Passed' ? '✅' : r.status === 'Failed' ? '❌' : '⚠️';
            return `     ${icon} ${r.status} — ${r.start_time} (${dur})`;
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
      projectId: z.number().int().optional().describe('Scope to this project ID.'),
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

        // Build a map: testName → {Android: {passed, total}, iOS: {passed, total}}
        type PlatformStat = { passed: number; total: number };
        const map: Record<string, { Android?: PlatformStat; iOS?: PlatformStat }> = {};

        for (const row of rows) {
          const name = String(row['name'] ?? '');
          const os   = String(row['device.os'] ?? '');
          if (!name || (os !== 'Android' && os !== 'iOS')) continue;

          const passed = Number(row['passedCount'] ?? 0);
          const total  = Number(row['_count_'] ?? (Number(row['passedCount'] ?? 0) + Number(row['failedCount'] ?? 0) + Number(row['incompleteCount'] ?? 0) + Number(row['errorCount'] ?? 0)));

          if (!map[name]) map[name] = {};
          map[name][os as 'Android' | 'iOS'] = { passed, total };
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
            const androidPct = a.total > 0 ? (a.passed / a.total) * 100 : 0;
            const iosPct     = i.total > 0 ? (i.passed / i.total) * 100 : 0;
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
      projectId: z.number().int().optional().describe('Scope to this project ID.'),
      projectName: z.string().optional().describe('Scope to this project name.'),
      outputFormat: outputFormatParam,
    },
    async ({ lookbackDays, maxRecords, bucketBy, projectId, projectName, outputFormat }) => {
      try {
        const cutoffTs = Date.now() - lookbackDays * 86400000;
        const records: Array<{ status: string; start_time: string }> = [];
        let fetchPage = 1;
        let done = false;

        while (!done && records.length < maxRecords) {
          const batch = await listTests(
            { limit: 500, page: fetchPage, returnTotalCount: false,
              sort: [{ property: 'start_time', descending: true }] },
            projectId, projectName
          );
          const rows = batch.data ?? [];
          if (rows.length === 0) break;

          for (const r of rows) {
            const ts = new Date(r.start_time).getTime();
            if (ts < cutoffTs) { done = true; break; }
            records.push({ status: r.status, start_time: r.start_time });
            if (records.length >= maxRecords) { done = true; break; }
          }
          if (rows.length < 500) done = true;
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

        const buckets: Record<string, { total: number; passed: number; failed: number; other: number }> = {};
        for (const r of records) {
          const key = bucketKey(r.start_time);
          if (!buckets[key]) buckets[key] = { total: 0, passed: 0, failed: 0, other: 0 };
          buckets[key].total++;
          if (r.status === 'Passed') buckets[key].passed++;
          else if (r.status === 'Failed') buckets[key].failed++;
          else buckets[key].other++;
        }

        const sorted = Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b));
        const structured = {
          bucketBy,
          lookbackDays,
          recordsScanned: records.length,
          cappedAt: records.length >= maxRecords ? maxRecords : null,
          buckets: sorted.map(([date, b]) => ({
            date,
            total: b.total,
            passed: b.passed,
            failed: b.failed,
            other: b.other,
            passRate: b.total > 0 ? parseFloat(((b.passed / b.total) * 100).toFixed(1)) : null,
          })),
        };

        const lines = [
          `📅 Test execution trend (${bucketBy === 'week' ? 'weekly' : 'daily'}, last ${lookbackDays} days — ${records.length} records scanned)\n`,
          `  ${'Date'.padEnd(12)} ${'Total'.padStart(6)} ${'Passed'.padStart(7)} ${'Failed'.padStart(7)} ${'Pass%'.padStart(7)}`,
          `  ${'─'.repeat(44)}`,
          ...sorted.map(([date, b]) => {
            const pct = b.total > 0 ? ((b.passed / b.total) * 100).toFixed(1) : '—';
            return `  ${date.padEnd(12)} ${String(b.total).padStart(6)} ${String(b.passed).padStart(7)} ${String(b.failed).padStart(7)} ${pct.padStart(7)}`;
          }),
        ];
        if (records.length >= maxRecords) {
          lines.push(`\n  ⚠️  Capped at ${maxRecords} records — increase maxRecords or reduce lookbackDays for a complete picture.`);
        }
        return respond(outputFormat, structured, lines.join('\n'));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
