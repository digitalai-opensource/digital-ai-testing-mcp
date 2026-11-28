/**
 * App exploration, stage 3 (2.6.0): test steps for the flows the USER accepted, written into the framework structure of a
 * boilerplate template. Pure: a template, the flows (with the locators the exploration verified) in; the template with one
 * test per flow out. Each test starts from a fresh session (Java/Python/Robot open one per test; Node reloads it), so a
 * flow never depends on another. No step is invented: every locator comes from the exploration, every value a test types
 * comes from an environment variable named in the answer (never written into the file).
 */
import type { Locator } from './app-exploration.js';

export type CodegenLanguage = 'java-junit5' | 'java-testng' | 'python' | 'nodejs' | 'robot';

export interface FlowStep { label: string; locator: Locator }
export interface CodegenFlow {
  id: string;
  title: string;
  kind: 'login' | 'navigate' | 'form' | 'destructive';
  /** Taps from the start screen (after the login, when the app has one). */
  steps: FlowStep[];
  /** Element on the final screen that must be visible. */
  check?: FlowStep;
  /** Form fields, typed from environment variables. */
  fields?: FlowStep[];
  /** Drop-downs: an option is picked only when TEST_DATA_<FIELD> is set (its text); otherwise the value shown stays. */
  choices?: FlowStep[];
  /** The submit (form) or destructive control. */
  action?: FlowStep;
}
export interface CodegenLogin { user: Locator; password: Locator; submit?: Locator }
export interface CodegenInput {
  language: CodegenLanguage;
  flows: CodegenFlow[];
  /** The app's login, done at the start of every test when the exploration logged in. */
  login?: CodegenLogin;
  /** Wraps one test body (reporting, steps group …), as the template's own decoration does. */
  decorate?: (body: string, indent: string) => string;
}

export const LOGIN_USER_ENV = 'APP_TEST_USER';
export const LOGIN_PASSWORD_ENV = 'APP_TEST_PASSWORD';

/** Environment variable for a form field's test data: TEST_DATA_<FIELD>. */
export function dataEnv(label: string): string {
  const base = label.replace(/\$?[\d.,]+/g, ' ').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase().slice(0, 40);
  return `TEST_DATA_${base || 'FIELD'}`;
}

const jstr = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const pystr = jstr;
const jsstr = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function javaBy(l: Locator): string {
  if (l.using === 'id') return `By.id(${jstr(l.value)})`;
  if (l.using === 'accessibility id') return `AppiumBy.accessibilityId(${jstr(l.value)})`;
  return `By.xpath(${jstr(l.value)})`;
}
function pyBy(l: Locator): string {
  if (l.using === 'id') return `By.ID, ${pystr(l.value)}`;
  if (l.using === 'accessibility id') return `AppiumBy.ACCESSIBILITY_ID, ${pystr(l.value)}`;
  return `By.XPATH, ${pystr(l.value)}`;
}
function jsSel(l: Locator): string {
  if (l.using === 'id') return jsstr(`id=${l.value}`);
  if (l.using === 'accessibility id') return jsstr(`~${l.value}`);
  return jsstr(l.value);
}
function robotLoc(l: Locator): string {
  const v = l.value.replace(/ {2,}/g, ' ');
  if (l.using === 'id') return `id=${v}`;
  if (l.using === 'accessibility id') return `accessibility_id=${v}`;
  return `xpath=${v}`;
}

type Op = { kind: 'tap' | 'check'; at: Locator; note: string } | { kind: 'type' | 'choose'; at: Locator; env: string; note: string };

/** The operations of one test, in order: login, the route, the form, the check. */
export function flowOps(f: CodegenFlow, login?: CodegenLogin): Op[] {
  const ops: Op[] = [];
  // No "bring the app to the front" step: on a phone that opens sessions on its launcher (Galaxy S21 Ultra DE0058) the
  // app WAS in front once and activate_app sent it to the launcher and a wallpaper app (2026-11-28); no phone showed a gain.
  if (login) {
    ops.push({ kind: 'type', at: login.user, env: LOGIN_USER_ENV, note: 'log in (user name)' });
    ops.push({ kind: 'type', at: login.password, env: LOGIN_PASSWORD_ENV, note: 'log in (password)' });
    if (login.submit) ops.push({ kind: 'tap', at: login.submit, note: 'log in' });
  }
  for (const s of f.steps) ops.push({ kind: 'tap', at: s.locator, note: s.label });
  for (const fld of f.fields ?? []) ops.push({ kind: 'type', at: fld.locator, env: dataEnv(fld.label), note: fld.label });
  for (const c of f.choices ?? []) ops.push({ kind: 'choose', at: c.locator, env: dataEnv(c.label), note: `${c.label} (drop-down)` });
  if (f.action) ops.push({ kind: 'tap', at: f.action.locator, note: f.action.label });
  if (f.check) ops.push({ kind: 'check', at: f.check.locator, note: f.check.label });
  return ops;
}

