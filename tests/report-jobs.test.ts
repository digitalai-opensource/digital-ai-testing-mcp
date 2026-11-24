/**
 * Background report jobs and the time estimates that decide when create_report offers one.
 * Estimates were calibrated against the dev tenant 2026-11-23 (see src/api/report-recipes.ts).
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  startJob, getJob, cancelJob, listJobs, describeJob, takeFinishedNotice, withReportNotice, jobDeadlineMs, fmtDuration,
  resetJobsForTests, markJobNotified, markJobCollected,
} from '../src/utils/report-jobs.js';
import { reporterEstimate, usageEstimateMs } from '../src/api/report-recipes.js';
import { fittingDays, fittingDaysBy, syncLimitMs } from '../src/tools/report-tools.js';

const tick = () => new Promise((r) => setTimeout(r, 5));
const DAY = 86_400_000;

describe('time estimates', () => {
  it('reporter: extrapolates the window from one probe page and scales with the probe speed', () => {
    // 1,000 runs spanning 2 hours → 12,000 runs/day; a 3-day window plus a 3-day comparison.
    const e = reporterEstimate({ probeRows: 1000, probeSpanMs: 2 * 3_600_000, probeMs: 2_500, failShare: 0.14, windowMs: 3 * DAY, extraWindowMs: 3 * DAY, maxRecords: 10_000, grouped: true });
    assert.equal(e.runs, 36_000);
    // plain capped at 10,000: 10,000 / (0.4 runs/ms × 1.4) ≈ 17.9 s; failures 36,000 × 14% = 5,040 at 0.16 runs/ms ≈ 31.5 s
    // (the two scans run side by side, so the longer counts) + 6 s grouped + 2 s = 39.5 s.
    assert.equal(e.ms, 39_500);
    const slow = reporterEstimate({ probeRows: 1000, probeSpanMs: 2 * 3_600_000, probeMs: 5_000, failShare: 0.14, windowMs: 3 * DAY, extraWindowMs: 3 * DAY, maxRecords: 10_000, grouped: true });
    assert.ok(slow.ms > 1.7 * (e.ms - 8_000), 'a reporter answering twice as slowly roughly doubles the scan part');
  });

  it('reporter: a project with fewer runs than one page is quick', () => {
    const e = reporterEstimate({ probeRows: 12, probeSpanMs: DAY, probeMs: 600, failShare: 0.5, windowMs: 7 * DAY, extraWindowMs: 0, maxRecords: 10_000, grouped: false });
    assert.equal(e.runs, 12);
    assert.ok(e.ms < 3_000, String(e.ms));
  });

  it('usage: end-to-end time per MB, calibrated on live runs (24 MB 14 s, 121 MB 48 s, 169 MB 87 s)', () => {
    assert.equal(usageEstimateMs(100 * 1_048_576), 51_000);
    assert.equal(usageEstimateMs(0), 3_000);
    assert.equal(usageEstimateMs(10 * 1_048_576, 1_000), 13_000, 'the per-MB cost can be given');
  });

  it('fittingDays scales the variable part of the estimate; nothing fits → 0', () => {
    assert.equal(fittingDays(30, 20_000, 45_000), 30);
    assert.equal(fittingDays(90, 188_000, 45_000), 18); // (45-8)/(188-8) × 90 = 18.5
    assert.equal(fittingDays(2, 900_000, 45_000), 0);
  });

  it('fittingDaysBy: a scan bound by maxRecords does not get faster with a smaller window, so no such window is offered', () => {
    // 12,000 runs a day, 25,000 read at most: 30 days and 17 days cost the same; only under ~2 days does the scan shrink.
    const p = { probeRows: 1000, probeSpanMs: 2 * 3_600_000, probeMs: 4_000, failShare: 0.005, extraWindowMs: 0, maxRecords: 25_000, grouped: true };
    const msFor = (days: number) => reporterEstimate({ ...p, windowMs: days * DAY }).ms;
    assert.ok(msFor(30) > 45_000 && msFor(17) === msFor(30), 'the linear rule would have offered 17 days');
    const fit = fittingDaysBy(30, msFor, 45_000);
    assert.equal(fit, 1);
    assert.ok(msFor(fit) <= 45_000 && msFor(fit + 1) > 45_000);
    assert.equal(fittingDaysBy(30, () => 60_000, 45_000), 0, 'nothing fits');
    assert.equal(fittingDaysBy(1, () => 1_000, 45_000), 0, 'no smaller window than one day');
    assert.equal(fittingDaysBy(90, (d) => 8_000 + d * 2_000, 45_000), 18, 'a linear model agrees with fittingDays');
  });

  it('the sync limit defaults to 45 s and can be configured', () => {
    const was = process.env.MCP_REPORT_SYNC_LIMIT_MS;
    try {
      delete process.env.MCP_REPORT_SYNC_LIMIT_MS;
      assert.equal(syncLimitMs(), 45_000);
      process.env.MCP_REPORT_SYNC_LIMIT_MS = '20000';
      assert.equal(syncLimitMs(), 20_000);
      process.env.MCP_REPORT_SYNC_LIMIT_MS = '10';
      assert.equal(syncLimitMs(), 45_000, 'nonsense values are ignored');
    } finally {
      if (was == null) delete process.env.MCP_REPORT_SYNC_LIMIT_MS; else process.env.MCP_REPORT_SYNC_LIMIT_MS = was;
    }
  });
});

describe('background jobs', () => {
  beforeEach(() => resetJobsForTests());
  afterEach(() => resetJobsForTests());

  it('deadline: twice the estimate or estimate + 2 min, between 5 and 60 minutes', () => {
    assert.equal(jobDeadlineMs(60_000), 5 * 60_000);
    assert.equal(jobDeadlineMs(10 * 60_000), 20 * 60_000);
    assert.equal(jobDeadlineMs(50 * 60_000), 60 * 60_000);
    assert.equal(fmtDuration(185_000), '3 min 5 s');
    assert.equal(fmtDuration(42_000), '42 s');
  });

  it('keeps the finished report in memory, reports progress, and tells the next tool result to collect it (once)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const job = startJob({ label: 'test-summary (30 days)', estimateMs: 120_000, run: async (_s, progress) => {
      progress('read 4,000 test runs');
      await gate;
      return { fileName: 'test-execution-summary.html', html: '<!DOCTYPE html>…', highlights: ['Pass rate 91%.'], runId: 'test-summary-x' };
    } });
    await tick();
    assert.match(describeJob(getJob(job.id)!), /running for .* of an estimated 2 min .*Now: read 4,000 test runs/);
    assert.equal(takeFinishedNotice(), null);
    release();
    await tick();
    assert.equal(getJob(job.id)!.status, 'done');
    assert.equal(getJob(job.id)!.result!.html, '<!DOCTYPE html>…', 'nothing written anywhere — the HTML waits in memory');
    const wrapped = withReportNotice(async () => ({ content: [{ type: 'text', text: 'devices…' }] }));
    const first = (await wrapped()) as { content: Array<{ text: string }> };
    assert.match(first.content[0].text, /Background report ready: test-summary \(30 days\)\. Collect it now with create_report jobId "job-[a-z0-9]+" .* report, test-execution-summary.html/);
    assert.equal(first.content[1].text, 'devices…');
    const second = (await wrapped()) as { content: Array<{ text: string }> };
    assert.equal(second.content.length, 1, 'announced once');
    assert.match(describeJob(getJob(job.id)!), /finished in [\s\S]*Highlights:\n- Pass rate 91%\./);
    markJobCollected(job.id);
    assert.equal(getJob(job.id)!.collected, true);
  });

  it('cancel stops the work through the signal, keeps the cancelled status and sends no notice', async () => {
    let sawAbort = false;
    const job = startJob({ label: 'usage-summary', estimateMs: 600_000, run: (signal) => new Promise((_r, reject) => {
      signal.addEventListener('abort', () => { sawAbort = true; reject(new Error('cancelled')); });
    }) });
    await tick();
    assert.equal(cancelJob(job.id)!.status, 'cancelled');
    await tick();
    assert.equal(sawAbort, true);
    assert.equal(getJob(job.id)!.status, 'cancelled');
    assert.equal(takeFinishedNotice(), null);
    assert.match(describeJob(getJob(job.id)!), /cancelled after .*No report was made/);
  });

  it('a job that passes its deadline is stopped and reported as timed out', async () => {
    const job = startJob({ label: 'slow', estimateMs: 10, deadlineMs: 20, run: (signal) => new Promise((_r, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }) });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(getJob(job.id)!.status, 'timed-out');
    assert.match(String(takeFinishedNotice()), /slow: .*stopped at its deadline/);
  });

  it('a failure is reported with its message; a status check counts as telling the user', async () => {
    const job = startJob({ label: 'device-health', estimateMs: 1_000, run: async () => { throw new Error('Digital.ai API Error [403]: Forbidden'); } });
    await tick();
    assert.equal(getJob(job.id)!.status, 'failed');
    markJobNotified(job.id);
    assert.equal(takeFinishedNotice(), null);
    assert.equal(listJobs().length, 1);
  });

  it('the notice wrapper leaves error results and results without jobs alone', async () => {
    const plain = { content: [{ type: 'text', text: 'x' }] };
    assert.equal(await withReportNotice(async () => plain)(), plain, 'no jobs → the same object');
    startJob({ label: 'quick', estimateMs: 1, run: async () => ({ fileName: 'q.html', html: '<html>', highlights: [], runId: 'r' }) });
    await tick();
    const err = { isError: true, content: [{ type: 'text', text: 'boom' }] };
    assert.equal(await withReportNotice(async () => err)(), err, 'an error result is not used to announce');
  });
});
