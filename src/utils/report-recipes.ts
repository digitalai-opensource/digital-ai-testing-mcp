/**
 * Report recipes (create_report): turn platform data into a render_report spec with the interpretation already
 * written. Pure — the data is collected in src/api/report-recipes.ts and these builders are fixture-tested.
 *
 * The agent spends almost nothing here: the server fetches, aggregates, lays out and writes a first "What it means"
 * for every section from the numbers. The agent may replace any of those texts with its own (create_report runId +
 * whatItMeans) when it knows more than the numbers say.
 */
import type { Block, ReportSpec, Section } from './report-render.js';
import { tallyStatuses, passRate, statusOutcome, type StatusCounts } from './test-status.js';
import { INFRA_CATEGORIES, type RunRecord } from './device-health.js';
import { causeQuote, causeGroupKey } from './failure-cause.js';

export { causeQuote } from './failure-cause.js';

export interface RecipeResult { spec: ReportSpec; highlights: string[] }

export interface TestRun extends RunRecord { test_id: number; duration: number | null }
/** Reporter status counts per value of one key (device.os, device.serialNumber …), counted by the reporter. */
export type GroupCounts = Array<{ key: string | null; counts: StatusCounts }>;

const DAY = 86_400_000;
const pct1 = (x: number | null) => (x == null ? 'n/a' : `${x.toFixed(1)}%`);
const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
const MONTH = ['Jan.', 'Feb.', 'March', 'April', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];
/*
 * Days are the SERVER'S LOCAL days (the user's own time zone on an npm install; the container's, normally UTC, under
 * Docker). UTC days put a run at 20:05 in New York on the next day, and the report showed "tomorrow" (seen live
 * 2026-11-23). The usage report is the exception: the platform cuts its CSV at UTC midnight, so usage-summary passes
 * utc = true and says "(UTC)".
 */
const parts = (t: number, utc: boolean) => {
  const d = new Date(t);
  return utc ? { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), w: d.getUTCDay() } : { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), w: d.getDay() };
};
const at = (y: number, m: number, d: number, utc: boolean) => (utc ? Date.UTC(y, m, d) : new Date(y, m, d).getTime());
export const longDate = (t: number, utc = false) => { const p = parts(t, utc); return `${MONTH[p.m]} ${p.d}, ${p.y}`; };
const shortDay = (t: number, utc = false) => { const p = parts(t, utc); return `${p.m + 1}/${p.d}`; };

/** Midnight that starts the day of t (local unless utc). */
export function dayStart(t: number, utc = false): number { const p = parts(t, utc); return at(p.y, p.m, p.d, utc); }
/** Midnight that starts the day `n` days after the day of t; calendar days, so a DST change does not shift it. */
export function addDays(t: number, n: number, utc = false): number { const p = parts(t, utc); return at(p.y, p.m, p.d + n, utc); }
/** YYYY-MM-DD of t (local unless utc). */
export function isoDate(t: number, utc = false): string { const p = parts(t, utc); return `${p.y}-${String(p.m + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; }

/** Bucket start (the day, or the Monday of the week) for a timestamp. */
export function bucketStart(t: number, by: 'day' | 'week', utc = false): number {
  if (by === 'day') return dayStart(t, utc);
  return addDays(t, -((parts(t, utc).w + 6) % 7), utc); // Monday = 0
}
export function buckets(from: number, to: number, by: 'day' | 'week', utc = false): number[] {
  const out: number[] = [];
  for (let t = bucketStart(from, by, utc); t <= to; t = addDays(t, by === 'day' ? 1 : 7, utc)) out.push(t);
  return out;
}

function rangeMeta(from: number, to: number, projectName?: string, utc = false): Array<{ label: string; value: string }> {
  return [
    ...(projectName ? [{ label: 'Project', value: projectName }] : []),
    { label: 'Range', value: `${longDate(from, utc)} to ${longDate(to, utc)}${utc ? ' (UTC)' : ''}` },
  ];
}

const isFail = (s: string) => statusOutcome(s) === 'fail';
const osLabel = (r: TestRun) => r.deviceOs ? (/^ios$/i.test(r.deviceOs) ? 'iOS' : /^android$/i.test(r.deviceOs) ? 'Android' : r.deviceOs) : 'Web or no device';
const CATEGORY_LABEL: Record<string, string> = {
  assertion: 'Assertion', script: 'Script', application: 'Application', device: 'Device', environment: 'Environment',
  network: 'Network', framework_error: 'Framework', unclassified: 'Unclassified',
};
const catLabel = (c: string | null) => CATEGORY_LABEL[(c ?? '').toLowerCase()] ?? (c ? c : 'Not classified');

function countBy<T>(rows: T[], key: (r: T) => string): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** Top N as categories + an "All others" line, so a long tail never becomes a wall of bars. */
function topN(entries: Array<[string, number]>, n: number): { cats: string[]; vals: number[]; other: number } {
  const head = entries.slice(0, n);
  return { cats: head.map(([k]) => k), vals: head.map(([, v]) => v), other: entries.slice(n).reduce((s, [, v]) => s + v, 0) };
}

/** What the platform's failure classification says, honest about how much of it is unclassified. */
/**
 * What the platform's classification says about where the failures come from. When most failures are unclassified it
 * gives the split of the rest as numbers and NO verdict: a report with 72% unclassified said "the lab is not the main
 * problem" while its own top cause, two thirds of all failures and unclassified, was a connection error (UAT 2026-11-24).
 * `topCause` is the most common cause of the same failures, when known.
 */
export function classificationMeans(failures: number, classified: number, infra: number, groups: Array<[string, number]>,
  topCause?: { n: number; classified: boolean }): string {
  if (!classified) return 'The platform did not classify these failures, so they cannot be split into lab and test or app problems.';
  const unclassifiedShare = 1 - classified / failures;
  const infraShare = infra / classified;
  if (unclassifiedShare >= 0.5) {
    const lab = Math.round(infraShare * 100);
    return `The platform left ${Math.round(unclassifiedShare * 100)}% of failures unclassified, so the classification cannot say where the problem is. ` +
      `Of the ${plural(classified, 'classified failure')}, ${lab}% point at the lab (device, environment, network, framework) and ${100 - lab}% at the test or the app. ` +
      (topCause && !topCause.classified
        ? `The most common cause (${plural(topCause.n, 'failure')}) is among the unclassified ones: read the causes before deciding where to look.`
        : 'Read the most common causes before deciding where to look.');
  }
  const lead = `${groups[0][0]} is the largest group (${Math.round((groups[0][1] / failures) * 100)}%). Of the classified failures, `;
  const verdict = infraShare >= 0.4
    ? `${Math.round(infraShare * 100)}% point at the lab (device, environment, network, framework): fix the lab before the tests.`
    : `${Math.round((1 - infraShare) * 100)}% point at the test or the app (assertion, script, application), so the lab is not the main problem.`;
  return lead + verdict;
}

/**
 * A test name without its run-specific parts (hex/UUID ids, dates, times, trailing run numbers), so "Login 0000811-ABC
 * 2397" and "Login 0000811-DEF 2398" count as one test. Live data: 925 of 928 failures had distinct raw names.
 */
export function testFamily(name: string): string {
  const out = name
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
    .replace(/\b(?=[0-9a-f-]*\d)[0-9a-f]{6,}(?:-[0-9a-f]{3,})*\b/gi, ' ')
    .replace(/\b[A-Z0-9]{10,}\b/g, (m) => (/\d/.test(m) && /[A-Z]/.test(m) ? ' ' : m))
    // A trailing device serial or short run code (_03R1KL, _98401C): letters AND digits, 6 or more, at the end only.
    .replace(/[\s_-]+(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,}\s*$/, '')
    .replace(/(?:[\s_#-]+\d+)+\s*$/g, '')
    .replace(/\s+/g, ' ')
    // A separator left at the end once a date or id was taken off ("Container report - 2026-11-25" → "Container report").
    .replace(/[\s_#:,;\-–—]+$/, '')
    .trim();
  return out || name.trim();
}

/**
 * Example prompts for a newly connected user (check_connectivity, README "How do I use"). One line each, worded the
 * way a user would ask; each maps to one create_report recipe. Usage needs Cloud Admin, so it is offered only there.
 */
export function exampleReportPrompts(role: string | undefined, projectName?: string): string[] {
  const p = projectName ? ` for ${projectName}` : '';
  return [
    `"Give me a test summary report${p} for the last 7 days"`,
    `"Why are tests failing this week? Make a failure analysis report"`,
    `"Show me a device health report: which devices need attention?"`,
    ...(role === 'Admin' ? [`"Create a usage summary for project <name> for the last 90 days"`] : []),
    `"Find an available Android phone and open my app in an inspection session"`,
  ];
}

// ── Test summary ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TestSummaryInput {
  runs: TestRun[];
  previous: TestRun[] | null;
  /** Failed and Error runs of the window with device, cause and classification. */
  failures: TestRun[];
  platforms: GroupCounts | null;
  devicesUsed: number | null;
  from: number;
  to: number;
  days: number;
  projectName?: string;
  passRateGoal?: number;
  capped?: boolean;
  /** The window is complete, but the scan reached its limit inside the previous period, so nothing is compared. */
  comparisonCut?: boolean;
}

export function buildTestSummary(i: TestSummaryInput): RecipeResult {
  const by: 'day' | 'week' = i.days <= 31 ? 'day' : 'week';
  const c = tallyStatuses(i.runs);
  const rate = passRate(c);
  const prevRate = i.previous ? passRate(tallyStatuses(i.previous)) : null;
  const failures = c.failed + c.error;
  const prevFailures = i.previous ? i.previous.filter((r) => isFail(r.status)).length : null;
  const tests = new Set(i.runs.map((r) => r.name)).size;
  const devices = i.devicesUsed ?? new Set(i.runs.map((r) => r.serial).filter(Boolean)).size;
  const highlights: string[] = [];
  const delta = rate != null && prevRate != null ? rate - prevRate : null;
  const prevPeriod = i.days === 1 ? 'previous day' : `previous ${i.days} days`;

  const kpis: Block = {
    type: 'kpis', items: [
      { value: c.total.toLocaleString('en-US'), label: 'Tests executed', ...(i.previous ? { delta: `${c.total >= i.previous.length ? '▲' : '▼'} ${Math.abs(c.total - i.previous.length).toLocaleString('en-US')} vs. ${prevPeriod}`, deltaGood: true } : {}) },
      { value: pct1(rate), label: 'Pass rate', ...(delta != null ? { delta: `${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(1)} points vs. ${prevPeriod}`, deltaGood: delta >= 0 } : {}) },
      { value: failures.toLocaleString('en-US'), label: 'Failed or error', accent: 'fail' as const, ...(prevFailures != null ? { delta: `${failures <= prevFailures ? '▼' : '▲'} ${Math.abs(failures - prevFailures).toLocaleString('en-US')} vs. ${prevPeriod}`, deltaGood: failures <= prevFailures } : {}) },
      // Raw names: the Failures tab groups names that differ only in run ids, so "tests" alone read as a contradiction.
      { value: tests.toLocaleString('en-US'), label: 'Distinct test names', accent: 'teal' as const },
      { value: devices.toLocaleString('en-US'), label: 'Devices used', accent: 'teal' as const },
    ],
  };
  if (!c.total) highlights.push(`No runs between ${longDate(i.from)} and ${longDate(i.to)}.`);
  if (rate != null) highlights.push(`Pass rate ${pct1(rate)} over ${plural(c.total, 'run')}${delta != null ? ` (${delta >= 0 ? 'up' : 'down'} ${Math.abs(delta).toFixed(1)} points)` : ''}.`);

  // Volume per bucket, stacked by outcome.
  const keys = buckets(i.from, i.to, by);
  const idx = new Map(keys.map((k, n) => [k, n]));
  const passed = keys.map(() => 0), failed = keys.map(() => 0), other = keys.map(() => 0);
  for (const r of i.runs) {
    const n = idx.get(bucketStart(Date.parse(r.start_time), by));
    if (n == null) continue;
    const o = statusOutcome(r.status);
    (o === 'pass' ? passed : o === 'fail' ? failed : other)[n]++;
  }
  const totals = keys.map((_, n) => passed[n] + failed[n] + other[n]);
  const busiest = totals.reduce((b, v, n) => (v > totals[b] ? n : b), 0);
  const idle = totals.filter((v) => v === 0).length;
  const avg = c.total / Math.max(1, keys.length);
  const half = Math.floor(keys.length / 2);
  const firstHalf = totals.slice(0, half).reduce((s, v) => s + v, 0), secondHalf = totals.slice(keys.length - half).reduce((s, v) => s + v, 0);
  const volumeTrend = keys.length >= 6 && firstHalf > 0 ? (secondHalf - firstHalf) / firstHalf : 0;
  const cats = keys.map((k) => shortDay(k));
  const unit = by === 'day' ? 'day' : 'week';
  // One bucket has no average and no busiest: "about 534 runs per day; the busiest day was 11/24 with 534".
  const volumeMeans = (keys.length === 1 ? `${plural(c.total, 'run')} on ${cats[0]}.`
    : `About ${Math.round(avg).toLocaleString('en-US')} runs per ${unit}; the busiest ${unit} was ${cats[busiest]} with ${totals[busiest].toLocaleString('en-US')}.`) +
    (idle ? ` ${plural(idle, unit)} had no runs at all.` : '') +
    (Math.abs(volumeTrend) >= 0.2 ? ` Volume in the second half of the range is ${Math.abs(Math.round(volumeTrend * 100))}% ${volumeTrend > 0 ? 'higher' : 'lower'} than in the first half.` : '');

  // Pass rate per bucket.
  const rates = keys.map((_, n) => (passed[n] + failed[n] > 0 ? Math.round((passed[n] / (passed[n] + failed[n])) * 1000) / 10 : null));
  const valid = rates.map((v, n) => [v, n] as const).filter(([v]) => v != null) as Array<[number, number]>;
  const worst = valid.reduce<[number, number] | null>((w, x) => (w == null || x[0] < w[0] ? x : w), null);
  const rateMeans = rate == null ? 'No run in this range reached a verdict.' :
    `Pass rate was ${pct1(rate)}${delta != null ? `, ${delta >= 0 ? 'up' : 'down'} ${Math.abs(delta).toFixed(1)} points on the ${prevPeriod}` : ''}.` +
    // With one day there is no "lowest day" and no "1 of 1 days" (UAT 2026-11-25).
    (worst && valid.length > 1 ? ` The lowest ${unit} was ${cats[worst[1]]} at ${worst[0].toFixed(1)}%.` : '') +
    (i.passRateGoal == null ? '' : valid.length === 1 ? ` That ${valid[0][0] >= i.passRateGoal ? 'meets' : 'is below'} the ${i.passRateGoal}% goal.`
      : ` ${valid.filter(([v]) => v >= i.passRateGoal!).length} of ${valid.length} ${unit}s met the ${i.passRateGoal}% goal.`);

  // Platforms (counted by the reporter for the window).
  const plat = (i.platforms ?? []).map((g) => ({ label: osLabel({ deviceOs: g.key } as TestRun), c: g.counts })).sort((a, b) => b.c.total - a.c.total);
  const platforms = plat.map((x) => x.label);
  const platPass = plat.map((x) => x.c.passed + x.c.healed);
  const platFail = plat.map((x) => x.c.failed + x.c.error);
  const platRates = platforms.map((p, n) => (platPass[n] + platFail[n] ? (platPass[n] / (platPass[n] + platFail[n])) * 100 : null));
  const lowPlat = platforms.length > 1 ? platRates.reduce<number>((w, v, n) => (v != null && (platRates[w] == null || v < platRates[w]!) ? n : w), 0) : -1;
  const platMeans = platforms.length < 2 ? `All runs were on ${platforms[0] ?? 'no platform'}.` :
    `${platforms[lowPlat]} had the lowest pass rate (${pct1(platRates[lowPlat])} over ${plural(platPass[lowPlat] + platFail[lowPlat], 'run')}); ` +
    platforms.filter((_, n) => n !== lowPlat).map((p) => `${p} ${pct1(platRates[platforms.indexOf(p)])}`).join(', ') + '.';

  // Failing tests, grouped by name family (run-specific ids stripped).
  const fam = new Map<string, string>();
  const famOf = (n: string) => { let f = fam.get(n); if (f == null) { f = testFamily(n); fam.set(n, f); } return f; };
  const failRuns = i.runs.filter((r) => isFail(r.status));
  const byTest = countBy(failRuns, (r) => famOf(r.name));
  const top = byTest.slice(0, 10);
  const runsOf = new Map(countBy(i.runs, (r) => famOf(r.name)));
  const variants = new Map<string, Set<string>>();
  for (const r of i.runs) { const f = famOf(r.name); (variants.get(f) ?? variants.set(f, new Set()).get(f)!).add(r.name); }
  const lastStatus = new Map<string, { t: number; s: string }>();
  for (const r of i.runs) { const f = famOf(r.name); const t = Date.parse(r.start_time); const p = lastStatus.get(f); if (!p || t > p.t) lastStatus.set(f, { t, s: r.status }); }
  const sparkOf = (name: string) => keys.map((k) => failRuns.filter((r) => famOf(r.name) === name && bucketStart(Date.parse(r.start_time), by) === k).length);
  const topShare = failures ? top.slice(0, 5).reduce((s, [, v]) => s + v, 0) / failures : 0;
  // "The top five account for 100%" beside a sixth failing test (931 of 933 rounded up), or said of a single failing test:
  // the clause is left out with five or fewer tests, and a share below 100% never rounds up to it.
  const topFive = byTest.length <= 5 ? '' : ` The top five account for ${topShare >= 1 ? '100' : Math.min(99.9, Math.floor(topShare * 1000) / 10)}% of failures.`;
  const failMeans = !failures ? 'No test failed in this range.' :
    `${plural(byTest.length, 'test')} failed at least once (names that differ only in ids, dates or run numbers count as one).${topFive} "${top[0][0]}" failed ${plural(top[0][1], 'time')} in ${plural(runsOf.get(top[0][0]) ?? 0, 'run')}.`;
  if (failures && top[0]) highlights.push(`Most frequent failure: "${top[0][0]}" (${plural(top[0][1], 'failure')}).`);

  // Causes (from the detailed failure scan).
  const det = i.failures;
  const cats2 = countBy(det, (r) => catLabel(r.errorCategory));
  const infra = det.filter((r) => INFRA_CATEGORIES.has((r.errorCategory ?? '').toLowerCase())).length;
  const classified = det.filter((r) => r.errorCategory && r.errorCategory.toLowerCase() !== 'unclassified').length;
  const detCause = countBy(det, (r) => (r.cause ?? '').replace(/\s+/g, ' ').trim().slice(0, 140))[0];
  const detTop = detCause && detCause[0] ? { n: detCause[1], classified: !!det.find((r) => (r.cause ?? '').replace(/\s+/g, ' ').trim().slice(0, 140) === detCause[0] && r.errorCategory && r.errorCategory.toLowerCase() !== 'unclassified') } : undefined;
  const causeMeans = !det.length ? 'Nothing to classify.' : classificationMeans(det.length, classified, infra, cats2, detTop);
  // No lab-or-test headline from a minority of the failures (see classificationMeans).
  if (det.length && classified / det.length <= 0.5) highlights.push(`The platform left ${Math.round((1 - classified / det.length) * 100)}% of failures unclassified.`);
  else if (classified) highlights.push(`${Math.round((infra / classified) * 100)}% of classified failures point at the lab (device, environment, network, framework).`);

  // A scan that stopped at its record limit covers only the newest runs. Said only at the bottom, a report headed
  // "Last 90 days" held the last four (10,000 runs of a project with ~2,000 a day, live 2026-11-24): say it first.
  const oldest = i.runs.reduce((t, r) => Math.min(t, Date.parse(r.start_time) || t), Infinity);
  const coverage = i.capped && Number.isFinite(oldest) && dayStart(oldest) > dayStart(i.from)
    ? { from: oldest, days: Math.max(1, Math.round((dayStart(i.to) - dayStart(oldest)) / DAY) + 1) } : null;
  if (coverage) {
    highlights.unshift(`Only the newest ${plural(c.total, 'run')} were read: the report covers ${longDate(coverage.from)} to ${longDate(i.to)} ` +
      `(${plural(coverage.days, 'day')}), not the ${i.days} days asked for.`);
  }
  const overview: Section[] = [
    ...(coverage ? [{ title: 'Coverage', blocks: [{ type: 'callout' as const, tone: 'warning' as const, title: `This report covers ${plural(coverage.days, 'day')}, not ${i.days}`,
      text: `The scan stopped at its limit of ${plural(c.total, 'run')}, which reach back to ${longDate(coverage.from)}. Runs from ${longDate(i.from)} ` +
        `to that day are not in any figure below. Ask for a shorter window or a higher limit (maxRecords, up to 25,000); for exact runs and pass rate ` +
        `over the whole range, the test trend report (create_test_trend_report) counts every run.` }] }] : []),
    { title: 'At a Glance', blocks: [kpis] },
    { title: `Runs per ${by === 'day' ? 'Day' : 'Week'}`, blocks: [{ type: 'bar', stacked: true, categories: cats, orientation: 'vertical',
      partial: [cats[cats.length - 1]], partialNote: `The last ${unit} is still in progress`, series: [
      { name: 'Passed', values: passed, tone: 'pass' }, { name: 'Failed or error', values: failed, tone: 'fail' }, { name: 'Other (incomplete, skipped)', values: other, tone: 'skip' }] }],
    whatItMeans: volumeMeans },
    { title: 'Pass Rate Over Time', blocks: [{ type: 'line', categories: cats, unit: '%', series: [{ name: 'Pass rate', values: rates }],
      ...(i.passRateGoal != null ? { target: { value: i.passRateGoal, label: `Goal ${i.passRateGoal}%` } } : {}) }], whatItMeans: rateMeans },
    ...(platforms.length ? [{ title: 'Results by Platform', blocks: [{ type: 'bar' as const, stacked: true, orientation: 'horizontal' as const, categories: platforms, series: [
      { name: 'Passed', values: platPass, tone: 'pass' as const }, { name: 'Failed or error', values: platFail, tone: 'fail' as const }] }], whatItMeans: platMeans }] : []),
  ];
  const failuresTab: Section[] = [
    { title: 'Most Frequent Failures', blocks: [{ type: 'table', columns: [
      { key: 'name', label: 'Test' }, { key: 'fails', label: 'Failures', format: 'number' }, { key: 'runs', label: 'Runs', format: 'number' },
      { key: 'rate', label: 'Pass rate', format: 'percent', decimals: 1 }, { key: 'last', label: 'Last result', format: 'status' }, { key: 'trend', label: `Failures per ${unit}`, format: 'spark' }],
    rows: top.map(([name, fails]) => {
      const runs = runsOf.get(name) ?? fails;
      const v = variants.get(name)?.size ?? 1;
      return { name: v > 1 ? `${name} (${v} name variants)` : name, fails, runs, rate: runs ? ((runs - fails) / runs) * 100 : null, last: lastStatus.get(name)?.s ?? '', trend: sparkOf(name) };
    }) }], whatItMeans: failMeans },
    { title: 'Failure Classification', blocks: [{ type: 'bar', orientation: 'horizontal', showShare: true, categories: cats2.map(([k]) => k), series: [{ name: 'Failures', values: cats2.map(([, v]) => v), tone: 'fail' }] }], whatItMeans: causeMeans },
  ];
  return {
    highlights,
    spec: {
      title: 'Test Execution Summary',
      subtitle: coverage ? `Newest ${plural(c.total, 'run')}: ${plural(coverage.days, 'day')} of the last ${i.days}`
        : `Last ${plural(i.days, 'day')}${i.previous ? `, compared with the ${i.days === 1 ? 'day' : `${i.days} days`} before` : ''}`,
      // The range shown is the range the figures cover.
      meta: rangeMeta(coverage?.from ?? i.from, i.to, i.projectName),
      headline: rate != null ? { value: pct1(rate), label: 'Pass rate' } : undefined,
      tabs: [{ label: 'Overview', sections: overview }, { label: 'Failures', sections: failuresTab }],
      source: `Source: Digital.ai Testing reporter, ${plural(c.total, 'run')} from ${longDate(coverage?.from ?? i.from)} to ${longDate(i.to)}. ` +
        'Pass rate = (Passed + Healed) / (Passed + Healed + Failed + Error); incomplete and skipped runs are excluded.' +
        (coverage ? ` **The scan hit its record limit: the ${i.days} days asked for begin ${longDate(i.from)}, and the runs before ${longDate(coverage.from)} were not read.**`
          : i.capped ? ' **The scan hit its record limit, so the oldest part of the range is incomplete.**' : '') +
        (i.comparisonCut ? ' The previous period is not compared: the scan reached its record limit before all of it was read.' : ''),
    },
  };
}

// ── Test inventory ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface InventoryRow { project: string; user: string | null; counts: StatusCounts }

export const emptyCounts = (): StatusCounts => ({ passed: 0, failed: 0, error: 0, incomplete: 0, skipped: 0, healed: 0, total: 0 });
export function addCounts(a: StatusCounts, b: StatusCounts): StatusCounts {
  return { passed: a.passed + b.passed, failed: a.failed + b.failed, error: a.error + b.error, incomplete: a.incomplete + b.incomplete,
    skipped: a.skipped + b.skipped, healed: a.healed + b.healed, total: a.total + b.total };
}

/**
 * Every test report by project, user and status, from the platform's own counts (no window, nothing read run by run).
 * `projects` is every project asked, so the ones without a report are counted; `reporterOnly` names reporter projects
 * that have no cloud project (null when the cloud list could not be read); `failed` names projects that did not answer.
 */
export function buildTestInventory(i: { rows: InventoryRow[]; projects: string[]; reporterOnly: string[] | null; failed: Array<{ project: string; error: string }>;
  scope: 'all' | 'one' | 'own'; now: number; storage?: Array<{ project: string; mb: number; quotaMb: number }> | null }): RecipeResult {
  const n = (x: number) => x.toLocaleString('en-US');
  const sumBy = (key: (r: InventoryRow) => string) => {
    const m = new Map<string, StatusCounts>();
    for (const r of i.rows) m.set(key(r), addCounts(m.get(key(r)) ?? emptyCounts(), r.counts));
    return [...m].filter(([, c]) => c.total > 0).sort((a, b) => b[1].total - a[1].total);
  };
  const NO_USER = '(no user recorded)';
  const byProject = sumBy((r) => r.project);
  const byUser = sumBy((r) => r.user ?? NO_USER);
  const all = i.rows.reduce((c, r) => addCounts(c, r.counts), emptyCounts());
  const rate = passRate(all);
  const share = (v: number) => Math.round((v / Math.max(all.total, 1)) * 1000) / 10;
  // A whole-number share for a sentence: never 100 unless it is everything (99.5% of 4 million is not "100%").
  const wholeShare = (v: number) => (v >= all.total ? 100 : Math.min(99, Math.round(share(v))));
  const usersOf = (project: string) => new Set(i.rows.filter((r) => r.project === project && r.user != null && r.counts.total > 0).map((r) => r.user)).size;
  const projectsOf = (user: string) => new Set(i.rows.filter((r) => (r.user ?? NO_USER) === user && r.counts.total > 0).map((r) => r.project)).size;
  const reporterOnly = new Set(i.reporterOnly ?? []);
  const orphans = byProject.filter(([p]) => reporterOnly.has(p)).length;
  const named = byUser.filter(([u]) => u !== NO_USER);
  const one = i.scope !== 'all';
  const where = one ? `project ${i.projects[0]}` : `${plural(i.projects.length, 'project')}`;

  const highlights = [
    `${n(all.total)} test reports in ${one ? where : `${n(byProject.length)} of ${where}`}, all dates; pass rate ${pct1(rate)}.`,
    ...(!one && byProject[0] ? [`${byProject[0][0]} holds ${share(byProject[0][1].total)}% of them${byProject[1] ? `, ${byProject[1][0]} ${share(byProject[1][1].total)}%` : ''}.`] : []),
    ...(named.length > 3 ? [`${plural(named.length, 'user')}; the top three account for ${wholeShare(named.slice(0, 3).reduce((t, [, c]) => t + c.total, 0))}% of reports.`]
      : named.length ? [`${plural(named.length, 'user')}.`] : []),
    ...(i.failed.length ? [`${plural(i.failed.length, 'project')} did not answer and ${i.failed.length === 1 ? 'is' : 'are'} not counted: ${i.failed.map((f) => f.project).slice(0, 5).join(', ')}.`] : []),
  ];

  const topProjects = topN(byProject.map(([k, c]) => [k, c.total] as [string, number]), 10);
  const topUsers = topN(named.map(([k, c]) => [k, c.total] as [string, number]), 10);
  const failedOrError = (c: StatusCounts) => c.failed + c.error;
  const other = (c: StatusCounts) => c.incomplete + c.skipped;
  const statusParts = [
    { label: 'Passed', value: all.passed, tone: 'pass' as const }, { label: 'Healed', value: all.healed, tone: 'pass' as const },
    { label: 'Failed', value: all.failed, tone: 'fail' as const }, { label: 'Error', value: all.error, tone: 'fail' as const },
    { label: 'Incomplete', value: all.incomplete, tone: 'skip' as const }, { label: 'Skipped', value: all.skipped, tone: 'skip' as const },
  ].filter((x) => x.value > 0);
  const empty = i.projects.length - byProject.length - i.failed.length;
  const lowest = byProject.filter(([, c]) => c.passed + c.healed + c.failed + c.error >= 100).map(([k, c]) => [k, passRate(c)] as [string, number | null])
    .filter((x): x is [string, number] => x[1] != null).sort((a, b) => a[1] - b[1])[0];

  const overview: Section[] = [
    { title: 'At a Glance', blocks: [{ type: 'kpis', items: [
      { value: n(all.total), label: 'Test reports, all dates' },
      { value: pct1(rate), label: 'Pass rate', accent: 'teal' },
      ...(one ? [] : [{ value: `${n(byProject.length)} of ${n(i.projects.length)}`, label: 'Projects with reports' }]),
      { value: n(named.length), label: 'Users', accent: 'teal' },
      { value: n(failedOrError(all)), label: 'Failed or error', accent: 'fail' }] }] },
    ...(statusParts.length ? [{ title: 'Reports by Status', blocks: [{ type: 'share' as const, parts: statusParts }],
      whatItMeans: rate == null ? 'No report has reached a verdict.' :
        `${pct1(rate)} of the reports that reached a verdict passed (${n(all.passed + all.healed)} of ${n(all.passed + all.healed + all.failed + all.error)}). ` +
        `${n(other(all))} never reached one (incomplete or skipped) and are not part of the pass rate.` }] : []),
    ...(one ? [] : [{ title: 'Reports by Project', blocks: [{ type: 'bar' as const, orientation: 'horizontal' as const, showShare: true, shareTotal: all.total,
      categories: topProjects.cats, series: [{ name: 'Reports', values: topProjects.vals }],
      ...(topProjects.other ? { otherLabel: `All other projects: ${share(topProjects.other)}%`, otherNote: `${byProject.length - 10} more projects` } : {}) }],
      whatItMeans: !byProject.length ? 'No project holds a test report.' :
        `${byProject[0][0]} holds ${share(byProject[0][1].total)}% of all reports` +
        (byProject.length > 3 ? `; the top three projects together hold ${wholeShare(byProject.slice(0, 3).reduce((t, [, c]) => t + c.total, 0))}%.` : '.') +
        (empty > 0 ? ` ${plural(empty, 'project')} ${empty === 1 ? 'has' : 'have'} no report at all.` : '') +
        (lowest ? ` Among projects with at least 100 verdicts, ${lowest[0]} has the lowest pass rate (${pct1(lowest[1])}).` : '') }]),
  ];
  // Reporter storage per project (reports with their attachments), against the project's quota.
  const stored = (i.storage ?? []).filter((x) => x.mb > 0).sort((a, b) => b.mb - a.mb);
  const gb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb).toLocaleString('en-US')} MB`);
  const overQuota = stored.filter((x) => x.quotaMb > 0 && x.mb > x.quotaMb);
  const storedTotal = stored.reduce((t, x) => t + x.mb, 0);
  if (overQuota.length) highlights.push(`${plural(overQuota.length, 'project')} ${overQuota.length === 1 ? 'is' : 'are'} over the storage quota; ${overQuota[0].project} holds ${gb(overQuota[0].mb)} against ${gb(overQuota[0].quotaMb)}.`);
  const storageTab: Section[] = !stored.length ? [] : [
    { title: 'Storage by Project', blocks: [{ type: 'bar', orientation: 'horizontal', unit: 'MB', showShare: true, shareTotal: storedTotal, categories: stored.slice(0, 10).map((x) => x.project),
      series: [{ name: 'Storage', values: stored.slice(0, 10).map((x) => Math.round(x.mb)) }],
      ...(stored.length > 10 ? { otherLabel: `${stored.length - 10} more projects in the table below` } : {}) }],
      whatItMeans: `Test reports and their attachments take ${gb(storedTotal)} in ${plural(stored.length, 'project')}; ${stored[0].project} holds ${Math.round((stored[0].mb / Math.max(storedTotal, 1)) * 100)}% of it.` +
        (overQuota.length ? ` ${plural(overQuota.length, 'project')} ${overQuota.length === 1 ? 'is' : 'are'} over quota (${overQuota.slice(0, 3).map((x) => `${x.project} at ${Math.round((x.mb / x.quotaMb) * 100)}%`).join(', ')}): the platform purges old reports there, or the quota needs raising.` : ' No project is over its quota.') },
    { title: 'Storage and Quota', blocks: [{ type: 'table', maxRows: 200, columns: [
      { key: 'project', label: 'Project' }, { key: 'mb', label: 'Storage (MB)', format: 'number' }, { key: 'quota', label: 'Quota (MB)', format: 'number' },
      { key: 'pct', label: 'Of quota', format: 'percent', decimals: 0 }, { key: 'reports', label: 'Reports', format: 'number' }, { key: 'per', label: 'MB per 1,000 reports', format: 'number', decimals: 1 }],
    rows: stored.slice(0, 200).map((x) => {
      const reports = byProject.find(([p]) => p === x.project)?.[1].total ?? 0;
      return { project: x.project, mb: Math.round(x.mb), quota: x.quotaMb, pct: x.quotaMb > 0 ? Math.round((x.mb / x.quotaMb) * 100) : null, reports, per: reports ? Math.round((x.mb / reports) * 10000) / 10 : null };
    }) }],
      whatItMeans: 'A project with much storage per report keeps large attachments (video, logs); one with storage and no reports left holds data whose reports were deleted or purged.' },
  ];

  const projectsTab: Section = { title: 'Every Project with Reports', blocks: [{ type: 'table', maxRows: 500, columns: [
    { key: 'project', label: 'Project' }, { key: 'reports', label: 'Reports', format: 'number' }, { key: 'share', label: 'Share', format: 'percent', decimals: 1 },
    { key: 'passed', label: 'Passed', format: 'number' }, { key: 'failed', label: 'Failed or error', format: 'number' }, { key: 'other', label: 'Incomplete or skipped', format: 'number' },
    { key: 'rate', label: 'Pass rate' }, { key: 'users', label: 'Users', format: 'number' },
    ...(reporterOnly.size ? [{ key: 'note', label: 'Note' }] : [])],
  rows: byProject.map(([p, c]) => ({ project: p, reports: c.total, share: share(c.total), passed: c.passed + c.healed, failed: failedOrError(c), other: other(c),
    rate: pct1(passRate(c)), users: usersOf(p), note: reporterOnly.has(p) ? 'no cloud project' : '' })) }],
  whatItMeans: `${plural(byProject.length, 'project')} hold reports.` +
    (orphans ? ` ${n(orphans)} of them no longer ${orphans === 1 ? 'has' : 'have'} a cloud project of the same name (marked "no cloud project"): their reports are still stored and still count toward storage.` : '') +
    (i.failed.length ? ` ${plural(i.failed.length, 'project')} did not answer and ${i.failed.length === 1 ? 'is' : 'are'} missing here.` : '') };
  const usersTab: Section[] = !named.length ? [] : [
    { title: 'Top Users', blocks: [{ type: 'bar', orientation: 'horizontal', showShare: true, shareTotal: all.total, categories: topUsers.cats, series: [{ name: 'Reports', values: topUsers.vals }],
      ...(topUsers.other ? { otherLabel: `All other users: ${share(topUsers.other)}%`, otherNote: `${named.length - 10} more users` } : {}) }],
      whatItMeans: `${named[0][0]} created ${share(named[0][1].total)}% of all reports. A user with a share like this is usually an automation or monitoring account, not a person.` +
        ' The same person can appear under more than one ID (a short name and an email, for example): IDs are counted as the platform recorded them.' },
    { title: 'Users', blocks: [{ type: 'table', maxRows: 100, columns: [
      { key: 'user', label: 'User' }, { key: 'reports', label: 'Reports', format: 'number' }, { key: 'share', label: 'Share', format: 'percent', decimals: 1 },
      { key: 'rate', label: 'Pass rate' }, { key: 'failed', label: 'Failed or error', format: 'number' }, { key: 'projects', label: 'Projects', format: 'number' }],
    rows: byUser.slice(0, 100).map(([u, c]) => ({ user: u, reports: c.total, share: share(c.total), rate: pct1(passRate(c)), failed: failedOrError(c), projects: projectsOf(u) })) }],
      whatItMeans: `${plural(named.length, 'user ID')} created reports${byUser.length > 100 ? '; the 100 with the most reports are listed' : ''}.` +
        (byUser.some(([u]) => u === NO_USER) ? ` ${n(byUser.find(([u]) => u === NO_USER)![1].total)} reports carry no user.` : '') },
  ];
  return {
    highlights,
    spec: {
      title: 'Test Report Inventory',
      subtitle: one ? `Every test report of project ${i.projects[0]}, all dates` : 'Every test report by project, user and status, all dates',
      meta: [{ label: 'Scope', value: one ? `Project ${i.projects[0]}` : `All projects (${n(i.projects.length)})` }, { label: 'As of', value: longDate(i.now) }],
      headline: { value: n(all.total), label: 'Test reports' },
      tabs: [
        { label: 'Overview', sections: overview },
        ...(one ? [] : [{ label: 'Projects', sections: [projectsTab] }]),
        ...(usersTab.length ? [{ label: 'Users', sections: usersTab }] : []),
        ...(storageTab.length ? [{ label: 'Storage', sections: storageTab }] : []),
      ],
      source: `Source: Digital.ai Testing reporter, the platform's own counts by project, user and status for ${one ? where : 'every project this access key can see'}, all dates (nothing is sampled or cut off). ` +
        'Pass rate = (Passed + Healed) / (Passed + Healed + Failed + Error). Web (Selenium) reports are counted under the user recorded in their own key.' +
        (i.scope === 'own' ? ' This access key can see its own project only.' : ''),
    },
  };
}

