import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAllDevices } from '../api/devices.js';
import { listTests } from '../api/reporting.js';

export function registerResources(server: McpServer): void {
  // ─── Device Farm Status ────────────────────────────────────────────────────
  // Pulled on demand by the LLM for ambient context — gives a quick picture of
  // the farm without the user having to ask get_device_health_summary first.

  server.resource(
    'device-farm-status',
    'digital-ai://farm/status',
    { description: 'Live device farm status: counts by availability, OS, and agent health.' },
    async (uri) => {
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
    }
  );

  // ─── Recent Test Failures ──────────────────────────────────────────────────
  // Surfaces the last 20 failed tests so the LLM has triage context immediately.

  server.resource(
    'recent-test-failures',
    'digital-ai://reporting/recent-failures',
    { description: 'The 20 most recent failed test executions across all projects.' },
    async (uri) => {
      const result = await listTests({
        limit: 20,
        page: 1,
        filter: [{ property: 'status', operator: '=', value: 'Failed' }],
        sort: [{ property: 'start_time', descending: true }],
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
    }
  );
}
