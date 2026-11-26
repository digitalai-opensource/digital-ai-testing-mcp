/**
 * Example reports for the customer docs (docs/examples/reports/). Every number, name, device, serial and user below is
 * MADE UP and generated from a fixed seed and a fixed reference date, so the output is the same on every run and holds
 * nothing from a real tenant. The script makes no network call: it feeds the pure report builders and the renderer.
 *
 *   npm run docs:example-reports
 *
 * Writes <name>.html for every report; the screenshots (<name>.png) are taken with headless Chrome separately.
 */
process.env.TZ = 'UTC'; // the builders cut days in the process time zone; UTC keeps the output identical everywhere

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTestSummary, buildTestTrend, buildTestBreakdown, buildTestReliability, buildReleaseReadiness, buildFailureAnalysis,
  buildTestInventory, buildDeviceHealth, buildDeviceCoverage, buildDeviceUtilization, buildLicenseUsage, buildUsageSummary,
  buildUsageOverview, dayStart, addDays, isoDate,
  type TestRun, type GroupCounts, type BreakdownRow, type InventoryRow, type PoolDevice, type DeviceUsageRow, type UserUsageRow,
  type ReservationRow, type LicenseSession, type RecipeResult,
} from '../src/utils/report-recipes.js';
import { buildPerformanceOverview } from '../src/utils/report-performance.js';
import { renderReport, type ReportSpec } from '../src/utils/report-render.js';
import { emptyStatusCounts, type StatusCounts } from '../src/utils/test-status.js';
import type { Transaction } from '../src/types/digital-ai.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'examples', 'reports');
const DAY = 86_400_000, HOUR = 3_600_000;
const NOW = Date.parse('2026-11-20T12:00:00Z'); // the fixed "now" of every example
const GENERATED = new Date(NOW);

