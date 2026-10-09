/**
 * get_test_boilerplate orchestration defaults + install_test_orchestrator_agent, driven through a real MCP
 * client/server pair. getMyAccountInfo is mocked so the project can be Appium Server, Grid, or "lookup failed"
 * without a live API; the client points at an unreachable host so nothing else can touch the network.
 */
import { describe, it, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const account = vi.hoisted(() => ({ isAppiumOss: true, fail: false }));
vi.mock('../src/api/users.js', () => ({
  getMyAccountInfo: async () => {
    if (account.fail) throw new Error('simulated 503 from my-account-info');
    return {
      username: 'harness', firstName: 'H', lastName: 'H', role: 'Admin',
      project: { id: 1, name: 'Harness', isAppiumOss: account.isAppiumOss, created: 0, notes: null },
    };
  },
}));

import { registerBoilerplateTools } from '../src/tools/boilerplate-tools.js';
import { resetClient } from '../src/api/client.js';

interface ToolResult { content: Array<{ type: string; text?: string }>; isError?: boolean }
interface Gen {
  serverMode: string;
  files: Array<{ filename: string; content: string }>;
  orchestration: { enabled: boolean; mode: string; reason: string; maxRetryAttempts?: number; agent?: { projectPath: string; source: string } };
}

let client: Client;
let jarServer: http.Server;
const ORIGINAL_MODE = process.env.MCP_DEPLOYMENT_MODE;
const ORIGINAL_URL = process.env.TEST_ORCHESTRATOR_JAR_URL;
const ORIGINAL_SHA = process.env.TEST_ORCHESTRATOR_JAR_SHA256;
const FAKE_JAR = Buffer.from('fake-agent-jar-for-handler-tests');

beforeAll(async () => {
  process.env.MCP_DEPLOYMENT_MODE = 'local'; // install tool writes directly (read at registration time)
  // The agent is downloaded on demand — serve it locally so these tests never touch the network.
  jarServer = http.createServer((_req, res) => res.end(FAKE_JAR));
  await new Promise<void>((r) => jarServer.listen(0, '127.0.0.1', r));
  process.env.TEST_ORCHESTRATOR_JAR_URL = `http://127.0.0.1:${(jarServer.address() as AddressInfo).port}/agent.jar`;
  process.env.TEST_ORCHESTRATOR_JAR_SHA256 = createHash('sha256').update(FAKE_JAR).digest('hex');
  resetClient('https://unreachable.invalid', 'aut_1_harness_key', 'harness');
  const server = new McpServer({ name: 'h', version: '0' });
  registerBoilerplateTools(server);
  client = new Client({ name: 'hc', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
});
afterAll(async () => {
  for (const [k, v] of [['MCP_DEPLOYMENT_MODE', ORIGINAL_MODE], ['TEST_ORCHESTRATOR_JAR_URL', ORIGINAL_URL], ['TEST_ORCHESTRATOR_JAR_SHA256', ORIGINAL_SHA]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise<void>((r) => jarServer.close(() => r()));
});

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}
async function gen(args: Record<string, unknown>): Promise<{ json: Gen; human: string; res: ToolResult }> {
  const res = await call('get_test_boilerplate', { ...args, outputFormat: 'json' });
  const text = res.content.map((c) => c.text ?? '').join('');
  const json = JSON.parse(text) as Gen;
  const human = (await call('get_test_boilerplate', { ...args, outputFormat: 'human' })).content.map((c) => c.text ?? '').join('');
  return { json, human, res };
}
const file = (g: Gen, name: string) => g.files.find((f) => f.filename === name);

describe('get_test_boilerplate — orchestration defaults', () => {
  it('Appium Server + Java (auto): orchestrated by default', async () => {
    account.isAppiumOss = true; account.fail = false;
    for (const language of ['java-junit5', 'java-testng']) {
      const { json, human } = await gen({ platform: 'android', language });
      assert.equal(json.serverMode, 'oss');
      assert.equal(json.orchestration.enabled, true, language);
      assert.equal(json.orchestration.maxRetryAttempts, 2);
      assert.match(file(json, 'build.gradle')!.content, /-javaagent:/);
      assert.match(file(json, 'pom.xml')!.content, /digitalai-test-orchestrator/);
      assert.match(file(json, 'orchestrator/config.template.yml')!.content, /accessKey: @DIGITAL_AI_ACCESS_KEY@/);
      assert.ok(file(json, 'orchestrator/.gitignore'));
      assert.ok(file(json, 'lib/.gitignore'));
      assert.equal(file(json, '.gitignore'), undefined, 'must never emit a root .gitignore (it would overwrite the user\'s)');
      assert.match(json.orchestration.agent!.source, /^configured URL \(http:\/\/127\.0\.0\.1:/);
      assert.match(human, /Test Orchestrator: ON/);
    }
  });

  it('the generated agent config never contains the real access key', async () => {
    account.isAppiumOss = true; account.fail = false;
    const { json } = await gen({ platform: 'ios', language: 'java-junit5' });
    assert.doesNotMatch(file(json, 'orchestrator/config.template.yml')!.content, /aut_1_harness_key/);
  });

  it('orchestration: "off" returns the classic boilerplate unchanged', async () => {
    account.isAppiumOss = true; account.fail = false;
    const { json } = await gen({ platform: 'android', language: 'java-testng', orchestration: 'off' });
    assert.equal(json.orchestration.enabled, false);
    assert.doesNotMatch(file(json, 'build.gradle')!.content, /javaagent/);
    assert.doesNotMatch(file(json, 'pom.xml')!.content, /orchestrator/);
    assert.equal(file(json, 'orchestrator/config.template.yml'), undefined);
    assert.equal(json.files.length, 3);
  });

  it('Appium Grid (auto): classic output, no warning', async () => {
    account.isAppiumOss = false; account.fail = false;
    const { json, human } = await gen({ platform: 'android', language: 'java-junit5' });
    assert.equal(json.serverMode, 'grid');
    assert.equal(json.orchestration.enabled, false);
    assert.match(json.orchestration.reason, /Appium Grid/);
    assert.doesNotMatch(human, /requested but not applied/);
  });

  it('Appium Grid + orchestration: "on": classic output WITH an explicit explanation', async () => {
    account.isAppiumOss = false; account.fail = false;
    const { json, human } = await gen({ platform: 'ios', language: 'java-testng', orchestration: 'on' });
    assert.equal(json.orchestration.enabled, false);
    assert.match(human, /requested but not applied/);
  });

  it('account lookup failure: reports "could not be determined", never claims the project is Grid', async () => {
    account.fail = true;
    try {
      const { json, human } = await gen({ platform: 'android', language: 'java-testng', orchestration: 'on' });
      assert.equal(json.orchestration.enabled, false);
      assert.match(json.orchestration.reason, /could not be determined/);
      assert.doesNotMatch(json.orchestration.reason, /runs on Appium Grid/);
      assert.match(human, /requested but not applied/);
    } finally {
      account.fail = false;
    }
  });

  it('Python and NodeJS are never orchestrated', async () => {
    account.isAppiumOss = true; account.fail = false;
    for (const language of ['python', 'nodejs']) {
      const { json } = await gen({ platform: 'android', language });
      assert.equal(json.orchestration.enabled, false, language);
    }
  });

  it('android-gradle-submodule scopes the generated files under e2e-tests/', async () => {
    account.isAppiumOss = true; account.fail = false;
    const { json } = await gen({ platform: 'android', language: 'java-junit5', projectType: 'android-gradle-submodule' });
    assert.ok(file(json, 'e2e-tests/orchestrator/config.template.yml'));
    assert.ok(file(json, 'e2e-tests/orchestrator/.gitignore'));
    assert.ok(file(json, 'e2e-tests/lib/.gitignore'));
    assert.equal(json.orchestration.agent?.projectPath, 'e2e-tests/lib/smart-agent.jar');
  });

  it('performance transactions default retries to 0; an explicit value wins', async () => {
    account.isAppiumOss = true; account.fail = false;
    const perf = await gen({ platform: 'android', language: 'java-testng', includePerformanceTransactions: true });
    assert.equal(perf.json.orchestration.maxRetryAttempts, 0);
    assert.match(file(perf.json, 'orchestrator/config.template.yml')!.content, /maxRetryAttempts: 0/);
    const explicit = await gen({ platform: 'android', language: 'java-testng', orchestrationMaxRetries: 3 });
    assert.equal(explicit.json.orchestration.maxRetryAttempts, 3);
  });
});

describe('install_test_orchestrator_agent (local mode)', () => {
  it('writes lib/smart-agent.jar into an existing project and flags a missing build file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-tool-'));
    try {
      const bare = await call('install_test_orchestrator_agent', { projectDir: dir, outputFormat: 'json' });
      assert.notEqual(bare.isError, true, bare.content.map((c) => c.text).join(''));
      const bareJson = JSON.parse(bare.content.map((c) => c.text ?? '').join(''));
      assert.equal(bareJson.buildFileFound, false);
      assert.match(bareJson.warning, /No build\.gradle/);
      assert.ok(existsSync(join(dir, 'lib', 'smart-agent.jar')));

      writeFileSync(join(dir, 'build.gradle'), "apply plugin: 'java'");
      const withBuild = await call('install_test_orchestrator_agent', { projectDir: dir, outputFormat: 'json' });
      const j = JSON.parse(withBuild.content.map((c) => c.text ?? '').join(''));
      assert.equal(j.buildFileFound, true);
      assert.equal(j.warning, undefined);
      assert.equal(j.replacedExisting, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a projectDir that does not exist', async () => {
    const res = await call('install_test_orchestrator_agent', { projectDir: join(tmpdir(), 'definitely-missing-orch-dir-xyz') });
    assert.equal(res.isError, true);
    assert.match(res.content.map((c) => c.text).join(''), /does not exist/);
  });

  it('rejects a relative or traversal path before writing anything', async () => {
    // Build the traversal path by string — path.join would normalise the '..' away before the tool sees it.
    for (const projectDir of ['relative/dir', `${tmpdir()}/../x`]) {
      const res = await call('install_test_orchestrator_agent', { projectDir });
      assert.equal(res.isError, true, projectDir);
    }
  });

  it('requires projectDir', async () => {
    const res = await call('install_test_orchestrator_agent', {});
    assert.equal(res.isError, true);
  });
});

describe('get_test_boilerplate — automotiveProjection (Android Auto / CarPlay)', () => {
  const sources = (g: Gen) => g.files.filter((f) => /\.(java|py|js)$/.test(f.filename));
  const all = (g: Gen) => g.files.map((f) => f.content).join('\n');

  it('Appium Server: every language sets the capability and appends the head-unit screenshot step', async () => {
    account.isAppiumOss = true; account.fail = false;
    for (const language of ['java-junit5', 'java-testng', 'python', 'nodejs']) {
      const { json, human } = await gen({ platform: 'android', language, automotiveProjection: '1280x720', orchestration: 'off' });
      const text = all(json);
      assert.match(text, /digitalai:automotiveProjection['"][,):]? ?['"]?1280x720/, `${language}: capability missing`);
      assert.match(text, /digitalai:automotive\.getScreenshot/, `${language}: screenshot step missing`);
      assert.match(text, /\/\/ .*digitalai:automotive\.tap|# .*digitalai:automotive\.tap/, `${language}: tap must stay a commented template`);
      assert.ok(sources(json).length > 0);
      assert.match(human, /Automotive projection: ON/);
      assert.equal((json as unknown as { automotive: { applied: boolean } }).automotive.applied, true);
    }
  });

  it('Appium Grid: classic boilerplate with an explicit "not applied" note', async () => {
    account.isAppiumOss = false; account.fail = false;
    const { json, human } = await gen({ platform: 'android', language: 'java-junit5', automotiveProjection: '800x480' });
    assert.doesNotMatch(all(json), /digitalai:automotive/);
    assert.match(human, /Automotive projection requested but not applied/);
    account.isAppiumOss = true;
  });

  it('CarPlay (iOS) accepts 800x480 only', async () => {
    account.isAppiumOss = true; account.fail = false;
    const bad = await call('get_test_boilerplate', { platform: 'ios', language: 'python', automotiveProjection: '1920x1080' });
    assert.equal(bad.isError, true);
    const ok = await gen({ platform: 'ios', language: 'python', automotiveProjection: '800x480' });
    assert.match(all(ok.json), /digitalai:automotiveProjection', '800x480'/);
  });
});

describe('get_test_boilerplate — template line endings never disable the step markers', () => {
  // Regression: on a Windows checkout (core.autocrlf) the NodeJS templates are CRLF and the "\n"-only marker patterns
  // never matched — a custom-app NodeJS boilerplate shipped ExperiBank's demo steps with the package swapped in.
  it('NodeJS custom app (android + ios): placeholder fail-guard, no demo steps, no leftover markers', async () => {
    account.isAppiumOss = true; account.fail = false;
    for (const [platform, appArg] of [['android', { packageName: 'com.acme.app', mainActivity: '.Main' }], ['ios', { bundleIdentifier: 'com.acme.app' }]] as const) {
      const { json } = await gen({ platform, language: 'nodejs', confirmSelectorsVerified: true, ...appArg });
      const test = json.files.find((f) => /Native\.js$/.test(f.filename))!.content;
      assert.match(test, /PLACEHOLDER TEST BODY/, platform);
      assert.doesNotMatch(test, /usernameTextField|BEGIN_DEMO_STEPS|END_DEMO_STEPS/, platform);
      assert.doesNotMatch(test, /\r/, `${platform}: generated file must be LF`);
    }
  });
});
