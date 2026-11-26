/**
 * Data collection for the report recipes (create_report). Each function returns plain records; the layout and the
 * interpretation are built in src/utils/report-recipes.ts.
 */
import { stripAnsi } from '../utils/failure-cause.js';
import { listTests, getGroupedTests, getGroupedTestsAllProjects } from './reporting.js';
import { getMyAccountInfo } from './users.js';
import { getReporterProjects } from './reporter-projects.js';
import { countsFromPivotRow, type StatusCounts } from '../utils/test-status.js';
import type { TestFilterField } from '../types/digital-ai.js';
import { serverSortAvailable } from './access-level.js';
import { getAllDevices } from './devices.js';
import { getAllProjects } from './projects.js';
import { getLicenseInfo } from './license.js';
import { fetchUsageReportCsv, UsageProbeStop, type FetchUsageReportOptions } from './usage-reports.js';
import { parseCsvSections, scanCsvRows } from '../utils/csv.js';
import { foldBreakdownRows, type TestRun, type PoolDevice, type LicenseSession, type LicenseLimits, type ReservationRow, type DeviceUsageRow, type UserUsageRow, type InventoryRow, type BreakdownRow } from '../utils/report-recipes.js';
import { loosePlan } from '../utils/report-case.js';

const PAGE = 1000;
const WAVE = 4;

export interface ScanOptions { filter?: TestFilterField[]; keys?: string[]; signal?: AbortSignal; onProgress?: (runsRead: number) => void }

/**
 * Reporter runs newer than `cutoff`, newest first. The reporter cannot filter on start_time (CSRF-blocked), so this
 * pages a server-sorted list and stops at the cutoff — the early exit is valid only on sorted pages (sortApplied).
 * Measured live 2026-11-23: plain 1,000-row pages read ~835 runs/s; asking for device/cause keys halves that, and
 * parallel requests barely overlap on the server — so the full scan stays plain and only failures carry details.
 */
export async function scanRuns(cutoff: number, maxRecords: number, projectName?: string, o: ScanOptions = {}): Promise<{ runs: TestRun[]; capped: boolean; /** Pages came newest first: everything newer than the oldest run read was read. */ sorted: boolean }> {
  const runs: TestRun[] = [];
  let scanned = 0;
  const fetchPage = (page: number, sort: boolean) => listTests({
    limit: PAGE, page, returnTotalCount: false,
    ...(sort && { sort: [{ property: 'start_time', descending: true }] }),
    ...(o.filter && { filter: o.filter }),
    ...(o.keys && { keys: o.keys }),
  }, undefined, projectName);
  let sort = serverSortAvailable();
  for (let first = 1; ; first += WAVE) {
    if (o.signal?.aborted) throw new Error('cancelled');
    const pages = await Promise.all(Array.from({ length: WAVE }, (_, k) => fetchPage(first + k, sort)));
    if (o.signal?.aborted) throw new Error('cancelled');
    if (sort && pages.some((b) => b.sortApplied === false)) {
      // Sort refused (remembered for this credential): an unsorted page is no continuation of sorted ones — restart.
      runs.length = 0;
      scanned = 0;
      sort = false;
      first = 1 - WAVE;
      continue;
    }
    for (const batch of pages) {
      const rows = (batch.data ?? []) as unknown as Array<Record<string, unknown>>;
      for (const r of rows) {
        scanned++;
        const t = Date.parse(String(r.start_time));
        if (!(t >= cutoff)) {
          if (batch.sortApplied) return { runs, capped: false, sorted: sort };
          continue;
        }
        runs.push({
          test_id: Number(r.test_id) || 0,
          name: String(r.name ?? ''),
          status: String(r.status ?? ''),
          start_time: String(r.start_time ?? ''),
          serial: (r['device.serialNumber'] as string) || null,
          deviceName: (r['device.name'] as string) || null,
          deviceOs: (r['device.os'] as string) || null,
          cause: stripAnsi((r.cause as string) ?? null),
          errorCategory: (r.errorCategory as string) ?? null,
          duration: typeof r.duration === 'number' ? r.duration : null,
        });
        if (runs.length >= maxRecords) return { runs, capped: true, sorted: sort };
      }
      if (rows.length < PAGE) return { runs, capped: false, sorted: sort };
    }
    o.onProgress?.(runs.length);
    if (scanned >= maxRecords * 2) return { runs, capped: true, sorted: sort };
  }
}

