/**
 * Fidelity eval runner — does an agent use this MCP CORRECTLY from a plain user goal, and does that hold up when
 * MCP_TOOLSETS trims the tool list? Complements the scripted UAT (docs/uat-test-suite.md), which names every tool and
 * therefore tests tool behaviour, not tool choice.
 *
 * Each scenario × toolset mode runs in a FRESH headless Claude Code session (`claude -p`):
 *  - empty temp working directory (no project CLAUDE.md, no auto-memory for that path)
 *  - --setting-sources local (user/project settings, skills and plugins are not loaded)
 *  - --strict-mcp-config with only this server (built dist/index.js), credentials from .env
 *  - --tools "" (no built-in tools: no file writes, no shell)
 *  - read-only MCP tools allowed; every side-effecting tool is DENIED (the attempt is still recorded and scored)
 * Transcripts are saved with access keys redacted under fidelity-results/<timestamp>/ (git-ignored).
 *
 * Usage:  npm run test:fidelity -- [--modes all,core] [--only id1,id2] [--runs 1] [--model <name>] [--concurrency 3]
 * Costs real model tokens: ~11 scenarios × 2 modes per run. Requires a logged-in Claude Code CLI and a populated .env.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, type Scenario } from './scenarios.js';
import { parseTranscript, evaluate, scenarioPassed, MCP_PREFIX, type CheckResult, type Trajectory } from './score.js';
import { SAFE_TOOLS } from './safety.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Args { modes: string[]; only: string[] | null; runs: number; model: string | null; concurrency: number }
function parseArgs(argv: string[]): Args {
  const get = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    modes: (get('modes') ?? 'all,core').split(',').map((s) => s.trim()).filter(Boolean),
    only: get('only') ? get('only')!.split(',').map((s) => s.trim()) : null,
    runs: Math.max(1, Number(get('runs') ?? 1)),
    model: get('model') ?? process.env.FIDELITY_MODEL ?? null,
    concurrency: Math.max(1, Number(get('concurrency') ?? 3)),
  };
}

function claudeBinary(): string {
  if (process.env.FIDELITY_CLAUDE_BIN) return process.env.FIDELITY_CLAUDE_BIN;
  if (process.platform !== 'win32') return 'claude';
  // npm's claude.cmd shim launches a native claude.exe; spawn that directly (a .cmd cannot be spawned without a shell,
  // and a shell would mangle the prompt quoting).
  const cmd = execFileSync('where', ['claude.cmd'], { encoding: 'utf8' }).split(/\r?\n/).find(Boolean);
  const exe = cmd ? join(dirname(cmd), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe') : '';
  if (!exe || !existsSync(exe)) throw new Error('Could not locate claude.exe — set FIDELITY_CLAUDE_BIN to the Claude Code executable.');
  return exe;
}

function loadEnv(): Record<string, string> {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) throw new Error('.env not found — the fidelity eval runs against the tenant configured there.');
  const env: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  if (!env.DIGITAL_AI_BASE_URL || !env.DIGITAL_AI_ACCESS_KEY) throw new Error('.env must define DIGITAL_AI_BASE_URL and DIGITAL_AI_ACCESS_KEY.');
  return env;
}

function redactor(env: Record<string, string>): (s: string) => string {
  const secrets = Object.entries(env).filter(([k, v]) => /KEY|TOKEN|SECRET/.test(k) && v.length >= 8).map(([, v]) => v);
  return (s) => secrets.reduce((acc, v) => acc.split(v).join('[REDACTED]'), s);
}

interface RunResult { scenario: Scenario; mode: string; run: number; trajectory: Trajectory; checks: CheckResult[]; passed: boolean; exitCode: number | null; stderr: string; transcriptFile: string }

function runOne(bin: string, scenario: Scenario, mode: string, run: number, env: Record<string, string>, args: Args, outDir: string, redact: (s: string) => string): Promise<RunResult> {
  const work = mkdtempSync(join(tmpdir(), 'dai-fidelity-'));
  const cwd = join(work, 'cwd');
  mkdirSync(cwd);
  const serverEnv: Record<string, string> = { ...env, MCP_DEPLOYMENT_MODE: 'local' };
  if (mode !== 'all') serverEnv.MCP_TOOLSETS = mode;
  const mcpConfig = join(work, 'mcp.json');
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { dai: { command: process.execPath, args: [join(ROOT, 'dist', 'index.js')], env: serverEnv } } }));
  const cliArgs = [
    '-p', scenario.prompt,
    '--output-format', 'stream-json', '--verbose',
    '--strict-mcp-config', '--mcp-config', mcpConfig,
    '--setting-sources', 'local',
    '--tools', '',
    '--no-session-persistence',
    '--allowedTools', ...SAFE_TOOLS.map((t) => MCP_PREFIX + t),
    ...(args.model ? ['--model', args.model] : []),
  ];
  return new Promise((done) => {
    const child = spawn(bin, cliArgs, { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 10 * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const transcriptFile = join(outDir, 'transcripts', `${mode}__${scenario.id}__${run}.jsonl`);
      writeFileSync(transcriptFile, redact(stdout));
      rmSync(work, { recursive: true, force: true }); // mcp.json holds credentials — never leave it behind
      const trajectory = parseTranscript(stdout);
      // Claude Code creates a per-cwd project folder (auto-memory path) under ~/.claude/projects — remove ours.
      const auto = (trajectory.memoryPaths as { auto?: string } | null)?.auto;
      if (auto && /dai-fidelity-/i.test(auto) && /[\\/]\.claude[\\/]projects[\\/]/.test(auto)) {
        rmSync(dirname(auto.replace(/[\\/]+$/, '')), { recursive: true, force: true });
      }
      const checks = evaluate(trajectory, scenario.checks);
      done({ scenario, mode, run, trajectory, checks, passed: scenarioPassed(checks) && code === 0, exitCode: code, stderr: redact(stderr).slice(-2000), transcriptFile });
    });
  });
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

function report(results: RunResult[], args: Args, started: Date): string {
  const modes = args.modes;
  const scenarios = [...new Map(results.map((r) => [r.scenario.id, r.scenario])).values()];
  const cell = (id: string, mode: string) => {
    const rs = results.filter((r) => r.scenario.id === id && r.mode === mode);
    const p = rs.filter((r) => r.passed).length;
    return rs.length ? `${p === rs.length ? '✅' : p === 0 ? '❌' : '⚠️'} ${p}/${rs.length}` : '—';
  };
  const cost = results.reduce((n, r) => n + (r.trajectory.costUsd ?? 0), 0);
  const lines = [
    `# MCP fidelity eval — ${started.toISOString()}`,
    '',
    `Model: ${[...new Set(results.map((r) => r.trajectory.model))].join(', ')} · Modes: ${modes.join(', ')} · Runs per cell: ${args.runs} · Cost: $${cost.toFixed(2)}`,
    `Mode "all" = MCP_TOOLSETS unset (full descriptions). Other modes = MCP_TOOLSETS=<mode> (tools outside it are one-line placeholders that load on first call).`,
    '',
    `| Scenario | Guards against | ${modes.join(' | ')} |`,
    `|---|---|${modes.map(() => '---').join('|')}|`,
    ...scenarios.map((s) => `| ${s.id} | ${s.guards} | ${modes.map((m) => cell(s.id, m)).join(' | ')} |`),
    '',
    '## Details',
  ];
  for (const s of scenarios) {
    lines.push('', `### ${s.id} — ${s.title}`, '', `> ${s.prompt}`);
    for (const r of results.filter((x) => x.scenario.id === s.id)) {
      lines.push('', `**${r.mode} · run ${r.run}: ${r.passed ? 'PASS' : 'FAIL'}** — ${r.trajectory.calls.length} tool calls, ${r.trajectory.turns ?? '?'} turns, $${(r.trajectory.costUsd ?? 0).toFixed(2)}${r.exitCode !== 0 ? ` · exit ${r.exitCode}` : ''}`);
      lines.push(`- trajectory: ${r.trajectory.calls.map((c) => c.tool + (c.denied ? '⊘' : '')).join(' → ') || '(none)'}`);
      for (const c of r.checks) lines.push(`- ${c.pass ? '✅' : c.soft ? '⚠️' : '❌'} ${c.label}${c.soft ? ' (soft)' : ''} — ${c.detail}`);
      if (r.exitCode !== 0 && r.stderr) lines.push(`- stderr: \`${r.stderr.replace(/\s+/g, ' ').slice(0, 300)}\``);
      lines.push(`- transcript: ${r.transcriptFile.replace(ROOT, '.')}`);
    }
  }
  lines.push('', '⊘ = denied by the harness (side-effecting tool) — the attempt is what is scored.');
  return lines.join('\n');
}

/**
 * Re-score saved transcripts with the CURRENT scenarios and scorer — no model calls, no cost. Use after changing a
 * check to see its effect on a previous run.
 */
