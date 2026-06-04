import { z } from 'zod';

/**
 * Standard outputFormat parameter for all data-returning tools.
 *
 * 'json' (default): compact structured object — use in automated workflows and orchestration
 *   where returned IDs or field values will be passed to follow-up tool calls. Any agent
 *   (Claude, Copilot, Gemini, etc.) should prefer this format when chaining tool calls.
 *
 * 'human': formatted text — use when presenting results directly to an operator who will
 *   read the output without further programmatic processing.
 */
export const outputFormatParam = z
  .enum(['json', 'human'])
  .optional()
  .default('json')
  .describe(
    "Response format. " +
    "'json' (default): compact structured object — choose this in automated workflows and orchestration where IDs or values will be passed to follow-up tool calls. " +
    "Any agent (Claude, Copilot, Gemini, etc.) should prefer 'json' when chaining tool calls. " +
    "'human': formatted text — use when displaying results directly to an operator."
  );

/** Return either structured JSON or human-readable text based on the caller's preference. */
export function respond(
  outputFormat: 'json' | 'human' | string,
  structured: object,
  humanText: string
): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: outputFormat === 'human' ? humanText : JSON.stringify(structured) }],
  };
}
