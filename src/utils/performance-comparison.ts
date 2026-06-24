// Domain compute for the performance-comparison tools. Pure functions over a
// Transaction[] that the caller has already fetched (via listTransactions) —
// no network here, so this whole module is unit-testable with fixture arrays.

import type {
  Transaction,
  ComparisonDimension,
  MetricComparison,
  PerformanceComparison,
  ConfoundFlag,
  ConfoundAssessment,
  ConfoundSeverity,
} from '../types/digital-ai.js';
import { summarizeMetric, detectOutliersMAD, median, mad } from './performance-stats.js';

// ─── Side selection ──────────────────────────────────────────────────────────

export interface TransactionFilter {
  appName?: string;
  appVersion?: string;
  transactionName?: string;   // matches Transaction.name
  deviceOs?: string;
  deviceName?: string;
  deviceModel?: string;
  deviceVersion?: string;
  networkProfile?: string;
  projectName?: string;
  testId?: number;
  startDate?: string;
  endDate?: string;
}

export interface SideSelector {
  label: string;
  transactionIds?: number[];
  filter?: TransactionFilter;
}

/** Resolve a side selector to concrete transactions from the full fetched list. */
export function resolveSide(allTxns: Transaction[], sel: SideSelector): Transaction[] {
  if (sel.transactionIds && sel.transactionIds.length > 0) {
    // Preserve caller order so excluded/missing IDs are easy to spot.
    const byId = new Map(allTxns.map((t) => [t.id, t]));
    return sel.transactionIds.map((id) => byId.get(id)).filter((t): t is Transaction => t != null);
  }
  const f = sel.filter ?? {};
  const sub = (field: string | undefined, q?: string) =>
    q == null || (field ?? '').toLowerCase().includes(q.toLowerCase());
  return allTxns.filter((t) => {
    if (!sub(t.appName, f.appName)) return false;
    if (!sub(t.appVersion, f.appVersion)) return false;
    if (!sub(t.name, f.transactionName)) return false;
    if (f.deviceOs && t.deviceOs !== f.deviceOs) return false;
    if (!sub(t.deviceName, f.deviceName)) return false;
    if (!sub(t.deviceModel, f.deviceModel)) return false;
    if (!sub(t.deviceVersion, f.deviceVersion)) return false;
    if (f.networkProfile !== undefined) {
      if (f.networkProfile === '') { if (t.networkProfile) return false; }
      else if (!sub(t.networkProfile, f.networkProfile)) return false;
    }
    if (!sub(t.projectName, f.projectName)) return false;
    if (f.testId !== undefined && t.testId !== f.testId) return false;
    if (f.startDate && new Date(t.startTime).getTime() < new Date(f.startDate).getTime()) return false;
    if (f.endDate && new Date(t.startTime).getTime() > new Date(f.endDate + 'T23:59:59Z').getTime()) return false;
    return true;
  });
}

// ─── Metric extraction ───────────────────────────────────────────────────────

export const SUPPORTED_METRICS = [
  'speedIndex', 'cpuAvg', 'memAvg', 'batteryAvg', 'duration',
  'totalDownloadedBytes', 'totalUploadedBytes',
] as const;
export type PerfMetric = (typeof SUPPORTED_METRICS)[number];

// Speed Index uses "SI" — NOT "ms". It is a composite visual-progress score
// (area above the render curve, WebPageTest methodology), not elapsed time;
// formatting it as "ms" invited reading a delta as "rendered N ms sooner" (v42).
const METRIC_UNITS: Record<PerfMetric, string> = {
  speedIndex: 'SI',
  cpuAvg: '%',
  memAvg: 'MB',
  batteryAvg: 'mW',
  duration: 'ms',
  totalDownloadedBytes: 'bytes',
  totalUploadedBytes: 'bytes',
};

function metricValue(t: Transaction, metric: PerfMetric): number | null {
  const v = t[metric];
  return typeof v === 'number' ? v : null;
}

// ─── Comparison ──────────────────────────────────────────────────────────────

