/**
 * MCP_TOOLSETS — opt-in toolsets with self-loading placeholders (src/utils/toolsets.ts).
 *
 * The fidelity contract under test:
 *  - unset / "all": the tool list is IDENTICAL to registering every module directly (no behaviour change)
 *  - with a selection, EVERY tool name is still registered (guidance never points at a missing tool)
 *  - core tools (meta, enable_toolset, validate_test_script) always keep their full definitions
 *  - calling a placeholder executes nothing, loads its toolset, and returns the tool's FULL description + parameters
 *  - loading a toolset restores full definitions and emits notifications/tools/list_changed
 * Uses the real tool modules (all of them, as index.ts does) through an in-memory MCP client; no network.
 */
import { describe, it, beforeAll } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { resetClient } from '../src/api/client.js';
import {
  captureRegistrations,
  parseToolsetSelection,
  registerWithToolsets,
  toolsetOfModule,
  describeShape,
  TOOLSETS,
  CORE_MODULES,
  type RegisterFn,
  type ToolsetController,
} from '../src/utils/toolsets.js';
import { makeToolsetTools } from '../src/tools/toolset-tools.js';
import { registerUserTools } from '../src/tools/user-tools.js';
import { registerDeviceTools } from '../src/tools/device-tools.js';
import { registerDeviceGroupTools } from '../src/tools/device-group-tools.js';
import { registerReservationTools } from '../src/tools/reservation-tools.js';
import { registerApplicationTools } from '../src/tools/application-tools.js';
import { registerRepositoryTools } from '../src/tools/repository-tools.js';
import { registerBrowserTools } from '../src/tools/browser-tools.js';
import { registerProjectTools } from '../src/tools/project-tools.js';
import { registerProvisioningProfileTools } from '../src/tools/provisioning-profile-tools.js';
import { registerBackupTools } from '../src/tools/backup-tools.js';
import { registerHealthTools } from '../src/tools/health-tools.js';
import { registerReportingTools } from '../src/tools/reporting-tools.js';
import { registerTestViewTools } from '../src/tools/test-view-tools.js';
import { registerResources } from '../src/tools/resources.js';
import { registerPrompts } from '../src/tools/prompt-tools.js';
import { registerWorkflowTools } from '../src/tools/workflow-tools.js';
import { registerBoilerplateTools } from '../src/tools/boilerplate-tools.js';
import { registerAgentTools } from '../src/tools/agent-tools.js';
import { registerRegionTools } from '../src/tools/region-tools.js';
import { registerNvServerTools } from '../src/tools/nv-server-tools.js';
import { registerTransactionTools } from '../src/tools/transaction-tools.js';
import { registerCoverageTools } from '../src/tools/coverage-tools.js';
import { registerDebugTools } from '../src/tools/debug-tools.js';
import { registerInspectionTools } from '../src/tools/inspection-tools.js';
import { registerWebInspectionTools } from '../src/tools/web-inspection-tools.js';
import { registerPerformanceTools } from '../src/tools/performance-tools.js';
import { registerUsageReportTools } from '../src/tools/usage-report-tools.js';
import { registerTestRunTools } from '../src/tools/test-run-tools.js';
import { registerMetaTools } from '../src/tools/meta-tools.js';
import { DESTRUCTIVE_TOOL_RE, annotationsFor } from '../src/utils/tool-annotations.js';

type ToolEntry = { name: string; description?: string; inputSchema: { properties?: Record<string, unknown>; additionalProperties?: boolean }; annotations?: Record<string, unknown> };

function modules(getController: () => ToolsetController | undefined): Array<[string, RegisterFn]> {
  return [
    ['users', registerUserTools], ['devices', registerDeviceTools], ['device-groups', registerDeviceGroupTools],
    ['reservations', registerReservationTools], ['applications', registerApplicationTools], ['repository', registerRepositoryTools],
    ['browsers', registerBrowserTools], ['projects', registerProjectTools], ['provisioning-profiles', registerProvisioningProfileTools],
    ['backup', registerBackupTools], ['health', registerHealthTools], ['reporting', registerReportingTools],
    ['test-views', registerTestViewTools], ['resources', registerResources], ['prompts', registerPrompts],
    ['workflows', registerWorkflowTools], ['boilerplate', registerBoilerplateTools], ['agents', registerAgentTools],
    ['regions', registerRegionTools], ['nv-servers', registerNvServerTools], ['transactions', registerTransactionTools],
    ['coverage', registerCoverageTools], ['debug', registerDebugTools], ['inspection', registerInspectionTools],
    ['web-inspection', registerWebInspectionTools], ['performance', registerPerformanceTools], ['usage-reports', registerUsageReportTools],
    ['test-runs', registerTestRunTools], ['meta', registerMetaTools], ['toolsets', makeToolsetTools(getController)],
  ];
}

