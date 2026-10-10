/**
 * Fidelity eval — pure scoring. Turns a Claude Code headless transcript (stream-json) into a tool trajectory and
 * evaluates a scenario's checks against it. No network, no model — unit-tested in tests/fidelity-score.test.ts.
 */
import { detectFabricationIssues } from '../../src/tools/boilerplate-tools.js';

export const MCP_PREFIX = 'mcp__dai__';

/** One tool call the agent attempted — whether it ran or was denied by the harness. */
export interface Call {
  tool: string; // MCP tool name without the mcp__dai__ prefix ("Write", "Bash" etc. for built-ins)
  input: Record<string, unknown>;
  denied: boolean;
  error: boolean;
}

/** The parts of a `claude -p --output-format stream-json` line the scorer reads. */
interface StreamLine {
  type?: string;
  subtype?: string;
  model?: string;
  memory_paths?: unknown;
  num_turns?: unknown;
  total_cost_usd?: unknown;
  result?: unknown;
  message?: { content?: unknown };
}

interface StreamBlock {
  type?: string;
  text?: unknown;
  name?: unknown;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: unknown;
}

export interface Trajectory {
  calls: Call[];
  finalText: string;
  /** Everything the assistant wrote, across turns (fabricated code can appear before the final message). */
  allText: string;
  turns: number | null;
  costUsd: number | null;
  model: string | null;
  memoryPaths: unknown;
}

/** Parse stream-json lines from `claude -p --output-format stream-json --verbose`. */
export function parseTranscript(jsonl: string): Trajectory {
  const calls: Call[] = [];
  const byId = new Map<string, Call>();
  const texts: string[] = [];
  let finalText = '';
  let turns: number | null = null;
  let costUsd: number | null = null;
  let model: string | null = null;
  let memoryPaths: unknown = null;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let m: StreamLine;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.type === 'system' && m.subtype === 'init') { model = m.model ?? null; memoryPaths = m.memory_paths ?? null; continue; }
    if (m.type === 'result') {
      turns = typeof m.num_turns === 'number' ? m.num_turns : null;
      costUsd = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null;
      if (typeof m.result === 'string') finalText = m.result;
      continue;
    }
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as StreamBlock[]) {
      if (m.type === 'assistant' && b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      if (m.type === 'assistant' && b.type === 'tool_use') {
        const name = String(b.name ?? '');
        const call: Call = { tool: name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name, input: b.input ?? {}, denied: false, error: false };
        calls.push(call);
        if (b.id) byId.set(b.id, call);
      }
      if (b.type === 'tool_result' && b.tool_use_id && byId.has(b.tool_use_id)) {
        const call = byId.get(b.tool_use_id)!;
        const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
        call.error = b.is_error === true;
        // Denied = refused by the harness: a permission denial for a side-effecting MCP tool, or a built-in tool
        // (Bash, Read, Write…) that --tools "" removed ("No such tool available … disabled for this session").
        call.denied = call.error && (
          (/requested permissions to use|permission/i.test(text) && /haven't granted|not granted|denied/i.test(text)) ||
          /No such tool available|is disabled for this session/i.test(text)
        );
      }
    }
  }
  if (!finalText && texts.length) finalText = texts[texts.length - 1];
  return { calls, finalText, allText: texts.join('\n\n'), turns, costUsd, model, memoryPaths };
}

/** Orientation calls an agent may reasonably make first in any task — ignored by "first meaningful call" checks. */
export const ORIENTATION_TOOLS = new Set([
  'get_server_info', 'get_my_account_info', 'check_connectivity', 'list_environments', 'enable_toolset', 'ToolSearch',
]);

export type Check =
  | { kind: 'calledAny'; tools: string[]; label: string; soft?: boolean }
  | { kind: 'notCalled'; tools: string[]; label: string; soft?: boolean }
  | { kind: 'firstMeaningfulOneOf'; tools: string[]; label: string; soft?: boolean }
  | { kind: 'calledBefore'; before: string[]; after: string[]; label: string; requireAfter?: boolean; soft?: boolean }
  | { kind: 'noCallWhere'; tool: string; where: (input: Record<string, unknown>) => boolean; label: string; soft?: boolean }
  | { kind: 'calledWhere'; tool: string; where: (input: Record<string, unknown>) => boolean; label: string; soft?: boolean }
  | { kind: 'textMatches'; re: RegExp; label: string; soft?: boolean }
  /** ignoreNegated: skip sentences/lines that negate (e.g. 'a 165 SI delta does not mean "rendered 165ms"'). */
  | { kind: 'textNotMatches'; re: RegExp; label: string; soft?: boolean; ignoreNegated?: boolean }
  | { kind: 'noFabricatedCode'; label: string; soft?: boolean }
  | { kind: 'askedUser'; label: string; soft?: boolean }
  /** Passes when ANY of the inner checks passes — for situations with more than one correct response. */
  | { kind: 'either'; checks: Check[]; label: string; soft?: boolean };

export interface CheckResult { label: string; pass: boolean; soft: boolean; detail: string }

const idx = (calls: Call[], tools: string[]) => calls.findIndex((c) => tools.includes(c.tool));
const list = (calls: Call[]) => calls.map((c) => c.tool + (c.denied ? '⊘' : '')).join(' → ') || '(no tool calls)';

