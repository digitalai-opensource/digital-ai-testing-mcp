/**
 * Test Run API — run Espresso, XCUITest and Maestro suites on the cloud (no client-side driver).
 *
 * Verified live 2026-10-09 with a passing Maestro run (ExperiBank login flow, Galaxy S10, 76 s):
 *  - POST /api/v1/test-run/execute-test-run-async, multipart. deviceQueries goes in the QUERY STRING (repeat for several).
 *    cloudApp is the NUMERIC application id — a name 400s ("Failed to convert ... to required type 'java.lang.Long'").
 *  - Maestro: the flow ZIP is the `tests` field and MUST contain a flows/ directory ("Maestro bundle should contain a
 *    'flows' directory with at least one flow file"). Android devices only.
 *  - Response: { data: { "Test Run Id": "27971404", "Link to Reporter": "..." } }
 *  - GET /api/v1/test-run/{id}/status → { data: { "Test Run State": Starting|Running|Finished, "Number of ... tests": "<n>" } }.
 *    Counts are strings and can briefly read "-1" mid-run. Unknown id → 404 "Test Run with id : N does not exist".
 *  - Each test lands in the Reporter with test.run.id=<id> and test.framework (e.g. Maestro).
 * Espresso / XCUITest fields (testApp / testAppUrl / cloudTestApp, includeTests, useTestOrchestrator, …) follow the
 * platform's "Manage Test Run with the API" reference; they were not exercised live (no test package on the dev tenant).
 */
import { createReadStream, existsSync, statSync } from 'fs';
import FormData from 'form-data';
import AdmZip from 'adm-zip';
import { apiGet, apiPost, apiPostForm } from './client.js';

export const TEST_RUN_EXECUTION_TYPES = ['ESPRESSO', 'XCUITEST', 'MAESTRO'] as const;
export type TestRunExecutionType = (typeof TEST_RUN_EXECUTION_TYPES)[number];
export const TEST_RUN_RUNNING_TYPES = ['fastFeedback', 'coverage'] as const;
export type TestRunRunningType = (typeof TEST_RUN_RUNNING_TYPES)[number];

export interface TestRunRequest {
  executionType: TestRunExecutionType;
  runningType: TestRunRunningType;
  /** Exactly one app source. */
  appPath?: string;
  appUrl?: string;
  cloudAppId?: number;
  /** Exactly one test source: Espresso/XCUITest test package (.zip) or Maestro flow bundle (.zip with flows/). */
  testsPath?: string;
  testsUrl?: string;
  cloudTestAppId?: number;
  deviceQueries: string[];
  maxDevices?: number;
  minDevices?: number;
  retry?: number;
  retryDifferentDevice?: boolean;
  overallTimeoutMs?: number;
  creationTimeoutMs?: number;
  reservationDurationMin?: number;
  includeTests?: string[];
  runTags?: Record<string, string>;
  additionalAppIds?: number[];
  /** iOS provisioning profile UUID used to sign the app and test app. */
  provisioningProfileUuid?: string;
  useTestOrchestrator?: boolean;
  clearPackageData?: boolean;
  useUIAutomator?: boolean;
}

export interface TestRunStatus {
  testRunId: string;
  state: string;
  finished: boolean;
  counts: {
    inFile: number | null;
    requested: number | null;
    total: number | null;
    passed: number | null;
    failed: number | null;
    skipped: number | null;
    running: number | null;
    queued: number | null;
    ignored: number | null;
  };
  reporterLink: string | null;
}

/**
 * Multipart field names for the test bundle. The FILE field is `tests` for Maestro (verified live) and `testApp` for
 * Espresso/XCUITest (reference); the URL / cloud-id variants are the reference's testAppUrl / cloudTestApp for all.
 */
export function testsFieldName(t: TestRunExecutionType): { file: string; url: string; cloud: string } {
  return { file: t === 'MAESTRO' ? 'tests' : 'testApp', url: 'testAppUrl', cloud: 'cloudTestApp' };
}

