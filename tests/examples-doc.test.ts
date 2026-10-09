/**
 * docs/examples.md is what users copy, and agents learn from it too. These checks stop it from teaching a misuse the
 * MCP was fixed to prevent — two such examples were found on 2026-10-09 ("Speed Index target is 2 seconds", and
 * "full report for test ID … including step detail").
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REGISTERED_TOOLS } from '../src/tools/meta-tools.js';
import { captureRegistrations } from '../src/utils/toolsets.js';
import { registerPrompts } from '../src/tools/prompt-tools.js';

const lines = readFileSync(join(__dirname, '..', 'docs', 'examples.md'), 'utf8').split(/\r?\n/);

describe('docs/examples.md', () => {
  it('never frames Speed Index as a duration (it is a composite score — the v42 misreading)', () => {
    const bad = lines.filter((l) => /speed\s*index/i.test(l) && /\b\d+(\.\d+)?\s*(ms|milliseconds|s|sec|seconds?)\b/i.test(l) && !/not a duration|composite/i.test(l));
    assert.deepEqual(bad, []);
  });

  it('never promises step detail from a numeric test ID (only report_api_id lookups return steps)', () => {
    const bad = lines.filter((l) => /test id/i.test(l) && /step[- ]?(level )?detail/i.test(l) && !/report_api_id|get_test_by_report_id/i.test(l));
    assert.deepEqual(bad, []);
  });

  it('every tool (or prompt) named in backticks or *(…)* hints exists', () => {
    const prompts = captureRegistrations([['prompts', registerPrompts]]).prompts.map((p) => String(p.args[0]));
    const registered = new Set<string>([...REGISTERED_TOOLS, ...prompts]);
    const named = new Set<string>();
    for (const l of lines) for (const m of l.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`|\b(get|list|start|stop|summarize|share|execute|automotive|enable|download|install)_[a-z0-9_]+\b/g)) {
      const name = (m[1] ?? m[0]).replace(/[`]/g, '');
      if (/^(get|list|start|stop|summarize|share|execute|automotive|enable|download|install)_/.test(name) || m[1]) named.add(name);
    }
    // Names that are capabilities/fields rather than tools.
    const notTools = new Set(['report_api_id', 'test_id', 'start_time', 'allow_users_delete_tests']);
    const unknown = [...named].filter((n) => !registered.has(n) && !notTools.has(n));
    assert.deepEqual(unknown, [], `examples.md names tools that do not exist: ${unknown.join(', ')}`);
  });
});
