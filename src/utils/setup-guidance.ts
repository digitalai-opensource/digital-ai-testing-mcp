/**
 * Setup mode — what the server says when it starts without credentials.
 *
 * Before: a missing DIGITAL_AI_BASE_URL / DIGITAL_AI_ACCESS_KEY made the process exit, and the client showed only
 * "-32000 Failed to reconnect". Now the server starts, the server instructions open with a SETUP REQUIRED block, and
 * every tool answers with the same instructions instead of running (index.ts passes `setupModeHandler` as the
 * registerWithToolsets wrapper). Nothing calls the API in this state.
 *
 * The instructions depend on how the server was installed, because that decides where the variables go:
 *   client-config — npx / npm install: the `env` block of the server's entry in the AI client's configuration
 *   docker        — the .env file passed with --env-file (or -e flags)
 *   source        — a source checkout: the client's `env` block, or .env in the folder the server starts from
 * The text never contains a credential value.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type SetupContext = 'client-config' | 'docker' | 'source';

const CONFIG_DOCS = 'https://github.com/digitalai-opensource/digital-ai-testing-mcp#configuration';

/**
 * Pure: the install path decides first (npx and npm installs are never containers); otherwise a container marker or an
 * explicit MCP_DEPLOYMENT_MODE=docker (set by the published image) means Docker.
 */
export function setupContext(opts: { modulePath: string; deploymentModeEnv?: string; inContainer: boolean }): SetupContext {
  const p = opts.modulePath.replace(/\\/g, '/');
  if (p.includes('/_npx/') || p.includes('/node_modules/digital-ai-testing-mcp/')) return 'client-config';
  if (opts.inContainer || opts.deploymentModeEnv?.trim().toLowerCase() === 'docker') return 'docker';
  return 'source';
}

export function detectSetupContext(): SetupContext {
  return setupContext({
    modulePath: fileURLToPath(import.meta.url),
    // Read directly (not getDeploymentMode): its default is `docker`, and only an EXPLICIT value says anything here.
    deploymentModeEnv: process.env.MCP_DEPLOYMENT_MODE,
    inContainer: existsSync('/.dockerenv'),
  });
}

function whereToSet(ctx: SetupContext): string {
  switch (ctx) {
    case 'client-config':
      return (
        "Add them to the `env` block of this server's entry in the AI client's MCP configuration (for example " +
        'claude_desktop_config.json, .vscode/mcp.json, .cursor/mcp.json, ~/.claude.json or ~/.codex/config.toml), ' +
        'together with MCP_DEPLOYMENT_MODE=local.'
      );
    case 'docker':
      return (
        'Add them to the .env file the container is started with (--env-file), or pass them with -e. On Windows, write ' +
        'the .env path with forward slashes (C:/path/to/.env).'
      );
    case 'source':
      return (
        "Add them to the `env` block of this server's entry in the AI client's MCP configuration, or to a .env file in " +
        'the folder the server starts from.'
      );
  }
}

/** The text every tool returns in setup mode. `namedProfiles` are DAI_PROFILE_* names that were found (no keys). */
export function setupGuidance(missing: string[], ctx: SetupContext, namedProfiles: string[] = []): string {
  const lines = [
    `SETUP REQUIRED — the Digital.ai Testing MCP server is not configured: ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set, so no tool can run.`,
    'Tell the user what to do (below). Do not ask them to paste an access key into this chat.',
    '',
    `How to fix: ${whereToSet(ctx)} Then restart the AI client or reconnect this MCP server.`,
    '',
    '  DIGITAL_AI_BASE_URL=https://your-tenant.experitest.com',
    '  DIGITAL_AI_ACCESS_KEY=<your access key>',
    '',
    'The access key is in the Digital.ai Testing portal: click your name (top right) → Access Key. It belongs to the ' +
      'project selected in the portal.',
  ];
  if (namedProfiles.length > 0) {
    lines.push(
      '',
      `Named profiles were found (${namedProfiles.join(', ')}), but the default connection is required as well: set ` +
        'DIGITAL_AI_BASE_URL and DIGITAL_AI_ACCESS_KEY to the connection to use at start.'
    );
  }
  lines.push('', `Configuration reference: ${CONFIG_DOCS}`);
  return lines.join('\n');
}

/** Opens the server instructions in setup mode — clients read instructions before the agent plans. */
export function setupInstructionsBlock(missing: string[]): string {
  return (
    `SETUP REQUIRED: this server has no Digital.ai credentials (${missing.join(', ')} not set). Every tool returns ` +
    'setup instructions instead of running. Before anything else, tell the user the server needs configuring and give ' +
    'them those instructions (call get_server_info to get them).\n\n'
  );
}

export function setupRequiredResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
