/**
 * App exploration, stage 2 (2.6.0): proposed test flows from a finished manifest, for the USER to accept. Pure: in a
 * manifest, out a list. Stage 3 writes tests only from accepted flows (owner decision 2026-11-27: user acceptance is a
 * prerequisite; the agent never accepts on the user's behalf).
 */
import type { Manifest } from '../api/app-crawl.js';
import type { Locator } from './app-exploration.js';

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
  /** The control that submits a form or performs a destructive action. Never tapped by the crawl. */
  action?: string;
  /** What the user must know before accepting. */
  caution?: string;
}

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'screen';

/** Flows proposed from a manifest: log in, open each screen, fill each form, and each destructive action (to confirm). */
export function proposeFlows(m: Manifest): ProposedFlow[] {
  const flows: ProposedFlow[] = [];
  const used = new Set<string>();
  const id = (base: string) => { let k = base; for (let n = 2; used.has(k); n++) k = `${base}-${n}`; used.add(k); return k; };
  const check = (s: Manifest['screens'][number]) => s.assertable.find((a) => a.label && !/^\(?untitled/i.test(a.label));

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
    const fields = s.notVisited.filter((n) => n.kind === 'input').map((n) => n.label);
    const submit = s.notVisited.find((n) => n.kind === 'action' || (n.kind === 'unknown' && /submit|send|pay|save|transfer|deposit|confirm|next|done|sign|apply|book|order/i.test(n.label)));
    if (fields.length && submit) {
      flows.push({
        id: id(`submit-${slug(s.title)}`), kind: 'form', title: `Fill and submit ${s.title}`, screen: s.title, steps: s.path,
        needsData: fields, action: submit.label,
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
