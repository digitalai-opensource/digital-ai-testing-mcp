/**
 * The report pointer: one line on the result of a data tool that says how to present what it just returned.
 *
 * Why it exists. render_report lays out ANY data as a branded report, and create_report builds whole reports, but nothing
 * at the moment of use told an agent so: the only prompts were those two tools' own descriptions and one sentence in the
 * server instructions, which Claude Desktop does not deliver (2026-11-23). An agent holding 200 device records wrote a
 * long table, or HTML by hand; one built a usage report from six summarize_usage_report calls in six minutes
 * (2026-11-24). A tool RESULT reaches every client, so the pointer rides there.
 *
 * Rules:
 *  - only tools that return records or aggregates (REPORT_POINTER_TOOLS), never a detail view, a log, a command or a session;
 *  - only when the result holds more than a handful of values (holdsData): a list of three devices is an answer, not a report;
 *  - never on an error;
 *  - where a recipe builds the finished report of that data, it is named first (the agent should not assemble it);
 *  - worded as an option for presenting, with "not for a quick answer": a question is still answered with a sentence;
 *  - at most once per tool every two minutes, so paging through a list does not repeat it;
 *  - MCP_REPORT_POINTER=false turns it off.
 */
import { withNudge } from './remediation.js';

/** Data tool → the report tool that builds the finished report of that data, or null when render_report is the route. */
export const REPORT_POINTER_TOOLS: Record<string, string | null> = {
  // Test results
  list_test_reports: null,
  get_grouped_test_reports: 'create_test_breakdown_report',
  summarize_test_failures: 'create_failure_analysis_report',
  get_project_test_summary: 'create_test_summary_report',
  get_daily_execution_trend: 'create_test_trend_report',
  get_test_stability_report: 'create_test_reliability_report',
  get_device_coverage_summary: 'create_device_coverage_report',
  get_failure_rate_by_app_version: null,
  get_cross_platform_divergence: null,
  get_regional_test_coverage: null,
  list_active_test_executions: null,
  list_test_views: null,
  search_test_views: null,
  get_test_view_summary: null,
  // Devices and the lab
  list_devices: null,
  get_device_health_summary: 'create_device_health_report',
  find_unhealthy_devices: 'create_device_health_report',
  get_environment_summary: 'create_device_health_report',
  get_license_utilization: 'create_license_usage_report',
  get_reporter_project_storage: 'create_test_inventory_report',
  list_virtual_device_templates: null,
  list_device_groups: null,
  get_devices_in_group: null,
  list_reservations: null,
  list_active_sessions: null,
  list_agents: null,
  get_agent_devices: null,
  get_agent_status: null,
  list_regions: null,
  get_region_topology: null,
  // Users, projects, usage
  list_users: null,
  list_projects: null,
  list_project_users: null,
  get_project_devices: null,
  summarize_usage_report: 'create_usage_summary_report',
  // Applications and files
  list_applications: null,
  list_repository_files: null,
  list_provisioning_profiles: null,
  list_available_browsers: null,
  // Performance
  list_transactions: 'create_performance_overview_report',
  get_transaction_performance_summary: 'create_performance_overview_report',
  get_performance_trend: 'create_performance_overview_report',
  compare_performance_transactions: null,
  detect_performance_outliers: null,
  list_nv_servers: null,
};

/** A result with fewer values than this is an answer, not material for a report. */
const MIN_RECORDS = 5;
const MIN_NUMBERS = 12;
const MIN_TEXT_LINES = 12;
/** The same tool does not repeat the pointer inside this window (paging through a list). */
export const REPORT_POINTER_REPEAT_MS = 2 * 60_000;

export function isReportPointerEnabled(): boolean {
  return !/^(false|0|off|no)$/i.test((process.env.MCP_REPORT_POINTER ?? '').trim());
}

/**
 * Does this result hold more than a handful of values? JSON: an array of five or more entries anywhere in the first four
 * levels, or, when it holds NO list at all, twelve or more numbers (an aggregate). Three test reports carry more than
 * twelve numbers between them and are still an answer, not a report. Formatted text: twelve or more non-empty lines.
 */
export function holdsData(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      let longest = 0, numbers = 0;
      const walk = (v: unknown, depth: number): void => {
        if (typeof v === 'number') { numbers++; return; }
        if (v == null || typeof v !== 'object' || depth > 4) return;
        if (Array.isArray(v)) { longest = Math.max(longest, v.length); for (const x of v.slice(0, 200)) walk(x, depth + 1); return; }
        for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
      };
      walk(JSON.parse(trimmed), 0);
      return longest >= MIN_RECORDS || (longest < 2 && numbers >= MIN_NUMBERS);
    } catch {
      // not JSON after all: count lines
    }
  }
  return trimmed.split('\n').filter((l) => l.trim()).length >= MIN_TEXT_LINES;
}

/** The pointer line for a tool, or null when the tool is not a data tool. */
export function reportPointer(tool: string): string | null {
  if (!(tool in REPORT_POINTER_TOOLS)) return null;
  const recipe = REPORT_POINTER_TOOLS[tool];
  return recipe
    ? `📊 Presenting this to the user? ${recipe} builds the finished branded report of this data in one call (do not assemble it from these numbers). For another cut, render_report lays out the numbers you send. Not for a quick answer.`
    : '📊 Presenting this to the user (a summary, ranking, trend or comparison)? render_report lays out the numbers you send as a branded report in one call: no hand-written HTML, no long table. Not for a quick answer.';
}

const lastShown = new Map<string, number>();
export function resetReportPointerForTests(): void { lastShown.clear(); }

type Handler = (...a: unknown[]) => unknown;

/**
 * Wrap a data tool: a successful result that holds data gets the pointer first (a "_presentAsReport" field in a JSON
 * object, a leading line otherwise, as the other notices are placed). Every other result is returned unchanged, the same object.
 */
export function withReportPointer(tool: string, callback: Handler, now: () => number = Date.now): Handler {
  const pointer = reportPointer(tool);
  if (!pointer) return callback;
  // A result that already names where the pointer leads (a guard, a hint of its own) needs no second pointer. With a
  // recipe that is render_report, create_report or that recipe: get_grouped_test_reports names create_test_inventory_report
  // in its scope line on every query without a project, which is another report and kept the pointer off that tool.
  const recipe = REPORT_POINTER_TOOLS[tool];
  const alreadyNamed = recipe ? new RegExp(`render_report|create_report\\b|${recipe}`) : /render_report|create_\w*report/;
  return async (...a: unknown[]) => {
    const result = await callback(...a);
    try {
      if (!isReportPointerEnabled()) return result;
      const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
      if (!r || r.isError || !Array.isArray(r.content)) return result;
      const text = r.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
      if (alreadyNamed.test(text) || !holdsData(text)) return result;
      const t = now();
      if (t - (lastShown.get(tool) ?? -Infinity) < REPORT_POINTER_REPEAT_MS) return result;
      lastShown.set(tool, t);
      return withNudge(r, pointer, '_presentAsReport');
    } catch {
      return result; // a pointer must never turn a working tool into a failing one
    }
  };
}
