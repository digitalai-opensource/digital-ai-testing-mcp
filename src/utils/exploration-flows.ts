/**
 * App exploration, stage 2 (2.6.0): proposed test flows from a finished manifest, for the USER to accept. Pure: in a
 * manifest, out a list. Stage 3 writes tests only from accepted flows (owner decision 2026-11-27: user acceptance is a
 * prerequisite; the agent never accepts on the user's behalf).
 */
import type { Manifest } from '../api/app-crawl.js';
import type { Locator } from './app-exploration.js';
import type { CodegenFlow, CodegenLogin } from './flow-codegen.js';

export type FlowKind = 'login' | 'navigate' | 'form' | 'destructive';

export interface ProposedFlow {
  id: string;
  kind: FlowKind;
  title: string;
  /** The screen the flow ends on (or acts on). */
  screen: string;
  /** Taps from the start screen, with locators verified by the crawl. */
  steps: Array<{ label: string; locator: Locator }>;
  /** An element on the final screen to assert on (verified by the crawl). */
  check?: { label: string; locator: Locator };
  /** Fields a form flow fills: the test data is the user's to give; the crawl never typed into them. */
  needsData?: string[];
  /** Drop-downs a form flow can set: the test keeps the value shown unless TEST_DATA_<FIELD> names an option. */
  choices?: Array<{ field: string; shown: string; options?: string[] }>;
  /** The control that submits a form or performs a destructive action. Never tapped by the crawl. */
  action?: string;
  /** What the user must know before accepting. */
  caution?: string;
}

