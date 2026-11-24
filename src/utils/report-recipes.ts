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
export function classificationMeans(failures: number, classified: number, infra: number, groups: Array<[string, number]>): string {
  if (!classified) return 'The platform did not classify these failures, so they cannot be split into lab and test or app problems.';
  const unclassifiedShare = 1 - classified / failures;
  const infraShare = infra / classified;
  const lead = unclassifiedShare >= 0.5
    ? `The platform left ${Math.round(unclassifiedShare * 100)}% of failures unclassified, so read the rest with care. Of the classified ones, `
    : `${groups[0][0]} is the largest group (${Math.round((groups[0][1] / failures) * 100)}%). Of the classified failures, `;
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
    .replace(/(?:[\s_#-]+\d+)+\s*$/g, '')
    .replace(/\s+/g, ' ')
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

  const kpis: Block = {
    type: 'kpis', items: [
      { value: c.total.toLocaleString('en-US'), label: 'Tests executed', ...(i.previous ? { delta: `${c.total >= i.previous.length ? '▲' : '▼'} ${Math.abs(c.total - i.previous.length).toLocaleString('en-US')} vs. previous ${i.days} days`, deltaGood: true } : {}) },
      { value: pct1(rate), label: 'Pass rate', ...(delta != null ? { delta: `${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(1)} points vs. previous ${i.days} days`, deltaGood: delta >= 0 } : {}) },
      { value: failures.toLocaleString('en-US'), label: 'Failed or error', accent: 'fail' as const, ...(prevFailures != null ? { delta: `${failures <= prevFailures ? '▼' : '▲'} ${Math.abs(failures - prevFailures).toLocaleString('en-US')} vs. previous ${i.days} days`, deltaGood: failures <= prevFailures } : {}) },
      { value: tests.toLocaleString('en-US'), label: 'Distinct tests', accent: 'teal' as const },
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
  const volumeMeans =
    `About ${Math.round(avg).toLocaleString('en-US')} runs per ${unit}; the busiest ${unit} was ${cats[busiest]} with ${totals[busiest].toLocaleString('en-US')}.` +
    (idle ? ` ${plural(idle, unit)} had no runs at all.` : '') +
    (Math.abs(volumeTrend) >= 0.2 ? ` Volume in the second half of the range is ${Math.abs(Math.round(volumeTrend * 100))}% ${volumeTrend > 0 ? 'higher' : 'lower'} than in the first half.` : '');

  // Pass rate per bucket.
  const rates = keys.map((_, n) => (passed[n] + failed[n] > 0 ? Math.round((passed[n] / (passed[n] + failed[n])) * 1000) / 10 : null));
  const valid = rates.map((v, n) => [v, n] as const).filter(([v]) => v != null) as Array<[number, number]>;
  const worst = valid.reduce<[number, number] | null>((w, x) => (w == null || x[0] < w[0] ? x : w), null);
  const rateMeans = rate == null ? 'No run in this range reached a verdict.' :
    `Pass rate was ${pct1(rate)}${delta != null ? `, ${delta >= 0 ? 'up' : 'down'} ${Math.abs(delta).toFixed(1)} points on the previous ${i.days} days` : ''}.` +
    (worst ? ` The lowest ${unit} was ${cats[worst[1]]} at ${worst[0].toFixed(1)}%.` : '') +
    (i.passRateGoal != null ? ` ${valid.filter(([v]) => v >= i.passRateGoal!).length} of ${valid.length} ${unit}s met the ${i.passRateGoal}% goal.` : '');

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
  const failMeans = !failures ? 'No test failed in this range.' :
    `${plural(byTest.length, 'test')} failed at least once (names that differ only in ids, dates or run numbers count as one). The top five account for ${Math.round(topShare * 100)}% of failures; "${top[0][0]}" failed ${plural(top[0][1], 'time')} in ${plural(runsOf.get(top[0][0]) ?? 0, 'run')}.`;
  if (failures && top[0]) highlights.push(`Most frequent failure: "${top[0][0]}" (${plural(top[0][1], 'failure')}).`);

  // Causes (from the detailed failure scan).
  const det = i.failures;
  const cats2 = countBy(det, (r) => catLabel(r.errorCategory));
  const infra = det.filter((r) => INFRA_CATEGORIES.has((r.errorCategory ?? '').toLowerCase())).length;
  const classified = det.filter((r) => r.errorCategory && r.errorCategory.toLowerCase() !== 'unclassified').length;
  const causeMeans = !det.length ? 'Nothing to classify.' : classificationMeans(det.length, classified, infra, cats2);
  if (classified) highlights.push(`${Math.round((infra / classified) * 100)}% of classified failures point at the lab (device, environment, network, framework).`);

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
        `to that day are not in any figure below. Ask for a shorter window, or a higher limit (maxRecords, up to 25,000).` }] }] : []),
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
        : `Last ${plural(i.days, 'day')}${i.previous ? `, compared with the ${i.days} days before` : ''}`,
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

// ── Failure analysis ────────────────────────────────────────────────────────────────────────────────────────────────

export function buildFailureAnalysis(i: { failures: TestRun[]; totalRuns: number | null; from: number; to: number; days: number; projectName?: string; capped?: boolean }): RecipeResult {
  const fails = i.failures;
  const highlights: string[] = [];
  const devName = (r: TestRun) => r.deviceName ? r.deviceName : r.serial ? r.serial : 'No device (web or other)';
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
  const devMeans = `${byDevice[0][0]} has the most failures (${plural(byDevice[0][1], 'failure')}, ${Math.round(devShare * 100)}% of all).` +
    (devShare > 0.3 && byDevice.length > 3 ? ' One device carrying this share usually means a device problem rather than a test problem; check it before re-running.' : '');
  highlights.push(byDevice[0][0].startsWith('No device')
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
  const catMeans = classificationMeans(fails.length, classifiedN, infra, cats);

  // Causes table.
  const causeKey = (r: TestRun) => (r.cause ?? '').replace(/\s+/g, ' ').trim().slice(0, 140) || '(no cause recorded)';
  const byCause = countBy(fails, causeKey).slice(0, 12);
  const example = (cause: string) => fails.find((r) => causeKey(r) === cause);
  const causeMeans = byCause[0][0] === '(no cause recorded)' && byCause.length === 1 ? 'No failure cause was recorded for these runs.' :
    `The most common cause appears ${plural(byCause[0][1], 'time')}: "${byCause[0][0].slice(0, 100)}". Fixing the top three causes would remove ${Math.round((byCause.slice(0, 3).reduce((s, [, v]) => s + v, 0) / fails.length) * 100)}% of failures.`;

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
          rows: byCause.map(([cause, n]) => ({ cause, n, cat: catLabel(example(cause)?.errorCategory ?? null), test: example(cause)?.name ?? '' })) }], whatItMeans: causeMeans },
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
    const mine = failures.filter((r) => r.serial === g.key);
    const infra = mine.filter((r) => INFRA_CATEGORIES.has((r.errorCategory ?? '').toLowerCase())).length;
    const causes = countBy(mine, (r) => (r.cause ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || '(no cause recorded)');
    return { serial: g.key!, name: mine.find((r) => r.deviceName)?.deviceName ?? g.key!, runs, failures: f, failRatio: runs ? f / runs : 0, infraShare: mine.length ? infra / mine.length : 0, topCause: causes[0]?.[0] ?? '' };
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
  const flaggedSerials = new Set(flagged.map((d) => d.serial));
  const kpis: Block = { type: 'kpis', items: [
    { value: i.devices.length.toLocaleString('en-US'), label: 'Devices' },
    { value: available.toLocaleString('en-US'), label: 'Available' },
    { value: inUse.toLocaleString('en-US'), label: 'In use or reserved', accent: 'teal' },
    { value: offline.toLocaleString('en-US'), label: 'Offline or error', accent: 'fail' },
    ...(health ? [{ value: flagged.length.toLocaleString('en-US'), label: `Failing tests (last ${i.days} days)`, accent: 'fail' as const }] : []),
  ] };
  highlights.push(`${available} of ${i.devices.length} devices available, ${offline} offline or in error.`);
  if (longOffline.length) highlights.push(`${plural(longOffline.length, 'device')} offline for more than a day.`);
  if (flagged.length) highlights.push(`${plural(flagged.length, 'device')} fail far more often than the rest of the pool.`);

  const shareMeans = `${Math.round((available / Math.max(1, i.devices.length)) * 100)}% of the pool is free right now and ${Math.round((offline / Math.max(1, i.devices.length)) * 100)}% is offline or in error.` +
    (longOffline.length ? ` ${plural(longOffline.length, 'device')} ${longOffline.length === 1 ? 'has' : 'have'} been offline for more than 24 hours and still count toward the pool; a device query can route tests to them.` : '');
  const ageText = (m: number | null) => m == null || m < 1 ? '' : m >= 1440 ? `${Math.round(m / 1440)} days` : m >= 60 ? `${Math.round(m / 60)} hours` : `${m} min`;
  const tileStatus = (d: DeviceRow) => flaggedSerials.has(d.serial) && /^available$/i.test(d.status) ? 'Degraded' : d.status || 'Unknown';
  const attention = i.devices.filter((d) => !/^(available|in use|reserved)$/i.test(d.status) || flaggedSerials.has(d.serial));
  const tileSet = i.devices.length <= 60 ? i.devices : attention.slice(0, 60);
  const tilesMeans = !attention.length ? 'Every device is available or in use, and none is failing tests that pass elsewhere.' :
    `${plural(attention.length, 'device')} need${attention.length === 1 ? 's' : ''} attention (shown first).` + (i.devices.length > 60 ? ` Only those are shown; the pool has ${i.devices.length} devices.` : '');

  const byOs = countBy(i.devices, (d) => d.os || 'Unknown');
  const osAvail = byOs.map(([os]) => i.devices.filter((d) => (d.os || 'Unknown') === os && /^available$/i.test(d.status)).length);
  const osOther = byOs.map(([os], k) => byOs[k][1] - osAvail[k] - i.devices.filter((d) => (d.os || 'Unknown') === os && /^(offline|error|unauthorized|disconnected)$/i.test(d.status)).length);
  const osOff = byOs.map(([os]) => i.devices.filter((d) => (d.os || 'Unknown') === os && /^(offline|error|unauthorized|disconnected)$/i.test(d.status)).length);

  const sections: Section[] = [
    { title: 'At a Glance', blocks: [kpis] },
    { title: 'Pool Status', columns: 2, blocks: [
      { type: 'share', label: 'Devices by status', parts: statusCounts.map(([label, value]) => ({ label, value, tone: /^available$/i.test(label) ? 'pass' as const : /^(in use|reserved)$/i.test(label) ? 'info' as const : /^(offline|error|unauthorized|disconnected)$/i.test(label) ? 'fail' as const : 'skip' as const })) },
      { type: 'bar', title: 'By Operating System', orientation: 'horizontal', stacked: true, categories: byOs.map(([k]) => k), series: [
        { name: 'Available', values: osAvail, tone: 'pass' }, { name: 'In use or other', values: osOther, tone: 'info' }, { name: 'Offline or error', values: osOff, tone: 'fail' }] },
    ], whatItMeans: shareMeans },
    { title: 'Devices', blocks: [{ type: 'tiles', items: tileSet.map((d) => ({
      name: d.name || d.serial, status: tileStatus(d),
      detail: [d.model, d.region, /^(offline|error|unauthorized|disconnected)$/i.test(d.status) && ageText(d.statusAgeMin) ? `for ${ageText(d.statusAgeMin)}` : ''].filter(Boolean).join(' · '),
      metric: (() => { const h = health?.stats.find((x) => x.serial === d.serial); return h && h.runs ? `${Math.round((1 - h.failRatio) * 100)}% pass` : undefined; })(),
    })) }], whatItMeans: tilesMeans },
  ];
  if (longOffline.length) {
    sections.push({ title: 'Offline for More Than a Day', blocks: [{ type: 'table', columns: [
      { key: 'name', label: 'Device' }, { key: 'model', label: 'Model' }, { key: 'status', label: 'Status', format: 'status' }, { key: 'age', label: 'For' }, { key: 'agent', label: 'Agent' }, { key: 'region', label: 'Region' }],
    rows: longOffline.slice(0, 25).map((d) => ({ name: d.name || d.serial, model: d.model, status: d.status, age: ageText(d.statusAgeMin), agent: d.agent, region: d.region })) }],
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
export interface DeviceUsageRow { device: string; os: string; osVersion: string; project: string; hours: number }
export interface UserUsageRow { user: string; project: string; hours: number }

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
  const userTab: Section[] = !activeUsers ? [] : [
    { title: `Top Users, Last ${days} Days`, blocks: [{ type: 'bar', orientation: 'horizontal', unit: 'hrs', showShare: true, shareTotal: total(activeUsers),
      categories: topUsers.cats, series: [{ name: 'Hours', values: topUsers.vals }],
      ...(topUsers.other ? { otherLabel: `All other users: ${pct(topUsers.other, total(activeUsers))}%` } : {}) }],
      whatItMeans: !userHours.length ? 'No user reserved a device in this range.' :
        `The top ${topUsers.cats.length} users account for ${Math.round((topUsers.vals.reduce((s, v) => s + v, 0) / Math.max(total(activeUsers), 0.0001)) * 100)}% of the reserved hours of ${plural(userHours.length, 'active user')}.` },
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
  highlights.push(`${r1(hoursAll)} reserved hours over ${days} days, ${r1(hoursRecent)} in the last ${i.recentDays}.`);

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
