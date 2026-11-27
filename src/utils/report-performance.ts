/**
 * Performance report recipes (create_report): performance transactions in, a render_report spec out. Pure and
 * fixture-tested, like src/utils/report-recipes.ts; the transactions are fetched by the tool.
 *
 * Speed Index is a composite score (the area above the visual-progress curve), not a duration: it is labelled "SI",
 * lower is better, and no sentence here turns a difference in SI into "N ms faster".
 */
import type { Section } from './report-render.js';
import type { Transaction } from '../types/digital-ai.js';
import { longDate, type RecipeResult } from './report-recipes.js';
import { median, detectOutliersMAD } from './performance-stats.js';
import type { ComparisonDimension, ConfoundFlag, MetricComparison } from '../types/digital-ai.js';
import { buildComparison, buildConfoundAssessment, resolveSide, metricValue, axisFromFilters, type SideSelector, type PerfMetric, type TransactionFilter } from './performance-comparison.js';

const DAY = 86_400_000;
const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
const n0 = (x: number) => Math.round(x).toLocaleString('en-US');
const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
/** Fewer samples than this and a group's median is listed but never ranked or compared. */
const MIN_SAMPLES = 3;

const si = (t: Transaction) => (t.speedIndex != null && t.speedIndex > 0 ? t.speedIndex : null);
const secs = (t: Transaction) => (t.duration > 0 ? t.duration / 1000 : null);
const cpu = (t: Transaction) => (t.cpuAvg != null && t.cpuAvg > 0 ? t.cpuAvg : null);
const mem = (t: Transaction) => (t.memAvg != null && t.memAvg > 0 ? t.memAvg : null);
const med = (list: Transaction[], f: (t: Transaction) => number | null) => median(list.map(f).filter((v): v is number => v != null));
const platform = (os: string) => (/^ios$/i.test(os) ? 'iOS' : /^android$/i.test(os) ? 'Android' : os || '(not recorded)');
const profile = (p: string) => p || '(none recorded)';
/** "Monitor" observes without shaping the network; every other named profile throttles it. */
const throttled = (p: string) => !!p && !/^(monitor|none)$/i.test(p);

function groupBy(list: Transaction[], key: (t: Transaction) => string): Array<[string, Transaction[]]> {
  const m = new Map<string, Transaction[]>();
  for (const t of list) { const k = key(t); const g = m.get(k); if (g) g.push(t); else m.set(k, [t]); }
  return [...m].sort((a, b) => b[1].length - a[1].length);
}

