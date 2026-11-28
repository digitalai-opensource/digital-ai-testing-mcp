/**
 * App exploration stage 3: tests written from accepted flows. renderFlowTests on every Appium Server template, and
 * get_test_boilerplate with explorationJobId through a real MCP client/server pair (getMyAccountInfo mocked, the
 * exploration read from a temp folder, nothing touching the network).
 */
import { describe, it, beforeAll, afterAll, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const account = vi.hoisted(() => ({ isAppiumOss: true }));
vi.mock('../src/api/users.js', () => ({
  getMyAccountInfo: async () => ({ username: 'h', firstName: 'H', lastName: 'H', role: 'Admin', project: { id: 1, name: 'Default', isAppiumOss: account.isAppiumOss, created: 0, notes: null } }),
}));

import { renderFlowTests, dataEnv, type CodegenFlow, type CodegenLanguage } from '../src/utils/flow-codegen.js';
import { registerBoilerplateTools, detectFabricationIssues } from '../src/tools/boilerplate-tools.js';
import { resetClient } from '../src/api/client.js';

const B = join(__dirname, '..', 'resources', 'boilerplate');
const TEMPLATES: Array<[CodegenLanguage, 'android' | 'ios', string]> = [
  ['java-junit5', 'android', 'Android-Native/Java JUnit5/AndroidNative-oss.java'],
  ['java-testng', 'android', 'Android-Native/java TestNG/AndroidNative-oss.java'],
  ['python', 'android', 'Android-Native/Python/AndroidNative-oss.py'],
  ['nodejs', 'android', 'Android-Native/NodeJS (WebDriver)/AndroidNative.js'],
  ['robot', 'android', 'Android-Native/Robot Framework/AndroidNative-oss.robot'],
  ['java-junit5', 'ios', 'iOS-Native/java-JUnit5/iOSNative-oss.java'],
  ['java-testng', 'ios', 'iOS-Native/java-TestNG/iOSNative-oss.java'],
  ['python', 'ios', 'iOS-Native/Python/iOSNative-oss.py'],
  ['nodejs', 'ios', 'iOS-Native/NodeJS (WebDriver)/iOSNative.js'],
  ['robot', 'ios', 'iOS-Native/Robot Framework/iOSNative-oss.robot'],
];
const id = (v: string) => ({ using: 'id' as const, value: v });
const flows: CodegenFlow[] = [
  { id: 'open-transfer', title: 'Open Transfer Funds', kind: 'navigate', steps: [{ label: 'Transfer', locator: { using: 'xpath' as const, value: "//*[@text='Transfer']" } }], check: { label: 'Amount', locator: id('com.acme.bank:id/amount') } },
  { id: 'submit-transfer', title: 'Fill and submit Transfer Funds', kind: 'form', steps: [{ label: 'Transfer', locator: { using: 'xpath' as const, value: "//*[@text='Transfer']" } }], fields: [{ label: 'Amount', locator: id('com.acme.bank:id/amount') }], choices: [{ label: 'Payee', locator: { using: 'xpath' as const, value: "(//*[contains(@class,'EditText')])[1]" } }], action: { label: 'Send', locator: { using: 'accessibility id' as const, value: 'Send money' } } },
];
const login = { user: id('com.acme.bank:id/user'), password: id('com.acme.bank:id/pass'), submit: id('com.acme.bank:id/signin') };

describe('renderFlowTests: one test per flow in every Appium Server template', () => {
  for (const [lang, platform, file] of TEMPLATES) {
    it(`${lang} ${platform}`, () => {
      const raw = readFileSync(join(B, file), 'utf8').replace(/\r\n/g, '\n');
      const out = renderFlowTests(raw, { language: lang, flows, login });
      assert.ok(out, 'the template has a test the flows can replace');
      assert.doesNotMatch(out!, /\[TEST_METHOD\]|\[testNameHere\]|BEGIN_DEMO_STEPS|ExperiBank|experitest/i, 'no placeholder or demo left');
      assert.match(out!, /com\.acme\.bank:id\/user/);
      assert.match(out!, /APP_TEST_PASSWORD/);
      assert.match(out!, /TEST_DATA_AMOUNT/);
      assert.match(out!, /confirm the expected result with the user/, 'a form flow says its outcome is not known');
      assert.doesNotMatch(out!, /activateApp|activate_app|Activate Application/, 'no app activation (it sent the app away on one phone)');
      if (lang === 'nodejs') assert.match(out!, /async function freshSession\(\)[\s\S]*?require\('\.\.\/\.\.\/wdio\.conf\.js'\)[\s\S]*?await freshSession\(\)/, 'a new session goes through the hub, not the device agent');
      // A drop-down: its option is picked only when TEST_DATA_PAYEE is set, by the option's text; otherwise it stays.
      assert.match(out!, /TEST_DATA_PAYEE/);
      assert.match(out!, lang === 'robot' ? /IF {4}os\.environ\.get\('TEST_DATA_PAYEE'\)\n[\s\S]*?starts-with\(@text,"%\{TEST_DATA_PAYEE\}"\)[\s\S]*?\n {4}END/ : lang === 'python' ? /if os\.environ\.get\("TEST_DATA_PAYEE"\):/ : lang === 'nodejs' ? /if \(process\.env\['TEST_DATA_PAYEE'\]\)[\s\S]*?replaceAll\('%s'/ : /if \(System\.getenv\("TEST_DATA_PAYEE"\) != null\)/);
      assert.match(out!, /not\(contains\(@class,\\?"EditText\\?"\)\)\]\[starts-with\(@text,/, 'an option is picked by the start of its text, never the field itself');
      const tests = lang === 'python' ? out!.match(/def test_/g) : lang === 'nodejs' ? out!.match(/it\('/g) : lang === 'robot' ? out!.match(/^\S.*\n {4}Start Steps Group/gm) : out!.match(/@Test/g);
      assert.equal(tests?.length, 2, 'one test per flow');
      if (lang.startsWith('java')) assert.match(out!, /import io\.appium\.java_client\.AppiumBy;/);
      if (lang === 'python') { assert.match(out!, /^import os$/m); assert.match(out!, /AppiumBy/); }
      if (lang === 'nodejs') assert.match(out!, /reloadSession\(\)/, 'every flow after the first starts a fresh session');
      if (lang === 'robot') { assert.match(out!, /Input Password {4}id=com\.acme\.bank:id\/pass {4}%\{APP_TEST_PASSWORD\}/, 'the password is never logged'); }
      // The raw template still holds its fill-in tokens ([Enter Instance here] …); substitute() fills them later.
      const high = detectFabricationIssues(out!).filter((i) => i.severity === 'high' && i.label !== 'placeholder credentials');
      assert.equal(high.length, 0, JSON.stringify(high));
    });
  }
  it('names test data variables from field labels', () => {
    assert.equal(dataEnv('Checking ($1,000.00)'), 'TEST_DATA_CHECKING');
    assert.equal(dataEnv('Check Amount'), 'TEST_DATA_CHECK_AMOUNT');
  });
});

describe('get_test_boilerplate with explorationJobId', () => {
  let client: Client;
  const dir = mkdtempSync(join(tmpdir(), 'dai-stage3-'));
  const saved = process.env.MCP_EXPLORATION_DIR;
  const loc = (v: string) => ({ using: 'xpath' as const, value: `//*[@text='${v}']` });
  const manifest = (accepted: string[]) => ({
    app: { platform: 'android', appId: 'com.acme.bank', activity: '.Main', version: '3.1' }, device: { name: 'Pixel', os: 'Android', version: '14' },
    startedAt: '', stoppedBecause: 'finished', taps: 5, notes: [],
    screens: [
      { signature: 'a', title: 'Sign in', foreground: null, path: [], elements: 5, assertable: [], navigation: [], notVisited: [], login: 'done', loginLocators: login },
      { signature: 'b', title: 'Home', foreground: null, path: [], elements: 20, assertable: [{ label: 'Balance', locator: loc('Balance') }], navigation: [], notVisited: [] },
      { signature: 'c', title: 'Transfer', foreground: null, path: [{ label: 'Transfer', locator: loc('Transfer') }], elements: 9, assertable: [{ label: 'Amount', locator: loc('Amount') }], navigation: [],
        notVisited: [{ label: 'Amount', kind: 'input', reason: '', locator: id('com.acme.bank:id/amount') }, { label: 'Send money', kind: 'action', reason: '', locator: loc('Send money') }] },
    ],
    acceptedFlows: accepted.map((a) => ({ id: a, title: a, acceptedAt: '' })),
  });
  beforeAll(async () => {
    process.env.MCP_EXPLORATION_DIR = dir;
    writeFileSync(join(dir, 'explore-bank1.json'), JSON.stringify(manifest(['login', 'open-transfer', 'submit-transfer'])));
    writeFileSync(join(dir, 'explore-none1.json'), JSON.stringify(manifest([])));
    resetClient('https://unreachable.invalid', 'aut_1_harness_key', 'harness');
    const server = new McpServer({ name: 'h', version: '0' });
    registerBoilerplateTools(server);
    client = new Client({ name: 'hc', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
  });
  afterAll(() => { if (saved === undefined) delete process.env.MCP_EXPLORATION_DIR; else process.env.MCP_EXPLORATION_DIR = saved; rmSync(dir, { recursive: true, force: true }); });
  const call = async (args: Record<string, unknown>) => (await client.callTool({ name: 'get_test_boilerplate', arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };

  it('writes one runnable test per accepted flow, with the report key and the test data named', async () => {
    const r = await call({ platform: 'android', language: 'python', explorationJobId: 'explore-bank1', outputFormat: 'json' });
    assert.notEqual(r.isError, true, r.content[0].text);
    const j = JSON.parse(r.content[0].text);
    assert.equal(j.runnable, true);
    assert.equal(j.requiresVerifiedSelectors, false);
    assert.equal(j.placeholderWarning, undefined);
    assert.deepEqual(j.exploration.tests.map((t: { flow: string }) => t.flow), ['login', 'open-transfer', 'submit-transfer']);
    assert.deepEqual(j.exploration.testData, ['APP_TEST_USER', 'APP_TEST_PASSWORD', 'TEST_DATA_AMOUNT']);
    const test = j.files.find((f: { filename: string; content: string }) => f.filename.endsWith('.py') && /def test_/.test(f.content)).content as string;
    assert.match(test, /digitalai:explorationRun/);
    assert.match(test, /explore-bank1/);
    assert.match(test, /com\.acme\.bank/, 'the app comes from the exploration');
    assert.equal((test.match(/def test_/g) ?? []).length, 3);
    assert.doesNotMatch(test, /ExperiBank|PLACEHOLDER TEST BODY/);
    assert.deepEqual(detectFabricationIssues(test).filter((i) => i.severity === 'high'), [], 'the finished file passes validate_test_script');
    const env = j.files.find((f: { filename: string }) => f.filename === '.env.example').content as string;
    for (const v of ['DIGITAL_AI_ACCESS_KEY=', 'APP_TEST_USER=', 'APP_TEST_PASSWORD=', 'TEST_DATA_AMOUNT=']) assert.match(env, new RegExp(`^${v}$`, 'm'), `${v} listed, empty`);
    assert.match(j.exploration.next, /already set in your shell[\s\S]*never choose test data/);
  });

  it('refuses flows nobody accepted, another app, a Grid project, and a run with no accepted flow', async () => {
    let r = await call({ platform: 'android', language: 'python', explorationJobId: 'explore-none1' });
    assert.match(r.content[0].text, /no flow of explore-none1 has been accepted/);
    r = await call({ platform: 'android', language: 'python', explorationJobId: 'explore-bank1', flows: ['open-home'] });
    assert.match(r.content[0].text, /only flows the user accepted/);
    r = await call({ platform: 'android', language: 'python', explorationJobId: 'explore-bank1', packageName: 'com.other.app' });
    assert.match(r.content[0].text, /the exploration is of com\.acme\.bank/);
    r = await call({ platform: 'ios', language: 'python', explorationJobId: 'explore-bank1' });
    assert.match(r.content[0].text, /android app, not ios/);
    account.isAppiumOss = false;
    try {
      r = await call({ platform: 'android', language: 'python', explorationJobId: 'explore-bank1' });
      assert.match(r.content[0].text, /Appium Server projects first/);
    } finally { account.isAppiumOss = true; }
  });
});