/**
 * WebdriverIO: a new session for the next flow. The cloud answers a session request with the device agent's own address
 * (direct connect) and wdio then sends every request there, including the new-session request of reloadSession, which
 * the agent refuses ("Bad Request", verified live 2026-11-28). Point wdio back at the hub from wdio.conf.js first.
 */
const FRESH_SESSION = [
  '// A fresh session for each flow after the first, created through the hub in wdio.conf.js (the running session talks',
  '// to the device agent directly, and an agent does not create sessions).',
  'async function freshSession() {',
  "  const { config } = require('../../wdio.conf.js');",
  '  Object.assign(browser.options, { protocol: config.protocol, hostname: config.hostname, port: config.port, path: config.path });',
  '  await browser.reloadSession();',
  '}',
].join('\n');

/** The option of an open drop-down, by its text (Android) or label (iOS); %s = the value. */
const OPTION_XPATH = '//*[@text="%s" or @label="%s"]';

const clip = (s: string) => s.replace(/\s+/g, ' ').replace(/\*\//g, '').slice(0, 70);

function body(lang: CodegenLanguage, ops: Op[], indent: string, f: CodegenFlow): string {
  const c = lang === 'python' || lang === 'robot' ? '#' : '//';
  const out: string[] = [`${indent}${c} Flow "${clip(f.title)}" from the app exploration: every locator was verified on the app.`];
  if (f.kind === 'form') out.push(`${indent}${c} The exploration never submitted this form: confirm the expected result with the user and assert it after the last step.`);
  if (f.kind === 'destructive') out.push(`${indent}${c} Destructive action, accepted by the user: run it only with a test account.`);
  // The flow id as a report column (explorationFlow), so each run is matched to its flow afterwards.
  if (lang === 'java-junit5' || lang === 'java-testng') out.push(`${indent}driver.executeScript("seetest:client.addTestProperty", "explorationFlow", ${jstr(f.id)});`);
  else if (lang === 'python') out.push(`${indent}self.driver.execute_script("seetest:client.addTestProperty", "explorationFlow", ${pystr(f.id)})`);
  else if (lang === 'nodejs') out.push(`${indent}await browser.execute('seetest:client.addTestProperty', 'explorationFlow', ${jsstr(f.id)});`);
  else out.push(`${indent}Add Test Property    explorationFlow    ${f.id}`);
  for (const op of ops) {
    const note = clip(op.note);
    switch (lang) {
      case 'java-junit5':
      case 'java-testng':
        if (op.kind === 'tap') out.push(`${indent}find(${javaBy(op.at)}).click(); // ${note}`);
        else if (op.kind === 'type') out.push(`${indent}find(${javaBy(op.at)}).sendKeys(java.util.Objects.requireNonNull(System.getenv(${jstr(op.env)}), ${jstr(`Set ${op.env} (test data; never written into the test)`)})); // ${note}`);
        else if (op.kind === 'choose') out.push(
          `${indent}if (System.getenv(${jstr(op.env)}) != null) { // ${note}: pick the option named in ${op.env}, else keep the value shown`,
          `${indent}    find(${javaBy(op.at)}).click();`,
          `${indent}    find(By.xpath(${jstr(OPTION_XPATH)}.replace("%s", System.getenv(${jstr(op.env)})))).click();`,
          `${indent}}`);
        else out.push(`${indent}find(${javaBy(op.at)}); // ${note} is shown (waits until visible)`);
        break;
      case 'python':
        if (op.kind === 'tap') out.push(`${indent}self.find(${pyBy(op.at)}).click()  # ${note}`);
        else if (op.kind === 'type') out.push(`${indent}self.find(${pyBy(op.at)}).send_keys(os.environ[${pystr(op.env)}])  # ${note}`);
        else if (op.kind === 'choose') out.push(
          `${indent}if os.environ.get(${pystr(op.env)}):  # ${note}: pick the option named in ${op.env}, else keep the value shown`,
          `${indent}    self.find(${pyBy(op.at)}).click()`,
          `${indent}    self.find(By.XPATH, ${pystr(OPTION_XPATH)}.replace("%s", os.environ[${pystr(op.env)}])).click()`);
        else out.push(`${indent}self.find(${pyBy(op.at)})  # ${note} is shown (waits until visible)`);
        break;
      case 'nodejs':
        if (op.kind === 'tap') out.push(`${indent}await (await find(${jsSel(op.at)})).click(); // ${note}`);
        else if (op.kind === 'type') out.push(`${indent}await (await find(${jsSel(op.at)})).setValue(testData(${jsstr(op.env)})); // ${note}`);
        else if (op.kind === 'choose') out.push(
          `${indent}if (process.env[${jsstr(op.env)}]) { // ${note}: pick the option named in ${op.env}, else keep the value shown`,
          `${indent}  await (await find(${jsSel(op.at)})).click();`,
          `${indent}  await (await find(${jsstr(OPTION_XPATH)}.replaceAll('%s', process.env[${jsstr(op.env)}]))).click();`,
          `${indent}}`);
        else out.push(`${indent}await find(${jsSel(op.at)}); // ${note} is shown (waits until displayed)`);
        break;
      case 'robot':
        if (op.kind === 'tap') out.push(`${indent}Wait And Click    ${robotLoc(op.at)}`);
        // Input Text writes the text into log.html; the password goes through Input Password, which does not.
        else if (op.kind === 'type' && op.env === LOGIN_PASSWORD_ENV) out.push(`${indent}Wait Until Element Is Visible    ${robotLoc(op.at)}    20s`, `${indent}Input Password    ${robotLoc(op.at)}    %{${op.env}}`);
        else if (op.kind === 'type') out.push(`${indent}Wait And Input    ${robotLoc(op.at)}    %{${op.env}}`);
        else if (op.kind === 'choose') out.push(
          `${indent}# ${note}: pick the option named in ${op.env}, else keep the value shown`,
          `${indent}IF    os.environ.get('${op.env}')`,
          `${indent}    Wait And Click    ${robotLoc(op.at)}`,
          `${indent}    Wait And Click    xpath=${OPTION_XPATH.split('%s').join(`%{${op.env}}`)}`,
          `${indent}END`);
        else out.push(`${indent}Wait Until Element Is Visible    ${robotLoc(op.at)}    20s`);
        break;
    }
  }
  return out.join('\n');
}

function methodName(lang: CodegenLanguage, title: string, used: Set<string>): string {
  const words = title.replace(/\(.*?\)/g, ' ').split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 8);
  let name: string;
  if (lang === 'python') name = 'test_' + (words.length ? words.map((w) => w.toLowerCase()).join('_') : 'flow');
  else if (lang === 'robot' || lang === 'nodejs') name = words.join(' ') || 'Flow';
  else {
    const camel = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('') || 'flow';
    name = /^[0-9]/.test(camel) ? `flow${camel}` : camel;
  }
  let n = name;
  for (let i = 2; used.has(n); i++) n = lang === 'robot' || lang === 'nodejs' ? `${name} ${i}` : `${name}${i}`;
  used.add(n);
  return n;
}

