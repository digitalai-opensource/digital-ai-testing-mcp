import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  mean, median, stddev, trimmedMean, mad, madRaw, detectOutliersMAD, summarizeMetric,
} from '../src/utils/performance-stats.js';
import {
  resolveSide, buildComparison, buildConfoundAssessment, buildOutlierReport,
} from '../src/utils/performance-comparison.js';
import type { Transaction } from '../src/types/digital-ai.js';

// ─── Fixture factory ───────────────────────────────────────────────────────────

let nextId = 1000;
function tx(partial: Partial<Transaction>): Transaction {
  return {
    id: nextId++,
    name: 'Login',
    appName: 'com.digitalai.sampleapp',
    appVersion: '1.0',
    startTime: '2026-06-11T05:00:00.000+00:00',
    date: '2026-06-11',
    deviceUid: 'UID',
    deviceName: 'Galaxy S21 US-0332',
    deviceModel: 'SM-G991U',
    deviceOs: 'Android',
    deviceManufacturer: 'samsung',
    deviceVersion: '12.0',
    deviceScreen: '1080 x 2176',
    deviceType: 'PHONE',
    networkProfile: '3G-average',
    cpuAvg: 34, cpuMax: 34, cpuCoreCount: 8,
    memAvg: 3478, memMax: 3480, memTotalInBytes: 7719833600,
    batteryAvg: 0.13, batteryMax: 0.44,
    totalUploadedBytes: 0, totalDownloadedBytes: 0,
    duration: 1972, speedIndex: 1000,
    videoStart: null, videoEnd: null,
    userName: 'joseph.hurley@digital.ai',
    testId: 409965, attachmentId: null, attachmentPath: null,
    projectId: 1, projectName: 'Default', attachmentList: null,
    ...partial,
  };
}

// ─── Pure stats ────────────────────────────────────────────────────────────────

describe('performance-stats primitives', () => {
  it('mean / median / stddev basics', () => {
    assert.equal(mean([2, 4, 6]), 4);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([5]), 5);
    assert.equal(mean([]), null);
    assert.equal(stddev([4, 4, 4]), 0);
  });

  it('trimmedMean drops the extremes', () => {
    // 10 values, 10% trim → drop 1 each end → mean of 2..9 = 5.5
    assert.equal(trimmedMean([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.1), 5.5);
    // A wild high value is trimmed away
    const withSpike = [10, 10, 10, 10, 1000];
    assert.ok(trimmedMean(withSpike, 0.2)! < mean(withSpike)!);
  });

  it('trimmedMean falls back to median when trimming removes everything', () => {
    assert.equal(trimmedMean([3, 1, 2], 0.49), median([3, 1, 2]));
  });

  it('mad is the scaled median absolute deviation', () => {
    assert.equal(madRaw([1, 1, 1]), 0);
    const m = mad([10, 12, 14, 16, 18]);
    assert.ok(m != null && m > 0);
  });

  it('detectOutliersMAD flags a wild sample and keeps the rest', () => {
    const res = detectOutliersMAD([1000, 1010, 1005, 1008, 1002, 5000]);
    assert.equal(res.outlierIndices.length, 1);
    assert.equal(res.flags[5].isOutlier, true);     // the 5000
    assert.equal(res.keptIndices.length, 5);
    assert.equal(res.degenerate, false);
  });

  it('detectOutliersMAD reports degenerate when MAD is 0', () => {
    const res = detectOutliersMAD([100, 100, 100, 100, 200]);
    assert.equal(res.degenerate, true);
    assert.equal(res.outlierIndices.length, 0);      // no scoring possible
  });

  it('summarizeMetric drops nulls and reports all three aggregates', () => {
    const s = summarizeMetric([1000, null, 1010, 1005, undefined]);
    assert.equal(s.n, 3);
    assert.ok(s.trimmedMean != null && s.median != null && s.mean != null);
  });
});

// ─── Side resolution ─────────────────────────────────────────────────────────────

describe('resolveSide', () => {
  const all = [
    tx({ id: 1, appVersion: '1.0' }),
    tx({ id: 2, appVersion: '2.0' }),
    tx({ id: 3, appVersion: '2.0', deviceModel: 'Pixel 7' }),
  ];

  it('selects by explicit IDs, ignoring missing ones', () => {
    const got = resolveSide(all, { label: 'A', transactionIds: [1, 3, 999] });
    assert.deepEqual(got.map((t) => t.id), [1, 3]);
  });

  it('selects by filter substring', () => {
    const got = resolveSide(all, { label: 'B', filter: { appVersion: '2.0' } });
    assert.deepEqual(got.map((t) => t.id).sort(), [2, 3]);
  });
});

// ─── Comparison ──────────────────────────────────────────────────────────────────

