/**
 * Which test framework and language a project's tests are generated in: the USER decides, once per project (owner
 * decision 2026-11-27). In real runs agents picked a language on their own when no stack was clearly best, and twice
 * created a second test framework next to an existing one.
 *
 * Three parts:
 * - analyseProject: what the client's workspace already holds (build files, test frameworks), read from disk. Only
 *   possible when the server runs on the user's machine and the client shares its workspace folder (roots).
 * - a choice store: the user's answer per project, in the server's own settings folder (next to the credential store),
 *   never in the customer's project. Keyed by the workspace folder, or by the cloud project when there is none.
 * - the decision (decideFramework): use the stored choice; otherwise ask the user (elicitation where the client
 *   supports it, else an answer that tells the agent to ask) — never pick one.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storeDir } from './credential-store.js';

export type FrameworkKind = 'mobile' | 'web';
export const MOBILE_LANGUAGES = ['java-junit5', 'java-testng', 'nodejs', 'python', 'robot'] as const;
export const WEB_LANGUAGES = ['java-junit5', 'java-testng', 'nodejs', 'python', 'robot', 'playwright'] as const;
export type FrameworkLanguage = (typeof WEB_LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<FrameworkLanguage, string> = {
  'java-junit5': 'Java + JUnit 5',
  'java-testng': 'Java + TestNG',
  nodejs: 'JavaScript + WebdriverIO',
  python: 'Python + pytest/unittest',
  robot: 'Robot Framework',
  playwright: 'Playwright Test (TypeScript/JavaScript)',
};

export interface DetectedFramework {
  language: FrameworkLanguage;
  /** Files that show it, relative to the workspace folder. */
  evidence: string[];
}

export interface ProjectAnalysis {
  /** The folder that was read, or undefined when nothing could be read (no shared folder, or not on this machine). */
  root?: string;
  /** Languages the project is built in (from build files), most evidence first. */
  stacks: string[];
  /** Test automation frameworks already set up in the project. */
  testFrameworks: DetectedFramework[];
  recommendation?: FrameworkLanguage;
  reason: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'target', 'dist', 'out', '.gradle', '.idea', '.vscode', 'venv', '.venv', '__pycache__', 'bin', 'obj', 'Pods', 'DerivedData']);
const MAX_FILES = 4000;

/** Files worth reading, up to 4 folders deep. */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= MAX_FILES || depth > 4) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (out.length >= MAX_FILES) return;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (!SKIP_DIRS.has(name) && !name.startsWith('.')) walk(p, depth + 1); }
      else out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

const read = (p: string): string => { try { return readFileSync(p, 'utf-8').slice(0, 200_000); } catch { return ''; } };

