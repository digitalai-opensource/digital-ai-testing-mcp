import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listTransactions, getTransaction } from '../api/transactions.js';
import { performanceTransaction } from '../api/webdriver.js';
import { getActiveKeyType } from '../api/client.js';
import type { Transaction } from '../types/digital-ai.js';
import { outputFormatParam, respond } from '../utils/output-format.js';
import {
  buildComparison,
  buildConfoundAssessment,
  buildOutlierReport,
  type SideSelector,
  type TransactionFilter,
  type PerfMetric,
} from '../utils/performance-comparison.js';
import type { PerformanceComparison, ConfoundAssessment } from '../types/digital-ai.js';

// All transaction data is Cloud Admin JWT only — project API keys 401 on the
// reporter transaction endpoints. Fail fast with an actionable message rather
// than surfacing a raw 401 from deep in the API layer.
function requireJwt(): string | null {
  if (getActiveKeyType() !== 'jwt') {
    return (
      'Cloud Admin JWT required. Performance transaction data is not accessible with a project API key ' +
      '(the reporter transaction endpoints return 401). Switch to a Cloud Admin JWT profile first: ' +
      'switch_environment("default").'
    );
  }
  return null;
}

// ─── Shared schema fragments ──────────────────────────────────────────────────

const filterShape = {
  appName: z.string().optional().describe('App package/bundle name (case-insensitive substring).'),
  appVersion: z.string().optional().describe('App version string (substring).'),
  transactionName: z.string().optional().describe('Transaction name, e.g. "Login" (substring).'),
  deviceOs: z.enum(['Android', 'iOS']).optional().describe('Device OS.'),
  deviceName: z.string().optional().describe('Full device name (substring).'),
  deviceModel: z.string().optional().describe('Device model code or name (substring), e.g. "SM-G991U".'),
  deviceVersion: z.string().optional().describe('OS version string (substring), e.g. "12.0".'),
  networkProfile: z.string().optional().describe('Network profile (substring); empty string matches transactions with no profile.'),
  projectName: z.string().optional().describe('Project name (substring).'),
  testId: z.number().int().optional().describe('Exact reporter test_id — use to compare two specific automation runs.'),
  startDate: z.string().optional().describe('ISO 8601 start of range (inclusive).'),
  endDate: z.string().optional().describe('ISO 8601 end of range (inclusive).'),
};
const sideFilterSchema = z.object(filterShape).optional();

const comparisonDimensionEnum = z.enum([
  'appVersion', 'deviceModel', 'deviceOs', 'deviceVersion',
  'networkProfile', 'deviceName', 'projectName', 'name', 'region', 'testId',
]);

const metricEnum = z.enum([
  'speedIndex', 'cpuAvg', 'memAvg', 'batteryAvg', 'duration',
  'totalDownloadedBytes', 'totalUploadedBytes',
]);

const METRIC_LABEL: Record<string, string> = {
  speedIndex: 'Speed Index', cpuAvg: 'CPU avg', memAvg: 'Memory avg', batteryAvg: 'Battery avg',
  duration: 'Duration', totalDownloadedBytes: 'Downloaded', totalUploadedBytes: 'Uploaded',
};

// Speed Index is a composite visual-progress score (area above the render curve,
// WebPageTest methodology), NOT elapsed time. A delta of N SI does NOT mean the
// screen rendered N ms sooner — it means cumulative rendering quality across the
// whole render window improved. Surface this everywhere the metric appears (v42).
const SPEED_INDEX_SEMANTICS =
  'area above the visual-progress curve (WebPageTest methodology); a lower value means content was visible ' +
  'more completely earlier across the render window. A delta is NOT a shift in render-completion time.';
const SPEED_INDEX_SEMANTICS_SHORT = 'area above the visual-progress curve; lower = content visible earlier';

// Force speedIndex to be present and first so it always anchors outlier exclusion
// and delta ranking. Returns the normalized list and whether it was adjusted (v42 FP2).
function normalizeMetrics(requested: string[] | undefined): { metrics: PerfMetric[]; adjusted: boolean } {
  const base = (requested && requested.length ? [...requested] : ['speedIndex']) as PerfMetric[];
  if (base[0] === 'speedIndex') return { metrics: base, adjusted: false };
  const without = base.filter((m) => m !== 'speedIndex');
  return { metrics: ['speedIndex', ...without], adjusted: true };
}

function buildSide(
  label: string,
  ids: number[] | undefined,
  filter: TransactionFilter | undefined
): SideSelector {
  return { label, transactionIds: ids, filter };
}

