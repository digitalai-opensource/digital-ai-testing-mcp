import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/utils/csv.js';
import { summarizeRows } from '../src/utils/usage-report-summary.js';

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