// ── Deterministic random numbers ────────────────────────────────────────────────────────────────────────────────────
let seed = 20261120;
function rnd(): number { // mulberry32
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
const between = (lo: number, hi: number) => lo + rnd() * (hi - lo);
const int = (lo: number, hi: number) => Math.floor(between(lo, hi + 1));
const hex = (n: number) => Array.from({ length: n }, () => '0123456789ABCDEF'[int(0, 15)]).join('');

// ── The made-up lab ─────────────────────────────────────────────────────────────────────────────────────────────────
const PROJECTS = ['Mobile Banking', 'Payments', 'Web Store', 'QA Sandbox'] as const;
const USERS = ['ana@example.com', 'ben@example.com', 'chen@example.com', 'dara@example.com', 'eli@example.com', 'fatima@example.com', 'gus@example.com', 'hana@example.com'];
const REGIONS = ['US', 'EU', 'APAC'] as const;

const MODELS: Array<{ model: string; os: 'Android' | 'iOS'; versions: string[]; maker: string; count: number }> = [
  { model: 'Pixel 8', os: 'Android', versions: ['15', '14'], maker: 'Google', count: 5 },
  { model: 'Pixel 7', os: 'Android', versions: ['14', '13'], maker: 'Google', count: 3 },
  { model: 'Galaxy S24', os: 'Android', versions: ['14'], maker: 'Samsung', count: 4 },
  { model: 'Galaxy S23', os: 'Android', versions: ['14', '13'], maker: 'Samsung', count: 3 },
  { model: 'Galaxy A54', os: 'Android', versions: ['14'], maker: 'Samsung', count: 2 },
  { model: 'OnePlus 12', os: 'Android', versions: ['15'], maker: 'OnePlus', count: 2 },
  { model: 'iPhone 15', os: 'iOS', versions: ['18.1', '17.6'], maker: 'Apple', count: 5 },
  { model: 'iPhone 14', os: 'iOS', versions: ['17.6', '17.5'], maker: 'Apple', count: 3 },
  { model: 'iPhone 13', os: 'iOS', versions: ['16.7'], maker: 'Apple', count: 2 },
  { model: 'iPad Air', os: 'iOS', versions: ['18.1'], maker: 'Apple', count: 2 },
];

let labNo = 1;
const DEVICES: PoolDevice[] = [];
for (const m of MODELS) {
  for (let k = 0; k < m.count; k++) {
    const no = String(labNo++).padStart(2, '0');
    const region = REGIONS[(labNo + k) % 3];
    DEVICES.push({
      id: String(5000 + labNo), name: `${m.model} Lab-${no}`, model: m.model, os: m.os, osVersion: m.versions[k % m.versions.length], manufacturer: m.maker,
      serial: m.os === 'iOS' ? `0000A${hex(3)}-${hex(16)}` : `LAB${hex(8)}`,
      status: 'Available', statusAgeMin: int(5, 600), region, agent: `lab-${region.toLowerCase()}-0${(k % 3) + 1}`,
    });
  }
}
// Some variety in today's state: a few in use, one offline for days, one offline for an hour, one in error.
for (const n of [0, 6, 12, 20, 26]) DEVICES[n].status = 'In Use';
DEVICES[9].status = 'Offline'; DEVICES[9].statusAgeMin = 4 * 1440 + 130;
DEVICES[23].status = 'Offline'; DEVICES[23].statusAgeMin = 55;
DEVICES[30].status = 'Error'; DEVICES[30].statusAgeMin = 2 * 1440 + 400;
const FLAKY = DEVICES.find((d) => d.model === 'Galaxy A54')!; // the device that keeps dropping sessions
const NEVER_USED = new Set([DEVICES[17].serial, DEVICES[28].serial, DEVICES[9].serial]); // no test ran on these
const RUN_DEVICES = DEVICES.filter((d) => !NEVER_USED.has(d.serial));

// ── Tests and how they fail ─────────────────────────────────────────────────────────────────────────────────────────
interface TestDef { name: string; project: string; web?: boolean; fail: number; weight: number }
const TESTS: TestDef[] = [
  { name: 'Login with valid user', project: 'Mobile Banking', fail: 0.03, weight: 10 },
  { name: 'Login with wrong password', project: 'Mobile Banking', fail: 0.04, weight: 6 },
  { name: 'View account balance', project: 'Mobile Banking', fail: 0.05, weight: 8 },
  { name: 'Transfer between accounts', project: 'Mobile Banking', fail: 0.12, weight: 7 },
  { name: 'Pay a bill', project: 'Mobile Banking', fail: 0.08, weight: 6 },
  { name: 'Deposit a check', project: 'Mobile Banking', fail: 0.05, weight: 5 }, // newly failing in the last days
  { name: 'Reset password', project: 'Mobile Banking', fail: 0.45, weight: 4 }, // mixed results
  { name: 'Open push notification', project: 'Mobile Banking', fail: 1, weight: 2 }, // fails every time
  { name: 'Update profile photo', project: 'Mobile Banking', fail: 0.06, weight: 4 },
  { name: 'Checkout as guest', project: 'Mobile Banking', web: true, fail: 0.1, weight: 6 },
  { name: 'Checkout with saved card', project: 'Mobile Banking', web: true, fail: 0.07, weight: 5 },
  { name: 'Search for a product', project: 'Mobile Banking', web: true, fail: 0, weight: 6 },
  { name: 'Add item to cart', project: 'Mobile Banking', web: true, fail: 0, weight: 5 },
  { name: 'Logout', project: 'Mobile Banking', fail: 0.01, weight: 4 },
];
const TOTAL_WEIGHT = TESTS.reduce((s, t) => s + t.weight, 0);
function pickTest(): TestDef { let r = rnd() * TOTAL_WEIGHT; for (const t of TESTS) { r -= t.weight; if (r <= 0) return t; } return TESTS[0]; }

const CAUSES: Array<{ cause: (t: TestDef) => string; category: string | null; weight: number }> = [
  { cause: () => `Element not found: //*[@id='${pick(['submitButton', 'amountField', 'accountList', 'confirmButton'])}'] after 20 s`, category: 'script', weight: 5 },
  { cause: () => 'Timed out after 30 s waiting for the confirmation screen', category: 'application', weight: 4 },
  { cause: (t) => t.web ? 'AssertionError: expected cart total "$42.10" but was "$40.00"' : 'AssertionError: expected balance "1,250.00" but was "1,205.00"', category: 'assertion', weight: 5 },
  { cause: () => 'Could not start a session: no available device matching the query', category: 'device', weight: 2 },
  { cause: () => 'Connection reset while installing the app on the device', category: 'network', weight: 1 },
  { cause: () => 'Session ended unexpectedly: the device stopped responding', category: null, weight: 2 },
];
const CAUSE_WEIGHT = CAUSES.reduce((s, c) => s + c.weight, 0);
function pickCause(t: TestDef): { cause: string; category: string | null } {
  let r = rnd() * CAUSE_WEIGHT;
  for (const c of CAUSES) { r -= c.weight; if (r <= 0) return { cause: c.cause(t), category: c.category }; }
  return { cause: CAUSES[0].cause(t), category: CAUSES[0].category };
}

interface Run extends TestRun { project: string; osVersion: string | null; model: string | null }
let testId = 410_000;
const RUNS: Run[] = [];
const DAYS_OF_RUNS = 120;
for (let d = DAYS_OF_RUNS - 1; d >= 0; d--) {
  const day = dayStart(addDays(NOW, -d));
  const weekday = new Date(day).getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  const growth = 1 + (DAYS_OF_RUNS - d) / DAYS_OF_RUNS * 0.35; // volume grows over the period
  const count = Math.round((weekend ? between(40, 70) : between(150, 230)) * growth * (d === 0 ? 0.5 : 1));
  const incident = d >= 28 && d <= 33; // one bad week, about a month ago
  for (let k = 0; k < count; k++) {
    const t = pickTest();
    const dev = t.web ? null : pick(RUN_DEVICES);
    const start = day + (d === 0 ? between(0, 12) : between(6, 22)) * HOUR;
    let p = t.fail;
    if (t.name === 'Deposit a check' && d <= 6) p = 0.6;
    if (t.name === 'Deposit a check' && d > 6 && d <= 13) p = -1; // passed every time before this week
    if (incident) p = Math.min(1, p + 0.12);
    if (dev === FLAKY && p >= 0) p = Math.max(p, 0.42);
    if (d >= 7 && d <= 13) p *= 1.7; // the previous week was a little worse
    const r = rnd();
    let status = r < p ? (rnd() < 0.8 ? 'Failed' : 'Error') : rnd() < 0.015 ? 'Skipped' : rnd() < 0.01 ? 'Incomplete' : 'Passed';
    let cause: string | null = null, category: string | null = null;
    if (status === 'Failed' || status === 'Error') {
      if (dev === FLAKY && rnd() < 0.8) { cause = 'Session ended unexpectedly: the device stopped responding'; category = 'device'; status = 'Error'; }
      else ({ cause, category } = pickCause(t));
    }
    RUNS.push({
      test_id: testId++, name: t.name, status, start_time: new Date(start).toISOString(), duration: Math.round(between(25, 240) * 1000),
      serial: dev?.serial ?? null, deviceName: dev?.name ?? null, deviceOs: dev?.os ?? null, cause, errorCategory: category,
      project: t.project, osVersion: dev?.osVersion ?? null, model: dev?.model ?? null,
    });
  }
}
RUNS.sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));