// ── Breakdown and trend: the platform's own counts, never cut short ───────────────────────────────────────────────

export interface BreakdownRow { values: Array<string | null>; counts: StatusCounts }

/**
 * Rows whose values differ only in letter case are one row ("Chrome" and "chrome", "ANDROID" and "Android"), shown in
 * the spelling most runs have. The platform stores what each client sent, so one browser arrives in two spellings.
 */
export function foldBreakdownRows(rows: BreakdownRow[]): BreakdownRow[] {
  // Per column: the runs behind each stored spelling, so a value is shown the same way in every row.
  const seen: Array<Map<string, Map<string, number>>> = [];
  for (const r of rows) r.values.forEach((v, n) => {
    if (v == null) return;
    const col = (seen[n] ??= new Map());
    const spellings = col.get(v.toLowerCase()) ?? new Map<string, number>();
    col.set(v.toLowerCase(), spellings);
    spellings.set(v, (spellings.get(v) ?? 0) + r.counts.total);
  });
  const shown = (v: string | null, n: number) => {
    if (v == null) return null;
    const spellings = seen[n]?.get(v.toLowerCase());
    return spellings ? [...spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0] : v;
  };
  const out = new Map<string, BreakdownRow>();
  for (const r of rows) {
    const values = r.values.map(shown);
    const id = JSON.stringify(values);
    const hit = out.get(id);
    if (hit) hit.counts = addCounts(hit.counts, r.counts); else out.set(id, { values, counts: r.counts });
  }
  return [...out.values()];
}

/** Words a person uses for a report key → the key; anything else is passed to the platform as written. */
const KEY_ALIASES: Record<string, string> = {
  platform: 'device.os', os: 'device.os', device: 'device.name', model: 'device.model', 'os version': 'device.version', osversion: 'device.version',
  manufacturer: 'device.manufacture', framework: 'test.framework', browser: 'browserName', 'browser version': 'browserVersion', browserversion: 'browserVersion',
  pool: 'device.pool.actual', classification: 'errorCategory', category: 'errorCategory', test: 'name', 'test name': 'name', day: 'date',
};
const KEY_LABELS: Record<string, string> = {
  'device.os': 'Platform', 'device.name': 'Device', 'device.model': 'Device Model', 'device.version': 'OS Version', 'device.manufacture': 'Manufacturer',
  'device.serialNumber': 'Device Serial', 'test.framework': 'Framework', browserName: 'Browser', browserVersion: 'Browser Version', 'device.pool.actual': 'Device Pool',
  errorCategory: 'Failure Classification', user: 'User', name: 'Test', date: 'Day', status: 'Status',
};
export const reportKey = (asked: string): string => KEY_ALIASES[asked.trim().toLowerCase()] ?? asked.trim();
/** The report columns the platform groups and filters by (verified as group keys live, 2026-11-24). */
export const KNOWN_REPORT_KEYS = ['device.os', 'test.framework', 'device.name', 'device.model', 'device.version', 'device.manufacture', 'browserName', 'browserVersion',
  'user', 'name', 'errorCategory', 'device.pool.actual', 'date', 'status'];
/**
 * The same list for tool texts, with the plain word each key also answers to. Without it an agent has no way to know the
 * names: asked for "Appium Server tests only" it tried framework, testFramework and automation_type, then reported that
 * "no field labels the test framework" (Claude Desktop, 2026-11-25).
 */
export const REPORT_KEYS_HELP = 'device.os ("platform"), test.framework ("framework": Appium Server, Selenium, Playwright …), device.name ("device"), ' +
  'device.model ("model"), device.version ("os version"), device.manufacture ("manufacturer"), browserName ("browser"), browserVersion, user, name ("test"), ' +
  'errorCategory ("classification"), device.pool.actual ("pool"), date (a UTC day), status, and any custom column your tests add, such as digitalai:build';
export const reportKeyLabel = (key: string): string => KEY_LABELS[key] ?? key.replace(/^digitalai:/, '');
/** Labels that differ only in letter case become the first spelling seen ("Login" and "login" are one test). */
const sameSpelling = () => {
  const first = new Map<string, string>();
  return (label: string) => { const hit = first.get(label.toLowerCase()); if (hit != null) return hit; first.set(label.toLowerCase(), label); return label; };
};
const groupValue = (key: string, v: string | null): string => {
  if (key === 'device.os') return v == null ? 'Web or no device' : /^ios$/i.test(v) ? 'iOS' : /^android$/i.test(v) ? 'Android' : v;
  if (key === 'errorCategory') return v == null ? 'Not classified' : catLabel(v);
  if (key === 'name') return v == null ? '(no name)' : testFamily(v);
  return v ?? '(not recorded)';
};
/** A label inside a sentence: lower case, except "OS". */
const lower = (label: string) => label.toLowerCase().replace(/\bos\b/g, 'OS');
/** Fewer verdicts than this and a group's pass rate is shown but never ranked or called lowest. */
const MIN_VERDICTS_TO_RANK = 20;
const verdicts = (c: StatusCounts) => c.passed + c.healed + c.failed + c.error;

