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
