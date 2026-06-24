import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAllDevices } from '../api/devices.js';
import { listTestsSortedDesc } from '../api/reporting.js';

// Resource handlers must not let errors escape to the MCP transport — wrap all
// api/ calls and return the error as the resource text so the client gets a
// readable payload instead of an opaque JSON-RPC error.

export function registerResources(server: McpServer): void {
  // ─── Device Farm Status ────────────────────────────────────────────────────
  // Pulled on demand by the LLM for ambient context — gives a quick picture of
  // the farm without the user having to ask get_device_health_summary first.

  server.resource(
    'device-farm-status',
    'digital-ai://farm/status',
    { description: 'Live device farm status: counts by availability, OS, and agent health.' },
    async (uri) => {
      try {
        const devices = await getAllDevices();
        const total = devices.length;
        const statusCounts: Record<string, number> = {};
        const osCounts: Record<string, number> = {};

        for (const d of devices) {
          const s = d.displayStatus || 'Unknown';
          statusCounts[s] = (statusCounts[s] ?? 0) + 1;
          osCounts[d.deviceOs] = (osCounts[d.deviceOs] ?? 0) + 1;
        }

        const available = statusCounts['Available'] ?? 0;
        const inUse = Object.entries(statusCounts)
          .filter(([s]) => s.toLowerCase().includes('in use') || s.toLowerCase().includes('busy'))
          .reduce((sum, [, n]) => sum + n, 0);
        const offline = statusCounts['Offline'] ?? 0;

        const statusLines = Object.entries(statusCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([s, n]) => `  ${s}: ${n}`)
          .join('\n');

        const osLines = Object.entries(osCounts)
          .map(([os, n]) => `  ${os}: ${n}`)
          .join('\n');

        const text = [
          `Digital.ai Device Farm — ${new Date().toUTCString()}`,
          `Total devices: ${total}  |  Available: ${available}  |  In Use: ${inUse}  |  Offline: ${offline}`,
          '',
          'By status:',
          statusLines,
          '',
          'By OS:',
          osLines,
        ].join('\n');

        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text }] };
      } catch (e) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'text/plain',
            text: `Error fetching device farm status: ${(e as Error).message}`,
          }],
        };
      }
    }
  );

  // ─── Recent Test Failures ──────────────────────────────────────────────────
  // Surfaces the last 20 failed tests so the LLM has triage context immediately.

  server.resource(
    'recent-test-failures',
    'digital-ai://reporting/recent-failures',
    { description: 'The 20 most recent failed test executions across all projects.' },
    async (uri) => {
      try {
        // listTestsSortedDesc guarantees newest-first for both key types — project
        // keys CSRF-block sort, so a plain sorted listTests call would silently
        // return arbitrary failures instead of the most recent.
        const result = await listTestsSortedDesc({
          limit: 20,
          page: 1,
          filter: [{ property: 'status', operator: '=', value: 'Failed' }],
        });

        const rows = (result.data ?? []).map((r) => {
          const started = new Date(r.start_time).toISOString().replace('T', ' ').slice(0, 19);
          const dur = r.duration != null ? (r.duration / 1000).toFixed(1) : 'n/a';
          return `  ❌ ${r.name} | ${started} | ${dur}s | UUID: ${r.uuid}`;
        });

        const text = [
          `Recent test failures — ${new Date().toUTCString()}`,
          `Count: ${rows.length}`,
          '',
          ...rows,
        ].join('\n');

        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text }] };
      } catch (e) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'text/plain',
            text: `Error fetching recent test failures: ${(e as Error).message}`,
          }],
        };
      }
    }
  );
}