/**
 * Results by one or two report keys. `rows` are the platform's counts for the window (or all dates when `from` is null),
 * so the totals are exact whatever the size. Values that differ only in case (ANDROID / Android) or only in run ids
 * (test names) are merged here.
 */
export function buildTestBreakdown(i: { rows: BreakdownRow[]; keys: string[]; from: number | null; to: number; days: number | null; projectName?: string; passRateGoal?: number }): RecipeResult {
  const n = (x: number) => x.toLocaleString('en-US');
  const [k1, k2] = i.keys;
  const label1 = reportKeyLabel(k1), label2 = k2 ? reportKeyLabel(k2) : null;
  const merged = new Map<string, { a: string; b: string | null; c: StatusCounts }>();
  // One memory per key: a model must not take the spelling of a device name that happens to read the same.
  const one = sameSpelling(), two = sameSpelling();
  for (const r of i.rows) {
    const a = one(groupValue(k1, r.values[0])), b = k2 ? two(groupValue(k2, r.values[1] ?? null)) : null;
    const id = JSON.stringify([a, b]);
    const hit = merged.get(id);
    if (hit) hit.c = addCounts(hit.c, r.counts); else merged.set(id, { a, b, c: r.counts });
  }
  const cells = [...merged.values()].filter((x) => x.c.total > 0);
  const total = (list: Array<{ c: StatusCounts }>) => list.reduce((c, x) => addCounts(c, x.c), emptyCounts());
  const groupBy = (pick: (x: { a: string; b: string | null }) => string) => {
    const m = new Map<string, StatusCounts>();
    for (const x of cells) m.set(pick(x), addCounts(m.get(pick(x)) ?? emptyCounts(), x.c));
    return [...m].sort((p, q) => q[1].total - p[1].total);
  };
  const all = total(cells);
  const rate = passRate(all);
  const g1 = groupBy((x) => x.a);
  const share = (v: number) => Math.round((v / Math.max(all.total, 1)) * 1000) / 10;
  const ranked = g1.filter(([, c]) => verdicts(c) >= MIN_VERDICTS_TO_RANK).map(([k, c]) => [k, passRate(c) as number, c] as const).sort((p, q) => p[1] - q[1]);
  const lowest = ranked.length > 1 ? ranked[0] : null, highest = ranked.length > 1 ? ranked[ranked.length - 1] : null;
  const window = i.from == null ? 'all dates' : `last ${plural(i.days ?? 0, 'day')}`;
  const top1 = g1.slice(0, 15);
  const failedOrError = (c: StatusCounts) => c.failed + c.error;
  const other = (c: StatusCounts) => c.incomplete + c.skipped;

  const highlights = [
    `${n(all.total)} runs in ${plural(g1.length, `${lower(label1)} group`)}, ${window}; pass rate ${pct1(rate)}.`,
    ...(g1[0] ? [`${g1[0][0]} has the most runs (${n(g1[0][1].total)}, ${share(g1[0][1].total)}%).`] : []),
    ...(lowest && highest ? [`Lowest pass rate: ${lowest[0]} at ${pct1(lowest[1])} over ${n(verdicts(lowest[2]))} verdicts; highest: ${highest[0]} at ${pct1(highest[1])}.`] : []),
  ];
  const means1 = !g1.length ? `No run in this range.` :
    `${g1[0][0]} has ${share(g1[0][1].total)}% of the runs.` +
    (lowest && highest ? ` Pass rate runs from ${pct1(lowest[1])} (${lowest[0]}, ${n(verdicts(lowest[2]))} verdicts) to ${pct1(highest[1])} (${highest[0]}).` : '') +
    (g1.length > ranked.length ? ` ${plural(g1.length - ranked.length, 'group')} with fewer than ${MIN_VERDICTS_TO_RANK} verdicts ${g1.length - ranked.length === 1 ? 'is' : 'are'} listed but not ranked: a rate over a handful of runs says little.` : '') +
    (i.passRateGoal != null && ranked.length ? ` ${ranked.filter(([, r]) => r >= i.passRateGoal!).length} of ${ranked.length} ranked groups meet the ${i.passRateGoal}% goal.` : '');

  const sections: Section[] = [
    { title: 'At a Glance', blocks: [{ type: 'kpis', items: [
      { value: n(all.total), label: `Runs, ${window}` }, { value: pct1(rate), label: 'Pass rate', accent: 'teal' },
      { value: n(g1.length), label: `${label1} groups` }, { value: n(failedOrError(all)), label: 'Failed or error', accent: 'fail' }] }] },
    { title: `Results by ${label1}`, blocks: [{ type: 'bar', stacked: true, orientation: 'horizontal', categories: top1.map(([k]) => k), series: [
      { name: 'Passed', values: top1.map(([, c]) => c.passed + c.healed), tone: 'pass' }, { name: 'Failed or error', values: top1.map(([, c]) => failedOrError(c)), tone: 'fail' },
      { name: 'Incomplete or skipped', values: top1.map(([, c]) => other(c)), tone: 'skip' }],
      ...(g1.length > 15 ? { otherLabel: `${g1.length - 15} more groups in the table below` } : {}) }], whatItMeans: means1 },
    { title: `Every ${label1} Group`, blocks: [{ type: 'table', maxRows: 300, columns: [
      { key: 'group', label: label1 }, { key: 'runs', label: 'Runs', format: 'number' }, { key: 'share', label: 'Share', format: 'percent', decimals: 1 },
      { key: 'passed', label: 'Passed', format: 'number' }, { key: 'failed', label: 'Failed or error', format: 'number' }, { key: 'other', label: 'Incomplete or skipped', format: 'number' },
      { key: 'rate', label: 'Pass rate' }],
    rows: g1.slice(0, 300).map(([k, c]) => ({ group: k, runs: c.total, share: share(c.total), passed: c.passed + c.healed, failed: failedOrError(c), other: other(c), rate: pct1(passRate(c)) })) }],
      whatItMeans: `Every row is a count from the platform for the whole range, with its run count beside its rate.${g1.length > 300 ? ` The 300 largest of ${n(g1.length)} groups are listed.` : ''}` +
        (k1 === 'name' ? ' Test names that differ only in ids, dates or run numbers are counted as one test.' : '') },
  ];
  if (k2 && label2) {
    const g2 = groupBy((x) => x.b ?? '(not recorded)').slice(0, 8).map(([k]) => k);
    const rowsA = g1.slice(0, 12).map(([k]) => k);
    const cell = (a: string, b: string) => cells.find((x) => x.a === a && (x.b ?? '(not recorded)') === b)?.c;
    const failRate = (c: StatusCounts | undefined) => (c && verdicts(c) >= MIN_VERDICTS_TO_RANK ? Math.round((failedOrError(c) / verdicts(c)) * 1000) / 10 : null);
    const values = rowsA.map((a) => g2.map((b) => failRate(cell(a, b))));
    let worst: { v: number; a: string; b: string } | null = null;
    values.forEach((row, ri) => row.forEach((v, ci) => { if (v != null && (!worst || v > worst.v)) worst = { v, a: rowsA[ri], b: g2[ci] }; }));
    const w = worst as { v: number; a: string; b: string } | null;
    sections.push({ title: `Failure Rate by ${label1} and ${label2}`, blocks: [{ type: 'heatmap', rows: rowsA, columns: g2, values, unit: '%', decimals: 1, highBad: true }],
      whatItMeans: (w ? `The highest failure rate is ${w.a} with ${w.b}: ${w.v.toFixed(1)}% of ${n(verdicts(cell(w.a, w.b)!))} verdicts failed.` : 'No combination has enough verdicts to rank.') +
        ` Cells with fewer than ${MIN_VERDICTS_TO_RANK} verdicts are left empty.` });
    const combos = [...cells].sort((p, q) => q.c.total - p.c.total).slice(0, 200);
    sections.push({ title: `${label1} and ${label2} Combinations`, blocks: [{ type: 'table', maxRows: 200, columns: [
      { key: 'a', label: label1 }, { key: 'b', label: label2 }, { key: 'runs', label: 'Runs', format: 'number' }, { key: 'failed', label: 'Failed or error', format: 'number' }, { key: 'rate', label: 'Pass rate' }],
    rows: combos.map((x) => ({ a: x.a, b: x.b ?? '(not recorded)', runs: x.c.total, failed: failedOrError(x.c), rate: pct1(passRate(x.c)) })) }],
      whatItMeans: `${plural(cells.length, 'combination')} had runs${cells.length > 200 ? '; the 200 largest are listed' : ''}.` });
  }
  return {
    highlights,
    spec: {
      title: `Test Results by ${label1}${label2 ? ` and ${label2}` : ''}`,
      subtitle: i.from == null ? 'All dates' : `Last ${plural(i.days ?? 0, 'day')}`,
      meta: [...(i.projectName ? [{ label: 'Project', value: i.projectName }] : []),
        { label: 'Range', value: i.from == null ? `All dates, as of ${longDate(i.to)}` : `${longDate(i.from)} to ${longDate(i.to)}` }],
      headline: rate != null ? { value: pct1(rate), label: 'Pass rate' } : undefined,
      sections,
      source: `Source: Digital.ai Testing reporter, the platform's own counts by ${i.keys.map((k) => lower(reportKeyLabel(k))).join(' and ')} and status for ${i.projectName ? `project ${i.projectName}` : 'the access key\'s own project'}, ` +
        `${i.from == null ? 'all dates' : `${longDate(i.from)} to ${longDate(i.to)}`} (nothing is sampled or cut off). ` +
        'Pass rate = (Passed + Healed) / (Passed + Healed + Failed + Error); incomplete and skipped runs are shown and left out of the rate.',
    },
  };
}

/**
 * Runs and pass rate over time from the platform's counts per day: exact for any range, where reading the runs stops at
 * 25,000 (a "last 90 days" summary of a busy project held nine days). `daysRows` are counts by the reporter's own date
 * key; `platforms` and `classes` are counts for the whole range.
 */
export type TrendBy = 'day' | 'week' | 'month';
export const trendBy = (days: number): TrendBy => (days <= 31 ? 'day' : days <= 182 ? 'week' : 'month');

/**
 * Starts of the trend's periods in LOCAL time, oldest first: the day, week (Monday) or month that holds `from`, then each
 * following one up to `to`. At most about 32 (31 days, 26 weeks, 13 months), which bounds the id lookups behind them.
 */
