/**
 * Line selection for get_test_log — pure, so it is unit-tested without an attachment ZIP.
 * Appium log lines are long (capability JSON), so a line count alone is a poor size bound: 400 lines measured
 * ~80k characters live. `contains` narrows to matching lines plus context; `maxChars` is the hard ceiling and keeps
 * the END of the selection (where the failure usually is).
 */

export const DEFAULT_LOG_MAX_CHARS = 40_000;
export const DEFAULT_LOG_CONTEXT = 3;

export interface LogViewOptions {
  /** Lines from the end; with `contains`, the number of MATCHES from the end (context lines come free). */
  maxLines: number;
  /** Case-insensitive substring; only matching lines (plus `context` lines either side) are kept. */
  contains?: string;
  context?: number;
  maxChars?: number;
}

export interface LogView {
  text: string;
  totalLines: number;
  /** Lines in `text` (excluding "--" group separators). */
  shownLines: number;
  /** Lines that matched `contains`; undefined without a filter. */
  matches?: number;
  /** True when maxLines or maxChars cut the selection. */
  truncated: boolean;
  /** True when maxChars (not maxLines) was the limit that cut it. */
  charCapped: boolean;
}

export function selectLogLines(content: string, opts: LogViewOptions): LogView {
  const lines = content.split('\n');
  const maxChars = opts.maxChars ?? DEFAULT_LOG_MAX_CHARS;

  // Each entry is a line index, or -1 for a "--" separator between non-adjacent match groups.
  let picked: number[];
  let matches: number | undefined;
  let truncated = false;
  if (opts.contains) {
    const needle = opts.contains.toLowerCase();
    const ctx = Math.max(0, opts.context ?? DEFAULT_LOG_CONTEXT);
    // Groups of adjacent kept lines, each holding at least one match; maxLines counts matches, so whole groups are
    // taken from the end until that many matches are in — context lines never use up the budget.
    const isMatch = lines.map((l) => l.toLowerCase().includes(needle));
    matches = isMatch.filter(Boolean).length;
    const groups: number[][] = [];
    let current: number[] | null = null;
    for (let i = 0; i < lines.length; i++) {
      const near = isMatch.slice(Math.max(0, i - ctx), i + ctx + 1).some(Boolean);
      if (!near) { current = null; continue; }
      if (!current) { current = []; groups.push(current); }
      current.push(i);
    }
    const taken: number[][] = [];
    let matchCount = 0;
    for (let g = groups.length - 1; g >= 0; g--) {
      if (matchCount >= opts.maxLines) { truncated = true; break; }
      taken.unshift(groups[g]);
      matchCount += groups[g].filter((i) => isMatch[i]).length;
    }
    picked = taken.flatMap((g, n) => (n === 0 ? g : [-1, ...g]));
  } else {
    const start = Math.max(0, lines.length - opts.maxLines);
    truncated = start > 0;
    picked = lines.slice(start).map((_, i) => start + i);
  }

  // Walk back from the end, keeping whole lines until maxChars characters.
  const kept: number[] = [];
  let real = 0;
  let size = 0;
  let charCapped = false;
  for (let k = picked.length - 1; k >= 0; k--) {
    const idx = picked[k];
    const len = (idx === -1 ? 2 : lines[idx].length) + 1;
    if (size + len > maxChars) {
      if (real > 0) { truncated = true; charCapped = true; break; }
      // The very last line alone exceeds the cap: keep its tail, and say so.
      truncated = true;
      charCapped = true;
    }
    kept.unshift(idx);
    size += len;
    if (idx >= 0) real++;
  }
  while (kept[0] === -1) kept.shift();

  const text = kept
    .map((idx) => (idx === -1 ? '--' : lines[idx].length > maxChars ? lines[idx].slice(-maxChars) : lines[idx]))
    .join('\n');
  return { text, totalLines: lines.length, shownLines: real, matches, truncated, charCapped };
}
