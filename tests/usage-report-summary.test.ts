import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { parseCsv, parseCsvSections } from '../src/utils/csv.js';
import { summarizeRows, pickSection } from '../src/utils/usage-report-summary.js';

const LICENSE_USAGE_SAMPLE =
  'Session Start Timestamp,Session End Timestamp,Session Duration (in hours),Username,Project\n' +
  '1,2,0.5,jane@company.com,DigitalSSO\n' +
  '3,4,1.5,jane@company.com,DigitalSSO\n' +
  '5,6,0.25,bob@company.com,DAIMCP POC\n' +
  '7,8,2.0,jane@company.com,DAIMCP POC\n';

describe('summarizeRows', () => {
  it('groups by a column and counts occurrences, sorted descending', () => {
    const parsed = parseCsv(LICENSE_USAGE_SAMPLE);
    const summary = summarizeRows(parsed, { groupBy: 'Username' });
    assert.equal(summary.totalRows, 4);
    assert.equal(summary.totalGroups, 2);
    assert.deepEqual(summary.groups, [
      { value: 'jane@company.com', count: 3 },
      { value: 'bob@company.com', count: 1 },
    ]);
    assert.equal(summary.truncated, false);
  });

  it('is case-insensitive when matching the groupBy column name', () => {
    const parsed = parseCsv(LICENSE_USAGE_SAMPLE);
    const summary = summarizeRows(parsed, { groupBy: 'username' });
    assert.equal(summary.totalGroups, 2);
  });

  it('sums a numeric column per group when sumColumn is provided', () => {
    const parsed = parseCsv(LICENSE_USAGE_SAMPLE);
    const summary = summarizeRows(parsed, { groupBy: 'Username', sumColumn: 'Session Duration (in hours)' });
    const jane = summary.groups.find((g) => g.value === 'jane@company.com');
    const bob = summary.groups.find((g) => g.value === 'bob@company.com');
    assert.equal(jane?.sum, 4);
    assert.equal(bob?.sum, 0.25);
  });

  it('throws a discoverable error listing real columns when groupBy does not match', () => {
    const parsed = parseCsv(LICENSE_USAGE_SAMPLE);
    assert.throws(
      () => summarizeRows(parsed, { groupBy: 'NotAColumn' }),
      /groupBy column "NotAColumn" not found\. Available columns: .*Username/
    );
  });

  it('throws a discoverable error listing real columns when sumColumn does not match', () => {
    const parsed = parseCsv(LICENSE_USAGE_SAMPLE);
    assert.throws(
      () => summarizeRows(parsed, { groupBy: 'Username', sumColumn: 'NotAColumn' }),
      /sumColumn "NotAColumn" not found\. Available columns:/
    );
  });

  it('truncates to topN, sorted by count, and reports truncation', () => {
    const parsed = parseCsv(LICENSE_USAGE_SAMPLE);
    const summary = summarizeRows(parsed, { groupBy: 'Username', topN: 1 });
    assert.equal(summary.groups.length, 1);
    assert.equal(summary.groups[0].value, 'jane@company.com');
    assert.equal(summary.totalGroups, 2);
    assert.equal(summary.truncated, true);
  });

  it('skips fully-blank trailing rows', () => {
    const parsed = parseCsv(LICENSE_USAGE_SAMPLE + ',,,,\n');
    const summary = summarizeRows(parsed, { groupBy: 'Username' });
    assert.equal(summary.totalRows, 4);
  });

  it('reports availableColumns for downstream discoverability', () => {
    const parsed = parseCsv(LICENSE_USAGE_SAMPLE);
    const summary = summarizeRows(parsed, { groupBy: 'Username' });
    assert.deepEqual(summary.availableColumns, [
      'Session Start Timestamp',
      'Session End Timestamp',
      'Session Duration (in hours)',
      'Username',
      'Project',
    ]);
  });
});

describe('multi-section usage reports (Users Usage, platform 26.2 User Tag column)', () => {
  const USERS_USAGE =
    'Project,Start Date,End Date,Total Reservation Time (hours),Tokens\n' +
    'DigitalSSO,2026-10-01 00:00,2026-10-07 23:59,58.22,no tokens\n' +
    'JPMC POC,2026-10-01 00:00,2026-10-07 23:59,1.5,no tokens\n' +
    '\n' +
    "User ID,Username,User's first name,User's last name,User's email,Project,Total Duration (in hours),Tokens,User Tag\n" +
    '1,alice,Alice,A,alice@x.com,DigitalSSO,2.0,0,france\n' +
    '2,bob,Bob,B,bob@x.com,JPMC POC,0.5,0,"fiserv-poc, jpmcpoc"\n' +
    '3,carol,Carol,C,carol@x.com,JPMC POC,1.0,0,\n';

  it('picks the section that has the groupBy column; Project stays on the summary table', () => {
    const sections = parseCsvSections(USERS_USAGE);
    assert.equal(pickSection(sections, { groupBy: 'Project' }), sections[0]);
    assert.equal(pickSection(sections, { groupBy: 'username' }), sections[1]);
    // sumColumn only exists in section 2, so Project + sum must resolve there
    assert.equal(pickSection(sections, { groupBy: 'Project', sumColumn: 'Total Duration (in hours)' }), sections[1]);
  });

  it("lists every section's columns when no section has the column", () => {
    assert.throws(() => pickSection(parseCsvSections(USERS_USAGE), { groupBy: 'Nope' }), /section 1: Project.*section 2: User ID/);
  });

  it('splits comma-separated User Tag cells into one bucket per tag and says so', () => {
    const sec = pickSection(parseCsvSections(USERS_USAGE), { groupBy: 'User Tag' });
    const r = summarizeRows(sec, { groupBy: 'User Tag', sumColumn: 'Total Duration (in hours)' });
    assert.equal(r.valuesSplit, true);
    assert.equal(r.totalRows, 3);
    const byTag = Object.fromEntries(r.groups.map((g) => [g.value, g.sum]));
    assert.deepEqual(byTag, { france: 2, 'fiserv-poc': 0.5, jpmcpoc: 0.5, '': 1 });
  });

  it('does not split non-tag columns', () => {
    const r = summarizeRows({ headers: ['Project'], rows: [['A, B']] }, { groupBy: 'Project' });
    assert.equal(r.valuesSplit, undefined);
    assert.deepEqual(r.groups, [{ value: 'A, B', count: 1 }]);
  });
});