export function trendPeriods(from: number, to: number, days: number): number[] {
  const by = trendBy(days);
  const startOf = (t: number) => { if (by !== 'month') return bucketStart(t, by); const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
  const next = (t: number) => { if (by !== 'month') return addDays(t, by === 'day' ? 1 : 7); const d = new Date(t); return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(); };
  const out: number[] = [];
  for (let t = startOf(from); t <= to; t = next(t)) out.push(t);
  return out;
}

/**
 * Runs and pass rate per local day, week or month. `periods` are the starts from trendPeriods with the platform's own
 * counts for each (the runs between the first run of the period and the first run of the next, found by run id); the
 * first period is counted from `from` only. Local days: the reporter's own `date` key is a UTC day, which put a run at
 * 20:05 in New York on the next day (the user chose local days, 2026-11-26).
 */
export function buildTestTrend(i: { periods: Array<{ start: number; counts: StatusCounts }>; platforms: BreakdownRow[] | null; classes: BreakdownRow[] | null; from: number; to: number; days: number;
  projectName?: string; passRateGoal?: number; timeZone?: string }): RecipeResult {
  const n = (x: number) => x.toLocaleString('en-US');
  const by = trendBy(i.days);
  const fromDay = dayStart(i.from);
  const keys = i.periods.map((p) => p.start);
  const counts = i.periods.map((p) => p.counts);
  const zone = i.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const all = counts.reduce((c, x) => addCounts(c, x), emptyCounts());
  const rate = passRate(all);
  const label = (k: number) => (by === 'month' ? `${MONTH[new Date(k).getMonth()]} ${new Date(k).getFullYear()}` : shortDay(k));
  const cats = keys.map(label);
  const rates = counts.map((c) => (verdicts(c) > 0 ? passRate(c) : null));
  const totals = counts.map((c) => c.total);
  const busiest = totals.reduce((b, v, k) => (v > totals[b] ? k : b), 0);
  const ranked = rates.map((v, k) => [v, k] as const).filter((x): x is readonly [number, number] => x[0] != null && verdicts(counts[x[1]]) >= MIN_VERDICTS_TO_RANK);
  const worst = ranked.reduce<readonly [number, number] | null>((w, x) => (w == null || x[0] < w[0] ? x : w), null);
  const half = Math.floor(keys.length / 2);
  const sumRate = (list: StatusCounts[]) => passRate(list.reduce((c, x) => addCounts(c, x), emptyCounts()));
  const firstHalf = half ? sumRate(counts.slice(0, half)) : null, secondHalf = half ? sumRate(counts.slice(keys.length - half)) : null;
  const drift = firstHalf != null && secondHalf != null ? secondHalf - firstHalf : null;
  const idle = totals.filter((v) => v === 0).length;
  const partial = cats.length ? [...(keys[0] < fromDay ? [cats[0]] : []), cats[cats.length - 1]] : [];
  const failedOrError = (c: StatusCounts) => c.failed + c.error;

  const highlights = [
    `${n(all.total)} runs over ${plural(i.days, 'day')}; pass rate ${pct1(rate)}.`,
    ...(drift != null && Math.abs(drift) >= 1 ? [`Pass rate is ${Math.abs(drift).toFixed(1)} points ${drift > 0 ? 'higher' : 'lower'} in the second half of the range (${pct1(secondHalf)}) than in the first (${pct1(firstHalf)}).`] : []),
    ...(worst ? [`Lowest ${by}: ${cats[worst[1]]} at ${worst[0].toFixed(1)}% over ${n(verdicts(counts[worst[1]]))} verdicts.`] : []),
  ];
  const plat = (i.platforms ?? []).map((r) => ({ label: groupValue('device.os', r.values[0]), c: r.counts }));
  const platMerged = [...plat.reduce((mm, x) => mm.set(x.label, addCounts(mm.get(x.label) ?? emptyCounts(), x.c)), new Map<string, StatusCounts>())].sort((p, q) => q[1].total - p[1].total);
  const cls = (i.classes ?? []).map((r) => ({ label: groupValue('errorCategory', r.values[0]), n: failedOrError(r.counts) })).filter((x) => x.n > 0);
  const clsMerged = [...cls.reduce((mm, x) => mm.set(x.label, (mm.get(x.label) ?? 0) + x.n), new Map<string, number>())].sort((p, q) => q[1] - p[1]);
  const clsTotal = clsMerged.reduce((t, [, v]) => t + v, 0);
  const unclassified = clsMerged.filter(([k]) => /unclassified|not classified/i.test(k)).reduce((t, [, v]) => t + v, 0);

  const sections: Section[] = [
    { title: 'At a Glance', blocks: [{ type: 'kpis', items: [
      { value: n(all.total), label: `Runs, last ${i.days} days` }, { value: pct1(rate), label: 'Pass rate', accent: 'teal' },
      { value: n(failedOrError(all)), label: 'Failed or error', accent: 'fail' },
      { value: n(Math.round(all.total / Math.max(1, i.days))), label: 'Runs per day' }] }] },
    { title: `Runs per ${by[0].toUpperCase()}${by.slice(1)}`, blocks: [{ type: 'bar', stacked: true, orientation: 'vertical', categories: cats, partial, partialNote: `Lighter bars are partial ${by}s`, series: [
      { name: 'Passed', values: counts.map((c) => c.passed + c.healed), tone: 'pass' }, { name: 'Failed or error', values: counts.map(failedOrError), tone: 'fail' },
      { name: 'Incomplete or skipped', values: counts.map((c) => c.incomplete + c.skipped), tone: 'skip' }] }],
      whatItMeans: `The busiest ${by} was ${cats[busiest]} with ${n(totals[busiest])} runs.` + (idle ? ` ${plural(idle, by)} had no runs.` : '') +
        ' Every bar is the platform\'s own count, so the whole range is covered however many runs it holds.' },
    { title: 'Pass Rate Over Time', blocks: [{ type: 'line', categories: cats, unit: '%', series: [{ name: 'Pass rate', values: rates }],
      ...(i.passRateGoal != null ? { target: { value: i.passRateGoal, label: `Goal ${i.passRateGoal}%` } } : {}) }],
      whatItMeans: rate == null ? 'No run in this range reached a verdict.' :
        `Pass rate over the whole range was ${pct1(rate)}.` + (worst ? ` The lowest ${by} was ${cats[worst[1]]} at ${worst[0].toFixed(1)}% (${n(verdicts(counts[worst[1]]))} verdicts).` : '') +
        (drift != null ? ` The second half of the range is ${Math.abs(drift).toFixed(1)} points ${drift >= 0 ? 'above' : 'below'} the first.` : '') +
        (i.passRateGoal != null ? ` ${ranked.filter(([v]) => v >= i.passRateGoal!).length} of ${ranked.length} ${by}s met the ${i.passRateGoal}% goal.` : '') +
        ' A sharp dip is worth checking against the lab on those days before the tests are blamed.' },
    ...(platMerged.length ? [{ title: 'Results by Platform', blocks: [{ type: 'bar' as const, stacked: true, orientation: 'horizontal' as const, categories: platMerged.map(([k]) => k), series: [
      { name: 'Passed', values: platMerged.map(([, c]) => c.passed + c.healed), tone: 'pass' as const }, { name: 'Failed or error', values: platMerged.map(([, c]) => failedOrError(c)), tone: 'fail' as const }] }],
      whatItMeans: platMerged.map(([k, c]) => `${k}: ${pct1(passRate(c))} over ${n(verdicts(c))} verdicts`).join('; ') + '.' }] : []),
    ...(clsMerged.length ? [{ title: 'Failures by Classification', blocks: [{ type: 'bar' as const, orientation: 'horizontal' as const, showShare: true, categories: clsMerged.map(([k]) => k), series: [{ name: 'Failures', values: clsMerged.map(([, v]) => v), tone: 'fail' as const }] }],
      whatItMeans: `${n(clsTotal)} failed or error runs in the range.` + (clsTotal && unclassified / clsTotal >= 0.5
        ? ` The platform left ${Math.round((unclassified / clsTotal) * 100)}% of them unclassified, so this chart cannot say where the problem is; a failure analysis report reads the causes.`
        : clsMerged[0] ? ` ${clsMerged[0][0]} is the largest group (${Math.round((clsMerged[0][1] / clsTotal) * 100)}%).` : '') }] : []),
  ];
  return {
    highlights,
    spec: {
      title: 'Test Execution Trend',
      subtitle: `Runs and pass rate per ${by}, last ${plural(i.days, 'day')}`,
      meta: rangeMeta(i.from, i.to, i.projectName),
      headline: rate != null ? { value: pct1(rate), label: `Pass rate, ${i.days} days` } : undefined,
      sections,
      source: `Source: Digital.ai Testing reporter, the platform's own counts per ${by} and status, ${longDate(i.from)} to ${longDate(i.to)}, in local time (${zone}); nothing is sampled or cut off. ` +
        'Pass rate = (Passed + Healed) / (Passed + Healed + Failed + Error); incomplete and skipped runs are shown and left out of the rate.',
    },
  };
}

// ── Failure analysis ────────────────────────────────────────────────────────────────────────────────────────────────

/** The bucket of failures with no device: web (browser) runs and runs that never got a device. */
const NO_DEVICE = 'No device (web or other)';

export function buildFailureAnalysis(i: { failures: TestRun[]; totalRuns: number | null; from: number; to: number; days: number; projectName?: string; capped?: boolean }): RecipeResult {
  const fails = i.failures;
  const highlights: string[] = [];
  const devName = (r: TestRun) => r.deviceName ? r.deviceName : r.serial ? r.serial : NO_DEVICE;
  const byDevice = countBy(fails, devName);
  const tests = new Set(fails.map((r) => r.name)).size;
  const infra = fails.filter((r) => INFRA_CATEGORIES.has((r.errorCategory ?? '').toLowerCase())).length;
  const cats = countBy(fails, (r) => catLabel(r.errorCategory));
  const kpis: Block = { type: 'kpis', items: [
    { value: fails.length.toLocaleString('en-US'), label: 'Failed or error runs', accent: 'fail' },
    { value: pct1(i.totalRuns ? (fails.length / i.totalRuns) * 100 : null), label: 'Of all runs' },
    { value: tests.toLocaleString('en-US'), label: 'Distinct failing tests', accent: 'teal' },
    { value: byDevice.length.toLocaleString('en-US'), label: 'Devices with failures', accent: 'teal' },
    { value: pct1(fails.length ? (infra / fails.length) * 100 : null), label: 'Infrastructure-classified' },
  ] };
  if (!fails.length) {
    return { highlights: ['No failures in this range.'], spec: { title: 'Failure Analysis', subtitle: `Last ${plural(i.days, 'day')}`, meta: rangeMeta(i.from, i.to, i.projectName),
      sections: [{ title: 'At a Glance', blocks: [kpis] }, { title: 'Failures', blocks: [{ type: 'callout', tone: 'note', title: 'No failures', text: `No run failed between ${longDate(i.from)} and ${longDate(i.to)}.` }] }] } };
  }
  const dev = topN(byDevice, 10);
  const devShare = byDevice[0][1] / fails.length;
  // The no-device bucket is web (browser) runs and runs that never got a device: not a device, so never "a device problem".
  const noDeviceTop = byDevice[0][0] === NO_DEVICE;
  const devMeans = noDeviceTop
    ? `Most failures (${plural(byDevice[0][1], 'failure')}, ${Math.round(devShare * 100)}%) were in runs without a device: web (browser) tests, or runs that ended before a device was assigned. Look at those tests and their causes, not at the devices.` +
      (byDevice.length > 1 ? ` Among the devices, ${byDevice[1][0]} has the most (${plural(byDevice[1][1], 'failure')}).` : '')
    : `${byDevice[0][0]} has the most failures (${plural(byDevice[0][1], 'failure')}, ${Math.round(devShare * 100)}% of all).` +
      (devShare > 0.3 && byDevice.length > 3 ? ' One device carrying this share usually means a device problem rather than a test problem; check it before re-running.' : '');
  highlights.push(noDeviceTop
    ? `${Math.round(devShare * 100)}% of failures were in runs without a device (web or other).`
    : `${byDevice[0][0]} carries ${Math.round(devShare * 100)}% of failures.`);

  // Device × day heatmap for the top devices.
  const by: 'day' | 'week' = i.days <= 21 ? 'day' : 'week';
  const keys = buckets(i.from, i.to, by);
  const topDevs = byDevice.slice(0, 8).map(([k]) => k);
  const values = topDevs.map((d) => keys.map((k) => fails.filter((r) => devName(r) === d && bucketStart(Date.parse(r.start_time), by) === k).length));
  let peak = { v: 0, d: '', k: 0 };
  values.forEach((row, ri) => row.forEach((v, ci) => { if (v > peak.v) peak = { v, d: topDevs[ri], k: keys[ci] }; }));
  const heatMeans = `The worst ${by} for a single device was ${shortDay(peak.k)} on ${peak.d} (${plural(peak.v, 'failure')}).` +
    ' A device whose cells stay dark across days is failing consistently; a single dark column across devices points at a change on that day.';

  const classifiedN = fails.filter((r) => r.errorCategory && r.errorCategory.toLowerCase() !== 'unclassified').length;

  // Causes table.
  // Grouped by the informative part of the cause with session ids, UUIDs and times taken out (failure-cause.ts).
  const causeKey = (r: TestRun) => causeGroupKey(r.cause);
  const byCause = countBy(fails, causeKey).slice(0, 12);
  const example = (cause: string) => fails.find((r) => causeKey(r) === cause);
  const noCause = byCause[0][0] === '(no cause recorded)';
  const topCat = (example(byCause[0][0])?.errorCategory ?? '').toLowerCase();
  const catMeans = classificationMeans(fails.length, classifiedN, infra, cats, noCause ? undefined : { n: byCause[0][1], classified: !!topCat && topCat !== 'unclassified' });
  const topCauseText = causeQuote(example(byCause[0][0])?.cause ?? byCause[0][0]);
  const topThreeShare = Math.round((byCause.slice(0, 3).reduce((s, [, v]) => s + v, 0) / fails.length) * 100);
  const causeMeans = noCause && byCause.length === 1 ? 'No failure cause was recorded for these runs.' :
    `The most common cause appears ${plural(byCause[0][1], 'time')}: "${topCauseText}". Fixing the top three causes would remove ${topThreeShare}% of failures.`;
  // The device with the most failures is rarely the story when one cause is most of them.
  if (!noCause) highlights.unshift(`Most common cause: "${topCauseText}" (${plural(byCause[0][1], 'failure')}, ${Math.round((byCause[0][1] / fails.length) * 100)}%); the top three causes cover ${topThreeShare}%.`);

  return {
    highlights,
    spec: {
      title: 'Failure Analysis',
      subtitle: `Failed and error runs, last ${plural(i.days, 'day')}`,
      meta: rangeMeta(i.from, i.to, i.projectName),
      headline: { value: fails.length.toLocaleString('en-US'), label: 'Failures' },
      tabs: [
        { label: 'Overview', sections: [
          { title: 'At a Glance', blocks: [kpis] },
          { title: 'Failures by Classification', blocks: [{ type: 'bar', orientation: 'horizontal', showShare: true, categories: cats.map(([k]) => k), series: [{ name: 'Failures', values: cats.map(([, v]) => v), tone: 'fail' }] }], whatItMeans: catMeans },
          { title: 'Failures by Device', blocks: [{ type: 'bar', orientation: 'horizontal', showShare: true, shareTotal: fails.length, categories: dev.cats, series: [{ name: 'Failures', values: dev.vals, tone: 'fail' }],
            ...(dev.other ? { otherLabel: `All other devices: ${plural(dev.other, 'failure')}` } : {}) }], whatItMeans: devMeans },
          { title: `Failures per Device and ${by === 'day' ? 'Day' : 'Week'}`, blocks: [{ type: 'heatmap', rows: topDevs, columns: keys.map((k) => shortDay(k)), values, highBad: true }], whatItMeans: heatMeans },
        ] },
        { label: 'Causes', sections: [
          { title: 'Most Common Causes', blocks: [{ type: 'table', columns: [
            { key: 'cause', label: 'Cause' }, { key: 'n', label: 'Failures', format: 'number' }, { key: 'cat', label: 'Classification' }, { key: 'test', label: 'Example test' }],
          rows: byCause.map(([cause, n]) => ({ cause: example(cause)?.cause ? causeQuote(example(cause)!.cause!, 200) : cause, n, cat: catLabel(example(cause)?.errorCategory ?? null), test: example(cause)?.name ?? '' })) }], whatItMeans: causeMeans },
        ] },
      ],
      source: `Source: Digital.ai Testing reporter, ${plural(fails.length, 'failed or error run')}${i.totalRuns != null ? ` of ${plural(i.totalRuns, 'run')}` : ''}, ${longDate(i.from)} to ${longDate(i.to)}. ` +
        'Classification is the platform\'s own (errorCategory).' + (i.capped ? ' **The scan hit its record limit, so the oldest part of the range is incomplete.**' : ''),
    },
  };
}

// ── Device health ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface DeviceRow { name: string; serial: string; os: string; model: string; status: string; statusAgeMin: number | null; region: string; agent: string }

export interface DeviceStat { serial: string; name: string; runs: number; failures: number; failRatio: number; infraShare: number; topCause: string }

/**
 * Devices whose failure ratio is far above the pool's: at least 5 runs and a ratio of 30% or twice the baseline,
 * whichever is higher. Counts come from the reporter's own grouping; causes from the failure scan.
 */
export function deviceStats(counts: GroupCounts, failures: TestRun[]): { stats: DeviceStat[]; baseline: number } {
  const total = counts.reduce((s, g) => s + g.counts.passed + g.counts.healed + g.counts.failed + g.counts.error, 0);
  const totalFail = counts.reduce((s, g) => s + g.counts.failed + g.counts.error, 0);
  const baseline = total ? totalFail / total : 0;
  const stats = counts.filter((g) => g.key).map((g) => {
    const runs = g.counts.passed + g.counts.healed + g.counts.failed + g.counts.error;
    const f = g.counts.failed + g.counts.error;
    // The counts arrive with serials that differ only in case already merged (groupedCounts), so the failures are matched the same way.
    const serial = g.key!.toLowerCase();
    const mine = failures.filter((r) => (r.serial ?? '').toLowerCase() === serial);
    const infra = mine.filter((r) => INFRA_CATEGORIES.has((r.errorCategory ?? '').toLowerCase())).length;
    const causes = countBy(mine, (r) => causeGroupKey(r.cause));
    const top = causes[0]?.[0];
    const topExample = top ? mine.find((r) => causeGroupKey(r.cause) === top)?.cause : undefined;
    return { serial: g.key!, name: mine.find((r) => r.deviceName)?.deviceName ?? g.key!, runs, failures: f, failRatio: runs ? f / runs : 0, infraShare: mine.length ? infra / mine.length : 0,
      topCause: topExample ? causeQuote(topExample, 160) : top ?? '' };
  });
  return { stats, baseline };
}
export const isFlagged = (d: DeviceStat, baseline: number) => d.runs >= 5 && d.failRatio >= Math.max(0.3, 2 * baseline);

export function buildDeviceHealth(i: { devices: DeviceRow[]; deviceCounts: GroupCounts | null; failures: TestRun[]; days: number; now: number; projectName?: string }): RecipeResult {
  const highlights: string[] = [];
  const statusCounts = countBy(i.devices, (d) => d.status || 'Unknown');
  const n = (re: RegExp) => i.devices.filter((d) => re.test(d.status)).length;
  const available = n(/^available$/i), inUse = n(/^(in use|reserved)$/i), offline = n(/^(offline|error|unauthorized|disconnected)$/i);
  const longOffline = i.devices.filter((d) => /^(offline|error|unauthorized|disconnected)$/i.test(d.status) && (d.statusAgeMin ?? 0) > 1440)
    .sort((a, b) => (b.statusAgeMin ?? 0) - (a.statusAgeMin ?? 0));
  const health = i.deviceCounts ? deviceStats(i.deviceCounts, i.failures) : null;
  const flagged = health ? health.stats.filter((d) => isFlagged(d, health.baseline)).sort((a, b) => b.failRatio - a.failRatio) : [];
  // The reporter keeps a serial in the spelling the client sent, the device list in its own: matched whatever the case,
  // as the failures are (deviceStats) and as the coverage report does.
  const sameSerial = (serial: string | null | undefined) => (serial ?? '').toLowerCase();
  const flaggedSerials = new Set(flagged.map((d) => sameSerial(d.serial)));
  const statBySerial = new Map((health?.stats ?? []).map((s) => [sameSerial(s.serial), s] as const));
  const kpis: Block = { type: 'kpis', items: [
    { value: i.devices.length.toLocaleString('en-US'), label: 'Devices' },
    { value: available.toLocaleString('en-US'), label: 'Available' },
    { value: inUse.toLocaleString('en-US'), label: 'In use or reserved', accent: 'teal' },
    { value: offline.toLocaleString('en-US'), label: 'Offline or error', accent: 'fail' },
    ...(health ? [{ value: flagged.length.toLocaleString('en-US'), label: `Devices failing far more often (last ${plural(i.days, 'day')})`, accent: 'fail' as const }] : []),
  ] };
  highlights.push(`${available} of ${i.devices.length} devices available, ${offline} offline or in error.`);
  if (longOffline.length) highlights.push(`${plural(longOffline.length, 'device')} offline or in error for more than a day.`);
  if (flagged.length) highlights.push(`${plural(flagged.length, 'device')} fail${flagged.length === 1 ? 's' : ''} far more often than the rest of the pool.`);

  const shareMeans = `${Math.round((available / Math.max(1, i.devices.length)) * 100)}% of the pool is free right now and ${Math.round((offline / Math.max(1, i.devices.length)) * 100)}% is offline or in error.` +
    (longOffline.length ? ` ${plural(longOffline.length, 'device')} ${longOffline.length === 1 ? 'has' : 'have'} been offline or in error for more than 24 hours and still count toward the pool; a device query can route tests to them.` : '');
  const ageText = (m: number | null) => m == null || m < 1 ? '' : m >= 1440 ? plural(Math.round(m / 1440), 'day') : m >= 60 ? `${Math.round(m / 60)} hours` : `${m} min`;
  const tileStatus = (d: DeviceRow) => flaggedSerials.has(sameSerial(d.serial)) && /^available$/i.test(d.status) ? 'Degraded' : d.status || 'Unknown';
  const attention = i.devices.filter((d) => !/^(available|in use|reserved)$/i.test(d.status) || flaggedSerials.has(sameSerial(d.serial)));
  const tileSet = i.devices.length <= 60 ? i.devices : attention.slice(0, 60);
  const tilesMeans = !attention.length ? 'Every device is available or in use, and none is failing tests that pass elsewhere.' :
    `${plural(attention.length, 'device')} need${attention.length === 1 ? 's' : ''} attention (shown first).` + (i.devices.length > 60 ? ` Only those are shown; the pool has ${i.devices.length} devices.` : '');

  const byOs = countBy(i.devices, (d) => d.os || 'Unknown');
  const osAvail = byOs.map(([os]) => i.devices.filter((d) => (d.os || 'Unknown') === os && /^available$/i.test(d.status)).length);
  const osOther = byOs.map(([os], k) => byOs[k][1] - osAvail[k] - i.devices.filter((d) => (d.os || 'Unknown') === os && /^(offline|error|unauthorized|disconnected)$/i.test(d.status)).length);
  const osOff = byOs.map(([os]) => i.devices.filter((d) => (d.os || 'Unknown') === os && /^(offline|error|unauthorized|disconnected)$/i.test(d.status)).length);

  // Where the lab is unhealthy: one region or one agent (host machine) holding most of the offline devices is a host or
  // network problem, not a device problem. Shown only when the inventory names more than one region or agent.
  const down = (d: DeviceRow) => /^(offline|error|unauthorized|disconnected)$/i.test(d.status);
  const place = (key: (d: DeviceRow) => string) => {
    const m = new Map<string, { all: number; avail: number; down: number }>();
    for (const d of i.devices) {
      const k = key(d) || '(not recorded)';
      const v = m.get(k) ?? { all: 0, avail: 0, down: 0 };
      v.all++; if (/^available$/i.test(d.status)) v.avail++; if (down(d)) v.down++;
      m.set(k, v);
    }
    return [...m].sort((a, b) => b[1].all - a[1].all);
  };
  const regions = place((d) => d.region), agents = place((d) => d.agent);
  const labSections: Section[] = [];
  if (regions.length > 1) {
    const worst = [...regions].filter(([, v]) => v.all >= 5).sort((a, b) => b[1].down / b[1].all - a[1].down / a[1].all)[0];
    labSections.push({ title: 'Lab Health by Region', blocks: [{ type: 'bar', orientation: 'horizontal', stacked: true, categories: regions.map(([k]) => k), series: [
      { name: 'Available', values: regions.map(([, v]) => v.avail), tone: 'pass' }, { name: 'In use or other', values: regions.map(([, v]) => v.all - v.avail - v.down), tone: 'info' },
      { name: 'Offline or error', values: regions.map(([, v]) => v.down), tone: 'fail' }] }],
      whatItMeans: worst && worst[1].down ? `${worst[0]} has the largest share of devices offline or in error: ${worst[1].down} of ${worst[1].all} (${Math.round((worst[1].down / worst[1].all) * 100)}%).` +
        (offline && worst[1].down / offline >= 0.5 ? ` That is ${Math.round((worst[1].down / offline) * 100)}% of all offline devices in one region, which points at the site or its network rather than at single devices.` : '')
        : 'No region with five or more devices has one offline or in error.' });
  }
  const badAgents = agents.filter(([, v]) => v.down > 0).sort((a, b) => b[1].down - a[1].down);
  if (agents.length > 1 && badAgents.length) {
    const allDown = badAgents.filter(([, v]) => v.down === v.all && v.all >= 2);
    labSections.push({ title: 'Agents with Offline Devices', blocks: [{ type: 'table', maxRows: 100, columns: [
      { key: 'agent', label: 'Agent' }, { key: 'region', label: 'Region' }, { key: 'devices', label: 'Devices', format: 'number' }, { key: 'down', label: 'Offline or error', format: 'number' },
      { key: 'share', label: 'Share down', format: 'percent', decimals: 0 }],
    rows: badAgents.slice(0, 100).map(([k, v]) => ({ agent: k, region: i.devices.find((d) => (d.agent || '(not recorded)') === k)?.region ?? '', devices: v.all, down: v.down, share: Math.round((v.down / v.all) * 100) })) }],
      whatItMeans: `${plural(badAgents.length, 'agent')} of ${agents.length} ${badAgents.length === 1 ? 'has' : 'have'} at least one device offline or in error.` +
        (allDown.length ? ` On ${plural(allDown.length, 'agent')} every device is down (${allDown.slice(0, 3).map(([k]) => k).join(', ')}${allDown.length > 3 ? ', …' : ''}): check the host machine before the devices.` : '') });
    if (allDown.length) highlights.push(`${plural(allDown.length, 'agent')} ${allDown.length === 1 ? 'has' : 'have'} every device offline: ${allDown.slice(0, 3).map(([k]) => k).join(', ')}.`);
  }

  const sections: Section[] = [
    { title: 'At a Glance', blocks: [kpis] },
    { title: 'Pool Status', columns: 2, blocks: [
      { type: 'share', label: 'Devices by status', parts: statusCounts.map(([label, value]) => ({ label, value, tone: /^available$/i.test(label) ? 'pass' as const : /^(in use|reserved)$/i.test(label) ? 'info' as const : /^(offline|error|unauthorized|disconnected)$/i.test(label) ? 'fail' as const : 'skip' as const })) },
      { type: 'bar', title: 'By Operating System', orientation: 'horizontal', stacked: true, categories: byOs.map(([k]) => k), series: [
        { name: 'Available', values: osAvail, tone: 'pass' }, { name: 'In use or other', values: osOther, tone: 'info' }, { name: 'Offline or error', values: osOff, tone: 'fail' }] },
    ], whatItMeans: shareMeans },
    ...labSections,
    { title: 'Devices', blocks: [{ type: 'tiles', items: tileSet.map((d) => ({
      name: d.name || d.serial, status: tileStatus(d),
      detail: [d.model, d.region, /^(offline|error|unauthorized|disconnected)$/i.test(d.status) && ageText(d.statusAgeMin) ? `for ${ageText(d.statusAgeMin)}` : ''].filter(Boolean).join(' · '),
      metric: (() => { const h = statBySerial.get(sameSerial(d.serial)); return h && h.runs ? `${Math.round((1 - h.failRatio) * 100)}% pass` : undefined; })(),
    })) }], whatItMeans: tilesMeans },
  ];
  if (longOffline.length) {
    sections.push({ title: 'Offline or in Error for More Than a Day', blocks: [{ type: 'table', columns: [
      { key: 'name', label: 'Device' }, { key: 'model', label: 'Model' }, { key: 'status', label: 'Status', format: 'status' }, { key: 'age', label: 'For' }, { key: 'agent', label: 'Agent' }, { key: 'region', label: 'Region' }],
    // Every one of them: the text and the tiles say how many, and a table that stopped at 25 of 27 contradicted both.
    maxRows: 500, rows: longOffline.map((d) => ({ name: d.name || d.serial, model: d.model, status: d.status, age: ageText(d.statusAgeMin), agent: d.agent, region: d.region })) }],
    whatItMeans: 'These devices have not come back by themselves. Remove them from the device query (for example with a region or tag condition) or ask the lab to check them; until then, tests routed to them fail or wait.' });
  }
  if (health) {
    const limit = Math.round(Math.max(0.3, 2 * health.baseline) * 100);
    sections.push({ title: `Devices Failing Far More Often Than the Pool (Last ${plural(i.days, 'Day')})`, blocks: flagged.length ? [{ type: 'table', columns: [
      { key: 'name', label: 'Device' }, { key: 'runs', label: 'Runs', format: 'number' }, { key: 'fail', label: 'Failure rate', format: 'percent', decimals: 0 },
      { key: 'infra', label: 'Infrastructure share', format: 'percent', decimals: 0 }, { key: 'cause', label: 'Top cause' }],
    rows: flagged.slice(0, 15).map((d) => ({ name: d.name, runs: d.runs, fail: d.failRatio * 100, infra: d.infraShare * 100, cause: d.topCause })) }] :
      [{ type: 'callout', tone: 'note', title: 'No device stands out', text: `No device with at least 5 runs failed ${limit}% or more of its runs in the last ${plural(i.days, 'day')}.` }],
    whatItMeans: flagged.length
      ? `Across the pool ${Math.round(health.baseline * 100)}% of runs fail; ${flagged.length === 1 ? 'this device fails' : 'these devices fail'} ${limit}% or more. A high infrastructure share points at the device itself (stuck dialog, wrong screen, network): check it before changing any test. find_unhealthy_devices can compare tests across devices and tag ${flagged.length === 1 ? 'it' : 'them'}.`
      : `Across the pool ${Math.round(health.baseline * 100)}% of runs fail and no device with enough runs is far above that.` });
  }
  return {
    highlights,
    spec: {
      title: 'Device Health',
      subtitle: `Status now${health ? `, test results over the last ${plural(i.days, 'day')}` : ''}`,
      // Not "Project": the pool is every device this access key sees; projectName scopes only the test results.
      meta: [...(i.projectName ? [{ label: 'Test results', value: `project ${i.projectName}` }] : []), { label: 'As of', value: longDate(i.now) }],
      headline: { value: `${available} of ${i.devices.length}`, label: 'Devices available' },
      sections,
      source: `Source: Digital.ai Testing device inventory (${plural(i.devices.length, 'device')} visible to this access key)` + (health ? ` and reporter runs from the last ${plural(i.days, 'day')}.` : '.') +
        ' "Degraded" marks an available device whose failure rate is far above the pool.',
    },
  };
}

// ── Usage summary ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReservationRow { start: number; hours: number; user: string; device: string; deviceDetail: string; project: string }
export interface DeviceUsageRow { device: string; os: string; osVersion: string; project: string; hours: number; deviceId?: string }
export interface UserUsageRow { user: string; project: string; hours: number; /** The user's tags as the report gives them: one cell, comma-separated. */ tags?: string }

/**
 * Usage across EVERY project: reserved hours by project, device and user. Built from the aggregated Devices Usage and
 * Users Usage reports, which carry totals for a range and no dates — so there is no weekly trend here (the per-project
 * usage summary has it), only the whole range against the recent window.
 */
export function buildUsageOverview(i: { devices: DeviceUsageRow[]; recentDevices: DeviceUsageRow[] | null; users: UserUsageRow[] | null; from: number; to: number; recentDays: number; usersNote?: string }): RecipeResult {
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const days = Math.max(1, Math.round((i.to - i.from) / DAY));
  const total = (rows: Array<{ hours: number }>) => rows.reduce((s, r) => s + r.hours, 0);
  const by = <T extends { hours: number }>(rows: T[], key: (r: T) => string) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + r.hours);
    return [...m].map(([k, v]) => [k, r1(v)] as [string, number]).sort((a, b) => b[1] - a[1]);
  };
  const used = i.devices.filter((d) => d.hours > 0);
  const hoursAll = total(used);
  const hoursRecent = i.recentDevices ? total(i.recentDevices) : null;
  const projects = by(used, (d) => d.project);
  const recentByProject = new Map(i.recentDevices ? by(i.recentDevices, (d) => d.project) : []);
  const devicesOf = (p: string) => new Set(used.filter((d) => d.project === p).map((d) => d.device)).size;
  const activeUsers = i.users ? i.users.filter((u) => u.hours > 0) : null;
  const usersOf = (p: string) => (activeUsers ? new Set(activeUsers.filter((u) => u.project === p).map((u) => u.user)).size : null);
  const pct = (v: number, of: number) => Math.round((v / Math.max(of, 0.0001)) * 1000) / 10;
  const perMonth = hoursAll / (days / 30);

  const highlights = [`${r1(hoursAll).toLocaleString('en-US')} reserved hours across ${plural(projects.length, 'project')} over ${days} days` +
    (hoursRecent != null ? `, ${r1(hoursRecent).toLocaleString('en-US')} in the last ${i.recentDays}.` : '.')];
  if (projects.length) highlights.push(`${projects[0][0]} leads with ${pct(projects[0][1], hoursAll)}% of the hours.`);

  const topProjects = topN(projects, 10);
  const top3 = projects.slice(0, 3).reduce((s, [, v]) => s + v, 0);
  const deviceDetail = new Map(used.map((d) => [d.device, [d.os, d.osVersion].filter(Boolean).join(' ')]));
  const devices = by(used, (d) => d.device);
  const topDevices = topN(devices, 10);
  const osHours = by(used, (d) => d.os || '(unknown)');
  const userHours = activeUsers ? by(activeUsers, (u) => u.user) : [];
  const topUsers = topN(userHours, 10);
  const trend = hoursRecent == null ? null : hoursRecent / (i.recentDays / 30) - perMonth;

  const overview: Section[] = [
    { title: 'At a Glance', blocks: [{ type: 'kpis', items: [
      { value: r1(hoursAll).toLocaleString('en-US'), label: `Hours, last ${days} days` },
      ...(hoursRecent != null ? [{ value: r1(hoursRecent).toLocaleString('en-US'), label: `Hours, last ${i.recentDays} days`, accent: 'teal' as const }] : []),
      { value: projects.length.toLocaleString('en-US'), label: 'Projects with usage' },
      { value: devices.length.toLocaleString('en-US'), label: 'Devices used', accent: 'teal' as const },
      ...(activeUsers ? [{ value: userHours.length.toLocaleString('en-US'), label: 'Active users' }] : [])] }] },
    ...(hoursRecent != null && trend != null ? [{ title: `Usage Trend: ${days} Days vs Last ${i.recentDays} Days`, blocks: [{ type: 'compare' as const, groups: [
      { title: 'Hours per month', rows: [{ label: `${days}-day avg`, value: r1(perMonth) }, { label: `${i.recentDays} days`, value: r1(hoursRecent / (i.recentDays / 30)) }] }] }],
      whatItMeans: `Reserved hours in the last ${i.recentDays} days are ${Math.abs(Math.round((trend / Math.max(perMonth, 0.0001)) * 100))}% ${trend >= 0 ? 'above' : 'below'} the ${days}-day monthly average.` }] : []),
    { title: `Reserved Hours by Project, Last ${days} Days`, blocks: [{ type: 'bar', orientation: 'horizontal', unit: 'hrs', showShare: true, shareTotal: hoursAll,
      categories: topProjects.cats, series: [{ name: 'Hours', values: topProjects.vals }],
      ...(topProjects.other ? { otherLabel: `All other projects: ${pct(topProjects.other, hoursAll)}%`, otherNote: `${projects.length - 10} more projects` } : {}) }],
      whatItMeans: !projects.length ? 'No reserved hours in this range.' :
        `The top ${Math.min(3, projects.length)} projects take ${Math.round((top3 / Math.max(hoursAll, 0.0001)) * 100)}% of all reserved hours, led by ${projects[0][0]}.` },
  ];
  const projectTable: Section = { title: 'Every Project', blocks: [{ type: 'table', maxRows: 200,
    columns: [{ key: 'project', label: 'Project' }, { key: 'hours', label: `Hours, ${days} days`, format: 'number', decimals: 1 },
      { key: 'share', label: 'Share', format: 'percent', decimals: 1 },
      ...(hoursRecent != null ? [{ key: 'recent', label: `Hours, last ${i.recentDays} days`, format: 'number' as const, decimals: 1 }] : []),
      { key: 'devices', label: 'Devices', format: 'number' as const }, ...(activeUsers ? [{ key: 'users', label: 'Users', format: 'number' as const }] : [])],
    rows: projects.map(([p, h]) => ({ project: p, hours: h, share: pct(h, hoursAll), recent: recentByProject.get(p) ?? 0, devices: devicesOf(p), users: usersOf(p) ?? 0 })) }],
    whatItMeans: `${plural(projects.length, 'project')} reserved a device in this range. A project with no reserved hours is not listed.` };
  const deviceTab: Section[] = [
    { title: `Top Devices, Last ${days} Days`, blocks: [{ type: 'bar', orientation: 'horizontal', unit: 'hrs', showShare: true, shareTotal: hoursAll,
      categories: topDevices.cats.map((d) => (deviceDetail.get(d) ? `${d}|${deviceDetail.get(d)}` : d)), series: [{ name: 'Hours', values: topDevices.vals }],
      ...(topDevices.other ? { otherLabel: `All other devices: ${pct(topDevices.other, hoursAll)}%`, otherNote: `${devices.length - 10} more devices` } : {}) }],
      whatItMeans: !devices.length ? 'No device was reserved in this range.' :
        `${devices[0][0]} is the most reserved device with ${devices[0][1].toLocaleString('en-US')} hours, across all projects.` },
    ...(osHours.length ? [{ title: 'Reserved Hours by Platform', blocks: [{ type: 'share' as const, unit: 'hrs', parts: osHours.slice(0, 8).map(([label, value]) => ({ label, value })) }],
      whatItMeans: `${osHours[0][0]} takes ${Math.round(pct(osHours[0][1], hoursAll))}% of the reserved hours.` }] : []),
  ];
  // Hours by user tag (a team, a cost centre): the basis of a chargeback. A user with several tags is counted under each.
  const tagHours = new Map<string, { hours: number; users: Set<string> }>();
  let untagged = 0;
  const multiTagged = new Set<string>(); // users, not rows: a user has one row per project
  for (const u of activeUsers ?? []) {
    const tags = (u.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    if (!tags.length) { untagged += u.hours; continue; }
    if (tags.length > 1) multiTagged.add(u.user);
    for (const t of tags) { const g = tagHours.get(t) ?? { hours: 0, users: new Set<string>() }; g.hours += u.hours; g.users.add(u.user); tagHours.set(t, g); }
  }
  const tagList = [...tagHours].sort((a, b) => b[1].hours - a[1].hours);
  const tagSection: Section[] = !tagList.length ? [] : [{ title: 'Reserved Hours by User Tag', blocks: [{ type: 'table', maxRows: 100, columns: [{ key: 'tag', label: 'User tag' },
    { key: 'users', label: 'Users', format: 'number' }, { key: 'hours', label: 'Reserved hours', format: 'number', decimals: 1 }, { key: 'share', label: 'Share of hours', format: 'percent', decimals: 1 }],
  rows: [...tagList.slice(0, 99).map(([tag, g]) => ({ tag, users: g.users.size, hours: Math.round(g.hours * 10) / 10, share: pct(g.hours, total(activeUsers ?? [])) })),
    ...(untagged > 0 ? [{ tag: '(no tag)', users: new Set((activeUsers ?? []).filter((u) => !(u.tags ?? '').trim()).map((u) => u.user)).size, hours: Math.round(untagged * 10) / 10, share: pct(untagged, total(activeUsers ?? [])) }] : [])] }],
    whatItMeans: `${tagList[0][0]} has the most reserved hours of ${plural(tagList.length, 'user tag')} (${pct(tagList[0][1].hours, total(activeUsers ?? []))}%).` +
      (untagged > 0 ? ` ${pct(untagged, total(activeUsers ?? []))}% of the hours belong to users with no tag, so a split by tag does not yet cover everything.` : ' Every active user has a tag.') +
      (multiTagged.size ? ` ${plural(multiTagged.size, 'user')} with more than one tag ${multiTagged.size === 1 ? 'is' : 'are'} counted under each, so the rows add up to more than the total.` : '') }];

  const userTab: Section[] = !activeUsers ? [] : [
    { title: `Top Users, Last ${days} Days`, blocks: [{ type: 'bar', orientation: 'horizontal', unit: 'hrs', showShare: true, shareTotal: total(activeUsers),
      categories: topUsers.cats, series: [{ name: 'Hours', values: topUsers.vals }],
      ...(topUsers.other ? { otherLabel: `All other users: ${pct(topUsers.other, total(activeUsers))}%` } : {}) }],
      whatItMeans: !userHours.length ? 'No user reserved a device in this range.' :
        `The top ${topUsers.cats.length} users account for ${Math.round((topUsers.vals.reduce((s, v) => s + v, 0) / Math.max(total(activeUsers), 0.0001)) * 100)}% of the reserved hours of ${plural(userHours.length, 'active user')}.` },
    ...tagSection,
  ];
  return {
    highlights,
    spec: {
      title: 'Usage Overview',
      subtitle: `Device reservations across all projects, last ${days} days`,
      meta: [{ label: 'Scope', value: 'All projects' }, ...rangeMeta(i.from, i.to, undefined, true)],
      headline: { value: `${r1(hoursAll).toLocaleString('en-US')} hrs`, label: `Reserved over ${days} days` },
      tabs: [
        { label: 'Executive Overview', sections: overview },
        { label: 'Projects', sections: [projectTable] },
        { label: 'Devices', sections: deviceTab },
        ...(userTab.length ? [{ label: 'Users', sections: userTab }] : []),
      ],
      source: `Source: Digital.ai Testing "Devices Usage"${activeUsers ? ' and "Users Usage"' : ''} usage reports, all projects, ${longDate(i.from, true)} to ${longDate(i.to, true)} (UTC). ` +
        'Hours are reservation time, which includes both manual and automated use. These reports hold totals per range, not dates: for weekly hours, name one project.' +
        (activeUsers || !i.usersNote ? '' : ` ${i.usersNote}`),
    },
  };
}

