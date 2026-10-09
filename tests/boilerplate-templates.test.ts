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