export interface CompareOptions {
  metrics?: PerfMetric[];        // default ['speedIndex']
  trimFraction?: number;         // default 0.1
  excludeOutliers?: boolean;     // default true — exclude on the PRIMARY metric
  outlierK?: number;             // default 3.5
}

function delta(b: number | null, a: number | null): number | null {
  return b != null && a != null ? b - a : null;
}

export function buildComparison(
  allTxns: Transaction[],
  sideASel: SideSelector,
  sideBSel: SideSelector,
  opts: CompareOptions = {}
): PerformanceComparison {
  const metrics = (opts.metrics && opts.metrics.length ? opts.metrics : ['speedIndex']) as PerfMetric[];
  const primary = metrics[0];
  const trimFraction = opts.trimFraction ?? 0.1;
  const excludeOutliers = opts.excludeOutliers ?? true;
  const k = opts.outlierK ?? 3.5;
  const notes: string[] = [];

  const prepSide = (sel: SideSelector) => {
    const txns = resolveSide(allTxns, sel);
    let kept = txns;
    const excludedIds: number[] = [];

    if (excludeOutliers && txns.length >= 4) {
      // Outlier detection runs on the PRIMARY metric; flagged transactions are
      // dropped from every metric summary so all metrics describe the same runs.
      const vals = txns.map((t) => metricValue(t, primary));
      const present = txns.filter((_, i) => vals[i] != null);
      const presentVals = vals.filter((v): v is number => v != null);
      const res = detectOutliersMAD(presentVals, k);
      const outlierTxnIds = new Set(res.outlierIndices.map((i) => present[i].id));
      if (outlierTxnIds.size > 0) {
        kept = txns.filter((t) => !outlierTxnIds.has(t.id));
        excludedIds.push(...outlierTxnIds);
      }
    } else if (excludeOutliers && txns.length > 0 && txns.length < 4) {
      notes.push(`Side "${sel.label}": ${txns.length} sample(s) — too few for outlier detection (need ≥4), kept all.`);
    }

    return { sel, txns, kept, excludedIds };
  };

  const A = prepSide(sideASel);
  const B = prepSide(sideBSel);

  const metricComparisons: MetricComparison[] = metrics.map((metric) => {
    const aSum = summarizeMetric(A.kept.map((t) => metricValue(t, metric)), trimFraction);
    const bSum = summarizeMetric(B.kept.map((t) => metricValue(t, metric)), trimFraction);
    const baseA = aSum.trimmedMean ?? aSum.median ?? aSum.mean;
    const baseB = bSum.trimmedMean ?? bSum.median ?? bSum.mean;
    const dTrim = delta(baseB, baseA);
    return {
      metric,
      unit: METRIC_UNITS[metric],
      sideA: aSum,
      sideB: bSum,
      deltaTrimmedMean: dTrim,
      deltaMedian: delta(bSum.median, aSum.median),
      deltaMean: delta(bSum.mean, aSum.mean),
      percentChangeTrimmedMean:
        dTrim != null && baseA != null && baseA !== 0 ? (dTrim / baseA) * 100 : null,
    };
  });

  return {
    sideA: { label: A.sel.label, transactionIds: A.kept.map((t) => t.id), n: A.kept.length, excludedIds: A.excludedIds },
    sideB: { label: B.sel.label, transactionIds: B.kept.map((t) => t.id), n: B.kept.length, excludedIds: B.excludedIds },
    metrics: metricComparisons,
    outlierExclusionApplied: excludeOutliers,
    trimFraction,
    notes,
  };
}

// ─── Outlier report (single set) ─────────────────────────────────────────────

export interface OutlierReportEntry {
  transactionId: number;
  deviceName: string;
  value: number;
  score: number;       // modified z-score in scaled-MAD units
  isOutlier: boolean;
}

export interface OutlierReport {
  metric: PerfMetric;
  unit: string;
  median: number | null;
  madScaled: number | null;
  threshold: number;
  degenerate: boolean;
  entries: OutlierReportEntry[];
  keptTransactionIds: number[];
  outlierTransactionIds: number[];
  missingMetricIds: number[];   // transactions with no value for this metric
}