export function buildUsageSummary(i: { rows: ReservationRow[]; from: number; to: number; recentDays: number; projectName?: string }): RecipeResult {
  const highlights: string[] = [];
  const recentFrom = i.to - i.recentDays * DAY;
  const recent = i.rows.filter((r) => r.start >= recentFrom);
  const sum = (rs: ReservationRow[]) => rs.reduce((s, r) => s + r.hours, 0);
  const hoursAll = sum(i.rows), hoursRecent = sum(recent);
  const days = Math.max(1, Math.round((i.to - i.from) / DAY));
  const usersAll = new Set(i.rows.map((r) => r.user)).size, usersRecent = new Set(recent.map((r) => r.user)).size;
  const devicesAll = new Set(i.rows.map((r) => r.device)).size;
  const perMonth = hoursAll / (days / 30);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  highlights.push(`${r1(hoursAll).toLocaleString('en-US')} reserved hours over ${days} days, ${r1(hoursRecent).toLocaleString('en-US')} in the last ${i.recentDays}.`);

  const keys = buckets(i.from, i.to, 'week', true);
  const weekly = keys.map((k) => r1(sum(i.rows.filter((r) => bucketStart(r.start, 'week', true) === k))));
  const firstRecent = keys.find((k) => k + 7 * DAY > recentFrom) ?? keys[keys.length - 1];
  const partial = [keys[0] < bucketStart(i.from, 'day', true) ? shortDay(keys[0], true) : null, keys[keys.length - 1] + 7 * DAY > i.to + DAY ? shortDay(keys[keys.length - 1], true) : null].filter((x): x is string => !!x);
  const trend = hoursRecent / (i.recentDays / 30) - perMonth;
  const trendMeans = `Reserved hours in the last ${i.recentDays} days are ${Math.abs(Math.round((trend / Math.max(perMonth, 0.0001)) * 100))}% ${trend >= 0 ? 'above' : 'below'} the ${days}-day monthly average, ` +
    `and ${usersRecent} of ${usersAll} users were active in that window.`;

  const userHours = [...new Set(i.rows.map((r) => r.user))].map((u) => [u, r1(sum(i.rows.filter((r) => r.user === u)))] as [string, number]).sort((a, b) => b[1] - a[1]);
  const users = topN(userHours, 10);
  const topUserShare = hoursAll ? users.vals.reduce((s, v) => s + v, 0) / hoursAll : 0;
  const deviceDetail = new Map(i.rows.map((r) => [r.device, r.deviceDetail]));
  const devHours = (rs: ReservationRow[]) => [...new Set(rs.map((r) => r.device))].map((d) => [d, r1(sum(rs.filter((r) => r.device === d)))] as [string, number]).sort((a, b) => b[1] - a[1]);
  const devsAll = devHours(i.rows), devsRecent = devHours(recent);
  const devBlock = (list: Array<[string, number]>, total: number): Block => {
    const t = topN(list, 8);
    return { type: 'bar', orientation: 'horizontal', unit: 'hrs', showShare: true, shareTotal: total,
      categories: t.cats.map((d) => (deviceDetail.get(d) ? `${d}|${deviceDetail.get(d)}` : d)), series: [{ name: 'Hours', values: t.vals }],
      ...(t.other ? { otherLabel: `All other devices: ${Math.round((t.other / Math.max(total, 0.0001)) * 1000) / 10}%`, otherNote: `${list.length - 8} more devices` } : {}) };
  };
  const devMeans = (list: Array<[string, number]>, total: number, label: string) => !list.length ? `No reservations in the ${label}.` :
    `The top three devices take ${Math.round((list.slice(0, 3).reduce((s, [, v]) => s + v, 0) / Math.max(total, 0.0001)) * 100)}% of reserved hours in the ${label}, led by ${list[0][0]}${deviceDetail.get(list[0][0]) ? ` (${deviceDetail.get(list[0][0])})` : ''}.`;

  return {
    highlights,
    spec: {
      title: 'Usage Summary',
      subtitle: `Device reservations, last ${days} days vs last ${i.recentDays} days`,
      meta: rangeMeta(i.from, i.to, i.projectName, true),
      headline: { value: `${r1(hoursAll)} hrs`, label: `Reserved over ${days} days` },
      tabs: [
        { label: 'Executive Overview', sections: [
          { title: 'At a Glance', blocks: [{ type: 'kpis', items: [
            { value: r1(hoursAll).toLocaleString('en-US'), label: `Hours, last ${days} days` },
            { value: r1(hoursRecent).toLocaleString('en-US'), label: `Hours, last ${i.recentDays} days`, accent: 'teal' },
            { value: usersAll.toLocaleString('en-US'), label: 'Active users' },
            { value: devicesAll.toLocaleString('en-US'), label: 'Devices used', accent: 'teal' }] }] },
          { title: `Usage Trend: ${days} Days vs Last ${i.recentDays} Days`, blocks: [{ type: 'compare', groups: [
            { title: 'Active users', rows: [{ label: `${days} days`, value: usersAll }, { label: `${i.recentDays} days`, value: usersRecent }] },
            { title: 'Hours per month', rows: [{ label: `${days}-day avg`, value: r1(perMonth) }, { label: `${i.recentDays} days`, value: r1(hoursRecent / (i.recentDays / 30)) }] }] }],
          whatItMeans: trendMeans },
          { title: 'Weekly Reserved Hours', blocks: [{ type: 'bar', categories: keys.map((k) => shortDay(k, true)), series: [{ name: 'Hours', values: weekly }], unit: 'hrs',
            highlight: { from: shortDay(firstRecent, true), label: `Last ${i.recentDays} days` }, ...(partial.length ? { partial, partialNote: 'Lighter bars are partial weeks' } : {}) }],
          whatItMeans: `The busiest week started ${shortDay(keys[weekly.indexOf(Math.max(...weekly))], true)} with ${Math.max(...weekly)} hours.` + (partial.length ? ' Partial weeks at the edges of the range are lighter and lower by nature.' : '') },
          { title: `Top Users, Last ${days} Days`, blocks: [{ type: 'bar', orientation: 'horizontal', unit: 'hrs', showShare: true, shareTotal: hoursAll, categories: users.cats, series: [{ name: 'Hours', values: users.vals }],
            ...(users.other ? { otherLabel: `All other users: ${Math.round((users.other / Math.max(hoursAll, 0.0001)) * 1000) / 10}%` } : {}) }],
          whatItMeans: `The top ${users.cats.length} users account for ${Math.round(topUserShare * 100)}% of reserved hours.` },
        ] },
        { label: `Last ${i.recentDays} Days`, sections: [{ title: `Device Usage, Last ${i.recentDays} Days`, blocks: [devBlock(devsRecent, hoursRecent)], whatItMeans: devMeans(devsRecent, hoursRecent, `last ${i.recentDays} days`) }] },
        { label: `Last ${days} Days`, sections: [{ title: `Device Usage, Last ${days} Days`, blocks: [devBlock(devsAll, hoursAll)], whatItMeans: devMeans(devsAll, hoursAll, `last ${days} days`) }] },
      ],
      source: `Source: Digital.ai Testing "Device Reservations" usage report, ${plural(i.rows.length, 'reservation')} from ${longDate(i.from, true)} to ${longDate(i.to, true)} (UTC). Hours are reservation time, which includes both manual and automated use.`,
    },
  };
}

// ── Test reliability: every test of a period against the period before, from counts by test name ──────────────────

/** Fewer verdicts than this in a period and a test is not judged in it. */
const MIN_VERDICTS_TO_JUDGE = 3;
export type TestStanding = 'Newly failing' | 'Fails every time' | 'Mixed results' | 'Passes every time' | 'Too few runs';

const passCount = (c: StatusCounts) => c.passed + c.healed;
const failCount = (c: StatusCounts) => c.failed + c.error;
const isJudged = (c: StatusCounts | undefined): c is StatusCounts => !!c && verdicts(c) >= MIN_VERDICTS_TO_JUDGE;
export interface JudgedTest { name: string; c: StatusCounts; p?: StatusCounts; standing: TestStanding }

/** Counts by test name for a period and for the one before: one standing per test. Names that differ only in run ids are one test. */
function judgeTests(current: BreakdownRow[], previous: BreakdownRow[] | null): { tests: JudgedTest[]; cur: Map<string, StatusCounts>; prev: Map<string, StatusCounts> | null; hasPrev: boolean } {
  // One spelling per test across both periods, the current one first, so "Login" now and "login" before are one test.
  const one = sameSpelling();
  const fold = (rows: BreakdownRow[]) => {
    const m = new Map<string, StatusCounts>();
    for (const r of rows) { const k = one(groupValue('name', r.values[0])); m.set(k, addCounts(m.get(k) ?? emptyCounts(), r.counts)); }
    return m;
  };
  const cur = fold(current), prev = previous ? fold(previous) : null;
  const tests = [...cur].filter(([, c]) => c.total > 0).map(([name, c]): JudgedTest => {
    const p = prev?.get(name);
    const standing: TestStanding = verdicts(c) === 0 ? 'Too few runs'
      : isJudged(p) && failCount(p) === 0 && failCount(c) >= 2 && failCount(c) * 2 >= verdicts(c) ? 'Newly failing'
      : !isJudged(c) ? 'Too few runs'
      : passCount(c) === 0 ? 'Fails every time'
      : failCount(c) > 0 ? 'Mixed results' : 'Passes every time';
    return { name, c, p, standing };
  });
  return { tests, cur, prev, hasPrev: !!prev && prev.size > 0 };
}

/**
 * Where each test stands: passes every time, fails every time, both in the same period ("mixed results"; the counts
 * cannot say why, so no test is called flaky), or newly failing (passed every run of the previous period, fails at least
 * half of its runs now). `current` and `previous` are the platform's counts by test name for two periods of the same
 * length, so nothing is sampled; names that differ only in run ids are one test (testFamily).
 */
