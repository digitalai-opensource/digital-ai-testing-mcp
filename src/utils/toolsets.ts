/**
 * Opt-in toolsets (MCP_TOOLSETS) — cut the context cost of 200 tool definitions WITHOUT weakening the guidance that
 * keeps agents using them correctly.
 *
 * Design constraint (the fidelity concern): many past misuse fixes live in tool descriptions, and descriptions
 * cross-reference each other densely ("install_application first", "then start_inspection_session", prompts that walk
 * five tools). Measured 2026-10-09: a transitive closure over those references pulls 69–79% of all tools into ANY
 * single toolset, so "load only these tools" either saves nothing or leaves guidance pointing at tools that do not exist.
 *
 * So nothing is ever removed. Every tool stays registered under its real name:
 *  - tools in a selected toolset (and the core) keep their full description and parameters;
 *  - every other tool becomes a SELF-LOADING PLACEHOLDER: a one-line description, no parameters. Calling it loads its
 *    whole toolset on the spot (full definitions restored; clients that support tools/list_changed refresh) and returns
 *    the tool's FULL description and parameter guidance in the response, asking the agent to call it again — so the
 *    guidance arrives at the moment of use, before the real call runs.
 *  - Server instructions and prompts are unchanged; every name they mention exists.
 * Unset / "all" registers everything in full — zero behaviour change for existing installs.
 */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';

export type RegisterFn = (server: McpServer) => void;

export interface CapturedTool { name: string; module: string; description: string; shape: Record<string, unknown>; callback: (...a: unknown[]) => unknown; args: unknown[] }
export interface CapturedOther { module: string; args: unknown[] }
export interface Captured { tools: CapturedTool[]; prompts: CapturedOther[]; resources: CapturedOther[] }

/** Run every register function against a recorder; nothing reaches a real server. */
export function captureRegistrations(modules: Array<[string, RegisterFn]>): Captured {
  const captured: Captured = { tools: [], prompts: [], resources: [] };
  for (const [module, register] of modules) {
    const recorder = {
      tool: (...args: unknown[]) => {
        // Every tool module uses server.tool(name, description, shape, callback).
        const [name, description, shape, callback] = args as [string, string, Record<string, unknown>, (...a: unknown[]) => unknown];
        if (typeof name !== 'string' || typeof description !== 'string' || typeof callback !== 'function') {
          throw new Error(`toolsets: unsupported server.tool signature in module ${module} (${String(name)})`);
        }
        captured.tools.push({ name, module, description, shape: shape ?? {}, callback, args });
      },
      prompt: (...args: unknown[]) => { captured.prompts.push({ module, args }); },
      resource: (...args: unknown[]) => { captured.resources.push({ module, args }); },
    };
    register(recorder as unknown as McpServer);
  }
  return captured;
}

/** User-facing toolsets → tool modules. Every tool module except the core belongs to exactly one toolset. */
export const TOOLSETS: Record<string, { modules: string[]; description: string }> = {
  devices: { modules: ['devices', 'device-groups', 'reservations', 'health', 'agents', 'regions'], description: 'devices, device groups, reservations, health, agents, regions' },
  apps: { modules: ['applications', 'repository', 'provisioning-profiles'], description: 'application repository, file repository, provisioning profiles' },
  reporting: { modules: ['reporting', 'test-views', 'coverage'], description: 'test reports, analytics, root-cause analysis, test views, coverage' },
  performance: { modules: ['transactions', 'performance', 'nv-servers'], description: 'performance transactions and comparisons, NV servers' },
  inspection: { modules: ['inspection', 'web-inspection', 'debug'], description: 'live device and browser inspection sessions, Android Auto/CarPlay, remote debug' },
  authoring: { modules: ['boilerplate', 'test-runs'], description: 'test boilerplate, Espresso/XCUITest/Maestro test runs' },
  browsers: { modules: ['browsers'], description: 'browser listing and Selenium sessions' },
  admin: { modules: ['users', 'projects', 'backup', 'usage-reports', 'workflows'], description: 'users, projects, backups, usage reports, POC/project workflows' },
};

/** Always loaded in full: connection/environment basics, toolset control, and the test-delivery backstop. */
export const CORE_MODULES = ['meta', 'toolsets'];
export const CORE_TOOLS = ['validate_test_script'];

export function toolsetOfModule(module: string): string | null {
  for (const [name, t] of Object.entries(TOOLSETS)) if (t.modules.includes(module)) return name;
  return null;
}

export interface Selection { all: boolean; toolsets: Set<string>; unknown: string[] }

export function parseToolsetSelection(raw: string | undefined): Selection {
  const tokens = (raw ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0 || tokens.includes('all')) return { all: true, toolsets: new Set(Object.keys(TOOLSETS)), unknown: [] };
  const toolsets = new Set<string>();
  const unknown: string[] = [];
  // "core" = only the always-loaded core in full (every other tool is a placeholder) — the maximum-savings setting.
  for (const t of tokens) {
    if (t === 'core') continue;
    if (TOOLSETS[t]) toolsets.add(t);
    else unknown.push(t);
  }
  return { all: false, toolsets, unknown };
}

