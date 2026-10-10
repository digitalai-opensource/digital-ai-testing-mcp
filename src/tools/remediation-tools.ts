import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { REMEDIATION_CATEGORIES, isDebugMode, saveNote, canWriteLocally, resolveRemediationLocation } from '../utils/remediation.js';

/**
 * Debug mode only (MCP_DEBUG_MODE=true): registered only then, so it costs nothing in normal use.
 * See src/utils/remediation.ts for the design (event log + notes + nudges).
 */
export function registerRemediationTools(server: McpServer): void {
  if (!isDebugMode()) return;

  server.tool(
    'record_remediation_note',
    'Debug mode: record something that would help improve this MCP — an error, calls wasted on unclear guidance, a ' +
    'user correction, giving up, a better path than the one recommended, or any improvement idea. Call it once per ' +
    'occurrence, when resolved or abandoned; never interrupt the user\'s task for it. Be concrete: the request, the ' +
    'tool calls and arguments involved, what the MCP said, and what finally worked. Never include credentials.',
    {
      category: z
        .enum(REMEDIATION_CATEGORIES)
        .describe('error | unclear-guidance | user-correction | gave-up | better-path | improvement'),
      title: z.string().min(3).max(140).describe('One line, e.g. "install_application 400s while the device is reserved via rdb".'),
      intent: z.string().describe('What the user asked for and what you were trying to do at the time (your understanding of the intent).'),
      whatHappened: z.string().describe('The sequence: tools called (with the arguments that mattered), what came back, where it went wrong or what was unclear.'),
      resolution: z.string().optional().describe('What eventually worked (the workaround or fix), or why it could not be resolved.'),
      resolved: z.boolean().optional().describe('true if the task got done, false if not.'),
      tools: z.array(z.string()).optional().describe('Tool names involved.'),
      wastedCalls: z.number().int().min(0).optional().describe('How many tool calls did not move the task forward (count them — do not estimate tokens).'),
      userFeedback: z.string().optional().describe('user-correction: what the user said, as close to verbatim as you can.'),
      suggestion: z.string().optional().describe('The MCP change that would have avoided this (clearer description, different default, new tool, better error).'),
    },
    async (args) => {
      try {
        if (canWriteLocally()) await resolveRemediationLocation();
        const { written, markdown, fileName } = saveNote(args);
        if (written) {
          return { content: [{ type: 'text', text: `📝 Remediation note saved to ${written}. Continue with the user's task.` }] };
        }
        return {
          content: [{
            type: 'text',
            text:
              `📝 Remediation note (${args.category}). The MCP server is not on the user's machine, so it cannot save this itself.\n` +
              `If you can write files, APPEND the markdown below to remediation/${fileName} in the root of the project you are working in. ` +
              `If the remediation/ folder is new, also create remediation/.gitignore containing a single line "*" so it is never committed. ` +
              `If you cannot write files, skip it — do not paste it into the conversation unless the user asks. Then continue with the user's task.\n\n` +
              `----- BEGIN ${fileName} -----\n${markdown}----- END -----`,
          }],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: could not record the note: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
