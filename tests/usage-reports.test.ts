import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  usageReportUtcMs,
  validateUsageReportParams,
  checkUsageReportSizeGuard,
  USAGE_REPORT_TYPES,
  MAX_UNSCOPED_RANGE_DAYS,
} from '../src/utils/usage-report-guard.js';
import { buildUsageReportPath } from '../src/api/usage-reports.js';

describe('usageReportUtcMs', () => {
  it('anchors to UTC midnight regardless of host timezone', () => {
    assert.equal(usageReportUtcMs('2026-06-01', 'start'), Date.UTC(2026, 5, 1, 0, 0, 0, 0));
    assert.equal(usageReportUtcMs('2026-06-30', 'end'), Date.UTC(2026, 5, 30, 23, 59, 59, 999));
  });
});

describe('USAGE_REPORT_TYPES capabilities', () => {
  it('License Usage supports neither project nor user filtering', () => {
    assert.equal(USAGE_REPORT_TYPES['License Usage'].supportsProject, false);
    assert.equal(USAGE_REPORT_TYPES['License Usage'].supportsUser, false);
  });

  it('Devices Usage and Browser Usage support project but not user', () => {
    for (const type of ['Devices Usage', 'Browser Usage'] as const) {
      assert.equal(USAGE_REPORT_TYPES[type].supportsProject, true);
      assert.equal(USAGE_REPORT_TYPES[type].supportsUser, false);
    }
  });

  it('Users Statistics wire value uses the correctly-spelled string (confirmed live)', () => {
    assert.equal(USAGE_REPORT_TYPES['Users Statistics'].wireValue, 'Users Statistics');
  });
});

describe('validateUsageReportParams', () => {
  it('accepts a well-formed request', () => {
    assert.equal(
      validateUsageReportParams({ reportType: 'License Usage', startDate: '2026-06-01', endDate: '2026-06-30' }),
      null
    );
  });

  it('rejects malformed dates', () => {
    assert.notEqual(
      validateUsageReportParams({ reportType: 'License Usage', startDate: '2026/06/01', endDate: '2026-06-30' }),
      null
    );
    assert.notEqual(
      validateUsageReportParams({ reportType: 'License Usage', startDate: '2026-06-01', endDate: 'not-a-date' }),
      null
    );
  });

  it('rejects endDate before startDate', () => {
    assert.notEqual(
      validateUsageReportParams({ reportType: 'License Usage', startDate: '2026-06-30', endDate: '2026-06-01' }),
      null
    );
  });

  it('rejects projectId for License Usage', () => {
    assert.notEqual(
      validateUsageReportParams({
        reportType: 'License Usage',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        projectId: 5,
      }),
      null
    );
  });

  it('rejects userId for Devices Usage and Browser Usage', () => {
    for (const reportType of ['Devices Usage', 'Browser Usage'] as const) {
      assert.notEqual(
        validateUsageReportParams({ reportType, startDate: '2026-06-01', endDate: '2026-06-01', userId: 5 }),
        null
      );
    }
  });

  it('accepts projectId/userId for report types that support them', () => {
    assert.equal(
      validateUsageReportParams({
        reportType: 'Device Reservations',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        projectId: 5,
        userId: 9,
      }),
      null
    );
  });
});

describe('checkUsageReportSizeGuard', () => {
  it('does not trigger for a range at or under the threshold with no filter', () => {
    assert.equal(
      checkUsageReportSizeGuard({
        reportType: 'License Usage',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
      }),
      null
    );
  });

  it(`triggers for an unfiltered range over ${MAX_UNSCOPED_RANGE_DAYS} days`, () => {
    const msg = checkUsageReportSizeGuard({
      reportType: 'License Usage',
      startDate: '2026-01-01',
      endDate: '2026-06-30',
    });
    assert.notEqual(msg, null);
    assert.match(msg as string, /Large export guard triggered/);
  });

  it('a project filter avoids the guard even for a wide range, when the report type supports it', () => {
    assert.equal(
      checkUsageReportSizeGuard({
        reportType: 'Device Reservations',
        startDate: '2026-01-01',
        endDate: '2026-06-30',
        projectId: 27754602,
      }),
      null
    );
  });

  it('projectId=0 is treated as "All projects" and does NOT avoid the guard', () => {
    const msg = checkUsageReportSizeGuard({
      reportType: 'Device Reservations',
      startDate: '2026-01-01',
      endDate: '2026-06-30',
      projectId: 0,
    });
    assert.notEqual(msg, null);
  });

  it('License Usage cannot be narrowed by filter — the guard fires on range alone', () => {
    const msg = checkUsageReportSizeGuard({
      reportType: 'License Usage',
      startDate: '2026-01-01',
      endDate: '2026-06-30',
    });
    assert.notEqual(msg, null);
    assert.match(msg as string, /has no project\/user filter available/);
  });

  it('confirmLargeExport:true bypasses the guard unconditionally', () => {
    assert.equal(
      checkUsageReportSizeGuard({
        reportType: 'License Usage',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        confirmLargeExport: true,
      }),
      null
    );
  });
});

describe('buildUsageReportPath', () => {
  it('builds the documented path shape with 0 for omitted project/user', () => {
    const path = buildUsageReportPath('License Usage', { startDate: '2026-06-01', endDate: '2026-06-30' });
    assert.equal(
      path,
      `/api/v2/configuration/get-CSV-reports/0/0/${Date.UTC(2026, 5, 1)}/${Date.UTC(2026, 5, 30, 23, 59, 59, 999)}/License%20Usage`
    );
  });

  it('uses the correctly-spelled wire value for Users Statistics', () => {
    const path = buildUsageReportPath('Users Statistics', { startDate: '2026-06-01', endDate: '2026-06-01' });
    assert.match(path, /Users%20Statistics$/);
  });

  it('places projectId and userId in the correct segment order', () => {
    const path = buildUsageReportPath('Device Reservations', {
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      projectId: 27754602,
      userId: 26062411,
    });
    assert.match(path, /^\/api\/v2\/configuration\/get-CSV-reports\/27754602\/26062411\//);
  });
});
