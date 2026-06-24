import { z } from 'zod';

export const outputFormatParam = z
  .enum(['json', 'human'])
  .optional()
  .default('json')
  .describe("'json' (default): structured output for tool chaining. 'human': formatted markdown for display.");

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
