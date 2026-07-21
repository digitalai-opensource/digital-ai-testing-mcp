import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { downloadUsageReport, buildUsageReportPath } from '../api/usage-reports.js';
import { validateUsageReportParams, checkUsageReportSizeGuard, MAX_UNSCOPED_RANGE_DAYS } from '../utils/usage-report-guard.js';
import { validateOutputPath } from '../utils/path-guard.js';
import { SERVER_FS_DOWNLOAD_NOTICE, SERVER_FS_OUTPUT_PARAM } from '../utils/locality.js';
import { buildDownloadCommand } from '../utils/download-command.js';
import { outputFormatParam, respond } from '../utils/output-format.js';

const REPORT_TYPE_ENUM = z.enum([
  'Device Reservations',
  'Users Usage',
  'Devices Usage',
  'Browser Usage',
  'Users Statistics',
  'License Usage',
]);

// Columns and guidance below reflect real live samples, not the object-type name alone — pick the
// NARROWEST report that has the field you need; "License Usage" is the largest and slowest (~27 MB
// for one unfiltered month, measured live) and should be a last resort, not a default.
const REPORT_TYPE_DESCRIPTION =
  'Which platform usage-report CSV to fetch:\n' +
  '- "Device Reservations": columns Project, Start Date, End Date, Total Reservation Time (hours)[, Tokens]. ' +
  'One row per project. Use for capacity planning / chargeback-by-project ("how many device-hours did project X use").\n' +
  '- "Users Usage": SAME columns/shape as Device Reservations. Without a userId it returns IDENTICAL project-aggregate ' +
  'rows to Device Reservations (confirmed live) — redundant; call Device Reservations instead in that case. Only ' +
  'meaningful with a specific non-zero userId, which narrows to that one user\'s reservation-hours per project.\n' +
  '- "Devices Usage": columns Device ID, Device name, OS, OS Version, Project, Total duration (hours). One row per ' +
  'device. Use for per-device utilization / idle-device audits, NOT per-user or per-session questions.\n' +
  '- "Browser Usage": columns session start/end timestamp+time, duration, session host, browser platform/name/version, ' +
  'username, email, project, execution type. One row per Selenium/browser session. Use for browser-version ' +
  'distribution and web-session audit trails, NOT mobile device usage.\n' +
  '- "Users Statistics": columns time logged, user, project, clicks, swipe distance, keys sent, installs, screens ' +
  'sent, screen time min/max/avg (ms), user tag. Per-INTERACTION-EVENT telemetry from interactive/manual sessions — ' +
  'NOT reservation-time totals and NOT automated test results. Use for manual-session engagement/activity analysis only.\n' +
  '- "License Usage": columns full per-session detail (timestamps, user, project, session/license type, device, ' +
  'product). No project/user filter exists — always platform-wide. The largest, slowest report; use only when a ' +
  'coarser report above does not have the field you need (license-seat exhaustion, per-product consumption, full ' +
  'session-level compliance audit).';