/** A pure reading of the file list and contents, so it can be tested with fixtures. */
export function analyseFiles(root: string, files: string[], contentOf: (path: string) => string = read): ProjectAnalysis {
  const rel = (p: string) => relative(root, p).replace(/\\/g, '/');
  const stackCount: Record<string, number> = {};
  const found = new Map<FrameworkLanguage, Set<string>>();
  const add = (lang: FrameworkLanguage, p: string) => { if (!found.has(lang)) found.set(lang, new Set()); found.get(lang)!.add(rel(p)); };
  const stack = (s: string) => { stackCount[s] = (stackCount[s] ?? 0) + 1; };
  for (const p of files) {
    const name = p.split(/[\\/]/).pop()!.toLowerCase();
    if (name === 'pom.xml' || /^build\.gradle(\.kts)?$/.test(name)) {
      stack('Java/Kotlin');
      const c = contentOf(p);
      if (/junit-jupiter|org\.junit\.jupiter/.test(c)) add('java-junit5', p);
      if (/org\.testng|testng/.test(c)) add('java-testng', p);
    } else if (name === 'testng.xml') add('java-testng', p);
    else if (name === 'package.json') {
      stack('JavaScript/TypeScript');
      const c = contentOf(p);
      if (/"(webdriverio|@wdio\/[a-z-]+)"/.test(c)) add('nodejs', p);
      if (/"@playwright\/test"/.test(c)) add('playwright', p);
    } else if (/^wdio\.[a-z.]*conf\.(js|ts|mjs|cjs)$|^wdio\.conf\.(js|ts|mjs|cjs)$/.test(name)) add('nodejs', p);
    else if (/^playwright\.config\.(js|ts|mjs|cjs)$/.test(name)) add('playwright', p);
    else if (name === 'requirements.txt' || name === 'pyproject.toml' || name === 'setup.py' || name === 'pipfile') {
      stack('Python');
      const c = contentOf(p).toLowerCase();
      if (/robotframework/.test(c)) add('robot', p);
      if (/appium-python-client|selenium|pytest/.test(c)) add('python', p);
    } else if (name === 'conftest.py' || name === 'pytest.ini') add('python', p);
    else if (name.endsWith('.robot')) add('robot', p);
    else if (name.endsWith('.swift') || name === 'package.swift' || name.endsWith('.xcodeproj')) stack('Swift');
    else if (name.endsWith('.csproj') || name.endsWith('.sln')) stack('C#/.NET');
  }
  const stacks = Object.entries(stackCount).sort((a, b) => b[1] - a[1]).map(([s]) => s);
  const testFrameworks = [...found.entries()].map(([language, ev]) => ({ language, evidence: [...ev].slice(0, 5) }));
  let recommendation: FrameworkLanguage | undefined;
  let reason: string;
  if (testFrameworks.length === 1) {
    recommendation = testFrameworks[0].language;
    reason = `The project already has ${LANGUAGE_LABELS[recommendation]} tests (${testFrameworks[0].evidence[0]}): add to that framework rather than creating a second one.`;
  } else if (testFrameworks.length > 1) {
    recommendation = testFrameworks[0].language;
    reason = `The project has more than one test framework (${testFrameworks.map((f) => LANGUAGE_LABELS[f.language]).join(', ')}): the user should say which one new tests belong to.`;
  } else if (stacks[0] === 'Java/Kotlin') {
    recommendation = 'java-junit5'; reason = 'The project is built with Java/Kotlin and has no test framework yet: Java + JUnit 5 fits its build.';
  } else if (stacks[0] === 'JavaScript/TypeScript') {
    recommendation = 'nodejs'; reason = 'The project is a JavaScript/TypeScript project with no test framework yet: WebdriverIO fits its toolchain.';
  } else if (stacks[0] === 'Python') {
    recommendation = 'python'; reason = 'The project is a Python project with no test framework yet: Python fits its toolchain.';
  } else {
    reason = stacks.length
      ? `The project is built with ${stacks.join(', ')}, for which no template exists here: the user should pick the language their team will maintain.`
      : 'Nothing in the project points to a language: the user should pick the language their team will maintain.';
  }
  return { root, stacks, testFrameworks, recommendation, reason };
}

/** Reads the first workspace folder the client shares (file:// URIs on this machine only). */
export function analyseProject(rootUris: string[]): ProjectAnalysis {
  for (const uri of rootUris) {
    let path: string;
    try { path = uri.startsWith('file:') ? fileURLToPath(uri) : uri; } catch { continue; }
    if (!existsSync(path)) continue;
    try { if (!statSync(path).isDirectory()) continue; } catch { continue; }
    return analyseFiles(path, listFiles(path));
  }
  return { stacks: [], testFrameworks: [], reason: 'The workspace cannot be read from here (no shared folder, or the server does not run on your machine): ask the user what the project is built with.' };
}

// ── The choice store ─────────────────────────────────────────────────────────────

interface StoredChoice { language: FrameworkLanguage; chosenAt: string; how: 'asked' | 'confirmed' }
type ChoiceFile = { version: 1; projects: Record<string, Partial<Record<FrameworkKind, StoredChoice>>> };

export function choiceStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.MCP_FRAMEWORK_CHOICE_DIR || storeDir(env), 'test-frameworks.json');
}

function readChoices(path = choiceStorePath()): ChoiceFile {
  try {
    const j = JSON.parse(readFileSync(path, 'utf-8')) as ChoiceFile;
    if (j && j.version === 1 && j.projects && typeof j.projects === 'object') return j;
  } catch { /* none yet, or unreadable: start empty */ }
  return { version: 1, projects: {} };
}

