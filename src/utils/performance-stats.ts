// Pure statistical helpers for performance comparison reporting.
// No network, no domain types — operate on plain number arrays so they are
// trivially unit-testable. All functions ignore nothing implicitly: callers
// are responsible for filtering out null/NaN before passing values in.

/** Arithmetic mean. Returns null for an empty array. */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Median (50th percentile, linear). Returns null for an empty array. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Population standard deviation. Returns null for an empty array, 0 for a single value. */
export function stddev(values: number[]): number | null {
  if (values.length === 0) return null;
  const m = mean(values)!;
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Symmetric trimmed mean: drop floor(n * trimFraction) values from EACH end
 * after sorting, then average the rest. Robust to a few wild samples while
 * keeping more data than the median.
 *
 * trimFraction is clamped to [0, 0.5). If trimming would remove every value
 * (small n + large fraction), falls back to the median so a result is always
 * returned for a non-empty array.
 */
export function trimmedMean(values: number[], trimFraction = 0.1): number | null {
  if (values.length === 0) return null;
  const frac = Math.min(Math.max(trimFraction, 0), 0.49);
  const sorted = [...values].sort((a, b) => a - b);
  const drop = Math.floor(sorted.length * frac);
  const kept = sorted.slice(drop, sorted.length - drop);
  if (kept.length === 0) return median(values);
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

/**
 * Raw median absolute deviation: median(|x - median(x)|).
 * Returns null for an empty array. Multiply by 1.4826 for a
 * normal-consistent estimate comparable to the standard deviation.
 */
export function madRaw(values: number[]): number | null {
  if (values.length === 0) return null;
  const med = median(values)!;
  const absDevs = values.map((v) => Math.abs(v - med));
  return median(absDevs);
}

/** Normal-consistent MAD (madRaw * 1.4826), comparable to stddev. */
export function mad(values: number[]): number | null {
  const raw = madRaw(values);
  return raw == null ? null : raw * 1.4826;
}

export interface OutlierFlag {
  index: number;       // index into the ORIGINAL (unsorted) values array
  value: number;
  /** Signed modified z-score (distance from median in scaled-MAD units). */
  score: number;
  isOutlier: boolean;
}

export interface OutlierResult {
  median: number | null;
  madScaled: number | null;   // 1.4826 * madRaw — the divisor used for scoring
  threshold: number;          // k
  flags: OutlierFlag[];
  keptIndices: number[];      // indices NOT flagged as outliers
  outlierIndices: number[];   // indices flagged as outliers
  /** True when MAD is 0 (>50% of values identical) and scoring was skipped. */
  degenerate: boolean;
}

/**
 * Flag outliers using the median / MAD modified z-score:
 *   score = (x - median) / (1.4826 * madRaw)
 * |score| > k  ⇒  outlier. Default k = 3.5 (Iglewicz–Hoaglin).
 *
 * MAD is robust for the small samples this tool deals in (N = 5–10), where a
 * single bad run would inflate a stddev-based bound enough to mask itself.
 *
 * Degenerate case: when madRaw is 0 (a majority of identical values) the score
 * is undefined; we flag nothing and set degenerate=true so callers can fall
 * back to a different rule or simply report no outliers.
 */
export function detectOutliersMAD(values: number[], k = 3.5): OutlierResult {
  const med = median(values);
  const scaled = mad(values);

  if (values.length === 0 || med == null || scaled == null || scaled === 0) {
    return {
      median: med,
      madScaled: scaled,
      threshold: k,
      flags: values.map((value, index) => ({ index, value, score: 0, isOutlier: false })),
      keptIndices: values.map((_, i) => i),
      outlierIndices: [],
      degenerate: scaled === 0 && values.length > 0,
    };
  }

  const flags: OutlierFlag[] = values.map((value, index) => {
    const score = (value - med) / scaled;
    return { index, value, score, isOutlier: Math.abs(score) > k };
  });

  return {
    median: med,
    madScaled: scaled,
    threshold: k,
    flags,
    keptIndices: flags.filter((f) => !f.isOutlier).map((f) => f.index),
    outlierIndices: flags.filter((f) => f.isOutlier).map((f) => f.index),
    degenerate: false,
  };
}

export interface MetricSummary {
  n: number;
  mean: number | null;
  median: number | null;
  trimmedMean: number | null;
  stddev: number | null;
  mad: number | null;
  min: number | null;
  max: number | null;
  /** Coefficient of variation (stddev / mean) — a unitless noise indicator. */
  cv: number | null;
}

/**
 * Full summary of one metric over a set of samples. nulls in the input are
 * dropped before computation (a missing metric does not count toward n).
 */
export function summarizeMetric(rawValues: (number | null | undefined)[], trimFraction = 0.1): MetricSummary {
  const values = rawValues.filter((v): v is number => v != null && !Number.isNaN(v));
  const m = mean(values);
  const sd = stddev(values);
  return {
    n: values.length,
    mean: m,
    median: median(values),
    trimmedMean: trimmedMean(values, trimFraction),
    stddev: sd,
    mad: mad(values),
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    cv: m != null && m !== 0 && sd != null ? sd / m : null,
  };
}
