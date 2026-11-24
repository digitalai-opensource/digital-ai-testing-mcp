#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import dotenv from 'dotenv';

import { registerUserTools } from './tools/user-tools.js';
import { registerDeviceTools } from './tools/device-tools.js';
import { registerDeviceGroupTools } from './tools/device-group-tools.js';
import { registerReservationTools } from './tools/reservation-tools.js';
import { registerApplicationTools } from './tools/application-tools.js';
import { registerRepositoryTools } from './tools/repository-tools.js';
import { registerBrowserTools } from './tools/browser-tools.js';
import { registerProjectTools } from './tools/project-tools.js';
import { registerProvisioningProfileTools } from './tools/provisioning-profile-tools.js';
import { registerBackupTools } from './tools/backup-tools.js';
import { registerHealthTools } from './tools/health-tools.js';
import { registerReportingTools } from './tools/reporting-tools.js';
import { registerTestViewTools } from './tools/test-view-tools.js';
import { registerResources } from './tools/resources.js';
import { registerPrompts } from './tools/prompt-tools.js';
import { registerWorkflowTools } from './tools/workflow-tools.js';
import { staleBuildRemedy } from './utils/locality.js';
import { registerBoilerplateTools } from './tools/boilerplate-tools.js';
import { registerAgentTools } from './tools/agent-tools.js';
import { registerRegionTools } from './tools/region-tools.js';
import { registerNvServerTools } from './tools/nv-server-tools.js';
import { registerTransactionTools } from './tools/transaction-tools.js';
import { registerCoverageTools } from './tools/coverage-tools.js';
import { registerDebugTools } from './tools/debug-tools.js';
import { registerInspectionTools } from './tools/inspection-tools.js';
import { registerWebInspectionTools } from './tools/web-inspection-tools.js';
import { registerPerformanceTools } from './tools/performance-tools.js';
import { registerUsageReportTools } from './tools/usage-report-tools.js';
import { registerTestRunTools } from './tools/test-run-tools.js';
import { registerRemediationTools } from './tools/remediation-tools.js';
import { registerReportTools, setReportRootsProvider } from './tools/report-tools.js';
import { declaresUi, setUiCapabilityProvider } from './utils/report-view.js';
import { isDebugMode, startRemediationSession, getRemediationSession, onDebugModeChange, instrumentHandler, debugInstructions, remediationDir, canWriteLocally } from './utils/remediation.js';
import { registerMetaTools, TOOL_COUNT } from './tools/meta-tools.js';
import { makeToolsetTools } from './tools/toolset-tools.js';
import { captureRegistrations, parseToolsetSelection, registerWithToolsets, TOOLSETS, type RegisterFn, type ToolsetController } from './utils/toolsets.js';
import { setToolCatalog } from './utils/tool-catalog.js';
import { computeWorkflowReadiness } from './utils/tool-registry.js';
import { getServerVersion } from './utils/version.js';
import { getDeploymentMode } from './utils/deployment-mode.js';
import { isUpdateCheckEnabled, updateSteps, withUpdateNotice } from './utils/update-check.js';
import { withReportNotice } from './utils/report-jobs.js';
import { runUpdateCheck } from './api/update-check.js';
import { installShutdownHandlers } from './api/shutdown.js';
import { describeStartingProfile, listProfiles, startupCredentialProblem } from './utils/profile-loader.js';
import { detectSetupContext, setupGuidance, setupInstructionsBlock, setupRequiredResult } from './utils/setup-guidance.js';

// `digital-ai-testing-mcp setup …` manages the local credential store and exits (src/cli/setup.ts); anything else
// starts the server. Checked before dotenv on purpose: setup acts on the user's own shell environment, not on a .env
// file that happens to be in the current folder. Every AI client starts the server with no arguments.
if (process.argv[2] === 'setup') {
  const { runSetupCli } = await import('./cli/setup.js');
  const code = await runSetupCli(process.argv.slice(3));
  await new Promise<void>((r) => process.stdout.write('', () => r())); // flush before exiting
  process.exit(code);
}

dotenv.config({ quiet: true });