export function buildTestReliability(i: { current: BreakdownRow[]; previous: BreakdownRow[] | null; from: number; to: number; days: number; projectName?: string }): RecipeResult {
  const n = (x: number) => x.toLocaleString('en-US');
  const { tests, cur, prev, hasPrev } = judgeTests(i.current, i.previous);
  const pass = passCount, fail = failCount, judged = isJudged;
  type T = JudgedTest;
  const by = (s: TestStanding) => tests.filter((t) => t.standing === s);
  const newly = by('Newly failing').sort((a, b) => fail(b.c) - fail(a.c));
  const always = by('Fails every time').sort((a, b) => verdicts(b.c) - verdicts(a.c));
  const mixed = by('Mixed results').sort((a, b) => fail(b.c) - fail(a.c));
  const passing = by('Passes every time');
  const few = by('Too few runs');
  const recovered = passing.filter((t) => judged(t.p) && fail(t.p) > 0).sort((a, b) => fail(b.p!) - fail(a.p!));
  const fresh = hasPrev ? tests.filter((t) => !t.p || !t.p.total) : [];
  const stopped = hasPrev ? [...prev!].filter(([name, c]) => !(cur.get(name)?.total) && c.total >= MIN_VERDICTS_TO_JUDGE).sort((a, b) => b[1].total - a[1].total) : [];
  const all = tests.reduce((c, t) => addCounts(c, t.c), emptyCounts());
  const runsOf = (list: T[]) => list.reduce((s, t) => s + t.c.total, 0);
  const rate = passRate(all);
  const window = `last ${plural(i.days, 'day')}`, before = `previous ${plural(i.days, 'day')}`;
  const prevText = (t: T) => (!hasPrev ? '' : !t.p || !t.p.total ? 'did not run' : verdicts(t.p) ? `${n(pass(t.p))} of ${n(verdicts(t.p))} passed` : 'no verdict');
  const prevRate = (t: T) => (judged(t.p) ? pct1(passRate(t.p)) : '');
  const change = (t: T) => {
    if (!judged(t.p)) return '';
    const d = (passRate(t.c) ?? 0) - (passRate(t.p) ?? 0);
    return `${d > 0 ? '+' : ''}${d.toFixed(1)} pts`;
  };
  const share = (v: number, of: number) => Math.round((v / Math.max(of, 1)) * 100);
  /** A share for a sentence: 12 of 9,118 runs is "under 1%", never "0%". */
  const shareText = (v: number, of: number) => (v > 0 && v / Math.max(of, 1) < 0.01 ? 'under 1%' : v < of && share(v, of) >= 100 ? 'over 99%' : `${share(v, of)}%`);
  const judgedTests = tests.length - few.length;
  const failingRuns = runsOf(always);
  const worse = mixed.filter((t) => judged(t.p) && (passRate(t.c) ?? 0) < (passRate(t.p) ?? 0) - 10);
  // A test at 99.7% has "mixed results" too; the ones a single run says little about are those near an even split.
  const unsteady = mixed.filter((t) => { const r = passRate(t.c) ?? 0; return r >= 10 && r <= 90; });

  const standingParts = [
    passing.length ? `${n(passing.length)} ${passing.length === 1 ? 'passes' : 'pass'} every time` : '', mixed.length ? `${n(mixed.length)} ${mixed.length === 1 ? 'has' : 'have'} mixed results` : '',
    always.length ? `${n(always.length)} ${always.length === 1 ? 'fails' : 'fail'} every time` : '', newly.length ? `${n(newly.length)} newly failing` : '',
    few.length ? `${n(few.length)} had too few runs to judge` : ''].filter(Boolean);
  const highlights = [
    `${plural(tests.length, 'test')} ran in the ${window} (${plural(all.total, 'run')}, pass rate ${pct1(rate)})${standingParts.length ? `: ${standingParts.join(', ')}` : ''}.`,
    ...(newly.length ? [`${plural(newly.length, 'test')} passed every run in the ${before} and ${newly.length === 1 ? 'fails' : 'fail'} now; the largest is "${newly[0].name}" (${n(fail(newly[0].c))} of ${n(verdicts(newly[0].c))} runs failed).`] : []),
    ...(mixed.length ? [`Most failures: "${mixed[0].name}" failed ${n(fail(mixed[0].c))} of ${n(verdicts(mixed[0].c))} runs (pass rate ${pct1(passRate(mixed[0].c))}${judged(mixed[0].p) ? `; ${pct1(passRate(mixed[0].p))} in the ${before}` : ''}).`] : []),
    ...(always.length ? [`${plural(always.length, 'test')} failed every run: ${plural(failingRuns, 'run')} (${shareText(failingRuns, all.total)} of all runs) that could not pass. The largest is "${always[0].name}" (${plural(verdicts(always[0].c), 'run')}).`] : []),
    ...(recovered.length ? [`${plural(recovered.length, 'test')} that failed in the ${before} ${recovered.length === 1 ? 'passes' : 'pass'} every run now.`] : []),
    ...(stopped.length ? [`${plural(stopped.length, 'test')} that ran in the ${before} did not run in this one.`] : []),
  ];

  const tone = { 'Passes every time': 'pass', 'Mixed results': 'warn', 'Fails every time': 'fail', 'Newly failing': 'fail', 'Too few runs': 'skip' } as const;
  const order: TestStanding[] = ['Passes every time', 'Mixed results', 'Fails every time', 'Newly failing', 'Too few runs'];
  const parts = (value: (list: T[]) => number) => order.map((s) => ({ label: s, value: value(by(s)), tone: tone[s] })).filter((p) => p.value > 0);
  const testCols = [{ key: 'test', label: 'Test' }, { key: 'runs', label: 'Runs', format: 'number' as const }];
  const sections: Section[] = [
    { title: 'At a Glance', blocks: [{ type: 'kpis', items: [
      { value: n(tests.length), label: `Tests run, ${window}` }, { value: n(passing.length), label: 'Pass every time', accent: 'teal' },
      { value: n(mixed.length), label: 'Mixed results' }, { value: n(always.length), label: 'Fail every time', accent: 'fail' },
      { value: n(newly.length), label: 'Newly failing', accent: 'fail' }] }] },
  ];
  if (!tests.length) {
    sections.push({ title: 'Tests', blocks: [{ type: 'callout', tone: 'note', title: 'No test ran', text: `No test run between ${longDate(i.from)} and ${longDate(i.to)}.` }] });
  } else {
    sections.push({ title: 'Where the Tests Stand', columns: 2, blocks: [
      { type: 'share', label: 'Tests', parts: parts((l) => l.length) }, { type: 'share', label: 'Runs', parts: parts(runsOf) }],
      whatItMeans: (judgedTests ? `${n(passing.length)} of ${plural(judgedTests, 'test')} with enough runs to judge passed every run; they carry ${shareText(runsOf(passing), all.total)} of the runs.` : 'No test had enough runs to judge.') +
        (mixed.length ? ` ${plural(mixed.length, 'test')} both passed and failed in the same period and ${mixed.length === 1 ? 'carries' : 'carry'} ${shareText(runsOf(mixed), all.total)} of the runs.` +
          (unsteady.length ? ` ${n(unsteady.length)} of them ${unsteady.length === 1 ? 'passes' : 'pass'} between 10% and 90% of ${unsteady.length === 1 ? 'its' : 'their'} runs (${shareText(runsOf(unsteady), all.total)} of all runs): for ${unsteady.length === 1 ? 'that test' : 'those'} a single result says little.`
            : ' None of them is near an even split: each passes over 90% of its runs, or under 10%.') : '') +
        (always.length ? ` Tests that fail every time take ${shareText(failingRuns, all.total)} of the runs${share(failingRuns, all.total) >= 1 ? ': device time spent on a result that is known in advance, until they are fixed or taken out of the run' : ''}.` : '') +
        (few.length ? ` ${plural(few.length, 'test')} had fewer than ${MIN_VERDICTS_TO_JUDGE} verdicts and ${few.length === 1 ? 'is' : 'are'} not judged.` : '') });
    if (newly.length) sections.push({ title: 'Newly Failing', blocks: [{ type: 'table', maxRows: 100, columns: [...testCols,
      { key: 'failed', label: 'Failed or error', format: 'number' }, { key: 'rate', label: 'Pass rate' }, { key: 'prev', label: `In the ${before}` }],
    rows: newly.slice(0, 100).map((t) => ({ test: t.name, runs: t.c.total, failed: fail(t.c), rate: pct1(passRate(t.c)), prev: prevText(t) })) }],
      whatItMeans: `These tests passed every run in the ${before} and fail at least half of their runs now. Something changed between the two periods: the app build, the test, its data or the devices it ran on. ` +
        'They are the first place to look, because the change is recent.' });
    if (always.length) sections.push({ title: 'Failing Every Time', blocks: [{ type: 'table', maxRows: 100, columns: [...testCols,
      ...(hasPrev ? [{ key: 'prev', label: `In the ${before}` }] : [])],
    rows: always.slice(0, 100).map((t) => ({ test: t.name, runs: t.c.total, prev: prevText(t) })) }],
      whatItMeans: (() => {
        const old = always.filter((t) => judged(t.p) && pass(t.p) === 0).length;
        return `${plural(always.length, 'test')} did not pass once in ${plural(failingRuns, 'run')}.` +
          (hasPrev && old ? ` ${old === always.length ? (old === 1 ? 'It' : 'All of them') : n(old)} also failed every run in the ${before}: ${old === 1 ? 'that is a broken test or a known defect' : 'those are broken tests or known defects'}, not news.` : '') +
          ' A test that cannot pass tells nothing new and lowers the pass rate of every report it is in.';
      })() });
    if (mixed.length) sections.push({ title: 'Mixed Results', blocks: [{ type: 'table', maxRows: 100, columns: [...testCols,
      { key: 'passed', label: 'Passed', format: 'number' }, { key: 'failed', label: 'Failed or error', format: 'number' }, { key: 'rate', label: 'Pass rate' },
      ...(hasPrev ? [{ key: 'prev', label: 'Pass rate before' }, { key: 'change', label: 'Change' }] : [])],
    rows: mixed.slice(0, 100).map((t) => ({ test: t.name, runs: t.c.total, passed: pass(t.c), failed: fail(t.c), rate: pct1(passRate(t.c)), prev: prevRate(t), change: change(t) })) }],
      whatItMeans: `${plural(mixed.length, 'test')} passed and failed in the same period${mixed.length > 100 ? '; the 100 with the most failures are listed' : ''}.` +
        (worse.length ? ` ${n(worse.length)} of them dropped by more than 10 points against the ${before}.` : '') +
        ' The counts cannot say why a test does both: it can be the device, the environment, test data or timing. ' +
        'A breakdown of one test by device or platform (create_test_breakdown_report, groupBy test and device) shows whether its failures sit in one place.' });
    if (recovered.length) sections.push({ title: 'Recovered', blocks: [{ type: 'table', maxRows: 50, columns: [...testCols, { key: 'prev', label: `In the ${before}` }],
      rows: recovered.slice(0, 50).map((t) => ({ test: t.name, runs: t.c.total, prev: prevText(t) })) }],
      whatItMeans: `${plural(recovered.length, 'test')} failed at least once in the ${before} and passed every run in this one.` });
    if (stopped.length) sections.push({ title: 'No Longer Run', blocks: [{ type: 'table', maxRows: 50, columns: [
      { key: 'test', label: 'Test' }, { key: 'runs', label: `Runs in the ${before}`, format: 'number' }, { key: 'rate', label: 'Pass rate then' }],
    rows: stopped.slice(0, 50).map(([name, c]) => ({ test: name, runs: c.total, rate: pct1(passRate(c)) })) }],
      whatItMeans: `${plural(stopped.length, 'test')} ran in the ${before} and not once in this period${stopped.length > 50 ? '; the 50 with the most runs are listed' : ''}. ` +
        'A test that stopped running was renamed, removed or skipped: its result is missing from this period\'s pass rate.' +
        (fresh.length ? ` ${plural(fresh.length, 'test')} ran in this period only; a renamed test shows up in both lists.` : '') });
    const everyone = [...tests].sort((a, b) => b.c.total - a.c.total);
    sections.push({ title: 'Every Test', blocks: [{ type: 'table', maxRows: 300, columns: [...testCols,
      { key: 'passed', label: 'Passed', format: 'number' }, { key: 'failed', label: 'Failed or error', format: 'number' }, { key: 'other', label: 'Incomplete or skipped', format: 'number' },
      { key: 'rate', label: 'Pass rate' }, ...(hasPrev ? [{ key: 'prev', label: 'Pass rate before' }] : []), { key: 'standing', label: 'Standing' }],
    rows: everyone.slice(0, 300).map((t) => ({ test: t.name, runs: t.c.total, passed: pass(t.c), failed: fail(t.c), other: t.c.incomplete + t.c.skipped, rate: pct1(passRate(t.c)), prev: prevRate(t), standing: t.standing })) }],
      whatItMeans: `Every test of the period with its counts${tests.length > 300 ? ` (the 300 with the most runs of ${n(tests.length)})` : ''}. Test names that differ only in ids, dates or run numbers are counted as one test.` });
  }
  return {
    highlights,
    spec: {
      title: 'Test Reliability',
      subtitle: `Every test of the ${window}${hasPrev ? `, against the ${before}` : ''}`,
      meta: rangeMeta(i.from, i.to, i.projectName),
      headline: judgedTests ? { value: `${n(passing.length)} of ${n(judgedTests)}`, label: 'Judged tests passing every run' } : undefined,
      sections,
      source: `Source: Digital.ai Testing reporter, the platform's own counts by test name and status for ${i.projectName ? `project ${i.projectName}` : 'the access key\'s own project'}, ` +
        `${longDate(i.from)} to ${longDate(i.to)}${hasPrev ? ` and the ${i.days} days before` : ''} (nothing is sampled or cut off). ` +
        `A test is judged from ${MIN_VERDICTS_TO_JUDGE} verdicts (passed, healed, failed or error) in a period. Newly failing: passed every run before, fails at least half now. ` +
        'Mixed results: at least one pass and one failure in the period.',
    },
  };
}

// ── Release readiness: a period (or one build) against stated checks ───────────────────────────────────────────────

export type CheckResult = 'Passed' | 'Failed' | 'At risk';
/** Fewer verdicts than this and the report gives no verdict of its own. */
const MIN_VERDICTS_FOR_READINESS = 20;

/**
 * A go/no-go view: the runs of a period (optionally one build, platform or any report column) against checks that the
 * report states in full. The verdict is the outcome of those checks, not a decision: "Not ready" when one fails, "Ready
 * with risks" when one is at risk, "Ready" when all pass, and no verdict under 20 verdicts.
 */
export function buildReleaseReadiness(i: { current: BreakdownRow[]; previous: BreakdownRow[] | null; platforms: BreakdownRow[] | null; classes: BreakdownRow[] | null;
  from: number; to: number; days: number; projectName?: string; passRateGoal?: number }): RecipeResult {
  const n = (x: number) => x.toLocaleString('en-US');
  const goal = i.passRateGoal ?? 95;
  const { tests, hasPrev } = judgeTests(i.current, i.previous);
  const window = `last ${plural(i.days, 'day')}`, before = `previous ${plural(i.days, 'day')}`;
  const all = tests.reduce((c, t) => addCounts(c, t.c), emptyCounts());
  const rate = passRate(all);
  const v = verdicts(all), fails = all.failed + all.error, noVerdict = all.incomplete + all.skipped;
  const newly = tests.filter((t) => t.standing === 'Newly failing').sort((a, b) => failCount(b.c) - failCount(a.c));
  const always = tests.filter((t) => t.standing === 'Fails every time').sort((a, b) => verdicts(b.c) - verdicts(a.c));
  const knownBroken = always.filter((t) => isJudged(t.p) && passCount(t.p) === 0);
  const unsteady = tests.filter((t) => { const r = passRate(t.c) ?? 0; return t.standing === 'Mixed results' && r >= 10 && r <= 90; }).sort((a, b) => failCount(b.c) - failCount(a.c));
  const plat = new Map<string, StatusCounts>();
  for (const r of i.platforms ?? []) { const k = groupValue('device.os', r.values[0]); plat.set(k, addCounts(plat.get(k) ?? emptyCounts(), r.counts)); }
  const platRanked = [...plat].filter(([, c]) => verdicts(c) >= MIN_VERDICTS_TO_RANK).sort((a, b) => (passRate(a[1]) ?? 0) - (passRate(b[1]) ?? 0));
  const platBelow = platRanked.filter(([, c]) => (passRate(c) ?? 0) < goal);
  const names = (list: Array<{ name: string }>, max = 3) => `${list.slice(0, max).map((t) => `"${t.name}"`).join(', ')}${list.length > max ? ', …' : ''}`;
  // Failures that would have to pass for the rate to reach the goal.
  const toGoal = Math.max(0, Math.ceil(fails - (1 - goal / 100) * v));

  const enough = v >= MIN_VERDICTS_FOR_READINESS;
  const checks: Array<{ check: string; result: CheckResult; detail: string; short: string }> = !enough ? [] : [
    { check: `Pass rate of at least ${goal}%`, short: 'pass rate', result: (rate ?? 0) >= goal ? 'Passed' : 'Failed',
      detail: `${pct1(rate)} over ${n(v)} verdicts.${toGoal ? ` ${n(toGoal)} fewer ${toGoal === 1 ? 'failure' : 'failures'} would reach the goal.` : ''}` },
    { check: 'No newly failing test', short: 'newly failing tests', result: !hasPrev ? 'At risk' : newly.length ? 'Failed' : 'Passed',
      detail: !hasPrev ? `No run in the ${before} to compare with, so a new failure cannot be told from an old one.`
        : newly.length ? `${plural(newly.length, 'test')} passed every run in the ${before} and ${newly.length === 1 ? 'fails' : 'fail'} at least half now: ${names(newly)}.` : `No test that passed every run in the ${before} fails at least half of its runs now.` },
    { check: 'No test failing every run', short: 'tests failing every run', result: !always.length ? 'Passed' : knownBroken.length === always.length ? 'At risk' : 'Failed',
      detail: !always.length ? 'Every judged test passed at least once.'
        : `${plural(always.length, 'test')} did not pass once: ${names(always)}.${knownBroken.length === always.length ? ` ${always.length === 1 ? 'It' : 'All'} also failed every run in the ${before} (known, but still open).` : ''}` },
    { check: `Every platform at ${goal}% or more`, short: 'a platform under the goal', result: !platRanked.length ? 'At risk' : platBelow.length ? 'Failed' : 'Passed',
      detail: !platRanked.length ? `No platform has ${MIN_VERDICTS_TO_RANK} verdicts or more.` : platBelow.length ? `${platBelow.map(([k, c]) => `${k} ${pct1(passRate(c))} (${n(verdicts(c))} verdicts)`).join(', ')}.`
        : `${platRanked.map(([k, c]) => `${k} ${pct1(passRate(c))}`).join(', ')}.` },
    { check: 'No test near an even split', short: 'tests with mixed results', result: unsteady.length ? 'At risk' : 'Passed',
      detail: unsteady.length ? `${plural(unsteady.length, 'test')} ${unsteady.length === 1 ? 'passes' : 'pass'} between 10% and 90% of ${unsteady.length === 1 ? 'its' : 'their'} runs, so one green run of ${unsteady.length === 1 ? 'it' : 'them'} is weak evidence: ${names(unsteady)}.`
        : 'No judged test passes between 10% and 90% of its runs.' },
    { check: 'Runs without a verdict under 5%', short: 'runs without a verdict', result: noVerdict / Math.max(all.total, 1) < 0.05 ? 'Passed' : 'At risk',
      detail: `${plural(noVerdict, 'run')} of ${n(all.total)} ended incomplete or skipped (${((noVerdict / Math.max(all.total, 1)) * 100).toFixed(1)}%); the pass rate leaves them out.` },
  ];
  const failed = checks.filter((c) => c.result === 'Failed'), risky = checks.filter((c) => c.result === 'At risk');
  const verdict = !enough ? 'Not enough data' : failed.length ? 'Not ready' : risky.length ? 'Ready with risks' : 'Ready';
  const verdictText = !enough ? `${plural(v, 'verdict')} in the ${window}: fewer than ${MIN_VERDICTS_FOR_READINESS}, too few for a verdict.`
    : failed.length ? `${failed.length} of ${checks.length} checks failed (${failed.map((c) => c.short).join(', ')})${risky.length ? `; ${risky.length} more at risk` : ''}.`
      : risky.length ? `No check failed; ${risky.length} of ${checks.length} ${risky.length === 1 ? 'is' : 'are'} at risk (${risky.map((c) => c.short).join(', ')}).` : `All ${checks.length} checks passed.`;

  const highlights = [
    `${verdict} against this report's checks: ${verdictText.charAt(0).toLowerCase()}${verdictText.slice(1)}`,
    `Pass rate ${pct1(rate)} over ${plural(v, 'verdict')} in the ${window} (${plural(tests.length, 'test')}); goal ${goal}%.`,
    ...(newly.length ? [`Newly failing: ${names(newly, 5)}.`] : []),
    ...(always.length ? [`Failing every run: ${names(always, 5)}.`] : []),
  ];

  const blockers = [...newly, ...always.filter((t) => !knownBroken.includes(t)), ...knownBroken];
  const sections: Section[] = [
    { title: 'Verdict', blocks: [{ type: 'callout', tone: !enough ? 'note' : failed.length ? 'risk' : risky.length ? 'warning' : 'finding', title: verdict, text: `${verdictText} ` +
      'This is the outcome of the checks listed below, each computed from the platform\'s own counts; whether to release is a decision for the people who know what the failing tests cover.' }] },
    { title: 'At a Glance', blocks: [{ type: 'kpis', items: [
      { value: n(all.total), label: `Runs, ${window}` }, { value: pct1(rate), label: `Pass rate (goal ${goal}%)`, accent: (rate ?? 0) >= goal ? 'teal' : 'fail' },
      { value: n(tests.length), label: 'Tests' }, { value: n(newly.length), label: 'Newly failing', accent: 'fail' }, { value: n(always.length), label: 'Failing every run', accent: 'fail' }] }] },
  ];
  if (enough) {
    sections.push({ title: 'Checks', blocks: [{ type: 'table', columns: [{ key: 'check', label: 'Check' }, { key: 'result', label: 'Result', format: 'status' }, { key: 'detail', label: 'What the counts say' }],
      rows: checks.map(({ check, result, detail }) => ({ check, result, detail })) }],
      whatItMeans: (failed.length ? `${failed.length === 1 ? 'One check fails' : `${failed.length} checks fail`}: ${failed.map((c) => c.short).join(', ')}.` : 'No check fails.') +
        (risky.length ? ` At risk: ${risky.map((c) => c.short).join(', ')}.` : '') + (i.passRateGoal == null ? ` The goal of ${goal}% is this report's default; pass another with passRateGoal.` : ` The goal of ${goal}% was given with the request.`) });
    if (blockers.length) sections.push({ title: 'Tests That Stand in the Way', blocks: [{ type: 'table', maxRows: 60, columns: [{ key: 'test', label: 'Test' }, { key: 'standing', label: 'Standing' },
      { key: 'runs', label: 'Runs', format: 'number' }, { key: 'failed', label: 'Failed or error', format: 'number' }, ...(hasPrev ? [{ key: 'prev', label: `In the ${before}` }] : [])],
    rows: blockers.slice(0, 60).map((t) => ({ test: t.name, standing: t.standing === 'Fails every time' && knownBroken.includes(t) ? 'Fails every time (also before)' : t.standing, runs: t.c.total, failed: failCount(t.c),
      prev: !t.p || !t.p.total ? 'did not run' : verdicts(t.p) ? `${n(passCount(t.p))} of ${n(verdicts(t.p))} passed` : 'no verdict' })) }],
      whatItMeans: (newly.length ? `${plural(newly.length, 'test')} broke between the two periods: start there, the change is recent.` : 'No test broke between the two periods.') +
        (always.length ? ` ${plural(always.length, 'test')} cannot pass at present${knownBroken.length ? `, ${knownBroken.length === always.length ? (always.length === 1 ? '' : 'all of them ') : `${n(knownBroken.length)} of them `}since before this period` : ''}: fix, or take out of the release criteria on purpose.` : '') });
    const platAll = [...plat].sort((a, b) => b[1].total - a[1].total);
    if (platAll.length) sections.push({ title: 'Results by Platform', blocks: [{ type: 'bar', stacked: true, orientation: 'horizontal', categories: platAll.map(([k]) => k), series: [
      { name: 'Passed', values: platAll.map(([, c]) => c.passed + c.healed), tone: 'pass' }, { name: 'Failed or error', values: platAll.map(([, c]) => c.failed + c.error), tone: 'fail' },
      { name: 'Incomplete or skipped', values: platAll.map(([, c]) => c.incomplete + c.skipped), tone: 'skip' }] }],
      whatItMeans: platRanked.length ? `${platRanked.map(([k, c]) => `${k}: ${pct1(passRate(c))} over ${n(verdicts(c))} verdicts`).join('; ')}.` +
        (platBelow.length && platBelow.length < platRanked.length ? ` The gap between platforms is ${((passRate(platRanked[platRanked.length - 1][1]) ?? 0) - (passRate(platRanked[0][1]) ?? 0)).toFixed(1)} points: the release is not equally ready on each.` : '')
        : `No platform has ${MIN_VERDICTS_TO_RANK} verdicts or more.` });
    const cats = new Map<string, number>();
    let infra = 0, classified = 0;
    for (const r of i.classes ?? []) {
      const f = r.counts.failed + r.counts.error;
      if (!f) continue;
      const raw = (r.values[0] ?? '').toLowerCase();
      cats.set(catLabel(r.values[0]), (cats.get(catLabel(r.values[0])) ?? 0) + f);
      if (raw && raw !== 'unclassified') classified += f;
      if (INFRA_CATEGORIES.has(raw)) infra += f;
    }
    const catList = [...cats].sort((a, b) => b[1] - a[1]);
    const catTotal = catList.reduce((s, [, f]) => s + f, 0);
    if (catTotal) sections.push({ title: 'Failures by Classification', blocks: [{ type: 'share', parts: catList.slice(0, 8).map(([label, value]) => ({ label, value })) }],
      whatItMeans: classificationMeans(catTotal, classified, infra, catList) });
  }
  return {
    highlights,
    spec: {
      title: 'Release Readiness',
      subtitle: `The ${window} against stated checks`,
      meta: rangeMeta(i.from, i.to, i.projectName),
      headline: { value: verdict, label: 'Against this report\'s checks' },
      sections,
      source: `Source: Digital.ai Testing reporter, the platform's own counts by test, platform and classification for ${i.projectName ? `project ${i.projectName}` : 'the access key\'s own project'}, ` +
        `${longDate(i.from)} to ${longDate(i.to)}${hasPrev ? ` and the ${i.days} days before` : ''} (nothing is sampled or cut off). ` +
        `Checks: pass rate at or above ${goal}%; no test that passed every run before and fails at least half now; no test without a single pass (at risk when it also never passed before); ` +
        `every platform with ${MIN_VERDICTS_TO_RANK} or more verdicts at the goal; no test passing between 10% and 90% of its runs; under 5% of runs without a verdict. A test is judged from ${MIN_VERDICTS_TO_JUDGE} verdicts.`,
    },
  };
}

