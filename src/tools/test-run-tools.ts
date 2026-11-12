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
import { checkDestructiveGuard } from '../utils/destructive-guard.js';
import { buildUploadCommand } from '../utils/upload-command.js';
import { serverFsUploadNotice, serverFsInputParam, serverFsOutputParam, commandGeneratorNotice, localPlatformParamNotice } from '../utils/locality.js';
import { outputFormatParam, respond } from '../utils/output-format.js';
import { commandPayload } from '../utils/command-payload.js';
import AdmZip from 'adm-zip';
import { listActiveSessions } from '../api/webdriver.js';
import { detectFabricationIssues } from './boilerplate-tools.js';
import { validateInputPath, validateOutputPath } from '../utils/path-guard.js';
import { caseInsensitiveEnum } from '../utils/schema.js';
import { MAESTRO_ACTIONS, buildMaestroFlowYaml, validateMaestroFlow, bareIdWarnings, flowFileName, type MaestroFlowSpec } from '../utils/maestro-flow.js';
import { writeFileSync } from 'fs';
import {
  PLAYWRIGHT_BROWSERS,
  type PlaywrightBrowser,
  isPlaywrightRunId,
  loadPlaywrightProject,
  buildPlaywrightConf,
  executePlaywrightRun,
  getPlaywrightRunStatus,
  cancelPlaywrightRun,
  downloadPlaywrightLogs,
} from '../api/playwright-runs.js';

const MAESTRO_BUNDLE_NOTE =
  'Maestro bundle = a .zip with a flows/ directory of .yaml flows (the platform rejects a bundle without flows/); ' +
  'an optional config.yaml and utils/ may sit alongside. Android only. Build flows from element IDs captured live ' +
  '(start_inspection_session → get_element_tree) — never guessed IDs. generate_maestro_flow builds the YAML and the bundle.';

/** `'["a","b"]'` → `["a","b"]`, `"a"` → `["a"]`; arrays and anything else pass through untouched. */
function parseStringArray(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t.startsWith('[')) { try { return JSON.parse(t); } catch { return v; } }
  return [v];
}

/**
 * Integer that also accepts a numeric STRING ("123" — agents without a refreshed schema send ids as text). Unlike
 * z.coerce.number(), null / booleans / "" stay invalid: coerce turned `cloudAppId: null` into 0, which then counted as
 * an app source and was sent to the platform as cloudApp=0.
 */
function intParam(min?: number) {
  const base = z.number().int();
  return z.preprocess((v) => (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? Number(v) : v), min === undefined ? base : base.min(min));
}

// Shared by execute_test_run and get_test_run_command — one schema, so the two cannot drift.
const runParams = {
  executionType: caseInsensitiveEnum(TEST_RUN_EXECUTION_TYPES).describe('ESPRESSO (Android instrumentation), XCUITEST (iOS) or MAESTRO (Android flows).'),
  runningType: caseInsensitiveEnum(TEST_RUN_RUNNING_TYPES, { default: 'fastFeedback' })
    .describe('fastFeedback (default): spread the tests across up to maxDevices devices matching ONE deviceQuery. coverage: run every test on one device per deviceQuery.'),
  cloudAppId: intParam().optional().describe('Numeric application id from list_applications (NOT the app name — a name is rejected). One app source is required.'),
  appUrl: z.string().optional().describe('URL of the application under test. One app source is required.'),
  testsUrl: z.string().optional().describe('ESPRESSO/XCUITEST only: URL of the test package (Espresso: the androidTest .apk). One test source is required.'),
  cloudTestAppId: z.number().int().optional().describe('ESPRESSO/XCUITEST only: numeric id of the test package in the file repository.'),
  // Without a refreshed schema (MCP_TOOLSETS placeholder) agents send this as a JSON string or a bare query — accept both.
  deviceQueries: z
    .preprocess(parseStringArray, z.array(z.string()).min(1))
    .describe("Device queries, e.g. [\"@os='android' and @category='PHONE'\"]. fastFeedback takes exactly one. Add @region from find_available_device to avoid unhealthy regions."),
  maxDevices: intParam(1).optional().describe('fastFeedback: maximum devices to use (recommended — the default is the license maximum).'),
  minDevices: intParam(1).optional().describe('fastFeedback: minimum devices (default 1).'),
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
  useUIAutomator: z
    .boolean()
    .optional()
    .describe(
      'ESPRESSO: set true when the test package uses UiAutomator (androidx.test.uiautomator) — without it those tests fail ' +
      'with "UiAutomationService ... already registered" (verified live). UiAutomator is also how to drive preinstalled ' +
      'apps (Settings, Messages): Espresso can only instrument an app signed with the same key as the test APK.'
    ),
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
    useUIAutomator: a.useUIAutomator,
  };
}

