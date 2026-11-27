import { describe, it, beforeEach, afterEach, assert } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { analyseFiles, analyseProject, decideFramework, setFrameworkContext, choiceStorePath, MOBILE_LANGUAGES, WEB_LANGUAGES, type FrameworkLanguage } from '../src/utils/framework-choice.js';

// The user chooses the framework, once per project (owner decision 2026-11-27). vitest runs with
// MCP_FRAMEWORK_CHOICE=trust-caller for every other suite; these tests turn it off.

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'fw-proj-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

describe('analyseFiles / analyseProject: what the workspace already holds', () => {
  it('a Maven project with JUnit 5 tests recommends adding to that framework', () => {
    const root = project({ 'pom.xml': '<dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId></dependency>', 'src/test/java/LoginTest.java': 'class X {}' });
    const a = analyseProject([pathToFileURL(root).href]);
    assert.equal(a.root, root);
    assert.deepEqual(a.stacks, ['Java/Kotlin']);
    assert.deepEqual(a.testFrameworks.map((f) => f.language), ['java-junit5']);
    assert.equal(a.recommendation, 'java-junit5');
    assert.match(a.reason, /already has Java \+ JUnit 5 tests \(pom\.xml\)/);
    rmSync(root, { recursive: true, force: true });
  });

  it('WebdriverIO, pytest, Robot and Playwright are recognised; node_modules is never read', () => {
    const root = project({
      'package.json': '{"devDependencies":{"@wdio/cli":"9.0.0","@playwright/test":"1.65.0"}}',
      'requirements.txt': 'Appium-Python-Client==6.0\nrobotframework==7.5',
      'node_modules/x/package.json': '{"dependencies":{"testng":"1"}}',
      'suite/login.robot': '*** Test Cases ***',
    });
    const langs = analyseProject([pathToFileURL(root).href]).testFrameworks.map((f) => f.language).sort();
    assert.deepEqual(langs, ['nodejs', 'playwright', 'python', 'robot']);
    rmSync(root, { recursive: true, force: true });
  });

  it('a project with no test framework gets a recommendation from its build language, or none', () => {
    assert.equal(analyseFiles('/p', ['/p/build.gradle'], () => 'implementation "androidx.core:core:1.0"').recommendation, 'java-junit5');
    assert.equal(analyseFiles('/p', ['/p/pyproject.toml'], () => '[project]').recommendation, 'python');
    const swift = analyseFiles('/p', ['/p/Package.swift'], () => '');
    assert.equal(swift.recommendation, undefined);
    assert.match(swift.reason, /no template exists here: the user should pick/);
  });

  it('no readable workspace (Claude Desktop, Docker): nothing is read and the reason says to ask', () => {
    const a = analyseProject([]);
    assert.equal(a.root, undefined);
    assert.match(a.reason, /ask the user what the project is built with/);
  });
});

