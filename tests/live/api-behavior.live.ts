import { describe, it, beforeAll } from 'vitest';
import assert from 'node:assert/strict';
import {
  getTestById,
  listTests,
  getApplications,
} from '../helpers/test-client.js';

// ─────────────────────────────────────────────────────────────────────────────
// LIVE API-BEHAVIOR PROBES
//
// Each assertion here locks in a backend behavior that was discovered ONLY by
// probing the live API during the v47 audit — the kind of thing a static code
// review and the mocked handler tests in tests/tools.test.ts cannot see.
//
// A failure here is not necessarily a bug in THIS repo — it may mean the
// Digital.ai backend behavior changed. When one fails, re-read the linked
// finding and decide whether a tool/description needs to change.
//
// Run with: npm run test:live   (requires a populated .env)
// ─────────────────────────────────────────────────────────────────────────────

const HAS_CREDS = !!process.env.DIGITAL_AI_ACCESS_KEY;

describe.skipIf(!HAS_CREDS)('Live API behavior probes', () => {
  let sampleTestId: number | undefined;
  let failedListRecord: Record<string, unknown> | undefined;

  beforeAll(async () => {
    const list = await listTests({ limit: 20, page: 1 });
    sampleTestId = list.data[0]?.test_id;
    failedListRecord = list.data.find((r) => r.status === 'Failed') as Record<string, unknown> | undefined
      ?? (list.data[0] as Record<string, unknown> | undefined);
  });

  // FINDING 1 (barrier #1): the numeric-id endpoint silently ignores includeSteps.
  // get_test_report removed the param on this basis. If this assertion ever fails,
  // the backend started returning steps by numeric id — revisit that removal.
  it('get_test_report (numeric id) does not return a steps array', async () => {
    assert.ok(sampleTestId != null, 'precondition: at least one test must exist');
    const report = await getTestById(sampleTestId!);
    assert.equal(
      report.steps,
      undefined,
      'numeric-id endpoint unexpectedly returned steps — re-evaluate get_test_report includeSteps removal'
    );
  });

  // FINDING 2 (barrier #3): the LIST endpoint does not carry per-record failure
  // diagnostics. This is why they can only be surfaced via get_test_report, and
  // why list_test_reports documents that. If the list starts carrying these,
  // we could surface diagnostics in the list view directly.
  it('list endpoint records do not carry cause / keyValuePairs', async () => {
    assert.ok(failedListRecord != null, 'precondition: at least one test must exist');
    assert.ok(!('keyValuePairs' in failedListRecord!), 'list record unexpectedly carries keyValuePairs');
    assert.ok(!('cause' in failedListRecord!), 'list record unexpectedly carries cause');
  });

  // FINDING 2 (companion): the single-record endpoint DOES expose the diagnostic
  // fields (they are normalized onto every TestReport, populated when the backend
  // classified the failure). Asserts the detail path carries the contract.
  it('get_test_report (single record) exposes the diagnostic field contract', async () => {
    assert.ok(sampleTestId != null, 'precondition: at least one test must exist');
    const report = await getTestById(sampleTestId!);
    // These keys are part of the normalized TestReport shape regardless of value.
    assert.ok('cause' in report, 'detail record missing cause field');
    assert.ok('errorCategory' in report, 'detail record missing errorCategory field');
    assert.ok('errorDetail' in report, 'detail record missing errorDetail field');
  });

  // FINDING 3 (Cat-1 cleared): /api/v1/applications filters server-side. A bundle
  // that cannot exist must return zero apps; if it returns the full list, the
  // server is ignoring the filter and our filter params are decorative.
  it('applications filter is honored server-side (fake bundle returns none)', async () => {
    const all = await getApplications();
    const filtered = await getApplications({ bundleIdentifier: 'com.nonexistent.zzz999.audit' });
    assert.ok(Array.isArray(all), 'unfiltered applications should be an array');
    assert.equal(filtered.length, 0, 'server ignored bundleIdentifier filter — it returned apps that do not match');
  });
});