const START_DATE_DESC = 'Inclusive start date, "YYYY-MM-DD". Interpreted as UTC 00:00:00.000 — NOT your local timezone.';
const END_DATE_DESC = 'Inclusive end date, "YYYY-MM-DD". Interpreted as UTC 23:59:59.999 — NOT your local timezone.';
const PROJECT_ID_DESC = 'Numeric project ID to scope to a single project. Omit or 0 for all projects. Not supported by "License Usage".';
const USER_ID_DESC = 'Numeric user ID to scope to a single user. Omit or 0 for all users. Not supported by "License Usage", "Devices Usage", or "Browser Usage".';
const CONFIRM_LARGE_DESC = `Set true to proceed with an unfiltered export spanning more than ${MAX_UNSCOPED_RANGE_DAYS} days despite the size guard.`;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function registerUsageReportTools(server: McpServer): void {
  server.tool(
    'download_usage_report',
    'Downloads one of six platform usage-report CSVs — Device Reservations, Users Usage, Devices Usage, Browser Usage, ' +
      'Users Statistics, or License Usage. Cloud Admin only. Unfiltered multi-week exports can be large and slow ' +
      '(measured live: ~27 MB for one unfiltered month of License Usage, ~6.4 MB for one unfiltered week of Device ' +
      `Reservations) — beyond ${MAX_UNSCOPED_RANGE_DAYS} days with no project/user filter, a size guard blocks the ` +
      'download until you narrow the request or pass confirmLargeExport: true.' +
      SERVER_FS_DOWNLOAD_NOTICE,
    {
      reportType: REPORT_TYPE_ENUM.describe(REPORT_TYPE_DESCRIPTION),
      startDate: z.string().describe(START_DATE_DESC),
      endDate: z.string().describe(END_DATE_DESC),
      projectId: z.number().optional().describe(PROJECT_ID_DESC),
      userId: z.number().optional().describe(USER_ID_DESC),
      localPath: z.string().describe(SERVER_FS_OUTPUT_PARAM),
      confirmLargeExport: z.boolean().optional().describe(CONFIRM_LARGE_DESC),
    },
    async ({ reportType, startDate, endDate, projectId, userId, localPath, confirmLargeExport }) => {
      const params = { reportType, startDate, endDate, projectId, userId, confirmLargeExport };

      const validationErr = validateUsageReportParams(params);
      if (validationErr) return { content: [{ type: 'text', text: `Error: ${validationErr}` }], isError: true };

      const pathErr = validateOutputPath(localPath);
      if (pathErr) return { content: [{ type: 'text', text: `Error: ${pathErr}` }], isError: true };

      const guardMsg = checkUsageReportSizeGuard(params);
      if (guardMsg) return { content: [{ type: 'text', text: guardMsg }] };

      try {
        const { bytes } = await downloadUsageReport(reportType, { startDate, endDate, projectId, userId }, localPath);
        return {
          content: [{ type: 'text', text: `✅ "${reportType}" report (${formatBytes(bytes)}) downloaded to: ${localPath}` }],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_usage_report_download_command',
    'Generates a ready-to-run curl or PowerShell command for downloading a usage-report CSV directly to the user\'s ' +
      'local machine. Use this instead of download_usage_report when the MCP server runs in Docker/remote and the ' +
      'written file would be inaccessible to the user — this is the preferred path for large exports, since the ' +
      'download runs on the user\'s own network instead of proxying through the MCP process. Same date/filter/size-guard ' +
      'rules as download_usage_report.\n\n' +
      'WARNING: The generated command embeds the active access key in plaintext. Run immediately, do not save or share.',
    {
      reportType: REPORT_TYPE_ENUM.describe(REPORT_TYPE_DESCRIPTION),
      startDate: z.string().describe(START_DATE_DESC),
      endDate: z.string().describe(END_DATE_DESC),
      projectId: z.number().optional().describe(PROJECT_ID_DESC),
      userId: z.number().optional().describe(USER_ID_DESC),
      localPath: z.string().describe('Path on the user\'s local machine to save the CSV.'),
      localPlatform: z
        .enum(['windows', 'macos', 'linux'])
        .describe('Platform of the machine that will run the command. "windows" emits both Git Bash curl and PowerShell. Cannot be inferred — the MCP runs in Docker.'),
      confirmLargeExport: z.boolean().optional().describe(CONFIRM_LARGE_DESC),
      outputFormat: outputFormatParam,
    },
    async ({ reportType, startDate, endDate, projectId, userId, localPath, localPlatform, confirmLargeExport, outputFormat }) => {
      const params = { reportType, startDate, endDate, projectId, userId, confirmLargeExport };

      const validationErr = validateUsageReportParams(params);
      if (validationErr) return { content: [{ type: 'text', text: `Error: ${validationErr}` }], isError: true };

      const guardMsg = checkUsageReportSizeGuard(params);
      if (guardMsg) return { content: [{ type: 'text', text: guardMsg }] };

      const path = buildUsageReportPath(reportType, { startDate, endDate, projectId, userId });
      const result = buildDownloadCommand({
        path,
        localPath,
        localPlatform,
        notes: [`Report: "${reportType}" (${startDate} to ${endDate}, inclusive UTC calendar days)`],
      });
      return respond(
        outputFormat,
        { endpoint: result.endpoint, curlCommand: result.curlCommand, psCommand: result.psCommand },
        result.humanText
      );
    }
  );
}