async function boot(raw: string | undefined) {
  let controller: ToolsetController | undefined;
  const server = new McpServer({ name: 't', version: '0' });
  const selection = parseToolsetSelection(raw);
  const c = registerWithToolsets(server, captureRegistrations(modules(() => controller)), selection);
  if (!selection.all) controller = c;
  const client = new Client({ name: 'c', version: '0' });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged++; });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const list = async () => ((await client.listTools()).tools as ToolEntry[]);
  return { client, list, listChanged: () => listChanged };
}

async function bootDirect() {
  const server = new McpServer({ name: 't', version: '0' });
  for (const [, register] of modules(() => undefined)) register(server);
  const client = new Client({ name: 'c', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return (await client.listTools()).tools as ToolEntry[];
}

const PLACEHOLDER = /^\[[a-z]+ toolset — loads on first call; that first call runs nothing and returns the full parameters\]/;

beforeAll(() => resetClient('https://unreachable.invalid', 'aut_1_toolsets', 'toolsets'));

describe('selection parsing and module coverage', () => {
  it('unset / empty / "all" → everything; names are case-insensitive; unknown names are reported', () => {
    for (const raw of [undefined, '', ' ', 'all', 'reporting,ALL']) assert.equal(parseToolsetSelection(raw).all, true, String(raw));
    const s = parseToolsetSelection('Reporting, inspection ,bogus');
    assert.equal(s.all, false);
    assert.deepEqual([...s.toolsets].sort(), ['inspection', 'reporting']);
    assert.deepEqual(s.unknown, ['bogus']);
    const core = parseToolsetSelection('core');
    assert.equal(core.all, false);
    assert.deepEqual([...core.toolsets], []);
    assert.deepEqual(core.unknown, [], '"core" is a valid keyword, not an unknown toolset');
  });

  it('every tool module registered in src/index.ts belongs to exactly one toolset (or the core)', () => {
    const index = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    const registered = [...index.matchAll(/\[\s*'([a-z-]+)',\s*(?:register\w+|makeToolsetTools)/g)].map((m) => m[1]);
    assert.ok(registered.length >= 29, 'module list not found in index.ts');
    const toolModules = new Set(captureRegistrations(modules(() => undefined)).tools.map((t) => t.module));
    for (const m of registered.filter((x) => toolModules.has(x))) {
      const owners = Object.entries(TOOLSETS).filter(([, t]) => t.modules.includes(m)).length;
      assert.ok(CORE_MODULES.includes(m) ? owners === 0 : owners === 1, `${m}: ${owners} toolsets`);
      assert.ok(CORE_MODULES.includes(m) || toolsetOfModule(m), m);
    }
  });

  it('describeShape lists every parameter with its guidance and required-ness', () => {
    const cap = captureRegistrations([['boilerplate', registerBoilerplateTools]]);
    const tool = cap.tools.find((t) => t.name === 'get_test_boilerplate')!;
    const lines = describeShape(tool.shape);
    assert.ok(lines.some((l) => /^- platform \(required\): /.test(l)), lines.slice(0, 3).join('\n'));
    assert.ok(lines.some((l) => /^- confirmSelectorsVerified: .*inspection/i.test(l)));
  });
});

describe('MCP_TOOLSETS unset → identical to direct registration', () => {
  it('same names, descriptions and input schemas as registering every module directly', async () => {
    const direct = await bootDirect();
    const { list } = await boot(undefined);
    const viaToolsets = await list();
    // The toolsets path adds two things on purpose — strict schemas (additionalProperties: false) and name-derived
    // annotations — so compare everything else, then assert those two separately.
    const norm = (ts: ToolEntry[]) =>
      ts.map((t) => JSON.stringify({ name: t.name, description: t.description, inputSchema: { ...t.inputSchema, additionalProperties: undefined } })).sort();
    assert.deepEqual(norm(viaToolsets), norm(direct));
    assert.ok(viaToolsets.every((t) => t.inputSchema.additionalProperties === false), 'every tool rejects unknown parameters');
    assert.ok(viaToolsets.every((t) => typeof t.annotations?.readOnlyHint === 'boolean'), 'every tool is annotated');
    assert.ok(viaToolsets.every((t) => !PLACEHOLDER.test(t.description ?? '')));
  });
});

describe('MCP_TOOLSETS=reporting → placeholders that load themselves', () => {
  it('every tool name is still registered; only non-selected, non-core tools are placeholders', async () => {
    const all = (await bootDirect()).map((t) => t.name).sort();
    const { list } = await boot('reporting');
    const tools = await list();
    assert.deepEqual(tools.map((t) => t.name).sort(), all, 'no tool may disappear');
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const core of ['get_server_info', 'switch_environment', 'enable_toolset', 'validate_test_script']) {
      assert.doesNotMatch(byName.get(core)!.description ?? '', PLACEHOLDER, `${core} must stay full`);
    }
    assert.doesNotMatch(byName.get('get_project_test_summary')!.description ?? '', PLACEHOLDER, 'selected toolset stays full');
    const ph = byName.get('start_inspection_session')!;
    assert.match(ph.description ?? '', PLACEHOLDER);
    assert.match(ph.description ?? '', /^\[inspection toolset/);
    assert.deepEqual(Object.keys(ph.inputSchema.properties ?? {}), [], 'placeholders carry no parameters');
  });

  it('the placeholder payload is a fraction of the full tool list', async () => {
    const full = JSON.stringify(await bootDirect()).length;
    const { list } = await boot('reporting');
    const partial = JSON.stringify(await list()).length;
    assert.ok(partial < full * 0.5, `expected < 50% of ${full} chars, got ${partial}`);
  });

  it('calling a placeholder runs nothing, returns the FULL guidance, loads the toolset and notifies the client', async () => {
    const { client, list, listChanged } = await boot('reporting');
    const res = (await client.callTool({ name: 'get_test_boilerplate', arguments: {} })) as { content: Array<{ text?: string }>; isError?: boolean };
    const text = res.content.map((c) => c.text ?? '').join('');
    assert.notEqual(res.isError, true, 'a guidance response, not an error');
    assert.match(text, /"authoring" toolset .* is loaded now/);
    assert.match(text, /Nothing was executed/);
    assert.match(text, /inspection gate|NEVER fabricate|confirmSelectorsVerified/i, 'the full description must be handed back');
    assert.match(text, /- platform \(required\):/);
    const after = new Map((await list()).map((t) => [t.name, t]));
    assert.doesNotMatch(after.get('get_test_boilerplate')!.description ?? '', PLACEHOLDER);
    assert.ok(Object.keys(after.get('get_test_boilerplate')!.inputSchema.properties ?? {}).includes('platform'));
    assert.doesNotMatch(after.get('execute_test_run')!.description ?? '', PLACEHOLDER, 'the whole toolset loads, not just one tool');
    assert.match(after.get('start_inspection_session')!.description ?? '', PLACEHOLDER, 'other toolsets stay placeholders');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(listChanged(), 1, 'exactly one tools/list_changed per load (not one per tool)');
  });

  it('after loading, the real tool runs (here: its own validation refuses missing args — not the placeholder text)', async () => {
    const { client } = await boot('reporting');
    await client.callTool({ name: 'cancel_test_run', arguments: {} });
    const res = (await client.callTool({ name: 'cancel_test_run', arguments: { testRunId: '1' } })) as { content: Array<{ text?: string }> };
    assert.match(res.content.map((c) => c.text ?? '').join(''), /Safety guard|confirmDeletion/);
  });

  it('rejects unknown parameters instead of silently dropping them; placeholders accept anything', async () => {
    const { client, list } = await boot('reporting');
    // A loaded tool: an invented parameter is an error that names the key (the SDK default would strip it and run).
    const bad = (await client.callTool({ name: 'list_test_reports', arguments: { search: 'x', outputFormat: 'json' } })) as { isError?: boolean; content: Array<{ text?: string }> };
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text ?? '', /Unrecognized key.*search/);
    const schema = (await list()).find((t) => t.name === 'list_test_reports')!.inputSchema as { additionalProperties?: boolean };
    assert.equal(schema.additionalProperties, false, 'the published schema says so too');
    // A placeholder: whatever the agent sends, it loads the toolset and returns guidance — never a validation error.
    const ph = (await client.callTool({ name: 'list_applications', arguments: { search: 'x', nameContains: 'y' } })) as { isError?: boolean; content: Array<{ text?: string }> };
    assert.notEqual(ph.isError, true);
    assert.match(ph.content[0].text ?? '', /Nothing was executed/);
  });

  it('annotations: placeholders are read-only; loaded tools carry readOnlyHint / destructiveHint by name', async () => {
    const { client, list } = await boot('reporting');
    const before = new Map((await list()).map((t) => [t.name, t.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined]));
    assert.equal(before.get('delete_application')?.readOnlyHint, true, 'a placeholder runs nothing, so it is read-only');
    assert.equal(before.get('list_test_reports')?.readOnlyHint, true);
    assert.equal(before.get('delete_test_reports')?.readOnlyHint, false);
    assert.equal(before.get('delete_test_reports')?.destructiveHint, true);
    await client.callTool({ name: 'enable_toolset', arguments: { toolsets: ['apps'] } });
    const after = new Map((await list()).map((t) => [t.name, t.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined]));
    assert.equal(after.get('delete_application')?.readOnlyHint, false, 'loaded: the real annotation replaces the placeholder one');
    assert.equal(after.get('delete_application')?.destructiveHint, true);
    assert.equal(after.get('list_applications')?.readOnlyHint, true);
  });

  it('enable_toolset lists state and loads toolsets on demand', async () => {
    const { client, list } = await boot('reporting');
    const listing = (await client.callTool({ name: 'enable_toolset', arguments: { outputFormat: 'json' } })) as { content: Array<{ text?: string }> };
    const before = JSON.parse(listing.content[0].text!);
    assert.equal(before.toolsets.find((t: { toolset: string }) => t.toolset === 'reporting').loaded, true);
    assert.equal(before.toolsets.find((t: { toolset: string }) => t.toolset === 'apps').loaded, false);
    const loaded = (await client.callTool({ name: 'enable_toolset', arguments: { toolsets: ['apps', 'devices'], outputFormat: 'json' } })) as { content: Array<{ text?: string }> };
    const after = JSON.parse(loaded.content[0].text!) as { loadedNow: string[]; signatures: string[] };
    const byName = new Map((await list()).map((t) => [t.name, t]));
    for (const n of ['list_applications', 'list_devices']) assert.doesNotMatch(byName.get(n)!.description ?? '', PLACEHOLDER, n);
    // A client that ignores tools/list_changed keeps the placeholder schema — the response names every parameter so the
    // agent never guesses them (fidelity eval 2026-10-14: execute_test_run called with invented parameter names).
    assert.equal(after.signatures.length, after.loadedNow.length);
    const sig = after.signatures.find((s) => s.startsWith('install_application('));
    assert.ok(sig, after.signatures.slice(0, 5).join('\n'));
    assert.match(sig!, /applicationId\*: number/, 'required params are starred and typed');
    assert.match(sig!, /deviceId: string[,)]/, 'optional params are not starred');
    const run = after.signatures.find((s) => s.startsWith('list_applications('));
    assert.match(run!, /osType: "ios"\|"android"/, 'enums list their values, through optional + preprocess wrappers');
    const del = after.signatures.find((s) => s.startsWith('delete_application('));
    assert.match(del!, /confirmDeletion\*?: boolean \[set only when the USER explicitly agreed\]/, 'guard flags carry the rule');
    const human = (await client.callTool({ name: 'enable_toolset', arguments: { toolsets: ['reporting'] } })) as { content: Array<{ text?: string }> };
    assert.doesNotMatch(human.content[0].text!, /Parameter names of the tools just loaded/, 'nothing listed when nothing newly loaded');
  });
});

describe('tool annotations cover every guarded tool', () => {
  it('every tool that calls checkDestructiveGuard matches DESTRUCTIVE_TOOL_RE (unassign_user_from_projects was missed once)', () => {
    const dir = join(process.cwd(), 'src', 'tools');
    const guarded: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(dir, file), 'utf8');
      // Each registration starts with server.tool(\n 'name', …; the guard call belongs to the nearest preceding name.
      const parts = src.split(/server\.tool\(\s*/).slice(1);
      for (const part of parts) {
        const name = part.match(/^'([a-z0-9_]+)'/)?.[1];
        if (name && part.includes('checkDestructiveGuard(')) guarded.push(name);
      }
    }
    assert.ok(guarded.length > 20, `found only ${guarded.length} guarded tools — the scan is broken`);
    assert.deepEqual(guarded.filter((n) => !DESTRUCTIVE_TOOL_RE.test(n)), []);
    assert.deepEqual(guarded.filter((n) => annotationsFor(n).destructiveHint !== true), []);
  });
});