// ── Counting helpers (what the reporter's grouped counts would return) ──────────────────────────────────────────────
function add(c: StatusCounts, status: string): void {
  const k = ({ Passed: 'passed', Failed: 'failed', Error: 'error', Incomplete: 'incomplete', Skipped: 'skipped', Healed: 'healed' } as const)[status as 'Passed'];
  if (k) c[k]++;
  c.total++;
}
function breakdown(runs: Run[], ...keys: Array<(r: Run) => string | null>): BreakdownRow[] {
  const m = new Map<string, BreakdownRow>();
  for (const r of runs) {
    const values = keys.map((k) => k(r));
    const id = JSON.stringify(values);
    const row = m.get(id) ?? m.set(id, { values, counts: emptyStatusCounts() }).get(id)!;
    add(row.counts, r.status);
  }
  return [...m.values()].sort((a, b) => b.counts.total - a.counts.total);
}
const grouped = (runs: Run[], key: (r: Run) => string | null): GroupCounts => breakdown(runs, key).map((r) => ({ key: r.values[0], counts: r.counts }));
const since = (from: number, to = Infinity) => RUNS.filter((r) => { const t = Date.parse(r.start_time); return t >= from && t < to; });
const isFail = (r: Run) => r.status === 'Failed' || r.status === 'Error';
const rangeStart = (days: number) => dayStart(addDays(NOW, -(days - 1)));

