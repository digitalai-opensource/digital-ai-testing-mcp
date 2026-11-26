/**
 * Failure causes as the reporter stores them, made readable and countable.
 *
 * Seen in reports (UAT 2026-11-25): Playwright causes carry terminal colour codes ("\u001b[31mTest timeout…\u001b[39m");
 * Appium wraps the real error ("Cannot start the '…' application. … Original error: <the informative part>"); a pytest
 * cause starts with the test's source lines ("driver = <appium.webdriver…> def test_login(driver): …") before the
 * "E   AssertionError" line that says what failed; and causes that differ only in a session id, a UUID or a time were
 * counted as different causes.
 */

/** Terminal colour and cursor codes, as Playwright and other runners write them into the failure text. */
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi<T extends string | null | undefined>(text: T): T {
  return (typeof text === 'string' ? text.replace(ANSI_RE, '') : text) as T;
}

/**
 * The informative part of a cause: colour codes removed; for a pytest traceback, its "E   …" lines (what failed, not
 * the source around it); for a wrapped Appium error, what follows "Original error:". Whitespace collapsed.
 */
export function causeText(cause: string | null | undefined): string {
  if (!cause) return '';
  const text = stripAnsi(cause);
  const eLines = text.split(/\r?\n/).filter((l) => /^E\s{1,}\S/.test(l)).map((l) => l.replace(/^E\s+/, ''));
  const flat = (eLines.length ? eLines.join(' ') : text).replace(/\s+/g, ' ').trim();
  return /Original error:\s*(\S.*)$/i.exec(flat)?.[1]?.trim() ?? flat;
}

/**
 * The cause as a group key: its informative part with run-specific values replaced, so two causes that differ only in
 * a session id, a UUID, a timestamp or a long number count as one.
 */
export function causeGroupKey(cause: string | null | undefined): string {
  const t = causeText(cause);
  if (!t) return '(no cause recorded)';
  return t
    .replace(/CLOUD-SID:[\w:.-]+/gi, 'CLOUD-SID:…')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '…')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[ T_]\d{1,2}[:-]\d{2}(?:[:-]\d{2})?(?:\.\d+)?Z?)?\b/g, '…')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '…')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/gi, '…')
    .replace(/\b\d{6,}\b/g, '…')
    .slice(0, 300);
}

/** A cause short enough for a table cell or a sentence: the informative part, cut at a word boundary at the END. */
export function causeQuote(cause: string, max = 120): string {
  const inner = causeText(cause) || cause.replace(/\s+/g, ' ').trim();
  if (inner.length <= max) return inner;
  const cut = inner.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s.,;:]+$/, '')}…`;
}
