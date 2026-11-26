import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { parseCsv, parseCsvSections, scanCsvRows, splitCsvLine } from '../src/utils/csv.js';

describe('parseCsv', () => {
  it('parses a simple header + rows', () => {
    const { headers, rows } = parseCsv('a,b,c\n1,2,3\n4,5,6\n');
    assert.deepEqual(headers, ['a', 'b', 'c']);
    assert.deepEqual(rows, [
      ['1', '2', '3'],
      ['4', '5', '6'],
    ]);
  });

  it('handles a quoted field containing a comma', () => {
    const { headers, rows } = parseCsv('Time,User\n"Jul 20, 2026, 8:21:33 AM",jane@company.com\n');
    assert.deepEqual(headers, ['Time', 'User']);
    assert.deepEqual(rows, [['Jul 20, 2026, 8:21:33 AM', 'jane@company.com']]);
  });

  it('handles doubled-quote escaping inside a quoted field', () => {
    const { rows } = parseCsv('Note\n"She said ""hi"" to me"\n');
    assert.deepEqual(rows, [['She said "hi" to me']]);
  });

  it('handles CRLF line endings', () => {
    const { headers, rows } = parseCsv('a,b\r\n1,2\r\n3,4\r\n');
    assert.deepEqual(headers, ['a', 'b']);
    assert.deepEqual(rows, [
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('handles a file with no trailing newline', () => {
    const { headers, rows } = parseCsv('a,b\n1,2');
    assert.deepEqual(headers, ['a', 'b']);
    assert.deepEqual(rows, [['1', '2']]);
  });

  it('handles a header-only file (no data rows)', () => {
    const { headers, rows } = parseCsv('a,b,c\n');
    assert.deepEqual(headers, ['a', 'b', 'c']);
    assert.deepEqual(rows, []);
  });

  it('handles an empty string', () => {
    const { headers, rows } = parseCsv('');
    assert.deepEqual(headers, []);
    assert.deepEqual(rows, []);
  });
});

describe('parseCsvSections', () => {
  // Shape of a live "Users Usage" export (platform 26.2): per-project summary, blank line, per-user section.
  const USERS_USAGE =
    'Project,Start Date,End Date,Total Reservation Time (hours),Tokens\n' +
    'DigitalSSO,2026-10-01 00:00,2026-10-07 23:59,58.22,no tokens\n' +
    '\n' +
    "User ID,Username,User's first name,User's last name,User's email,Project,Total Duration (in hours),Tokens,User Tag\n" +
    '1,alice,Alice,A,alice@x.com,DigitalSSO,2.0,0,france\n';

  it('splits blank-line-separated tables, each with its own header', () => {
    const sections = parseCsvSections(USERS_USAGE);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].headers[0], 'Project');
    assert.equal(sections[0].rows.length, 1);
    assert.equal(sections[1].headers.at(-1), 'User Tag');
    assert.equal(sections[1].rows.length, 1);
  });
});

describe('scanCsvRows: a large file row by row', () => {
  const scan = (text: string) => { const rows: string[][] = []; scanCsvRows(Buffer.from(text, 'utf8'), (r) => rows.push(r)); return rows; };

  it('gives the same rows as parseCsv, without building the table', () => {
    const text = 'a,b,c\r\n1,"x, y",3\r\n4,"say ""hi""",6\n7,,9';
    const { headers, rows } = parseCsv(text.replace(/\r/g, ''));
    assert.deepEqual(scan(text), [headers, ...rows]);
    assert.deepEqual(splitCsvLine('1,"x, y","say ""hi""",'), ['1', 'x, y', 'say "hi"', '']);
    assert.deepEqual(splitCsvLine(''), ['']);
  });

  it('a line break inside a quoted field stays in its row; a blank line arrives as one empty field', () => {
    assert.deepEqual(scan('id,note\n1,"first line\nsecond line"\n\n2,plain\n'), [['id', 'note'], ['1', 'first line\nsecond line'], [''], ['2', 'plain']]);
    assert.deepEqual(scan(''), []);
  });

  it('reads 50,000 rows and lets the caller keep two values of each', () => {
    const lines = ['start,end,kind'];
    for (let k = 0; k < 50_000; k++) lines.push(`${1_000_000 + k},${1_000_500 + k},${k % 2 ? 'Browsers' : 'Mobile execution'}`);
    let n = 0, sum = 0;
    scanCsvRows(Buffer.from(lines.join('\n')), (r) => { if (r[0] === 'start') return; n++; sum += Number(r[1]) - Number(r[0]); });
    assert.equal(n, 50_000);
    assert.equal(sum, 50_000 * 500);
  });
});