const name = process.env.MCP_SERVER_NAME ?? 'digital-ai-testing-mcp';
const version = getServerVersion();

console.error(`[${name}] v${version} starting...`);
const starting = describeStartingProfile();
console.error(
  `[${name}] Target: ${starting ? `${starting.url} (profile "${starting.name}" from ${starting.source === 'store' ? 'the credential store' : 'environment variables'})` : '(not set)'}`
);
console.error(`[${name}] Deployment mode: ${getDeploymentMode()}`);

// Missing credentials no longer stop the process (the client showed only "-32000 Failed to reconnect"). The server
// starts in setup mode: the instructions open with SETUP REQUIRED and every tool returns setup instructions for this
// kind of install instead of running (src/utils/setup-guidance.ts). Nothing calls the API in this state.
const credentialProblem = startupCredentialProblem();
const missingCredentials = credentialProblem?.missing ?? [];
const setupText = credentialProblem
  ? setupGuidance(missingCredentials, detectSetupContext(), listProfiles().filter((p) => p.source === 'env').map((p) => p.name), credentialProblem.storeNote)
  : null;
if (setupText) {
  console.error(
    `[${name}] NOT CONFIGURED: ${missingCredentials.join(', ')} not set. Starting in setup mode — every tool returns ` +
      'setup instructions. Set the variables and restart the server.'
  );
}

