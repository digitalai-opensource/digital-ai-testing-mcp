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

describe('get_test_boilerplate — reportStatus (report the real outcome)', () => {
  // Verified live 2026-10-16: a session with no WebDriver errors is reported Passed even when the test failed on its own
  // assertion; with the wrapper the report is Failed with the assertion message as the cause (Grid and Appium Server).
  // stopStepsGroup is a 0-argument seetest command the Grid cannot run, so Grid gets the status only.
  const test = (g: Gen) => g.files.find((f) => /\.(java|py)$|Native\.js$/.test(f.filename) && !/conf/.test(f.filename))!.content;

  it('Appium Server: every language wraps the steps in a steps group and sets Passed/Failed', async () => {
    account.isAppiumOss = true; account.fail = false;
    for (const language of ['java-junit5', 'java-testng', 'python', 'nodejs']) {
      for (const platform of ['android', 'ios']) {
        const t = test((await gen({ platform, language, orchestration: 'off' })).json);
        assert.match(t, /seetest:client\.startStepsGroup['"], ['"]Test steps/, `${platform}/${language}: group start`);
        assert.match(t, /seetest:client\.stopStepsGroup/, `${platform}/${language}: group stop`);
        assert.match(t, /seetest:client\.setReportStatus['"], ['"]Passed/, `${platform}/${language}: Passed`);
        assert.match(t, /seetest:client\.setReportStatus['"], ['"]Failed/, `${platform}/${language}: Failed`);
        // Arguments are passed separately — the inline form fails silently.
        assert.doesNotMatch(t, /seetest:client\.\w+\(/, `${platform}/${language}: inline arguments`);
      }
    }
  });

  it('Appium Grid: status only — no steps group', async () => {
    account.isAppiumOss = false; account.fail = false;
    for (const language of ['java-junit5', 'python', 'nodejs']) {
      const t = test((await gen({ platform: 'android', language })).json);
      assert.match(t, /seetest:client\.setReportStatus/, language);
      assert.doesNotMatch(t, /StepsGroup/, `${language}: the Grid cannot run stopStepsGroup`);
    }
    account.isAppiumOss = true;
  });

  it('wraps the custom-app placeholder too, so an unfilled scaffold reports Failed', async () => {
    account.isAppiumOss = true; account.fail = false;
    const t = test((await gen({ platform: 'android', language: 'python', confirmSelectorsVerified: true, packageName: 'com.acme.app', mainActivity: '.Main' })).json);
    assert.ok(t.indexOf('setReportStatus", "Failed"') > t.indexOf('PLACEHOLDER TEST BODY'), 'the catch follows the placeholder body');
    assert.match(t, /try:\n[\s\S]*raise NotImplementedError[\s\S]*except Exception as e:/);
  });

  it('is the outermost layer: performance transaction and Axe scan sit inside it', async () => {
    account.isAppiumOss = true; account.fail = false;
    const t = test((await gen({ platform: 'android', language: 'java-junit5', includePerformanceTransactions: true, includeAxeScan: true, orchestration: 'off' })).json);
    // Match the calls, not the explanatory comments above them.
    const at = (s: string) => t.indexOf(s);
    const start = at('executeScript("seetest:client.startPerformanceTransaction"');
    const end = at('executeScript("seetest:client.endPerformanceTransaction"');
    assert.ok(at('try {') < start && start < end && end < at('"Passed"'));
    assert.ok(start < at('executeScript("mobile: axeScan"') && at('executeScript("mobile: axeScan"') < end);
  });

  it('reportStatus: false leaves the bare steps', async () => {
    account.isAppiumOss = true; account.fail = false;
    const t = test((await gen({ platform: 'android', language: 'python', reportStatus: false })).json);
    assert.doesNotMatch(t, /setReportStatus|StepsGroup/);
  });
});

describe('get_test_boilerplate — appiumVersion and reportKeys', () => {
  // Verified live 2026-10-16: digitalai:appiumVersion picks the Appium Server version (an unavailable one fails the
  // session with the platform's list); a digitalai:<key> capability lands on the report and filters list_test_reports
  // on Appium Server AND Grid.
  const test = (g: Gen) => g.files.map((f) => f.content).join('\n');

  it('Appium Server: both are injected in every language', async () => {
    account.isAppiumOss = true; account.fail = false;
    for (const language of ['java-junit5', 'java-testng', 'python', 'nodejs']) {
      const { json, human } = await gen({ platform: 'android', language, appiumVersion: '2.18.0', reportKeys: { runId: 'nightly-42' }, orchestration: 'off' });
      const t = test(json);
      assert.match(t, /digitalai:appiumVersion['"],? ?:? ?['"]2\.18\.0/, language);
      assert.match(t, /digitalai:runId['"],? ?:? ?['"]nightly-42/, language);
      assert.match(human, /"property":"runId","operator":"=","value":"nightly-42"/, language);
    }
  });

  it('newSessionWaitTimeout is a number capability in every language and both modes', async () => {
    for (const oss of [true, false]) {
      account.isAppiumOss = oss; account.fail = false;
      for (const language of ['java-junit5', 'python', 'nodejs']) {
        const t = test((await gen({ platform: 'android', language, newSessionWaitTimeout: 300, orchestration: 'off' })).json);
        assert.match(t, /digitalai:newSessionWaitTimeout['"](?:, |\] = |: )300\b/, `${oss ? 'oss' : 'grid'}/${language}`);
      }
    }
    account.isAppiumOss = true;
  });

  it('Appium Grid: report keys are injected; appiumVersion is ignored with a note', async () => {
    account.isAppiumOss = false; account.fail = false;
    for (const language of ['java-junit5', 'python', 'nodejs']) {
      const { json } = await gen({ platform: 'android', language, appiumVersion: '2.18.0', reportKeys: { runId: 'r1' } });
      const t = test(json);
      assert.match(t, /digitalai:runId/, language);
      assert.doesNotMatch(t, /digitalai:appiumVersion/, language);
      assert.match(String((json as unknown as { capabilityNotes: string[] }).capabilityNotes), /appiumVersion ignored/);
    }
    account.isAppiumOss = true;
  });

  it('rejects unsafe report keys and appiumVersion with includeAxeScan', async () => {
    account.isAppiumOss = true; account.fail = false;
    for (const bad of [{ 'bad key': 'x' }, { ok: 'x"); System.exit(1); //' }, { ok: '' }]) {
      const r = await call('get_test_boilerplate', { platform: 'android', language: 'python', reportKeys: bad });
      assert.equal(r.isError, true, JSON.stringify(bad));
    }
    for (const bad of [{ build: 'rc  1' }, { build: ' rc' }]) {
      const r = await call('get_test_boilerplate', { platform: 'android', language: 'robot', reportKeys: bad });
      assert.equal(r.isError, true, `double/leading space must be refused: ${JSON.stringify(bad)}`);
    }
    for (const reserved of ['deviceQuery', 'accessKey', 'AppiumVersion', 'testName']) {
      const r = await call('get_test_boilerplate', { platform: 'android', language: 'python', reportKeys: { [reserved]: 'x' } });
      assert.equal(r.isError, true, reserved);
      assert.match(r.content[0].text ?? '', /reserved capability name/, reserved);
    }
    const r = await call('get_test_boilerplate', { platform: 'android', language: 'python', appiumVersion: '2.18.0', includeAxeScan: true });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text ?? '', /cannot be combined with includeAxeScan/);
  });

  it('Axe on Appium Server pins the version with the digitalai: name (a bare name breaks wdio 9)', async () => {
    account.isAppiumOss = true; account.fail = false;
    for (const language of ['java-junit5', 'python', 'nodejs']) {
      const t = test((await gen({ platform: 'android', language, includeAxeScan: true, orchestration: 'off' })).json);
      assert.match(t, /digitalai:appiumVersion['"],? ?:? ?['"]2\.16\.2/, language);
      assert.doesNotMatch(t, /['"]appiumVersion['"]/, language);
    }
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

describe('get_web_test_boilerplate — file naming', () => {
  it('does not double the Test suffix', async () => {
    const res = await call('get_web_test_boilerplate', { language: 'java-junit5', testName: 'ExampleWebTest', outputFormat: 'json' });
    const j = JSON.parse(res.content.map((c) => c.text ?? '').join('')) as { files: Array<{ filename: string }> };
    const names = j.files.map((f) => f.filename);
    assert.ok(names.some((n) => /ExampleWebTest.java$/.test(n)), names.join(', '));
    assert.ok(!names.some((n) => /TestTest/.test(n)), names.join(', '));
  });
});

describe('get_test_boilerplate — Robot Framework (Appium Server only)', () => {
  // Verified live 2026-10-16 (robotframework 7.5 + AppiumLibrary 3.2.1): Android and iOS demo suites passed; a suite with
  // a failing step reported Failed with Robot's message as the cause; report keys / newSessionWaitTimeout were honoured.
  const suite = (g: Gen) => g.files.find((f) => f.filename.endsWith('.robot'))!.content;

  it('Android and iOS: suite + reporting library + pinned requirements, outcome reported from the teardown', async () => {
    account.isAppiumOss = true; account.fail = false;
    for (const platform of ['android', 'ios']) {
      const { json, human } = await gen({ platform, language: 'robot' });
      assert.deepEqual(json.files.map((f) => f.filename).sort(), ['requirements.txt', `tests/${platform === 'android' ? 'AndroidNative' : 'iOSNative'}.robot`, 'tests/DigitalAiReport.py'].sort());
      const s = suite(json);
      assert.match(s, /Library\s+AppiumLibrary/);
      assert.match(s, /Test Teardown\s+Close Cloud Session/);
      assert.match(s, /Report Test Outcome\s+\$\{TEST STATUS\}\s+\$\{TEST MESSAGE\}/);
      assert.match(s, /Start Steps Group\s+Test steps/);
      assert.match(s, /%\{DIGITAL_AI_ACCESS_KEY=aut_1_harness_key\}/, 'env var wins, key is the fallback');
      assert.doesNotMatch(s, /\[Enter |BEGIN_DEMO_STEPS/);
      assert.match(json.files.find((f) => f.filename === 'requirements.txt')!.content, /robotframework==7\.5\nrobotframework-appiumlibrary==3\.2\.1/);
      assert.match(json.files.find((f) => f.filename === 'tests/DigitalAiReport.py')!.content, /execute_script\('seetest:client\.setReportStatus', mapped,/);
      assert.match(human, /robot --outputdir results tests\//);
    }
  });

  it('refuses Appium Grid projects and the options that have no Robot form', async () => {
    account.isAppiumOss = false; account.fail = false;
    const grid = await call('get_test_boilerplate', { platform: 'android', language: 'robot' });
    assert.equal(grid.isError, true);
    assert.match(grid.content[0].text ?? '', /Appium Server projects only — this project runs on Appium Grid/);
    account.isAppiumOss = true;
    for (const opt of [{ includeAxeScan: true }, { includePerformanceTransactions: true }, { automotiveProjection: '800x480' }]) {
      const r = await call('get_test_boilerplate', { platform: 'android', language: 'robot', ...opt });
      assert.equal(r.isError, true, JSON.stringify(opt));
      assert.match(r.content[0].text ?? '', /not available for Robot Framework yet/);
    }
  });

  it('injects extra capabilities as dictionary rows (numbers as ${n})', async () => {
    account.isAppiumOss = true; account.fail = false;
    const s = suite((await gen({ platform: 'android', language: 'robot', newSessionWaitTimeout: 300, appiumVersion: '2.18.0', reportKeys: { runId: 'r1' } })).json);
    assert.match(s, /\n\.\.\. +digitalai:deviceQuery=[^\n]*\n\.\.\. +digitalai:appiumVersion=2\.18\.0\n\.\.\. +digitalai:newSessionWaitTimeout=\$\{300\}\n\.\.\. +digitalai:runId=r1\n/);
  });

  it('a custom app gets the Robot placeholder with a Fail guard that validate_test_script flags', async () => {
    account.isAppiumOss = true; account.fail = false;
    const s = suite((await gen({ platform: 'android', language: 'robot', confirmSelectorsVerified: true, packageName: 'com.acme.app', mainActivity: '.Main' })).json);
    assert.match(s, /^    Fail    Replace this placeholder body/m);
    assert.match(s, /#   Wait And Click    id=<resource-id from get_element_tree>/);
    assert.doesNotMatch(s, /usernameTextField/);
    const v = await call('validate_test_script', { scriptContent: s, fileName: 'AndroidNative.robot', outputFormat: 'json' });
    assert.equal(v.isError, true);
    assert.match(v.content.map((c) => c.text ?? '').join(''), /scaffold guard present/);
  });
});

describe('generated demo tests pass their own validator with no warnings (release 1)', () => {
  for (const isAppiumOss of [true, false]) {
    for (const platform of ['android', 'ios'] as const) {
      for (const language of ['python', 'java-junit5', 'java-testng', 'nodejs', 'robot'] as const) {
        if (language === 'robot' && !isAppiumOss) continue;
        it(`${isAppiumOss ? 'Appium Server' : 'Appium Grid'} ${platform} ${language}`, async () => {
          account.isAppiumOss = isAppiumOss; account.fail = false;
          const g = (await gen({ platform, language, orchestration: 'off' })).json;
          for (const f of g.files.filter((f) => /\.(py|java|js|robot)$/.test(f.filename) && !/Report\.py$|wdio\.conf\.js$/.test(f.filename))) {
            const v = await call('validate_test_script', { scriptContent: f.content, fileName: f.filename, outputFormat: 'json' });
            const j = JSON.parse(v.content.map((c) => c.text ?? '').join('')) as { verdict: string; issues: Array<{ severity: string; label: string; detail: string }> };
            assert.equal(j.verdict, 'pass', f.filename);
            const warn = j.issues.filter((i) => i.severity === 'warn');
            assert.equal(warn.length, 0, `${f.filename}: ${warn.map((w) => `${w.label}: ${w.detail}`).join(' | ')}`);
          }
        });
      }
    }
  }
});

describe('get_web_test_boilerplate — fixes found running the templates live (2026-10-16)', () => {
  const webGen = async (args: Record<string, unknown>) => {
    const res = await call('get_web_test_boilerplate', { testName: 'Checkout', outputFormat: 'json', ...args });
    return { res, json: JSON.parse(res.content.map((c) => c.text ?? '').join('')) as { files: Array<{ filename: string; content: string }> } };
  };
  const source = (j: { files: Array<{ filename: string; content: string }> }) => j.files.map((f) => f.content).join('\n');

  it('names the report with digitalai:testName (digitalai:reportName is ignored by the platform)', async () => {
    for (const language of ['java-junit5', 'python', 'nodejs']) {
      const s = source((await webGen({ language })).json);
      assert.match(s, /digitalai:testName/, language);
      assert.doesNotMatch(s, /digitalai:reportName/, language);
    }
  });

  it('python: Selenium 4 options (no desired_capabilities) and no double-indented browser lines', async () => {
    const s = source((await webGen({ language: 'python' })).json);
    assert.doesNotMatch(s, /desired_capabilities=/);
    assert.match(s, /options = ArgOptions\(\)/);
    assert.match(s, /\n {8}browser_name = os\.environ\.get\("BROWSER", "chrome"\)\n {8}caps\["browserName"\] = browser_name\n/);
  });

  it('every web language reports the real outcome', async () => {
    for (const language of ['java-junit5', 'python', 'nodejs']) {
      const s = source((await webGen({ language })).json);
      assert.match(s, /seetest:client\.setReportStatus['"], ['"]Failed/, language);
      assert.match(s, /seetest:client\.startStepsGroup/, language);
    }
  });

  it('robot: SeleniumLibrary suite with the report library; Edge maps to "edge"; Opera is refused', async () => {
    const { json } = await webGen({ language: 'robot' });
    assert.deepEqual(json.files.map((f) => f.filename), ['tests/Checkout.robot', 'tests/DigitalAiWebReport.py', 'requirements.txt']);
    const s = json.files[0].content;
    assert.match(s, /Library\s+SeleniumLibrary/);
    assert.match(s, /set_capability\("digitalai:testName", "\$\{TEST_NAME\}"\)/);
    assert.match(s, /\$\{BROWSER\}\s+%\{BROWSER=chrome\}/);
    assert.match(s, /^    Fail    Replace this placeholder/m);
    assert.match(source((await webGen({ language: 'robot', targetBrowser: 'edge' })).json), /\$\{BROWSER\}\s+edge\n/);
    const r = await call('get_web_test_boilerplate', { language: 'robot', targetBrowser: 'opera' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text ?? '', /cannot drive Opera/);
  });
});

describe('get_test_boilerplate — NodeJS spec path matches wdio.conf.js', () => {
  // Regression (live run 2026-10-16): the spec was returned as a bare "AndroidNative.js"; saved at the project root,
  // WebdriverIO found "0 spec files" and ran nothing, without an error.
  it('every platform × server mode returns the spec at the path its config loads', async () => {
    for (const oss of [true, false]) {
      account.isAppiumOss = oss; account.fail = false;
      for (const platform of ['android', 'ios']) {
        const { json } = await gen({ platform, language: 'nodejs' });
        const conf = json.files.find((f) => f.filename === 'wdio.conf.js')!.content;
        const spec = conf.match(/specs:\s*\['\.\/([^']+)'\]/)![1];
        assert.ok(json.files.some((f) => f.filename === spec), `${oss ? 'oss' : 'grid'}/${platform}: no file at ${spec} — got ${json.files.map((f) => f.filename).join(', ')}`);
      }
    }
    account.isAppiumOss = true;
  });
});
