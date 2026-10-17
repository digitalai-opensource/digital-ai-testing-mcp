/**
 * MCP tool annotations (readOnlyHint / destructiveHint) derived from the tool's name, so clients that honour
 * annotations can auto-approve reads and warn on destructive calls. The same prefix rule drives the fidelity eval's
 * allow-list (tests/fidelity/safety.ts), so the two can never disagree about what counts as read-only.
 *
 * A toolset PLACEHOLDER (MCP_TOOLSETS) is always read-only: its first call executes nothing and returns guidance.
 */
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/** Tools that only read, or only generate text (get_*_command) — safe to run without a side effect. */
export const READ_ONLY_TOOL_RE = /^(list_|get_|find_|check_|summarize_|compare_|assess_|detect_|validate_|search_)|^(enable_toolset|switch_environment)$/;

/**
 * Tools that delete, release or cancel something that cannot be undone. Every tool that calls checkDestructiveGuard
 * must match (tests/toolsets.test.ts asserts it) — `unassign_user_from_projects` was missed the first time.
 */
export const DESTRUCTIVE_TOOL_RE = /^(delete_|release_|cancel_|uninstall_|remove_|unassign_|cleanup_)/;

/**
 * Read-only by name, but with an opt-in mode that changes the tenant — so NOT read-only: no readOnlyHint, and the
 * fidelity eval denies them (the attempt is still recorded). find_unhealthy_devices tags devices with confirmTagging.
 */
export const WRITES_DESPITE_NAME = new Set(['find_unhealthy_devices']);

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOL_RE.test(name) && !WRITES_DESPITE_NAME.has(name);
}

export function annotationsFor(name: string, opts: { placeholder?: boolean } = {}): ToolAnnotations {
  // No title: it repeats for every unloaded tool and the placeholder description already says the first call runs nothing.
  if (opts.placeholder) return { readOnlyHint: true, destructiveHint: false };
  if (isReadOnlyTool(name)) return { readOnlyHint: true, destructiveHint: false };
  return { readOnlyHint: false, destructiveHint: DESTRUCTIVE_TOOL_RE.test(name) };
}
