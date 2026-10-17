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
  /**
   * MCP_TOOLSETS placeholder: the call loaded a toolset and returned guidance — the tool itself did NOT run. Order and
   * presence checks skip these: a placeholder get_remote_debug_command is not "generating the rdb script".
   */
  placeholder: boolean;
  /** The tool result's text (text blocks joined) — what the tool returned to the agent. */
  resultText?: string;
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
        const call: Call = { tool: name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name, input: b.input ?? {}, denied: false, error: false, placeholder: false };
        calls.push(call);
        if (b.id) byId.set(b.id, call);
      }
      if (b.type === 'tool_result' && b.tool_use_id && byId.has(b.tool_use_id)) {
        const call = byId.get(b.tool_use_id)!;
        const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
        call.resultText = typeof b.content === 'string'
          ? b.content
          : Array.isArray(b.content)
            ? (b.content as Array<{ type?: string; text?: unknown }>).filter((x) => x.type === 'text' && typeof x.text === 'string').map((x) => x.text as string).join('\n')
            : text;
        call.error = b.is_error === true;
        // Denied = refused by the harness: a permission denial for a side-effecting MCP tool, or a built-in tool
        // (Bash, Read, Write…) that --tools "" removed ("No such tool available … disabled for this session").
        call.denied = call.error && (
          (/requested permissions to use|permission/i.test(text) && /haven't granted|not granted|denied/i.test(text)) ||
          /No such tool available|is disabled for this session/i.test(text)
        );
        // The server's placeholder reply (src/utils/toolsets.ts) — nothing ran.
        call.placeholder = !call.error && /toolset .* was not loaded in this server; it is loaded now\./.test(text) && /Nothing was executed\./.test(text);
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
  /**
   * No fabricated code in the agent's text, and no file writes. allowGeneratedWrites (opt-in, per scenario): a Write
   * still passes if its content is the output of an EARLIER get_test_boilerplate call in the same session — every line
   * is found in that output — and the content itself passes the fabrication scan. Any other write fails.
   */
  | { kind: 'noFabricatedCode'; label: string; soft?: boolean; allowGeneratedWrites?: boolean }
  | { kind: 'askedUser'; label: string; soft?: boolean }
  /** Passes when ANY of the inner checks passes — for situations with more than one correct response. */
  | { kind: 'either'; checks: Check[]; label: string; soft?: boolean }
  /** Every inner check must pass — combine with either for "did X, or did Y and Z". */
  | { kind: 'allOf'; checks: Check[]; label: string; soft?: boolean };

export interface CheckResult { label: string; pass: boolean; soft: boolean; detail: string }

const idx = (calls: Call[], tools: string[]) => calls.findIndex((c) => tools.includes(c.tool));
const list = (calls: Call[]) => calls.map((c) => c.tool + (c.denied ? '⊘' : c.placeholder ? '⟳' : '')).join(' → ') || '(no tool calls)';
/** Calls that actually reached a tool handler — placeholder (toolset-loading) calls excluded. */
const real = (t: Trajectory) => t.calls.filter((c) => !c.placeholder);

/** Code blocks in the assistant's text, for fabrication scanning. */
export function codeBlocks(text: string): string[] {
  return codeBlocksWithLang(text).map((b) => b.code);
}

export function codeBlocksWithLang(text: string): Array<{ lang: string; code: string }> {
  return [...text.matchAll(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1].toLowerCase(), code: m[2] }));
}

/** Fences that hold commands for the user to run, not test code — a `<your key>` placeholder there is correct redaction. */
const COMMAND_FENCES = new Set(['bash', 'sh', 'shell', 'zsh', 'powershell', 'ps1', 'pwsh', 'cmd', 'bat', 'console', 'text', 'txt', 'plaintext']);
/** Placeholders that stand for a credential the agent rightly refused to paste. */
const CREDENTIAL_PLACEHOLDER = /<[^>]*\b(key|token|secret|credential|password)\b[^>]*>/i;

/** Test-code blocks only (test fences or unlabeled), with credential placeholders blanked before scanning. */
export function testCodeBlocks(text: string): string[] {
  return codeBlocksWithLang(text)
    .filter((b) => !COMMAND_FENCES.has(b.lang))
    .map((b) => b.code.replace(new RegExp(CREDENTIAL_PLACEHOLDER.source, 'gi'), '"[credential]"'));
}

/**
 * Why a write is NOT acceptable as generated output, or null when it is: it must be a Write (not an Edit), come after a
 * get_test_boilerplate call that returned content, contain only lines that appear in that output (whitespace-trimmed),
 * and pass the fabrication scan on its own content. A single added or changed line — a guessed selector, a credential —
 * makes the write fail.
 */