// Server instructions are delivered to the client at connect time — BEFORE the agent
// forms a plan — so they carry more weight than tool descriptions (which are read at
// call time, after a plan is already committed; the v43 root cause). This slot is the
// MCP's only reach into the consuming agent ahead of its first action, so it leads with
// the one policy that keeps being bypassed: never author test code from guessed selectors.
const SERVER_INSTRUCTIONS = `Digital.ai Testing — device farm, app lifecycle, reporting, and test authoring.

REPORTS: for any request for a report — test summary / test execution report, failure analysis, device health, usage summary — call create_report: one call returns the finished branded HTML file, already saved or ready to hand over. Do not assemble it from get_daily_execution_trend, summarize_test_failures or list_test_reports. If your client loads tools on demand, load create_report by name. Other data: lay it out with render_report.

TEST-AUTHORING POLICY — read this BEFORE you plan or create any test for an app:
1. Decide the mode FIRST, before calling any tool or writing any file:
   • INTERACTIVE (the default whenever intent is vague, you lack the app's source code, or the user says anything like "let's decide as we go"): call start_inspection_session, capture REAL element IDs via get_element_tree / open_mobile_studio, and build steps from those.
   • AUTONOMOUS (only when intent is step-specific AND you already have a real selector source — captured inspection IDs, or authoritative app source in the workspace): use get_test_boilerplate. It returns NO runnable code for a real app unless a live inspection session exists or you pass confirmSelectorsVerified:true.
2. PROHIBITED, regardless of how the request is phrased: hand-writing or generating a test file with invented or placeholder element IDs (e.g. nav_catalog, home_container), guessed XPaths, or fabricated credentials, and presenting it as a finished test. A test built without real, inspection-sourced (or source-derived) selectors is non-functional — do not deliver it. Writing the file yourself instead of calling get_test_boilerplate does NOT exempt you from this.
3. If you have no selector source, you are in INTERACTIVE mode by definition — start_inspection_session first. If you are unsure which mode the user wants, ASK before calling any tool. A test-type label picked from a menu ("login test", "smoke", "e2e") is a category, not a specification.
4. Before you present or save ANY test — generated here OR written by hand — run validate_test_script on it. If it flags placeholder selectors, a scaffold fail-guard, or placeholder credentials, the test is not runnable; fix it before delivering.
5. EXCEPTION — the ExperiBank demo app (com.experitest.ExperiBank, "SeeTestDemoApp" in the repository): get_test_boilerplate called WITHOUT appId / packageName / bundleIdentifier returns a runnable ExperiBank test whose steps are already verified. No inspection is needed for it; use that for "a test for the demo / ExperiBank app".
6. TELEPHONY (two-phone calls, SMS, MMS, call audio): no template here — start from the reference project https://github.com/dai-continuous-testing/UseCase-SIM-Card-Tests and tell the user about it.
7. LOCATORS AND WAITS: pick the strategy by this ladder, from the attributes get_element_tree / find_elements actually show. Android: resource-id → accessibility id (content-desc) → @text XPath. iOS: accessibility id (= the name attribute: identifier, else label — the same match as //*[@name=…] XPath without the tree walk) → -ios predicate string on type/label (Appium Server only) → attribute XPath. Never index XPath ([1], [2]), never Thread.sleep/time.sleep/pause: every step waits explicitly for its element (the generated templates' find() helper). Do not add an implicit wait next to explicit waits. A screen that is really web content (no native ids, a WebView in the tree) is driven through webview_context (list → switch → css selector finds → native) on Appium Server projects.

APP NOT IN REPOSITORY: When list_applications returns 0 results for a requested app, ask the user: "That app isn't in the Digital.ai repository. If it's available on the Google Play Store or Apple App Store, I can install it directly onto a farm device. Would you like to do that?" If yes — Android: (1) start_inspection_session (no appId); (2) app_control(action:"deep_link", url:"market://details?id=<packageName>") — opens Play Store to the install page (returns 500 but succeeds on-device — ignore the error, take a screenshot to verify); (3) take_inspection_screenshot; (4) find_elements(xpath, "//*[@content-desc='Install']") + tap_element — no auth prompt, Google account handles it silently. iOS: (1) start_inspection_session (no appId); (2) launch_app(packageName:"com.apple.AppStore") — itms-apps:// URL schemes are NOT supported on Grid iOS (returns 500); (3) take_inspection_screenshot — if a consent/onboarding screen appears with disabled buttons, stop the session and use open_mobile_studio for manual interaction; (4) user taps GET manually (Face ID/Touch ID cannot be automated). Note: this installs on one device only — the app is not added to the repository.
GENERAL: credentials and base URL come from the active profile (switch_environment changes it — never read them from env). Destructive tools require confirmDeletion:true.
API BEHAVIOR — critical facts for device, reporter, and application tools:
DEVICE QUERIES: Use displayStatus (not currentStatus) for availability — currentStatus only returns online/offline/error, never "Available". @category must be UPPERCASE ('PHONE', 'TABLET', 'WATCH', 'FOLDABLE' — foldables are not in PHONE). @version requires decimal ('14.0' not '14'). These fields silently return empty results — never use in queries, filter client-side instead: @manufacturer, @tag, @deviceName, @id, @udid, @status, @available, @agentName, @pool, @project, @isEmulator.
REPORTER: List results use snake_case (test_id, start_time). CSRF-blocked filter properties (return 401): start_time, create_time, uuid. CSRF-blocked operators: !=, like, startsWith, in. Use projectName (never projectId — CSRF-blocked on reporter endpoints) to scope reporter calls to a project. Reporter deletes: Cloud Admin always; project-level keys only when the project's allowUsersDeleteTests setting is on (the tools refuse up front otherwise). For "most recent" queries use find_latest_test_for_name or list_active_test_executions. get_grouped_test_reports requires groupBy field (not keys — keys is silently ignored). Transaction and performance tools work for all access levels; project keys see only their own project's transactions.
APPLICATIONS: applicationName filter param is silently ignored — use the nameContains tool param for client-side filtering instead.
RESERVATIONS: project= causes 400; deviceUid= causes 400 — use projectId= and deviceId= instead.
DATES: Reservation and provisioning-profile dates are MM/DD/YYYY HH:mm:ss (not ISO 8601) — use the tool's dedicated date parser, not new Date().
SLOW TOOLS (avoid in loops): get_environment_summary, get_transaction_performance_summary, get_performance_trend, get_daily_execution_trend.
ACCESS LEVEL: never infer privilege from key format. A Cloud Admin may hold either a long eyJ... key or a short aut_1_... key. The real level (Cloud Admin / Project Admin / Project User) is detected from the API — read it from get_server_info or list_environments before telling the user what they can or cannot do.

PROJECT CONTEXT: each Project Admin / Project User key is scoped to exactly one project — there is no API call to change project within the same key. "Switch projects", "change project context", "use a different project", or "access project X" all mean switch_environment to the profile holding that project's key. Use list_environments to show available profiles.`;

