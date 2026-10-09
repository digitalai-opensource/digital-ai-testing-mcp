/**
 * Small, live-verified platform changes (2026-10-09): multi-section usage-report CSVs with the 26.2 User Tag column,
 * the 25.9 2-year usage retention, and the accessibility_report flag on reporter list records.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { parseCsvSections } from '../src/utils/csv.js';
import { pickSection, summarizeRows } from '../src/utils/usage-report-summary.js';
import { usageReportRetentionNote } from '../src/utils/usage-report-guard.js';
import { formatTestReport } from '../src/utils/response-formatter.js';
import type { TestReport } from '../src/types/digital-ai.js';

// Shape of a live "Users Usage" export: per-project summary, blank line, per-user section ending in User Tag.
const USERS_USAGE =
  'Project,Start Date,End Date,Total Reservation Time (hours),Tokens\n' +
  'DigitalSSO,2026-10-01 00:00,2026-10-07 23:59,58.22,no tokens\n' +
  'JPMC POC,2026-10-01 00:00,2026-10-07 23:59,1.5,no tokens\n' +
  '\n' +
  "User ID,Username,User's first name,User's last name,User's email,Project,Total Duration (in hours),Tokens,User Tag\n" +
  '1,alice,Alice,A,alice@x.com,DigitalSSO,2.0,0,france\n' +
  '2,bob,Bob,B,bob@x.com,JPMC POC,0.5,0,"fiserv-poc, jpmcpoc"\n' +
  '3,carol,Carol,C,carol@x.com,JPMC POC,1.0,0,\n';

describe('multi-section usage reports', () => {
  it('splits blank-line-separated tables, each with its own header', () => {
    const sections = parseCsvSections(USERS_USAGE);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].headers[0], 'Project');
    assert.equal(sections[0].rows.length, 2);
    assert.equal(sections[1].headers.at(-1), 'User Tag');
    assert.equal(sections[1].rows.length, 3);
  });

  it('picks the section that has the groupBy column; Project stays on the summary table', () => {
    const sections = parseCsvSections(USERS_USAGE);
    assert.equal(pickSection(sections, { groupBy: 'Project' }), sections[0]);
    assert.equal(pickSection(sections, { groupBy: 'username' }), sections[1]);
    // sumColumn only exists in section 2, so Project + sum must resolve there
    assert.equal(pickSection(sections, { groupBy: 'Project', sumColumn: 'Total Duration (in hours)' }), sections[1]);
  });

  it('lists every section\'s columns when no section has the column', () => {
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

describe('usage retention note (2 years, platform 25.9+)', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  it('warns when the range starts before the retention window', () => {
    const note = usageReportRetentionNote('2024-01-01', now);
    assert.match(note ?? '', /retained for 2 years/);
    assert.match(note ?? '', /2024-01-01 to 2024-10-09/);
  });
  it('is silent inside the window', () => {
    assert.equal(usageReportRetentionNote('2025-06-01', now), null);
  });
});

describe('accessibility_report on list records', () => {
  const base: TestReport = {
    uuid: 'u', test_id: 1, name: 'Axe Test', status: 'Passed', status_code: 0, success: true,
    start_time: '2026-06-10T13:52:49.656Z', create_time: '2026-06-10T13:52:49.656Z', duration: 1000, project_id: 1,
    has_attachment: 'N', attachment_count: 0, attachments_size: 0,
  };
  it('shows a line only when the run has an Axe report', () => {
    assert.match(formatTestReport({ ...base, accessibility_report: true }), /Accessibility: Axe report/);
    assert.doesNotMatch(formatTestReport({ ...base, accessibility_report: false }), /Accessibility/);
  });
});