export function generatedWriteProblem(t: Trajectory, w: Call): string | null {
  if (w.tool !== 'Write') return `${w.tool} edits a file in place — only whole-file Writes of generated output are allowed`;
  const content = typeof w.input.content === 'string' ? w.input.content : '';
  if (!content.trim()) return 'empty write';
  const idx = t.calls.indexOf(w);
  const generated = t.calls.slice(0, idx).filter((x) => x.tool === 'get_test_boilerplate' && !x.error && !x.denied && x.resultText).map((x) => x.resultText!);
  if (generated.length === 0) return 'no earlier get_test_boilerplate output to compare with';
  // Whitespace runs are collapsed: re-aligning columns ("Input Text  id=…    John Snow") changes nothing — Robot treats
  // any 2+ spaces as one separator — and agents do it when saving (fidelity runs 2026-10-17).
  const norm = (l: string) => l.trim().replace(/\s+/g, ' ');
  const lines = new Set(generated.join('\n').split(/\r?\n/).map(norm).filter(Boolean));
  // The only tolerated change: a credential line that reads the key from the DIGITAL_AI_ACCESS_KEY environment variable
  // instead of embedding it (what the generated files tell the user to do) — with no literal value of its own.
  const envOnlyCredential = (l: string) => /DIGITAL_AI_ACCESS_KEY/.test(l) && !/=\s*[A-Za-z0-9_\-.]{12,}|["'][A-Za-z0-9_\-.]{12,}["']/.test(l.replace(/DIGITAL_AI_ACCESS_KEY/g, ''));
  const meta = metadataLines(content, String(w.input.file_path ?? ''));
  const foreign = content.split(/\r?\n/)
    .map((raw, i) => ({ l: norm(raw), i }))
    .filter(({ l, i }) => l && !lines.has(l) && !envOnlyCredential(l) && !meta.has(i))
    .map(({ l }) => l);
  if (foreign.length) return `${foreign.length} code line(s) not in the generator's output, e.g. ${JSON.stringify(foreign[0].slice(0, 80))}`;
  const issues = detectFabricationIssues(content).filter((i) => i.severity === 'high');
  if (issues.length) return `${issues[0].label}: ${issues[0].detail.slice(0, 80)}`;
  return null;
}

/**
 * Indexes of lines that are metadata, which an agent may rename or reword when saving generated output (user decision
 * 2026-10-17): comments; Robot "Documentation" / "[Documentation]" / "[Tags]" and the "..." lines continuing them;
 * Robot test-case names; Python docstrings. Steps, selectors, capabilities and credentials are never metadata — a
 * changed or added one still fails, including a step with no selector (e.g. an invented "Page Should Contain Text").
 */
export function metadataLines(content: string, filePath: string): Set<number> {
  const raw = content.split(/\r?\n/);
  const out = new Set<number>();
  const comment = (t: string) => t.startsWith('#') || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
  if (/\.robot$/i.test(filePath)) {
    let section = '';
    let continuingMeta = false; // the statement a "..." line continues is metadata
    raw.forEach((line, i) => {
      const t = line.trim();
      if (!t) return;
      if (t.startsWith('***')) { section = t.toLowerCase(); continuingMeta = false; return; }
      if (t.startsWith('#')) { out.add(i); return; }
      if (t.startsWith('...')) { if (continuingMeta) out.add(i); return; }
      const isDoc = /^(Documentation|\[Documentation\]|\[Tags\]|Metadata)(\s|$)/i.test(t);
      const isTestName = section.includes('test case') && !/^\s/.test(line);
      continuingMeta = isDoc;
      if (isDoc || isTestName) out.add(i);
    });
    return out;
  }
  if (/\.py$/i.test(filePath)) {
    // A docstring must START the line — a triple-quoted string inside code (x = """…""") is code, not documentation.
    let inDoc = false;
    raw.forEach((line, i) => {
      const t = line.trim();
      const quotes = (t.match(/"""|'''/g) ?? []).length;
      if (inDoc) {
        out.add(i);
        if (quotes % 2 === 1) inDoc = false;
      } else if (/^("""|''')/.test(t)) {
        out.add(i);
        if (quotes % 2 === 1) inDoc = true;
      } else if (t.startsWith('#')) {
        out.add(i);
      }
    });
    return out;
  }
  raw.forEach((line, i) => { if (comment(line.trim())) out.add(i); });
  return out;
}

export function evaluate(t: Trajectory, checks: Check[]): CheckResult[] {
  return checks.map((c): CheckResult => evaluateOne(t, c));
}

function evaluateOne(t: Trajectory, c: Check): CheckResult {
  {
    const soft = c.soft === true;
    switch (c.kind) {
      case 'calledAny': {
        const hit = real(t).find((x) => c.tools.includes(x.tool));
        return { label: c.label, soft, pass: !!hit, detail: hit ? `called ${hit.tool}` : `none of ${c.tools.join('/')} — trajectory: ${list(t.calls)}` };
      }
      case 'notCalled': {
        const hit = real(t).find((x) => c.tools.includes(x.tool));
        return { label: c.label, soft, pass: !hit, detail: hit ? `called ${hit.tool} ${JSON.stringify(hit.input).slice(0, 160)}` : 'not called' };
      }
      case 'firstMeaningfulOneOf': {
        const first = real(t).find((x) => !ORIENTATION_TOOLS.has(x.tool));
        return { label: c.label, soft, pass: !!first && c.tools.includes(first.tool), detail: `first meaningful call: ${first?.tool ?? '(none)'}` };
      }
      case 'calledBefore': {
        const a = idx(real(t), c.before);
        const b = idx(real(t), c.after);
        if (b < 0) return { label: c.label, soft, pass: !c.requireAfter, detail: c.requireAfter ? `${c.after.join('/')} never called — ${list(t.calls)}` : `${c.after.join('/')} not called (vacuous)` };
        return { label: c.label, soft, pass: a >= 0 && a < b, detail: `trajectory: ${list(t.calls)}` };
      }
      case 'noCallWhere': {
        const hit = real(t).find((x) => x.tool === c.tool && c.where(x.input));
        return { label: c.label, soft, pass: !hit, detail: hit ? `${c.tool} ${JSON.stringify(hit.input).slice(0, 200)}` : 'no offending call' };
      }
      case 'calledWhere': {
        const hit = real(t).find((x) => x.tool === c.tool && c.where(x.input));
        return { label: c.label, soft, pass: !!hit, detail: hit ? `${c.tool} ${JSON.stringify(hit.input).slice(0, 200)}` : `no matching ${c.tool} call — ${list(t.calls)}` };
      }
      case 'textMatches':
        return { label: c.label, soft, pass: c.re.test(t.allText), detail: c.re.test(t.allText) ? 'matched' : `no match for ${c.re}` };
      case 'textNotMatches': {
        // Sentences that contrast or correct ("…a different metric", "that's the duration metric instead") are the
        // agent doing the right thing, not a violation.
        const text = c.ignoreNegated
          ? t.allText.split(/(?<=[.!?])\s+|\n/).filter((s) => !/\b(not|never|no longer|instead( of)?|rather than|different metric|wall-clock|if you (actually )?meant)\b|n't\b/i.test(s)).join('\n')
          : t.allText;
        const m = text.match(c.re);
        return { label: c.label, soft, pass: !m, detail: m ? `found: "${m[0].slice(0, 120)}"` : 'not present' };
      }
      case 'noFabricatedCode': {
        // Only test code counts: a PowerShell/bash upload command with "<your key>" in place of the real key is the
        // agent refusing to paste a credential, not a fabricated test (three-run pass 2026-10-14).
        const high = testCodeBlocks(t.allText).flatMap((b) => detectFabricationIssues(b)).filter((i) => i.severity === 'high');
        const written = t.calls.filter((x) => ['Write', 'Edit', 'NotebookEdit'].includes(x.tool));
        const verdicts = written.map((w) => ({ w, reason: c.allowGeneratedWrites ? generatedWriteProblem(t, w) : 'file writes are not allowed in this scenario' }));
        const bad = verdicts.filter((v) => v.reason !== null);
        const pass = high.length === 0 && bad.length === 0;
        const okWrites = verdicts.length - bad.length;
        return {
          label: c.label, soft, pass,
          detail: pass
            ? `no fabricated selectors/credentials${okWrites ? `; ${okWrites} write(s) verified as the generator's own output` : ', no files written'}`
            : [...high.map((i) => `${i.label}: ${i.detail.slice(0, 100)}`), ...bad.map((v) => `attempted ${v.w.tool} — ${v.reason}`)].join('; '),
        };
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
      case 'allOf': {
        const inner = c.checks.map((x) => evaluateOne(t, x));
        const miss = inner.filter((r) => !r.pass);
        return { label: c.label, soft, pass: miss.length === 0, detail: miss.length ? miss.map((r) => `${r.label}: ${r.detail}`).join(' | ') : 'all satisfied' };
      }
    }
  }
}

/** A scenario passes when every hard (non-soft) check passes. */
export function scenarioPassed(results: CheckResult[]): boolean {
  return results.every((r) => r.soft || r.pass);
}