const debugMode = isDebugMode();
const server = new McpServer({ name, version }, // Debug block goes FIRST: clients truncate long instructions, and at the end it was the part that got cut (2026-10-10).
  // Setup mode puts its block before everything, for the same reason.
  { instructions: (setupText ? setupInstructionsBlock(missingCredentials) : '') + (debugMode ? debugInstructions() : '') + SERVER_INSTRUCTIONS });

// Capture every module first, then register through the toolset layer (src/utils/toolsets.ts), which also applies
// strict input schemas and annotations. With MCP_TOOLSETS unset this registers everything in full; with it set, tools outside the chosen toolsets become
// self-loading placeholders — every name still exists, so no description, prompt or instruction points at a missing tool.
let toolsetController: ToolsetController | undefined;
const modules: Array<[string, RegisterFn]> = [
  ['users', registerUserTools],
  ['devices', registerDeviceTools],
  ['device-groups', registerDeviceGroupTools],
  ['reservations', registerReservationTools],
  ['applications', registerApplicationTools],
  ['repository', registerRepositoryTools],
  ['browsers', registerBrowserTools],
  ['projects', registerProjectTools],
  ['provisioning-profiles', registerProvisioningProfileTools],
  ['backup', registerBackupTools],
  ['health', registerHealthTools],
  ['reporting', registerReportingTools],
  ['test-views', registerTestViewTools],
  ['resources', registerResources],
  ['prompts', registerPrompts],
  ['workflows', registerWorkflowTools],
  ['boilerplate', registerBoilerplateTools],
  ['agents', registerAgentTools],
  ['regions', registerRegionTools],
  ['nv-servers', registerNvServerTools],
  ['transactions', registerTransactionTools],
  ['coverage', registerCoverageTools],
  ['debug', registerDebugTools],
  ['inspection', registerInspectionTools],
  ['web-inspection', registerWebInspectionTools],
  ['performance', registerPerformanceTools],
  ['usage-reports', registerUsageReportTools],
  ['test-runs', registerTestRunTools],
  ['remediation', registerRemediationTools], // set_debug_mode, record_remediation_note (records only while debug mode is on)
  ['report', registerReportTools], // render_report — core: reports come from every toolset
  ['meta', registerMetaTools],
  ['toolsets', makeToolsetTools(() => toolsetController)],
];
const toolsetSelection = parseToolsetSelection(process.env.MCP_TOOLSETS);
if (toolsetSelection.unknown.length > 0) {
  console.error(`[${name}] ⚠️  MCP_TOOLSETS: unknown toolset(s) ignored: ${toolsetSelection.unknown.join(', ')} (valid: ${Object.keys(TOOLSETS).join(', ')}, core, all)`);
}
// Debug mode (MCP_DEBUG_MODE=true, or set_debug_mode for this run): every tool and placeholder is instrumented for
// the remediation event log. The wrapper is always installed (debug mode can be turned on mid-run); off, it calls the
// tool directly — instrumentHandler checks the mode on every call.
// The client's workspace folders. Only clients that declare the roots capability answer (Claude Code does).
async function clientRoots(): Promise<string[]> {
  if (!server.server.getClientCapabilities()?.roots) return [];
  const { roots } = await server.server.listRoots(undefined, { timeout: 3000 });
  return roots.map((r) => r.uri);
}
// Finished reports go to a folder the client shares with the conversation when there is one (see report-tools.ts).
setReportRootsProvider(clientRoots);
// Whether the client renders MCP Apps views: a finished report is then shown inline (utils/report-view.ts).
setUiCapabilityProvider(() => declaresUi(server.server.getClientCapabilities()));
function startDebugSession(): void {
  if (getRemediationSession()) return; // turned off and on again: the same session continues
  const s = startRemediationSession({
    mcpVersion: version,
    toolsets: process.env.MCP_TOOLSETS || 'all',
    client: () => server.server.getClientVersion(),
    // The client's workspace folders — where the remediation/ folder goes.
    roots: clientRoots,
  });
  console.error(
    `[${name}] Debug mode ON — remediation session ${s.id}: ` +
      (canWriteLocally()
        ? `notes and event log go to remediation/ in the client's project (resolved on first use; current guess ${remediationDir()}).`
        : "notes are returned to the agent to save in its project's remediation/ folder (server is not on the user's machine).")
  );
}
if (debugMode) startDebugSession();
const captured = captureRegistrations(modules);
setToolCatalog(captured.tools); // get_server_info reports real per-area counts from this
// Update check (on unless MCP_UPDATE_CHECK=false): the first successful tool result after a newer release was found
// carries a notice, at most once a day. Placeholders are skipped (their reply is guidance for the next call), and the
// notice goes OUTSIDE the debug instrumentation so the event log measures the tool's own response.
// With the update check off, the only wrapper is the background-report notice, which returns a result unchanged while no job exists.
const updateCheck = isUpdateCheckEnabled();
// Setup mode: every tool (and placeholder) keeps its name and schema but answers with the setup instructions.
const setupModeHandler = setupText ? () => setupRequiredResult(setupText) : undefined;
const controller = registerWithToolsets(
  server,
  captured,
  toolsetSelection,
  setupModeHandler
    ? () => setupModeHandler
    : (tool, callback, placeholder) => {
        const handler = instrumentHandler(tool, callback, { placeholder });
        if (placeholder) return handler;
        // A finished background report is announced first in the next result of ANY tool (the server cannot start a turn).
        const withJobs = withReportNotice(handler);
        return updateCheck ? withUpdateNotice(withJobs) : withJobs;
      }
);
// set_debug_mode turned it on mid-run: start the remediation session. record_remediation_note stays listed either way
// (Claude Desktop does not reload the tool list on tools/list_changed — 2.4.6-beta.1, 2026-11-22).
onDebugModeChange((on) => {
  if (on) startDebugSession();
  console.error(`[${name}] Debug mode turned ${on ? 'ON' : 'OFF'} with set_debug_mode (until restart).`);
});
if (!toolsetSelection.all) {
  toolsetController = controller;
  console.error(`[${name}] Toolsets loaded in full: ${controller.loaded().join(', ') || '(core only)'} — the rest are self-loading placeholders.`);
}