// ── The reports ─────────────────────────────────────────────────────────────────────────────────────────────────────
const reports: Record<string, RecipeResult | { spec: ReportSpec }> = {};

{ // Test summary: 7 days of Mobile Banking, compared with the 7 days before.
  const from = rangeStart(7), prevFrom = from - (NOW - from);
  const mine = RUNS.filter((r) => r.project === 'Mobile Banking');
  const cur = mine.filter((r) => Date.parse(r.start_time) >= from);
  const prev = mine.filter((r) => { const t = Date.parse(r.start_time); return t >= prevFrom && t < from; });
  reports['test-summary'] = buildTestSummary({ runs: cur, previous: prev, failures: cur.filter(isFail), platforms: grouped(cur, (r) => r.deviceOs),
    devicesUsed: new Set(cur.map((r) => r.serial).filter(Boolean)).size, from, to: NOW, days: 7, projectName: 'Mobile Banking', passRateGoal: 90 });
}
{ // Test trend: 90 days, counted per UTC day.
  const from = rangeStart(90), runs = since(from);
  reports['test-trend'] = buildTestTrend({ daysRows: breakdown(runs, (r) => isoDate(Date.parse(r.start_time), true)), platforms: breakdown(runs, (r) => r.deviceOs),
    classes: breakdown(runs, (r) => r.errorCategory), from, to: NOW, days: 90, projectName: 'Mobile Banking', passRateGoal: 90 });
}
{ // Test breakdown: 30 days by test and platform.
  const from = rangeStart(30);
  reports['test-breakdown'] = buildTestBreakdown({ rows: breakdown(since(from), (r) => r.name, (r) => r.deviceOs), keys: ['name', 'device.os'], from, to: NOW, days: 30,
    projectName: 'Mobile Banking', passRateGoal: 90 });
}
const from7 = rangeStart(7), prev7 = addDays(from7, -7);
const byName = (runs: Run[]) => breakdown(runs, (r) => r.name);
reports['test-reliability'] = buildTestReliability({ current: byName(since(from7)), previous: byName(since(prev7, from7)), from: from7, to: NOW, days: 7, projectName: 'Mobile Banking' });
reports['release-readiness'] = buildReleaseReadiness({ current: byName(since(from7)), previous: byName(since(prev7, from7)), platforms: breakdown(since(from7), (r) => r.deviceOs),
  classes: breakdown(since(from7), (r) => r.errorCategory), from: from7, to: NOW, days: 7, projectName: 'Mobile Banking', passRateGoal: 90 });
reports['failure-analysis'] = buildFailureAnalysis({ failures: since(from7).filter(isFail), totalRuns: since(from7).length, from: from7, to: NOW, days: 7, projectName: 'Mobile Banking' });