/** Validation shared by the executor and the command generator. Returns an error message, or null. */
export function validateTestRunRequest(r: TestRunRequest): string | null {
  const appSources = [r.appPath, r.appUrl, r.cloudAppId].filter((v) => v != null && v !== '').length;
  if (appSources !== 1) return 'Provide exactly one app source: appPath, appUrl or cloudAppId (numeric application id from list_applications).';
  const testSources = [r.testsPath, r.testsUrl, r.cloudTestAppId].filter((v) => v != null && v !== '').length;
  if (testSources !== 1) return 'Provide exactly one test source: testsPath, testsUrl or cloudTestAppId.';
  if (r.executionType === 'MAESTRO' && !r.testsPath) {
    // Verified live: the platform demands the multipart file field ("tests is required when Execution type is MAESTRO").
    return 'MAESTRO needs the flow bundle as a file: pass testsPath (a .zip containing flows/*.yaml).';
  }
  if (r.deviceQueries.length === 0) return 'Provide at least one deviceQuery, e.g. "@os=\'android\' and @category=\'PHONE\'".';
  if (r.runningType === 'fastFeedback' && r.deviceQueries.length > 1) {
    return 'fastFeedback takes exactly ONE deviceQuery (use maxDevices to spread tests); use coverage for one device per query.';
  }
  if (r.executionType === 'MAESTRO' && r.deviceQueries.some((q) => /@os\s*=\s*'ios'/i.test(q))) {
    return 'Maestro runs on Android devices only.';
  }
  if (r.executionType === 'MAESTRO' && (r.useTestOrchestrator || r.clearPackageData || r.useUIAutomator || r.includeTests?.length || r.provisioningProfileUuid)) {
    return 'includeTests, useTestOrchestrator, clearPackageData, useUIAutomator and provisioningProfileUuid are not supported with MAESTRO.';
  }
  if (r.retry != null && (r.retry < 0 || r.retry > 5)) return 'retry must be 0–5.';
  return null;
}

/**
 * Pre-flight a local Maestro bundle the same way the platform does, so a bad ZIP fails here (instantly) instead of
 * after an upload. Returns an error message, or null. Only reads the archive's directory — nothing is extracted.
 */
export function checkMaestroBundle(zipPath: string): string | null {
  if (!/\.zip$/i.test(zipPath)) return 'The Maestro bundle must be a .zip file.';
  let names: string[];
  try {
    names = new AdmZip(zipPath).getEntries().map((e) => e.entryName.replace(/\\/g, '/'));
  } catch (e) {
    return `Could not read the Maestro bundle as a ZIP: ${(e as Error).message}`;
  }
  const flows = names.filter((n) => /(^|\/)flows\/[^/]+\.ya?ml$/i.test(n));
  if (flows.length === 0) {
    return 'The Maestro bundle must contain a flows/ directory with at least one .yaml flow (the platform rejects it otherwise). ' +
      `Entries found: ${names.slice(0, 10).join(', ') || '(none)'}.`;
  }
  return null;
}

/** Query string carrying the device queries (verified: the platform reads deviceQueries from the URL). */
export function deviceQueriesQueryString(queries: string[]): string {
  // Also encode ' (encodeURIComponent leaves it) so the URL is safe inside generated shell commands.
  return queries.map((q) => `deviceQueries=${encodeURIComponent(q).replace(/'/g, '%27')}`).join('&');
}

/** Scalar multipart fields (everything except the files), shared with the command generator. */
export function testRunScalarFields(r: TestRunRequest): Array<[string, string]> {
  const f: Array<[string, string]> = [
    ['executionType', r.executionType],
    ['runningType', r.runningType],
  ];
  const names = testsFieldName(r.executionType);
  if (r.appUrl) f.push(['appUrl', r.appUrl]);
  if (r.cloudAppId != null) f.push(['cloudApp', String(r.cloudAppId)]);
  if (r.testsUrl) f.push([names.url, r.testsUrl]);
  if (r.cloudTestAppId != null) f.push([names.cloud, String(r.cloudTestAppId)]);
  if (r.maxDevices != null) f.push(['maxDevices', String(r.maxDevices)]);
  if (r.minDevices != null) f.push(['minDevices', String(r.minDevices)]);
  if (r.retry != null) f.push(['retry', String(r.retry)]);
  if (r.retryDifferentDevice != null) f.push(['retryDifferentDevice', String(r.retryDifferentDevice)]);
  if (r.overallTimeoutMs != null) f.push(['overallTimeout', String(r.overallTimeoutMs)]);
  if (r.creationTimeoutMs != null) f.push(['creationTimeout', String(r.creationTimeoutMs)]);
  if (r.reservationDurationMin != null) f.push(['reservationDuration', String(r.reservationDurationMin)]);
  if (r.includeTests?.length) f.push(['includeTests', r.includeTests.join(',')]);
  if (r.runTags && Object.keys(r.runTags).length) f.push(['runTags', JSON.stringify(r.runTags)]);
  if (r.additionalAppIds?.length) f.push(['additionalAppIds', r.additionalAppIds.join(',')]);
  if (r.provisioningProfileUuid) f.push(['uuid', r.provisioningProfileUuid]);
  if (r.useTestOrchestrator != null) f.push(['useTestOrchestrator', String(r.useTestOrchestrator)]);
  if (r.clearPackageData != null) f.push(['clearPackageData', String(r.clearPackageData)]);
  if (r.useUIAutomator != null) f.push(['useUIAutomator', String(r.useUIAutomator)]);
  return f;
}

