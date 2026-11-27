/**
 * App exploration, stage 1: a READ-ONLY crawl of the user's app into a manifest, run on the server as a background job
 * (an agent driving it call by call would spend hundreds of calls and element trees in tokens). Pure parts live in
 * src/utils/app-exploration.ts; this file drives the inspection session.
 *
 * Safety (owner decisions 2026-11-27): only navigation taps from the allow-list are made. Taps that could write data are
 * recorded, never made, in stage 1 (a later stage asks once per session whether write paths may be pursued); destructive
 * taps always need the user's confirmation one by one. A login is done only with a test login the user named.
 */
import { createInspectionSession, quitInspectionSession, getPageSource, findFirstElementId, tapElement, typeIntoElement, pressBack, launchApp, appControl, getForegroundActivity, getForegroundPackage } from './webdriver.js';
import { parseScreen, screenSignature, isLoading, candidateTaps, locatorFor, loginParts, screenTitle, type ExplorePlatform, type Locator, type ScreenElement, type TapClass } from '../utils/app-exploration.js';

export interface ExploreTarget {
  platform: ExplorePlatform;
  /** Android package or iOS bundle id. */
  appId: string;
  /** Android launch activity. */
  activity?: string;
  /** Repository app id and version, recorded in the manifest. */
  repositoryId?: number;
  version?: string;
  deviceQuery?: string;
  region?: string;
}

export interface ExploreOptions {
  maxScreens: number;
  maxMinutes: number;
  maxDepth: number;
  /** The user's answer at the start: may paths that could write data be followed? Destructive taps never are. */
  allowWritePaths: boolean;
  /** A test login, read by the server (never through the model). */
  login?: { username: string; password: string; source: string };
}

export interface ManifestStep { label: string; locator: Locator }
export interface ManifestScreen {
  signature: string;
  title: string;
  foreground: string | null;
  /** How to get here from the start screen. */
  path: ManifestStep[];
  elements: number;
  /** Locators worth asserting on: unique ids and visible texts. */
  assertable: Array<{ label: string; locator: Locator }>;
  navigation: Array<{ label: string; locator: Locator | null; leadsTo?: string; note?: string; settleMs?: number }>;
  /** How long the screen took to stop changing after the tap that first reached it (ms). */
  settleMs?: number;
  /** It never stopped changing within the settle limit (animation, ticker, endless loader). */
  unstable?: true;
  notVisited: Array<{ label: string; kind: TapClass; reason: string }>;
  login?: 'done' | 'needed';
}
export interface Manifest {
  app: { platform: ExplorePlatform; appId: string; activity?: string; repositoryId?: number; version?: string };
  device: { name: string; os: string; version: string };
  startedAt: string;
  finishedAt?: string;
  stoppedBecause: string;
  screens: ManifestScreen[];
  taps: number;
  notes: string[];
  /** Settle times of every transition, for the wait timeouts of generated tests. */
  timing?: { transitions: number; medianSettleMs: number; slowestSettleMs: number; unstable: number };
}

/** Settle reads: first look after this long, then every poll until two reads match; give up after the max. */
const SETTLE_FIRST_MS = 400;
const SETTLE_POLL_MS = 400;
const SETTLE_MAX_MS = 10_000;
const SETTLE_LAUNCH_MS = 20_000;

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelled')); }, { once: true });
});
const labelOf = (e: ScreenElement) => (e.text ?? e.description ?? e.innerText ?? e.id ?? e.type.split('.').pop() ?? '?').slice(0, 60);

