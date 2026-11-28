import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getApplicationInfo, getApplications } from '../api/applications.js';
import { getMyAccountInfo } from '../api/users.js';
import { exploreApp, type Manifest, type LoginRef } from '../api/app-crawl.js';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposeFlows, type ProposedFlow } from '../utils/exploration-flows.js';
import { explorationRuns } from '../api/exploration-runs.js';
import { respond, outputFormatParam } from '../utils/output-format.js';
import { resolveAppLogin } from '../utils/app-logins.js';
import { setupCommand } from '../cli/clients.js';

/**
 * App exploration, stage 1 (2.6.0): map the USER'S app read-only into a manifest of screens, navigation and verified
 * locators, so the placeholder steps of a boilerplate can be written from what is really on the app. The first input is
 * always the app, its version and its OS (owner decision 2026-11-27); it is never the sample app outside a demo.
 * Runs as a background job in this server process; the agent checks status. See src/api/app-crawl.ts.
 */
interface Job { id: string; status: 'running' | 'done' | 'failed' | 'cancelled'; startedAt: number; progress: string; manifest?: Manifest; error?: string; abort: AbortController; label: string; savedTo?: string }
const jobs = new Map<string, Job>();

/**
 * Finished manifests are saved in the temp folder (never the user's documents), so a resume works after a server or client
 * restart. They hold screens, routes and locators, never a login value (only the login's NAME or variable names).
 */
