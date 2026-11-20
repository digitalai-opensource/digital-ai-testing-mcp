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

let width = 0;

/** The terminal's width in columns (0 = do not wrap: tests, piped output). */
export function setWidth(columns: number | undefined): void {
  width = columns && columns > 20 ? Math.min(columns, 110) - 1 : 0;
}

/**
 * Wraps one line at word boundaries to the terminal width. Continuation lines keep the line's indent plus two
 * spaces, so a wrapped item still reads as one item (feedback 2026-11-20: the terminal broke long lines mid-word
 * at column 0). A command to copy is never wrapped — a line break inside it would break the paste — and neither is
 * a single word longer than the width (a path); the terminal wraps those itself.
 */
export function wrap(line: string): string {
  if (!width || line.includes('\x1b[36m') || stripStyle(line).length <= width) return line;
  // The indent is the leading spaces; color codes before or between them belong to the first word (a whole line in
  // gray starts with its code, and slicing by visible length cut that code in half).
  let i = 0;
  let indent = 0;
  let codes = '';
  for (;;) {
    const code = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
    if (code) {
      codes += code[0];
      i += code[0].length;
    } else if (line[i] === ' ') {
      indent++;
      i++;
    } else break;
  }
  const words = (codes + line.slice(i)).split(' ');
  const out: string[] = [];
  let current = ' '.repeat(indent);
  let visible = indent;
  let lineHasWord = false;
  for (const w of words) {
    const len = stripStyle(w).length;
    if (lineHasWord && visible + 1 + len > width) {
      out.push(current);
      current = ' '.repeat(indent + 2) + w;
      visible = indent + 2 + len;
      continue;
    }
    current += (lineHasWord ? ' ' : '') + w;
    visible += (lineHasWord ? 1 : 0) + len;
    lineHasWord = true;
  }
  out.push(current);
  return out.join('\n');
}

/** Removes the styling again (tests of the styled form, and widths). */
export function stripStyle(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}