/** Crawls the app read-only and returns its manifest. `progress` reports what is happening; `signal` cancels. */
export async function exploreApp(target: ExploreTarget, opts: ExploreOptions, progress: (t: string) => void, signal: AbortSignal): Promise<Manifest> {
  const started = Date.now();
  const deadline = started + opts.maxMinutes * 60_000;
  const p = target.platform;
  progress('starting an inspection session');
  const session = await createInspectionSession({
    platform: p, deviceQuery: target.deviceQuery, region: target.region, testName: `App exploration: ${target.appId}`,
    ...(p === 'android' ? { app: `cloud:${target.appId}${target.activity ? `/${target.activity}` : ''}`, appPackage: target.appId, ...(target.activity ? { appActivity: target.activity } : {}) } : { app: `cloud:${target.appId}`, appPackage: target.appId }),
  });
  const h = session.handle;
  const manifest: Manifest = {
    app: { platform: p, appId: target.appId, activity: target.activity, repositoryId: target.repositoryId, version: target.version },
    device: { name: session.deviceName, os: session.deviceOs, version: session.deviceVersion },
    startedAt: new Date(started).toISOString(), stoppedBecause: 'finished: every reachable screen within the limits was visited', screens: [], taps: 0, notes: [],
  };
  const bySig = new Map<string, ManifestScreen>();
  let stop: string | null = null;
  const overBudget = () => {
    if (signal.aborted) return 'cancelled';
    if (Date.now() > deadline) return `the time budget (${opts.maxMinutes} min) was reached`;
    if (manifest.screens.length >= opts.maxScreens) return `the screen budget (${opts.maxScreens}) was reached`;
    return null;
  };

  const read = async () => {
    const xml = await getPageSource(h);
    const els = parseScreen(xml, p);
    const fg = p === 'android' ? await getForegroundActivity(h).catch(() => null) : null;
    const pkg = p === 'android' ? await getForegroundPackage(h).catch(() => null) : null;
    return { els, fg, pkg, sig: screenSignature(els, fg) };
  };
  type Read = Awaited<ReturnType<typeof read>> & { settleMs: number; settled: boolean };
  const settleTimes: number[] = [];
  let unstableCount = 0;
  // Reads until the screen's structure stops changing (two equal reads in a row, no loader), instead of a fixed sleep:
  // a slow screen read half-drawn would be recorded as a screen of its own, and a fixed wait long enough for the
  // slowest screen wastes time on every fast one. A progress indicator that never goes away (a determinate bar) is
  // accepted once the rest has been the same for four reads. settleMs = when the final state was first seen.
  const settle = async (maxMs = SETTLE_MAX_MS): Promise<Read> => {
    const t0 = Date.now();
    await sleep(SETTLE_FIRST_MS, signal);
    let prev = await read();
    let prevAt = Date.now() - t0;
    let same = 0;
    while (Date.now() - t0 < maxMs) {
      await sleep(SETTLE_POLL_MS, signal);
      const cur = await read();
      if (cur.sig === prev.sig) {
        same++;
        if (!isLoading(cur.els) || same >= 4) { settleTimes.push(prevAt); return { ...cur, settleMs: prevAt, settled: true }; }
      } else { same = 0; prev = cur; prevAt = Date.now() - t0; }
    }
    unstableCount++;
    return { ...prev, settleMs: Date.now() - t0, settled: false };
  };
  const tapBy = async (loc: Locator): Promise<Read | null> => {
    const id = await findFirstElementId(h, loc.using, loc.value);
    if (!id) return null;
    await tapElement(h, id);
    manifest.taps++;
    return settle();
  };
  // A text field's own locator is often empty in Compose / SwiftUI apps: fall back to its position among the fields
  // (used inside the crawl only, never written into a delivered test).
  const fieldLocator = (els: ScreenElement[], e: ScreenElement): Locator => {
    const own = e.id ? locatorFor(e, p) : null;
    if (own) return own;
    const fields = els.filter((x) => /EditText|TextField|SecureTextField/.test(x.type));
    const cls = p === 'android' ? "contains(@class,'EditText')" : "(self::XCUIElementTypeTextField or self::XCUIElementTypeSecureTextField)";
    return { using: 'xpath', value: `(//*[${cls}])[${fields.indexOf(e) + 1}]` };
  };
  const doLogin = async (els: ScreenElement[]): Promise<boolean> => {
    const parts = loginParts(els);
    if (!parts || !opts.login) return false;
    const userId = await findFirstElementId(h, ...Object.values(fieldLocator(els, parts.user)) as [string, string]);
    const passId = await findFirstElementId(h, ...Object.values(fieldLocator(els, parts.password)) as [string, string]);
    if (!userId || !passId) return false;
    await typeIntoElement(h, userId, opts.login.username);
    await typeIntoElement(h, passId, opts.login.password);
    const submit = parts.submit ? locatorFor(parts.submit, p) : null;
    if (submit) await tapBy(submit);
    else await settle();
    return true;
  };
  const relaunch = async (path: ManifestStep[]) => {
    await appControl(h, 'terminate', target.appId).catch(() => undefined);
    await launchApp(h, target.appId, target.activity);
    let s: Read | null = await settle(SETTLE_LAUNCH_MS);
    if (loginParts(s.els) && opts.login) { await doLogin(s.els); s = await settle(); }
    for (const step of path) { s = await tapBy(step.locator); if (!s) return null; }
    return s;
  };

  const record = (s: Awaited<ReturnType<typeof read>> & Partial<Pick<Read, 'settleMs' | 'settled'>>, path: ManifestStep[], login?: ManifestScreen['login']): ManifestScreen => {
    const { taps, unvisited } = candidateTaps(s.els, opts.allowWritePaths);
    const assertable = s.els.filter((e) => (e.id || (e.text && e.text.length <= 60)) && !/EditText|TextField/.test(e.type))
      .map((e) => ({ label: labelOf(e), locator: locatorFor(e, p) })).filter((a): a is { label: string; locator: Locator } => !!a.locator).slice(0, 25);
    const screen: ManifestScreen = {
      signature: s.sig, title: screenTitle(s.els), foreground: s.fg, path, elements: s.els.length, assertable,
      navigation: taps.map((t) => ({ label: labelOf(t.element) + (t.collapsed ? ` (+${t.collapsed} similar rows)` : ''), locator: locatorFor(t.element, p) })),
      notVisited: unvisited.map((u) => ({ label: labelOf(u.element), kind: u.kind, reason: u.reason })).slice(0, 40),
      ...(login ? { login } : {}),
      ...(s.settleMs !== undefined && path.length ? { settleMs: s.settleMs } : {}),
      ...(s.settled === false ? { unstable: true as const } : {}),
    };
    bySig.set(s.sig, screen);
    manifest.screens.push(screen);
    progress(`${manifest.screens.length} screen(s), ${manifest.taps} tap(s): ${screen.title}`);
    return screen;
  };

  const visit = async (screen: ManifestScreen, depth: number): Promise<void> => {
    if (depth >= opts.maxDepth) { manifest.notes.push(`"${screen.title}": not explored further (depth limit ${opts.maxDepth})`); return; }
    for (const nav of screen.navigation) {
      if ((stop = overBudget())) return;
      if (!nav.locator) { nav.note = 'no stable locator: not tapped'; continue; }
      let here: Awaited<ReturnType<typeof read>> = await read();
      if (here.sig !== screen.signature) {
        const back = await relaunch(screen.path);
        if (!back || back.sig !== screen.signature) { manifest.notes.push(`"${screen.title}" could not be reached again; its remaining taps were skipped`); return; }
        here = back;
      }
      const next = await tapBy(nav.locator);
      if (!next) { nav.note = 'not found when tapped'; continue; }
      nav.settleMs = next.settleMs;
      if (!next.settled) nav.note = `the screen kept changing for ${Math.round(next.settleMs / 1000)} s (animation or endless loader): recorded as it was then`;
      if (p === 'android' && next.pkg && next.pkg !== target.appId) {
        nav.note = `opens another app (${next.pkg}): not followed`;
        await relaunch(screen.path);
        continue;
      }
      if (next.sig === screen.signature) { nav.note = 'stays on this screen'; continue; }
      const known = bySig.get(next.sig);
      if (known) { nav.leadsTo = known.title; }
      else {
        const child = record(next, [...screen.path, { label: nav.label, locator: nav.locator }]);
        nav.leadsTo = child.title;
        await visit(child, depth + 1);
        if (stop) return;
      }
      await pressBack(h).catch(() => undefined);
      await settle();
    }
  };

  try {
    let first: Awaited<ReturnType<typeof read>> = await settle(SETTLE_LAUNCH_MS);
    // The app must be in front before anything is recorded: one live run (2026-11-27) read the phone's launcher at the
    // start. Launch it once more; if it is still not in front, stop rather than map another app.
    if (p === 'android' && first.pkg && first.pkg !== target.appId) {
      manifest.notes.push(`At the start ${first.pkg} was in front, not the app; it was launched again.`);
      await launchApp(h, target.appId, target.activity).catch(() => undefined);
      first = await settle(SETTLE_LAUNCH_MS);
      if (first.pkg && first.pkg !== target.appId) {
        manifest.stoppedBecause = `the app did not come to the front (${first.pkg} stayed in front): it may have crashed at start; try another device`;
        return manifest;
      }
    }
    let login: ManifestScreen['login'] | undefined;
    if (loginParts(first.els)) {
      if (opts.login && await doLogin(first.els)) {
        record(first, [], 'done');
        login = 'done';
        first = await settle();
        if (loginParts(first.els)) manifest.notes.push(`The test login (${opts.login.source}) did not get past the login screen: check it.`);
      } else {
        record(first, [], 'needed');
        manifest.stoppedBecause = 'a login screen: the app could not be explored past it without a test login';
        manifest.notes.push('Give a test login to explore past the login screen (the login is read by the server, never typed through the chat).');
        return manifest;
      }
    }
    const root = bySig.get(first.sig) ?? record(first, []);
    if (login === 'done' && root.path.length === 0) root.path = [];
    await visit(root, 0);
    if (stop) manifest.stoppedBecause = stop;
    return manifest;
  } finally {
    if (settleTimes.length) {
      const sorted = [...settleTimes].sort((x, y) => x - y);
      manifest.timing = { transitions: sorted.length, medianSettleMs: sorted[Math.floor(sorted.length / 2)], slowestSettleMs: sorted[sorted.length - 1], unstable: unstableCount };
    }
    manifest.finishedAt = new Date().toISOString();
    await quitInspectionSession(h).catch(() => undefined);
  }
}