describe('buildComparison', () => {
  it('computes a per-metric delta between two sides', () => {
    const all = [
      tx({ id: 10, appVersion: '1.0', speedIndex: 1000 }),
      tx({ id: 11, appVersion: '1.0', speedIndex: 1010 }),
      tx({ id: 12, appVersion: '1.0', speedIndex: 1005 }),
      tx({ id: 13, appVersion: '2.0', speedIndex: 1200 }),
      tx({ id: 14, appVersion: '2.0', speedIndex: 1210 }),
      tx({ id: 15, appVersion: '2.0', speedIndex: 1205 }),
    ];
    const cmp = buildComparison(
      all,
      { label: 'v1.0', filter: { appVersion: '1.0' } },
      { label: 'v2.0', filter: { appVersion: '2.0' } },
      { metrics: ['speedIndex'], excludeOutliers: false }
    );
    const si = cmp.metrics[0];
    assert.equal(cmp.sideA.n, 3);
    assert.equal(cmp.sideB.n, 3);
    // Speed Index is a composite score, not a duration — its unit is "SI", never "ms" (v42).
    assert.equal(si.unit, 'SI');
    assert.ok(si.deltaTrimmedMean != null && si.deltaTrimmedMean > 190 && si.deltaTrimmedMean < 210);
    assert.ok(si.percentChangeTrimmedMean != null && si.percentChangeTrimmedMean > 18);
  });

  it('excludes outliers on the primary metric when enabled', () => {
    const all = [
      tx({ id: 20, appVersion: '1.0', speedIndex: 1000 }),
      tx({ id: 21, appVersion: '1.0', speedIndex: 1005 }),
      tx({ id: 22, appVersion: '1.0', speedIndex: 1002 }),
      tx({ id: 23, appVersion: '1.0', speedIndex: 1008 }),
      tx({ id: 24, appVersion: '1.0', speedIndex: 9000 }), // outlier
    ];
    const cmp = buildComparison(
      all,
      { label: 'A', filter: { appVersion: '1.0' } },
      { label: 'B', transactionIds: [20, 21] },
      { metrics: ['speedIndex'], excludeOutliers: true }
    );
    assert.deepEqual(cmp.sideA.excludedIds, [24]);
    assert.equal(cmp.sideA.n, 4);
  });
});

// ─── Confound assessment (the real 1894-vs-1895 scenario) ─────────────────────────

describe('buildConfoundAssessment', () => {
  it('flags device-model + OS-version confounds when the axis is appVersion', () => {
    // Mirrors the live case: comparing "versions" but the two sides are actually
    // different device models AND different OS versions AND different projects.
    const all = [
      tx({ id: 30, appVersion: '1.0', deviceModel: 'SM-G991U', deviceVersion: '12.0', projectName: 'Default' }),
      tx({ id: 31, appVersion: '2.0', deviceModel: 'SM-N986U1', deviceVersion: '13.0', projectName: 'DAIMCP POC' }),
    ];
    const a = buildConfoundAssessment(
      all,
      { label: 'v1.0', transactionIds: [30] },
      { label: 'v2.0', transactionIds: [31] },
      ['appVersion']
    );
    assert.equal(a.validity, 'confounded');
    const dims = a.flags.map((f) => f.dimension);
    assert.ok(dims.includes('deviceModel'));
    assert.ok(dims.includes('deviceVersion'));
  });

  it('flags missing telemetry (all-zero CPU/mem)', () => {
    const all = [
      tx({ id: 40, speedIndex: 1000 }),
      tx({ id: 41, speedIndex: 1015, cpuAvg: 0, memAvg: 0 }), // 1894-style: no telemetry
    ];
    const a = buildConfoundAssessment(
      all,
      { label: 'A', transactionIds: [40] },
      { label: 'B', transactionIds: [41] },
      ['deviceModel'] // declare model as axis so model difference isn't the flag we test
    );
    assert.ok(a.flags.some((f) => f.kind === 'telemetry'));
  });

  it('returns clean when only the declared axis differs', () => {
    const all = [
      tx({ id: 50, appVersion: '1.0', speedIndex: 1000 }),
      tx({ id: 51, appVersion: '1.0', speedIndex: 1004 }),
      tx({ id: 52, appVersion: '2.0', speedIndex: 1100 }),
      tx({ id: 53, appVersion: '2.0', speedIndex: 1104 }),
    ];
    const a = buildConfoundAssessment(
      all,
      { label: 'v1.0', filter: { appVersion: '1.0' } },
      { label: 'v2.0', filter: { appVersion: '2.0' } },
      ['appVersion']
    );
    assert.equal(a.validity, 'clean');
    assert.equal(a.flags.length, 0);
  });
});

// ─── Outlier report ───────────────────────────────────────────────────────────────

describe('buildOutlierReport', () => {
  it('maps flagged values back to transaction IDs', () => {
    const all = [
      tx({ id: 60, speedIndex: 1000 }),
      tx({ id: 61, speedIndex: 1005 }),
      tx({ id: 62, speedIndex: 1002 }),
      tx({ id: 63, speedIndex: 1008 }),
      tx({ id: 64, speedIndex: 1003 }),
      tx({ id: 65, speedIndex: 8000 }),
    ];
    const r = buildOutlierReport(all, { label: 'set', transactionIds: [60, 61, 62, 63, 64, 65] }, 'speedIndex');
    assert.deepEqual(r.outlierTransactionIds, [65]);
    assert.equal(r.keptTransactionIds.length, 5);
  });

  it('reports transactions missing the metric separately', () => {
    const all = [
      tx({ id: 70, speedIndex: 1000 }),
      tx({ id: 71, speedIndex: null }),
    ];
    const r = buildOutlierReport(all, { label: 'set', transactionIds: [70, 71] }, 'speedIndex');
    assert.deepEqual(r.missingMetricIds, [71]);
  });
});
