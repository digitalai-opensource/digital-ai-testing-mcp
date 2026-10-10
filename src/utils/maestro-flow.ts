/**
 * Maestro flow builder — pure, no network, no fs. Turns structured steps into a flow YAML the Test Run API runs
 * (executionType MAESTRO, a .zip with flows/<name>.yaml). The syntax mirrors a flow that passed live on 2026-10-09
 * (ExperiBank login, Galaxy S10): appId header, `---`, then a list of commands.
 *
 * Strings are emitted as JSON-quoted scalars, which are valid YAML double-quoted strings — no hand-rolled escaping.
 */

export const MAESTRO_ACTIONS = [
  'launchApp',
  'tapOn',
  'longPressOn',
  'inputText',
  'eraseText',
  'assertVisible',
  'assertNotVisible',
  'scrollUntilVisible',
  'scroll',
  'swipe',
  'hideKeyboard',
  'back',
  'pressKey',
  'waitForAnimationToEnd',
  'takeScreenshot',
  'stopApp',
] as const;
export type MaestroAction = (typeof MAESTRO_ACTIONS)[number];

export interface MaestroStep {
  action: MaestroAction;
  /** Element by resource-id (full "pkg:id/name" as get_element_tree shows it — Maestro matches the id as a regex). */
  id?: string;
  /** Element by visible text, or the text to type for inputText. */
  text?: string;
  /** launchApp: clear app data first. */
  clearState?: boolean;
  /** scrollUntilVisible / swipe direction. */
  direction?: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';
  /** pressKey: Enter, Home, Back, … ; takeScreenshot: file name; eraseText: number of characters. */
  value?: string;
  /** Mark a step optional (Maestro continues if it fails). */
  optional?: boolean;
}

export interface MaestroFlowSpec {
  appId: string;
  name?: string;
  tags?: string[];
  steps: MaestroStep[];
}

const q = (s: string) => JSON.stringify(s);
const needsSelector: ReadonlySet<MaestroAction> = new Set(['tapOn', 'longPressOn', 'assertVisible', 'assertNotVisible', 'scrollUntilVisible']);
/** Commands emitted in mapping form, where Maestro's `optional: true` can be attached. */
const supportsOptional: ReadonlySet<MaestroAction> = new Set(['launchApp', 'tapOn', 'longPressOn', 'assertVisible', 'assertNotVisible', 'scrollUntilVisible', 'inputText', 'swipe']);

/** Every problem with the spec, so the caller can fix them in one pass. Empty array = valid. */
export function validateMaestroFlow(spec: MaestroFlowSpec): string[] {
  const errors: string[] = [];
  if (!/^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/.test(spec.appId)) errors.push(`appId "${spec.appId}" is not an Android package name (e.g. com.example.app).`);
  if (spec.steps.length === 0) errors.push('steps is empty.');
  spec.steps.forEach((s, i) => {
    const at = `step ${i + 1} (${s.action})`;
    if (needsSelector.has(s.action) && !s.id && !s.text) errors.push(`${at}: needs id or text.`);
    if (s.id && s.text && s.action !== 'inputText') errors.push(`${at}: use id OR text, not both.`);
    if (s.action === 'inputText' && !s.text) errors.push(`${at}: needs text (the value to type).`);
    if (s.action === 'pressKey' && !s.value) errors.push(`${at}: needs value (the key, e.g. "Enter").`);
    if (s.action === 'swipe' && !s.direction) errors.push(`${at}: needs direction.`);
    if (s.action === 'eraseText' && s.value != null && !/^\d+$/.test(s.value)) errors.push(`${at}: value must be a character count.`);
    // The emitter only writes `optional: true` for commands in mapping form; refuse it elsewhere rather than drop it silently.
    if (s.optional && !supportsOptional.has(s.action)) errors.push(`${at}: optional is not supported for ${s.action} (only ${[...supportsOptional].join(', ')}).`);
  });
  return errors;
}

/** Bare resource names ("loginButton") instead of the full "pkg:id/loginButton" — soft warning, not an error. */
export function bareIdWarnings(spec: MaestroFlowSpec): string[] {
  return spec.steps
    .map((s, i) => (s.id && !s.id.includes(':id/') && !/[.*+?^$()[\]|\\]/.test(s.id) ? `step ${i + 1}: id "${s.id}" has no package prefix — use the full resource-id from get_element_tree (e.g. "${spec.appId}:id/${s.id}"), since Maestro matches the id against the whole resource-id.` : null))
    .filter((w): w is string => w !== null);
}

function selector(s: MaestroStep, indent: string): string[] {
  return s.id ? [`${indent}id: ${q(s.id)}`] : [`${indent}text: ${q(s.text ?? '')}`];
}

function stepYaml(s: MaestroStep): string[] {
  const opt = s.optional ? ['    optional: true'] : [];
  switch (s.action) {
    case 'launchApp':
      return s.clearState || s.optional ? ['- launchApp:', ...(s.clearState ? ['    clearState: true'] : []), ...opt] : ['- launchApp'];
    case 'tapOn':
    case 'longPressOn':
    case 'assertVisible':
    case 'assertNotVisible':
      return [`- ${s.action}:`, ...selector(s, '    '), ...opt];
    case 'inputText': {
      // With a target, tap it first so the text lands in the right field.
      const tap = s.id ? ['- tapOn:', `    id: ${q(s.id)}`, ...opt] : [];
      // Mapping form (`inputText: { text }`) is what carries `optional`; the scalar form stays for the common case.
      return [...tap, ...(s.optional ? ['- inputText:', `    text: ${q(s.text ?? '')}`, ...opt] : [`- inputText: ${q(s.text ?? '')}`])];
    }
    case 'eraseText':
      return [s.value ? `- eraseText: ${s.value}` : '- eraseText'];
    case 'scrollUntilVisible':
      return ['- scrollUntilVisible:', '    element:', ...selector(s, '      '), `    direction: ${s.direction ?? 'DOWN'}`, ...opt];
    case 'swipe':
      return ['- swipe:', `    direction: ${s.direction}`, ...opt];
    case 'pressKey':
      return [`- pressKey: ${q(s.value ?? '')}`];
    case 'takeScreenshot':
      return [`- takeScreenshot: ${q(s.value ?? 'screenshot')}`];
    case 'scroll':
    case 'hideKeyboard':
    case 'back':
    case 'waitForAnimationToEnd':
    case 'stopApp':
      return [`- ${s.action}`];
  }
}

export function buildMaestroFlowYaml(spec: MaestroFlowSpec): string {
  const header = [
    `appId: ${spec.appId}`,
    ...(spec.name ? [`name: ${q(spec.name)}`] : []),
    ...(spec.tags?.length ? ['tags:', ...spec.tags.map((t) => `  - ${q(t)}`)] : []),
    '---',
  ];
  return [...header, ...spec.steps.flatMap(stepYaml)].join('\n') + '\n';
}

/** File-system-safe flow file name: "ExperiBank login" → "experibank_login.yaml". */
export function flowFileName(name: string | undefined): string {
  const base = (name ?? 'flow').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'flow';
  return `${base}.yaml`;
}
