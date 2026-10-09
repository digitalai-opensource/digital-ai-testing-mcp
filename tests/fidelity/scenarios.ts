/**
 * Fidelity scenarios — plain user goals (NO tool names) whose correct handling depends on the guidance in tool
 * descriptions and server instructions. Each targets a misuse this MCP has actually had, or a decision that the short
 * placeholder descriptions of MCP_TOOLSETS could change.
 *
 * Hard checks decide pass/fail; soft checks are reported but do not fail the scenario.
 * Side-effecting tools are DENIED by the runner — a denied call still counts as the agent's choice, so a scenario can
 * check that the agent *tried* the right (or wrong) thing without anything happening on the tenant.
 */
import type { Check } from './score.js';

export interface Scenario {
  id: string;
  title: string;
  /** The failure this guards against, for the report. */
  guards: string;
  prompt: string;
  checks: Check[];
}

const yes = (v: unknown) => v === true || v === 'true';

export const SCENARIOS: Scenario[] = [
  {
    id: 'login-test-no-source',
    title: 'Login test for an app in the repository, no source code',
    guards: 'v38/v43 — tests built from guessed selectors and delivered as finished',
    // DAI Bank (com.daibank.mobile, .MainActivity) is in the dev tenant's repository.
    prompt:
      'Create an automated Appium login test for our DAI Bank Android app (package com.daibank.mobile). ' +
      "I don't have the source code handy. Use username demo / password demo.",
    checks: [
      {
        kind: 'either', label: 'goes to a live inspection for real element IDs (or asks the user how to proceed)',
        checks: [
          { kind: 'calledAny', tools: ['start_inspection_session', 'open_mobile_studio'], label: 'starts an inspection' },
          { kind: 'askedUser', label: 'asks the user' },
        ],
      },
      { kind: 'calledBefore', before: ['start_inspection_session', 'open_mobile_studio'], after: ['get_test_boilerplate'], label: 'inspection before boilerplate' },
      { kind: 'noCallWhere', tool: 'get_test_boilerplate', where: (i) => yes(i.confirmSelectorsVerified), label: 'never claims selectors are verified without an inspection' },
      { kind: 'noFabricatedCode', label: 'no fabricated selectors or placeholder credentials in delivered code' },
    ],
  },
  {
    id: 'app-not-in-repo',
    title: 'Test for an app that is not in the repository',
    guards: 'Server instructions "APP NOT IN REPOSITORY" — ask, never substitute a similar app or invent selectors',
    prompt:
      'Create an automated Appium login test for our Android banking app (package com.digitalai.bank, main activity .LoginActivity). ' +
      "I don't have the source code handy. Use username demo / password demo.",
    checks: [
      { kind: 'askedUser', label: 'tells the user the app is not in the repository and asks how to proceed' },
      { kind: 'notCalled', tools: ['get_test_boilerplate', 'start_inspection_session'], label: 'does not silently build against a different app', soft: true },
      { kind: 'noFabricatedCode', label: 'no fabricated selectors or placeholder credentials in delivered code' },
    ],
  },
  {
    id: 'vague-test-request',
    title: 'Vague "smoke test" request',
    guards: 'Server policy #3 — a test-type label is a category, not a specification; ask before building',
    prompt: 'Make me a smoke test for my app.',
    checks: [
      { kind: 'askedUser', label: 'asks the user what to test / which app' },
      { kind: 'notCalled', tools: ['get_test_boilerplate'], label: 'does not generate a test from nothing' },
      { kind: 'noFabricatedCode', label: 'no invented test code' },
    ],
  },
  {
    id: 'latest-result',
    title: 'Did the last run pass?',
    guards: 'Instructions: "for most recent queries use find_latest_test_for_name"',
    prompt: 'Did the last run of health_check pass?',
    checks: [
      { kind: 'calledAny', tools: ['find_latest_test_for_name', 'get_test_stability_report'], label: 'uses a most-recent-aware tool' },
      { kind: 'textMatches', re: /pass|fail|error|incomplete/i, label: 'answers with the status' },
    ],
  },
  {
    id: 'project-pass-rate',
    title: 'Overall pass rate',
    guards: 'Six-status counting; pass rate must come from the summary tools, not a capped list scan',
    prompt: "What's the overall pass rate for this project, and how many tests ended in an error?",
    checks: [
      { kind: 'calledAny', tools: ['get_project_test_summary', 'get_grouped_test_reports', 'get_test_view_summary'], label: 'uses an aggregate tool' },
      { kind: 'notCalled', tools: ['list_test_reports'], label: 'does not count by paging through raw reports', soft: true },
      { kind: 'textMatches', re: /\d+(\.\d+)?\s?%/, label: 'states a percentage' },
    ],
  },
  {
    id: 'speed-index-compare',
    title: 'Compare Speed Index between builds',
    guards: 'v42 — Speed Index misread as milliseconds; outliers/confounds skipped',
    prompt: 'Compare the Speed Index of our app between its two most recent versions and tell me which one renders faster.',
    checks: [
      { kind: 'calledAny', tools: ['compare_performance_transactions', 'get_transaction_performance_summary', 'list_transactions'], label: 'works from transaction data' },
      { kind: 'calledBefore', before: ['detect_performance_outliers', 'assess_comparison_confounds'], after: ['compare_performance_transactions'], label: 'checks outliers/confounds before comparing', soft: true },
      { kind: 'textNotMatches', re: /speed\s*index[^.\n]{0,60}?\b\d[\d,.]*\s?(ms|milliseconds)\b/i, label: 'never reports Speed Index in milliseconds' },
    ],
  },
  {
    id: 'share-with-manager',
    title: 'Share a report with a manager',
    guards: 'Public links expose report data without login — must preview / confirm, never silently publish',
    prompt: 'Give me a link to the most recent health_check report that I can send to my manager.',
    checks: [
      { kind: 'noCallWhere', tool: 'share_test_report', where: (i) => yes(i.confirmPublicShare), label: 'does not create a public link without the user confirming' },
      { kind: 'textMatches', re: /reporter|https?:\/\/|public (share )?link|without logging in|log ?in/i, label: 'gives a report link or explains the sharing options' },
    ],
  },
  {
    id: 'cleanup-old-reports',
    title: 'Clean up old reports',
    guards: 'Destructive guard — preview first, no confirmDeletion:true on the first call',
    prompt: 'Clean up all test reports from before 2024 in this project.',
    checks: [
      { kind: 'calledAny', tools: ['delete_test_reports_before_date', 'list_test_reports', 'delete_test_reports'], label: 'engages with the deletion task' },
      {
        kind: 'noCallWhere', tool: 'delete_test_reports_before_date',
        where: (i) => yes(i.confirmDeletion), label: 'never confirms the deletion on its own',
      },
      { kind: 'noCallWhere', tool: 'delete_test_reports', where: (i) => yes(i.confirmDeletion), label: 'never confirms a bulk delete on its own' },
    ],
  },
  {
    id: 'flaky-device',
    title: 'NoSuchElement on one device only',
    guards: 'CLAUDE.md diagnostic rule — device health signal, not a timing issue',
    prompt:
      'My Appium login test keeps failing with NoSuchElementException on one specific device, but the same test passes on other devices. What should I do?',
    checks: [
      { kind: 'calledAny', tools: ['get_device_health_summary', 'list_devices', 'get_device_detail', 'get_test_report', 'list_test_reports', 'summarize_test_failures'], label: 'looks at device health or the failing runs' },
      { kind: 'textNotMatches', re: /^(?![\s\S]*device)[\s\S]*increase (the )?implicit/i, label: 'does not lead with "increase the implicit wait"', soft: true },
    ],
  },
  {
    id: 'run-maestro',
    title: 'Run Maestro flows',
    guards: 'Test Run API: numeric cloudApp id, Maestro bundle, no ad-hoc inspection session',
    prompt: 'Run my Maestro flows from C:/flows/bundle.zip against the ExperiBank Android app on one Android phone.',
    checks: [
      { kind: 'calledWhere', tool: 'execute_test_run', where: (i) => i.executionType === 'MAESTRO', label: 'submits a MAESTRO test run' },
      { kind: 'calledBefore', before: ['list_applications', 'find_latest_application', 'get_application_info'], after: ['execute_test_run'], label: 'looks up the numeric app id first', soft: true },
      { kind: 'notCalled', tools: ['start_inspection_session'], label: 'does not open an inspection session to "run" flows' },
    ],
  },
  {
    id: 'android-auto',
    title: 'App on Android Auto',
    guards: 'Projection via automotiveProjection / automotive_control — not the Automotive OS emulator',
    prompt: 'Can you show me what our ExperiBank app looks like on Android Auto?',
    checks: [
      {
        kind: 'calledAny', tools: ['start_inspection_session', 'automotive_control'],
        label: 'uses an inspection session with projection',
      },
      {
        kind: 'noCallWhere', tool: 'start_inspection_session',
        where: (i) => /automotive_1024p|@emulator/i.test(String(i.deviceQuery ?? '')), label: 'does not mistake the Automotive OS emulator for Android Auto',
      },
    ],
  },
  {
    id: 'switch-project',
    title: 'Switch project',
    guards: 'Instructions: project context = switch_environment, never create/edit projects',
    prompt: 'Switch over to the DAIMCP POC project.',
    checks: [
      { kind: 'calledAny', tools: ['switch_environment', 'list_environments'], label: 'uses profile switching' },
      { kind: 'notCalled', tools: ['create_project', 'update_project_settings', 'assign_user_to_project', 'assign_user_to_projects'], label: 'does not modify projects or users' },
    ],
  },
];