const DETAIL_KEYS = ['device.serialNumber', 'device.name', 'device.os', 'cause', 'errorCategory'];

/** Failed and Error runs since `cutoff`, with device, cause and the platform's classification. */
export async function scanFailures(cutoff: number, maxRecords: number, projectName?: string, signal?: AbortSignal): Promise<{ runs: TestRun[]; capped: boolean }> {
  const [f, e] = await Promise.all(['Failed', 'Error'].map((status) =>
    scanRuns(cutoff, maxRecords, projectName, { filter: [{ property: 'status', operator: '=', value: status }], keys: DETAIL_KEYS, signal })));
  return { runs: [...f.runs, ...e.runs], capped: f.capped || e.capped };
}

/**
 * Status counts per value of `groupBy` for runs with test_id >= minTestId, counted by the reporter itself. The window
 * is expressed as a test_id bound because start_time cannot be filtered; test ids grow with creation time. The value
 * must be a NUMBER — a string bound answers 400 "Failed to retrieve data" (probed live 2026-11-23).
 */
export async function groupedCounts(groupBy: string, minTestId: number, projectName?: string): Promise<Array<{ key: string | null; counts: StatusCounts }>> {
  const res = (await getGroupedTests({ groupBy: [groupBy], pivotBy: ['status'], filter: [{ property: 'test_id', operator: '>=', value: minTestId as unknown as string }], returnTotalCount: true }, undefined, projectName)) as { data?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  const rows = Array.isArray(res) ? res : res.data ?? [];
  // Values that differ only in letter case are one group (ANDROID / Android would otherwise be two rows of one platform).
  return foldBreakdownRows(rows.map((r) => ({ values: [r[groupBy] == null || r[groupBy] === '' ? null : String(r[groupBy])], counts: countsFromPivotRow(r) })))
    .map((r) => ({ key: r.values[0], counts: r.counts }));
}

export async function deviceRows(): Promise<PoolDevice[]> {
  const devices = await getAllDevices();
  return devices.map((d) => ({
    id: d.id == null ? undefined : String(d.id),
    osVersion: d.osVersion,
    manufacturer: d.manufacturer,
    name: d.deviceName,
    // Always text (the id fallback may arrive as a number): the coverage report matches serials by lower case.
    serial: String(d.udid || d.iosUdid || d.id || ''),
    os: d.deviceOs,
    model: d.modelName || d.model,
    status: d.displayStatus || d.currentStatus,
    statusAgeMin: Number.isFinite(Number(d.statusAgeInMinutes)) ? Number(d.statusAgeInMinutes) : null,
    region: d.region,
    agent: d.agentName,
  }));
}

/** The project of the active access key (a reporter call without a project answers for this one), when the platform names it. */
export async function ownProjectName(): Promise<string | undefined> {
  return getMyAccountInfo().then((a) => a.project?.name || undefined).catch(() => undefined);
}

/** Cloud project id for a name (the usage CSV takes the CLOUD id; reporter ids differ). */
export async function cloudProjectId(projectName: string): Promise<{ id: number; name: string }> {
  const projects = await getAllProjects();
  const p = projects.find((x) => x.name.toLowerCase() === projectName.toLowerCase());
  if (!p) throw new Error(`No project named "${projectName}" is visible to this access key. Known: ${projects.slice(0, 20).map((x) => x.name).join(', ')}${projects.length > 20 ? ', …' : ''}`);
  return { id: p.id, name: p.name };
}

/** "H:MM:SS" (or "MM:SS") → hours. */
export function durationHours(s: string): number {
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  const [h, m, sec] = parts.length === 3 ? parts : [0, parts[0] ?? 0, parts[1] ?? 0];
  return h + m / 60 + sec / 3600;
}

/** Per-reservation rows of the Device Reservations CSV (section 2) for one project and UTC date range. */
export async function reservationRows(projectId: number, startDate: string, endDate: string, opts: FetchUsageReportOptions = {}): Promise<{ rows: ReservationRow[]; fetchMs: number; bytes: number }> {
  const { data, fetchMs } = await fetchUsageReportCsv('Device Reservations', { startDate, endDate, projectId }, opts);
  const sections = parseCsvSections(data.toString('utf8'));
  const detail = sections.find((s) => s.headers.includes('Reservation Start Timestamp'));
  if (!detail) return { rows: [], fetchMs, bytes: data.length };
  const col = (n: string) => detail.headers.indexOf(n);
  const [ts, dur, user, devName, model, os, ver, project] = ['Reservation Start Timestamp', 'Reservation Duration', 'Username', 'Device Name', 'Device Model', 'Device OS', 'Device OS Version', 'Project'].map(col);
  const rows: ReservationRow[] = [];
  for (const r of detail.rows) {
    const start = Number(r[ts]);
    if (!Number.isFinite(start)) continue;
    rows.push({
      start,
      hours: durationHours(r[dur] ?? ''),
      user: r[user] || '(unknown user)',
      device: r[devName] || '(unknown device)',
      deviceDetail: [r[model], r[os] && r[ver] ? `${r[os]} ${r[ver]}` : r[os]].filter(Boolean).join(', '),
      project: r[project] ?? '',
    });
  }
  return { rows, fetchMs, bytes: data.length };
}

/**
 * Reserved hours per device per project, from the Devices Usage report (projectId 0 = every project). The platform
 * aggregates it, so it stays small for any range: all projects over 180 days was 35 KB / 511 rows, about 18 s (live
 * 2026-11-24) — where the per-reservation report for one busy project over the same range is 169 MB.
 */
export async function deviceUsageRows(projectId: number, startDate: string, endDate: string, opts: FetchUsageReportOptions = {}): Promise<DeviceUsageRow[]> {
  const { data } = await fetchUsageReportCsv('Devices Usage', { startDate, endDate, projectId }, opts);
  const sec = parseCsvSections(data.toString('utf8')).find((s) => s.headers.some((h) => /^project$/i.test(h)));
  if (!sec) return [];
  const col = (re: RegExp) => sec.headers.findIndex((h) => re.test(h));
  const [name, os, ver, project, hours, id] = [/^device name$/i, /^os$/i, /^os version$/i, /^project$/i, /hours/i, /^device id$/i].map(col);
  return sec.rows.filter((r) => r[project]).map((r) => ({
    ...(id >= 0 && r[id] ? { deviceId: r[id] } : {}),
    device: r[name] || '(unknown device)', os: r[os] ?? '', osVersion: r[ver] ?? '', project: r[project], hours: Number(r[hours]) || 0,
  }));
}

/**
 * Every session of the License Usage report for a UTC date range, all projects: start, end, session type (Mobile execution,
 * Browsers, Manual testing, Development, Virtual Devices) and license type (Dedicated Devices, Browsers, Virtual Devices).
 * One row per session: 3 days were 24,705 rows and 6.3 MB (2026-11-24); 30 days 172,916 rows and 48 MB, downloaded in 16 s
 * (2026-11-25). Read row by row, keeping five values of each: building the whole table first would be four million strings.
 */
export async function licenseSessions(startDate: string, endDate: string, opts: FetchUsageReportOptions = {}): Promise<{ sessions: LicenseSession[]; bytes: number }> {
  const { data } = await fetchUsageReportCsv('License Usage', { startDate, endDate }, opts);
  const sessions: LicenseSession[] = [];
  let cols: number[] | null = null;
  let ended = false;
  // A few dozen distinct names repeat on 170,000 rows: keep one copy of each.
  const seen = new Map<string, string>();
  const one = (v: string | undefined) => { const k = v ?? ''; let s = seen.get(k); if (s === undefined) { s = k; seen.set(k, s); } return s; };
  scanCsvRows(data, (r) => {
    if (ended) return;
    if (!cols) {
      // The session table starts at the row that names its columns (a summary section may come before it).
      if (r.some((h) => /^session start timestamp$/i.test(h))) {
        cols = [/^session start timestamp$/i, /^session end timestamp$/i, /^session type$/i, /^license type$/i, /^project$/i].map((re) => r.findIndex((h) => re.test(h)));
      }
      return;
    }
    if (r.length === 1 && r[0] === '') { ended = true; return; } // a blank line ends the table
    const [start, end, kind, license, project] = cols;
    const s = Number(r[start]), e = Number(r[end]);
    if (!r[start] || !Number.isFinite(s) || !Number.isFinite(e)) return;
    sessions.push({ start: s, end: e, sessionType: one(r[kind]), licenseType: one(r[license]), project: one(r[project]) });
  });
  return { sessions, bytes: data.length };
}

/** The licensed numbers, or null when the key may not read them. */
export async function licenseLimits(): Promise<LicenseLimits | null> {
  return getLicenseInfo().then((l) => ({ dedicatedDevices: Number(l.dedicatedDevices) || 0, sharedDevices: Number(l.sharedDevices) || 0, virtualDevices: Number(l.virtualDevices) || 0, browsers: Number(l.browsers) || 0 })).catch(() => null);
}

/** Reserved hours per user per project: the per-user section of the Users Usage report (all projects, 30 days: 5 KB, ~17 s live). */
export async function userUsageRows(startDate: string, endDate: string, opts: FetchUsageReportOptions = {}): Promise<UserUsageRow[]> {
  const { data } = await fetchUsageReportCsv('Users Usage', { startDate, endDate, projectId: 0 }, opts);
  const sec = parseCsvSections(data.toString('utf8')).find((s) => s.headers.some((h) => /^username$/i.test(h)));
  if (!sec) return [];
  const col = (re: RegExp) => sec.headers.findIndex((h) => re.test(h));
  const [user, project, hours, tag] = [/^username$/i, /^project$/i, /duration/i, /^user tag$/i].map(col);
  return sec.rows.filter((r) => r[user]).map((r) => ({ user: r[user], project: r[project] ?? '', hours: Number(r[hours]) || 0, ...(tag >= 0 && r[tag] ? { tags: r[tag] } : {}) }));
}

/**
 * Every test report this access key can see, counted by project, user and status. No window: these are the platform's
 * own counts (the grouped endpoint), so nothing is read run by run and nothing is capped — 4,011,046 reports in 85
 * projects took 12.3 s live (2026-11-24), where paging the runs would have been 8,000 list calls.
 * Mobile reports carry the user in "user", web (Selenium) reports in "digitalai:user": both are grouped and a row is filed
 * under whichever it has. `projectName` limits it to one project. A key that cannot list reporter projects (Project User)
 * gets its own project, the only one it can see.
 */
export async function inventoryData(o: { projectName?: string; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<{
  rows: InventoryRow[]; projects: string[]; reporterOnly: string[] | null; failed: Array<{ project: string; error: string }>; scope: 'all' | 'one' | 'own';
  storage?: Array<{ project: string; mb: number; quotaMb: number }> | null;
}> {
  const request = { groupBy: ['user', 'digitalai:user'], pivotBy: ['status' as const] };
  const toRow = (project: string, r: Record<string, unknown>): InventoryRow =>
    ({ project, user: ((r['user'] ?? r['digitalai:user']) as string | null | undefined) ?? null, counts: countsFromPivotRow(r) });
  const single = async (project: string | undefined, label: string, scope: 'one' | 'own') => {
    const res = (await getGroupedTests(request, undefined, project)) as { data?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    return { rows: (Array.isArray(res) ? res : res.data ?? []).map((r) => toRow(label, r)), projects: [label], reporterOnly: null, failed: [], scope };
  };
  if (o.projectName) return single(o.projectName, o.projectName, 'one');
  let all: Awaited<ReturnType<typeof getGroupedTestsAllProjects>>;
  try {
    all = await getGroupedTestsAllProjects(request, { signal: o.signal, onProgress: o.onProgress });
  } catch (e) {
    if (!/cannot list the reporter's projects/.test((e as Error).message)) throw e;
    const own = await getMyAccountInfo().then((a) => a.project?.name).catch(() => undefined);
    return single(undefined, own ?? 'This access key\'s project', 'own');
  }
  // Reporter projects with no cloud project of the same name (old POCs whose cloud project was deleted).
  const cloud = await getAllProjects().then((ps) => new Set(ps.map((p) => p.name.toLowerCase()))).catch(() => null);
  // Storage and quota per reporter project (the same list the counts were asked from).
  const storage = await getReporterProjects().then((ps) => ps.map((p) => ({ project: String(p.name), mb: Number(p.currentDiskStorageInMB) || 0, quotaMb: Number(p.diskStorageThresholdInMB) || 0 }))).catch(() => null);
  return {
    storage,
    rows: all.rows.map((r) => toRow(String(r['project']), r)),
    projects: all.projects,
    reporterOnly: cloud ? all.projects.filter((p) => !cloud.has(p.toLowerCase())) : null,
    failed: all.failed,
    scope: 'all',
  };
}

// ── Counts for a window (no run is read) ─────────────────────────────────────────────────────────────────────────

/**
 * The id of the first test that started at or after `t`, or null when none did. The reporter cannot filter on
 * start_time, but it filters on a numeric test_id and ids grow with time, so the window's first id is found by a binary
 * search over ids: each step asks for the one record with the smallest id >= mid. Live 2026-11-24: 90 days back in a
 * project of 830,000 reports took 19 steps and 1.0 s. With that id, counts for any window come from the grouped
 * endpoint (230,158 runs of 90 days in 7 s) where reading the runs stops at 25,000.
 */
export async function firstTestIdSince(t: number, projectName?: string): Promise<number | null> {
  const one = async (request: Parameters<typeof listTests>[0]) => {
    const page = await listTests({ limit: 1, page: 1, returnTotalCount: false, ...request }, undefined, projectName);
    if (request.sort && !page.sortApplied) throw new Error('The reporter refused a sorted list for this access key, so a time window cannot be bounded: ask for all dates.');
    return (page.data ?? [])[0] as { test_id?: number; start_time?: string } | undefined;
  };
  const newest = await one({ sort: [{ property: 'start_time', descending: true }] });
  if (!newest || Date.parse(String(newest.start_time)) < t) return null;
  let lo = 1, hi = Number(newest.test_id);
  for (let step = 0; lo < hi && step < 40; step++) {
    const mid = Math.floor((lo + hi) / 2);
    const rec = await one({ filter: [{ property: 'test_id', operator: '>=', value: mid as unknown as string }], sort: [{ property: 'test_id', descending: false }] });
    if (!rec || Date.parse(String(rec.start_time)) >= t) hi = mid;
    else lo = Number(rec.test_id) + 1;
  }
  return lo;
}

/**
 * Counts by one or two report keys with a status pivot, from `minTestId` on (null: all dates). Keys verified live as
 * group keys (2026-11-24): device.os, device.name, device.model, device.version, device.manufacture, test.framework,
 * browserName, browserVersion, device.pool.actual, errorCategory, user, name, date (a day, "2026-11-24"), and custom
 * digitalai:<key> columns. A grouping by user also groups by digitalai:user (web reports keep the user there).
 * Letter case: group values that differ only in case are one row, and `where` matches every stored spelling of its value
 * (the platform's "=" matches one: browserName = "chrome" 1,243 runs, = "Chrome" 809, live 2026-11-25) unless `exactCase`.
 */
export async function breakdownCounts(keys: string[], minTestId: number | null, projectName?: string, /** Exclusive upper bound: the period before a window. */ belowTestId?: number,
  /** Only runs whose column equals the value. Verified live 2026-11-24: equality filters combine with the id bound. */ where?: Record<string, string>,
  /** Match `where` by the exact spelling the platform stores. */ exactCase = false): Promise<BreakdownRow[]> {
  const groupBy = keys.includes('user') && !keys.includes('digitalai:user') ? [...keys, 'digitalai:user'] : keys;
  // Both bounds are NUMBERS; a range (>= and <) adds up exactly (verified live 2026-11-24).
  const filter: TestFilterField[] = [
    ...(minTestId != null ? [{ property: 'test_id', operator: '>=', value: minTestId }] : []),
    ...(belowTestId != null ? [{ property: 'test_id', operator: '<', value: belowTestId }] : []),
    ...Object.entries(where ?? {}).map(([property, value]) => ({ property, operator: '=', value })),
  ];
  // Sent as "contains" with the key grouped as well; only the groups whose value equals the wanted one are kept (report-case.ts).
  const plan = exactCase ? null : loosePlan(groupBy, filter);
  const sent = plan?.filter ?? filter;
  const res = (await getGroupedTests({
    groupBy: plan?.groupBy ?? groupBy, pivotBy: ['status'],
    ...(sent.length ? { filter: sent } : {}),
  }, undefined, projectName)) as { data?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  const raw = Array.isArray(res) ? res : res.data ?? [];
  const rows = plan ? plan.apply(raw).rows : raw;
  return foldBreakdownRows(rows.map((r) => ({
    values: keys.map((k) => {
      const v = k === 'user' ? r['user'] ?? r['digitalai:user'] : r[k];
      return v == null || v === '' ? null : String(v);
    }),
    counts: countsFromPivotRow(r),
  })));
}

// ── Estimates ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface WorkEstimate {
  ms: number;
  basis: string;
  /** Plausible range when the estimate rests on samples. */
  rangeMs?: [number, number];
  /** usage-summary: rows already fetched by the probe (small CSV). */
  prefetched?: ReservationRow[];
  /** Reporter recipes: the estimate for the window scaled by `factor` (0-1). Not linear: maxRecords bounds the scan. */
  scaled?: (factor: number) => number;
}

/**
 * Time model for a reporter recipe, from one 1,000-run probe page: how many runs the window holds (the page's own
 * time span extrapolated) and how fast this reporter answers right now (the probe's own duration). Calibrated live
 * 2026-11-23: plain pages in waves read ~1.4x a single page's rate, detail (failure) pages ~0.4x, grouped counts ~6 s.
 */
export function reporterEstimate(p: { probeRows: number; probeSpanMs: number; probeMs: number; failShare: number; windowMs: number; extraWindowMs: number; maxRecords: number; grouped: boolean }): { ms: number; runs: number } {
  const perMs = p.probeRows >= 1000 && p.probeSpanMs > 0 ? p.probeRows / p.probeSpanMs : 0;
  const runsIn = (ms: number) => (perMs ? Math.round(perMs * ms) : p.probeRows);
  const plain = Math.min(p.maxRecords, runsIn(p.windowMs + p.extraWindowMs));
  const detail = Math.min(p.maxRecords, Math.round(runsIn(p.windowMs) * p.failShare));
  const pageRate = 1000 / Math.max(500, p.probeMs); // runs per ms for one page
  const plainMs = plain / (pageRate * 1.4);
  const detailMs = detail / (pageRate * 0.4);
  const ms = Math.max(plainMs, detailMs) + (p.grouped ? 6_000 : 0) + 2_000;
  return { ms: Math.round(ms), runs: runsIn(p.windowMs) };
}

export async function estimateReporterRecipe(o: { windowMs: number; extraWindowMs: number; maxRecords: number; grouped: boolean; projectName?: string }): Promise<WorkEstimate & { runs: number }> {
  const t0 = Date.now();
  const page = await listTests({ limit: PAGE, page: 1, returnTotalCount: false, ...(serverSortAvailable() && { sort: [{ property: 'start_time', descending: true }] }) }, undefined, o.projectName);
  const probeMs = Date.now() - t0;
  const rows = (page.data ?? []) as unknown as Array<Record<string, unknown>>;
  const times = rows.map((r) => Date.parse(String(r.start_time))).filter(Number.isFinite);
  const span = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
  const fails = rows.filter((r) => r.status === 'Failed' || r.status === 'Error').length;
  const model = (factor: number) => reporterEstimate({ probeRows: rows.length, probeSpanMs: span, probeMs, failShare: rows.length ? fails / rows.length : 0, windowMs: o.windowMs * factor, extraWindowMs: o.extraWindowMs * factor, maxRecords: o.maxRecords, grouped: o.grouped });
  const e = model(1);
  const capped = e.runs > o.maxRecords;
  return {
    scaled: (factor) => model(factor).ms + probeMs,
    ms: e.ms + probeMs,
    runs: e.runs,
    basis: `about ${e.runs.toLocaleString('en-US')} runs in the window${capped ? ` (only the newest ${o.maxRecords.toLocaleString('en-US')} would be read)` : ''}, this reporter answering a 1,000-run page in ${(probeMs / 1000).toFixed(1)} s`,
  };
}

/**
 * Usage CSV time model, from samples (measured live 2026-11-23 on one busy project): the platform BUILDS the CSV before
 * sending anything, ~1 s + 0.2 s per MB (7 d 1.8 MB 1.2 s, 30 d 24 MB 6.8 s, 90 d 121 MB 25 s, 180 d 169 MB 35 s); the
 * transfer then ran at 2-3 MB/s; parsing and layout ~20 MB/s. Size per day varies a lot between weeks, so the size is
 * scaled from several small slices spread over the range rather than from one.
 */
export function usageEstimateMs(totalBytes: number, msPerMb = 480): number {
  // End to end (build + transfer + parse) the live runs took 14 s for 24 MB, 48 s for 121 MB, 87 s for 169 MB.
  return Math.round(3_000 + (totalBytes / 1_048_576) * msPerMb);
}

/** Exact reserved hours of a project in a range, from the small Devices Usage report (~1.3 s even for 180 days, live). */
export async function reservedHours(projectId: number, startDate: string, endDate: string): Promise<number | null> {
  try {
    const { data } = await fetchUsageReportCsv('Devices Usage', { startDate, endDate, projectId }, { timeoutMs: 20_000 });
    const sec = parseCsvSections(data.toString('utf8'))[0];
    const col = sec?.headers.findIndex((h) => /hours/i.test(h)) ?? -1;
    return col < 0 ? null : sec.rows.reduce((n, r) => n + (Number(r[col]) || 0), 0);
  } catch {
    return null;
  }
}

export async function estimateUsageRecipe(projectId: number, startDate: string, endDate: string): Promise<WorkEstimate> {
  const DAY = 86_400_000;
  const t0 = Date.parse(`${startDate}T00:00:00Z`), t1 = Date.parse(`${endDate}T00:00:00Z`);
  const days = Math.round((t1 - t0) / DAY) + 1;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  if (days <= 14) {
    // Short ranges build in a few seconds: fetch for real, and keep the rows if they arrive within the budget.
    const s = Date.now();
    try {
      const { rows, bytes } = await reservationRows(projectId, startDate, endDate, { timeoutMs: 15_000, probe: { afterMs: 3_000, decide: () => false } });
      return { ms: 0, basis: `the whole ${(bytes / 1_048_576).toFixed(1)} MB CSV arrived in ${((Date.now() - s) / 1000).toFixed(1)} s`, prefetched: rows };
    } catch (e) {
      if (!(e instanceof UsageProbeStop)) throw e;
      const total = e.info.totalBytes ?? e.info.readBytes * 3;
      return { ms: usageEstimateMs(total), basis: `a ${(total / 1_048_576).toFixed(1)} MB CSV` };
    }
  }
  // The exact reserved hours of the range (cheap), and eight 1-day samples spread over it for bytes per reserved hour
  // (three samples missed the burst days of many short reservations and put 169 MB at 100 MB).
  const N = Math.min(8, days);
  const starts = Array.from({ length: N }, (_, k) => t0 + Math.round((k * (days - 1)) / Math.max(1, N - 1)) * DAY);
  const [hours, samples] = await Promise.all([
    reservedHours(projectId, startDate, endDate),
    Promise.all(starts.map(async (st) => {
      const s = Date.now();
      const { bytes, rows } = await reservationRows(projectId, iso(st), iso(st), { timeoutMs: 20_000 });
      return { bytes, hours: rows.reduce((n, r) => n + r.hours, 0), ms: Date.now() - s };
    })),
  ]);
  const sampled = samples.reduce((n, x) => n + x.bytes, 0);
  const sampledHours = samples.reduce((n, x) => n + x.hours, 0);
  const perDay = sampled / samples.length;
  // Bytes follow the number of reservations; reserved hours track that far better than calendar days (bursty weeks).
  // Sample days still vary (12-36 KB per hour live), so the point estimate leans half on the long-run ratio measured
  // over whole ranges (17-22 KB per hour, 2026-11-23) and the range spans both.
  const PRIOR = 18_000;
  const sampleRatio = sampledHours >= 5 ? sampled / sampledHours : PRIOR;
  const perHour = (sampleRatio + PRIOR) / 2;
  const total = hours != null ? hours * perHour : perDay * days;
  const rangeMs: [number, number] | undefined = hours != null
    ? [usageEstimateMs(hours * Math.min(sampleRatio, PRIOR)), usageEstimateMs(hours * Math.max(sampleRatio, PRIOR))]
    : undefined;
  return {
    ms: usageEstimateMs(total),
    rangeMs,
    basis: hours != null
      ? `about ${(total / 1_048_576).toFixed(0)} MB of reservations (${Math.round(hours).toLocaleString('en-US')} reserved hours, ${(perHour / 1024).toFixed(0)} KB per hour in ${N} sample days); the platform builds the whole CSV before sending it`
      : `about ${(total / 1_048_576).toFixed(0)} MB of reservations, scaled from ${N} sample days; the platform builds the whole CSV before sending it`,
  };
}