/** Variables a generated test reads: the login and each form field. */
export function envVarsFor(flows: CodegenFlow[], login?: CodegenLogin): string[] {
  const names = new Set<string>();
  if (login) { names.add(LOGIN_USER_ENV); names.add(LOGIN_PASSWORD_ENV); }
  for (const f of flows) for (const fld of f.fields ?? []) names.add(dataEnv(fld.label));
  return [...names];
}

/** Optional variables: a drop-down keeps the value it shows unless its variable names an option. */
export function optionalEnvVarsFor(flows: CodegenFlow[]): string[] {
  return [...new Set(flows.flatMap((f) => (f.choices ?? []).map((c) => dataEnv(c.label))))];
}

/**
 * Replaces the template's single placeholder test with one test per flow. Returns null when the template does not have
 * the expected shape (the caller then refuses rather than writing half a file).
 */
export function renderFlowTests(template: string, input: CodegenInput): string | null {
  const { language, flows, login } = input;
  if (!flows.length) return null;
  const decorate = input.decorate ?? ((b: string) => b);
  const used = new Set<string>();
  let out = template;
  if (language === 'java-junit5' || language === 'java-testng') {
    const re = /([^\S\n]*)@Test\n[^\S\n]*public void \[TEST_METHOD\]\(\)[^{\n]*\{\n[\s\S]*?\[END_DEMO_STEPS\]\n[^\S\n]*\}\n/;
    const m = re.exec(out);
    if (!m) return null;
    const ind = m[1];
    const methods = flows.map((f) => `${ind}@Test\n${ind}public void ${methodName(language, f.title, used)}() {\n${decorate(body(language, flowOps(f, login), ind + '    ', f), ind + '    ')}\n${ind}}\n`).join('\n');
    out = out.replace(re, () => methods);
    if (/AppiumBy\./.test(methods) && !/import io\.appium\.java_client\.AppiumBy;/.test(out)) out = `import io.appium.java_client.AppiumBy;\n${out}`;
    return out;
  }
  if (language === 'python') {
    const re = /([^\S\n]*)def \[TEST_METHOD\]\(self\):\n[\s\S]*?\[END_DEMO_STEPS\]\n/;
    const m = re.exec(out);
    if (!m) return null;
    const ind = m[1];
    const methods = flows.map((f) => `${ind}def ${methodName(language, f.title, used)}(self):\n${decorate(body(language, flowOps(f, login), ind + '    ', f), ind + '    ')}\n`).join('\n');
    out = out.replace(re, () => methods);
    if (/AppiumBy\./.test(methods) && !/from appium\.webdriver\.common\.appiumby import AppiumBy/.test(out)) out = out.replace(/^(from appium import webdriver\n)/m, '$1from appium.webdriver.common.appiumby import AppiumBy\n');
    if (/os\.environ/.test(methods) && !/^import os$/m.test(out)) out = `import os\n${out}`;
    return out;
  }
  if (language === 'nodejs') {
    const itRe = /it\('\[(?:TEST_METHOD|testNameHere)\]', myTest\)/;
    const fnRe = /([^\S\n]*)async function myTest\(\) \{\n[\s\S]*?\[END_DEMO_STEPS\]\n[^\S\n]*\}/;
    const m = fnRe.exec(out);
    if (!itRe.test(out) || !m) return null;
    const ind = m[1];
    const names = flows.map((f) => methodName(language, f.title, used));
    const its = names.map((n, i) => `it(${jsstr(n)}, flow${i + 1})`).join('\n    ');
    const helper = `${ind}// Test data from the environment, never written into the test.\n${ind}function testData(name) {\n${ind}  const v = process.env[name];\n${ind}  if (!v) throw new Error(\`Set \${name} (test data; never written into the test)\`);\n${ind}  return v;\n${ind}}\n`
      + (flows.length > 1 ? FRESH_SESSION.split('\n').map((l) => `${ind}${l}`).join('\n') + '\n' : '');
    const fns = flows.map((f, i) => {
      // One session per spec file in wdio: every flow after the first starts a fresh session (fresh install, start screen).
      const reload = i ? `${ind}  await freshSession(); // a fresh session: this flow starts from the app's start screen\n` : '';
      return `${ind}async function flow${i + 1}() {\n${reload}${decorate(body(language, flowOps(f, login), ind + '  ', f), ind + '  ')}\n${ind}}`;
    }).join('\n');
    out = out.replace(itRe, () => its).replace(fnRe, () => `${helper}${fns}`);
    return out;
  }
  if (language === 'robot') {
    const re = /\[TEST_METHOD\]\n[\s\S]*?\[END_DEMO_STEPS\]\n(?:[^\S\n]*Stop Steps Group\n)?/;
    if (!re.test(out)) return null;
    const cases = flows.map((f) => `${methodName(language, f.title, used)}\n    Start Steps Group    ${clip(f.title)}\n${decorate(body(language, flowOps(f, login), '    ', f), '    ')}\n    Stop Steps Group\n`).join('\n');
    return out.replace(re, () => cases);
  }
  return null;
}