export function buildOutlierReport(
  allTxns: Transaction[],
  sel: SideSelector,
  metric: PerfMetric,
  k = 3.5
): OutlierReport {
  const txns = resolveSide(allTxns, sel);
  const withVal = txns
    .map((t) => ({ t, v: metricValue(t, metric) }))
    .filter((e): e is { t: Transaction; v: number } => e.v != null);
  const missingMetricIds = txns.filter((t) => metricValue(t, metric) == null).map((t) => t.id);

  const values = withVal.map((e) => e.v);
  const res = detectOutliersMAD(values, k);

  const entries: OutlierReportEntry[] = withVal.map((e, i) => ({
    transactionId: e.t.id,
    deviceName: e.t.deviceName,
    value: e.v,
    score: res.flags[i]?.score ?? 0,
    isOutlier: res.flags[i]?.isOutlier ?? false,
  }));

  return {
    metric,
    unit: METRIC_UNITS[metric],
    median: median(values),
    madScaled: mad(values),
    threshold: k,
    degenerate: res.degenerate,
    entries,
    keptTransactionIds: entries.filter((e) => !e.isOutlier).map((e) => e.transactionId),
    outlierTransactionIds: entries.filter((e) => e.isOutlier).map((e) => e.transactionId),
    missingMetricIds,
  };
}

// ─── Confound assessment ─────────────────────────────────────────────────────

// Dimensions present on the Transaction record we can actually inspect.
const DIM_ACCESSOR: Partial<Record<ComparisonDimension, (t: Transaction) => string>> = {
  appVersion: (t) => t.appVersion || '(none)',
  deviceModel: (t) => t.deviceModel || '(unknown)',
  deviceOs: (t) => t.deviceOs || '(unknown)',
  deviceVersion: (t) => t.deviceVersion || '(unknown)',
  networkProfile: (t) => t.networkProfile || '(none)',
  deviceName: (t) => t.deviceName || '(unknown)',
  projectName: (t) => t.projectName || '(none)',
  name: (t) => t.name || '(none)',
  testId: (t) => String(t.testId ?? '(none)'),
};

// How much a confounding difference in this dimension is likely to distort a
// performance comparison that is NOT about that dimension.
const DIM_SEVERITY: Record<string, ConfoundSeverity> = {
  deviceModel: 'high',
  deviceOs: 'high',
  deviceVersion: 'high',
  networkProfile: 'high',
  appVersion: 'high',
  deviceName: 'medium',  // distinct names can still be the same model
  projectName: 'low',
  name: 'medium',        // different transaction names rarely measure the same thing
  testId: 'low',
};

