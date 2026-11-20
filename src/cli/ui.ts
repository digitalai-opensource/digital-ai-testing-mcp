/**
 * Terminal styling for the setup command: color by meaning, and only in a real terminal. Off by default, so tests,
 * piped output (`setup doctor > report.txt`) and anything not started through terminalIO() stay plain text.
 *
 * Plain SGR codes, no glyphs: the classic Windows console (PowerShell 5.1, cmd) shows a box for symbols such as ✓
 * with its default font, while it renders these colors (Windows 10+ consoles understand VT sequences, and Node turns
 * that mode on for a TTY). "Faint" (SGR 2) is not used for the same reason — bright black (90) is the gray.
 */

let enabled = false;

export function setColor(on: boolean): void {
  enabled = on;
}

/** https://no-color.org, FORCE_COLOR, a TTY, and not TERM=dumb. */
export function colorWanted(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  return Boolean(stream.isTTY) && env.TERM !== 'dumb';
}

const sgr = (open: number, close: number) => (text: string) => (enabled && text ? `\x1b[${open}m${text}\x1b[${close}m` : text);

export const bold = sgr(1, 22);
export const gray = sgr(90, 39);
export const green = sgr(32, 39);
export const yellow = sgr(33, 39);
export const red = sgr(31, 39);
export const cyan = sgr(36, 39);

/** A command to copy: cyan, so it stands out from the prose around it. */
export const command = cyan;

/** "Step 1 of 3  Connect …" — a step of the guided setup. */
export function step(n: number, total: number, title: string): string {
  return bold(`Step ${n} of ${total}  ${title}`);
}

/**
 * A question: the text bold, a trailing [Y/n] / [y/N] / [default] and an "(e.g. …)" example gray, so the answer
 * choices read as a hint rather than as part of the question.
 */
export function prompt(question: string): string {
  if (!enabled) return question;
  const m = /^(.*?)(\s*\((?:e\.g\.|for example)[^)]*\))?(\s*\[[^\]]*\])?(:?\s*)$/s.exec(question);
  if (!m) return bold(question);
  const [, text, example = '', choices = '', tail] = m;
  return `${bold(text)}${gray(example)}${gray(choices)}${tail}`;
}

/** Removes the styling again (tests of the styled form, and widths). */
export function stripStyle(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}