/** "name (required): description" lines for a zod raw shape — the parameter guidance a placeholder hands back. */
export function describeShape(shape: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, node] of Object.entries(shape)) {
    let n = node as { description?: string; isOptional?: () => boolean; _def?: { innerType?: unknown } } | undefined;
    let description = n?.description;
    while (!description && n?._def?.innerType) { n = n._def.innerType as typeof n; description = n?.description; }
    const optional = typeof (node as { isOptional?: () => boolean })?.isOptional === 'function' && (node as { isOptional: () => boolean }).isOptional();
    lines.push(`- ${key}${optional ? '' : ' (required)'}: ${description ?? ''}`.trimEnd());
  }
  return lines;
}

function firstSentence(text: string, max = 150): string {
  const s = text.replace(/\s+/g, ' ').trim();
  const end = s.search(/[.!?](\s|$)/);
  const one = end > 0 ? s.slice(0, end + 1) : s;
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Kept short — it repeats for every unloaded tool. enable_toolset's description explains the mechanism in full. */
export function placeholderDescription(tool: CapturedTool, toolset: string): string {
  return `[${toolset} toolset — loads on first call] ${firstSentence(tool.description, 120)}`;
}

export interface ToolsetController {
  /** Toolsets currently loaded in full (all toolsets when selection.all). */
  loaded(): string[];
  /** Load toolsets in full. Returns the tool names that changed from placeholder to full. */
  enable(toolsets: string[]): string[];
  /** Per-toolset summary for get_server_info / enable_toolset. */
  summary(): Array<{ toolset: string; description: string; loaded: boolean; tools: number }>;
}

/**
 * Register every captured tool (full or placeholder), then prompts and resources, onto the real server.
 * Placeholder-to-full restores use RegisteredTool.update(), which emits notifications/tools/list_changed.
 */
export function registerWithToolsets(server: McpServer, captured: Captured, selection: Selection): ToolsetController {
  const s = server as unknown as { tool: (...a: unknown[]) => RegisteredTool; prompt: (...a: unknown[]) => unknown; resource: (...a: unknown[]) => unknown };
  const loaded = new Set<string>(selection.toolsets);
  const handles = new Map<string, { tool: CapturedTool; handle: RegisteredTool; toolset: string | null }>();
  const isFull = (t: CapturedTool, toolset: string | null) =>
    selection.all || CORE_MODULES.includes(t.module) || CORE_TOOLS.includes(t.name) || toolset == null || loaded.has(toolset);

  const controller: ToolsetController = {
    loaded: () => [...loaded].sort(),
    enable(toolsets) {
      const changed: string[] = [];
      // RegisteredTool.update() notifies the client once PER TOOL (44 notifications for one toolset, observed live).
      // Silence it for the batch and send a single tools/list_changed at the end.
      const srv = server as unknown as { sendToolListChanged: () => void };
      const notify = srv.sendToolListChanged;
      srv.sendToolListChanged = () => {};
      try {
      for (const ts of toolsets) {
        if (!TOOLSETS[ts] || loaded.has(ts)) continue;
        loaded.add(ts);
        for (const { tool, handle, toolset } of handles.values()) {
          if (toolset !== ts || CORE_TOOLS.includes(tool.name)) continue;
          handle.update({ description: tool.description, paramsSchema: tool.shape as never, callback: tool.callback as never });
          changed.push(tool.name);
        }
      }
      } finally {
        srv.sendToolListChanged = notify;
      }
      if (changed.length) notify.call(server);
      return changed;
    },
    summary() {
      return Object.entries(TOOLSETS).map(([toolset, t]) => ({
        toolset,
        description: t.description,
        loaded: loaded.has(toolset),
        tools: captured.tools.filter((x) => t.modules.includes(x.module)).length,
      }));
    },
  };

  for (const tool of captured.tools) {
    const toolset = toolsetOfModule(tool.module);
    if (isFull(tool, toolset)) {
      handles.set(tool.name, { tool, handle: s.tool(...tool.args), toolset });
      continue;
    }
    const ts = toolset!;
    const placeholder = async () => {
      controller.enable([ts]);
      const guidance = [
        `The "${ts}" toolset (${TOOLSETS[ts].description}) was not loaded in this server; it is loaded now.`,
        `Nothing was executed. Read ${tool.name}'s full guidance below, then call ${tool.name} again with its parameters.`,
        '',
        `${tool.name} — full description:`,
        tool.description,
        '',
        'Parameters:',
        ...describeShape(tool.shape),
      ].join('\n');
      return { content: [{ type: 'text' as const, text: guidance }] };
    };
    handles.set(tool.name, { tool, handle: s.tool(tool.name, placeholderDescription(tool, ts), {}, placeholder), toolset });
  }
  for (const p of captured.prompts) s.prompt(...p.args);
  for (const r of captured.resources) s.resource(...r.args);
  return controller;
}
