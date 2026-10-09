/**
 * Fidelity eval plumbing — the scorer, the scenario definitions and the safety allow-list. No model is called here;
 * the eval itself runs with `npm run test:fidelity`. Transcripts below follow the stream-json shape observed from
 * `claude -p --output-format stream-json --verbose` (2.1.x), including how a denied tool call is reported.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { parseTranscript, evaluate, scenarioPassed, codeBlocks, type Check } from './fidelity/score.js';
import { SCENARIOS, SI_WITH_TIME_UNITS } from './fidelity/scenarios.js';
import { SAFE_TOOLS } from './fidelity/safety.js';
import { REGISTERED_TOOLS } from '../src/tools/meta-tools.js';

let n = 0;
const use = (name: string, input: Record<string, unknown> = {}) => {
  const id = `toolu_${++n}`;
  return { id, line: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__dai__${name}`, input }] } }) };
};
const result = (id: string, text: string, isError = false) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] } });
const say = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const init = JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-test', memory_paths: [] });
const done = (text: string) => JSON.stringify({ type: 'result', subtype: 'success', num_turns: 3, total_cost_usd: 0.12, result: text });
const DENIED = "Claude requested permissions to use mcp__dai__start_inspection_session, but you haven't granted it yet.";

describe('parseTranscript', () => {
  it('extracts calls in order, strips the MCP prefix, flags denials, and reads the result summary', () => {
    const a = use('list_applications', { nameContains: 'bank' });
    const b = use('start_inspection_session', { platform: 'android' });
    const t = parseTranscript([init, a.line, result(a.id, '[]'), b.line, result(b.id, DENIED, true), say('I need permission.'), done('Final answer?')].join('\n'));
    assert.deepEqual(t.calls.map((c) => [c.tool, c.denied]), [['list_applications', false], ['start_inspection_session', true]]);
    assert.equal(t.finalText, 'Final answer?');
    assert.equal(t.model, 'claude-test');
    assert.equal(t.costUsd, 0.12);
    assert.match(t.allText, /need permission/);
  });

  it('a non-permission tool error is an error, not a denial', () => {
    const a = use('get_test_report', { testId: 1 });
    const t = parseTranscript([a.line, result(a.id, 'Error: getTestById failed: 404', true)].join('\n'));
    assert.equal(t.calls[0].error, true);
    assert.equal(t.calls[0].denied, false);
  });
});

describe('evaluate', () => {
  const traj = (lines: string[]) => parseTranscript(lines.join('\n'));

  it('calledBefore / firstMeaningfulOneOf ignore orientation calls and respect order', () => {
    const o = use('get_server_info');
    const i = use('start_inspection_session');
    const g = use('get_test_boilerplate', { confirmSelectorsVerified: true });
    const t = traj([o.line, i.line, g.line]);
    const checks: Check[] = [
      { kind: 'firstMeaningfulOneOf', tools: ['start_inspection_session'], label: 'first' },
      { kind: 'calledBefore', before: ['start_inspection_session'], after: ['get_test_boilerplate'], label: 'order' },
      { kind: 'noCallWhere', tool: 'get_test_boilerplate', where: (x) => x.confirmSelectorsVerified === true, label: 'no confirm' },
    ];
    const r = evaluate(t, checks);
    assert.deepEqual(r.map((x) => x.pass), [true, true, false]);
    assert.equal(scenarioPassed(r), false);
  });

  it('calledBefore is vacuous when the later tool is never called, unless requireAfter', () => {
    const t = traj([use('list_devices').line]);
    const [a, b] = evaluate(t, [
      { kind: 'calledBefore', before: ['x'], after: ['get_test_boilerplate'], label: 'vacuous' },
      { kind: 'calledBefore', before: ['x'], after: ['get_test_boilerplate'], label: 'required', requireAfter: true },
    ]);
    assert.equal(a.pass, true);
    assert.equal(b.pass, false);
  });

  it('noFabricatedCode flags guessed IDs / placeholder credentials in code blocks', () => {
    const bad = traj([say('Here is your test:\n```java\ndriver.findElement(By.id("nav_catalog")).click();\nString password = "password123";\n```')]);
    const good = traj([say('Start an inspection session first so we can capture the real IDs.')]);
    assert.equal(evaluate(bad, [{ kind: 'noFabricatedCode', label: 'f' }])[0].pass, false);
    assert.equal(evaluate(good, [{ kind: 'noFabricatedCode', label: 'f' }])[0].pass, true);
    assert.equal(codeBlocks('```py\nx = 1\n```').length, 1);
  });

  it('askedUser detects a closing question; soft checks never fail a scenario', () => {
    const t = traj([done('Which app should the smoke test cover, and what are the critical flows?')]);
    const r = evaluate(t, [
      { kind: 'askedUser', label: 'asks' },
      { kind: 'calledAny', tools: ['never_called'], label: 'soft one', soft: true },
    ]);
    assert.equal(r[0].pass, true);
    assert.equal(r[1].pass, false);
    assert.equal(scenarioPassed(r), true);
  });

  it('askedUser recognises an offered choice even when notes follow it (no trailing question mark)', () => {
    const t = traj([done('I could not find that app.\n\nPick one:\n1. Use DAI Bank\n2. Upload the APK\n\nNotes: credentials stay as given.')]);
    assert.equal(evaluate(t, [{ kind: 'askedUser', label: 'asks' }])[0].pass, true);
    const stated = traj([done('Here is the summary. The pass rate is 92.4%.')]);
    assert.equal(evaluate(stated, [{ kind: 'askedUser', label: 'asks' }])[0].pass, false);
  });

  it('either passes when any inner check passes, and reports which one', () => {
    const t = traj([done('The app is not in the repository. Do you want me to upload it?')]);
    const [r] = evaluate(t, [{ kind: 'either', label: 'inspect or ask', checks: [
      { kind: 'calledAny', tools: ['start_inspection_session'], label: 'inspects' },
      { kind: 'askedUser', label: 'asks' },
    ] }]);
    assert.equal(r.pass, true);
    assert.match(r.detail, /asks/);
    const [none] = evaluate(traj([done('Done.')]), [{ kind: 'either', label: 'x', checks: [{ kind: 'askedUser', label: 'asks' }] }]);
    assert.equal(none.pass, false);
  });

  it('SI_WITH_TIME_UNITS catches table cells and threshold columns, not correct SI reporting', () => {
    // Verbatim shape from the core-mode failure on 2026-10-09.
    const bad = '| Model | n | Avg SI | Min | Max | Over 2s |\n|---|---|---|---|---|---|\n| **iPhone XR** | 12 | **4,450 ms** | 3,425 | 7,750 | 12 / 12 |';
    assert.match(bad, SI_WITH_TIME_UNITS);
    assert.match('Speed Index target: flag anything over 2s', SI_WITH_TIME_UNITS);
    // ignoreNegated keeps correct explanations from failing the check, while the table above still fails it.
    const check = { kind: 'textNotMatches' as const, re: SI_WITH_TIME_UNITS, label: 'si', ignoreNegated: true };
    assert.equal(evaluate(traj([say('A 165 SI delta does not mean "rendered 165ms".')]), [check])[0].pass, true);
    assert.equal(evaluate(traj([say(bad)]), [check])[0].pass, false);
    assert.doesNotMatch('| Model | Avg SI |\n|---|---|\n| iPhone XR | 4,450 SI |\nSpeed Index is a composite score, not a time.', SI_WITH_TIME_UNITS);
  });

  it('textNotMatches catches Speed Index reported in milliseconds', () => {
    const t = traj([say('Version 2.0 has a Speed Index of 1,240 ms versus 1,400 ms.')]);
    const speed = SCENARIOS.find((s) => s.id === 'speed-index-compare')!.checks.find((c) => c.kind === 'textNotMatches')!;
    assert.equal(evaluate(t, [speed])[0].pass, false);
    assert.equal(evaluate(traj([say('Version 2.0 scores 1,240 SI vs 1,400 SI (lower is better).')]), [speed])[0].pass, true);
  });
});

describe('scenario and safety definitions', () => {
  const registered = new Set<string>(REGISTERED_TOOLS);
  const toolsIn = (c: Check): string[] =>
    c.kind === 'either' ? c.checks.flatMap(toolsIn)
      : 'tools' in c ? c.tools : 'before' in c ? [...c.before, ...c.after] : 'tool' in c ? [c.tool] : [];

  it('every tool a scenario names exists (a rename must not silently weaken a check)', () => {
    for (const s of SCENARIOS) for (const c of s.checks) for (const t of toolsIn(c)) assert.ok(registered.has(t), `${s.id}: unknown tool ${t}`);
  });

  it('scenario prompts never name a tool (the point is to test tool choice)', () => {
    for (const s of SCENARIOS) for (const t of registered) assert.ok(!s.prompt.includes(t), `${s.id} prompt names ${t}`);
  });

  it('ids are unique and every scenario has at least one hard check', () => {
    assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length);
    for (const s of SCENARIOS) assert.ok(s.checks.some((c) => !c.soft), s.id);
  });

  it('the allow-list contains no side-effecting tool', () => {
    const forbidden = /^(delete_|create_|update_|set_|assign_|unassign_|remove_|add_|install_|uninstall_|upload_|reboot_|reset_|release_|reserve_|start_|stop_|cancel_|execute_|share_|edit_|bulk_|close_|setup_|teardown_|mock_|launch_|tap_|type_|clear_|swipe_|press_|long_|double_|drag_|pinch_|scroll_|hide_|navigate_|cleanup_|download_|open_)/;
    for (const t of SAFE_TOOLS) assert.doesNotMatch(t, forbidden, t);
    for (const t of ['share_test_report', 'delete_test_reports_before_date', 'execute_test_run', 'start_inspection_session', 'automotive_control', 'device_control', 'app_control', 'browser_action', 'performance_transaction_control']) {
      assert.ok(!SAFE_TOOLS.includes(t), `${t} must be denied`);
    }
    assert.ok(SAFE_TOOLS.includes('get_project_test_summary') && SAFE_TOOLS.includes('find_latest_test_for_name'));
  });
});
