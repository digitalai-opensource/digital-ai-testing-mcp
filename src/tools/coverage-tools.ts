import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAllDevices } from '../api/devices.js';
import { getGroupedTests } from '../api/reporting.js';
import { outputFormatParam, respond } from '../utils/output-format.js';

export function registerCoverageTools(server: McpServer): void {
  // ─── get_device_coverage_summary ─────────────────────────────────────────

  server.tool(
    'get_device_coverage_summary',
    'Cross-reference the device farm inventory against the test execution history to show ' +
    'which OS values, device models, and manufacturers have been exercised in tests vs. ' +
    'what is available in the farm. Also identifies devices that have never appeared in any test run. ' +
    'Use this to find coverage gaps before a release.',
    {
      projectId: z.number().int().optional().describe('Scope test history to this project ID.'),
      projectName: z.string().optional().describe('Scope test history to this project name.'),
      outputFormat: outputFormatParam,
    },
    async ({ projectId, projectName, outputFormat }) => {
      try {
        // Fetch in parallel: device inventory + test result groupings
        const [devices, osTested, modelTested] = await Promise.all([
          getAllDevices(),
          getGroupedTests({ groupBy: ['device.os'], returnTotalCount: false }, projectId, projectName) as Promise<{ data?: Array<Record<string, unknown>> }>,
          getGroupedTests({ groupBy: ['device.model'], returnTotalCount: false }, projectId, projectName) as Promise<{ data?: Array<Record<string, unknown>> }>,
        ]);

        // --- Inventory breakdown ---
        const invByOs: Record<string, number> = {};
        const invByModel: Record<string, number> = {};
        const invByMfg: Record<string, number> = {};
        const invByRegion: Record<string, number> = {};
        for (const d of devices) {
          invByOs[d.deviceOs] = (invByOs[d.deviceOs] ?? 0) + 1;
          invByModel[d.model || d.modelName || 'unknown'] = (invByModel[d.model || d.modelName || 'unknown'] ?? 0) + 1;
          invByMfg[d.manufacturer || 'unknown'] = (invByMfg[d.manufacturer || 'unknown'] ?? 0) + 1;
          invByRegion[d.region || 'unknown'] = (invByRegion[d.region || 'unknown'] ?? 0) + 1;
        }

        // --- Tested set ---
        const osTestedRows = (osTested?.data ?? (Array.isArray(osTested) ? osTested : [])) as Array<Record<string, unknown>>;
        const modelTestedRows = (modelTested?.data ?? (Array.isArray(modelTested) ? modelTested : [])) as Array<Record<string, unknown>>;

        const testedOs = new Set(osTestedRows.map(r => String(r['device.os'] ?? '')).filter(Boolean));
        const testedModels = new Set(modelTestedRows.map(r => String(r['device.model'] ?? '')).filter(Boolean));

        const untestedOs = Object.keys(invByOs).filter(os => !testedOs.has(os));
        const untestedModels = Object.keys(invByModel).filter(m => !testedModels.has(m));

        const structured = {
          inventoryTotal: devices.length,
          byOs: Object.entries(invByOs).map(([os, count]) => ({
            os, inventoryCount: count, tested: testedOs.has(os),
          })),
          byModel: Object.entries(invByModel)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([model, count]) => ({ model, inventoryCount: count, tested: testedModels.has(model) })),
          byManufacturer: Object.entries(invByMfg).sort((a, b) => b[1] - a[1])
            .map(([mfg, count]) => ({ manufacturer: mfg, count })),
          byRegion: Object.entries(invByRegion).sort((a, b) => b[1] - a[1])
            .map(([region, count]) => ({ region, count })),
          untestedOsValues: untestedOs,
          untestedModelCount: untestedModels.length,
          note: modelTestedRows.length === 0
            ? 'device.model groupBy may not be supported on this deployment — model coverage is approximate'
            : undefined,
        };

        const lines = [
          `📱 Device Coverage Summary (${devices.length} devices in farm)\n`,
          '── OS Coverage ──',
          ...Object.entries(invByOs).map(([os, cnt]) => {
            const icon = testedOs.has(os) ? '✅' : '❌';
            return `  ${icon} ${os}: ${cnt} device(s) in farm${testedOs.has(os) ? ' — tested' : ' — NO TEST RESULTS FOUND'}`;
          }),
          '',
          '── Manufacturer Breakdown ──',
          ...Object.entries(invByMfg).sort((a, b) => b[1] - a[1]).map(([mfg, cnt]) =>
            `  • ${mfg}: ${cnt}`
          ),
          '',
          '── Regional Breakdown ──',
          ...Object.entries(invByRegion).sort((a, b) => b[1] - a[1]).map(([r, cnt]) =>
            `  • ${r}: ${cnt}`
          ),
          '',
          untestedOs.length > 0
            ? `⚠️  OS values in inventory with no test history: ${untestedOs.join(', ')}`
            : '✅ All OS values in inventory have test history',
          testedModels.size > 0
            ? `   Models with test history: ${testedModels.size} of ${Object.keys(invByModel).length} in farm`
            : '   (device.model grouping unavailable on this deployment)',
        ];
        return respond(outputFormat, structured, lines.join('\n'));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── get_regional_test_coverage ──────────────────────────────────────────

  server.tool(
    'get_regional_test_coverage',
    'Show the device farm composition broken down by region (US1, SG1, UK1, etc.), ' +
    'including device counts, OS split, and current availability per region. ' +
    'Note: test result records do not carry a region field directly, so this tool shows ' +
    'infrastructure coverage (what is available where) rather than execution coverage. ' +
    'Pair with list_devices filtered by @region to drill into a specific region.',
    {
      outputFormat: outputFormatParam,
    },
    async ({ outputFormat }) => {
      try {
        const devices = await getAllDevices();

        // Group by region
        const regions: Record<string, {
          total: number; available: number; offline: number; inUse: number; other: number;
          ios: number; android: number;
        }> = {};

        for (const d of devices) {
          const r = d.region || d.agentLocation || 'unknown';
          if (!regions[r]) regions[r] = { total: 0, available: 0, offline: 0, inUse: 0, other: 0, ios: 0, android: 0 };
          regions[r].total++;
          const st = d.displayStatus.toLowerCase();
          if (st === 'available') regions[r].available++;
          else if (st === 'offline' || st === 'error') regions[r].offline++;
          else if (st === 'in use' || st === 'reserved') regions[r].inUse++;
          else regions[r].other++;
          if (d.deviceOs === 'iOS') regions[r].ios++;
          else if (d.deviceOs === 'Android') regions[r].android++;
        }

        const sorted = Object.entries(regions).sort((a, b) => b[1].total - a[1].total);

        const structured = {
          totalDevices: devices.length,
          regions: sorted.map(([name, r]) => ({
            region: name,
            total: r.total,
            available: r.available,
            offline: r.offline,
            inUse: r.inUse,
            other: r.other,
            ios: r.ios,
            android: r.android,
            availabilityPct: parseFloat(((r.available / r.total) * 100).toFixed(1)),
          })),
        };

        const lines = [
          `🌍 Regional Device Coverage (${devices.length} devices across ${sorted.length} regions)\n`,
          `  ${'Region'.padEnd(10)} ${'Total'.padStart(6)} ${'Avail'.padStart(6)} ${'In Use'.padStart(7)} ${'Offline'.padStart(8)} ${'iOS'.padStart(5)} ${'Android'.padStart(8)} ${'Avail%'.padStart(7)}`,
          `  ${'─'.repeat(62)}`,
          ...sorted.map(([name, r]) => {
            const pct = ((r.available / r.total) * 100).toFixed(0);
            return `  ${name.padEnd(10)} ${String(r.total).padStart(6)} ${String(r.available).padStart(6)} ${String(r.inUse).padStart(7)} ${String(r.offline).padStart(8)} ${String(r.ios).padStart(5)} ${String(r.android).padStart(8)} ${(pct + '%').padStart(7)}`;
          }),
        ];
        return respond(outputFormat, structured, lines.join('\n'));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