export function storedChoice(key: string, kind: FrameworkKind, path = choiceStorePath()): StoredChoice | undefined {
  const c = readChoices(path).projects[key]?.[kind];
  return c && (WEB_LANGUAGES as readonly string[]).includes(c.language) ? c : undefined;
}

/** Saves the user's choice. A failure to write is reported, never fatal: the choice is then asked for again next time. */
export function saveChoice(key: string, kind: FrameworkKind, language: FrameworkLanguage, how: StoredChoice['how'], path = choiceStorePath()): string | undefined {
  try {
    const file = readChoices(path);
    file.projects[key] = { ...(file.projects[key] ?? {}), [kind]: { language, chosenAt: new Date().toISOString(), how } };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    return undefined;
  } catch (e) {
    return `The choice could not be saved (${(e as Error).message}); it will be asked for again next time.`;
  }
}

/** The key a project's choice is kept under: the workspace folder, else the cloud project. */
export function projectKey(analysis: ProjectAnalysis, cloudProject?: string): string {
  if (analysis.root) return `folder:${process.platform === 'win32' ? analysis.root.toLowerCase() : analysis.root}`;
  return `cloud:${cloudProject ?? 'unknown'}`;
}

// ── The decision ─────────────────────────────────────────────────────────────────

export interface FrameworkContext {
  /** The client's workspace folders (file:// URIs). */
  roots: () => Promise<string[]>;
  /** Whether the client lets the server ask the user directly (MCP elicitation). */
  canAsk: () => boolean;
  /** Ask the user; resolves with the chosen language, 'declined', or undefined when asking failed. */
  ask: (message: string, options: FrameworkLanguage[], recommended?: FrameworkLanguage) => Promise<FrameworkLanguage | 'declined' | undefined>;
  /** "<cloud host>/<project name>", for projects without a shared folder. */
  cloudProject: () => Promise<string | undefined>;
}

let context: FrameworkContext | null = null;
export function setFrameworkContext(c: FrameworkContext | null): void { context = c; }

export type FrameworkDecision =
  | { ok: true; language: FrameworkLanguage; note: string; analysis: ProjectAnalysis; addToExisting: boolean }
  | { ok: false; answer: Record<string, unknown>; text: string };

const listOptions = (options: readonly FrameworkLanguage[]) => options.map((l) => `${l} (${LANGUAGE_LABELS[l]})`).join(', ');

