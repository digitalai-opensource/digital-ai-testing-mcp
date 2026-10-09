import { describe, it, beforeAll } from 'vitest';
import assert from 'node:assert/strict';
import { resolveAgentSource, loadAgentBytes, sha256Hex } from '../../src/api/test-orchestrator.js';
import { getGroupedTests, getTestByUuid } from '../../src/api/reporting.js';
import { getAllTestViews, getTestViewSummary } from '../../src/api/test-views.js';
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
  // FINDING 6: server-side start_time sort is honored for EVERY role (validated 2026-10-08 for Cloud Admin,
  // ProjectAdmin and User keys — results identical to a full scan). Older notes said project roles were
  // CSRF-blocked; listTests now attempts sort for all roles and only falls back if the platform refuses.
  // sortApplied:false here means the platform started refusing sort for this credential — the fallback
  // still keeps results correct, but revisit the fast path.
  it('server-side start_time sort is applied and returns newest first', async () => {
    const res = await listTests({ limit: 10, page: 1, sort: [{ property: 'start_time', descending: true }] });
    assert.equal(res.sortApplied, true, 'platform refused sort for this credential — listTests fell back to unsorted');
    const ts = res.data.map((r) => r.start_time);
    assert.ok(ts.every((t, i) => i === 0 || ts[i - 1] >= t), 'results are not newest-first');
  });

  // FINDING 7 (2026-10-09): the reporter has SIX statuses. A grouped call with pivotBy ["status"] and NO groupBy
  // returns one aggregate row carrying all of them — get_project_test_summary relies on that. If a NEW column appears,
  // add it to src/utils/test-status.ts (countsFromPivotRow already keeps it in `total` via _count_).
  it('grouped pivotBy status returns one row with all six status columns', async () => {
    const res = await getGroupedTests({ pivotBy: ['status'] }) as { data?: Array<Record<string, unknown>> };
    const row = res.data?.[0];
    assert.ok(row, 'no aggregate row — get_project_test_summary would report zeros');
    for (const k of ['passedCount', 'failedCount', 'errorCount', 'incompleteCount', 'skippedCount', 'healedCount', '_count_']) {
      assert.ok(k in row!, `pivot row missing ${k}`);
    }
    const known = ['passedCount', 'failedCount', 'errorCount', 'incompleteCount', 'skippedCount', 'healedCount']
      .reduce((n, k) => n + Number(row![k]), 0);
    assert.equal(known, Number(row!['_count_']), 'a status column exists that test-status.ts does not know');
  });

  // FINDING 8 (2026-10-09): the test-view summary path is /{id}/summary. `{id}:summary` is parsed as the id → 400.
  it('test view summary is served at /testView/{id}/summary', async () => {
    const views = await getAllTestViews();
    if (views.length === 0) return; // nothing to probe on this tenant
    const s = await getTestViewSummary(views[0].id);
    assert.equal(typeof s._count_, 'number');
    assert.equal(typeof s.errorCount, 'number', 'view summary stopped returning errorCount');
  });

  // FINDING 9 (2026-10-09): reports resolve by UUID (global) at /reporter/api/reports/{uuid}; get_test_report and
  // list_test_attachments prefer it because numeric test_ids collide across reporter scopes.
  it('GET /reporter/api/reports/{uuid} returns the same report as the numeric id', async () => {
    const list = await listTests({ limit: 1, page: 1 });
    const t = list.data[0];
    assert.ok(t, 'precondition: at least one test must exist');
    const byUuid = await getTestByUuid(t.uuid);
    assert.equal(byUuid.test_id, t.test_id);
    assert.equal(byUuid.uuid, t.uuid);
  });

  it('applications filter is honored server-side (fake bundle returns none)', async () => {
    const all = await getApplications();
    const filtered = await getApplications({ bundleIdentifier: 'com.nonexistent.zzz999.audit' });
    assert.ok(Array.isArray(all), 'unfiltered applications should be an array');
    assert.equal(filtered.length, 0, 'server ignored bundleIdentifier filter — it returned apps that do not match');
  });
});

// The Test Orchestrator agent is NOT shipped with the package — install_test_orchestrator_agent downloads it on
// demand from the location pinned in resources/test-orchestrator/agent.json. If this fails, the pinned file moved or
// changed upstream: update downloadUrl + sha256 in agent.json (never relax the checksum).
describe('Test Orchestrator pinned download location', () => {
  it('serves exactly the pinned file (size + SHA-256)', async () => {
    const source = resolveAgentSource({});
    const bytes = await loadAgentBytes(source);
    assert.equal(sha256Hex(bytes), source.sha256);
  }, 120000);
});
