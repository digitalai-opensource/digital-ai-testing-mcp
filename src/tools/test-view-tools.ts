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
import { applyMaxResults, appendTruncationNotice } from '../utils/pagination.js';
import {
  formatTestViewList,
  formatTestViewSummary,
} from '../utils/response-formatter.js';
import { outputFormatParam, respond } from '../utils/output-format.js';

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
        return respond(outputFormat, structured, humanText);
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
        return respond(outputFormat, structured, humanText);
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
      id: z.number().int().describe('The numeric test view group ID.'),
      outputFormat: outputFormatParam,
    },
    async ({ id, outputFormat }) => {
      try {
        const view = await getTestViewById(id);
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
    'Get aggregated pass/fail/incomplete/skipped counts for a test view. Optionally filter by key-value pairs to narrow the scope (e.g. only Android results).',
    {
      id: z.number().int().describe('The numeric test view group ID.'),
      filter: z
        .record(z.string())
        .optional()
        .describe(
          'Optional key-value filter to scope the counts, e.g. {"device.os":"Android"}.'
        ),
      outputFormat: outputFormatParam,
    },
    async ({ id, filter, outputFormat }) => {
      try {
        const summary = await getTestViewSummary(id, filter);
        const total = summary._count_;
        const structured = {
          total,
          passed: summary.passedCount,
          failed: summary.failedCount,
          incomplete: summary.incompleteCount,
          skipped: summary.skippedCount,
          passRate: total > 0 ? parseFloat(((summary.passedCount / total) * 100).toFixed(1)) : 0,
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
    'Create a new test view group. Test views define how reports are grouped and visualised in the reporting dashboard. The byKey, groupByKey1 and groupByKey2 fields must be valid test report key names.',
    {
      name: z.string().describe('Display name for the new test view group.'),
      byKey: z
        .string()
        .describe('The primary "View by" key, e.g. "device.os" or "browser". Must exist in test data.'),
      groupByKey1: z
        .string()
        .describe('Left "Group by" panel key, e.g. "environment". Must exist in test data.'),
      groupByKey2: z
        .string()
        .describe('Right "Group by" panel key, e.g. "version". Must exist in test data.'),
      keys: z
        .array(z.string())
        .optional()
        .describe('Additional key names to include in the view.'),
      showInDashboard: z
        .boolean()
        .optional()
        .describe('Whether to show this view on the main dashboard. Default: false.'),
    },
    async ({ name, byKey, groupByKey1, groupByKey2, keys, showInDashboard }) => {
      try {
        const view = await createTestView({
          name,
          byKey,
          groupByKey1,
          groupByKey2,
          ...(keys && { keys }),
          showInDashboard: showInDashboard ?? false,
        });
        return {
          content: [
            {
              type: 'text',
              text: `✅ Test view "${view.name}" created successfully (ID: ${view.id}).`,
            },
          ],
        };
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
      id: z.number().int().describe('The numeric ID of the test view to update.'),
      name: z.string().optional().describe('New display name for the test view.'),
      showInDashboard: z
        .boolean()
        .optional()
        .describe('Set to true to show on the dashboard, false to hide it.'),
    },
    async ({ id, name, showInDashboard }) => {
      try {
        const view = await updateTestView({ id, ...(name && { name }), ...(showInDashboard !== undefined && { showInDashboard }) });
        return {
          content: [{ type: 'text', text: `✅ Test view "${view.name}" (ID: ${view.id}) updated.` }],
        };
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
      id: z.number().int().describe('The numeric ID of the test view to delete.'),
      confirmDeletion: z
        .boolean()
        .optional()
        .describe('Must be true to confirm the deletion.'),
    },
    async ({ id, confirmDeletion }) => {
      const guard = checkDestructiveGuard(confirmDeletion, `Delete test view ${id}`);
      if (guard) return { content: [{ type: 'text', text: guard }] };
      try {
        await deleteTestView(id);
        return { content: [{ type: 'text', text: `✅ Test view ${id} deleted.` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
