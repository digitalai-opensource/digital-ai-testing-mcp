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
import { registerMetaTools, TOOL_COUNT } from './tools/meta-tools.js';
import { computeWorkflowReadiness } from './utils/tool-registry.js';

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
const version = process.env.MCP_SERVER_VERSION ?? '1.0.0';

console.error(`[${name}] v${version} starting...`);
console.error(`[${name}] Target: ${process.env.DIGITAL_AI_BASE_URL}`);

const server = new McpServer({ name, version });

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
registerMetaTools(server);

console.error(`[${name}] All tool modules registered (${TOOL_COUNT} tools + 2 resources + 4 prompts).`);

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
