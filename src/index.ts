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
import { registerBoilerplateTools } from './tools/boilerplate-tools.js';
import { registerAgentTools } from './tools/agent-tools.js';
import { registerRegionTools } from './tools/region-tools.js';
import { registerNvServerTools } from './tools/nv-server-tools.js';
import { registerTransactionTools } from './tools/transaction-tools.js';
import { registerCoverageTools } from './tools/coverage-tools.js';
import { registerDebugTools } from './tools/debug-tools.js';
import { registerInspectionTools } from './tools/inspection-tools.js';
import { registerPerformanceTools } from './tools/performance-tools.js';
import { registerMetaTools, TOOL_COUNT } from './tools/meta-tools.js';
import { computeWorkflowReadiness } from './utils/tool-registry.js';
import { getServerVersion } from './utils/version.js';

dotenv.config({ quiet: true });

const REQUIRED_ENV = ['DIGITAL_AI_BASE_URL', 'DIGITAL_AI_ACCESS_KEY'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(
    `[digital-ai-mcp] FATAL: Missing required environment variables: ${missing.join(', ')}`
  );
  console.error(
    `[digital-ai-mcp] Copy .env.example to .env and fill in the required values.`
  );
  process.exit(1);
}

const name = process.env.MCP_SERVER_NAME ?? 'digital-ai-testing-mcp';
const version = getServerVersion();

console.error(`[${name}] v${version} starting...`);
console.error(`[${name}] Target: ${process.env.DIGITAL_AI_BASE_URL}`);

// Server instructions are delivered to the client at connect time — BEFORE the agent
// forms a plan — so they carry more weight than tool descriptions (which are read at
// call time, after a plan is already committed; the v43 root cause). This slot is the
// MCP's only reach into the consuming agent ahead of its first action, so it leads with
// the one policy that keeps being bypassed: never author test code from guessed selectors.
const SERVER_INSTRUCTIONS = `Digital.ai Continuous Testing — device farm, app lifecycle, reporting, and test authoring.

TEST-AUTHORING POLICY — read this BEFORE you plan or create any test for an app:
1. Decide the mode FIRST, before calling any tool or writing any file:
   • INTERACTIVE (the default whenever intent is vague, you lack the app's source code, or the user says anything like "let's decide as we go"): call start_inspection_session, capture REAL element IDs via get_element_tree / open_mobile_studio, and build steps from those.
   • AUTONOMOUS (only when intent is step-specific AND you already have a real selector source — captured inspection IDs, or authoritative app source in the workspace): use get_test_boilerplate. It returns NO runnable code for a real app unless a live inspection session exists or you pass confirmSelectorsVerified:true.
2. PROHIBITED, regardless of how the request is phrased: hand-writing or generating a test file with invented or placeholder element IDs (e.g. nav_catalog, home_container), guessed XPaths, or fabricated credentials, and presenting it as a finished test. A test built without real, inspection-sourced (or source-derived) selectors is non-functional — do not deliver it. Writing the file yourself instead of calling get_test_boilerplate does NOT exempt you from this.
3. If you have no selector source, you are in INTERACTIVE mode by definition — start_inspection_session first. If you are unsure which mode the user wants, ASK before calling any tool. A test-type label picked from a menu ("login test", "smoke", "e2e") is a category, not a specification.
4. Before you present or save ANY test — generated here OR written by hand — run validate_test_script on it. If it flags placeholder selectors, a scaffold fail-guard, or placeholder credentials, the test is not runnable; fix it before delivering.

GENERAL: credentials and base URL come from the active profile (switch_environment changes it — never read them from env). Destructive tools require confirmDeletion:true. Reporter delete tools are Cloud Admin only — project-level keys (Project Admin and Project User) are CSRF-blocked. Transaction and performance tools work for all access levels; project-level keys see only their own project's data.
PROJECT CONTEXT: each project-level key (Project Admin or Project User, prefixed aut_1_...) is scoped to exactly one project — there is no API call to change project within the same key. "Switch projects", "change project context", "use a different project", or "access project X" all mean switch_environment to the profile holding that project's key. Use list_environments to show available profiles.`;

const server = new McpServer({ name, version }, { instructions: SERVER_INSTRUCTIONS });

registerUserTools(server);
registerDeviceTools(server);
registerDeviceGroupTools(server);
registerReservationTools(server);
registerApplicationTools(server);
registerRepositoryTools(server);
registerBrowserTools(server);
registerProjectTools(server);
registerProvisioningProfileTools(server);
registerBackupTools(server);
registerHealthTools(server);
registerReportingTools(server);
registerTestViewTools(server);
registerResources(server);
registerPrompts(server);
registerWorkflowTools(server);
registerBoilerplateTools(server);
registerAgentTools(server);
registerRegionTools(server);
registerNvServerTools(server);
registerTransactionTools(server);
registerCoverageTools(server);
registerDebugTools(server);
registerInspectionTools(server);
registerPerformanceTools(server);
registerMetaTools(server);

console.error(`[${name}] All tool modules registered (${TOOL_COUNT} tools + 2 resources + 6 prompts).`);

// Startup parity check: verify all workflow dependency tools are actually registered.
// A missing tool here means a module failed to load — the image needs to be rebuilt.
const workflowReadiness = computeWorkflowReadiness(server);
const degradedWorkflows = Object.entries(workflowReadiness).filter(([, s]) => !s.ready);
if (degradedWorkflows.length > 0) {
  for (const [wf, status] of degradedWorkflows) {
    const missing = [...status.missingRead, ...status.missingWrite];
    if (!status.workflowPresent) missing.unshift(`${wf} (workflow tool itself)`);
    console.error(`[${name}] ⚠️  DEGRADED: ${wf} — missing: ${missing.join(', ')}`);
  }
  console.error(`[${name}] Rebuild the image to restore full workflow capability: docker build -t digital-ai-testing-mcp:latest .`);
} else {
  console.error(`[${name}] Workflow readiness: all workflows ready ✓`);
}
console.error(`[${name}] Ready.`);
// Note: create_poc is registered as both a tool (universal client support) and a prompt (prompt-aware clients).

process.on('SIGTERM', () => {
  console.error(`[${name}] Shutting down.`);
  process.exit(0);
});
process.on('SIGINT', () => {
  console.error(`[${name}] Shutting down.`);
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);
