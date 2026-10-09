import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  executeTestRun,
  getTestRunStatus,
  cancelTestRun,
  validateTestRunRequest,
  testRunScalarFields,
  testsFieldName,
  deviceQueriesQueryString,
  TEST_RUN_EXECUTION_TYPES,
  TEST_RUN_RUNNING_TYPES,
  type TestRunRequest,
  type TestRunStatus,
} from '../api/test-runs.js';
import { validateInputPath } from '../utils/path-guard.js';
import { checkDestructiveGuard } from '../utils/destructive-guard.js';
import { buildUploadCommand } from '../utils/upload-command.js';
import { serverFsUploadNotice, serverFsInputParam, commandGeneratorNotice, localPlatformParamNotice } from '../utils/locality.js';
import { outputFormatParam, respond } from '../utils/output-format.js';
import { commandPayload } from '../utils/command-payload.js';

const MAESTRO_BUNDLE_NOTE =
  'Maestro bundle = a .zip with a flows/ directory of .yaml flows (the platform rejects a bundle without flows/); ' +
  'an optional config.yaml and utils/ may sit alongside. Android only. Build flows from element IDs captured live ' +
  '(start_inspection_session → get_element_tree) — never guessed IDs.';

// Shared by execute_test_run and get_test_run_command — one schema, so the two cannot drift.
const runParams = {
  executionType: z.enum(TEST_RUN_EXECUTION_TYPES).describe('ESPRESSO (Android instrumentation), XCUITEST (iOS) or MAESTRO (Android flows).'),
  runningType: z
    .enum(TEST_RUN_RUNNING_TYPES)
    .optional()
    .default('fastFeedback')
    .describe('fastFeedback (default): spread the tests across up to maxDevices devices matching ONE deviceQuery. coverage: run every test on one device per deviceQuery.'),
  cloudAppId: z.number().int().optional().describe('Numeric application id from list_applications (NOT the app name — a name is rejected). One app source is required.'),
  appUrl: z.string().optional().describe('URL of the application under test. One app source is required.'),
  testsUrl: z.string().optional().describe('ESPRESSO/XCUITEST only: URL of the test package (.zip). One test source is required.'),
  cloudTestAppId: z.number().int().optional().describe('ESPRESSO/XCUITEST only: numeric id of the test package in the file repository.'),
  deviceQueries: z
    .array(z.string())
    .min(1)
    .describe("Device queries, e.g. [\"@os='android' and @category='PHONE'\"]. fastFeedback takes exactly one. Add @region from find_available_device to avoid unhealthy regions."),
  maxDevices: z.number().int().min(1).optional().describe('fastFeedback: maximum devices to use (recommended — the default is the license maximum).'),
  minDevices: z.number().int().min(1).optional().describe('fastFeedback: minimum devices (default 1).'),
  retry: z.number().int().min(0).max(5).optional().describe('Retries for failed tests, 0–5 (default 0).'),
  retryDifferentDevice: z.boolean().optional().describe('Retry failed tests on a different device.'),
  overallTimeoutMs: z.number().int().optional().describe('Timeout for the whole run in ms (platform default 4 h).'),
  reservationDurationMin: z.number().int().optional().describe('Reservation per device session in minutes (default 120).'),
  includeTests: z.array(z.string()).optional().describe('ESPRESSO/XCUITEST: run only these (fullClassName, fullClassName.methodName, methodName or packageName).'),
  runTags: z.record(z.string(), z.string()).optional().describe('Tags written to every Reporter record of the run, e.g. {"build":"1.4.2"}.'),
  additionalAppIds: z.array(z.number().int()).optional().describe('Extra application ids installed before the tests start.'),
  provisioningProfileUuid: z.string().optional().describe('XCUITEST: provisioning profile UUID used to sign the app and test app.'),
  useTestOrchestrator: z.boolean().optional().describe('ESPRESSO: run in Android Test Orchestrator mode.'),
  clearPackageData: z.boolean().optional().describe('ESPRESSO with useTestOrchestrator: clear app data after each test.'),
};