/** Compare version strings part by part ("2.10" after "2.9"); anything unparsable sorts by first appearance. */
function versionOrder(a: string, b: string): number {
  const pa = a.split(/[.\-+_ ]/).map(Number), pb = b.split(/[.\-+_ ]/).map(Number);
  for (let k = 0; k < Math.max(pa.length, pb.length); k++) {
    const x = pa[k] ?? 0, y = pb[k] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Every performance transaction of a range: the slowest transactions by median Speed Index, medians by network profile,
 * platform and app version, activity over time, and how much of the data carries no measurement. `total` is how many
 * transactions the access key can see at all, so a thin range is recognisable.
 */
export function buildPerformanceOverview(i: { transactions: Transaction[]; total: number; newest: number | null; from: number | null; to: number; days: number | null; projectName?: string }): RecipeResult {
  const tx = i.transactions;
  const window = i.from == null ? 'all dates' : `last ${plural(i.days ?? 0, 'day')}`;
  const names = groupBy(tx, (t) => t.name || '(no name)');
  const apps = groupBy(tx.filter((t) => t.appName), (t) => t.appName);
  const devices = new Set(tx.map((t) => t.deviceUid || t.deviceName)).size;
  const withSi = tx.filter((t) => si(t) != null);
  const noTelemetry = tx.filter((t) => cpu(t) == null && mem(t) == null);
  const overallSi = med(tx, si), overallSecs = med(tx, secs);

  const ranked = names.map(([name, list]) => ({ name, list, n: list.filter((t) => si(t) != null).length, si: med(list, si) }))
    .filter((x) => x.n >= MIN_SAMPLES && x.si != null).sort((a, b) => b.si! - a.si!);
  const slowest = ranked[0] ?? null, fastest = ranked.length > 1 ? ranked[ranked.length - 1] : null;
  let outliers = 0;
  for (const x of ranked) outliers += detectOutliersMAD(x.list.map(si).filter((v): v is number => v != null)).outlierIndices.length;

  const profiles = groupBy(tx, (t) => profile(t.networkProfile));
  const shaped = tx.filter((t) => throttled(t.networkProfile)).length;
  const platforms = groupBy(tx, (t) => platform(t.deviceOs));

  // App versions of ONE transaction, oldest version first: the transaction with the most runs among those measured on
  // two or more versions. Versions of a whole app hold different transactions, so their medians say nothing about a change.
  const byVersion = (list: Transaction[]) => groupBy(list, (t) => t.appVersion || '(not recorded)')
    .map(([v, l]) => ({ v, list: l, n: l.filter((t) => si(t) != null).length, si: med(l, si), first: l.reduce((m, t) => { const s = Date.parse(t.startTime); return s < m ? s : m; }, Infinity) }))
    .sort((a, b) => versionOrder(a.v, b.v) || a.first - b.first);
  const versioned = names.map(([name, list]) => ({ name, list, versions: byVersion(list) }))
    .find((x) => x.versions.filter((v) => v.n >= MIN_SAMPLES && v.si != null).length >= 2) ?? null;
  const versions = versioned?.versions ?? [];
  const versionsRanked = versions.filter((x) => x.n >= MIN_SAMPLES && x.si != null);
  const lastTwo = versionsRanked.slice(-2);
  const versionChange = lastTwo.length === 2 ? Math.round(((lastTwo[1].si! - lastTwo[0].si!) / lastTwo[0].si!) * 100) : null;

  // Activity: per week up to 90 days, else per month.
  const byMonth = i.days == null || i.days > 90;
  const bucket = (t: number) => { const d = new Date(t); return byMonth ? new Date(d.getFullYear(), d.getMonth(), 1).getTime() : new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime(); };
  const label = (t: number) => { const d = new Date(t); return byMonth ? `${d.getMonth() + 1}/${String(d.getFullYear()).slice(2)}` : `${d.getMonth() + 1}/${d.getDate()}`; };
  const activity = new Map<number, number>();
  for (const t of tx) { const s = Date.parse(t.startTime); if (Number.isFinite(s)) activity.set(bucket(s), (activity.get(bucket(s)) ?? 0) + 1); }
  const activityKeys = [...activity.keys()].sort((a, b) => a - b).slice(-36);

  const stale = i.newest != null && i.to - i.newest > 30 * DAY;
  const highlights = [
    `${plural(tx.length, 'performance transaction')} ${i.from == null ? 'on record' : `in the ${window}`}${i.from != null && i.total > tx.length ? ` (of ${i.total.toLocaleString('en-US')} on record)` : ''}: ${plural(names.length, 'transaction name')}, ${plural(apps.length, 'app')}, ${plural(devices, 'device')}.`,
    ...(slowest ? [`Highest median Speed Index: "${slowest.name}" at ${n0(slowest.si!)} SI over ${plural(slowest.n, 'run')}${fastest ? `; lowest: "${fastest.name}" at ${n0(fastest.si!)} SI` : ''}. Speed Index is a composite score, lower is better.`] : []),
    ...(versionChange != null && Math.abs(versionChange) >= 10 ? [`"${versioned!.name}": median Speed Index ${versionChange > 0 ? 'rose' : 'fell'} ${Math.abs(versionChange)}% from app version ${lastTwo[0].v} to ${lastTwo[1].v} (${lastTwo[0].n} and ${lastTwo[1].n} runs).`] : []),
    ...(tx.length && withSi.length < tx.length * 0.9 ? [`${plural(tx.length - withSi.length, 'transaction')} (${Math.round(((tx.length - withSi.length) / tx.length) * 100)}%) recorded no Speed Index.`] : []),
    ...(stale ? [`The newest transaction is from ${longDate(i.newest!)}: nothing has been measured for ${plural(Math.floor((i.to - i.newest!) / DAY), 'day')}.`] : []),
  ];

  const sections: Section[] = [
    { title: 'At a Glance', blocks: [{ type: 'kpis', items: [
      { value: tx.length.toLocaleString('en-US'), label: `Transactions, ${window}` }, { value: names.length.toLocaleString('en-US'), label: 'Transaction names' },
      { value: overallSi == null ? 'n/a' : `${n0(overallSi)} SI`, label: 'Median Speed Index', accent: 'teal' },
      { value: overallSecs == null ? 'n/a' : `${r1(overallSecs)} s`, label: 'Median duration' }, { value: devices.toLocaleString('en-US'), label: 'Devices' }] }] },
  ];
  if (!tx.length) {
    sections.push({ title: 'Transactions', blocks: [{ type: 'callout', tone: 'note', title: 'No performance transaction',
      text: i.total ? `No transaction in the ${window}; ${plural(i.total, 'transaction')} on record${i.newest != null ? `, the newest from ${longDate(i.newest)}` : ''}. Ask for a longer range or all dates.`
        : 'This access key sees no performance transaction. A transaction is recorded when a test runs seetest:client.startPerformanceTransaction and endPerformanceTransaction.' }] });
  } else {
    const row = (name: string, list: Transaction[]) => ({ name, runs: list.length, si: r1(med(list, si)), secs: r1(med(list, secs)), cpu: r1(med(list, cpu)), mem: r1(med(list, mem)) });
    const metricCols = [{ key: 'runs', label: 'Runs', format: 'number' as const }, { key: 'si', label: 'Median Speed Index (SI)', format: 'number' as const, decimals: 0 },
      { key: 'secs', label: 'Median duration (s)', format: 'number' as const, decimals: 1 }, { key: 'cpu', label: 'Median CPU (%)', format: 'number' as const, decimals: 1 },
      { key: 'mem', label: 'Median memory (MB)', format: 'number' as const, decimals: 0 }];
    const top = ranked.slice(0, 12);
    sections.push({ title: 'Transactions by Speed Index', blocks: [
      ...(top.length ? [{ type: 'bar' as const, orientation: 'horizontal' as const, unit: 'SI', decimals: 0, categories: top.map((x) => `${x.name} (${x.n})`), series: [{ name: 'Median Speed Index', values: top.map((x) => Math.round(x.si!)) }],
        ...(ranked.length > 12 ? { otherLabel: `${ranked.length - 12} more in the table below` } : {}) }] : []),
      { type: 'table', maxRows: 100, columns: [{ key: 'name', label: 'Transaction' }, ...metricCols],
        rows: names.slice(0, 100).map(([name, list]) => row(name, list)) }],
      whatItMeans: (slowest ? `"${slowest.name}" has the highest median Speed Index (${n0(slowest.si!)} SI over ${plural(slowest.n, 'run')})${fastest ? `, "${fastest.name}" the lowest (${n0(fastest.si!)} SI)` : ''}. ` : `No transaction name has ${MIN_SAMPLES} or more runs with a Speed Index, so none is ranked. `) +
        'Speed Index is a composite score of how early the screen is visually complete: lower is better, and a difference in SI is not a number of milliseconds. ' +
        `The number in brackets is the runs behind each median; names with fewer than ${MIN_SAMPLES} are listed but not ranked.` +
        (outliers ? ` ${plural(outliers, 'run')} sit far from the median of their own transaction (outliers); the median is not moved by them.` : '') });
    if (profiles.length > 1 || shaped) sections.push({ title: 'By Network Profile', blocks: [{ type: 'table', columns: [{ key: 'name', label: 'Network profile' }, ...metricCols],
      rows: profiles.map(([name, list]) => row(name, list)) }],
      whatItMeans: `${plural(shaped, 'transaction')} of ${tx.length.toLocaleString('en-US')} ran under a profile that shapes the network (latency, bandwidth or loss); "Monitor" observes without shaping. ` +
        'Medians of different profiles are not comparable with each other: compare versions, devices or platforms within one profile.' });
    if (platforms.length > 1) sections.push({ title: 'By Platform', blocks: [{ type: 'table', columns: [{ key: 'name', label: 'Platform' }, ...metricCols], rows: platforms.map(([name, list]) => row(name, list)) }],
      whatItMeans: 'Android and iOS rows hold different transactions, apps and network profiles, so this table shows what was measured on each platform, not which platform is faster. ' +
        'For a like-for-like answer compare one transaction name under one profile (compare_performance_transactions, after assess_comparison_confounds).' });
    if (versioned) sections.push({ title: `"${versioned.name}" by App Version`, blocks: [
      ...(versionsRanked.length > 1 ? [{ type: 'bar' as const, unit: 'SI', decimals: 0, categories: versionsRanked.slice(-15).map((x) => `${x.v} (${x.n})`), series: [{ name: 'Median Speed Index', values: versionsRanked.slice(-15).map((x) => Math.round(x.si!)) }] }] : []),
      { type: 'table', maxRows: 40, columns: [{ key: 'name', label: 'Version' }, ...metricCols], rows: versions.slice(-40).map((x) => row(x.v, x.list)) }],
      whatItMeans: `"${versioned.name}" is the transaction with the most runs among those measured on two or more app versions (${versioned.list.length.toLocaleString('en-US')} runs); versions are in version order.` +
        (versionChange != null ? ` From ${lastTwo[0].v} to ${lastTwo[1].v} the median Speed Index ${versionChange === 0 ? 'did not change' : `${versionChange > 0 ? 'rose' : 'fell'} ${Math.abs(versionChange)}%`} (${lastTwo[0].n} and ${lastTwo[1].n} runs)` +
          `${Math.abs(versionChange) >= 10 ? `, ${versionChange > 0 ? 'a slowdown' : 'an improvement'} to confirm on the same devices and network profile before it is reported as one (assess_comparison_confounds checks that)` : ''}.` : ` Fewer than two versions have ${MIN_SAMPLES} or more runs with a Speed Index, so no change between versions is stated.`) });
    if (activityKeys.length > 1) sections.push({ title: `Transactions per ${byMonth ? 'Month' : 'Week'}`, blocks: [{ type: 'bar', categories: activityKeys.map(label), series: [{ name: 'Transactions', values: activityKeys.map((k) => activity.get(k) ?? 0) }] }],
      whatItMeans: (stale ? `The newest transaction is from ${longDate(i.newest!)}. ` : '') + 'A trend in performance needs steady measurement: weeks or months with no transaction are gaps in what this report can say, not periods without change.' });
    const quality = [
      withSi.length < tx.length ? { text: `${plural(tx.length - withSi.length, 'transaction')} recorded no Speed Index (it needs video; the medians above leave them out).`, tone: 'neutral' as const } : { text: 'Every transaction recorded a Speed Index.', tone: 'good' as const },
      noTelemetry.length ? { text: `${plural(noTelemetry.length, 'transaction')} recorded neither CPU nor memory (no telemetry from the device).`, tone: 'bad' as const } : { text: 'Every transaction recorded CPU or memory.', tone: 'good' as const },
      { text: `${plural(names.filter(([, l]) => l.length < MIN_SAMPLES).length, 'transaction name')} of ${names.length.toLocaleString('en-US')} ${names.filter(([, l]) => l.length < MIN_SAMPLES).length === 1 ? 'has' : 'have'} fewer than ${MIN_SAMPLES} runs: too few for a median to mean much.`, tone: 'neutral' as const },
    ];
    sections.push({ title: 'What the Data Can Support', blocks: [{ type: 'findings', items: quality }] });
  }
  return {
    highlights,
    spec: {
      title: 'Performance Overview',
      subtitle: i.from == null ? 'Performance transactions, all dates' : `Performance transactions, ${window}`,
      meta: [...(i.projectName ? [{ label: 'Project', value: i.projectName }] : []),
        { label: 'Range', value: i.from == null ? `All dates, as of ${longDate(i.to)}` : `${longDate(i.from)} to ${longDate(i.to)}` }],
      headline: overallSi != null ? { value: `${n0(overallSi)} SI`, label: 'Median Speed Index' } : undefined,
      sections,
      source: `Source: Digital.ai Testing reporter, performance transactions ${i.projectName ? `of project ${i.projectName}` : 'visible to this access key'}${i.from == null ? '' : `, ${longDate(i.from)} to ${longDate(i.to)}`}. ` +
        `Medians over the runs that recorded the metric; a group needs ${MIN_SAMPLES} runs to be ranked. Speed Index (SI) is a composite score of visual completeness over time, lower is better; duration is wall-clock time between the start and end of the transaction.`,
    },
  };
}

// ── Performance comparison (two sides) ───────────────────────────────────────────────────────────────────────────────

/** Metrics a comparison report shows unless asked otherwise. Speed Index is always first: it anchors outlier exclusion. */
export const DEFAULT_COMPARISON_METRICS: PerfMetric[] = ['speedIndex', 'duration', 'cpuAvg', 'memAvg'];
/** A change smaller than this (percent, on the trimmed mean) is reported as about the same. */
export const SAME_PCT = 5;
/** Fewer runs with a Speed Index than this on a side and no verdict is given. */
const MIN_VERDICT_RUNS = 3;

const DIM_LABEL: Record<string, string> = { appVersion: 'app version', deviceModel: 'device model', deviceOs: 'platform', deviceVersion: 'OS version',
  networkProfile: 'network profile', deviceName: 'device', projectName: 'project', name: 'transaction name', testId: 'test', region: 'region' };
const dimLabel = (d: string) => DIM_LABEL[d] ?? d;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const valuesOf = (v: string[] = []) => (v.length <= 4 ? v.join(', ') : `${v.slice(0, 4).join(', ')} and ${v.length - 4} more`);
/**
 * Comparing one of these also compares the ones it implies: iOS against Android cannot run on the same model or device,
 * and device against device is model against model when they differ (live: two iPhones compared by name were reported
 * as confounded by their models). The OS version is never implied by a device: it is what most often confounds one.
 */
const IMPLIED: Partial<Record<string, ComparisonDimension[]>> = {
  deviceOs: ['deviceModel', 'deviceName', 'deviceVersion'],
  deviceModel: ['deviceName'],
  deviceName: ['deviceModel'],
};
const METRIC_NAME: Record<PerfMetric, string> = { speedIndex: 'Speed Index', duration: 'Duration', cpuAvg: 'CPU', memAvg: 'Memory', batteryAvg: 'Battery',
  totalDownloadedBytes: 'Downloaded', totalUploadedBytes: 'Uploaded' };
function show(m: PerfMetric, v: number | null): string {
  if (v == null) return 'n/a';
  if (m === 'speedIndex') return `${n0(v)} SI`;
  if (m === 'duration') return `${(v / 1000).toFixed(2)} s`;
  if (m === 'cpuAvg') return `${v.toFixed(1)}%`;
  if (m === 'memAvg') return `${n0(v)} MB`;
  if (m === 'batteryAvg') return `${n0(v)} mW`;
  return `${(v / 1_048_576).toFixed(2)} MB`;
}
/** A percentage without its sign: one decimal under 10, whole numbers above. */
const pctText = (p: number) => `${Math.abs(p) < 10 ? Number(Math.abs(p).toFixed(1)) : Math.round(Math.abs(p))}%`;
const signed = (p: number) => `${p > 0 ? '+' : p < 0 ? '-' : ''}${pctText(p)}`;
const headlineOf = (m: MetricComparison, side: 'sideA' | 'sideB') => m[side].trimmedMean ?? m[side].median ?? m[side].mean;
function when(t: Transaction): string {
  const d = new Date(t.startTime);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const SIDE_FIELD: Partial<Record<keyof TransactionFilter, string>> = { appName: 'app', appVersion: 'app version', transactionName: 'transaction', deviceOs: 'platform',
  deviceName: 'device', deviceModel: 'model', deviceVersion: 'OS version', networkProfile: 'network profile', projectName: 'project', testId: 'test',
  startDate: 'from', endDate: 'to' };
/** How a side was chosen, in words: "transaction Login, app version 2.0" or "4 transactions chosen by id". */
function describeSide(s: SideSelector): string {
  if (s.transactionIds?.length) return `${plural(s.transactionIds.length, 'transaction')} chosen by id`;
  return Object.entries(s.filter ?? {}).filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${SIDE_FIELD[k as keyof TransactionFilter] ?? k} ${v === '' ? '(none)' : v}`).join(', ');
}

/** When no axis was named and the filters show none: the one factor that differs entirely (with what it implies), else none. */
function axisFromData(pool: Transaction[], a: SideSelector, b: SideSelector): ComparisonDimension[] {
  const cross = buildConfoundAssessment(pool, a, b, []).flags.filter((f) => f.kind === 'cross-side').map((f) => f.dimension as ComparisonDimension);
  const lead = cross.find((d) => cross.every((o) => o === d || (IMPLIED[d] ?? []).includes(o)));
  return lead ? [lead] : [];
}

type Verdict = { kind: 'no-si' | 'confounded' | 'few' | 'same' | 'noise' | 'better' | 'worse'; title: string; text: string; tone: 'finding' | 'note' | 'warning' | 'risk' };

/**
 * Two sets of performance transactions side by side: Speed Index first (trimmed mean, median and mean per side, the
 * change), the other metrics, whether the sides are like for like, the runs and those left out as outliers, and a verdict
 * that says when a difference is too small, too noisy or confounded to report. Builds on the pure buildComparison /
 * buildConfoundAssessment. The comparison axis is the one given, else the filters that differ, else the single factor
 * that differs in the data.
 */
export function buildPerformanceComparison(i: { pool: Transaction[]; sideA: SideSelector; sideB: SideSelector; axis?: ComparisonDimension[]; metrics?: PerfMetric[] }): RecipeResult {
  const A = i.sideA, B = i.sideB, la = `"${A.label}"`, lb = `"${B.label}"`;
  const runsA = resolveSide(i.pool, A), runsB = resolveSide(i.pool, B);
  const empty = [runsA.length ? null : A, runsB.length ? null : B].filter((s): s is SideSelector => s != null);
  if (empty.length) {
    throw new Error(`No performance transaction matched ${empty.map((s) => `side "${s.label}" (${describeSide(s) || 'no selection'})`).join(' or ')}. ` +
      'Filters match part of the value, letter case ignored; check the values with list_transactions.');
  }
  const missing = [A, B].flatMap((s) => (s.transactionIds ?? []).filter((id) => !i.pool.some((t) => t.id === id)));
  const metrics: PerfMetric[] = ['speedIndex', ...(i.metrics?.length ? i.metrics : DEFAULT_COMPARISON_METRICS).filter((m) => m !== 'speedIndex')];

  let axis: ComparisonDimension[] = i.axis?.filter((d) => d) ?? [];
  let axisSource: 'given' | 'filters' | 'data' | 'none' = axis.length ? 'given' : 'none';
  if (!axis.length) { axis = axisFromFilters(A, B); if (axis.length) axisSource = 'filters'; }
  if (!axis.length) { axis = axisFromData(i.pool, A, B); if (axis.length) axisSource = 'data'; }
  const implied = [...new Set(axis.flatMap((d) => IMPLIED[d] ?? []))].filter((d) => !axis.includes(d));
  const conf = buildConfoundAssessment(i.pool, A, B, [...axis, ...implied]);
  const cmp = buildComparison(i.pool, A, B, { metrics });
  const axisText = axis.length ? andList(axis.map(dimLabel)) : '';

  // ── The verdict, on Speed Index ──
  const si = cmp.metrics[0];
  const nA = si.sideA.n, nB = si.sideB.n;
  const siA = headlineOf(si, 'sideA'), siB = headlineOf(si, 'sideB');
  const pct = si.percentChangeTrimmedMean;
  const dMed = si.deltaMedian;
  const spread = Math.max(si.sideA.mad ?? 0, si.sideB.mad ?? 0);
  const highCross = conf.flags.filter((f) => f.kind === 'cross-side' && f.severity === 'high');
  const caveat = conf.validity === 'caveated' ? ' Read the caveats under Like for Like before relying on it.' : '';
  const both = `${show('speedIndex', siA)} on ${la}, ${show('speedIndex', siB)} on ${lb}`;
  let verdict: Verdict;
  if (!nA || !nB) {
    const none = [nA ? null : la, nB ? null : lb].filter((x): x is string => x != null);
    verdict = { kind: 'no-si', tone: 'warning', title: 'No Speed Index to Compare',
      text: `${andList(none)} ${none.length === 1 ? 'has' : 'have'} no run with a Speed Index (it is measured from the video of the run). The other metrics are compared below.` };
  } else if (highCross.length) {
    const others = andList(highCross.map((f) => dimLabel(String(f.dimension))));
    verdict = { kind: 'confounded', tone: 'risk', title: 'Not a Like-for-Like Comparison',
      text: (axis.length
        ? `Besides the ${axisText}, the sides differ in ${others}, so the ${pct != null ? `${pctText(pct)} ${pct >= 0 ? 'higher' : 'lower'} ` : ''}Speed Index on ${lb} cannot be put down to the ${axisText} alone. `
        : `No compared factor was named and the sides differ in ${others}, so a difference in Speed Index cannot be put down to any one of them. `) +
        `Choose runs that match in ${others}${axis.length ? '' : ' except the one being compared'}; Like for Like lists the values.` };
  } else if (Math.min(nA, nB) < MIN_VERDICT_RUNS) {
    verdict = { kind: 'few', tone: 'warning', title: 'Too Few Runs for a Verdict',
      text: `${la} has ${plural(nA, 'run')} with a Speed Index and ${lb} ${plural(nB, 'run')}: with fewer than ${MIN_VERDICT_RUNS} on a side one unusual run decides the result. ` +
        `For the record: ${both}. Run each side 5 or more times (10 for short transactions) and compare again.` };
  } else if (pct != null && Math.abs(pct) < SAME_PCT) {
    verdict = { kind: 'same', tone: 'note', title: 'About the Same',
      text: `Speed Index differs by ${pctText(pct)} between the sides (${both}, trimmed means), under ${SAME_PCT}%: no difference worth reporting.${caveat}` };
  } else if (dMed != null && Math.abs(dMed) <= spread) {
    verdict = { kind: 'noise', tone: 'note', title: 'No Clear Difference',
      text: `The trimmed means differ by ${pct != null ? pctText(pct) : 'an unknown share'} (${both}), but the gap between the medians (${n0(Math.abs(dMed))} SI) is within the ` +
        `run-to-run spread of the sides (about ${n0(spread)} SI). More runs per side would settle it.${caveat}` };
  } else {
    const better = (pct ?? 0) < 0;
    verdict = { kind: better ? 'better' : 'worse', tone: better ? 'finding' : 'risk',
      title: `Speed Index ${pctText(pct ?? 0)} ${better ? 'Lower' : 'Higher'} on ${lb}`,
      text: `${lb} scores a ${pctText(pct ?? 0)} ${better ? 'lower' : 'higher'} Speed Index than ${la} (${both}, trimmed means). ` +
        `${better ? 'Lower is better: its screen was visually complete earlier.' : 'Higher is worse: its screen was visually complete later.'} ` +
        `The gap between the medians (${n0(Math.abs(dMed ?? 0))} SI) is larger than the run-to-run spread of either side (about ${n0(spread)} SI), over ${nA} and ${nB} runs.${caveat}` };
  }

  // ── Secondary metrics that moved clearly (10% or more on the trimmed mean, both sides measured) ──
  const moved = cmp.metrics.slice(1).filter((m) => m.percentChangeTrimmedMean != null && Math.abs(m.percentChangeTrimmedMean) >= 10 && m.sideA.n && m.sideB.n)
    .map((m) => `${METRIC_NAME[m.metric as PerfMetric]} ${pctText(m.percentChangeTrimmedMean!)} ${m.percentChangeTrimmedMean! > 0 ? 'higher' : 'lower'} on ${lb}`);

  // ── Runs, outliers ──
  const excluded = new Set([...cmp.sideA.excludedIds, ...cmp.sideB.excludedIds]);
  const allRuns = [...runsA.map((t) => ({ side: A.label, t })), ...runsB.map((t) => ({ side: B.label, t }))];
  const times = allRuns.map((r) => Date.parse(r.t.startTime)).filter(Number.isFinite);
  const first = times.length ? times.reduce((m, t) => (t < m ? t : m), Infinity) : null;
  const last = times.length ? times.reduce((m, t) => (t > m ? t : m), -Infinity) : null;
  const noTelemetry = allRuns.filter((r) => metricValue(r.t, 'cpuAvg') == null && metricValue(r.t, 'memAvg') == null).length;
  const validityWord = conf.validity === 'clean' ? 'Yes' : conf.validity === 'caveated' ? 'With caveats' : 'No';

  const highlights = [
    `${verdict.title}. ${verdict.text}`,
    `Like for like: ${validityWord}${axis.length ? ` (compared: ${axisText}${axisSource === 'filters' ? ', from the filters' : axisSource === 'data' ? ', the only factor that differs' : ''})` : ''}.`,
    ...(moved.length ? [`Also: ${andList(moved)} (trimmed means).`] : []),
    ...(excluded.size ? [`${plural(excluded.size, 'run')} left out as ${excluded.size === 1 ? 'an outlier' : 'outliers'}: ${[...excluded].join(', ')}.`] : []),
    ...(missing.length ? [`Not found: transaction${missing.length === 1 ? '' : 's'} ${missing.join(', ')}.`] : []),
  ];

  // ── Like for like, in plain words ──
  const sideVals = (f: ConfoundFlag) => `${la} ${valuesOf(f.sideAValues)}; ${lb} ${valuesOf(f.sideBValues)}`;
  const likeItems: Array<{ text: string; tone: 'good' | 'bad' | 'neutral' }> = [];
  if (axisSource === 'given') likeItems.push({ text: `Compared: ${axisText}, as asked.`, tone: 'good' });
  else if (axisSource === 'filters') likeItems.push({ text: `Compared: ${axisText}, the filter${axis.length === 1 ? '' : 's'} that differ${axis.length === 1 ? 's' : ''} between the sides.`, tone: 'good' });
  else if (axisSource === 'data') likeItems.push({ text: `Compared: ${axisText}, the only factor that differs between the sides.`, tone: 'good' });
  if (implied.length) likeItems.push({ text: `Comparing the ${axisText} also compares the ${andList(implied.map(dimLabel))}.`, tone: 'neutral' });
  for (const f of conf.flags) {
    if (f.dimension === 'region') likeItems.push({ text: 'Region is not recorded on a transaction, so a comparison of regions cannot be checked here: confirm each side\'s devices in the device list.', tone: 'neutral' });
    else if (f.kind === 'cross-side') likeItems.push({ text: `${cap(dimLabel(String(f.dimension)))} differs between the sides: ${sideVals(f)}.`, tone: f.severity === 'high' ? 'bad' : 'neutral' });
    else if (f.kind === 'within-side') likeItems.push({ text: `${cap(dimLabel(String(f.dimension)))} varies within a side (${sideVals(f)}): it adds noise, not a bias.`, tone: 'neutral' });
    else if (f.kind === 'telemetry') likeItems.push({ text: `${plural(noTelemetry, 'run')} of ${allRuns.length} recorded no CPU or memory (no telemetry from the device): those figures leave ${noTelemetry === 1 ? 'it' : 'them'} out.`, tone: 'neutral' });
    else if (f.kind === 'imbalance') likeItems.push({ text: `${la} has ${plural(runsA.length, 'run')} and ${lb} ${plural(runsB.length, 'run')}: the figures of the smaller side are less certain.`, tone: 'neutral' });
  }
  if (!conf.flags.some((f) => f.kind === 'cross-side' || f.kind === 'within-side')) {
    likeItems.push({ text: axis.length ? 'Nothing else that is recorded differs: app version, device, OS version, network profile and transaction match.'
      : 'The sides do not differ in any recorded factor: same app version, device, OS version, network profile and transaction.', tone: 'good' });
  }

  const sections: Section[] = [
    { title: 'At a Glance', blocks: [
      { type: 'kpis', items: [
        { value: show('speedIndex', siA), label: `${la}: Speed Index` }, { value: show('speedIndex', siB), label: `${lb}: Speed Index`, accent: 'teal' },
        { value: pct == null ? 'n/a' : signed(pct), label: `Change on ${lb}` }, { value: `${nA} / ${nB}`, label: 'Runs counted' },
        { value: validityWord, label: 'Like for like' }] },
      { type: 'callout', tone: verdict.tone, title: verdict.title, text: verdict.text }],
    whatItMeans: 'Speed Index figures are trimmed means: the top and bottom 10% of runs are dropped before averaging. Speed Index is a composite score of how early the screen is visually complete: lower is better, and a difference in SI is not a number of milliseconds.' },
  ];
  if (nA && nB) {
    const three = (s: 'sideA' | 'sideB') => [si[s].trimmedMean, si[s].median, si[s].mean].map((v) => Math.round(v ?? 0));
    const skew = (s: 'sideA' | 'sideB') => (si[s].mean != null && si[s].median ? Math.abs(si[s].mean! - si[s].median!) / si[s].median! > 0.1 : false);
    const skewed = [skew('sideA') ? la : null, skew('sideB') ? lb : null].filter((x): x is string => x != null);
    sections.push({ title: 'Speed Index', blocks: [
      { type: 'bar', unit: 'SI', decimals: 0, categories: ['Trimmed mean', 'Median', 'Mean'], series: [{ name: A.label, values: three('sideA') }, { name: B.label, values: three('sideB') }] },
      { type: 'table', columns: [{ key: 'side', label: 'Side' }, { key: 'n', label: 'Runs', format: 'number' }, { key: 'min', label: 'Lowest (SI)', format: 'number', decimals: 0 },
        { key: 'max', label: 'Highest (SI)', format: 'number', decimals: 0 }, { key: 'spread', label: 'Run-to-run spread (SI)', format: 'number', decimals: 0 }],
      rows: (['sideA', 'sideB'] as const).map((s) => ({ side: s === 'sideA' ? A.label : B.label, n: si[s].n, min: si[s].min, max: si[s].max, spread: si[s].mad == null ? null : Math.round(si[s].mad!) })) }],
    whatItMeans: (skewed.length
      ? `On ${andList(skewed)} the mean is more than 10% away from the median: a few runs differ a lot from the rest, so the median and trimmed mean describe a typical run better. `
      : 'Trimmed mean, median and mean agree on both sides: no handful of unusual runs is moving the figures. ') +
      'The spread is the scaled median absolute deviation: how far a typical run lies from its side\'s median.' });
  }
  sections.push({ title: 'All Metrics', blocks: [{ type: 'table', columns: [{ key: 'metric', label: 'Metric' }, { key: 'side', label: 'Side' }, { key: 'n', label: 'Runs', format: 'number' },
    { key: 'trimmed', label: 'Trimmed mean' }, { key: 'median', label: 'Median' }, { key: 'mean', label: 'Mean' }, { key: 'change', label: `Change on ${lb}` }],
  rows: cmp.metrics.flatMap((m) => {
    const k = m.metric as PerfMetric;
    const unit = m.unit === 'bytes' ? 'MB' : m.unit === 'ms' ? 's' : m.unit;
    return [{ metric: `${METRIC_NAME[k]} (${unit})`, side: A.label, n: m.sideA.n, trimmed: show(k, m.sideA.trimmedMean), median: show(k, m.sideA.median), mean: show(k, m.sideA.mean), change: '' },
      { metric: '', side: B.label, n: m.sideB.n, trimmed: show(k, m.sideB.trimmedMean), median: show(k, m.sideB.median), mean: show(k, m.sideB.mean),
        change: m.percentChangeTrimmedMean == null ? 'n/a' : signed(m.percentChangeTrimmedMean) }];
  }) }],
  whatItMeans: (moved.length ? `Beyond Speed Index: ${andList(moved)}. ` : 'No other metric moved by 10% or more. ') +
    'Lower is better for every metric here. Duration is wall-clock time from the start to the end of the transaction; CPU, memory and battery are averages over it.' +
    (noTelemetry ? ` ${plural(noTelemetry, 'run')} recorded no CPU or memory and ${noTelemetry === 1 ? 'is' : 'are'} left out of those two.` : '') });
  sections.push({ title: 'Like for Like', blocks: [{ type: 'findings', items: likeItems }],
    whatItMeans: conf.validity === 'clean' ? (axis.length ? `The sides match in every recorded factor except the ${axisText}, so a difference can be put down to it.` : 'The sides match in every recorded factor.')
      : conf.validity === 'caveated' ? 'Usable with care: the factors above add noise or thin out the CPU and memory figures, but no other factor differs entirely between the sides.'
        : 'A factor other than the one compared differs entirely between the sides, so a difference cannot be put down to the compared factor alone.' });
  sections.push({ title: 'Runs', blocks: [{ type: 'table', maxRows: 100, columns: [{ key: 'side', label: 'Side' }, { key: 'id', label: 'Transaction', format: 'mono' }, { key: 'when', label: 'Started' },
    { key: 'device', label: 'Device' }, { key: 'os', label: 'OS version' }, { key: 'app', label: 'App version' }, { key: 'profile', label: 'Network profile' },
    { key: 'si', label: 'Speed Index (SI)', format: 'number', decimals: 0 }, { key: 'secs', label: 'Duration (s)', format: 'number', decimals: 2 },
    { key: 'cpu', label: 'CPU (%)', format: 'number', decimals: 1 }, { key: 'used', label: 'Counted' }],
  rows: allRuns.map(({ side, t }) => ({ side, id: String(t.id), when: when(t), device: t.deviceName || t.deviceModel || '', os: t.deviceVersion || '', app: t.appVersion || '',
    profile: profile(t.networkProfile), si: metricValue(t, 'speedIndex'), secs: t.duration > 0 ? Math.round(t.duration / 10) / 100 : null, cpu: metricValue(t, 'cpuAvg'),
    used: excluded.has(t.id) ? 'Left out: outlier' : metricValue(t, 'speedIndex') == null ? 'No Speed Index' : 'Yes' })) }],
  whatItMeans: `${plural(runsA.length, 'run')} on ${la} and ${plural(runsB.length, 'run')} on ${lb}${first != null && last != null ? `, between ${longDate(first)} and ${longDate(last)}` : ''}. ` +
    (excluded.size ? `${plural(excluded.size, 'run')} ${excluded.size === 1 ? 'lies' : 'lie'} far from ${excluded.size === 1 ? 'its' : 'their'} side's median Speed Index and ${excluded.size === 1 ? 'is' : 'are'} left out of every figure; such a run usually had a problem of its own (a busy device, a network hiccup, a cold start): run it again rather than keep it. ` : '') +
    (Math.min(runsA.length, runsB.length) < 4 ? 'A side with fewer than 4 runs is not checked for outliers.' : 'Both sides were checked for outliers.') +
    (missing.length ? ` Transaction${missing.length === 1 ? '' : 's'} ${missing.join(', ')} ${missing.length === 1 ? 'was' : 'were'} not found.` : '') });

  return {
    highlights,
    spec: {
      title: 'Performance Comparison',
      subtitle: `${la} against ${lb}`,
      meta: [{ label: A.label, value: `${describeSide(A) || 'every transaction'} (${plural(runsA.length, 'run')})` },
        { label: B.label, value: `${describeSide(B) || 'every transaction'} (${plural(runsB.length, 'run')})` },
        ...(first != null && last != null ? [{ label: 'Runs from', value: `${longDate(first)} to ${longDate(last)}` }] : [])],
      headline: pct != null && nA && nB ? { value: signed(pct), label: `Speed Index on ${lb} against ${la} (lower is better)` } : undefined,
      sections,
      source: 'Source: Digital.ai Testing reporter, performance transactions visible to this access key. A metric leaves out the runs that did not record it. ' +
        'Runs whose Speed Index lies more than 3.5 times the usual spread from their side\'s median are left out of every metric, on a side with 4 or more runs. ' +
        `Trimmed means drop the top and bottom 10%. A change under ${SAME_PCT}% is reported as about the same; a larger one counts as clear only when the gap between the medians exceeds the ` +
        'run-to-run spread (scaled median absolute deviation) of both sides. Speed Index (SI) is a composite score of visual completeness over time, lower is better.',
    },
  };
}