// Build the transaction pool the compute layer will resolve sides against.
//
// listTransactions() is PROJECT-SCOPED to the active JWT's reporter context, so
// transactions created under a different project's reporter instance are absent
// from it. getTransaction(id) is a direct GET that works across scopes. So:
//   - explicit IDs are always resolved directly (cross-scope, and bounded by the
//     number of IDs given — no full-list fetch when both sides are explicit);
//   - the bulk list is fetched ONLY when a side uses a filter (which needs it).
async function gatherPool(sides: SideSelector[]): Promise<Transaction[]> {
  const pool = new Map<number, Transaction>();
  const needList = sides.some((s) => !s.transactionIds || s.transactionIds.length === 0);
  if (needList) {
    for (const t of await listTransactions()) pool.set(t.id, t);
  }
  const explicitIds = [...new Set(sides.flatMap((s) => s.transactionIds ?? []))];
  const missing = explicitIds.filter((id) => !pool.has(id));
  const fetched = await Promise.all(missing.map((id) => getTransaction(id).catch(() => null)));
  for (const t of fetched) if (t) pool.set(t.id, t);
  return [...pool.values()];
}

function num(n: number | null | undefined, digits = 1): string {
  return n == null ? 'n/a' : n.toFixed(digits);
}

// ─── Human-readable renderers ─────────────────────────────────────────────────

function renderComparison(cmp: PerformanceComparison): string {
  const lines: string[] = [
    `📊 Performance comparison — "${cmp.sideA.label}" (A) vs "${cmp.sideB.label}" (B)`,
    `   A: ${cmp.sideA.n} sample(s)${cmp.sideA.excludedIds.length ? ` (excluded ${cmp.sideA.excludedIds.length} outlier: ${cmp.sideA.excludedIds.join(', ')})` : ''}`,
    `   B: ${cmp.sideB.n} sample(s)${cmp.sideB.excludedIds.length ? ` (excluded ${cmp.sideB.excludedIds.length} outlier: ${cmp.sideB.excludedIds.join(', ')})` : ''}`,
    `   Outlier exclusion: ${cmp.outlierExclusionApplied ? `on (MAD, trim ${(cmp.trimFraction * 100).toFixed(0)}%)` : 'off'}`,
    '',
  ];
  for (const m of cmp.metrics) {
    const a = m.sideA, b = m.sideB;
    const pct = m.percentChangeTrimmedMean;
    const dir = pct == null ? '' : pct > 0 ? ' ▲' : pct < 0 ? ' ▼' : ' ●';
    const composite = m.metric === 'speedIndex' ? '  ⚠️ composite visual-progress score, NOT elapsed time' : '';
    lines.push(`  ${METRIC_LABEL[m.metric] ?? m.metric} (${m.unit})${composite}`);
    lines.push(`    A  trimmed=${num(a.trimmedMean)} median=${num(a.median)} mean=${num(a.mean)}  [min ${num(a.min)} / max ${num(a.max)}]  n=${a.n}  CV=${a.cv == null ? 'n/a' : (a.cv * 100).toFixed(1) + '%'}`);
    lines.push(`    B  trimmed=${num(b.trimmedMean)} median=${num(b.median)} mean=${num(b.mean)}  [min ${num(b.min)} / max ${num(b.max)}]  n=${b.n}  CV=${b.cv == null ? 'n/a' : (b.cv * 100).toFixed(1) + '%'}`);
    lines.push(`    Δ  trimmed=${num(m.deltaTrimmedMean)} median=${num(m.deltaMedian)} mean=${num(m.deltaMean)}${pct == null ? '' : `  (${pct > 0 ? '+' : ''}${pct.toFixed(1)}% on trimmed mean)${dir}`}`);
    lines.push('');
  }
  for (const n of cmp.notes) lines.push(`  ⚠️ ${n}`);
  return lines.join('\n');
}

function renderConfounds(a: ConfoundAssessment): string {
  const icon = a.validity === 'clean' ? '✅' : a.validity === 'caveated' ? '⚠️' : '⛔';
  const sevIcon: Record<string, string> = { high: '⛔', medium: '⚠️', low: 'ℹ️', info: 'ℹ️' };
  const lines: string[] = [
    `${icon} Confound assessment — validity: ${a.validity.toUpperCase()}`,
    `   Declared comparison axis: ${a.comparisonAxis.join(', ') || '(none)'}`,
    '',
    `   ${a.summary}`,
    '',
  ];
  if (a.flags.length === 0) {
    lines.push('   No confounding factors detected.');
  } else {
    lines.push('   Factors:');
    for (const f of a.flags) {
      lines.push(`     ${sevIcon[f.severity]} [${f.severity}/${f.kind}] ${f.dimension}: ${f.message}`);
    }
  }
  return lines.join('\n');
}

