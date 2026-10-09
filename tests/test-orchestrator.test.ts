/**
 * Test Orchestrator: pure generation helpers + agent source resolution / install / live download.
 * No .env and no live API — the "live download" path runs against a local HTTP server.
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decideOrchestration,
  resolveMaxRetryAttempts,
  buildConfigTemplate,
  addOrchestrationToGradle,
  addOrchestrationToMaven,
  DEFAULT_MAX_RETRY_ATTEMPTS,
  ORCHESTRATOR_GITIGNORE,
  LIB_GITIGNORE,
} from '../src/utils/test-orchestrator.js';
import {
  readAgentManifest,
  resolveAgentSource,
  loadAgentBytes,
  installAgentIntoProject,
  buildAgentDownloadCommands,
  sha256Hex,
} from '../src/api/test-orchestrator.js';

const ROOT = join(__dirname, '..');
const gradleTemplate = readFileSync(join(ROOT, 'resources/boilerplate/Android-Native/java TestNG/gradle-oss'), 'utf8');
const mavenTemplate = readFileSync(join(ROOT, 'resources/boilerplate/Android-Native/Java JUnit5/maven-oss'), 'utf8');

describe('decideOrchestration', () => {
  it('auto → ON only for Java on Appium Server', () => {
    for (const language of ['java-junit5', 'java-testng'] as const) {
      assert.equal(decideOrchestration({ mode: 'auto', language, isAppiumOss: true }).enabled, true);
      assert.equal(decideOrchestration({ mode: 'auto', language, isAppiumOss: false }).enabled, false);
    }
    for (const language of ['python', 'nodejs'] as const) {
      for (const isAppiumOss of [true, false]) {
        const d = decideOrchestration({ mode: 'auto', language, isAppiumOss });
        assert.equal(d.enabled, false);
        assert.equal(d.requestedButNotApplied, false, 'auto never flags a not-applied request');
      }
    }
  });

  it('off always disables, even where supported', () => {
    const d = decideOrchestration({ mode: 'off', language: 'java-testng', isAppiumOss: true });
    assert.equal(d.enabled, false);
    assert.match(d.reason, /off/);
  });

  it('on + unsupported → disabled AND flagged (never silently ignored)', () => {
    const grid = decideOrchestration({ mode: 'on', language: 'java-junit5', isAppiumOss: false });
    assert.deepEqual([grid.enabled, grid.requestedButNotApplied], [false, true]);
    assert.match(grid.reason, /Appium Grid/);
    const py = decideOrchestration({ mode: 'on', language: 'python', isAppiumOss: true });
    assert.deepEqual([py.enabled, py.requestedButNotApplied], [false, true]);
    assert.match(py.reason, /Python/);
  });

  it('unknown server mode (account lookup failed) is reported as such — never asserted to be Grid', () => {
    const d = decideOrchestration({ mode: 'on', language: 'java-testng', isAppiumOss: undefined });
    assert.equal(d.enabled, false);
    assert.equal(d.requestedButNotApplied, true);
    assert.match(d.reason, /could not be determined/);
    assert.doesNotMatch(d.reason, /runs on Appium Grid/);
  });
});

describe('resolveMaxRetryAttempts', () => {
  it('defaults to 2', () => {
    assert.equal(resolveMaxRetryAttempts({ placeholderBody: false, performanceTransactions: false }).value, DEFAULT_MAX_RETRY_ATTEMPTS);
  });
  it('is 0 for a placeholder body or performance runs, with a reason', () => {
    for (const o of [{ placeholderBody: true, performanceTransactions: false }, { placeholderBody: false, performanceTransactions: true }]) {
      const r = resolveMaxRetryAttempts(o);
      assert.equal(r.value, 0);
      assert.ok(r.note);
    }
  });
  it('an explicit request always wins', () => {
    assert.equal(resolveMaxRetryAttempts({ requested: 4, placeholderBody: true, performanceTransactions: true }).value, 4);
  });
});

describe('buildConfigTemplate', () => {
  it('normalises the hub URL and never contains a real key', () => {
    for (const instanceUrl of ['https://cloud.example.com', 'https://cloud.example.com/', 'https://cloud.example.com/wd/hub']) {
      const y = buildConfigTemplate({ instanceUrl, maxRetryAttempts: 2 });
      assert.match(y, /^ {2}url: https:\/\/cloud\.example\.com\/wd\/hub$/m);
      assert.match(y, /^ {2}accessKey: @DIGITAL_AI_ACCESS_KEY@$/m);
      assert.match(y, /^ {2}maxRetryAttempts: 2$/m);
    }
  });
  it('contains the substitution token EXACTLY once — filtering would otherwise copy the key into a comment too', () => {
    const y = buildConfigTemplate({ instanceUrl: 'https://x', maxRetryAttempts: 0 });
    assert.equal((y.match(/@DIGITAL_AI_ACCESS_KEY@/g) ?? []).length, 1);
    assert.doesNotMatch(y.split('\n').filter((l) => l.trimStart().startsWith('#')).join('\n'), /@DIGITAL_AI_ACCESS_KEY@/);
  });
  it('uses spaces only (YAML rejects tabs)', () => {
    assert.doesNotMatch(buildConfigTemplate({ instanceUrl: 'https://x', maxRetryAttempts: 0 }), /\t/);
  });
});

describe('addOrchestrationToGradle', () => {
  const out = addOrchestrationToGradle(gradleTemplate);
  it('keeps the original build and appends conditional agent wiring', () => {
    assert.ok(out.startsWith(gradleTemplate.trimEnd()));
    assert.match(out, /def orchestratorActive = orchestratorJar\.exists\(\) && orchestratorKey/);
    assert.match(out, /-javaagent:\$\{orchestratorJar\.absolutePath\}=\$\{file\('orchestrator\/rendered\/config\.yml'\)\.absolutePath\}/);
    assert.match(out, /-Dbuild\.id=\$\{System\.getenv\('BUILD_ID'\) \?: 'local'\}/);
    assert.match(out, /logger\.warn\("Digital\.ai Test Orchestrator NOT attached/);
  });
  it('raises the compile level to 17 ONLY when the agent is active (JDK 11 builds without the agent keep working)', () => {
    const idx17 = out.indexOf('JavaVersion.VERSION_17');
    const idxIf = out.indexOf('if (orchestratorActive) {');
    assert.ok(idxIf >= 0 && idx17 > idxIf, 'VERSION_17 must sit inside the if (orchestratorActive) block');
    const beforeIf = out.slice(0, idxIf);
    assert.doesNotMatch(beforeIf, /VERSION_17|sourceCompatibility/);
  });
  it('declares the (hashed) key as a task input so a rotated key re-renders the config', () => {
    assert.match(out, /inputs\.property\('orchestratorKeyFingerprint', \(orchestratorKey \?: ''\)\.digest\('SHA-256'\)\)/);
    assert.match(out, /ReplaceTokens, tokens: \[DIGITAL_AI_ACCESS_KEY:/);
  });
  it('renders into the git-ignored orchestrator/rendered directory and cleans it', () => {
    assert.match(out, /into 'orchestrator\/rendered'/);
    assert.match(out, /clean \{ delete 'orchestrator\/rendered' \}/);
  });
});

describe('addOrchestrationToMaven', () => {
  const out = addOrchestrationToMaven(mavenTemplate);
  it('leaves the base compile level alone and raises to 17 only inside the agent profile', () => {
    assert.match(out, /<source>11<\/source>\s*<target>11<\/target>/, 'base compiler config must be untouched');
    const profileStart = out.indexOf('<id>digitalai-test-orchestrator</id>');
    assert.ok(profileStart > 0);
    assert.equal(out.indexOf('<release>17</release>') > profileStart, true, 'release 17 must be inside the profile');
    assert.doesNotMatch(out.slice(0, profileStart), /<release>/);
  });
  it('adds AND-activated profiles (jar exists + env key) before </project>, plus a default Build ID', () => {
    assert.match(out, /<exists>\$\{basedir\}\/lib\/smart-agent\.jar<\/exists>/);
    assert.match(out, /<property><name>env\.DIGITAL_AI_ACCESS_KEY<\/name><\/property>/);
    assert.match(out, /<orchestrator\.buildId>local<\/orchestrator\.buildId>/);
    assert.match(out, /<\/profiles>\s*<\/project>\s*$/);
  });
  it('quotes the -javaagent token so project paths with spaces survive Surefire argLine splitting', () => {
    assert.match(out, /<argLine>"-javaagent:\$\{basedir\}\/lib\/smart-agent\.jar=\$\{basedir\}\/orchestrator\/rendered\/config\.template\.yml" -Dbuild\.id=\$\{orchestrator\.buildId\}<\/argLine>/);
  });
  it('renders the config into orchestrator/rendered (git-ignored), not target/', () => {
    assert.match(out, /<outputDirectory>\$\{basedir\}\/orchestrator\/rendered<\/outputDirectory>/);
  });
  it('keeps tags balanced', () => {
    for (const tag of ['project', 'build', 'plugins', 'plugin', 'profiles', 'profile', 'properties', 'dependencies', 'configuration']) {
      const open = (out.match(new RegExp(`<${tag}(\\s[^>]*)?>`, 'g')) ?? []).length;
      const close = (out.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
      assert.equal(open, close, `<${tag}> unbalanced`);
    }
  });
});

describe('scoped .gitignore files (no root .gitignore is ever generated)', () => {
  it('orchestrator/.gitignore hides the rendered key-bearing config; lib/.gitignore hides the JAR', () => {
    assert.match(ORCHESTRATOR_GITIGNORE, /^rendered\/$/m);
    assert.match(LIB_GITIGNORE, /^smart-agent\.jar$/m);
  });
});

describe('live download from a configured URL', () => {
  const payload = Buffer.from('fake-agent-bytes-for-test');
  let server: http.Server;
  let url: string;
  let hits = 0;

  beforeAll(async () => {
    server = http.createServer((_req, res) => { hits++; res.end(payload); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent.jar`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('downloads at request time, verifies the checksum, and caches per URL+checksum', async () => {
    const source = resolveAgentSource({ TEST_ORCHESTRATOR_JAR_URL: url, TEST_ORCHESTRATOR_JAR_SHA256: sha256Hex(payload) });
    const before = hits;
    assert.deepEqual(await loadAgentBytes(source), payload);
    assert.deepEqual(await loadAgentBytes(source), payload);
    assert.equal(hits - before, 1, 'second load should come from the cache');
  });

  it('refuses a download whose checksum does not match — and installs nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-bad-'));
    try {
      const source = resolveAgentSource({ TEST_ORCHESTRATOR_JAR_URL: url, TEST_ORCHESTRATOR_JAR_SHA256: '0'.repeat(64) });
      await assert.rejects(() => installAgentIntoProject(dir, source), /checksum verification/);
      assert.equal(existsSync(join(dir, 'lib', 'smart-agent.jar')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('agent source resolution (no network)', () => {
  const manifest = readAgentManifest();

  it('the JAR is NOT shipped — only the pinned manifest is', () => {
    const dir = join(ROOT, 'resources', 'test-orchestrator');
    assert.ok(existsSync(join(dir, 'agent.json')));
    assert.equal(existsSync(join(dir, 'smart-agent-1.0-SNAPSHOT.jar')), false);
  });

  it('defaults to the pinned sample-repo download: immutable commit URL + 64-hex checksum', () => {
    const s = resolveAgentSource({});
    assert.equal(s.kind, 'pinned');
    assert.match(manifest.source.commit, /^[0-9a-f]{40}$/, 'must pin a full commit SHA, never a branch');
    assert.ok(s.downloadUrl.includes(`/${manifest.source.commit}/`), 'URL must reference the pinned commit');
    assert.doesNotMatch(s.downloadUrl, /\/(main|master|HEAD)\//);
    assert.match(s.sha256, /^[0-9a-f]{64}$/);
    assert.equal(s.homepage, manifest.source.repository);
    assert.match(s.label, new RegExp(manifest.source.commit.slice(0, 12)));
  });

  it('TEST_ORCHESTRATOR_JAR_URL (permanent location) takes precedence when a checksum accompanies it', () => {
    const sha = 'a'.repeat(64);
    const s = resolveAgentSource({ TEST_ORCHESTRATOR_JAR_URL: 'https://example.com/agent.jar', TEST_ORCHESTRATOR_JAR_SHA256: sha.toUpperCase() });
    assert.deepEqual([s.kind, s.downloadUrl, s.sha256], ['url', 'https://example.com/agent.jar', sha]);
  });

  it('a URL WITHOUT a valid checksum is refused — the tool never promises verification it cannot do', () => {
    assert.throws(() => resolveAgentSource({ TEST_ORCHESTRATOR_JAR_URL: 'https://example.com/agent.jar' }), /TEST_ORCHESTRATOR_JAR_SHA256/);
    assert.throws(() => resolveAgentSource({ TEST_ORCHESTRATOR_JAR_URL: 'https://example.com/agent.jar', TEST_ORCHESTRATOR_JAR_SHA256: 'abc' }), /64-hex/);
  });

  it('download commands verify the checksum AND remove the file on a mismatch (bash + PowerShell)', () => {
    const c = buildAgentDownloadCommands(resolveAgentSource({}));
    assert.match(c.bash, new RegExp(`${manifest.sha256}  lib/smart-agent\\.jar`));
    assert.ok(c.bash.includes(manifest.source.downloadUrl));
    assert.match(c.bash, /sha256sum -c -/);
    assert.match(c.bash, /shasum -a 256 -c -/);
    assert.match(c.bash, /\|\| \{ rm -f lib\/smart-agent\.jar;.*false; \}$/);
    assert.doesNotMatch(c.bash, /\bexit\b/, 'must not exit the user\'s interactive shell');
    assert.match(c.powershell, /Get-FileHash lib\\smart-agent\.jar -Algorithm SHA256/);
    assert.match(c.powershell, /Remove-Item lib\\smart-agent\.jar/);
    assert.match(c.powershell, new RegExp(manifest.sha256));
  });
});

describe('download + install (local HTTP server stands in for the download location)', () => {
  const payload = Buffer.from('fake-agent-bytes-for-install-tests');
  let server: http.Server;
  let url: string;
  const deadUrl = 'http://127.0.0.1:1/agent.jar';

  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end(payload));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/install/agent.jar`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const src = () => resolveAgentSource({ TEST_ORCHESTRATOR_JAR_URL: url, TEST_ORCHESTRATOR_JAR_SHA256: sha256Hex(payload) });

  it('installs into <projectDir>/lib/smart-agent.jar, reports replacement and whether a build file was found', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-install-'));
    try {
      const first = await installAgentIntoProject(dir, src());
      assert.equal(first.replaced, false);
      assert.equal(first.buildFileFound, false);
      assert.deepEqual(readFileSync(join(dir, 'lib', 'smart-agent.jar')), payload);
      writeFileSync(join(dir, 'pom.xml'), '<project/>');
      const second = await installAgentIntoProject(dir, src());
      assert.equal(second.replaced, true);
      assert.equal(second.buildFileFound, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a projectDir that does not exist instead of silently creating an empty tree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-missing-'));
    try {
      const missing = join(dir, 'e2e-test'); // typo for e2e-tests
      await assert.rejects(() => installAgentIntoProject(missing, src()), /does not exist/);
      assert.equal(existsSync(join(missing, 'lib')), false);
      mkdirSync(missing);
      await installAgentIntoProject(missing, src()); // exists now → fine
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unreachable download location fails with manual-install instructions (URL, checksum, target path) and writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-offline-'));
    try {
      const sha = sha256Hex(payload);
      const offline = resolveAgentSource({ TEST_ORCHESTRATOR_JAR_URL: deadUrl, TEST_ORCHESTRATOR_JAR_SHA256: sha });
      await assert.rejects(
        () => installAgentIntoProject(dir, offline),
        (e: Error) => e.message.includes('Could not download') && e.message.includes(deadUrl) && e.message.includes(sha) && e.message.includes('lib/smart-agent.jar')
      );
      assert.equal(existsSync(join(dir, 'lib', 'smart-agent.jar')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