describe('decideFramework: the user decides, once per project', () => {
  let store: string;
  let saved: string | undefined;
  let asked: Array<{ message: string; options: FrameworkLanguage[]; recommended?: FrameworkLanguage }>;
  let answer: FrameworkLanguage | 'declined' | undefined;
  let canAsk: boolean;
  let roots: string[];
  beforeEach(() => {
    saved = process.env.MCP_FRAMEWORK_CHOICE;
    delete process.env.MCP_FRAMEWORK_CHOICE;
    store = mkdtempSync(join(tmpdir(), 'fw-store-'));
    process.env.MCP_FRAMEWORK_CHOICE_DIR = store;
    asked = []; answer = undefined; canAsk = false; roots = [];
    setFrameworkContext({
      roots: async () => roots,
      canAsk: () => canAsk,
      ask: async (message, options, recommended) => { asked.push({ message, options, recommended }); return answer; },
      cloudProject: async () => 'cloud.example/Team A',
    });
  });
  afterEach(() => {
    setFrameworkContext(null);
    if (saved === undefined) delete process.env.MCP_FRAMEWORK_CHOICE; else process.env.MCP_FRAMEWORK_CHOICE = saved;
    delete process.env.MCP_FRAMEWORK_CHOICE_DIR;
    rmSync(store, { recursive: true, force: true });
  });
  const decide = (a: Partial<Parameters<typeof decideFramework>[0]> = {}) =>
    decideFramework({ kind: 'mobile', options: MOBILE_LANGUAGES, tool: 'get_test_boilerplate', ...a });

  it('a language the agent picked is not enough: no code, the analysis, and "ask the user"', async () => {
    const d = await decide({ requested: 'python' });
    assert.equal(d.ok, false);
    if (d.ok) return;
    assert.equal(d.answer.status, 'choose_framework');
    assert.match(d.text, /ASK THE USER which one to use \(do not choose for them\)/);
    assert.match(d.text, /confirmedByUser: true/);
    assert.equal(existsSync(choiceStorePath()), false, 'nothing is saved');
  });

  it('the user\'s confirmed choice is saved for the project and reused without asking', async () => {
    const first = await decide({ requested: 'java-testng', confirmedByUser: true });
    assert.equal(first.ok && first.language, 'java-testng');
    const stored = JSON.parse(readFileSync(choiceStorePath(), 'utf-8'));
    assert.equal(stored.projects['cloud:cloud.example/Team A'].mobile.language, 'java-testng');
    const later = await decide({});
    assert.equal(later.ok && later.language, 'java-testng');
    assert.match(later.ok ? later.note : '', /the user chose it for cloud project cloud\.example\/Team A/);
    const other = await decide({ requested: 'python' });
    assert.equal(other.ok, false, 'another language needs the user again');
    const web = await decideFramework({ kind: 'web', options: WEB_LANGUAGES, tool: 'get_web_test_boilerplate' });
    assert.equal(web.ok, false, 'web tests are chosen separately');
  });

  it('a client that supports it asks the USER directly (elicitation); a decline generates nothing', async () => {
    const root = project({ 'pom.xml': 'junit-jupiter' });
    roots = [pathToFileURL(root).href];
    canAsk = true; answer = 'java-junit5';
    const d = await decide({ requested: 'python' });
    assert.equal(d.ok && d.language, 'java-junit5', 'the user\'s answer wins over what the agent asked for');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].recommended, 'python');
    assert.match(asked[0].message, /already has Java \+ JUnit 5 tests/);
    assert.equal(d.ok && d.addToExisting, true, 'the project has that framework: add to it');
    rmSync(join(store, 'test-frameworks.json'));
    answer = 'declined';
    const no = await decide({});
    assert.equal(no.ok, false);
    if (!no.ok) assert.equal(no.answer.status, 'framework_not_chosen');
    rmSync(root, { recursive: true, force: true });
  });

  it('never a second framework next to an existing one unless the user asks for it', async () => {
    const root = project({ 'package.json': '{"devDependencies":{"webdriverio":"9"}}', 'wdio.conf.js': '' });
    roots = [pathToFileURL(root).href];
    const d = await decide({ requested: 'python', confirmedByUser: true });
    assert.equal(d.ok, false);
    if (!d.ok) {
      assert.equal(d.answer.status, 'second_framework');
      assert.match(d.text, /would add a SECOND test framework/);
    }
    assert.equal(existsSync(choiceStorePath()), false, 'a refused choice is not saved');
    const yes = await decide({ requested: 'python', confirmedByUser: true, newFramework: true });
    assert.equal(yes.ok && yes.language, 'python');
    assert.equal(yes.ok && yes.addToExisting, false);
    rmSync(root, { recursive: true, force: true });
  });

  it('trust-caller (CI, no user present) uses the language passed and still never picks one', async () => {
    process.env.MCP_FRAMEWORK_CHOICE = 'trust-caller';
    const d = await decide({ requested: 'robot' });
    assert.equal(d.ok && d.language, 'robot');
    const none = await decide({});
    assert.equal(none.ok, false);
  });
});