const SHOWS_VALUE = /[$€£¥]\s?\d|\(\s*[$€£¥]?\d[\d.,]*\s*\)/;
const slug =(t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'screen';

/** Flows proposed from a manifest: log in, open each screen, fill each form, and each destructive action (to confirm). */
export function proposeFlows(m: Manifest): ProposedFlow[] {
  const flows: ProposedFlow[] = [];
  const used = new Set<string>();
  const id = (base: string) => { let k = base; for (let n = 2; used.has(k); n++) k = `${base}-${n}`; used.add(k); return k; };
  // What proves a flow reached its screen: the screen's own title text, else an element the screen before it does not
  // have; never a framework container (android:id/content is on every screen: the first live test checked it).
  const check = (s: Manifest['screens'][number]) => {
    const prev = s.path.length ? m.screens.find((x) => !x.login && x.path.length === s.path.length - 1 && JSON.stringify(x.path) === JSON.stringify(s.path.slice(0, -1))) : undefined;
    const before = new Set((prev?.assertable ?? []).map((a) => a.locator.value));
    const usable = s.assertable.filter((a) => a.label && !/^\(?untitled/i.test(a.label) && !/^android:id\//.test(a.locator.value) && !before.has(a.locator.value));
    const title = s.rawTitle ?? s.title;
    return usable.find((a) => a.label === title) ?? usable.find((a) => a.locator.using !== 'xpath') ?? usable[0];
  };

  const login = m.screens.find((s) => s.login === 'done');
  if (login) {
    flows.push({
      id: id('login'), kind: 'login', title: 'Log in with the test login', screen: login.title, steps: [],
      ...(m.screens.find((s) => !s.login && s.path.length === 0) ? { check: check(m.screens.find((s) => !s.login && s.path.length === 0)!) } : {}),
      needsData: ['user name', 'password'],
      caution: 'The test reads the login from environment variables (never written into the test).',
    });
  }
  for (const s of m.screens) {
    if (s.login) continue;
    if (s.path.length) {
      flows.push({ id: id(`open-${slug(s.title)}`), kind: 'navigate', title: `Open ${s.title}`, screen: s.title, steps: s.path, ...(check(s) ? { check: check(s) } : {}) });
    }
    // A field that already shows a value ("Checking ($1,000.00)") is a selection, not an entry field: the test keeps it.
    // (Explorations before drop-downs were recognised recorded them as text fields: the value test still applies there.)
    const fields = s.notVisited.filter((n) => n.kind === 'input' && !SHOWS_VALUE.test(n.label)).map((n) => n.field ?? n.label);
    const choices = s.notVisited.filter((n) => n.kind === 'choice').map((n) => ({ field: n.field ?? n.label, shown: n.label, ...(n.options ? { options: n.options } : {}) }));
    const submit = s.notVisited.find((n) => n.kind === 'action' || (n.kind === 'unknown' && /submit|send|pay|save|transfer|deposit|confirm|next|done|sign|apply|book|order/i.test(n.label)));
    if ((fields.length || choices.length) && submit) {
      flows.push({
        id: id(`submit-${slug(s.title)}`), kind: 'form', title: `Fill and submit ${s.title}`, screen: s.title, steps: s.path,
        ...(fields.length ? { needsData: fields } : {}), ...(choices.length ? { choices } : {}), action: submit.label,
        caution: 'Submitting may change data in the app (the crawl never submitted it): use test data and a test account.',
      });
    }
    for (const d of s.notVisited.filter((n) => n.kind === 'destructive')) {
      flows.push({
        id: id(`confirm-${slug(d.label)}`), kind: 'destructive', title: `${d.label} (on ${s.title})`, screen: s.title, steps: s.path, action: d.label,
        caution: 'Destructive: it may delete data or end the session. Accept only if a test should do this; the crawl never tapped it.',
      });
    }
  }
  return flows;
}

/**
 * The accepted flows of a manifest in the shape the code generator takes (src/utils/flow-codegen.ts), with the login
 * done at the start of every test when the exploration logged in. A flow whose controls have no verified locator is
 * left out and named in `skipped` (never written with a guessed one).
 */
export function codegenInput(m: Manifest, ids: string[]): { flows: CodegenFlow[]; login?: CodegenLogin; skipped: string[] } {
  const proposed = proposeFlows(m);
  const loginScreen = m.screens.find((s) => s.login === 'done' && s.loginLocators);
  const login = loginScreen?.loginLocators;
  const flows: CodegenFlow[] = [];
  const skipped: string[] = [];
  // Every flow starts behind the login: without its locators (an exploration from before they were kept) no test could
  // get past it, so none is written.
  if (m.screens.some((s) => s.login === 'done') && !login) {
    return { flows, skipped: ids.map((id) => `${id} (the exploration logged in, but its login fields were not recorded: run the exploration again with this version)`) };
  }
  for (const id of ids) {
    const f = proposed.find((x) => x.id === id);
    if (!f) { skipped.push(`${id} (not a flow of this exploration)`); continue; }
    const screen = m.screens.find((s) => s.title === f.screen);
    const loc = (label: string | undefined, kind?: string) => (label ? screen?.notVisited.find((n) => (!kind || n.kind === kind) && ((n.field ?? n.label) === label || n.label === label))?.locator : undefined);
    if (f.kind === 'login') {
      if (!login) { skipped.push(`${f.id} (the login fields have no verified locators)`); continue; }
      flows.push({ id: f.id, title: f.title, kind: 'login', steps: [], ...(f.check ? { check: f.check } : {}) });
      continue;
    }
    if (f.kind === 'form') {
      const fields = (f.needsData ?? []).map((label) => ({ label, locator: loc(label, 'input') }));
      const choices = (f.choices ?? []).map((c) => ({ label: c.field, locator: loc(c.field, 'choice') }));
      const action = loc(f.action);
      if (fields.some((x) => !x.locator) || choices.some((x) => !x.locator) || !action) { skipped.push(`${f.id} (a field or the submit control has no verified locator)`); continue; }
      flows.push({
        id: f.id, title: f.title, kind: 'form', steps: f.steps, fields: fields as CodegenFlow['fields'],
        ...(choices.length ? { choices: choices as CodegenFlow['choices'] } : {}), action: { label: f.action!, locator: action },
      });
      continue;
    }
    if (f.kind === 'destructive') {
      const action = loc(f.action);
      if (!action) { skipped.push(`${f.id} (the control has no verified locator)`); continue; }
      flows.push({ id: f.id, title: f.title, kind: 'destructive', steps: f.steps, action: { label: f.action!, locator: action } });
      continue;
    }
    flows.push({ id: f.id, title: f.title, kind: 'navigate', steps: f.steps, ...(f.check ? { check: f.check } : {}) });
  }
  return { flows, ...(login ? { login } : {}), skipped };
}