{ // Test inventory: every report on record by project and user (all time, so larger numbers than the runs above).
  const rows: InventoryRow[] = [];
  const scale: Record<string, number> = { 'Mobile Banking': 41_000, Payments: 23_500, 'Web Store': 17_800, 'QA Sandbox': 2_300 };
  for (const project of PROJECTS) {
    const users = USERS.slice(0, project === 'QA Sandbox' ? 3 : 6).filter(() => rnd() > 0.15);
    for (const user of [...users, null]) {
      const total = Math.round(scale[project] * (user ? between(0.05, 0.35) : 0.04));
      const failRate = project === 'QA Sandbox' ? 0.3 : between(0.06, 0.16);
      const failed = Math.round(total * failRate * 0.8), error = Math.round(total * failRate * 0.2), skipped = Math.round(total * 0.01), incomplete = Math.round(total * 0.005);
      rows.push({ project, user, counts: { ...emptyStatusCounts(), passed: total - failed - error - skipped - incomplete, failed, error, skipped, incomplete, total } });
    }
  }
  reports['test-inventory'] = buildTestInventory({ rows, projects: [...PROJECTS, 'Onboarding Pilot'], reporterOnly: ['Archive 2024'], failed: [], scope: 'all', now: NOW,
    storage: [{ project: 'Mobile Banking', mb: 18_400, quotaMb: 25_000 }, { project: 'Payments', mb: 9_100, quotaMb: 25_000 }, { project: 'Web Store', mb: 26_300, quotaMb: 25_000 },
      { project: 'QA Sandbox', mb: 1_200, quotaMb: 10_000 }] });
}
{ // Device health: today's pool and the last 7 days of runs on it.
  const runs = since(from7).filter((r) => r.serial);
  reports['device-health'] = buildDeviceHealth({ devices: DEVICES, deviceCounts: grouped(runs, (r) => r.serial), failures: runs.filter(isFail), days: 7, now: NOW, projectName: 'Mobile Banking' });
}
{ // Device coverage: 30 days of runs against the pool.
  const from = rangeStart(30), runs = since(from);
  reports['device-coverage'] = buildDeviceCoverage({ devices: DEVICES, byDevice: grouped(runs, (r) => r.serial), byVersion: breakdown(runs, (r) => r.deviceOs, (r) => r.osVersion),
    from, to: NOW, days: 30, projectName: 'Mobile Banking' });
}

// Reserved hours per device and project (Devices Usage), for a range of days.
function deviceUsage(days: number): DeviceUsageRow[] {
  const rows: DeviceUsageRow[] = [];
  for (const d of DEVICES) {
    const demand = d.model === 'iPhone 15' || d.model === 'Galaxy S24' ? 9 : d.model === 'iPad Air' || d.model === 'iPhone 13' ? 0.4 : d.status === 'Offline' ? 0.1 : 3.5;
    for (const project of PROJECTS) {
      if (project === 'Web Store') continue;
      const share = project === 'Mobile Banking' ? 0.6 : project === 'Payments' ? 0.3 : 0.1;
      const hours = NEVER_USED.has(d.serial) || d.model === 'iPad Air' && project !== 'QA Sandbox' ? 0 : Math.round(demand * share * days * between(0.6, 1.4) * 10) / 10;
      rows.push({ device: d.name, deviceId: d.id, os: d.os, osVersion: d.osVersion ?? '', project, hours });
    }
  }
  return rows;
}
reports['device-utilization'] = buildDeviceUtilization({ usage: deviceUsage(30), devices: DEVICES, from: Date.parse(`${isoDate(addDays(NOW, -29), true)}T00:00:00Z`),
  to: Date.parse(`${isoDate(NOW, true)}T23:59:59Z`), days: 30 });

