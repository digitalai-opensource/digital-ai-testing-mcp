import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listTransactions, getTransaction } from '../api/transactions.js';
import {
  formatTransactionList,
  formatTransaction,
} from '../utils/response-formatter.js';
import { applyMaxResults, appendTruncationNotice } from '../utils/pagination.js';
import { outputFormatParam, respond } from '../utils/output-format.js';
import type { Transaction } from '../types/digital-ai.js';

// Transaction endpoints work for all access levels. Cloud Admin sees all projects;
// project-level keys (Project Admin and Project User) see only their own project.
// Server-side filtering is CSRF-blocked; all filters are applied client-side.

export function registerTransactionTools(server: McpServer): void {
  server.tool(
    'list_transactions',
    'List performance transaction records — instrumented segments of mobile test sessions ' +
    'that capture CPU, memory, battery, network, and Speed Index metrics between developer-marked start/end points. ' +
    'Use this for performance regression analysis: compare metrics across app versions, devices, or network profiles. ' +
    'SPEED INDEX is a composite visual-progress score (WebPageTest methodology — the integral of (1 − VisualCompletion(t)) ' +
    'over the render window), NOT a duration: a lower value means content was visible more completely earlier in the ' +
    'render window. Do not read a Speed Index delta as "rendered N ms sooner". ' +
    'If these transactions were collected without a verified NV server connection (see list_nv_servers), Speed Index ' +
    'values may be invalid. ' +
    'Server-side filtering is not available; all filters are applied client-side. ' +
    'All access levels — project keys see only their own project\'s transactions.',
    {
      appName: z.string().optional().describe('Filter by app package/bundle name (case-insensitive substring match).'),
      appVersion: z.string().optional().describe('Filter by app version string (case-insensitive substring match).'),
      transactionName: z.string().optional().describe('Filter by transaction name (case-insensitive substring match, e.g. "Login", "Checkout").'),
      deviceOs: z.enum(['Android', 'iOS']).optional().describe('Filter by device OS.'),
      deviceName: z.string().optional().describe('Filter by device name (case-insensitive substring match).'),
      networkProfile: z.string().optional().describe('Filter by network profile name (case-insensitive substring match). Empty string to find transactions with no network profile.'),
      startDate: z.string().optional().describe('ISO 8601 start of date range (inclusive), e.g. "2026-01-01".'),
      endDate: z.string().optional().describe('ISO 8601 end of date range (inclusive), e.g. "2026-06-01".'),
      minDurationMs: z.number().optional().describe('Minimum transaction duration in milliseconds.'),
      maxDurationMs: z.number().optional().describe('Maximum transaction duration in milliseconds.'),
      projectId: z.number().int().optional().describe('Filter by project ID.'),
      maxResults: z.number().optional().default(50).describe('Maximum number of results to return (default: 50).'),
      outputFormat: outputFormatParam,
    },
    async ({ appName, appVersion, transactionName, deviceOs, deviceName, networkProfile, startDate, endDate, minDurationMs, maxDurationMs, projectId, maxResults, outputFormat }) => {
      try {
        let txs = await listTransactions();

        if (appName) {
          const q = appName.toLowerCase();
          txs = txs.filter(t => t.appName.toLowerCase().includes(q));
        }
        if (appVersion) {
          const q = appVersion.toLowerCase();
          txs = txs.filter(t => t.appVersion.toLowerCase().includes(q));
        }
        if (transactionName) {
          const q = transactionName.toLowerCase();
          txs = txs.filter(t => t.name.toLowerCase().includes(q));
        }
        if (deviceOs) {
          txs = txs.filter(t => t.deviceOs === deviceOs);
        }
        if (deviceName) {
          const q = deviceName.toLowerCase();
          txs = txs.filter(t => t.deviceName.toLowerCase().includes(q));
        }
        if (networkProfile !== undefined) {
          if (networkProfile === '') {
            txs = txs.filter(t => !t.networkProfile);
          } else {
            const q = networkProfile.toLowerCase();
            txs = txs.filter(t => t.networkProfile.toLowerCase().includes(q));
          }
        }
        if (startDate) {
          const start = new Date(startDate).getTime();
          txs = txs.filter(t => new Date(t.startTime).getTime() >= start);
        }
        if (endDate) {
          const end = new Date(endDate + 'T23:59:59Z').getTime();
          txs = txs.filter(t => new Date(t.startTime).getTime() <= end);
        }
        if (minDurationMs !== undefined) {
          txs = txs.filter(t => t.duration >= minDurationMs);
        }
        if (maxDurationMs !== undefined) {
          txs = txs.filter(t => t.duration <= maxDurationMs);
        }
        if (projectId !== undefined) {
          txs = txs.filter(t => t.projectId === projectId);
        }

        // Sort newest first by default
        txs = [...txs].sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

        const paged = applyMaxResults(txs, maxResults);
        const structured = {
          total: paged.total,
          returned: paged.returned,
          truncated: paged.truncated,
          transactions: paged.items.map(t => ({
            id: t.id,
            name: t.name,
            appName: t.appName,
            appVersion: t.appVersion,
            date: t.date,
            startTime: t.startTime,
            duration: t.duration,
            deviceOs: t.deviceOs,
            deviceVersion: t.deviceVersion,
            deviceName: t.deviceName,
            networkProfile: t.networkProfile,
            cpuAvg: t.cpuAvg,
            cpuMax: t.cpuMax,
            memAvg: t.memAvg,
            memMax: t.memMax,
            batteryAvg: t.batteryAvg,
            totalUploadedBytes: t.totalUploadedBytes,
            totalDownloadedBytes: t.totalDownloadedBytes,
            speedIndex: t.speedIndex,
            testId: t.testId,
            projectId: t.projectId,
          })),
        };
        const humanText = appendTruncationNotice(
          `Found ${paged.total} transaction(s):\n\n${formatTransactionList(paged.items)}`,
          paged
        );
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_transaction',
    'Get full details for a single performance transaction, including time-series sample arrays for CPU, memory, battery, ' +
    'and network metrics sampled throughout the transaction duration. Use this to drill into a specific transaction after ' +
    'identifying it via list_transactions. Works with all access levels.',
    {
      transactionId: z.number().int().describe('Numeric transaction ID from list_transactions.'),
      outputFormat: outputFormatParam,
    },
    async ({ transactionId, outputFormat }) => {
      try {
        const tx = await getTransaction(transactionId);
        const structured = {
          ...tx,
          sampleCounts: {
            cpu: tx.cpuSamples?.length ?? 0,
            memory: tx.memorySamples?.length ?? 0,
            battery: tx.batterySamples?.length ?? 0,
            networkDownload: tx.networkDownloadSamples?.length ?? 0,
            networkUpload: tx.networkUploadSamples?.length ?? 0,
          },
        };
        return respond(outputFormat, structured as object, formatTransaction(tx));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_transaction_performance_summary',
    'Aggregate performance metrics across transactions for regression and hardware analysis. ' +
    'NOTE: avgCpuPct can legitimately exceed 100 on iOS — the platform reports CPU per-core ' +
    '(e.g. 119% on a dual-core device running one core at 100% and one at 19%). This is expected ' +
    'and preserved as-is because it carries diagnostic value for identifying CPU saturation. ' +
    'groupBy controls what dimension is compared:\n' +
    '  "appVersion" — compare how metrics changed across releases (regression testing)\n' +
    '  "name" — find which transaction types (Login, Checkout, etc.) are slowest\n' +
    '  "deviceModel" — compare Speed Index and CPU across device models (hardware analysis)\n' +
    '  "deviceType" — compare PHONE vs TABLET performance\n' +
    '  "deviceScreen" — compare by screen resolution\n' +
    '  "deviceName" — compare by full device name\n' +
    '  "networkProfile" — compare performance under different network conditions\n' +
    'Results are sorted by avgSpeedIndex descending so the worst-performing group appears first. ' +
    'avgSpeedIndex is a composite visual-progress score (area above the progressive-render curve), NOT elapsed time. ' +
    'Compare it directionally (lower is better) but do not interpret a delta as a shift in render-completion time. ' +
    'Accepts the same filters as list_transactions to scope the analysis. ' +
    'All access levels — project keys see only their own project\'s transactions.',
    {
      groupBy: z
        .enum(['appVersion', 'name', 'deviceModel', 'deviceType', 'deviceScreen', 'deviceName', 'networkProfile'])
        .default('appVersion')
        .describe('Dimension to group and aggregate by. Use "deviceModel" or "deviceType" for hardware comparison.'),
      appName: z.string().optional().describe('Scope to this app (case-insensitive substring match).'),
      appVersion: z.string().optional().describe('Scope to this app version (case-insensitive substring match). Useful with groupBy=deviceModel.'),
      transactionName: z.string().optional().describe('Scope to transactions with this name (substring match).'),
      deviceOs: z.enum(['Android', 'iOS']).optional().describe('Scope to one OS.'),
      deviceName: z.string().optional().describe('Scope to a specific device (substring match).'),
      networkProfile: z.string().optional().describe('Scope to a specific network profile.'),
      startDate: z.string().optional().describe('ISO 8601 start of date range.'),
      endDate: z.string().optional().describe('ISO 8601 end of date range.'),
      outputFormat: outputFormatParam,
    },
    async ({ groupBy, appName, appVersion, transactionName, deviceOs, deviceName, networkProfile, startDate, endDate, outputFormat }) => {
      try {
        let txs = await listTransactions();

        if (appName) { const q = appName.toLowerCase(); txs = txs.filter(t => t.appName.toLowerCase().includes(q)); }
        if (appVersion) { const q = appVersion.toLowerCase(); txs = txs.filter(t => t.appVersion.toLowerCase().includes(q)); }
        if (transactionName) { const q = transactionName.toLowerCase(); txs = txs.filter(t => t.name.toLowerCase().includes(q)); }
        if (deviceOs) { txs = txs.filter(t => t.deviceOs === deviceOs); }
        if (deviceName) { const q = deviceName.toLowerCase(); txs = txs.filter(t => t.deviceName.toLowerCase().includes(q)); }
        if (networkProfile !== undefined) {
          txs = networkProfile === '' ? txs.filter(t => !t.networkProfile) : txs.filter(t => t.networkProfile.toLowerCase().includes(networkProfile.toLowerCase()));
        }
        if (startDate) { const start = new Date(startDate).getTime(); txs = txs.filter(t => new Date(t.startTime).getTime() >= start); }
        if (endDate) { const end = new Date(endDate + 'T23:59:59Z').getTime(); txs = txs.filter(t => new Date(t.startTime).getTime() <= end); }

        if (txs.length === 0) {
          return respond(outputFormat, { groups: [] }, 'No transactions match the specified filters.');
        }

        // Extract the grouping key from a transaction
        const getKey = (t: Transaction): string => {
          switch (groupBy) {
            case 'appVersion':    return t.appVersion || 'unknown';
            case 'name':          return t.name;
            case 'deviceModel':   return t.deviceModel || 'unknown';
            case 'deviceType':    return t.deviceType || 'unknown';
            case 'deviceScreen':  return t.deviceScreen || 'unknown';
            case 'deviceName':    return t.deviceName || 'unknown';
            case 'networkProfile': return t.networkProfile || '(none)';
          }
        };

        const groups: Record<string, Transaction[]> = {};
        for (const t of txs) {
          const key = getKey(t);
          if (!groups[key]) groups[key] = [];
          groups[key].push(t);
        }

        const avg = (arr: (number | null)[]): number | null => {
          const nums = arr.filter((v): v is number => v != null);
          return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
        };
        const max = (arr: (number | null)[]): number | null => {
          const nums = arr.filter((v): v is number => v != null);
          return nums.length ? Math.max(...nums) : null;
        };
        const min = (arr: (number | null)[]): number | null => {
          const nums = arr.filter((v): v is number => v != null);
          return nums.length ? Math.min(...nums) : null;
        };

        const aggregated = Object.entries(groups)
          .map(([key, group]) => ({
            [groupBy]: key,
            count: group.length,
            avgSpeedIndex: avg(group.map(t => t.speedIndex)),
            minSpeedIndex: min(group.map(t => t.speedIndex)),
            maxSpeedIndex: max(group.map(t => t.speedIndex)),
            avgDurationMs: avg(group.map(t => t.duration)),
            maxDurationMs: max(group.map(t => t.duration)),
            avgCpuPct: avg(group.map(t => t.cpuAvg)),
            maxCpuPct: max(group.map(t => t.cpuMax)),
            avgMemMB: avg(group.map(t => t.memAvg)),
            maxMemMB: max(group.map(t => t.memMax)),
            avgBatteryMW: avg(group.map(t => t.batteryAvg)),
            totalUploadedBytes: group.reduce((s, t) => s + t.totalUploadedBytes, 0),
            totalDownloadedBytes: group.reduce((s, t) => s + t.totalDownloadedBytes, 0),
          }))
          // Sort worst Speed Index first so regressions/outliers surface immediately
          .sort((a, b) => (b.avgSpeedIndex ?? 0) - (a.avgSpeedIndex ?? 0));

        const structured = { groupBy, totalTransactions: txs.length, groups: aggregated };

        // Human-readable output
        const label: Record<string, string> = {
          appVersion: 'App Version', name: 'Transaction Name', deviceModel: 'Device Model',
          deviceType: 'Device Type', deviceScreen: 'Screen Resolution',
          deviceName: 'Device Name', networkProfile: 'Network Profile',
        };
        const lines = [
          `📊 Performance Summary by ${label[groupBy]} (${txs.length} transactions across ${aggregated.length} groups)`,
          `   Sorted by avg Speed Index (highest = slowest rendering first)\n`,
        ];
        for (const g of aggregated) {
          const si = g.avgSpeedIndex != null ? `${g.avgSpeedIndex.toFixed(0)} SI` : 'n/a';
          const siRange = g.minSpeedIndex != null && g.maxSpeedIndex != null
            ? ` [${g.minSpeedIndex}–${g.maxSpeedIndex} SI]` : '';
          const dur = g.avgDurationMs != null ? `${(g.avgDurationMs / 1000).toFixed(2)}s` : 'n/a';
          const cpu = g.avgCpuPct != null ? `${g.avgCpuPct.toFixed(1)}%` : 'n/a';
          const mem = g.avgMemMB != null ? `${g.avgMemMB.toFixed(0)}MB` : 'n/a';
          lines.push(`  ${g[groupBy as keyof typeof g]} (${g.count} runs)`);
          lines.push(`    Speed Index: ${si}${siRange} | Duration: ${dur} | CPU: ${cpu} | Mem: ${mem}`);
        }

        return respond(outputFormat, structured, lines.join('\n'));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── get_performance_trend ────────────────────────────────────────────────

  server.tool(
    'get_performance_trend',
    'Show how performance metrics (Speed Index, CPU, memory, duration) change over time, ' +
    'bucketed by day, week, or month. Use this to detect sprint-over-sprint regressions, ' +
    'confirm that a performance fix held, or identify when a regression was introduced. ' +
    'Accepts the same filters as list_transactions. All access levels — project keys see only their own project\'s transactions.',
    {
      bucketBy: z.enum(['day', 'week', 'month']).optional().default('week')
        .describe('Time bucket size: "day", "week" (default), or "month".'),
      lookbackDays: z.number().int().min(1).max(730).optional().default(90)
        .describe('How many days back to analyse (default: 90).'),
      appName: z.string().optional().describe('Scope to this app (substring match).'),
      appVersion: z.string().optional().describe('Scope to this app version (substring match).'),
      transactionName: z.string().optional().describe('Scope to transactions with this name.'),
      deviceOs: z.enum(['Android', 'iOS']).optional().describe('Scope to one OS.'),
      networkProfile: z.string().optional().describe('Scope to a specific network profile.'),
      outputFormat: outputFormatParam,
    },
    async ({ bucketBy, lookbackDays, appName, appVersion, transactionName, deviceOs, networkProfile, outputFormat }) => {
      try {
        let txs = await listTransactions();

        const cutoff = Date.now() - lookbackDays * 86400000;
        txs = txs.filter(t => new Date(t.startTime ?? t.startTime).getTime() >= cutoff);

        if (appName)          { const q = appName.toLowerCase(); txs = txs.filter(t => t.appName.toLowerCase().includes(q)); }
        if (appVersion)       { const q = appVersion.toLowerCase(); txs = txs.filter(t => t.appVersion.toLowerCase().includes(q)); }
        if (transactionName)  { const q = transactionName.toLowerCase(); txs = txs.filter(t => t.name.toLowerCase().includes(q)); }
        if (deviceOs)         { txs = txs.filter(t => t.deviceOs === deviceOs); }
        if (networkProfile !== undefined) {
          txs = networkProfile === ''
            ? txs.filter(t => !t.networkProfile)
            : txs.filter(t => t.networkProfile.toLowerCase().includes(networkProfile.toLowerCase()));
        }

        if (txs.length === 0) {
          return respond(outputFormat, { buckets: [] },
            `No transactions found in the last ${lookbackDays} days matching the specified filters.`);
        }

        const bucketKey = (iso: string): string => {
          const d = new Date(iso);
          if (bucketBy === 'month')  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
          if (bucketBy === 'week') {
            const day = d.getUTCDay() || 7;
            const monday = new Date(d);
            monday.setUTCDate(d.getUTCDate() - (day - 1));
            return monday.toISOString().slice(0, 10);
          }
          return d.toISOString().slice(0, 10);
        };

        const buckets: Record<string, { count: number; speedIndex: number[]; duration: number[]; cpu: number[]; mem: number[] }> = {};
        for (const t of txs) {
          const key = bucketKey(t.startTime);
          if (!buckets[key]) buckets[key] = { count: 0, speedIndex: [], duration: [], cpu: [], mem: [] };
          const b = buckets[key];
          b.count++;
          if (t.speedIndex != null) b.speedIndex.push(t.speedIndex);
          if (t.duration != null) b.duration.push(t.duration);
          if (t.cpuAvg != null) b.cpu.push(t.cpuAvg);
          if (t.memAvg != null) b.mem.push(t.memAvg);
        }

        const avgOf = (arr: number[]): number | null =>
          arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
        const fmt1 = (n: number | null, unit = '') => n == null ? 'n/a' : `${n.toFixed(1)}${unit}`;

        const sorted = Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b));
        const structured = {
          bucketBy, lookbackDays,
          totalTransactions: txs.length,
          buckets: sorted.map(([period, b]) => ({
            period,
            count: b.count,
            avgSpeedIndex: avgOf(b.speedIndex) != null ? parseFloat(avgOf(b.speedIndex)!.toFixed(0)) : null,
            avgDurationMs: avgOf(b.duration) != null ? parseFloat(avgOf(b.duration)!.toFixed(0)) : null,
            avgCpuPct: avgOf(b.cpu) != null ? parseFloat(avgOf(b.cpu)!.toFixed(1)) : null,
            avgMemMB: avgOf(b.mem) != null ? parseFloat(avgOf(b.mem)!.toFixed(0)) : null,
          })),
        };

        const lines = [
          `📈 Performance trend (${bucketBy === 'week' ? 'weekly' : bucketBy === 'month' ? 'monthly' : 'daily'}, last ${lookbackDays} days — ${txs.length} transactions)\n`,
          `  ${'Period'.padEnd(12)} ${'Runs'.padStart(5)} ${'SpeedIdx'.padStart(9)} ${'Duration'.padStart(9)} ${'CPU%'.padStart(6)} ${'Mem MB'.padStart(7)}`,
          `  ${'─'.repeat(52)}`,
          ...sorted.map(([period, b]) => {
            const si  = fmt1(avgOf(b.speedIndex), ' SI');
            const dur = avgOf(b.duration) != null ? `${(avgOf(b.duration)! / 1000).toFixed(2)}s` : 'n/a';
            const cpu = fmt1(avgOf(b.cpu), '%');
            const mem = avgOf(b.mem) != null ? `${avgOf(b.mem)!.toFixed(0)}` : 'n/a';
            return `  ${period.padEnd(12)} ${String(b.count).padStart(5)} ${si.padStart(9)} ${dur.padStart(9)} ${cpu.padStart(6)} ${mem.padStart(7)}`;
          }),
        ];
        return respond(outputFormat, structured, lines.join('\n'));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