// ── Device coverage: what the tests of a period ran on, against the pool ───────────────────────────────────────────

export interface PoolDevice extends DeviceRow { /** The platform's device id (the usage reports' "Device ID"). */ id?: string; osVersion?: string; manufacturer?: string }

/**
 * Which devices, models and OS versions the tests ran on, and which devices of the pool had no run. `byDevice` are the
 * platform's counts per device serial number for the period, `byVersion` per platform and OS version. The pool is every
 * device the access key sees today; the runs are one project's, and the report says so.
 */
export function buildDeviceCoverage(i: { devices: PoolDevice[]; byDevice: GroupCounts; byVersion: BreakdownRow[]; from: number; to: number; days: number; projectName?: string }): RecipeResult {
  const n = (x: number) => x.toLocaleString('en-US');
  const window = `last ${plural(i.days, 'day')}`;
  const pool = i.devices;
  const runsOf = new Map<string, StatusCounts>();
  for (const g of i.byDevice) if (g.key) runsOf.set(String(g.key).toLowerCase(), addCounts(runsOf.get(String(g.key).toLowerCase()) ?? emptyCounts(), g.counts));
  const noDevice = i.byDevice.filter((g) => !g.key).reduce((s, g) => s + g.counts.total, 0);
  const counts = (d: PoolDevice) => runsOf.get(d.serial.toLowerCase());
  const tested = pool.filter((d) => (counts(d)?.total ?? 0) > 0);
  const untested = pool.filter((d) => !(counts(d)?.total));
  const isAvailable = (d: PoolDevice) => /^(available|in use|reserved)$/i.test(d.status);
  const idle = untested.filter(isAvailable);
  const poolSerials = new Set(pool.map((d) => d.serial.toLowerCase()));
  const elsewhere = [...runsOf].filter(([k, c]) => !poolSerials.has(k) && c.total > 0);
  const elsewhereRuns = elsewhere.reduce((s, [, c]) => s + c.total, 0);
  const deviceRuns = [...runsOf.values()].reduce((s, c) => s + c.total, 0);
  const share = (v: number, of: number) => Math.round((v / Math.max(of, 1)) * 100);
  const used = [...tested].sort((a, b) => counts(b)!.total - counts(a)!.total);
  const top5 = used.slice(0, 5).reduce((s, d) => s + counts(d)!.total, 0);

  // OS versions: the major version, per platform ("Android 14", "iOS 17").
  const platform = (os: string | null | undefined) => groupValue('device.os', os ?? null);
  const major = (v: string | null | undefined) => /^\d+/.exec(String(v ?? '').trim())?.[0] ?? '';
  const verKey = (os: string | null | undefined, v: string | null | undefined) => (major(v) ? `${platform(os)} ${major(v)}` : `${platform(os)} (version not recorded)`);
  const versions = new Map<string, { os: string; major: number; inPool: number; tested: number; runs: StatusCounts }>();
  const slot = (os: string | null | undefined, v: string | null | undefined) => {
    const k = verKey(os, v);
    let s = versions.get(k);
    if (!s) { s = { os: platform(os), major: Number(major(v)) || 0, inPool: 0, tested: 0, runs: emptyCounts() }; versions.set(k, s); }
    return s;
  };
  for (const d of pool) { const s = slot(d.os, d.osVersion); s.inPool++; if (counts(d)?.total) s.tested++; }
  for (const r of i.byVersion) { if (r.values[0] == null) continue; const s = slot(r.values[0], r.values[1]); s.runs = addCounts(s.runs, r.counts); }
  const verList = [...versions].sort((a, b) => a[1].os.localeCompare(b[1].os) || b[1].major - a[1].major);
  const gaps = verList.filter(([, s]) => s.inPool > 0 && s.runs.total === 0 && s.major > 0);
  const newest = (os: string) => verList.filter(([, s]) => s.os === os && s.inPool > 0 && s.major > 0)[0];
  const newestGaps = ['Android', 'iOS'].map(newest).filter((x): x is NonNullable<typeof x> => !!x && x[1].runs.total === 0);
  const coveredVersions = verList.filter(([, s]) => s.inPool > 0 && s.major > 0 && s.runs.total > 0).length;
  const poolVersions = verList.filter(([, s]) => s.inPool > 0 && s.major > 0).length;

  // Models, joined through the device.
  const models = new Map<string, { os: string; inPool: number; tested: number; runs: StatusCounts }>();
  for (const d of pool) {
    const k = d.model || '(model not recorded)';
    const m = models.get(k) ?? { os: platform(d.os), inPool: 0, tested: 0, runs: emptyCounts() };
    m.inPool++;
    const c = counts(d);
    if (c?.total) { m.tested++; m.runs = addCounts(m.runs, c); }
    models.set(k, m);
  }
  const modelList = [...models].sort((a, b) => b[1].runs.total - a[1].runs.total || b[1].inPool - a[1].inPool);
  const modelGaps = modelList.filter(([, m]) => m.tested === 0);

  const scope = i.projectName ? `project ${i.projectName}` : 'the access key\'s own project';
  const highlights = [
    `Tests of ${scope} ran on ${n(tested.length)} of ${plural(pool.length, 'device')} in the ${window} (${plural(deviceRuns, 'run')} on devices${noDevice ? `, ${n(noDevice)} more with no device` : ''}).`,
    ...(idle.length ? [`${plural(idle.length, 'device')} that ${idle.length === 1 ? 'is' : 'are'} online had no run.`] : []),
    ...(gaps.length ? [`${plural(gaps.length, 'OS version')} in the pool had no run: ${gaps.slice(0, 4).map(([k, s]) => `${k} (${plural(s.inPool, 'device')})`).join(', ')}${gaps.length > 4 ? ', …' : ''}.`] : []),
    ...(used.length > 5 ? [`The five most used devices carried ${share(top5, deviceRuns)}% of the runs on devices.`] : []),
  ];

  const sections: Section[] = [
    { title: 'At a Glance', blocks: [{ type: 'kpis', items: [
      { value: n(pool.length), label: 'Devices in the pool' }, { value: n(tested.length), label: `With a run, ${window}`, accent: 'teal' },
      { value: n(idle.length), label: 'Online, no run', accent: 'fail' }, { value: `${coveredVersions} of ${poolVersions}`, label: 'OS versions with a run' }] }] },
  ];
  if (!pool.length) {
    sections.push({ title: 'Pool', blocks: [{ type: 'callout', tone: 'note', title: 'No device', text: 'This access key sees no device.' }] });
  } else {
    const byOs = ['Android', 'iOS'].filter((os) => pool.some((d) => platform(d.os) === os));
    sections.push({ title: 'Coverage of the Pool', columns: 2, blocks: [
      { type: 'share', label: 'Devices', parts: [
        { label: 'Had a run', value: tested.length, tone: 'pass' as const }, { label: 'Online, no run', value: idle.length, tone: 'warn' as const },
        { label: 'Offline or in error, no run', value: untested.length - idle.length, tone: 'skip' as const }].filter((p) => p.value > 0) },
      { type: 'bar', title: 'By platform', stacked: true, orientation: 'horizontal', categories: byOs, series: [
        { name: 'Had a run', values: byOs.map((os) => tested.filter((d) => platform(d.os) === os).length), tone: 'pass' },
        { name: 'No run', values: byOs.map((os) => untested.filter((d) => platform(d.os) === os).length), tone: 'skip' }] }],
      whatItMeans: `${share(tested.length, pool.length)}% of the pool ran at least one test of ${scope}.` +
        (used.length > 5 ? ` The runs are ${share(top5, deviceRuns) >= 50 ? 'concentrated' : 'spread'}: the five most used devices carried ${share(top5, deviceRuns)}% of them` +
          `${share(top5, deviceRuns) >= 50 ? ', so a problem on one of those devices moves the pass rate and the rest of the pool adds little coverage' : ''}.` : '') +
        (elsewhere.length ? ` ${plural(elsewhereRuns, 'run')} were on ${plural(elsewhere.length, 'device')} that ${elsewhere.length === 1 ? 'is' : 'are'} not in today's pool (emulators, simulators or devices since removed).` : '') });
    const verRows = verList.filter(([, s]) => s.inPool > 0 || s.runs.total > 0);
    sections.push({ title: 'Runs by OS Version', blocks: [
      { type: 'bar', orientation: 'horizontal', categories: verRows.slice(0, 20).map(([k]) => k), series: [{ name: 'Runs', values: verRows.slice(0, 20).map(([, s]) => s.runs.total) }] },
      { type: 'table', maxRows: 60, columns: [{ key: 'version', label: 'OS version' }, { key: 'pool', label: 'Devices in pool', format: 'number' }, { key: 'tested', label: 'Devices with a run', format: 'number' },
        { key: 'runs', label: 'Runs', format: 'number' }, { key: 'rate', label: 'Pass rate' }],
      rows: verRows.slice(0, 60).map(([k, s]) => ({ version: k, pool: s.inPool, tested: s.tested, runs: s.runs.total, rate: verdicts(s.runs) ? pct1(passRate(s.runs)) : '' })) }],
      whatItMeans: (gaps.length ? `${plural(gaps.length, 'OS version')} that the pool has ${gaps.length === 1 ? 'was' : 'were'} not tested: ${gaps.slice(0, 6).map(([k]) => k).join(', ')}${gaps.length > 6 ? ', …' : ''}.` : 'Every OS version in the pool had at least one run.') +
        (newestGaps.length ? ` That includes the newest ${newestGaps.map(([k]) => k).join(' and ')} in the pool, the version users move to next.` : '') +
        (() => {
          const ranked = verRows.filter(([, s]) => verdicts(s.runs) >= MIN_VERDICTS_TO_RANK).sort((a, b) => (passRate(a[1].runs) ?? 0) - (passRate(b[1].runs) ?? 0));
          return ranked.length > 1 ? ` Pass rate runs from ${pct1(passRate(ranked[0][1].runs))} on ${ranked[0][0]} (${n(verdicts(ranked[0][1].runs))} verdicts) to ${pct1(passRate(ranked[ranked.length - 1][1].runs))} on ${ranked[ranked.length - 1][0]}.` : '';
        })() +
        (() => { const single = verRows.filter(([, s]) => s.runs.total > 0 && s.tested === 1 && s.inPool > 1); return single.length ? ` ${plural(single.length, 'version')} ran on one device only although the pool has more (${single.slice(0, 3).map(([k]) => k).join(', ')}).` : ''; })() });
    sections.push({ title: 'Device Models', blocks: [{ type: 'table', maxRows: 200, columns: [{ key: 'model', label: 'Model' }, { key: 'os', label: 'Platform' }, { key: 'pool', label: 'Devices in pool', format: 'number' },
      { key: 'tested', label: 'Devices with a run', format: 'number' }, { key: 'runs', label: 'Runs', format: 'number' }, { key: 'rate', label: 'Pass rate' }],
    rows: modelList.slice(0, 200).map(([k, m]) => ({ model: k, os: m.os, pool: m.inPool, tested: m.tested, runs: m.runs.total, rate: verdicts(m.runs) ? pct1(passRate(m.runs)) : '' })) }],
      whatItMeans: `${n(modelList.length - modelGaps.length)} of ${plural(modelList.length, 'model')} in the pool had a run; ${modelGaps.length ? `${n(modelGaps.length)} had none` : 'none was left out'}.` +
        (modelList[0] && modelList[0][1].runs.total ? ` ${modelList[0][0]} carried the most runs (${n(modelList[0][1].runs.total)}, ${share(modelList[0][1].runs.total, deviceRuns)}%).` : '') });
    if (used.length) sections.push({ title: 'Most Used Devices', blocks: [{ type: 'table', maxRows: 15, columns: [{ key: 'device', label: 'Device' }, { key: 'model', label: 'Model' }, { key: 'version', label: 'OS version' },
      { key: 'runs', label: 'Runs', format: 'number' }, { key: 'share', label: 'Share', format: 'percent', decimals: 1 }, { key: 'rate', label: 'Pass rate' }],
    rows: used.slice(0, 15).map((d) => ({ device: d.name, model: d.model, version: verKey(d.os, d.osVersion), runs: counts(d)!.total, share: Math.round((counts(d)!.total / Math.max(deviceRuns, 1)) * 1000) / 10, rate: pct1(passRate(counts(d)!)) })) }] });
    if (untested.length) {
      const list = [...idle, ...untested.filter((d) => !isAvailable(d))];
      sections.push({ title: 'Devices with No Run', blocks: [{ type: 'table', maxRows: 300, columns: [{ key: 'device', label: 'Device' }, { key: 'model', label: 'Model' }, { key: 'version', label: 'OS version' },
        { key: 'status', label: 'Status', format: 'status' }, { key: 'region', label: 'Region' }],
      rows: list.slice(0, 300).map((d) => ({ device: d.name, model: d.model, version: verKey(d.os, d.osVersion), status: d.status, region: d.region })) }],
        whatItMeans: `${plural(untested.length, 'device')} had no run of ${scope} in the ${window}: ${n(idle.length)} online, ${n(untested.length - idle.length)} offline or in error. ` +
          'A device with no run here may still be used by another project or for manual testing; the device utilization report (reserved hours per device) answers that for the whole lab.' });
    }
  }
  return {
    highlights,
    spec: {
      title: 'Device Coverage',
      subtitle: `What the tests of the ${window} ran on, against the pool`,
      meta: rangeMeta(i.from, i.to, i.projectName),
      headline: pool.length ? { value: `${share(tested.length, pool.length)}%`, label: 'Of the pool had a run' } : undefined,
      sections,
      source: `Source: Digital.ai Testing reporter, the platform's own counts by device and by OS version for ${scope}, ${longDate(i.from)} to ${longDate(i.to)} (nothing is sampled or cut off), ` +
        `joined by serial number with the device list of ${longDate(i.to)}: every device this access key can see, whatever project uses it. OS versions are grouped by major version.`,
    },
  };
}

// ── Device utilization: reserved hours per device against the hours the pool had ───────────────────────────────────

/**
 * How much of the pool is used. `usage` is the platform's Devices Usage report (reserved hours per device and project,
 * every kind of use: automated, manual, API), joined by device id with today's device list. Utilization = reserved
 * hours / (24 h x days), so a device used through every working day sits near 33%.
 */
