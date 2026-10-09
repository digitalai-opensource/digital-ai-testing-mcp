import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOLSETS, type ToolsetController } from '../utils/toolsets.js';
import { outputFormatParam, respond } from '../utils/output-format.js';

/**
 * enable_toolset — load toolsets in full mid-session (MCP_TOOLSETS opt-in). Always registered in full.
 * The controller is created after capture, so it is reached through a getter.
 */
export function makeToolsetTools(getController: () => ToolsetController | undefined): (server: McpServer) => void {
  return (server: McpServer) => {
    server.tool(
      'enable_toolset',
      'Load one or more toolsets in full. This server may run with MCP_TOOLSETS limiting which toolsets are loaded; tools ' +
      'outside them are listed with a one-line "[<toolset> toolset — not loaded …]" description. Calling such a tool also ' +
      'loads its toolset automatically, so this is only needed to see the full definitions up front (e.g. before planning ' +
      'a multi-step task). Call with no toolsets to list them and see which are loaded. ' +
      `Toolsets: ${Object.entries(TOOLSETS).map(([k, v]) => `${k} (${v.description})`).join('; ')}.`,
      {
        toolsets: z
          .array(z.enum(Object.keys(TOOLSETS) as [string, ...string[]]))
          .optional()
          .describe('Toolsets to load. Omit to list toolsets and their state.'),
        outputFormat: outputFormatParam,
      },
      async ({ toolsets, outputFormat }) => {
        const c = getController();
        if (!c) {
          return respond(outputFormat, { allLoaded: true }, 'All toolsets are loaded (this server is not using MCP_TOOLSETS).');
        }
        const changed = toolsets?.length ? c.enable(toolsets) : [];
        const summary = c.summary();
        const lines = [
          ...(toolsets?.length
            ? [changed.length
                ? `✅ Loaded ${toolsets.join(', ')} — ${changed.length} tool(s) now have their full definitions. Clients that support tool-list updates refresh automatically; either way the tools are callable now.`
                : `${toolsets.join(', ')} already loaded — nothing changed.`, '']
            : []),
          'Toolsets:',
          ...summary.map((t) => `  ${t.loaded ? '✅' : '○'} ${t.toolset} — ${t.description} (${t.tools} tools)`),
        ];
        return respond(outputFormat, { loadedNow: changed, toolsets: summary }, lines.join('\n'));
      }
    );
  };
}