export function explorationDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MCP_EXPLORATION_DIR?.trim() || join(tmpdir(), 'digital-ai-testing-explorations');
}
function saveManifest(id: string, m: Manifest): string | undefined {
  try {
    const dir = explorationDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.json`);
    writeFileSync(file, JSON.stringify(m, null, 2), 'utf8');
    return file;
  } catch { return undefined; }
}
export function loadManifest(id: string): Manifest | undefined {
  const inMemory = jobs.get(id)?.manifest;
  if (inMemory) return inMemory;
  if (!/^explore-[a-z0-9]+$/.test(id)) return undefined;
  const file = join(explorationDir(), `${id}.json`);
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, 'utf8')) as Manifest; } catch { return undefined; }
}

function summary(m: Manifest): string {
  const lines = [
    `App ${m.app.appId}${m.app.version ? ` version ${m.app.version}` : ''} (${m.app.platform}) on ${m.device.name} (${m.device.os} ${m.device.version}).`,
    `${m.screens.length} screen(s), ${m.taps} tap(s)${(m.runs ?? 1) > 1 ? ` over ${m.runs} runs` : ''}. Stopped: ${m.stoppedBecause}.`,
    ...(m.frontier?.length ? [`Not yet followed: ${m.frontier.length} route(s), e.g. ${m.frontier.slice(0, 4).map((f) => `${f.label} on ${f.screen}`).join('; ')}. To continue: start_app_exploration with resumeFrom (and the same test login); screens already mapped are kept.`] : []),
    ...(m.timing ? [`Render timing: screens settled in ${(m.timing.medianSettleMs / 1000).toFixed(1)} s typically, ${(m.timing.slowestSettleMs / 1000).toFixed(1)} s at the slowest (${m.timing.transitions} transitions${m.timing.unstable ? `; ${m.timing.unstable} never stopped changing` : ''}). Generated tests wait for an element of the next screen (explicit waits, never sleeps), with a timeout well above the slowest.`] : []),
    '',
    ...m.screens.map((s, i) => {
      const route = s.path.length ? ` — reached by: ${s.path.map((p) => p.label).join(' → ')}` : ' — start screen';
      const nav = s.navigation.length ? `\n   navigation: ${s.navigation.map((n) => `${n.label}${n.leadsTo ? ` → ${n.leadsTo}` : n.note ? ` (${n.note})` : ''}`).join('; ')}` : '';
      const nv = s.notVisited.length ? `\n   not tapped: ${s.notVisited.slice(0, 8).map((n) => `${n.label} (${n.kind})`).join('; ')}${s.notVisited.length > 8 ? ` … +${s.notVisited.length - 8}` : ''}` : '';
      return `${i + 1}. ${s.title}${s.login ? ` [login ${s.login}]` : ''}${route}${nav}${nv}`;
    }),
    ...(m.notes.length ? ['', 'Notes:', ...m.notes.map((n) => `- ${n}`)] : []),
    '',
    'Next: confirm with the user which flows matter (use cases), then write test steps ONLY from these locators (assertable and navigation, outputFormat json), into the framework structure from get_test_boilerplate, and validate_test_script.',
  ];
  return lines.join('\n');
}

export function registerExplorationTools(server: McpServer): void {
  server.tool(
    'start_app_exploration',
    'App exploration (map my app, crawl the app, discover its screens): opens a session on a real device and maps THE USER\'S app ' +
    'read-only into a manifest of screens, how to reach each one, the navigation between them and locators verified on the app. ' +
    'Use it to turn the placeholder steps of get_test_boilerplate into steps from the real app. The FIRST input is always the ' +
    'user\'s app, its version and its OS: ask for them; never explore a sample app unless the user is learning with the demo. ' +
    'Runs in the background (default budget 30 minutes / 40 screens, one device held meanwhile): answers at once with a jobId; ' +
    'END YOUR TURN and check app_exploration_status later. BEFORE starting, ask the user ONE question for the whole session: may ' +
    'it follow paths that could write data (allowWritePaths)? No (default): only navigation (tabs, menus, list rows, back) is ' +
    'tapped. Yes: buttons whose effect is unknown and write paths (pay, transfer, save) may be tapped too — but nothing is ever ' +
    'typed or submitted with data. Destructive actions (delete, remove, reset, sign out) are NEVER tapped by the crawl: each needs ' +
    'the user\'s own confirmation, so they are listed for the user. Switches and text fields are never touched. A login screen stops ' +
    'it unless the user named a test login: testLogin = the NAME of a login the user saved in a terminal with "setup app-login <name>" ' +
    '(password in the OS keychain), or loginUserEnv / loginPasswordEnv = names of environment variables set in this server\'s ' +
    'configuration. Never ask the user to type a password into the chat, and never repeat one. A large app: raise maxScreens / ' +
    'maxMinutes / maxDepth when the user asks for a deeper scan, or map it in chunks: a run that stops on its budget can be ' +
    'continued with resumeFrom = its jobId (also after a restart); only routes not yet followed are explored.',
    {
      platform: z.enum(['android', 'ios']).describe('The app\'s OS.'),
      appId: z.number().int().optional().describe('The app in the repository (list_applications): its package / bundle id, activity and version come from the record.'),
      packageName: z.string().optional().describe('Android package, when there is no repository id. Needs appVersion.'),
      mainActivity: z.string().optional().describe('Android launch activity, with packageName.'),
      bundleIdentifier: z.string().optional().describe('iOS bundle id, when there is no repository id. Needs appVersion.'),
      installedApp: z.boolean().optional().describe('The app is already on the phones (preinstalled like Google Maps or Apple Maps, or installed outside the repository): give packageName / bundleIdentifier; it is launched, never installed, and its version is read from the phone (Android). A phone without it stops the run with that reason.'),
      appVersion: z.string().optional().describe('The version being explored (from the record when appId is given).'),
      deviceQuery: z.string().optional().describe('Device query, e.g. "@os=\'android\' and @model=\'SM-G981U\'". Default: a free phone of the platform.'),
      region: z.string().optional().describe('Region code from find_available_device.'),
      maxScreens: z.number().int().min(1).max(200).optional().describe('Stop after this many screens (default 40).'),
      maxMinutes: z.number().int().min(2).max(120).optional().describe('Stop after this many minutes (default 30, up to 120). For more, continue with resumeFrom.'),
      maxDepth: z.number().int().min(1).max(10).optional().describe('How many taps deep from the start screen (default 6).'),
      resumeFrom: z.string().regex(/^explore-[a-z0-9]+$/).optional().describe('jobId of an earlier exploration of the SAME app to continue: its screens are kept and only the routes it did not follow are explored. The app and version come from it; give the same testLogin (or it is read from the earlier run).'),
      allowWritePaths: z.boolean().describe('The USER\'s answer, asked once at the start: may the crawl follow paths that could write data? Never covers destructive actions.'),
      testLogin: z.string().optional().describe('NAME of a test login the user saved with "setup app-login <name>" (e.g. "daibank"). The server reads it; the password is never returned.'),
      loginUserEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional().describe('NAME of the environment variable on the server that holds the test login\'s user name (e.g. "DAIBANK_USER"). With loginPasswordEnv.'),
      loginPasswordEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional().describe('NAME of the environment variable that holds its password. The value is read by the server and never returned.'),
      outputFormat: outputFormatParam,
    },
    async (a) => {
      try {
        if (a.installedApp && a.appId !== undefined) throw new Error('installedApp is for an app that is NOT in the repository: give packageName / bundleIdentifier instead of appId (a repository app is installed by the session).');
        if (a.installedApp && !(a.platform === 'android' ? a.packageName : a.bundleIdentifier)) throw new Error('installedApp needs packageName (Android) or bundleIdentifier (iOS).');
        const prev = a.resumeFrom ? loadManifest(a.resumeFrom) : undefined;
        if (a.resumeFrom && !prev) throw new Error(`no saved exploration ${a.resumeFrom} (looked in this server run and in ${explorationDir()}). Start a new exploration instead.`);
        if (prev && prev.app.platform !== a.platform) throw new Error(`exploration ${a.resumeFrom} is of a ${prev.app.platform} app, not ${a.platform}.`);
        if (prev && !prev.screens.length) throw new Error(`exploration ${a.resumeFrom} mapped no screens (${prev.stoppedBecause}), so there is nothing to continue: start a new exploration${/front|crash/.test(prev.stoppedBecause) ? ` on another phone (it ran on ${prev.device.name})` : ''}.`);
        if (prev && !prev.frontier?.length) throw new Error(`exploration ${a.resumeFrom} has no routes left to follow: it is complete within its depth limit${prev.settings ? ` (${prev.settings.maxDepth} taps)` : ''}. A larger maxDepth needs a new exploration.`);
        let appIdStr = prev ? prev.app.appId : a.platform === 'android' ? a.packageName : a.bundleIdentifier;
        let activity = a.mainActivity;
        let version = a.appVersion;
        let pin: { appReleaseVersion?: string; appBuildVersion?: string } = a.appVersion && !a.installedApp ? { appReleaseVersion: a.appVersion } : {};
        const buildNotes: string[] = [];
        let appRef: string | undefined;
        if (prev) {
          activity = prev.app.activity;
          appRef = prev.app.appRef;
          version = prev.app.version;
          pin = { appReleaseVersion: prev.app.appReleaseVersion, appBuildVersion: prev.app.appBuildVersion };
        } else if (a.appId !== undefined) {
          const app = await getApplicationInfo(a.appId).catch((e: Error) => { throw new Error(`application ${a.appId} was not found: ${e.message}. Ask the user which app to explore; no other app is used in its place.`); });
          appIdStr = (a.platform === 'android' ? app.packageName : app.bundleIdentifier) ?? undefined;
          if (!appIdStr) throw new Error(`application ${a.appId} has no ${a.platform === 'android' ? 'Android package' : 'iOS bundle id'}: check the platform.`);
          activity = activity ?? app.mainActivity ?? undefined;
          version = version ?? app.releaseVersion ?? app.buildVersion ?? undefined;
          // The platform installs a build by package + version, not by repository id, and only from the session's own
          // project. Desktop test 2026-11-27: the agent chose a build of another project, the crawl installed the
          // project's own build of the same package, and the manifest named the wrong one.
          const project = await getMyAccountInfo().then((i) => i.project?.name).catch(() => undefined);
          const assigned = (app.projectsInfo ?? []).map((x) => x.name);
          if (project && assigned.length && !assigned.includes(project)) {
            const here = await getApplications({ packageName: appIdStr }).then((l) => l.filter((x) => (x.projectsInfo ?? []).some((q) => q.name === project))).catch(() => []);
            throw new Error(`build ${a.appId} is assigned to ${assigned.join(', ')}, not to the active project ${project}: a session here can only install that project's builds${here.length ? ` (${here.map((x) => `${x.id}: version ${x.releaseVersion ?? '?'} build ${x.buildVersion ?? '?'}`).join('; ')})` : ' (it has none of this app)'}. Explore one of those, or switch_environment to a profile of ${assigned.join(' / ')}.`);
          }
          pin = { appReleaseVersion: app.releaseVersion ?? undefined, appBuildVersion: app.buildVersion ?? undefined };
          // The exact build: by its unique name when no other build of this app in the project has it (verified live
          // 2026-11-27: "cloud:uniqueName=DAI-Bankv1.0" installed that build; an unknown name is refused "… was not
          // found"). Builds with one version can still differ (UICatalog: four signed variants of 1.0 build 11908, one of
          // which never starts), so version alone is only the fallback.
          const inProject = project ? await getApplications({ packageName: appIdStr }).then((l) => l.filter((x) => (x.projectsInfo ?? []).some((q) => q.name === project))).catch(() => []) : [];
          const uniq = app.uniqueName?.trim();
          if (uniq && !inProject.some((x) => x.id !== a.appId && x.uniqueName?.trim() === uniq)) appRef = `cloud:uniqueName=${uniq}`;
          const twins = inProject.filter((x) => x.id !== a.appId && x.releaseVersion === app.releaseVersion && x.buildVersion === app.buildVersion);
          if (twins.length && !appRef) buildNotes.push(`${twins.length + 1} builds in ${project} share version ${app.releaseVersion} build ${app.buildVersion} and have no unique name of their own (${[a.appId, ...twins.map((x) => x.id)].join(', ')}): the platform installs one of them and cannot be told which.`);
        }
        if (!appIdStr) throw new Error('name the app to explore: appId (repository), or packageName / bundleIdentifier with appVersion. Ask the user for their app, its version and its OS.');
        if (!prev && a.appId === undefined && !version && !a.installedApp) throw new Error('appVersion is required with packageName / bundleIdentifier: a manifest describes one version of the app.');
        let login: { username: string; password: string; source: string } | undefined;
        if (a.testLogin && (a.loginUserEnv || a.loginPasswordEnv)) throw new Error('give testLogin OR loginUserEnv / loginPasswordEnv, not both.');
        // A resume reads the login the earlier run named (names only are kept), unless the caller names one.
        const ref: LoginRef | undefined = a.testLogin || a.loginUserEnv || a.loginPasswordEnv
          ? { testLogin: a.testLogin, userEnv: a.loginUserEnv, passwordEnv: a.loginPasswordEnv }
          : prev?.settings?.loginRef;
        const loginName = ref?.testLogin;
        const userEnv = ref?.userEnv;
        const passEnv = ref?.passwordEnv;
        if (loginName) {
          const r = resolveAppLogin(loginName, setupCommand());
          if (!r.username || !r.password) throw new Error(`${r.reason}. Never ask for the password in the chat.`);
          login = { username: r.username, password: r.password, source: `the saved test login ${loginName.trim().toLowerCase()}` };
        } else if (userEnv || passEnv) {
          const u = userEnv ? process.env[userEnv] : undefined;
          const pw = passEnv ? process.env[passEnv] : undefined;
          if (!u || !pw) throw new Error(`the test login needs both a user-name and a password variable; not set for this server (or empty): ${[!userEnv ? 'loginUserEnv (not given)' : !u ? userEnv : '', !passEnv ? 'loginPasswordEnv (not given)' : !pw ? passEnv : ''].filter(Boolean).join(', ')}. AI clients usually pass only variables named in the server's own configuration (its env block), not the whole system environment. Simpler: the user saves the login once in a terminal with "${setupCommand()} app-login <name>" and you pass testLogin. Never ask for the password in the chat.`);
          login = { username: u, password: pw, source: `${userEnv} / ${passEnv}` };
        }
        const id = `explore-${Date.now().toString(36)}`;
        const abort = new AbortController();
        const job: Job = { id, status: 'running', startedAt: Date.now(), progress: 'starting', abort, label: `${appIdStr}${version ? ` ${version}` : ''}` };
        jobs.set(id, job);
        const opts = {
          maxScreens: a.maxScreens ?? 40, maxMinutes: a.maxMinutes ?? 30, maxDepth: a.maxDepth ?? prev?.settings?.maxDepth ?? 6, login, allowWritePaths: a.allowWritePaths,
          ...(ref ? { loginRef: ref } : {}), ...(prev ? { resume: prev } : {}),
        };
        exploreApp({ platform: a.platform, appId: appIdStr, activity, repositoryId: prev?.app.repositoryId ?? a.appId, version, ...pin, ...(appRef ? { appRef } : {}), ...(a.installedApp || prev?.app.source === 'installed' ? { installed: true } : {}), deviceQuery: a.deviceQuery ?? prev?.settings?.deviceQuery, region: a.region ?? prev?.settings?.region }, opts, (t) => { job.progress = t; }, abort.signal)
          .then((m) => {
            for (const n of buildNotes) if (!m.notes.includes(n)) m.notes.push(n);
            job.savedTo = saveManifest(id, m);
            if (job.status === 'running') { job.status = 'done'; job.manifest = m; }
          })
          .catch((e: Error) => { if (job.status === 'running') { job.status = abort.signal.aborted ? 'cancelled' : 'failed'; job.error = e.message; } });
        const text = `${prev ? `Continuing exploration ${a.resumeFrom} (${prev.screens.length} screens mapped, ${prev.frontier?.length ?? 0} routes left) as` : 'Exploring'} ${job.label} (${a.platform}) in the background: jobId ${id}. Budget: ${opts.maxScreens} screens or ${opts.maxMinutes} minutes, ${opts.maxDepth} taps deep; one device is held meanwhile. ` +
          (opts.allowWritePaths
            ? 'Write paths allowed for this session (nothing is typed or submitted with data); destructive actions are never tapped. '
            : 'Read-only: navigation only; anything that could write data is recorded, not tapped. ') +
          `END YOUR TURN now and tell the user it is running; check app_exploration_status with jobId ${id} when they come back.`;
        // Never the login itself: only where it comes from (the first trial echoed the password here, 2026-11-27).
        return respond(a.outputFormat, { jobId: id, status: 'running', app: job.label, ...(prev ? { resumes: a.resumeFrom } : {}), ...(pin.appReleaseVersion ? { build: { releaseVersion: pin.appReleaseVersion, buildVersion: pin.appBuildVersion, ...(appRef ? { installedBy: appRef } : {}) } } : {}), ...(buildNotes.length ? { buildNotes } : {}), budget: { maxScreens: opts.maxScreens, maxMinutes: opts.maxMinutes, maxDepth: opts.maxDepth }, allowWritePaths: opts.allowWritePaths, ...(login ? { testLogin: `from ${login.source}` } : {}) }, text);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'app_exploration_status',
    'Status of an app exploration started with start_app_exploration: progress while it runs; when done, the manifest (screens, how ' +
    'to reach each, navigation, what was not tapped and why, verified locators). cancel: true stops it and releases the device.',
    {
      jobId: z.string().describe('From start_app_exploration.'),
      cancel: z.boolean().optional().describe('Stop the exploration.'),
      outputFormat: outputFormatParam,
    },
    async ({ jobId, cancel, outputFormat }) => {
      const job = jobs.get(jobId);
      if (!job) {
        const saved = loadManifest(jobId);
        if (saved) return respond(outputFormat, { jobId, status: 'done', manifest: saved }, summary(saved));
        return { content: [{ type: 'text', text: `Error: no exploration ${jobId} in this server run or in ${explorationDir()}.` }], isError: true };
      }
      if (cancel && job.status === 'running') { job.status = 'cancelled'; job.abort.abort(); }
      const mins = Math.round((Date.now() - job.startedAt) / 60_000);
      if (job.status === 'running') return respond(outputFormat, { jobId, status: 'running', progress: job.progress, minutes: mins }, `Still exploring ${job.label} (${mins} min): ${job.progress}. Check again later.`);
      if (job.status !== 'done') return respond(outputFormat, { jobId, status: job.status, error: job.error }, `Exploration ${job.status}${job.error ? `: ${job.error}` : ''}.`);
      return respond(outputFormat, { jobId, status: 'done', manifest: job.manifest, ...(job.savedTo ? { savedTo: job.savedTo } : {}) }, summary(job.manifest!) + (job.savedTo ? `\nSaved to ${job.savedTo} (no login values in it).` : ''));
    }
  );

  server.tool(
    'app_exploration_flows',
    'Stage 2 of app exploration: the test flows a finished exploration suggests (log in, open each screen, fill and submit ' +
    'each form, and each destructive action), for the USER to choose. Show the list to the user, ask which flows matter, ' +
    'and pass ONLY the ids the user chose in accept — never accept on the user\'s behalf, and a destructive flow only when the ' +
    'user explicitly asks for it. Accepted flows are saved with the exploration; test steps are then written only for them, ' +
    'from the locators the exploration verified. A form flow needs test data from the user (never invent it, never a real ' +
    'customer\'s).',
    {
      jobId: z.string().describe('From start_app_exploration (a finished run, in this server run or saved).'),
      accept: z.array(z.string()).optional().describe('The flow ids THE USER chose. Omit to list the proposals.'),
      outputFormat: outputFormatParam,
    },
    async ({ jobId, accept, outputFormat }) => {
      const m = loadManifest(jobId);
      if (!m) return { content: [{ type: 'text', text: `Error: no finished exploration ${jobId} (in this server run or in ${explorationDir()}).` }], isError: true };
      const flows = proposeFlows(m);
      const line = (f: ProposedFlow) => `- ${f.id}: ${f.title}${f.steps.length ? ` — ${f.steps.map((x) => x.label).join(' → ')}` : ''}${f.needsData ? ` — needs test data: ${f.needsData.join(', ')}` : ''}${f.choices ? ` — drop-downs: ${f.choices.map((c) => `${c.field} (shows ${c.shown}${c.options ? `; options: ${c.options.slice(0, 6).join(', ')}${c.options.length > 6 ? ', …' : ''}` : ''})`).join('; ')}` : ''}${f.caution ? ` (${f.caution})` : ''}`;
      if (!accept) {
        const accepted = new Set((m.acceptedFlows ?? []).map((a) => a.id));
        // Stage 3: the runs of the generated tests, found by their report key (only once flows were accepted).
        let runs: Awaited<ReturnType<typeof explorationRuns>> = [];
        let runsNote: string | undefined;
        if (accepted.size) {
          const since = Date.parse(m.finishedAt ?? m.startedAt) || Date.now() - 7 * 86_400_000;
          runs = await explorationRuns(jobId, since).catch((e: Error) => { runsNote = `runs could not be read: ${e.message}`; return []; });
        }
        const latest = new Map<string, (typeof runs)[number]>();
        for (const r of runs) if (r.flow && !latest.has(r.flow)) latest.set(r.flow, r);
        const runLine = (id: string) => { const r = latest.get(id); const n = runs.filter((x) => x.flow === id).length; return r ? `  [accepted; last run ${r.status}, ${n} run(s)]` : '  [accepted; not run yet]'; };
        const text = [
          `${flows.length} proposed flow(s) for ${m.app.appId}${m.app.version ? ` ${m.app.version}` : ''}. ${accepted.size ? 'Accepted flows show their runs (tests generated with get_test_boilerplate explorationJobId).' : 'Ask the user which to keep, then call again with accept: [ids].'}`,
          '', ...flows.map((f) => line(f) + (accepted.has(f.id) ? runLine(f.id) : '')),
          ...(runs.length ? ['', `Runs of the generated tests (report key explorationRun = ${jobId}): ${runs.length}, ${runs.filter((r) => /pass/i.test(r.status)).length} passed. Newest: ${runs.slice(0, 5).map((r) => `#${r.testId} ${r.flow ?? r.name} ${r.status}`).join('; ')}.`] : []),
          ...(runsNote ? ['', runsNote] : []),
        ].join('\n');
        return respond(outputFormat, { jobId, flows, ...(m.acceptedFlows ? { acceptedFlows: m.acceptedFlows } : {}), ...(accepted.size ? { runs } : {}), ...(runsNote ? { runsNote } : {}) }, text);
      }
      const unknown = accept.filter((a) => !flows.some((f) => f.id === a));
      if (unknown.length) return { content: [{ type: 'text', text: `Error: unknown flow id(s): ${unknown.join(', ')}. List the proposals first (no accept).` }], isError: true };
      const now = new Date().toISOString();
      const kept = new Map((m.acceptedFlows ?? []).map((a) => [a.id, a]));
      for (const id of accept) if (!kept.has(id)) kept.set(id, { id, title: flows.find((f) => f.id === id)!.title, acceptedAt: now });
      m.acceptedFlows = [...kept.values()];
      const job = jobs.get(jobId);
      if (job?.manifest) job.manifest.acceptedFlows = m.acceptedFlows;
      const savedTo = saveManifest(jobId, m);
      const chosen = flows.filter((f) => kept.has(f.id));
      const text = [`Accepted ${chosen.length} flow(s)${savedTo ? ` (saved with the exploration: ${savedTo})` : ''}:`, ...chosen.map(line), '',
        'Next: write test steps for these flows only, from their verified locators (outputFormat json gives every locator), into the framework structure from get_test_boilerplate, and validate_test_script. Form flows need the user\'s test data.'].join('\n');
      return respond(outputFormat, { jobId, accepted: chosen, ...(savedTo ? { savedTo } : {}) }, text);
    }
  );
}