export function buildDeviceUtilization(i: { usage: DeviceUsageRow[]; devices: PoolDevice[]; from: number; to: number; days: number; projectName?: string }): RecipeResult {
  const n = (x: number) => x.toLocaleString('en-US');
  const h = (x: number) => (x >= 100 ? n(Math.round(x)) : (Math.round(x * 10) / 10).toLocaleString('en-US'));
  const window = `last ${plural(i.days, 'day')}`;
  const perDevice = new Map<string, { hours: number; projects: Set<string>; name: string; os: string; osVersion: string }>();
  for (const r of i.usage) {
    const k = r.deviceId || `name:${r.device}`;
    const d = perDevice.get(k) ?? { hours: 0, projects: new Set<string>(), name: r.device, os: r.os, osVersion: r.osVersion };
    d.hours += r.hours;
    if (r.hours > 0 && r.project) d.projects.add(r.project);
    perDevice.set(k, d);
  }
  const keyOf = (d: PoolDevice) => (d.id && perDevice.has(String(d.id)) ? String(d.id) : `name:${d.name}`);
  const hoursOf = (d: PoolDevice) => perDevice.get(keyOf(d))?.hours ?? 0;
  const pool = i.devices;
  const poolKeys = new Set(pool.map(keyOf));
  const gone = [...perDevice].filter(([k, v]) => !poolKeys.has(k) && v.hours > 0);
  const goneHours = gone.reduce((s, [, v]) => s + v.hours, 0);
  const total = [...perDevice.values()].reduce((s, v) => s + v.hours, 0);
  const poolHours = pool.reduce((s, d) => s + hoursOf(d), 0);
  const capacity = pool.length * i.days * 24;
  const pct = (v: number, of: number) => (of > 0 ? Math.round((v / of) * 1000) / 10 : 0);
  const perDay = (hours: number, devices = 1) => hours / Math.max(devices, 1) / i.days;
  const used = pool.filter((d) => hoursOf(d) > 0).sort((a, b) => hoursOf(b) - hoursOf(a));
  const unused = pool.filter((d) => hoursOf(d) === 0);
  const online = (d: PoolDevice) => /^(available|in use|reserved)$/i.test(d.status);
  const unusedOnline = unused.filter(online);
  const platform = (os: string | null | undefined) => groupValue('device.os', os ?? null);
  const major = (v: string | null | undefined) => /^\d+/.exec(String(v ?? '').trim())?.[0] ?? '';
  const version = (d: PoolDevice) => (major(d.osVersion) ? `${platform(d.os)} ${major(d.osVersion)}` : platform(d.os));

  const bands: Array<[string, (perDayHours: number) => boolean]> = [
    ['Not reserved', (x) => x === 0], ['Under 1 h a day', (x) => x > 0 && x < 1], ['1 to 4 h a day', (x) => x >= 1 && x < 4],
    ['4 to 12 h a day', (x) => x >= 4 && x < 12], ['Over 12 h a day', (x) => x >= 12]];
  const bandCounts = bands.map(([, test]) => pool.filter((d) => test(perDay(hoursOf(d)))).length);
  const busy = pool.filter((d) => perDay(hoursOf(d)) >= 12);
  const light = pool.filter((d) => { const x = perDay(hoursOf(d)); return x > 0 && x < 1; });

  const group = (key: (d: PoolDevice) => string) => {
    const m = new Map<string, { devices: number; hours: number; unused: number; os: string }>();
    for (const d of pool) {
      const g = m.get(key(d)) ?? { devices: 0, hours: 0, unused: 0, os: platform(d.os) };
      g.devices++; g.hours += hoursOf(d); if (hoursOf(d) === 0) g.unused++;
      m.set(key(d), g);
    }
    return [...m];
  };
  const models = group((d) => d.model || '(model not recorded)').sort((a, b) => perDay(b[1].hours, b[1].devices) - perDay(a[1].hours, a[1].devices));
  const regions = group((d) => d.region || '(not recorded)').sort((a, b) => b[1].devices - a[1].devices);
  const versions = group(version).sort((a, b) => perDay(b[1].hours, b[1].devices) - perDay(a[1].hours, a[1].devices));
  const surplus = models.filter(([, g]) => g.devices >= 2 && g.unused === g.devices);
  const topModel = models[0] && models[0][1].hours > 0 ? models[0] : null;
  const top10 = used.slice(0, Math.max(1, Math.round(pool.length / 10))).reduce((s, d) => s + hoursOf(d), 0);
  const scope = i.projectName ? `project ${i.projectName}` : 'every project';

  const highlights = [
    `${h(total)} reserved device hours in the ${window} (${scope}): ${pct(poolHours, capacity)}% of the hours the pool of ${plural(pool.length, 'device')} had.`,
    ...(unused.length ? [`${plural(unused.length, 'device')} ${unused.length === 1 ? 'was' : 'were'} not reserved once${unusedOnline.length ? `; ${n(unusedOnline.length)} of them ${unusedOnline.length === 1 ? 'is' : 'are'} online` : ''}.`] : []),
    ...(used.length >= 10 ? [`The most used tenth of the pool (${plural(Math.max(1, Math.round(pool.length / 10)), 'device')}) took ${pct(top10, poolHours)}% of the hours.`] : []),
    ...(topModel ? [`Highest demand per device: ${topModel[0]} at ${h(perDay(topModel[1].hours, topModel[1].devices))} h a day over ${plural(topModel[1].devices, 'device')}.`] : []),
    ...(busy.length ? [`${plural(busy.length, 'device')} ${busy.length === 1 ? 'is' : 'are'} reserved more than 12 h a day.`] : []),
  ];

  const sections: Section[] = [
    { title: 'At a Glance', blocks: [{ type: 'kpis', items: [
      { value: h(total), label: `Reserved hours, ${window}` }, { value: `${pct(poolHours, capacity)}%`, label: 'Of the pool\'s hours', accent: 'teal' },
      { value: n(used.length), label: `Devices reserved, of ${n(pool.length)}` }, { value: n(unused.length), label: 'Not reserved once', accent: 'fail' }] }] },
  ];
  if (!pool.length) {
    sections.push({ title: 'Pool', blocks: [{ type: 'callout', tone: 'note', title: 'No device', text: 'This access key sees no device.' }] });
  } else {
    sections.push({ title: 'How Much Each Device Is Used', blocks: [{ type: 'bar', orientation: 'horizontal', showShare: true, shareTotal: pool.length, categories: bands.map(([label]) => label),
      series: [{ name: 'Devices', values: bandCounts }] }],
      whatItMeans: `${pct(unused.length + light.length, pool.length)}% of the pool was reserved for less than an hour a day or not at all` +
        (busy.length ? `, while ${plural(busy.length, 'device')} ${busy.length === 1 ? 'was' : 'were'} reserved more than 12 hours a day: demand is uneven, and tests waiting for those devices could run on idle ones of the same kind.`
          : '. No device is reserved more than 12 hours a day, so the pool has room for more work at its present size.') });
    sections.push({ title: 'Demand by Model', blocks: [{ type: 'table', maxRows: 200, columns: [{ key: 'model', label: 'Model' }, { key: 'os', label: 'Platform' }, { key: 'devices', label: 'Devices', format: 'number' },
      { key: 'hours', label: 'Reserved hours', format: 'number', decimals: 1 }, { key: 'perDay', label: 'Hours per device per day', format: 'number', decimals: 1 }, { key: 'unused', label: 'Not reserved', format: 'number' }],
    rows: models.slice(0, 200).map(([k, g]) => ({ model: k, os: g.os, devices: g.devices, hours: Math.round(g.hours * 10) / 10, perDay: Math.round(perDay(g.hours, g.devices) * 10) / 10, unused: g.unused })) }],
      whatItMeans: (topModel ? `${topModel[0]} is the most used model per device (${h(perDay(topModel[1].hours, topModel[1].devices))} h a day each).` : 'No model was reserved.') +
        (surplus.length ? ` ${plural(surplus.length, 'model')} with two or more devices ${surplus.length === 1 ? 'was' : 'were'} not reserved at all (${surplus.slice(0, 4).map(([k, g]) => `${k}, ${g.devices} devices`).join('; ')}${surplus.length > 4 ? '; …' : ''}): candidates to retire or to swap for models in demand.` : '') });
    if (versions.length > 1) sections.push({ title: 'Demand by OS Version', blocks: [{ type: 'bar', orientation: 'horizontal', unit: 'h', decimals: 1, categories: versions.slice(0, 20).map(([k, g]) => `${k} (${g.devices})`),
      series: [{ name: 'Hours per device per day', values: versions.slice(0, 20).map(([, g]) => Math.round(perDay(g.hours, g.devices) * 10) / 10) }] }],
      whatItMeans: `Hours per device per day, with the number of devices in brackets. ${versions[0][0]} is used the most per device; ` +
        `${versions[versions.length - 1][0]} the least (${h(perDay(versions[versions.length - 1][1].hours, versions[versions.length - 1][1].devices))} h a day).` });
    if (regions.length > 1) sections.push({ title: 'Use by Region', blocks: [{ type: 'table', columns: [{ key: 'region', label: 'Region' }, { key: 'devices', label: 'Devices', format: 'number' },
      { key: 'hours', label: 'Reserved hours', format: 'number', decimals: 1 }, { key: 'perDay', label: 'Hours per device per day', format: 'number', decimals: 1 }, { key: 'unused', label: 'Not reserved', format: 'number' }],
    rows: regions.map(([k, g]) => ({ region: k, devices: g.devices, hours: Math.round(g.hours * 10) / 10, perDay: Math.round(perDay(g.hours, g.devices) * 10) / 10, unused: g.unused })) }],
      whatItMeans: (() => {
        const ranked = [...regions].filter(([, g]) => g.devices >= 3).sort((a, b) => perDay(b[1].hours, b[1].devices) - perDay(a[1].hours, a[1].devices));
        return ranked.length > 1 ? `${ranked[0][0]} is the busiest region per device (${h(perDay(ranked[0][1].hours, ranked[0][1].devices))} h a day), ${ranked[ranked.length - 1][0]} the quietest (${h(perDay(ranked[ranked.length - 1][1].hours, ranked[ranked.length - 1][1].devices))} h a day).` : 'One region holds nearly all devices.';
      })() });
    if (used.length) sections.push({ title: 'Most Used Devices', blocks: [{ type: 'table', maxRows: 20, columns: [{ key: 'device', label: 'Device' }, { key: 'model', label: 'Model' }, { key: 'version', label: 'OS version' }, { key: 'region', label: 'Region' },
      { key: 'hours', label: 'Reserved hours', format: 'number', decimals: 1 }, { key: 'util', label: 'Utilization', format: 'percent', decimals: 1 }, { key: 'projects', label: 'Projects', format: 'number' }],
    rows: used.slice(0, 20).map((d) => ({ device: d.name, model: d.model, version: version(d), region: d.region, hours: Math.round(hoursOf(d) * 10) / 10, util: pct(hoursOf(d), i.days * 24), projects: perDevice.get(keyOf(d))?.projects.size ?? 0 })) }],
      whatItMeans: `Utilization is reserved hours against all ${n(i.days * 24)} hours of the range; a device used through every working day sits near 33%.` });
    if (unused.length) {
      const list = [...unusedOnline, ...unused.filter((d) => !online(d))];
      sections.push({ title: 'Devices Not Reserved', blocks: [{ type: 'table', maxRows: 300, columns: [{ key: 'device', label: 'Device' }, { key: 'model', label: 'Model' }, { key: 'version', label: 'OS version' },
        { key: 'status', label: 'Status', format: 'status' }, { key: 'region', label: 'Region' }],
      rows: list.slice(0, 300).map((d) => ({ device: d.name, model: d.model, version: version(d), status: d.status, region: d.region })) }],
        whatItMeans: `${plural(unused.length, 'device')} had no reservation by ${scope} in the ${window}: ${n(unusedOnline.length)} online and ready, ${n(unused.length - unusedOnline.length)} offline or in error. ` +
          'An online device nobody reserves is spare capacity, or a device nobody knows about: check its project assignment and tags before retiring it.' });
    }
  }
  return {
    highlights,
    spec: {
      title: 'Device Utilization',
      subtitle: `Reserved hours per device, ${window}`,
      meta: rangeMeta(i.from, i.to, i.projectName, true),
      headline: pool.length ? { value: `${pct(poolHours, capacity)}%`, label: 'Of the pool\'s hours reserved' } : undefined,
      sections,
      source: `Source: Digital.ai Testing "Devices Usage" usage report for ${scope}, ${longDate(i.from, true)} to ${longDate(i.to, true)} (UTC), joined by device id with the device list of ${longDate(i.to, true)}. ` +
        'Hours are reservation time of every kind (automated, manual, API). Utilization = reserved hours / (24 hours x days x devices); a device added or removed during the range is counted for the whole range.' +
        (gone.length ? ` ${h(goneHours)} more hours were on ${plural(gone.length, 'device')} no longer in the device list.` : ''),
    },
  };
}

// ── License usage: peak concurrent sessions per license type against the licensed number ───────────────────────────

export interface LicenseSession { start: number; end: number; sessionType: string; licenseType: string; project: string }
export interface LicenseLimits { dedicatedDevices?: number; sharedDevices?: number; virtualDevices?: number; browsers?: number }

/** The most sessions open at the same moment, and when. Ends are counted before starts at the same millisecond. */
export function peakConcurrency(sessions: Array<{ start: number; end: number }>): { peak: number; at: number | null } {
  const events: Array<[number, number]> = [];
  for (const s of sessions) { if (!(s.end > s.start)) continue; events.push([s.start, 1], [s.end, -1]); }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0, peak = 0, at: number | null = null;
  for (const [t, d] of events) { open += d; if (open > peak) { peak = open; at = t; } }
  return { peak, at };
}

/**
 * License use from the platform's License Usage report (one row per session, with its start and end): the peak number of
 * sessions open at once per license type against the licensed number, peaks per day, the mix of session types and the
 * busiest hours. Peaks are exact for the range: they are computed from every session, not sampled.
 */
export function buildLicenseUsage(i: { sessions: LicenseSession[]; limits: LicenseLimits | null; from: number; to: number; days: number }): RecipeResult {
  const n = (x: number) => x.toLocaleString('en-US');
  const h = (x: number) => (x >= 100 ? n(Math.round(x)) : (Math.round(x * 10) / 10).toLocaleString('en-US'));
  const window = `last ${plural(i.days, 'day')}`;
  const hours = (list: LicenseSession[]) => list.reduce((s, x) => s + Math.max(0, x.end - x.start) / 3_600_000, 0);
  const group = (key: (s: LicenseSession) => string) => {
    const m = new Map<string, LicenseSession[]>();
    for (const s of i.sessions) { const k = key(s) || '(not recorded)'; const g = m.get(k); if (g) g.push(s); else m.set(k, [s]); }
    return [...m].sort((a, b) => hours(b[1]) - hours(a[1]));
  };
  const limitOf = (type: string): number | null => {
    const l = i.limits; if (!l) return null;
    const v = /dedicated/i.test(type) ? l.dedicatedDevices : /shared/i.test(type) ? l.sharedDevices : /virtual/i.test(type) ? l.virtualDevices : /browser/i.test(type) ? l.browsers : undefined;
    return v != null && v > 0 ? v : null;
  };
  const when = (t: number | null) => { if (t == null) return ''; const d = new Date(t); return `${longDate(t, true)} at ${String(d.getUTCHours()).padStart(2, '0')}:00 UTC`; };
  const types = group((s) => s.licenseType).map(([type, list]) => {
    const { peak, at } = peakConcurrency(list);
    const limit = limitOf(type);
    return { type, list, sessions: list.length, hours: hours(list), peak, at, limit, share: limit ? Math.round((peak / limit) * 100) : null };
  });
  const total = hours(i.sessions);
  const kinds = group((s) => s.sessionType).map(([kind, list]) => ({ kind, sessions: list.length, hours: hours(list) }));
  const projects = group((s) => s.project).map(([project, list]) => ({ project, sessions: list.length, hours: hours(list), peak: peakConcurrency(list).peak }));

  // Peak per UTC day and license type: one sweep per type, the running count carried over midnight.
  const dayKeys: number[] = [];
  for (let t = dayStart(i.from, true); t <= i.to; t = addDays(t, 1, true)) dayKeys.push(t);
  const dayPeaks = types.map((ty) => {
    const events: Array<[number, number]> = [];
    for (const s of ty.list) { if (s.end > s.start) events.push([s.start, 1], [s.end, -1]); }
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const peaks = new Map<number, number>();
    let open = 0;
    for (const [t, d] of events) { open += d; const k = dayStart(t, true); if (open > (peaks.get(k) ?? 0)) peaks.set(k, open); }
    return dayKeys.map((k) => peaks.get(k) ?? 0);
  });
  // Session hours by the hour of day (UTC) in which the session started.
  const byHour = Array.from({ length: 24 }, () => 0);
  for (const s of i.sessions) byHour[new Date(s.start).getUTCHours()] += Math.max(0, s.end - s.start) / 3_600_000;
  const busiest = byHour.indexOf(Math.max(...byHour));
  const quietHours = byHour.filter((v) => v < (Math.max(...byHour) || 1) * 0.1).length;
  const near = types.filter((t) => t.share != null && t.share >= 90);
  const kindShare = (k: { hours: number }) => Math.round((k.hours / Math.max(total, 1e-9)) * 100);
  /** 1 of 1,000 is "under 1%", never "0%". */
  const pctText = (v: number, of: number) => (v > 0 && v / Math.max(of, 1e-9) < 0.01 ? 'under 1%' : `${Math.round((v / Math.max(of, 1e-9)) * 100)}%`);

  const highlights = [
    `${plural(i.sessions.length, 'session')} and ${h(total)} license hours in the ${window} (UTC).`,
    ...types.slice(0, 4).map((t) => `${t.type}: peak of ${plural(t.peak, 'session')} at once${t.limit ? ` of ${n(t.limit)} licensed (${pctText(t.peak, t.limit)})` : ''}${t.at != null ? `, ${when(t.at)}` : ''}.`),
    ...(kinds.length > 1 ? [`By hours: ${kinds.slice(0, 4).map((k) => `${k.kind} ${pctText(k.hours, total)}`).join(', ')}.`] : []),
  ];

  const sections: Section[] = [
    { title: 'At a Glance', blocks: [{ type: 'kpis', items: [
      { value: n(i.sessions.length), label: `Sessions, ${window}` }, { value: h(total), label: 'License hours', accent: 'teal' },
      ...types.slice(0, 3).map((t) => ({ value: t.limit ? `${n(t.peak)} of ${n(t.limit)}` : n(t.peak), label: `Peak, ${t.type}`, ...(t.share != null && t.share >= 90 ? { accent: 'fail' as const } : {}) }))] }] },
  ];
  if (!i.sessions.length) {
    sections.push({ title: 'Sessions', blocks: [{ type: 'callout', tone: 'note', title: 'No session', text: `The License Usage report holds no session between ${longDate(i.from, true)} and ${longDate(i.to, true)} (UTC).` }] });
  } else {
    sections.push({ title: 'Peak Use Against the License', blocks: [
      ...types.filter((t) => t.limit).map((t) => ({ type: 'meter' as const, label: t.type, value: t.peak, max: t.limit!, warnAt: 75, failAt: 90 })),
      { type: 'table', columns: [{ key: 'type', label: 'License type' }, { key: 'sessions', label: 'Sessions', format: 'number' }, { key: 'hours', label: 'Hours', format: 'number', decimals: 1 },
        { key: 'peak', label: 'Peak at once', format: 'number' }, { key: 'limit', label: 'Licensed', format: 'number' }, { key: 'share', label: 'Peak of license', format: 'percent', decimals: 0 }, { key: 'at', label: 'When' }],
      rows: types.map((t) => ({ type: t.type, sessions: t.sessions, hours: Math.round(t.hours * 10) / 10, peak: t.peak, limit: t.limit, share: t.share, at: when(t.at) })) }],
      whatItMeans: (near.length ? `${near.map((t) => t.type).join(' and ')} reached ${near.map((t) => `${t.share}%`).join(' and ')} of the licensed number: at that moment a further session had to wait or was refused. `
        : types.some((t) => t.limit) ? `No license type came near its limit: the highest peak was ${Math.max(...types.map((t) => t.share ?? 0))}% of the licensed number. ` : 'The licensed numbers could not be read, so the peaks stand without a limit beside them. ') +
        'A peak is the most sessions open at the same moment, computed from every session\'s start and end; the average is far lower, so capacity is a question of the peak hours, not of total hours.' });
    if (dayKeys.length > 1) sections.push({ title: 'Peak Sessions per Day', blocks: [{ type: 'line', categories: dayKeys.map((k) => shortDay(k, true)), series: types.slice(0, 4).map((t, k) => ({ name: t.type, values: dayPeaks[k] })) }],
      whatItMeans: (() => {
        const t0 = types[0]; const peaks = dayPeaks[0]; const top = Math.max(...peaks), low = Math.min(...peaks.filter((_, k) => dayKeys[k] + DAY <= i.to || peaks.length === 1));
        return `${t0.type} peaked at ${n(top)} on its busiest day and ${n(Number.isFinite(low) ? low : 0)} on its quietest full day (UTC days).` +
          (top >= 2 * Math.max(1, Number.isFinite(low) ? low : 0) ? ' The gap is wide: the load comes in bursts, and spreading scheduled runs would lower the peak without buying licenses.' : ' The load is steady from day to day.');
      })() });
    if (kinds.length > 1) sections.push({ title: 'What the Licenses Are Used For', blocks: [{ type: 'share', unit: 'hrs', decimals: 1, parts: kinds.slice(0, 8).map((k) => ({ label: k.kind, value: Math.round(k.hours * 10) / 10 })) },
      { type: 'table', columns: [{ key: 'kind', label: 'Session type' }, { key: 'sessions', label: 'Sessions', format: 'number' }, { key: 'hours', label: 'Hours', format: 'number', decimals: 1 }, { key: 'avg', label: 'Minutes per session', format: 'number', decimals: 1 }],
        rows: kinds.map((k) => ({ kind: k.kind, sessions: k.sessions, hours: Math.round(k.hours * 10) / 10, avg: Math.round((k.hours * 60 / Math.max(k.sessions, 1)) * 10) / 10 })) }],
      whatItMeans: `${kinds[0].kind} takes ${kindShare(kinds[0])}% of the license hours` + (kinds[1] ? `, ${kinds[1].kind} ${kindShare(kinds[1])}%` : '') + '. ' +
        'Session types are the platform\'s own: executions are automated runs, manual testing and development are people holding a device.' });
    sections.push({ title: 'Busiest Hours of the Day', blocks: [{ type: 'bar', unit: 'hrs', decimals: 1, categories: byHour.map((_, k) => String(k).padStart(2, '0')), series: [{ name: 'Session hours', values: byHour.map((v) => Math.round(v * 10) / 10) }] }],
      whatItMeans: `Session hours by the hour in which the session started (UTC). The busiest hour is ${String(busiest).padStart(2, '0')}:00 UTC.` +
        (quietHours >= 6 ? ` ${quietHours} hours of the day carry less than a tenth of that: scheduled runs moved there would meet a free lab.` : ' Use is spread around the clock.') });
    if (projects.length > 1) sections.push({ title: 'By Project', blocks: [{ type: 'table', maxRows: 50, columns: [{ key: 'project', label: 'Project' }, { key: 'sessions', label: 'Sessions', format: 'number' },
      { key: 'hours', label: 'Hours', format: 'number', decimals: 1 }, { key: 'share', label: 'Share of hours', format: 'percent', decimals: 1 }, { key: 'peak', label: 'Peak at once', format: 'number' }],
    rows: projects.slice(0, 50).map((p) => ({ project: p.project, sessions: p.sessions, hours: Math.round(p.hours * 10) / 10, share: Math.round((p.hours / Math.max(total, 1e-9)) * 1000) / 10, peak: p.peak })) }],
      whatItMeans: `${projects[0].project} uses ${Math.round((projects[0].hours / Math.max(total, 1e-9)) * 100)}% of the license hours and peaks at ${plural(projects[0].peak, 'session')} at once. Project peaks do not add up to the total: they happen at different moments.` });
  }
  return {
    highlights,
    spec: {
      title: 'License Usage',
      subtitle: `Peak concurrent sessions against the license, ${window}`,
      meta: rangeMeta(i.from, i.to, undefined, true),
      headline: types[0] ? { value: types[0].limit ? `${n(types[0].peak)} of ${n(types[0].limit)}` : n(types[0].peak), label: `Peak sessions at once, ${types[0].type}` } : undefined,
      sections,
      source: `Source: Digital.ai Testing "License Usage" usage report, ${plural(i.sessions.length, 'session')} of every project from ${longDate(i.from, true)} to ${longDate(i.to, true)} (UTC)` +
        `${i.limits ? ', and the license record for the licensed numbers' : ''}. Peak = the most sessions open at the same moment, from each session's start and end time. ` +
        'A session that began before the range or ended after it is counted with the times the report gives.',
    },
  };
}