console.error(`[${name}] All tool modules registered (${TOOL_COUNT} tools + 2 resources + 7 prompts).`);

// Startup parity check: verify all workflow dependency tools are actually registered.
// A missing tool here means a module failed to load — the build/image is stale and needs rebuilding.
const workflowReadiness = computeWorkflowReadiness(server);
const degradedWorkflows = Object.entries(workflowReadiness).filter(([, s]) => !s.ready);
if (degradedWorkflows.length > 0) {
  for (const [wf, status] of degradedWorkflows) {
    const missing = [...status.missingRead, ...status.missingWrite];
    if (!status.workflowPresent) missing.unshift(`${wf} (workflow tool itself)`);
    console.error(`[${name}] ⚠️  DEGRADED: ${wf} — missing: ${missing.join(', ')}`);
  }
  console.error(`[${name}] To restore full workflow capability: ${staleBuildRemedy()}`);
} else {
  console.error(`[${name}] Workflow readiness: all workflows ready ✓`);
}
console.error(`[${name}] Ready.`);
// Note: create_poc is registered as both a tool (universal client support) and a prompt (prompt-aware clients).

// Open sessions are quit before exiting (device released, report cleaned up) — src/api/shutdown.ts.
installShutdownHandlers(name);

// Asks GitHub for the newest release at most once per 24 h (src/api/update-check.ts). Not awaited: startup never waits
// for it, and it never throws.
if (updateCheck) {
  void runUpdateCheck({ current: version }).then((r) => {
    if (r.updateAvailable) console.error(`[${name}] Update available: v${r.latest} (running v${r.current}). ${updateSteps()}`);
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