// ─── Tool registration ─────────────────────────────────────────────────────────

export function registerPerformanceTools(server: McpServer): void {
  // ── compare_performance_transactions ──────────────────────────────────────
  server.tool(
    'compare_performance_transactions',
    'Compare performance (Speed Index and optionally CPU/memory/battery/duration) between TWO sets of ' +
    'transactions, reporting trimmed mean, median, AND raw mean for each side plus the delta and % change. ' +
    'This is the analytical core of a performance comparison report — for the full guided sequence use the ' +
    'performance_comparison_report prompt. ' +
    'PREREQUISITE WORKFLOW — before trusting any delta this tool produces, you should already have: ' +
    '(a) confirmed via list_nv_servers that an NV server in the device region was ONLINE during the runs — ' +
    'Speed Index collected without active NV instrumentation is unreliable; ' +
    '(b) run detect_performance_outliers on each side and addressed flagged samples (needs ≥4 samples per side, ' +
    'or outlier exclusion is skipped); ' +
    '(c) run assess_comparison_confounds with the intended comparisonAxis and gotten a clean/caveated verdict. ' +
    'This tool\'s built-in MAD exclusion is a safety net, NOT a substitute for those steps. ' +
    'Define each side either by explicit transactionIds (from list_transactions) OR by a filter object ' +
    '(appVersion, deviceModel, networkProfile, etc.). Common comparisons: app v1 vs v2 on the same device; ' +
    'device A vs device B on the same app; one region vs another; two automation test scripts (by testId). ' +
    'STRONGLY RECOMMENDED: pass comparisonAxis (what is SUPPOSED to differ) so the tool also runs a confound check ' +
    'and tells you whether the delta is attributable to that axis or polluted by an uncontrolled factor — a raw delta ' +
    'without a confound check is easy to misread (e.g. a Speed Index gap that is really a device-model difference). ' +
    'Cloud Admin JWT required.',
    {
      sideALabel: z.string().describe('Human label for side A, e.g. "v1.0" or "Galaxy S21".'),
      sideBLabel: z.string().describe('Human label for side B, e.g. "v2.0" or "Pixel 7".'),
      sideATransactionIds: z.array(z.number().int()).optional().describe('Explicit transaction IDs for side A. Provide this OR sideAFilter.'),
      sideBTransactionIds: z.array(z.number().int()).optional().describe('Explicit transaction IDs for side B. Provide this OR sideBFilter.'),
      sideAFilter: sideFilterSchema.describe('Filter selecting side A transactions (used when sideATransactionIds is omitted).'),
      sideBFilter: sideFilterSchema.describe('Filter selecting side B transactions (used when sideBTransactionIds is omitted).'),
      metrics: z.array(metricEnum).optional().describe('Metrics to compare. Speed Index is ALWAYS included and forced to the front — it is the platform\'s primary UX latency signal and the anchor for outlier exclusion and delta ranking; if you omit it or list it later it is auto-inserted first. NOTE: speedIndex is a composite visual-progress score (' + SPEED_INDEX_SEMANTICS_SHORT + '), NOT a duration. Add cpuAvg/memAvg/batteryAvg/duration as secondary metrics. Default ["speedIndex"].'),
      comparisonAxis: z.array(comparisonDimensionEnum).optional().describe('The dimension(s) that are SUPPOSED to differ. When provided, a confound assessment is embedded in the result.'),
      trimFraction: z.number().min(0).max(0.49).optional().default(0.1).describe('Fraction trimmed from each end for the trimmed mean. Default 0.1 (10%).'),
      excludeOutliers: z.boolean().optional().default(true).describe('Drop MAD outliers (on the primary metric) before aggregating. Default true.'),
      outlierK: z.number().min(1).optional().default(3.5).describe('Modified z-score threshold for outlier exclusion. Default 3.5.'),
      outputFormat: outputFormatParam,
    },
    async (args) => {
      const jwtErr = requireJwt();
      if (jwtErr) return { content: [{ type: 'text', text: jwtErr }], isError: true };
      try {
        const sideA = buildSide(args.sideALabel, args.sideATransactionIds, args.sideAFilter as TransactionFilter | undefined);
        const sideB = buildSide(args.sideBLabel, args.sideBTransactionIds, args.sideBFilter as TransactionFilter | undefined);
        const all = await gatherPool([sideA, sideB]);

        const { metrics, adjusted } = normalizeMetrics(args.metrics);
        const cmp = buildComparison(all, sideA, sideB, {
          metrics,
          trimFraction: args.trimFraction,
          excludeOutliers: args.excludeOutliers,
          outlierK: args.outlierK,
        });
        if (adjusted) {
          cmp.notes.unshift('Speed Index was inserted as the primary metric (it anchors outlier exclusion and delta ranking).');
        }

        if (cmp.sideA.n === 0 || cmp.sideB.n === 0) {
          const which = [cmp.sideA.n === 0 ? `"${args.sideALabel}"` : null, cmp.sideB.n === 0 ? `"${args.sideBLabel}"` : null].filter(Boolean).join(' and ');
          return {
            content: [{ type: 'text', text: `No transactions matched side ${which}. Verify the IDs or widen the filter with list_transactions first.` }],
            isError: true,
          };
        }

        let confounds: ConfoundAssessment | undefined;
        if (args.comparisonAxis && args.comparisonAxis.length) {
          confounds = buildConfoundAssessment(all, sideA, sideB, args.comparisonAxis);
        }

        const structured = {
          comparison: cmp,
          metricSemantics: { speedIndex: { isCompositeMetric: true, unit: 'SI', meaning: SPEED_INDEX_SEMANTICS } },
          ...(confounds && { confounds }),
        };
        const human = [renderComparison(cmp), ...(confounds ? ['', renderConfounds(confounds)] : [])].join('\n');
        return respond(args.outputFormat, structured, human);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── assess_comparison_confounds ───────────────────────────────────────────
  server.tool(
    'assess_comparison_confounds',
    'Check whether a planned two-set performance comparison is sound, BEFORE trusting any delta. Given the two ' +
    'sides and the comparisonAxis (the dimension that is SUPPOSED to differ — e.g. "appVersion"), it flags every ' +
    'OTHER dimension (device model, OS, OS version, network profile, project, transaction name) that varies across ' +
    'or within the sides, plus transactions missing CPU/memory telemetry and sample-size imbalance. Returns a ' +
    'validity verdict: clean / caveated / confounded. Use this to scrub a comparison plan during the planning phase, ' +
    'or to explain why a surprising delta is untrustworthy. Cloud Admin JWT required.',
    {
      sideALabel: z.string().describe('Human label for side A.'),
      sideBLabel: z.string().describe('Human label for side B.'),
      sideATransactionIds: z.array(z.number().int()).optional().describe('Explicit transaction IDs for side A. Provide this OR sideAFilter.'),
      sideBTransactionIds: z.array(z.number().int()).optional().describe('Explicit transaction IDs for side B. Provide this OR sideBFilter.'),
      sideAFilter: sideFilterSchema.describe('Filter selecting side A transactions.'),
      sideBFilter: sideFilterSchema.describe('Filter selecting side B transactions.'),
      comparisonAxis: z.array(comparisonDimensionEnum).min(1).describe('The dimension(s) that SHOULD differ between sides. Everything else that differs is reported as a confound.'),
      outputFormat: outputFormatParam,
    },
    async (args) => {
      const jwtErr = requireJwt();
      if (jwtErr) return { content: [{ type: 'text', text: jwtErr }], isError: true };
      try {
        const sideA = buildSide(args.sideALabel, args.sideATransactionIds, args.sideAFilter as TransactionFilter | undefined);
        const sideB = buildSide(args.sideBLabel, args.sideBTransactionIds, args.sideBFilter as TransactionFilter | undefined);
        const all = await gatherPool([sideA, sideB]);
        const assessment = buildConfoundAssessment(all, sideA, sideB, args.comparisonAxis);
        return respond(args.outputFormat, { confounds: assessment }, renderConfounds(assessment));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── detect_performance_outliers ───────────────────────────────────────────
  server.tool(
    'detect_performance_outliers',
    'Flag outlier transactions within a SINGLE set using a robust median/MAD modified z-score (default threshold ' +
    '3.5). Returns each transaction with its score, the kept set, and the recommended exclusions — use it to decide ' +
    'which samples to re-run or drop before computing a comparison aggregate. Robust for the small samples (N=5–10) ' +
    'this workflow uses, where one bad run would inflate a standard-deviation bound enough to hide itself. ' +
    'Cloud Admin JWT required.',
    {
      label: z.string().optional().default('set').describe('Optional label for the set in output.'),
      transactionIds: z.array(z.number().int()).optional().describe('Explicit transaction IDs. Provide this OR filter.'),
      filter: sideFilterSchema.describe('Filter selecting the transactions (used when transactionIds is omitted).'),
      metric: metricEnum.optional().default('speedIndex').describe('Metric to test for outliers. Default speedIndex.'),
      outlierK: z.number().min(1).optional().default(3.5).describe('Modified z-score threshold. Default 3.5.'),
      outputFormat: outputFormatParam,
    },
    async (args) => {
      const jwtErr = requireJwt();
      if (jwtErr) return { content: [{ type: 'text', text: jwtErr }], isError: true };
      try {
        const sel = buildSide(args.label ?? 'set', args.transactionIds, args.filter as TransactionFilter | undefined);
        const all = await gatherPool([sel]);
        const report = buildOutlierReport(all, sel, args.metric as PerfMetric, args.outlierK);

        const lines: string[] = [
          `🔍 Outlier scan on ${METRIC_LABEL[report.metric] ?? report.metric} (${report.unit}) — "${args.label}"`,
          `   median=${num(report.median)} scaledMAD=${num(report.madScaled)} threshold=±${report.threshold}` +
            (report.degenerate ? '  (MAD=0: >50% identical values — no scoring possible)' : ''),
          '',
        ];
        for (const e of report.entries) {
          lines.push(`   ${e.isOutlier ? '⛔' : '  '} tx ${e.transactionId} (${e.deviceName}): ${num(e.value)} ${report.unit}  z=${num(e.score, 2)}${e.isOutlier ? '  ← OUTLIER' : ''}`);
        }
        if (report.missingMetricIds.length) {
          lines.push('', `   ⚠️ No ${report.metric} value: ${report.missingMetricIds.join(', ')}`);
        }
        lines.push('', `   Keep: ${report.keptTransactionIds.join(', ') || '—'}`);
        if (report.outlierTransactionIds.length) lines.push(`   Exclude/re-run: ${report.outlierTransactionIds.join(', ')}`);

        return respond(args.outputFormat, { outliers: report }, lines.join('\n'));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── performance_transaction_control (phase 2 — generate fresh samples) ─────
  server.tool(
    'performance_transaction_control',
    'Generate a FRESH performance transaction inside a live inspection session (start_inspection_session). ' +
    'Call action:"start" with a networkProfile, then perform ONLY the UI steps you want measured using the normal ' +
    'tap_element / type_into_element / launch_app tools, then call action:"end" with a transactionName. The platform ' +
    'records CPU/memory/battery/network + Speed Index for the window between start and end. ' +
    'Use networkProfile:"Monitor" to measure current performance WITHOUT throttling (the usual choice); only pass a ' +
    'throttling profile ("3G-average", "wifi", …) when constrained network conditions ARE what you want to measure. ' +
    'WORKFLOW for a comparison sample series: per comparison point, repeat [start → run the SAME verified flow → end] ' +
    'N times. The flow MUST be verified first (real selectors from get_element_tree — never fabricated), or every ' +
    'sample is garbage. ' +
    'PRE-REQUISITE: the NV server for the device\'s region must be ONLINE and tunnel-connected — verify with ' +
    'list_nv_servers(region=<device region>) BEFORE starting, or the transaction silently records nothing. ' +
    'CAVEATS: (1) a THROTTLING profile activates NV shaping immediately — an app doing background network on the ' +
    'measured screen may ANR; keep the window tight. "Monitor" is pass-through and carries no such risk. ' +
    '(2) The recorded transaction appears in the reporter ~1 minute AFTER end (not instantly) — wait, then read it ' +
    'with list_transactions(transactionName, deviceName, startDate) → get_transaction. ' +
    '(3) networkProfile must exist on the NV server ("Monitor" is broadly guaranteed; others are deployment-specific). ' +
    'Reading the resulting transactions back requires a Cloud Admin JWT.',
    {
      handle: z.string().describe('Inspection session handle from start_inspection_session.'),
      action: z.enum(['start', 'end']).describe('"start" begins measurement (needs networkProfile); "end" finalizes it (needs transactionName).'),
      networkProfile: z.string().optional().describe('NV network profile for action:"start". Use "Monitor" to observe without throttling (default choice); "3G-average"/"wifi" apply network conditions. Required to start; must exist on the NV server.'),
      transactionName: z.string().optional().describe('Name for action:"end", e.g. "Login". This is how you find the record afterward via list_transactions.'),
    },
    async (args) => {
      try {
        const result = await performanceTransaction(args.handle, args.action, {
          networkProfile: args.networkProfile,
          transactionName: args.transactionName,
        });
        return { content: [{ type: 'text', text: `✅ ${result}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error (${args.action} performance transaction): ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