type RunArgs = z.infer<z.ZodObject<typeof runParams>>;

function toRequest(a: RunArgs, files: { appPath?: string; testsPath?: string }): TestRunRequest {
  return {
    executionType: a.executionType,
    runningType: a.runningType ?? 'fastFeedback',
    appPath: files.appPath,
    appUrl: a.appUrl,
    cloudAppId: a.cloudAppId,
    testsPath: files.testsPath,
    testsUrl: a.testsUrl,
    cloudTestAppId: a.cloudTestAppId,
    deviceQueries: a.deviceQueries,
    maxDevices: a.maxDevices,
    minDevices: a.minDevices,
    retry: a.retry,
    retryDifferentDevice: a.retryDifferentDevice,
    overallTimeoutMs: a.overallTimeoutMs,
    reservationDurationMin: a.reservationDurationMin,
    includeTests: a.includeTests,
    runTags: a.runTags,
    additionalAppIds: a.additionalAppIds,
    provisioningProfileUuid: a.provisioningProfileUuid,
    useTestOrchestrator: a.useTestOrchestrator,
    clearPackageData: a.clearPackageData,
  };
}

function formatStatus(s: TestRunStatus): string {
  const c = s.counts;
  const n = (v: number | null) => (v == null ? '—' : String(v));
  return [
    `🧪 Test run ${s.testRunId}: ${s.state}${s.finished ? '' : ' (in progress)'}`,
    `   Total ${n(c.total)} · ✅ passed ${n(c.passed)} · ❌ failed ${n(c.failed)} · ⏭️ skipped ${n(c.skipped)} · ▶️ running ${n(c.running)} · ⏳ queued ${n(c.queued)}` +
      (c.ignored ? ` · ignored ${c.ignored}` : ''),
    ...(s.reporterLink ? [`   Reporter: ${s.reporterLink}`] : []),
    ...(s.finished
      ? ['   Each test is in the Reporter with test.run.id=' + s.testRunId + ' — use list_test_reports with that filter, then get_test_report / summarize_test_failures.']
      : ['   Poll again with get_test_run_status (waitSeconds lets the tool wait for completion).']),
  ].join('\n');
}

