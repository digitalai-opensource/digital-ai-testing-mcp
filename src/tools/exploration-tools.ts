import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getApplicationInfo } from '../api/applications.js';
import { exploreApp, type Manifest } from '../api/app-crawl.js';
import { respond, outputFormatParam } from '../utils/output-format.js';
import { resolveAppLogin } from '../utils/app-logins.js';
import { setupCommand } from '../cli/clients.js';

/**
 * App exploration, stage 1 (2.6.0): map the USER'S app read-only into a manifest of screens, navigation and verified
 * locators, so the placeholder steps of a boilerplate can be written from what is really on the app. The first input is
 * always the app, its version and its OS (owner decision 2026-11-27); it is never the sample app outside a demo.
 * Runs as a background job in this server process; the agent checks status. See src/api/app-crawl.ts.
 */
interface Job { id: string; status: 'running' | 'done' | 'failed' | 'cancelled'; startedAt: number; progress: string; manifest?: Manifest; error?: string; abort: AbortController; label: string }
const jobs = new Map<string, Job>();

function summary(m: Manifest): string {
  const lines = [
    `App ${m.app.appId}${m.app.version ? ` version ${m.app.version}` : ''} (${m.app.platform}) on ${m.device.name} (${m.device.os} ${m.device.version}).`,
    `${m.screens.length} screen(s), ${m.taps} tap(s). Stopped: ${m.stoppedBecause}.`,
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
    'configuration. Never ask the user to type a password into the chat, and never repeat one.',
    {
      platform: z.enum(['android', 'ios']).describe('The app\'s OS.'),
      appId: z.number().int().optional().describe('The app in the repository (list_applications): its package / bundle id, activity and version come from the record.'),
      packageName: z.string().optional().describe('Android package, when there is no repository id. Needs appVersion.'),
      mainActivity: z.string().optional().describe('Android launch activity, with packageName.'),
      bundleIdentifier: z.string().optional().describe('iOS bundle id, when there is no repository id. Needs appVersion.'),
      appVersion: z.string().optional().describe('The version being explored (from the record when appId is given).'),
      deviceQuery: z.string().optional().describe('Device query, e.g. "@os=\'android\' and @model=\'SM-G981U\'". Default: a free phone of the platform.'),
      region: z.string().optional().describe('Region code from find_available_device.'),
      maxScreens: z.number().int().min(1).max(200).optional().describe('Stop after this many screens (default 40).'),
      maxMinutes: z.number().int().min(2).max(60).optional().describe('Stop after this many minutes (default 30).'),
      maxDepth: z.number().int().min(1).max(10).optional().describe('How many taps deep from the start screen (default 6).'),
      allowWritePaths: z.boolean().describe('The USER\'s answer, asked once at the start: may the crawl follow paths that could write data? Never covers destructive actions.'),
      testLogin: z.string().optional().describe('NAME of a test login the user saved with "setup app-login <name>" (e.g. "daibank"). The server reads it; the password is never returned.'),
      loginUserEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional().describe('NAME of the environment variable on the server that holds the test login\'s user name (e.g. "DAIBANK_USER"). With loginPasswordEnv.'),
      loginPasswordEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional().describe('NAME of the environment variable that holds its password. The value is read by the server and never returned.'),
      outputFormat: outputFormatParam,
    },
    async (a) => {
      try {
        let appIdStr = a.platform === 'android' ? a.packageName : a.bundleIdentifier;
        let activity = a.mainActivity;
        let version = a.appVersion;
        if (a.appId !== undefined) {
          const app = await getApplicationInfo(a.appId).catch((e: Error) => { throw new Error(`application ${a.appId} was not found: ${e.message}. Ask the user which app to explore; no other app is used in its place.`); });
          appIdStr = (a.platform === 'android' ? app.packageName : app.bundleIdentifier) ?? undefined;
          if (!appIdStr) throw new Error(`application ${a.appId} has no ${a.platform === 'android' ? 'Android package' : 'iOS bundle id'}: check the platform.`);
          activity = activity ?? app.mainActivity ?? undefined;
          version = version ?? app.releaseVersion ?? app.buildVersion ?? undefined;
        }
        if (!appIdStr) throw new Error('name the app to explore: appId (repository), or packageName / bundleIdentifier with appVersion. Ask the user for their app, its version and its OS.');
        if (a.appId === undefined && !version) throw new Error('appVersion is required with packageName / bundleIdentifier: a manifest describes one version of the app.');
        let login: { username: string; password: string; source: string } | undefined;
        if (a.testLogin && (a.loginUserEnv || a.loginPasswordEnv)) throw new Error('give testLogin OR loginUserEnv / loginPasswordEnv, not both.');
        if (a.testLogin) {
          const r = resolveAppLogin(a.testLogin, setupCommand());
          if (!r.username || !r.password) throw new Error(`${r.reason}. Never ask for the password in the chat.`);
          login = { username: r.username, password: r.password, source: `the saved test login ${a.testLogin.trim().toLowerCase()}` };
        } else if (a.loginUserEnv || a.loginPasswordEnv) {
          const u = a.loginUserEnv ? process.env[a.loginUserEnv] : undefined;
          const pw = a.loginPasswordEnv ? process.env[a.loginPasswordEnv] : undefined;
          if (!u || !pw) throw new Error(`the test login needs both a user-name and a password variable; not set for this server (or empty): ${[!a.loginUserEnv ? 'loginUserEnv (not given)' : !u ? a.loginUserEnv : '', !a.loginPasswordEnv ? 'loginPasswordEnv (not given)' : !pw ? a.loginPasswordEnv : ''].filter(Boolean).join(', ')}. AI clients usually pass only variables named in the server's own configuration (its env block), not the whole system environment. Simpler: the user saves the login once in a terminal with "${setupCommand()} app-login <name>" and you pass testLogin. Never ask for the password in the chat.`);
          login = { username: u, password: pw, source: `${a.loginUserEnv} / ${a.loginPasswordEnv}` };
        }
        const id = `explore-${Date.now().toString(36)}`;
        const abort = new AbortController();
        const job: Job = { id, status: 'running', startedAt: Date.now(), progress: 'starting', abort, label: `${appIdStr}${version ? ` ${version}` : ''}` };
        jobs.set(id, job);
        const opts = { maxScreens: a.maxScreens ?? 40, maxMinutes: a.maxMinutes ?? 30, maxDepth: a.maxDepth ?? 6, login, allowWritePaths: a.allowWritePaths };
        exploreApp({ platform: a.platform, appId: appIdStr, activity, repositoryId: a.appId, version, deviceQuery: a.deviceQuery, region: a.region }, opts, (t) => { job.progress = t; }, abort.signal)
          .then((m) => { if (job.status === 'running') { job.status = 'done'; job.manifest = m; } })
          .catch((e: Error) => { if (job.status === 'running') { job.status = abort.signal.aborted ? 'cancelled' : 'failed'; job.error = e.message; } });
        const text = `Exploring ${job.label} (${a.platform}) in the background: jobId ${id}. Budget: ${opts.maxScreens} screens or ${opts.maxMinutes} minutes, ${opts.maxDepth} taps deep; one device is held meanwhile. ` +
          (opts.allowWritePaths
            ? 'Write paths allowed for this session (nothing is typed or submitted with data); destructive actions are never tapped. '
            : 'Read-only: navigation only; anything that could write data is recorded, not tapped. ') +
          `END YOUR TURN now and tell the user it is running; check app_exploration_status with jobId ${id} when they come back.`;
        // Never the login itself: only where it comes from (the first trial echoed the password here, 2026-11-27).
        return respond(a.outputFormat, { jobId: id, status: 'running', app: job.label, budget: { maxScreens: opts.maxScreens, maxMinutes: opts.maxMinutes, maxDepth: opts.maxDepth }, allowWritePaths: opts.allowWritePaths, ...(login ? { testLogin: `from ${login.source}` } : {}) }, text);
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
      if (!job) return { content: [{ type: 'text', text: `Error: no exploration ${jobId} in this server run (explorations end with the server process).` }], isError: true };
      if (cancel && job.status === 'running') { job.status = 'cancelled'; job.abort.abort(); }
      const mins = Math.round((Date.now() - job.startedAt) / 60_000);
      if (job.status === 'running') return respond(outputFormat, { jobId, status: 'running', progress: job.progress, minutes: mins }, `Still exploring ${job.label} (${mins} min): ${job.progress}. Check again later.`);
      if (job.status !== 'done') return respond(outputFormat, { jobId, status: job.status, error: job.error }, `Exploration ${job.status}${job.error ? `: ${job.error}` : ''}.`);
      return respond(outputFormat, { jobId, status: 'done', manifest: job.manifest }, summary(job.manifest!));
    }
  );
}