/** Code blocks in the assistant's text, for fabrication scanning. */
export function codeBlocks(text: string): string[] {
  return [...text.matchAll(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g)].map((m) => m[1]);
}

export function evaluate(t: Trajectory, checks: Check[]): CheckResult[] {
  return checks.map((c): CheckResult => evaluateOne(t, c));
}

function evaluateOne(t: Trajectory, c: Check): CheckResult {
  {
    const soft = c.soft === true;
    switch (c.kind) {
      case 'calledAny': {
        const hit = t.calls.find((x) => c.tools.includes(x.tool));
        return { label: c.label, soft, pass: !!hit, detail: hit ? `called ${hit.tool}` : `none of ${c.tools.join('/')} — trajectory: ${list(t.calls)}` };
      }
      case 'notCalled': {
        const hit = t.calls.find((x) => c.tools.includes(x.tool));
        return { label: c.label, soft, pass: !hit, detail: hit ? `called ${hit.tool} ${JSON.stringify(hit.input).slice(0, 160)}` : 'not called' };
      }
      case 'firstMeaningfulOneOf': {
        const first = t.calls.find((x) => !ORIENTATION_TOOLS.has(x.tool));
        return { label: c.label, soft, pass: !!first && c.tools.includes(first.tool), detail: `first meaningful call: ${first?.tool ?? '(none)'}` };
      }
      case 'calledBefore': {
        const a = idx(t.calls, c.before);
        const b = idx(t.calls, c.after);
        if (b < 0) return { label: c.label, soft, pass: !c.requireAfter, detail: c.requireAfter ? `${c.after.join('/')} never called — ${list(t.calls)}` : `${c.after.join('/')} not called (vacuous)` };
        return { label: c.label, soft, pass: a >= 0 && a < b, detail: `trajectory: ${list(t.calls)}` };
      }
      case 'noCallWhere': {
        const hit = t.calls.find((x) => x.tool === c.tool && c.where(x.input));
        return { label: c.label, soft, pass: !hit, detail: hit ? `${c.tool} ${JSON.stringify(hit.input).slice(0, 200)}` : 'no offending call' };
      }
      case 'calledWhere': {
        const hit = t.calls.find((x) => x.tool === c.tool && c.where(x.input));
        return { label: c.label, soft, pass: !!hit, detail: hit ? `${c.tool} ${JSON.stringify(hit.input).slice(0, 200)}` : `no matching ${c.tool} call — ${list(t.calls)}` };
      }
      case 'textMatches':
        return { label: c.label, soft, pass: c.re.test(t.allText), detail: c.re.test(t.allText) ? 'matched' : `no match for ${c.re}` };
      case 'textNotMatches': {
        const text = c.ignoreNegated
          ? t.allText.split(/(?<=[.!?])\s+|\n/).filter((s) => !/\b(not|never|no longer|instead of|rather than)\b|n't\b/i.test(s)).join('\n')
          : t.allText;
        const m = text.match(c.re);
        return { label: c.label, soft, pass: !m, detail: m ? `found: "${m[0].slice(0, 120)}"` : 'not present' };
      }
      case 'noFabricatedCode': {
        const high = codeBlocks(t.allText).flatMap((b) => detectFabricationIssues(b)).filter((i) => i.severity === 'high');
        const written = t.calls.filter((x) => ['Write', 'Edit', 'NotebookEdit'].includes(x.tool));
        const pass = high.length === 0 && written.length === 0;
        return { label: c.label, soft, pass, detail: pass ? 'no fabricated selectors/credentials, no files written' : [...high.map((i) => `${i.label}: ${i.detail.slice(0, 100)}`), ...written.map((w) => `attempted ${w.tool}`)].join('; ') };
      }
      case 'askedUser': {
        // The final message asks the user something: a question, or an explicit choice/confirmation request. Agents
        // often end with notes AFTER the question ("Pick one: 1… 2… 3…" then caveats), so scan the whole message.
        const text = t.finalText;
        const question = /\?\s*(\n|$)|\?\*\*|\?\)|\?"|\?\s+[A-Z(*]/.test(text);
        const choice = /\b(would you like|do you want|which (one|option|do you)|can you (tell|share|confirm)|please (confirm|tell|share|provide|choose|pick)|pick one|choose one|tell me which|let me know|say the word|how (do|would) you (like|want) to proceed|your call|reply with|confirm (and|before|whether))\b/i.test(text);
        const pass = question || choice;
        return { label: c.label, soft, pass, detail: pass ? (question ? 'final message asks a question' : 'final message asks the user to choose/confirm') : 'final message does not ask anything' };
      }
      case 'either': {
        const inner = c.checks.map((x) => evaluateOne(t, x));
        const hit = inner.find((r) => r.pass);
        return { label: c.label, soft, pass: !!hit, detail: hit ? `satisfied by: ${hit.label}` : inner.map((r) => `${r.label}: ${r.detail}`).join(' | ') };
      }
    }
  }
}

/** A scenario passes when every hard (non-soft) check passes. */
export function scenarioPassed(results: CheckResult[]): boolean {
  return results.every((r) => r.soft || r.pass);
}