export function registerTestRunTools(server: McpServer): void {
  server.tool(
    'execute_test_run',
    'Run an Espresso, XCUITest or Maestro suite on cloud devices — the platform schedules, runs and reports it; no local ' +
    'Appium driver. Asynchronous: returns a testRunId immediately; follow with get_test_run_status. ' +
    'Results land in the Reporter tagged test.run.id=<id>. ' + MAESTRO_BUNDLE_NOTE + ' ' +
    'Appium/Selenium tests are NOT run this way — they run from the user\'s own machine or CI. ' + serverFsUploadNotice(),
    {
      ...runParams,
      appPath: z.string().optional().describe('Local .apk/.ipa to upload as the app under test. ' + serverFsInputParam()),
      testsPath: z
        .string()
        .optional()
        .describe('Local test bundle: the Maestro flow .zip (REQUIRED for MAESTRO), or the Espresso/XCUITest test package .zip. ' + serverFsInputParam()),
      outputFormat: outputFormatParam,
    },
    async (args) => {
      for (const p of [args.appPath, args.testsPath]) {
        if (!p) continue;
        const err = validateInputPath(p);
        if (err) return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
      }
      const request = toRequest(args, { appPath: args.appPath, testsPath: args.testsPath });
      const invalid = validateTestRunRequest(request);
      if (invalid) return { content: [{ type: 'text', text: `Error: ${invalid}` }], isError: true };
      try {
        const run = await executeTestRun(request);
        const human =
          `🚀 Test run ${run.testRunId} submitted (${request.executionType}, ${request.runningType}).\n` +
          (run.reporterLink ? `Reporter: ${run.reporterLink}\n` : '') +
          `Track it with get_test_run_status(testRunId: "${run.testRunId}", waitSeconds: 45) — repeat until finished. A one-flow Maestro run on one device took ~75 s in testing.`;
        return respond(args.outputFormat, { testRunId: run.testRunId, reporterLink: run.reporterLink, executionType: request.executionType }, human);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_test_run_status',
    'Status of a test run started with execute_test_run (or the Test Run API): state (Starting / Running / Finished / Cancelled) ' +
    'and passed/failed/skipped/running/queued counts. Pass waitSeconds to keep polling until the run finishes or the wait ' +
    'elapses (max 50 — MCP clients time tool calls out at ~60 s; call again to keep waiting). Counts can briefly be unknown mid-run.',
    {
      testRunId: z.string().describe('The Test Run Id returned by execute_test_run.'),
      waitSeconds: z.number().int().min(0).max(50).optional().describe('Poll every 10 s for up to this many seconds (max 50) until the run finishes. Default 0 (single check).'),
      outputFormat: outputFormatParam,
    },
    async ({ testRunId, waitSeconds, outputFormat }) => {
      try {
        const deadline = Date.now() + (waitSeconds ?? 0) * 1000;
        let s = await getTestRunStatus(testRunId);
        while (!s.finished && Date.now() + 10_000 <= deadline) {
          await new Promise((r) => setTimeout(r, 10_000));
          s = await getTestRunStatus(testRunId);
        }
        return respond(outputFormat, s, formatStatus(s));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'cancel_test_run',
    'Cancel every remaining test of a test run (running tests stop; not-yet-run tests are reported as skipped). ' +
    'Requires confirmDeletion: true. Cancelling a finished run is harmless.',
    {
      testRunId: z.string().describe('The Test Run Id to cancel.'),
      confirmDeletion: z.boolean().optional().describe('Must be true to cancel. Omit to preview.'),
      outputFormat: outputFormatParam,
    },
    async ({ testRunId, confirmDeletion, outputFormat }) => {
      const guard = checkDestructiveGuard(confirmDeletion, `Cancel test run ${testRunId}`);
      if (guard) return { content: [{ type: 'text', text: guard }] };
      try {
        await cancelTestRun(testRunId);
        // The state flips within seconds (verified: Starting → Cancelled in < 5 s).
        await new Promise((r) => setTimeout(r, 3000));
        const s = await getTestRunStatus(testRunId);
        return respond(outputFormat, s, `🛑 Cancel requested.\n${formatStatus(s)}`);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_test_run_command',
    'Generates a ready-to-run curl or PowerShell command that starts a test run by uploading the app and test bundle ' +
    'directly from the user\'s machine. ' + commandGeneratorNotice('execute_test_run', 'upload') + ' ' + MAESTRO_BUNDLE_NOTE + '\n\n' +
    'WARNING: The generated command embeds the active access key in plaintext. Instruct the user to run it immediately and not save or share the output.',
    {
      ...runParams,
      appPath: z.string().optional().describe('Path to the .apk/.ipa on the user\'s machine, used verbatim in the command.'),
      testsPath: z.string().optional().describe('Path to the test bundle .zip on the user\'s machine (REQUIRED for MAESTRO), used verbatim.'),
      localPlatform: z.enum(['windows', 'macos', 'linux']).describe('Platform of the machine that will run the command. ' + localPlatformParamNotice()),
      outputFormat: outputFormatParam,
    },
    async (args) => {
      const request = toRequest(args, { appPath: args.appPath, testsPath: args.testsPath });
      const invalid = validateTestRunRequest(request);
      if (invalid) return { content: [{ type: 'text', text: `Error: ${invalid}` }], isError: true };
      const files: Array<[string, string]> = [];
      if (args.appPath) files.push(['app', args.appPath]);
      if (args.testsPath) files.push([testsFieldName(request.executionType).file, args.testsPath]);
      const result = buildUploadCommand({
        path: `/api/v1/test-run/execute-test-run-async?${deviceQueriesQueryString(request.deviceQueries)}`,
        files,
        fields: testRunScalarFields(request),
        localPlatform: args.localPlatform,
        notes: ['The response contains "Test Run Id" — pass it to get_test_run_status to follow the run.'],
      });
      return respond(args.outputFormat, commandPayload(result), result.humanText);
    }
  );
}
