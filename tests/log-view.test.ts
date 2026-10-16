/**
 * get_test_log line selection (src/utils/log-view.ts). Regression target: debug-mode intake 2026-10-16 —
 * get_test_log averaged ~66k characters per call (maxLines 400 → ~80k, 2000 → ~119k) because Appium log lines
 * are long; contains + maxChars bound the response.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { selectLogLines } from '../src/utils/log-view.js';

const LOG = Array.from({ length: 20 }, (_, i) => `line ${i}${i === 5 || i === 15 ? ' ERROR boom' : ''}`).join('\n');

describe('selectLogLines', () => {
  it('without a filter returns the last maxLines lines', () => {
    const v = selectLogLines(LOG, { maxLines: 3 });
    assert.equal(v.text, 'line 17\nline 18\nline 19');
    assert.equal(v.totalLines, 20);
    assert.equal(v.shownLines, 3);
    assert.equal(v.truncated, true);
    assert.equal(v.charCapped, false);
  });

  it('contains keeps matches plus context, case-insensitively, with "--" between groups', () => {
    const v = selectLogLines(LOG, { maxLines: 200, contains: 'error', context: 1 });
    assert.equal(v.text, 'line 4\nline 5 ERROR boom\nline 6\n--\nline 14\nline 15 ERROR boom\nline 16');
    assert.equal(v.matches, 2);
    assert.equal(v.shownLines, 6);
    assert.equal(v.truncated, false);
  });

  it('with contains, maxLines counts matches — context lines are free', () => {
    const last = selectLogLines(LOG, { maxLines: 1, contains: 'error', context: 1 });
    assert.equal(last.text, 'line 14\nline 15 ERROR boom\nline 16');
    assert.equal(last.truncated, true);
    const both = selectLogLines(LOG, { maxLines: 2, contains: 'error', context: 3 });
    assert.equal(both.shownLines, 14, 'two matches with 3 lines of context each');
    assert.equal(both.truncated, false);
  });

  it('maxChars keeps whole lines from the end and says it cut', () => {
    const long = Array.from({ length: 10 }, (_, i) => `${i}:${'x'.repeat(98)}`).join('\n'); // 100 chars + newline each
    const v = selectLogLines(long, { maxLines: 200, maxChars: 350 });
    assert.equal(v.shownLines, 3);
    assert.ok(v.text.startsWith('7:'));
    assert.equal(v.charCapped, true);
    assert.equal(v.truncated, true);
  });

  it('a single line longer than maxChars is cut to its end rather than dropped', () => {
    const v = selectLogLines(`short\n${'y'.repeat(5000)}END`, { maxLines: 200, maxChars: 1000 });
    assert.equal(v.shownLines, 1);
    assert.equal(v.text.length, 1000);
    assert.ok(v.text.endsWith('END'));
    assert.equal(v.charCapped, true, 'a sliced line is a cut and must be reported as one');
    assert.equal(v.truncated, true);
  });

  it('a filter with no matches returns nothing, not the whole log', () => {
    const v = selectLogLines(LOG, { maxLines: 200, contains: 'nope' });
    assert.equal(v.text, '');
    assert.equal(v.matches, 0);
  });
});