export async function executeTestRun(r: TestRunRequest): Promise<{ testRunId: string; reporterLink: string | null }> {
  const invalid = validateTestRunRequest(r);
  if (invalid) throw new Error(invalid);
  for (const p of [r.appPath, r.testsPath]) {
    if (p && (!existsSync(p) || !statSync(p).isFile())) throw new Error(`File not found: ${p}`);
  }
  if (r.executionType === 'MAESTRO' && r.testsPath) {
    const bad = checkMaestroBundle(r.testsPath);
    if (bad) throw new Error(bad);
  }
  try {
    const form = new FormData();
    for (const [k, v] of testRunScalarFields(r)) form.append(k, v);
    if (r.appPath) form.append('app', createReadStream(r.appPath));
    if (r.testsPath) form.append(testsFieldName(r.executionType).file, createReadStream(r.testsPath));
    const res = await apiPostForm<{ data?: Record<string, string> }>(
      `/api/v1/test-run/execute-test-run-async?${deviceQueriesQueryString(r.deviceQueries)}`,
      form
    );
    const id = res.data?.['Test Run Id'];
    if (!id) throw new Error(`the platform returned no Test Run Id: ${JSON.stringify(res).slice(0, 300)}`);
    return { testRunId: String(id), reporterLink: res.data?.['Link to Reporter'] ?? null };
  } catch (e) {
    throw new Error(`executeTestRun failed: ${(e as Error).message}`);
  }
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return v == null || v === '' || !Number.isFinite(n) || n < 0 ? null : n; // the platform briefly reports "-1" mid-run
};

/** Pure: normalize the platform's human-labelled status payload. */
export function normalizeTestRunStatus(id: string, d: Record<string, unknown>): TestRunStatus {
  const state = String(d['Test Run State'] ?? 'Unknown');
  return {
    testRunId: String(d['Test Run Id'] ?? id),
    state,
    finished: /^(finished|canceled|cancelled|failed|error|timed?\s*out)$/i.test(state),
    counts: {
      inFile: num(d['Number of tests in file']),
      requested: num(d['Number of requested tests']),
      total: num(d['Total number of tests']),
      passed: num(d['Number of passed tests']),
      failed: num(d['Number of failed tests']),
      skipped: num(d['Number of skipped tests']),
      running: num(d['Number of running tests']),
      queued: num(d['Number of queued tests']),
      ignored: num(d['Number of ignored tests']),
    },
    reporterLink: d['Link to Reporter'] != null ? String(d['Link to Reporter']) : null,
  };
}

export async function getTestRunStatus(testRunId: string): Promise<TestRunStatus> {
  try {
    const res = await apiGet<{ data?: Record<string, unknown> }>(`/api/v1/test-run/${encodeURIComponent(testRunId)}/status`);
    return normalizeTestRunStatus(testRunId, res.data ?? {});
  } catch (e) {
    throw new Error(`getTestRunStatus failed: ${(e as Error).message}`);
  }
}

/** POST /api/v1/test-run/{id}/cancel — cancels every test of the run (verified live). */
export async function cancelTestRun(testRunId: string): Promise<unknown> {
  try {
    return await apiPost<unknown>(`/api/v1/test-run/${encodeURIComponent(testRunId)}/cancel`);
  } catch (e) {
    throw new Error(`cancelTestRun failed: ${(e as Error).message}`);
  }
}
