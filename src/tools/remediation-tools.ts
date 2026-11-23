import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  REMEDIATION_CATEGORIES, isDebugMode, saveNote, canWriteLocally, resolveRemediationLocation, setDebugMode, configuredDebugMode,
  debugInstructions,
} from '../utils/remediation.js';

const onOff = (on: boolean) => (on ? 'on' : 'off');

/** set_debug_mode's answer — the server instructions are fixed at connect, so this text has to carry the new rules. */
export function debugModeChangeText(on: boolean, changed: boolean): string {
  const config = `MCP_DEBUG_MODE in the client configuration is ${onOff(configuredDebugMode())}; it applies again when the MCP server restarts.`;
  if (!changed) return `Debug mode is already ${onOff(on).toUpperCase()}. Nothing changed. ${config}`;
  if (on) {
    return (
      `Debug mode is now ON for this run of the MCP server. ${config}\n\n` +
      debugInstructions('set_debug_mode').trimEnd()
    );
  }
  return (
    `Debug mode is now OFF for this run of the MCP server. ${config}\n` +
    'Stop recording remediation notes and ignore any DEBUG MODE block in the server instructions: no event log is ' +
    'kept, no reminders are added, and record_remediation_note records nothing. Notes already saved stay where they are.'
  );
}

/**
 * Both tools are always listed (user request 2026-11-22: turn debug mode on or off with a prompt until the next restart).
 * record_remediation_note was hidden while off at first, but Claude Desktop does not reload the tool list when the server
 * says it changed (2.4.6-beta.1), so a note tool added mid-run never reached the agent. Listed always (~550 tokens, user
 * decision 2026-11-22), it records only while debug mode is on. See src/utils/remediation.ts for the design (event log + notes + nudges).
 */
export function registerRemediationTools(server: McpServer): void {
  server.tool(
    'set_debug_mode',
    'Turn debug mode on or off for this run of the MCP server — ONLY when the user asks for it (e.g. "turn on debug ' +
    'mode", "stop recording remediation notes"), never on your own. Debug mode records remediation notes and an event ' +
    'log that help improve this MCP. The change lasts until the MCP server restarts; then MCP_DEBUG_MODE in the ' +
    'client configuration applies again. The response carries the rules to follow from then on. To only CHECK whether ' +
    'debug mode is on, read the "Debug mode" line of get_server_info instead.',
    {
      enabled: z.boolean().describe('true = turn debug mode on, false = turn it off.'),
    },
    async ({ enabled }) => {
      const { changed } = setDebugMode(enabled);
      return { content: [{ type: 'text', text: debugModeChangeText(enabled, changed) }] };
    }
  );

  server.tool(
    'record_remediation_note',
    'Debug mode only — records nothing while debug mode is off, so call it only when debug mode is ON (the server ' +
    'instructions, get_server_info or set_debug_mode say so). Record something that would help improve this MCP — an error, calls wasted on unclear guidance, a ' +
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
      // Listed only while debug mode is on; a client that did not refresh its tool list can still call it.
      if (!isDebugMode()) {
        return { content: [{ type: 'text', text: "Debug mode is off, so the note was not recorded. Continue with the user's task." }] };
      }
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
              `📝 Remediation note (${args.category}). The MCP server could not save this itself (it is not on the user's machine, or has no writable project folder).\n` +
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