{ // License usage: 14 days of sessions, one row per session.
  const sessions: LicenseSession[] = [];
  const types: Array<{ sessionType: string; licenseType: string; perDay: number; hours: [number, number] }> = [
    { sessionType: 'Mobile execution', licenseType: 'Dedicated Devices', perDay: 170, hours: [0.05, 0.4] },
    { sessionType: 'Manual testing', licenseType: 'Dedicated Devices', perDay: 14, hours: [0.3, 2.5] },
    { sessionType: 'Development', licenseType: 'Dedicated Devices', perDay: 8, hours: [0.5, 3] },
    { sessionType: 'Browsers', licenseType: 'Browsers', perDay: 90, hours: [0.03, 0.3] },
    { sessionType: 'Shared Devices', licenseType: 'Shared Devices', perDay: 12, hours: [0.2, 1.5] },
    { sessionType: 'Virtual Devices', licenseType: 'Virtual Devices', perDay: 20, hours: [0.1, 0.8] },
  ];
  const first = Date.parse(`${isoDate(addDays(NOW, -13), true)}T00:00:00Z`);
  for (let d = 0; d < 14; d++) {
    const day = first + d * DAY, weekend = [0, 6].includes(new Date(day).getUTCDay());
    for (const t of types) {
      const n = Math.round(t.perDay * (weekend ? 0.25 : between(0.8, 1.25)) * (d === 13 ? 0.5 : 1));
      for (let k = 0; k < n; k++) {
        // Most sessions in working hours across the three regions; a peak in the US afternoon / EU evening overlap.
        const start = day + (rnd() < 0.6 ? between(13, 18) : between(1, 23)) * HOUR;
        if (start > NOW) continue;
        sessions.push({ start, end: Math.min(NOW, start + between(t.hours[0], t.hours[1]) * HOUR), sessionType: t.sessionType, licenseType: t.licenseType,
          project: t.licenseType === 'Browsers' ? 'Web Store' : pick(['Mobile Banking', 'Mobile Banking', 'Payments', 'QA Sandbox']) });
      }
    }
  }
  reports['license-usage'] = buildLicenseUsage({ sessions, limits: { dedicatedDevices: 30, sharedDevices: 8, virtualDevices: 20, browsers: 25 }, from: first,
    to: Date.parse(`${isoDate(NOW, true)}T23:59:59Z`), days: 14 });
}
{ // Usage summary: 90 days of reservations of one project.
  const rows: ReservationRow[] = [];
  const first = Date.parse(`${isoDate(addDays(NOW, -89), true)}T00:00:00Z`);
  for (let d = 0; d < 90; d++) {
    const day = first + d * DAY, weekend = [0, 6].includes(new Date(day).getUTCDay());
    const n = Math.round((weekend ? between(2, 6) : between(14, 26)) * (1 + d / 180));
    for (let k = 0; k < n; k++) {
      const dev = pick(RUN_DEVICES.filter((x) => x.model !== 'iPad Air'));
      rows.push({ start: day + between(7, 20) * HOUR, hours: Math.round(between(0.2, rnd() < 0.15 ? 6 : 2) * 100) / 100, user: pick(USERS.slice(0, 6)), device: dev.name,
        deviceDetail: `${dev.model}, ${dev.os} ${dev.osVersion}`, project: 'Mobile Banking' });
    }
  }
  reports['usage-summary'] = buildUsageSummary({ rows, from: first, to: Date.parse(`${isoDate(NOW, true)}T23:59:59Z`), recentDays: 30, projectName: 'Mobile Banking' });
}
{ // Usage overview: every project, 30 days, with users and their tags.
  const users: UserUsageRow[] = [];
  const tags: Record<string, string> = { 'ana@example.com': 'Mobile Team', 'ben@example.com': 'Mobile Team', 'chen@example.com': 'Payments Team', 'dara@example.com': 'Payments Team, QA',
    'eli@example.com': 'QA', 'fatima@example.com': 'Mobile Team' };
  for (const user of USERS) for (const project of PROJECTS) {
    if (project === 'Web Store' || rnd() < 0.35) continue;
    users.push({ user, project, hours: Math.round(between(2, 90) * 10) / 10, tags: tags[user] ?? '' });
  }
  reports['usage-overview'] = buildUsageOverview({ devices: deviceUsage(30), recentDevices: deviceUsage(7), users, from: Date.parse(`${isoDate(addDays(NOW, -29), true)}T00:00:00Z`),
    to: Date.parse(`${isoDate(NOW, true)}T23:59:59Z`), recentDays: 7 });
}
{ // Performance overview: 30 days of performance transactions of the banking app.
  const tx: Transaction[] = [];
  const names: Array<[string, number, number]> = [['Login', 1400, 3200], ['Account overview', 2100, 4100], ['Transfer money', 2600, 5200], ['Pay a bill', 1900, 3900], ['Open statement', 3300, 6800]];
  const perfDevices = RUN_DEVICES.filter((d) => ['Pixel 8', 'Galaxy S24', 'iPhone 15', 'iPhone 14'].includes(d.model)).slice(0, 8);
  let id = 9001;
  for (let k = 0; k < 140; k++) {
    const [name, si, ms] = pick(names);
    const dev = pick(perfDevices);
    const daysAgo = between(0, 29);
    const appVersion = daysAgo < 12 ? '4.3.0' : '4.2.0';
    const profile = pick(['Monitor', 'Monitor', '4G-average', '3G-poor']);
    const slow = (profile === '3G-poor' ? 1.8 : profile === '4G-average' ? 1.2 : 1) * (appVersion === '4.3.0' && name === 'Transfer money' ? 1.35 : 1) * (dev.os === 'iOS' ? 0.9 : 1);
    const noTelemetry = rnd() < 0.06;
    const t = NOW - daysAgo * DAY;
    tx.push({
      id: id++, name, appName: 'com.example.mobilebank', appVersion, startTime: new Date(t).toISOString(), date: isoDate(t, true), deviceUid: dev.serial, deviceName: dev.name,
      deviceModel: dev.model, deviceOs: dev.os, deviceManufacturer: dev.manufacturer ?? '', deviceVersion: dev.osVersion ?? '', deviceScreen: '1080 x 2400', deviceType: 'PHONE',
      networkProfile: profile, cpuAvg: noTelemetry ? null : Math.round(between(8, 35) * 10) / 10, cpuMax: noTelemetry ? null : Math.round(between(40, 90)), cpuCoreCount: 8,
      memAvg: noTelemetry ? null : Math.round(between(180, 420)), memMax: noTelemetry ? null : Math.round(between(420, 600)), memTotalInBytes: null, batteryAvg: null, batteryMax: null,
      totalUploadedBytes: int(20_000, 400_000), totalDownloadedBytes: int(200_000, 4_000_000), duration: Math.round(ms * slow * between(0.85, 1.2)),
      speedIndex: rnd() < 0.05 ? null : Math.round(si * slow * between(0.85, 1.2)), videoStart: null, videoEnd: null, userName: pick(USERS.slice(0, 4)), testId: null,
      attachmentId: null, attachmentPath: null, projectId: 1, projectName: 'Mobile Banking', attachmentList: null,
    } as Transaction);
  }
  const from = rangeStart(30);
  reports['performance-overview'] = buildPerformanceOverview({ transactions: tx, total: tx.length + 64, newest: Math.max(...tx.map((x) => Date.parse(x.startTime))), from, to: NOW,
    days: 30, projectName: 'Mobile Banking' });
}
{ // A report of any data: what render_report draws from an agent's own outline (here: the app repository).
  const spec: ReportSpec = {
    title: 'Applications in the Repository',
    subtitle: 'Every build uploaded to the app repository, by platform and project',
    meta: [{ label: 'Date', value: 'Nov. 20, 2026' }, { label: 'Builds', value: '64' }],
    headline: { value: '64', label: 'Builds' },
    sections: [
      { title: 'At a Glance', blocks: [{ type: 'kpis', items: [
        { value: 64, label: 'Builds' }, { value: 9, label: 'Distinct apps', accent: 'teal' }, { value: 38, label: 'Android builds', accent: 'teal' },
        { value: 26, label: 'iOS builds', accent: 'teal' }, { value: 21, label: 'Older than 90 days', accent: 'fail' }] }] },
      { title: 'Builds by Platform', columns: 2, blocks: [
        { type: 'share', value: 64, label: 'builds', parts: [{ label: 'Android', value: 38 }, { label: 'iOS', value: 26 }] },
        { type: 'bar', orientation: 'horizontal', categories: ['Mobile Banking', 'Payments', 'QA Sandbox', 'Web Store'], series: [
          { name: 'Android', values: [18, 11, 7, 2] }, { name: 'iOS', values: [13, 8, 4, 1] }], stacked: true }],
        whatItMeans: 'Mobile Banking holds almost half of all builds. Android builds outnumber iOS builds in every project, mostly because each Android release is uploaded as a debug and a release build.' },
      { title: 'Uploads per Month', blocks: [{ type: 'line', categories: ['June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.'], series: [
        { name: 'Android', values: [4, 5, 6, 7, 8, 8] }, { name: 'iOS', values: [3, 3, 4, 5, 5, 6] }] }],
        whatItMeans: 'Uploads have doubled since June, in step with the move to a release every two weeks.' },
      { title: 'Largest Apps', blocks: [{ type: 'table', columns: [
        { key: 'app', label: 'App' }, { key: 'platform', label: 'Platform' }, { key: 'version', label: 'Latest version', format: 'mono' },
        { key: 'builds', label: 'Builds', format: 'number' }, { key: 'size', label: 'Size', format: 'number', unit: 'MB', decimals: 1 }],
        rows: [
          { app: 'Mobile Bank', platform: 'Android', version: '4.3.0 (812)', builds: 14, size: 61.4 },
          { app: 'Mobile Bank', platform: 'iOS', version: '4.3.0 (812)', builds: 11, size: 88.2 },
          { app: 'Pay Wallet', platform: 'Android', version: '2.8.1 (305)', builds: 9, size: 38.7 },
          { app: 'Pay Wallet', platform: 'iOS', version: '2.8.1 (305)', builds: 7, size: 52.0 },
          { app: 'Store Companion', platform: 'Android', version: '1.4.0 (77)', builds: 2, size: 24.9 },
        ] }],
        whatItMeans: 'The iOS builds are about 40% larger than the Android builds of the same version; 21 builds are older than 90 days and are candidates for cleanup.' },
    ],
    source: 'Source: the application repository, 64 builds. Example data.',
  };
  reports['any-data'] = { spec };
}