export async function decideFramework(args: {
  kind: FrameworkKind;
  options: readonly FrameworkLanguage[];
  requested?: FrameworkLanguage;
  confirmedByUser?: boolean;
  newFramework?: boolean;
  tool: string;
}): Promise<FrameworkDecision> {
  // MCP_FRAMEWORK_CHOICE=trust-caller: no user to ask (a CI pipeline, an evaluation harness, the test suite): the
  // language the caller passes is used as given. It must still be passed; nothing is chosen for the caller.
  if (process.env.MCP_FRAMEWORK_CHOICE === 'trust-caller') {
    if (args.requested) return { ok: true, language: args.requested, note: `${LANGUAGE_LABELS[args.requested]} (MCP_FRAMEWORK_CHOICE=trust-caller: the caller's choice is used without asking).`, analysis: { stacks: [], testFrameworks: [], reason: '' }, addToExisting: false };
  }
  const ctx = context;
  let roots: string[] = [];
  try { roots = ctx ? await ctx.roots() : []; } catch { roots = []; }
  const analysis = analyseProject(roots);
  let cloud: string | undefined;
  if (!analysis.root) { try { cloud = ctx ? await ctx.cloudProject() : undefined; } catch { cloud = undefined; } }
  const key = projectKey(analysis, cloud);
  const projectLabel = analysis.root ? `the project in ${analysis.root}` : cloud ? `cloud project ${cloud}` : 'this project';
  const usable = analysis.testFrameworks.filter((f) => args.options.includes(f.language));
  const recommended = analysis.recommendation && args.options.includes(analysis.recommendation) ? analysis.recommendation : undefined;
  const summary = {
    project: projectLabel,
    ...(analysis.root ? { builtWith: analysis.stacks, existingTestFrameworks: usable } : {}),
    ...(recommended ? { recommendation: recommended } : {}),
    reason: analysis.reason,
    options: args.options,
  };

  // Never a second framework next to an existing one unless the user asked for it.
  const duplicate = (language: FrameworkLanguage): FrameworkDecision | undefined => {
    const existing = usable.find((f) => f.language === language) ? undefined : usable[0];
    if (!existing || args.newFramework) return undefined;
    const text = `${projectLabel} already has ${LANGUAGE_LABELS[existing.language]} tests (${existing.evidence[0]}). Generating ${LANGUAGE_LABELS[language]} would add a SECOND test framework to it. ` +
      `Ask the user: add the new test to the existing ${existing.language} framework (call ${args.tool} with language "${existing.language}"), or really start a second framework (call again with newFramework: true).`;
    return { ok: false, answer: { status: 'second_framework', ...summary, existing: existing.language, message: text }, text: `⚠️ ${text}` };
  };
  // A choice is saved only once it is accepted: a choice refused as a second framework used to be saved first, so every
  // later call in the project answered "second framework" again (UAT review 2026-11-27).
  const done = (language: FrameworkLanguage, note: string, save?: StoredChoice['how']): FrameworkDecision => {
    const dup = duplicate(language);
    if (dup) return dup;
    const saveNote = save ? saveChoice(key, args.kind, language, save) : undefined;
    return { ok: true, language, note: saveNote ? `${note} ${saveNote}` : note, analysis, addToExisting: usable.some((f) => f.language === language) };
  };

  const stored = storedChoice(key, args.kind);
  if (stored && (!args.requested || args.requested === stored.language)) {
    return done(stored.language, `${LANGUAGE_LABELS[stored.language]}: the user chose it for ${projectLabel} on ${stored.chosenAt.slice(0, 10)}. To use another language, call again with that language and confirmedByUser: true after asking the user.`);
  }
  if (args.requested && args.confirmedByUser) {
    return done(args.requested, `${LANGUAGE_LABELS[args.requested]}: confirmed by the user for ${projectLabel}; later calls in this project use it without asking.`, 'confirmed');
  }
  if (ctx?.canAsk()) {
    const message = `Which test framework should ${args.kind === 'web' ? 'web' : 'mobile'} tests for ${projectLabel} be generated in?\n` +
      `${analysis.reason}${recommended ? `\nRecommended: ${LANGUAGE_LABELS[recommended]}.` : ''}${stored ? `\nChosen earlier: ${LANGUAGE_LABELS[stored.language]}.` : ''}`;
    const answer = await ctx.ask(message, [...args.options], args.requested ?? recommended);
    if (answer === 'declined') {
      return { ok: false, answer: { status: 'framework_not_chosen', ...summary, message: 'The user did not choose a framework, so nothing was generated.' }, text: 'The user did not choose a test framework, so nothing was generated. Ask them which one they want.' };
    }
    if (answer) {
      return done(answer, `${LANGUAGE_LABELS[answer]}: chosen by the user for ${projectLabel}; later calls in this project use it without asking.`, 'asked');
    }
  }
  const text = [
    `Choose the test framework with the user first: nothing was generated.`,
    '',
    `Project: ${projectLabel}.`,
    ...(analysis.root ? [`Built with: ${analysis.stacks.join(', ') || 'nothing recognised'}. Test frameworks already in it: ${usable.length ? usable.map((f) => `${LANGUAGE_LABELS[f.language]} (${f.evidence[0]})`).join(', ') : 'none'}.`] : []),
    analysis.reason,
    recommended ? `Recommendation to put to the user: ${LANGUAGE_LABELS[recommended]}.` : 'There is no clear recommendation: list the options and ask.',
    `Options: ${listOptions(args.options)}.`,
    stored ? `The user chose ${LANGUAGE_LABELS[stored.language]} for this project earlier; you asked for ${args.requested ? LANGUAGE_LABELS[args.requested] : 'another'}.` : '',
    '',
    `ASK THE USER which one to use (do not choose for them), then call ${args.tool} again with language set to their answer and confirmedByUser: true. The choice is remembered for this project.`,
  ].filter((l) => l !== '').join('\n');
  return { ok: false, answer: { status: 'choose_framework', ...summary, ...(stored ? { chosenEarlier: stored.language } : {}), howToProceed: `Ask the user, then call ${args.tool} with language and confirmedByUser: true.` }, text };
}
