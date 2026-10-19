/**
 * Static checks on the Java boilerplate templates and the Gradle project-type adapter.
 *
 * Each case pins a bug that shipped in generated projects and was confirmed by actually building them:
 *  - every standalone Gradle build failed: "Cannot resolve external dependency … no repositories are defined";
 *  - with repositories fixed, JUnit 5 Gradle builds reported BUILD SUCCESSFUL while running ZERO tests,
 *    because `test { useJUnitPlatform() }` was missing;
 *  - TestNG templates used @BeforeTest/@AfterTest (one driver per suite <test> block) instead of one
 *    session per test method.
 * Pure file reads — no network, no .env.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { adaptGradleForProjectType } from '../src/tools/boilerplate-tools.js';

const ROOT = join(__dirname, '..', 'resources', 'boilerplate');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const all = walk(ROOT);
const rel = (p: string) => p.slice(ROOT.length + 1).replace(/\\/g, '/');
const javaDirs = (re: RegExp) => all.filter((p) => re.test(rel(p)));

const gradleFiles = javaDirs(/\/[^/]*(junit5|testng)[^/]*\/gradle(-oss)?$/i);
const junit5Gradle = gradleFiles.filter((p) => /junit5/i.test(rel(p)));
const testngJava = javaDirs(/testng[^/]*\/[^/]+\.java$/i);

describe('Java Gradle templates', () => {
  it('found all 8 Gradle templates (Grid + Appium Server × JUnit5/TestNG × Android/iOS)', () => {
    assert.equal(gradleFiles.length, 8, gradleFiles.map(rel).join(', '));
  });

  for (const f of gradleFiles) {
    it(`${rel(f)} declares an ACTIVE mavenCentral repository`, () => {
      assert.match(readFileSync(f, 'utf8'), /^repositories \{ mavenCentral\(\) \}/m);
    });
  }

  for (const f of junit5Gradle) {
    it(`${rel(f)} runs tests on the JUnit Platform`, () => {
      assert.match(readFileSync(f, 'utf8'), /test\s*\{\s*useJUnitPlatform\(\)\s*\}/);
    });
  }
});

describe('TestNG templates use one session per test method', () => {
  it('found all 4 TestNG templates', () => {
    assert.equal(testngJava.length, 4, testngJava.map(rel).join(', '));
  });
  for (const f of testngJava) {
    it(`${rel(f)} uses @BeforeMethod/@AfterMethod, never @BeforeTest/@AfterTest`, () => {
      const s = readFileSync(f, 'utf8');
      assert.match(s, /@BeforeMethod/);
      assert.match(s, /@AfterMethod/);
      assert.doesNotMatch(s, /@(Before|After)Test\b/);
    });
  }
});

describe('WebdriverIO configs (Appium Server AND Grid)', () => {
  // Found live 2026-10-16: wdio 9 refuses to start a session when a capability is neither W3C-standard nor
  // vendor-prefixed — the Android config's bare autoDismissAlerts / autoGrantPermissions failed every run.
  // 2026-10-17: wdio 7.40 (the Grid pin) rejects them the same way ("Invalid or unsupported WebDriver capabilities"),
  // so the Grid configs are held to the same rule.
  const W3C = new Set(['platformName', 'browserName', 'browserVersion', 'acceptInsecureCerts', 'pageLoadStrategy', 'proxy', 'setWindowRect', 'timeouts', 'strictFileInteractability', 'unhandledPromptBehavior']);
  const confs = all.filter((p) => /wdio(-oss)?\.conf\.js$/.test(p));

  it('found all four wdio configs', () => {
    assert.equal(confs.length, 4, confs.map(rel).join(', '));
  });

  it('every capability is W3C-standard or vendor-prefixed', () => {
    for (const p of confs) {
      const caps = readFileSync(p, 'utf-8').match(/capabilities:\s*\[\{([\s\S]*?)\}\]/)![1];
      const keys = [...caps.matchAll(/^\s*'?([\w:.-]+)'?\s*:/gm)].map((m) => m[1]);
      assert.ok(keys.length > 3, rel(p));
      for (const k of keys) assert.ok(W3C.has(k) || k.includes(':'), `${rel(p)}: unprefixed capability "${k}"`);
    }
  });
});

describe('adaptGradleForProjectType', () => {
  const sample = readFileSync(junit5Gradle[0], 'utf8');

  it('keeps the repository for standalone projects (default and explicit)', () => {
    assert.equal(adaptGradleForProjectType(sample), sample);
    assert.equal(adaptGradleForProjectType(sample, 'standalone-gradle'), sample);
  });

  it('strips the module-level repository for android-gradle-submodule, leaving the rest intact', () => {
    const out = adaptGradleForProjectType(sample, 'android-gradle-submodule');
    assert.doesNotMatch(out, /repositories/);
    assert.doesNotMatch(out, /Standalone use only/);
    assert.match(out, /useJUnitPlatform\(\)/);
    assert.match(out, /java-client/);
  });

  it('handles CRLF templates', () => {
    const out = adaptGradleForProjectType(sample.replace(/\n/g, '\r\n'), 'android-gradle-submodule');
    assert.doesNotMatch(out, /repositories/);
  });
});

describe('Python and Node template fixes (2026-10-17)', () => {
  const PY = walk(ROOT).filter((p) => p.endsWith('.py') && !p.endsWith('Report.py'));

  it('every Python tearDown is guarded — a failed setUp must not be masked by quit()', () => {
    assert.ok(PY.length >= 4, `expected the four Python templates, found ${PY.length}`);
    for (const p of PY) {
      const src = readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');
      assert.match(src, /def tearDown\(self\):\n(?:.*\n)*?\s+if self\.driver is None:\n\s+return/, `${p}: tearDown lacks the None guard`);
      assert.match(src, /try:\n\s+self\.driver\.quit\(\)\n\s+finally:\n\s+self\.driver = None/, `${p}: quit() is not in try/finally`);
    }
  });

  it('wdio configs pass the mobile: shell object as ONE execute argument and wait long enough for a native app', () => {
    const confs = walk(ROOT).filter((p) => /wdio(-oss)?\.conf\.js$/.test(p));
    assert.ok(confs.length >= 4);
    for (const p of confs) {
      const src = readFileSync(p, 'utf-8');
      assert.ok(!/execute\('mobile: shell', \[/.test(src), `${p}: mobile: shell args are wrapped in an array (sent as args:[[{…}]])`);
      if (/mobile: shell/.test(src)) assert.match(src, /mobile: broadcast/, `${p}: should name the flag-free mobile: broadcast alternative`);
      if (p.includes('-oss')) assert.match(src, /waitforTimeout: 45000/, `${p}: OSS waitforTimeout should be 45 s`);
    }
  });
});

describe('Locators and waits in the templates (release 1, 2026-10-17)', () => {
  const sources = walk(ROOT).filter((p) => /\.(py|java|js|robot)$/.test(p) && !/Report\.py$|wdio.*\.conf\.js$/.test(p));

  it('no iOS template locates by //*[@name=…] XPath — accessibility id is the same match without the tree walk', () => {
    const ios = sources.filter((p) => p.includes('iOS-Native'));
    assert.ok(ios.length >= 7, `found ${ios.length}`);
    for (const p of ios) {
      const src = readFileSync(p, 'utf-8');
      assert.doesNotMatch(src, /\/\/\*\[@name=/, `${p}: still uses //*[@name=] XPath`);
      assert.ok(/AppiumBy\.accessibilityId|MobileBy\.AccessibilityId|ACCESSIBILITY_ID|find\('~|accessibility_id=|_find\("/.test(src), `${p}: no accessibility-id locator`);
    }
  });

  it('every template waits explicitly and sets no implicit wait', () => {
    for (const p of sources) {
      const src = readFileSync(p, 'utf-8');
      assert.doesNotMatch(src, /implicitly_wait|implicitlyWait/, `${p}: implicit wait present`);
      assert.ok(/WebDriverWait|waitForDisplayed|Wait Until Element Is Visible/.test(src), `${p}: no explicit wait`);
      assert.doesNotMatch(src, /Thread\.sleep|time\.sleep|browser\.pause|\n\s+Sleep\s{2,}/, `${p}: fixed sleep present`);
    }
  });

  it('Android templates use By.id for the country button, not a resource-id XPath', () => {
    for (const p of sources.filter((p) => p.includes('Android-Native'))) {
      assert.doesNotMatch(readFileSync(p, 'utf-8'), /@resource-id='com\.experitest\.ExperiBank:id\/countryButton'|@resource-id="com\.experitest\.ExperiBank:id\/countryButton"/, p);
    }
  });

  it('Grid Java templates spell the strategy MobileBy (java-client 7.x); Appium Server ones AppiumBy', () => {
    for (const p of sources.filter((p) => p.includes('iOS-Native') && p.endsWith('.java'))) {
      const src = readFileSync(p, 'utf-8');
      if (p.endsWith('-oss.java')) assert.match(src, /AppiumBy\.accessibilityId/, p);
      else assert.match(src, /MobileBy\.AccessibilityId/, p);
    }
  });
});