function rescore(dir: string, args: Args) {
  const tdir = join(dir, 'transcripts');
  if (!existsSync(tdir)) throw new Error(`No transcripts/ in ${dir}`);
  const results: RunResult[] = [];
  for (const file of readdirSync(tdir).filter((f) => f.endsWith('.jsonl')).sort()) {
    const [mode, id, run] = file.replace(/\.jsonl$/, '').split('__');
    const scenario = SCENARIOS.find((s) => s.id === id);
    if (!scenario) { console.log(`  skip ${file} (scenario no longer exists)`); continue; }
    const trajectory = parseTranscript(readFileSync(join(tdir, file), 'utf8'));
    const checks = evaluate(trajectory, scenario.checks);
    results.push({ scenario, mode, run: Number(run), trajectory, checks, passed: scenarioPassed(checks), exitCode: 0, stderr: '', transcriptFile: join(tdir, file) });
    console.log(`  ${scenarioPassed(checks) ? 'PASS' : 'FAIL'}  ${mode.padEnd(10)} ${id}`);
  }
  const modes = [...new Set(results.map((r) => r.mode))];
  writeFileSync(join(dir, 'report-rescored.md'), report(results, { ...args, modes }, new Date()));
  console.log(`\n${results.filter((r) => r.passed).length}/${results.length} passed on re-score. Report: ${join(dir, 'report-rescored.md')}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rescoreIdx = process.argv.indexOf('--rescore');
  if (rescoreIdx >= 0) return rescore(resolve(process.argv[rescoreIdx + 1] ?? ''), args);
  const env = loadEnv();
  const bin = claudeBinary();
  if (!existsSync(join(ROOT, 'dist', 'index.js'))) throw new Error('dist/index.js missing — run npm run build first.');
  const scenarios = SCENARIOS.filter((s) => !args.only || args.only.includes(s.id));
  if (scenarios.length === 0) throw new Error(`No scenarios match --only ${args.only?.join(',')}. Known: ${SCENARIOS.map((s) => s.id).join(', ')}`);
  const started = new Date();
  const outDir = join(ROOT, 'fidelity-results', started.toISOString().replace(/[:.]/g, '-'));
  mkdirSync(join(outDir, 'transcripts'), { recursive: true });
  const redact = redactor(env);
  const jobs = args.modes.flatMap((mode) => scenarios.flatMap((scenario) => Array.from({ length: args.runs }, (_, i) => ({ mode, scenario, run: i + 1 }))));
  console.log(`Fidelity eval: ${scenarios.length} scenario(s) × ${args.modes.length} mode(s) × ${args.runs} run(s) = ${jobs.length} headless sessions (concurrency ${args.concurrency})`);
  const results = await pool(jobs, args.concurrency, async (j) => {
    const r = await runOne(bin, j.scenario, j.mode, j.run, env, args, outDir, redact);
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${j.mode.padEnd(10)} ${j.scenario.id}${args.runs > 1 ? ` #${j.run}` : ''}  (${r.trajectory.calls.map((c) => c.tool + (c.denied ? '⊘' : '')).join(' → ') || 'no tool calls'})`);
    return r;
  });
  const md = report(results, args, started);
  writeFileSync(join(outDir, 'report.md'), md);
  writeFileSync(join(outDir, 'results.json'), redact(JSON.stringify(results.map((r) => ({
    scenario: r.scenario.id, mode: r.mode, run: r.run, passed: r.passed, exitCode: r.exitCode,
    calls: r.trajectory.calls, checks: r.checks, turns: r.trajectory.turns, costUsd: r.trajectory.costUsd, model: r.trajectory.model,
  })), null, 2)));
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} passed. Report: ${join(outDir, 'report.md')}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(`fidelity eval failed: ${(e as Error).message}`); process.exitCode = 2; });