// ── Write ───────────────────────────────────────────────────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
for (const [name, r] of Object.entries(reports)) {
  const html = renderReport({ ...r.spec, generatedAt: GENERATED, timeZone: 'UTC' });
  writeFileSync(join(OUT, `${name}.html`), html);
  console.log(`${name}.html  ${(html.length / 1024).toFixed(1)} KB${'highlights' in r ? `  | ${r.highlights[0] ?? ''}` : ''}`);
}

// ── Safety scan: nothing that looks like a real tenant, key or address ─────────────────────────────────────────────
const RULES: Array<[string, RegExp]> = [
  ['experitest', /experitest/i], ['uscloud', /uscloud/i], ['@digital.ai', /@digital\.ai/i], ['digital.ai/ URL', /digital\.ai\//i],
  ['email outside example.com', /[\w.+-]+@(?!example\.com\b)[\w-]+\.[\w.-]+/i], ['aut_ key', /aut_\d/i], ['JWT', /eyJ[\w-]{10,}/],
];
let problems = 0;
for (const f of readdirSync(OUT).filter((x) => x.endsWith('.html'))) {
  const text = readFileSync(join(OUT, f), 'utf8');
  for (const [label, re] of RULES) {
    const m = text.match(re);
    if (m) { problems++; console.log(`SAFETY: ${f}: ${label}: "${m[0]}"`); }
  }
}
console.log(problems ? `Safety scan: ${problems} finding(s).` : 'Safety scan: clean (no tenant hosts, company addresses, keys or non-example emails).');
if (problems) process.exitCode = 1;
