import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getAllTestViews,
  getTestViewById,
  listTestViews,
  getTestViewSummary,
  createTestView,
  updateTestView,
  deleteTestView,
} from '../api/test-views.js';
import { checkDestructiveGuard } from '../utils/destructive-guard.js';
import { applyMaxResults, appendTruncationNotice, withPaging } from '../utils/pagination.js';
import {
  formatTestViewList,
  formatTestViewSummary,
} from '../utils/response-formatter.js';
import { outputFormatParam, respond } from '../utils/output-format.js';
import { countsFromPivotRow, passRate, unknownStatusCount, PASS_RATE_BASIS } from '../utils/test-status.js';

export function registerTestViewTools(server: McpServer): void {
  // ─── list_test_views ───────────────────────────────────────────────────────

  server.tool(
    'list_test_views',
    'List all test view groups configured in the reporting system. Test views define how test results are grouped and displayed on dashboards.',
    {
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Maximum number of test views to return (default: 50).'),
      outputFormat: outputFormatParam,
    },
    async ({ maxResults, outputFormat }) => {
      try {
        const views = await getAllTestViews();
        const paged = applyMaxResults(views, maxResults);
        const structured = {
          views: paged.items.map(v => ({
            id: v.id,
            name: v.name,
            byKey: v.byKey,
            createdBy: v.createdBy,
            showInDashboard: v.showInDashboard,
          })),
        };
        const humanText = appendTruncationNotice(formatTestViewList(paged.items), paged);
        return respond(outputFormat, withPaging(structured, paged), humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── search_test_views ─────────────────────────────────────────────────────

  server.tool(
    'search_test_views',
    'Search and paginate through test view groups by name. Useful when there are many test views configured.',
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Results per page (default: 50).'),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Page number starting at 1 (default: 1).'),
      searchValue: z
        .string()
        .optional()
        .describe('Case-insensitive search against test view names.'),
      sort: z
        .array(
          z.object({
            property: z.string().describe('Field to sort by, e.g. "name".'),
            descending: z.boolean().describe('True for descending order.'),
          })
        )
        .optional()
        .describe('Sort order, e.g. [{"property":"name","descending":false}].'),
      outputFormat: outputFormatParam,
    },
    async ({ limit, page, searchValue, sort, outputFormat }) => {
      try {
        const request = {
          limit: limit ?? 50,
          page: page ?? 1,
          ...(searchValue && { searchValue }),
          ...(sort && { sort }),
        };
        const result = await listTestViews(request);
        const paged = applyMaxResults(result.data ?? [], limit ?? 50);
        const structured = {
          total: result.count,
          views: paged.items.map(v => ({
            id: v.id,
            name: v.name,
            byKey: v.byKey,
            createdBy: v.createdBy,
            showInDashboard: v.showInDashboard,
          })),
        };
        const countLine = `Total: ${result.count}\n\n`;
        const humanText = appendTruncationNotice(countLine + formatTestViewList(paged.items), paged);
        return respond(outputFormat, withPaging(structured, paged), humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── get_test_view ─────────────────────────────────────────────────────────

  server.tool(
    'get_test_view',
    'Get full configuration details for a specific test view group by its ID, including its grouping keys and filter settings.',
    {
      id: z.number().int().optional().describe('The numeric test view group ID.'),
      viewId: z.number().int().optional().describe('Deprecated — use id instead.'),
      outputFormat: outputFormatParam,
    },
    async ({ id, viewId: viewIdParam, outputFormat }) => {
      const resolvedId = id ?? viewIdParam;
      if (resolvedId === undefined) {
        return { content: [{ type: 'text' as const, text: 'Error: id is required' }], isError: true };
      }
      try {
        const view = await getTestViewById(resolvedId);
        const lines = [
          `Test View: ${view.name} (ID: ${view.id})`,
          `  View by key:    ${view.byKey}`,
          `  Group by key 1: ${view.groupByKey1 ?? '—'}`,
          `  Group by key 2: ${view.groupByKey2 ?? '—'}`,
          `  Created by:     ${view.createdBy}`,
          `  In dashboard:   ${view.showInDashboard ? 'Yes' : 'No'}`,
        ];
        if (view.keys && view.keys.length > 0) {
          lines.push(`  Keys: ${view.keys.join(', ')}`);
        }
        return respond(outputFormat, view, lines.join('\n'));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── get_test_view_summary ─────────────────────────────────────────────────

  server.tool(
    'get_test_view_summary',
    'Get aggregated status counts for a test view — Passed, Failed, Error, Incomplete, Skipped, Healed — with the view\'s own saved filter applied. Optionally filter further by key-value pairs (e.g. only Android results). Pass rate = (Passed+Healed)/(Passed+Healed+Failed+Error).',
    {
      id: z.number().int().describe('The numeric test view group ID.'),
      filter: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'Optional key-value filter to scope the counts, e.g. {"device.os":"Android"}.'
        ),
      outputFormat: outputFormatParam,
    },
    async ({ id, filter, outputFormat }) => {
      try {
        const summary = await getTestViewSummary(id, filter);
        const counts = countsFromPivotRow(summary as unknown as Record<string, unknown>);
        const unknown = unknownStatusCount(counts);
        const structured = {
          ...counts,
          ...(unknown > 0 ? { otherStatus: unknown } : {}),
          passRate: passRate(counts),
          passRateBasis: PASS_RATE_BASIS,
        };
        return respond(outputFormat, structured, formatTestViewSummary(summary));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── create_test_view ──────────────────────────────────────────────────────

  server.tool(
    'create_test_view',
    'Create a new test view group. Test views define how reports are grouped and visualised in the reporting dashboard. The byKey field must be a valid test report key name (e.g. "device.os", "status", "appVersion").',
    {
      name: z.string().describe('Display name for the new test view group.'),
      byKey: z
        .string()
        .describe('The primary "View by" key, e.g. "device.os" or "browser". Must exist in test data.'),
      groupByKey1: z
        .string()
        .optional()
        .describe('Left "Group by" panel key (default: "status"). Common values: status, device.os, device.model, appVersion.'),
      groupByKey2: z
        .string()
        .optional()
        .describe('Right "Group by" panel key (default: "device.model"). Common values: device.model, device.os, appVersion.'),
      keys: z
        .array(z.string())
        .optional()
        .describe('Additional key names to include in the view.'),
      showInDashboard: z
        .boolean()
        .optional()
        .describe('Whether to show this view on the main dashboard. Default: false.'),
      outputFormat: outputFormatParam,
    },
    async ({ name, byKey, groupByKey1, groupByKey2, keys, showInDashboard, outputFormat }) => {
      try {
        const view = await createTestView({
          name,
          byKey,
          groupByKey1: groupByKey1 ?? 'status',
          groupByKey2: groupByKey2 ?? 'device.model',
          ...(keys && { keys }),
          showInDashboard: showInDashboard ?? false,
        });
        // Structured too — the id is what the next call needs (UAT 2026-10-10: json mode returned only text).
        return respond(outputFormat, { created: true, ...view }, `✅ Test view "${view.name}" created successfully (ID: ${view.id}).`);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── update_test_view ──────────────────────────────────────────────────────

  server.tool(
    'update_test_view',
    'Update the name or dashboard visibility of an existing test view group.',
    {
      id: z.number().int().optional().describe('The numeric ID of the test view to update.'),
      viewId: z.number().int().optional().describe('Deprecated — use id instead.'),
      name: z.string().optional().describe('New display name for the test view.'),
      showInDashboard: z
        .boolean()
        .optional()
        .describe('Set to true to show on the dashboard, false to hide it.'),
      outputFormat: outputFormatParam,
    },
    async ({ id, viewId: viewIdParam, name, showInDashboard, outputFormat }) => {
      const resolvedId = id ?? viewIdParam;
      if (resolvedId === undefined) {
        return { content: [{ type: 'text' as const, text: 'Error: id is required' }], isError: true };
      }
      try {
        const view = await updateTestView({ id: resolvedId, ...(name && { name }), ...(showInDashboard !== undefined && { showInDashboard }) });
        return respond(outputFormat, { updated: true, ...view }, `✅ Test view "${view.name}" (ID: ${view.id}) updated.`);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── delete_test_view ──────────────────────────────────────────────────────

  server.tool(
    'delete_test_view',
    'Permanently delete a test view group. This removes the view configuration but does not delete any underlying test data. Requires confirmDeletion: true.',
    {
      id: z.number().int().optional().describe('The numeric ID of the test view to delete.'),
      viewId: z.number().int().optional().describe('Deprecated — use id instead.'),
      confirmDeletion: z
        .boolean()
        .optional()
        .describe('Must be true to confirm the deletion.'),
      outputFormat: outputFormatParam,
    },
    async ({ id, viewId: viewIdParam, confirmDeletion, outputFormat }) => {
      const resolvedId = id ?? viewIdParam;
      if (resolvedId === undefined) {
        return { content: [{ type: 'text' as const, text: 'Error: id is required' }], isError: true };
      }
      // Name the view in the guard and the result, so the user confirms what they recognise (UAT 2026-10-10).
      const viewName = await getTestViewById(resolvedId).then((v) => v.name).catch(() => null);
      const label = viewName ? `test view "${viewName}" (ID ${resolvedId})` : `test view ${resolvedId}`;
      const guard = checkDestructiveGuard(confirmDeletion, `Delete ${label}`);
      if (guard) return { content: [{ type: 'text', text: guard }] };
      try {
        await deleteTestView(resolvedId);
        return respond(outputFormat, { deleted: true, id: resolvedId, name: viewName }, `✅ Deleted ${label}.`);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