function distinct(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function hasTelemetry(t: Transaction): boolean {
  // 1894-style records report cpuAvg/memAvg of 0 with empty sample arrays —
  // treat all-zero CPU+memory as "no telemetry captured".
  const cpu = t.cpuAvg ?? 0;
  const mem = t.memAvg ?? 0;
  return !(cpu === 0 && mem === 0);
}

export function buildConfoundAssessment(
  allTxns: Transaction[],
  sideASel: SideSelector,
  sideBSel: SideSelector,
  axis: (ComparisonDimension | string)[]
): ConfoundAssessment {
  const A = resolveSide(allTxns, sideASel);
  const B = resolveSide(allTxns, sideBSel);
  const axisSet = new Set(axis);
  const flags: ConfoundFlag[] = [];

  // Region is not a field on the transaction record — note it can't be verified here.
  if (axisSet.has('region')) {
    flags.push({
      dimension: 'region',
      severity: 'info',
      kind: 'cross-side',
      message: 'Region is not stored on transaction records; the region split cannot be verified here. ' +
        'Confirm region membership via the device records (list_devices) when selecting each side.',
    });
  }

  for (const dim of Object.keys(DIM_ACCESSOR) as ComparisonDimension[]) {
    if (axisSet.has(dim)) continue; // this dimension is SUPPOSED to differ
    const accessor = DIM_ACCESSOR[dim]!;
    const aVals = distinct(A.map(accessor));
    const bVals = distinct(B.map(accessor));
    const baseSeverity = DIM_SEVERITY[dim] ?? 'low';

    // Cross-side confound: the value-sets don't overlap (each side is internally
    // uniform but they differ from each other) — classic confound.
    const overlap = aVals.filter((v) => bVals.includes(v));
    if (aVals.length > 0 && bVals.length > 0 && overlap.length === 0) {
      flags.push({
        dimension: dim,
        severity: baseSeverity,
        kind: 'cross-side',
        message: `${dim} differs entirely between the two sides (A: ${aVals.join(', ')} | B: ${bVals.join(', ')}). ` +
          `This is not the declared comparison axis, so it confounds the result.`,
        sideAValues: aVals,
        sideBValues: bVals,
      });
      continue; // a full cross-side split dominates; skip the within-side note for this dim
    }

    // Within-side heterogeneity: a side mixes multiple values of a non-axis dim → noise.
    if (aVals.length > 1 || bVals.length > 1) {
      flags.push({
        dimension: dim,
        severity: baseSeverity === 'high' ? 'medium' : 'low',
        kind: 'within-side',
        message: `${dim} varies within a side (A: ${aVals.join(', ') || '—'} | B: ${bVals.join(', ') || '—'}). ` +
          `Mixed values add variance unrelated to the comparison.`,
        sideAValues: aVals,
        sideBValues: bVals,
      });
    }
  }

  // Telemetry completeness.
  const aNoTel = A.filter((t) => !hasTelemetry(t)).length;
  const bNoTel = B.filter((t) => !hasTelemetry(t)).length;
  if (aNoTel > 0 || bNoTel > 0) {
    flags.push({
      dimension: 'telemetry',
      severity: 'medium',
      kind: 'telemetry',
      message: `${aNoTel} of ${A.length} (A) and ${bNoTel} of ${B.length} (B) transactions have no CPU/memory telemetry ` +
        `(all-zero samples). Speed Index may still be valid, but CPU/memory/battery comparison for those runs is meaningless.`,
    });
  }

  // Sample-size imbalance.
  if (A.length > 0 && B.length > 0) {
    const ratio = Math.max(A.length, B.length) / Math.min(A.length, B.length);
    if (ratio >= 2) {
      flags.push({
        dimension: 'sampleSize',
        severity: 'low',
        kind: 'imbalance',
        message: `Sample sizes are imbalanced (A: ${A.length}, B: ${B.length}). ` +
          `Unequal N widens the confidence interval on the smaller side.`,
      });
    }
  }
  if (A.length === 0 || B.length === 0) {
    flags.push({
      dimension: 'sampleSize',
      severity: 'high',
      kind: 'imbalance',
      message: `A side has no transactions (A: ${A.length}, B: ${B.length}). The comparison cannot be computed.`,
    });
  }

  const hasHigh = flags.some((f) => f.severity === 'high');
  const hasMedLow = flags.some((f) => f.severity === 'medium' || f.severity === 'low');
  const validity: ConfoundAssessment['validity'] = hasHigh ? 'confounded' : hasMedLow ? 'caveated' : 'clean';

  const summary =
    validity === 'clean'
      ? `No confounds detected — the only difference between the sides is the declared axis (${axis.join(', ') || 'none declared'}). Comparison is sound.`
      : validity === 'caveated'
        ? `Comparison is usable but caveated: ${flags.length} factor(s) add noise or affect non-Speed-Index metrics. Read the flags before trusting secondary metrics.`
        : `Comparison is CONFOUNDED: a high-impact factor other than the declared axis (${axis.join(', ') || 'none declared'}) differs between the sides. The delta cannot be attributed to the axis alone. Re-select the sides to hold this factor constant, or change the declared axis.`;

  return { comparisonAxis: axis, validity, flags, summary };
}