function formatStatus(s: TestRunStatus): string {
  const c = s.counts;
  const n = (v: number | null | undefined) => (v == null ? '—' : String(v));
  if (s.kind === 'playwright') {
    return [
      `🎭 Playwright run ${s.testRunId}: ${s.state}${s.finished ? '' : ' (in progress)'}`,
      `   Browsers: requested ${n(c.requested)} · completed ${n(s.browsersCompleted)} · ▶️ running ${n(c.running)} · ⏳ queued ${n(c.queued)}`,
      ...(s.queueReason ? [`   Queued because: ${s.queueReason}` +
        (/licen[cs]e/i.test(s.queueReason) ? ' — the cloud has no free Playwright (Cross Browser) license; a cloud admin must free or add capacity. cancel_test_run if it should not wait.' : '')] : []),
      ...(s.reporterLink ? [`   Reporter: ${s.reporterLink}`] : []),
      ...(s.finished
        ? [`   Results are in the Reporter with test.run.id=${s.testRunId}; logsPath on get_test_run_status downloads the run's logs (zip).`]
        : ['   Poll again with get_test_run_status (waitSeconds lets the tool wait for completion).']),
    ].join('\n');
  }
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
        .describe('Local test bundle: the Maestro flow .zip (REQUIRED for MAESTRO), the Espresso androidTest .apk (e.g. app-debug-androidTest.apk), or the XCUITest test runner package. ' + serverFsInputParam()),
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
    'elapses (max 50 — MCP clients time tool calls out at ~60 s; call again to keep waiting). Counts can briefly be unknown mid-run. ' +
    'Also takes a Playwright run id (a UUID from execute_playwright_run): state (QUEUED / RUNNING / CANCELED …), browser ' +
    'counts and the queue reason; logsPath saves that run\'s logs zip.',
    {
      testRunId: z.string().describe('The Test Run Id returned by execute_test_run or execute_playwright_run.'),
      waitSeconds: z.number().int().min(0).max(50).optional().describe('Poll every 10 s for up to this many seconds (max 50) until the run finishes. Default 0 (single check).'),
      logsPath: z.string().optional().describe('Playwright runs only: save the run\'s logs (.zip) here. ' + serverFsOutputParam()),
      outputFormat: outputFormatParam,
    },
    async ({ testRunId, waitSeconds, logsPath, outputFormat }) => {
      const playwright = isPlaywrightRunId(testRunId);
      if (logsPath) {
        if (!playwright) return { content: [{ type: 'text', text: 'Error: logsPath is for Playwright runs (UUID ids) only.' }], isError: true };
        const pathErr = validateOutputPath(logsPath);
        if (pathErr) return { content: [{ type: 'text', text: `Error: ${pathErr}` }], isError: true };
      }
      const fetchStatus = (id: string) => (playwright ? getPlaywrightRunStatus(id) : getTestRunStatus(id));
      try {
        const deadline = Date.now() + (waitSeconds ?? 0) * 1000;
        let s = await fetchStatus(testRunId);
        while (!s.finished && Date.now() + 10_000 <= deadline) {
          await new Promise((r) => setTimeout(r, 10_000));
          s = await fetchStatus(testRunId);
        }
        if (logsPath) {
          const logs = await downloadPlaywrightLogs(testRunId);
          writeFileSync(logsPath, logs);
          const entries = (() => { try { return new AdmZip(logs).getEntries().filter((e) => !e.isDirectory).length; } catch { return null; } })();
          const note = `Logs: ${logs.length} bytes written to ${logsPath}${entries === 0 ? ' (empty — the run produced no logs, e.g. it never started)' : entries != null ? ` (${entries} file${entries === 1 ? '' : 's'})` : ''}.`;
          return respond(outputFormat, { ...s, logsPath, logsBytes: logs.length, logFiles: entries }, `${formatStatus(s)}\n   ${note}`);
        }
        return respond(outputFormat, s, formatStatus(s));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'cancel_test_run',
    'Cancel every remaining test of a test run (running tests stop; not-yet-run tests are reported as skipped), or a ' +
    'Playwright run (UUID id from execute_playwright_run). ' +
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
        if (isPlaywrightRunId(testRunId)) {
          const answer = await cancelPlaywrightRun(testRunId);
          const s = await getPlaywrightRunStatus(testRunId);
          return respond(outputFormat, { ...s, platformAnswer: answer }, `🛑 Cancel requested${/already canceled/i.test(answer) ? ' — the run was already canceled' : ''}.\n${formatStatus(s)}`);
        }
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
    'execute_playwright_run',
    'Run a Playwright Test project on the Digital.ai cloud (Execution Service): the platform runs the whole project in ' +
    'Microsoft\'s Playwright container image (chromium, firefox, webkit) and reports each test to the Reporter under ' +
    'test.run.id=<run id>. Asynchronous — returns a run id (UUID) at once; follow with get_test_run_status, cancel with ' +
    'cancel_test_run. Needs a Cross Browser license on a Digital.ai-hosted (SaaS) cloud: if the run stays QUEUED with ' +
    '"Waiting for licenses", no Playwright capacity is free — tell the user rather than waiting. ' +
    'projectPath is the project folder (zipped here without node_modules, reports, .git or credential files) or a .zip ' +
    'of it. With a playwright.config.* its projects choose the browsers; otherwise pass browsers. ' + serverFsUploadNotice(),
    {
      projectPath: z.string().describe('Playwright project folder or .zip (tests plus optional playwright.config.* and package.json). ' + serverFsInputParam()),
      imageVersion: z
        .string()
        .optional()
        .describe('Playwright version of the container image, e.g. "1.49.0" (any tag of mcr.microsoft.com/playwright; an unknown one is rejected at once). Default: the @playwright/test version in the project\'s package.json.'),
      browsers: z
        .preprocess(parseStringArray, z.array(z.enum(PLAYWRIGHT_BROWSERS)).min(1))
        .optional()
        .describe('chromium, firefox and/or webkit — one run per browser. Required when the project has no playwright.config.*; overrides the config\'s projects otherwise.'),
      outputFormat: outputFormatParam,
    },
    async (args) => {
      const pathErr = validateInputPath(args.projectPath);
      if (pathErr) return { content: [{ type: 'text', text: `Error: ${pathErr}` }], isError: true };
      let project;
      try {
        project = loadPlaywrightProject(args.projectPath);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
      if (project.specCount === 0 && !project.hasConfig) {
        return { content: [{ type: 'text', text: `Error: no Playwright tests found in ${args.projectPath} (no *.spec.* / *.test.* files and no playwright.config.*). Files: ${project.files.slice(0, 15).join(', ') || '(none)'}.` }], isError: true };
      }
      const imageVersion = args.imageVersion ?? project.detectedVersion;
      if (!imageVersion) {
        return { content: [{ type: 'text', text: 'Error: pass imageVersion (e.g. "1.49.0") — the project has no package.json with an exact @playwright/test version to take it from. Use the version the tests are written for.' }], isError: true };
      }
      const conf = buildPlaywrightConf(project, imageVersion, args.browsers as PlaywrightBrowser[] | undefined);
      if (typeof conf === 'string') return { content: [{ type: 'text', text: `Error: ${conf}` }], isError: true };
      try {
        const run = await executePlaywrightRun(project, conf);
        const browsersText = conf.browsers.map((b) => b.browser ?? 'config projects').join(', ');
        const human =
          `🎭 Playwright run ${run.testRunId} submitted (${browsersText}, image ${imageVersion}; ${project.specCount} spec file${project.specCount === 1 ? '' : 's'}, ${Math.round(project.zip.length / 1024)} KB` +
          (project.skipped.length ? `; not uploaded: ${project.skipped.slice(0, 6).join(', ')}${project.skipped.length > 6 ? ' …' : ''}` : '') + `).\n` +
          (run.reporterLink ? `Reporter: ${run.reporterLink}\n` : '') +
          `Track it with get_test_run_status(testRunId: "${run.testRunId}", waitSeconds: 45).`;
        return respond(args.outputFormat, {
          testRunId: run.testRunId, reporterLink: run.reporterLink, kind: 'playwright', imageVersion,
          imageVersionSource: args.imageVersion ? 'argument' : 'package.json', conf, specFiles: project.specCount, uploadedBytes: project.zip.length, notUploaded: project.skipped,
        }, human);
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

  // ── generate_maestro_flow ───────────────────────────────────────────────────
  // Same selector rule as get_test_boilerplate: a flow for a real app is only emitted while a live Android inspection
  // session exists, or when the caller asserts the selectors were captured elsewhere (confirmSelectorsVerified).
  server.tool(
    'generate_maestro_flow',
    'Build a Maestro flow (YAML) for an Android app from structured steps, and optionally write a ready-to-run bundle ' +
    '(.zip with flows/<name>.yaml) for execute_test_run (executionType MAESTRO, testsPath = the bundle). ' +
    'Steps use element IDs captured live (start_inspection_session → get_element_tree, full "pkg:id/name" resource-ids) ' +
    'or visible text — never guessed IDs. Without a live Android inspection session the tool returns NO flow unless ' +
    'confirmSelectorsVerified is true. Android only.',
    {
      appId: z.string().describe('Android package name, e.g. "com.experitest.ExperiBank".'),
      flowName: z.string().optional().describe('Flow name (also the file name, e.g. "Login smoke" → flows/login_smoke.yaml).'),
      tags: z.array(z.string()).optional().describe('Maestro tags, e.g. ["smoke"].'),
      steps: z
        .array(
          z.object({
            action: z.enum(MAESTRO_ACTIONS).describe('Maestro command.'),
            id: z.string().optional().describe('Element resource-id — the FULL "pkg:id/name" from get_element_tree. For inputText: the field to tap first.'),
            text: z.string().optional().describe('Element visible text (tapOn/assert*/scrollUntilVisible), or the value to type (inputText).'),
            clearState: z.boolean().optional().describe('launchApp: clear app data first.'),
            direction: z.enum(['UP', 'DOWN', 'LEFT', 'RIGHT']).optional().describe('scrollUntilVisible (default DOWN) / swipe.'),
            value: z.string().optional().describe('pressKey: key name ("Enter", "Home"); takeScreenshot: file name; eraseText: character count.'),
            optional: z.boolean().optional().describe('Continue the flow if this step fails.'),
          })
        )
        .min(1)
        .describe('Ordered steps. Typical: launchApp (clearState) → inputText with id → tapOn → assertVisible.'),
      bundlePath: z.string().optional().describe('Where to write the bundle .zip for execute_test_run. Omit to get the YAML only. ' + serverFsOutputParam()),
      confirmSelectorsVerified: z
        .boolean()
        .optional()
        .describe(
          'Set true ONLY if every id/text in the steps was captured from the real app outside a still-open session (rdb/UIAutomator ' +
          'dump, open_mobile_studio, a since-closed inspection session, or authoritative app source). Never for guessed IDs.'
        ),
      outputFormat: outputFormatParam,
    },
    async (args) => {
      const liveAndroid = listActiveSessions().some((s) => s.platform === 'android');
      if (!liveAndroid && args.confirmSelectorsVerified !== true) {
        const blocked = {
          status: 'blocked',
          reason: 'no_verified_selectors',
          requiredAction: 'start_inspection_session',
          message: 'No Maestro flow generated: there is no live Android inspection session and the selectors are not confirmed as captured from the real app.',
          howToProceed: [
            'PREFERRED: start_inspection_session(platform: "android"), capture the real resource-ids with get_element_tree, then re-call while it is open.',
            'ALTERNATIVE: if you already captured them elsewhere (rdb/UIAutomator dump, open_mobile_studio, authoritative source), re-call with confirmSelectorsVerified: true.',
          ],
        };
        return { content: [{ type: 'text', text: args.outputFormat === 'human' ? `⛔ ${blocked.message}\n- ${blocked.howToProceed.join('\n- ')}` : JSON.stringify(blocked, null, 2) }], isError: true };
      }

      const spec: MaestroFlowSpec = { appId: args.appId, name: args.flowName, tags: args.tags, steps: args.steps };
      const errors = validateMaestroFlow(spec);
      if (errors.length) return { content: [{ type: 'text', text: `Error: the flow is not valid:\n- ${errors.join('\n- ')}` }], isError: true };

      const yaml = buildMaestroFlowYaml(spec);
      const fabricated = detectFabricationIssues(yaml).filter((i) => i.severity === 'high');
      if (fabricated.length) {
        return {
          content: [{ type: 'text', text: `Error: the steps contain placeholders, not real selectors — no flow generated:\n- ${fabricated.map((i) => `${i.label}: ${i.detail}`).join('\n- ')}` }],
          isError: true,
        };
      }

      const file = flowFileName(args.flowName);
      const warnings = bareIdWarnings(spec);
      let written: string | null = null;
      if (args.bundlePath) {
        if (!/\.zip$/i.test(args.bundlePath)) return { content: [{ type: 'text', text: 'Error: bundlePath must end in .zip.' }], isError: true };
        const pathErr = validateOutputPath(args.bundlePath);
        if (pathErr) return { content: [{ type: 'text', text: `Error: ${pathErr}` }], isError: true };
        try {
          const zip = new AdmZip();
          zip.addFile(`flows/${file}`, Buffer.from(yaml, 'utf8'));
          zip.writeZip(args.bundlePath);
          written = args.bundlePath;
        } catch (e) {
          return { content: [{ type: 'text', text: `Error: could not write the bundle: ${(e as Error).message}` }], isError: true };
        }
      }

      const next = written
        ? `execute_test_run(executionType: "MAESTRO", testsPath: "${written}", cloudAppId: <id from list_applications for ${args.appId}>, deviceQueries: ["@os='android'"])`
        : 'pass bundlePath to write a runnable bundle, or zip it yourself as flows/' + file;
      const human = [
        `🎼 Maestro flow flows/${file} (${args.steps.length} step${args.steps.length === 1 ? '' : 's'})${written ? ` — bundle written to ${written}` : ''}`,
        ...(warnings.length ? ['', '⚠️ ' + warnings.join('\n⚠️ ')] : []),
        '',
        '```yaml',
        yaml.trimEnd(),
        '```',
        '',
        `Next: ${next}`,
      ].join('\n');
      return respond(args.outputFormat, { flowFile: `flows/${file}`, yaml, bundlePath: written, warnings, nextStep: next }, human);
    }
  );
}
