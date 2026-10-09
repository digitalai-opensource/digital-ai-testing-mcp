import { canonicalBrowserName } from '../utils/browser-name.js';
import { z } from 'zod';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getMyAccountInfo } from '../api/users.js';
import { getApplicationInfo } from '../api/applications.js';
import { getActiveAccessKey, getActiveUrl } from '../api/client.js';
import { listActiveSessions, AUTOMOTIVE_RESOLUTIONS, type AutomotiveResolution } from '../api/webdriver.js';
import { outputFormatParam, respond } from '../utils/output-format.js';
import { staleBuildRemedy, serverFsInstallNotice, serverFsProjectDirParam } from '../utils/locality.js';
import { isLocalFilesystem } from '../utils/deployment-mode.js';
import { validateOutputPath } from '../utils/path-guard.js';
import {
  AGENT_PROJECT_PATH,
  CONFIG_TEMPLATE_PATH,
  GITIGNORE_ADVICE,
  JDK_TRUST_NOTE,
  LIB_GITIGNORE,
  LIB_GITIGNORE_PATH,
  ORCHESTRATOR_GITIGNORE,
  ORCHESTRATOR_GITIGNORE_PATH,
  addOrchestrationToGradle,
  addOrchestrationToMaven,
  buildConfigTemplate,
  decideOrchestration,
  resolveMaxRetryAttempts,
  type OrchestrationInfo,
} from '../utils/test-orchestrator.js';
import {
  buildAgentDownloadCommands,
  installAgentIntoProject,
  resolveAgentSource,
} from '../api/test-orchestrator.js';

type Platform = 'android' | 'ios';
type Language = 'java-junit5' | 'java-testng' | 'nodejs' | 'python';
type ProjectType = 'standalone-gradle' | 'standalone-maven' | 'android-gradle-submodule';

interface BoilerplateFile {
  /** Display name shown in output headings and JSON keys. */
  filename: string;
  /** Actual filename on disk inside the boilerplate directory. */
  diskName: string;
  /** Code fence language hint for human output. */
  lang: string;
  /** True when this is a setup-instructions prose file, not runnable source. */
  isInstructions?: boolean;
}

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOILERPLATE_DIR = join(PACKAGE_ROOT, 'resources', 'boilerplate');

const PLATFORM_DIR: Record<Platform, string> = {
  android: 'Android-Native',
  ios: 'iOS-Native',
};

const LANGUAGE_SUBDIR: Record<Platform, Record<Language, string>> = {
  android: {
    'java-junit5': 'Java JUnit5',
    'java-testng': 'java TestNG',
    'nodejs':      'NodeJS (WebDriver)',
    'python':      'Python',
  },
  ios: {
    'java-junit5': 'java-JUnit5',
    'java-testng': 'java-TestNG',
    'nodejs':      'NodeJS (WebDriver)',
    'python':      'Python',
  },
};

function getFilesForVariant(
  platform: Platform,
  language: Language,
  isAppiumOss: boolean,
  projectType?: ProjectType
): BoilerplateFile[] {
  const testBase = platform === 'android' ? 'AndroidNative' : 'iOSNative';
  const ossSuffix = isAppiumOss ? '-oss' : '';

  switch (language) {
    case 'java-junit5':
    case 'java-testng': {
      const javaClass = platform === 'android' ? 'LocalAndroidTest' : 'LocaliOSTest';
      const javaPath = `src/test/java/${javaClass}.java`;
      if (projectType === 'android-gradle-submodule') {
        return [
          { filename: `e2e-tests/${javaPath}`,   diskName: `${testBase}${ossSuffix}.java`, lang: 'java' },
          { filename: 'e2e-tests/build.gradle',  diskName: `gradle${ossSuffix}`,           lang: 'groovy' },
        ];
      }
      if (projectType === 'standalone-maven') {
        return [
          { filename: javaPath,   diskName: `${testBase}${ossSuffix}.java`, lang: 'java' },
          { filename: 'pom.xml',  diskName: `maven${ossSuffix}`,            lang: 'xml' },
        ];
      }
      // standalone-gradle (default) — also return pom.xml so users have both options
      return [
        { filename: javaPath,       diskName: `${testBase}${ossSuffix}.java`, lang: 'java' },
        { filename: 'build.gradle', diskName: `gradle${ossSuffix}`,           lang: 'groovy' },
        { filename: 'pom.xml',      diskName: `maven${ossSuffix}`,            lang: 'xml' },
      ];
    }
    case 'nodejs': {
      const shellDisk = platform === 'android'
        ? (isAppiumOss ? 'Shell-oss' : 'Shell')
        : (isAppiumOss ? 'Shell-oss.txt' : 'Shell.txt');
      return [
        { filename: 'package.json',   diskName: isAppiumOss ? 'package-oss.json' : 'package.json', lang: 'json' },
        { filename: 'wdio.conf.js',   diskName: isAppiumOss ? 'wdio-oss.conf.js' : 'wdio.conf.js', lang: 'javascript' },
        { filename: `${testBase}.js`, diskName: `${testBase}.js`,                                   lang: 'javascript' },
        { filename: 'setup-steps.sh', diskName: shellDisk,                                          lang: 'sh', isInstructions: true },
      ];
    }
    case 'python': {
      const pipSuffix = isAppiumOss ? '-oss' : '';
      const pipExt = platform === 'android' ? '' : '.txt';
      return [
        { filename: `${testBase}.py`,   diskName: `${testBase}${ossSuffix}.py`,   lang: 'python' },
        { filename: 'requirements.txt', diskName: `pip${pipSuffix}${pipExt}`,     lang: 'text' },
      ];
    }
  }
}

// Gradle templates declare `repositories { mavenCentral() }` so the default standalone project resolves its
// dependencies (without it every standalone build failed: "no repositories are defined"). Inside an existing
// Android project the module must NOT declare repositories: they are centralised in settings.gradle, often with
// RepositoriesMode.FAIL_ON_PROJECT_REPOS, which turns a module-level block into a build error.
export function adaptGradleForProjectType(content: string, projectType?: ProjectType): string {
  if (projectType !== 'android-gradle-submodule') return content;
  return content.replace(
    /^\/\/ Standalone use only[^\n]*\r?\nrepositories \{ mavenCentral\(\) \}\r?\n(\r?\n)?/m,
    ''
  );
}

// ── v43 Fix D — fabricated-test detector ──────────────────────────────────────
// A backstop for the failure the boilerplate gate cannot catch: an agent that
// hand-writes (or fills) a test with invented selectors and ships it. Pure string
// scan, no network — unit-testable. High-severity hits mean the script is NOT
// runnable as-is and must not be delivered as finished.
export interface ScriptIssue {
  severity: 'high' | 'info';
  label: string;
  detail: string;
}

export function detectFabricationIssues(content: string): ScriptIssue[] {
  const issues: ScriptIssue[] = [];
  const add = (severity: ScriptIssue['severity'], label: string, detail: string) =>
    issues.push({ severity, label, detail });

  // 1. Unfilled angle-bracket placeholders the scaffold emits, e.g. <resource-id from get_element_tree>, <value>, <visible text>.
  // Only flag genuine placeholder phrasing — not bare single-token identifiers like Java/TS generic
  // type parameters (`AndroidDriver<AndroidElement>`, `List<Value>`), which contain the same keyword
  // substrings but aren't placeholders.
  const PLACEHOLDER_KEYWORDS = /\b(resource-id|selector|element|value|visible text|udid|enter|your)\b/i;
  const BARE_PLACEHOLDER_WORDS = new Set(['resource-id', 'selector', 'element', 'value', 'udid']);
  const angleCandidates = content.match(/<[^>\n]+>/g) || [];
  const angle = angleCandidates.filter((m) => {
    const inner = m.slice(1, -1).trim();
    if (!PLACEHOLDER_KEYWORDS.test(inner)) return false;
    // A single token with no whitespace is only a placeholder if it's an exact, lowercase, known
    // placeholder word — otherwise it's a bare identifier (a generic type parameter, a class name, etc.).
    if (!/\s/.test(inner)) return BARE_PLACEHOLDER_WORDS.has(inner);
    return true;
  });
  if (angle.length) add('high', 'placeholder selectors', `Unreplaced placeholder token(s): ${[...new Set(angle)].slice(0, 4).join(', ')}`);

  // 2. The deliberate scaffold fail-guard / "not a real test" markers left in place.
  if (/raise NotImplementedError|PLACEHOLDER TEST BODY|NOT A RUNNABLE TEST|NOT A FINISHED TEST|Replace this placeholder/i.test(content)) {
    add('high', 'scaffold guard present', 'The deliberate placeholder fail-guard is still in the body — the test was never filled in with real steps.');
  }

  // 3. Credential placeholders / obvious fabricated logins.
  const cred = content.match(/YOUR_ACCESS_KEY_HERE|YOUR_PASSWORD|<password>|\[Enter [^\]]*\]|changeme|password123/gi);
  if (cred) add('high', 'placeholder credentials', `Credential placeholder(s): ${[...new Set(cred)].slice(0, 4).join(', ')}`);

  // 4. Known fabricated example IDs from the v43 post-mortem — illustrative, not exhaustive.
  const knownFab = content.match(/\b(nav_catalog|home_container)\b/g);
  if (knownFab) add('high', 'known fabricated IDs', `Resource IDs from a prior fabrication incident: ${[...new Set(knownFab)].join(', ')}. Confirm these came from a live inspection, not a guess.`);

  // 5. Web-specific: placeholder CSS selectors that were never filled in.
  const webPlaceholder = content.match(/#YOUR_SELECTOR|\.your-class|\[data-testid="placeholder"\]|\[data-testid='placeholder'\]|YOUR_ELEMENT_ID|YOUR_CSS_SELECTOR/gi);
  if (webPlaceholder) add('high', 'placeholder CSS selectors', `Unreplaced placeholder CSS selector(s): ${[...new Set(webPlaceholder)].slice(0, 4).join(', ')}`);

  // 5. Soft signal: no inspection session ran in this process — can't be a hard fail
  // (selectors may be source-derived or captured in a since-closed session), but worth surfacing.
  if (listActiveSessions().length === 0) {
    add('info', 'no live inspection session', 'No inspection session is active in this MCP process. If the selectors here were not captured from an inspection or taken from authoritative app source, they are guesses — re-verify before delivering.');
  }

  return issues;
}

// Pattern matches the [BEGIN_DEMO_STEPS] ... [END_DEMO_STEPS] block including its leading indent.
const DEMO_STEP_PATTERN = /([^\S\n]*)(?:\/\/|#) \[BEGIN_DEMO_STEPS\]\n[\s\S]*?[^\S\n]*(?:\/\/|#) \[END_DEMO_STEPS\]/;

// Pattern to capture the content between the demo step markers (for wrapping without clearing).
const DEMO_INNER_PATTERN = /(?<=(?:\/\/|#) \[BEGIN_DEMO_STEPS\]\n)([\s\S]*?)(?=\n[^\S\n]*(?:\/\/|#) \[END_DEMO_STEPS\])/;

function wrapWithPerformanceTransaction(language: Language, indent: string, core: string): string {
  if (language === 'java-junit5' || language === 'java-testng') {
    return [
      `${indent}// startPerformanceTransaction arg = NV network profile ("Monitor" = observe without throttling)`,
      `${indent}// endPerformanceTransaction arg   = transaction name (appears in reporter + list_transactions)`,
      `${indent}// Data appears in the reporter ~1 min after endPerformanceTransaction. Pre-req: NV server must be`,
      `${indent}// ONLINE and tunnel-connected in the device region — verify with list_nv_servers(region=<region>).`,
      `${indent}driver.executeScript("seetest:client.startPerformanceTransaction", "Monitor");`,
      core,
      `${indent}driver.executeScript("seetest:client.endPerformanceTransaction", "My Transaction");`,
    ].join('\n');
  }
  if (language === 'python') {
    return [
      `${indent}# startPerformanceTransaction arg = NV network profile ("Monitor" = observe without throttling)`,
      `${indent}# endPerformanceTransaction arg   = transaction name (appears in reporter + list_transactions)`,
      `${indent}# Data appears in the reporter ~1 min after endPerformanceTransaction. Pre-req: NV server must be`,
      `${indent}# ONLINE and tunnel-connected in the device region — verify with list_nv_servers(region=<region>).`,
      `${indent}self.driver.execute_script("seetest:client.startPerformanceTransaction", "Monitor")`,
      core,
      `${indent}self.driver.execute_script("seetest:client.endPerformanceTransaction", "My Transaction")`,
    ].join('\n');
  }
  // nodejs
  return [
    `${indent}// startPerformanceTransaction arg = NV network profile ("Monitor" = observe without throttling)`,
    `${indent}// endPerformanceTransaction arg   = transaction name (appears in reporter + list_transactions)`,
    `${indent}// Data appears in the reporter ~1 min after endPerformanceTransaction. Pre-req: NV server must be`,
    `${indent}// ONLINE and tunnel-connected in the device region — verify with list_nv_servers(region=<region>).`,
    `${indent}await browser.execute('seetest:client.startPerformanceTransaction', 'Monitor');`,
    core,
    `${indent}await browser.execute('seetest:client.endPerformanceTransaction', 'My Transaction');`,
  ].join('\n');
}

function appendAxeScan(language: Language, indent: string, apiKey: string): string {
  const key = apiKey || '[Enter AXE_DEVTOOLS_API_KEY here]';
  if (language === 'java-junit5' || language === 'java-testng') {
    return [
      `${indent}// Axe DevTools accessibility scan — scans the current screen state`,
      `${indent}java.util.Map<String, Object> axeSettings = new java.util.HashMap<>();`,
      `${indent}axeSettings.put("apiKey", "${key}");`,
      `${indent}axeSettings.put("scanName", "Accessibility Scan");`,
      `${indent}axeSettings.put("tags", new java.util.ArrayList<>());`,
      `${indent}driver.executeScript("mobile: axeScan", axeSettings);`,
    ].join('\n');
  }
  if (language === 'python') {
    return [
      `${indent}# Axe DevTools accessibility scan — scans the current screen state`,
      `${indent}axe_settings = {"apiKey": "${key}", "scanName": "Accessibility Scan", "tags": []}`,
      `${indent}self.driver.execute_script("mobile: axeScan", axe_settings)`,
    ].join('\n');
  }
  // nodejs
  return [
    `${indent}// Axe DevTools accessibility scan — scans the current screen state`,
    `${indent}const axeSettings = { apiKey: '${key}', scanName: 'Accessibility Scan', tags: [] };`,
    `${indent}await browser.execute('mobile: axeScan', axeSettings);`,
  ].join('\n');
}

// Android Auto / CarPlay head-unit check, appended after the test steps when automotiveProjection is set. The capability
// (injected separately) keeps projection on for the whole session — verified live as the reliable route (a Galaxy S10
// rejects mid-session digitalai:automotive.start but projects fine with the capability). No selectors are involved:
// it captures the head unit and leaves the tap as a commented template, so nothing fabricated is presented as a step.
function appendAutomotiveCheck(language: Language, indent: string): string {
  if (language === 'java-junit5' || language === 'java-testng') {
    return [
      `${indent}// Android Auto / CarPlay head unit (digitalai:automotiveProjection is on for this whole session).`,
      `${indent}// getScreenshot returns a base64 PNG of the projected display; tap takes head-unit coordinates.`,
      `${indent}String headUnitPng = (String) driver.executeScript("digitalai:automotive.getScreenshot");`,
      `${indent}System.out.println("Head unit screenshot: " + headUnitPng.length() + " base64 chars");`,
      `${indent}// driver.executeScript("digitalai:automotive.tap", x, y);  // coordinates within the projection resolution`,
    ].join('\n');
  }
  if (language === 'python') {
    return [
      `${indent}# Android Auto / CarPlay head unit (digitalai:automotiveProjection is on for this whole session).`,
      `${indent}# getScreenshot returns a base64 PNG of the projected display; tap takes head-unit coordinates.`,
      `${indent}head_unit_png = self.driver.execute_script("digitalai:automotive.getScreenshot")`,
      `${indent}print(f"Head unit screenshot: {len(head_unit_png)} base64 chars")`,
      `${indent}# self.driver.execute_script("digitalai:automotive.tap", x, y)  # coordinates within the projection resolution`,
    ].join('\n');
  }
  return [
    `${indent}// Android Auto / CarPlay head unit (digitalai:automotiveProjection is on for this whole session).`,
    `${indent}// getScreenshot returns a base64 PNG of the projected display; tap takes head-unit coordinates.`,
    `${indent}const headUnitPng = await browser.execute('digitalai:automotive.getScreenshot');`,
    `${indent}console.log(\`Head unit screenshot: \${headUnitPng.length} base64 chars\`);`,
    `${indent}// await browser.execute('digitalai:automotive.tap', x, y);  // coordinates within the projection resolution`,
  ].join('\n');
}

// The cleared-body placeholder is a deliberate ANTI-fabrication guard (v38).
// Three properties matter: (1) a loud banner so the scaffold is never mistaken
// for a finished test; (2) an EXECUTABLE fail/raise as the first statement so a
// scaffold delivered unmodified fails immediately with an explanatory message
// instead of silently running fabricated selectors; (3) example selectors use
// <…> tokens — NOT the real package name — so they cannot be copy-pasted and
// passed off as verified locators (the prior version interpolated the real
// package into fake IDs, which is exactly how fabricated selectors looked real).
function failGuard(language: Language, indent: string): string {
  const msg = 'Replace this placeholder body with real element selectors captured from a live inspection (start_inspection_session -> get_element_tree, or open_mobile_studio) before running. Do not run the scaffold as-is.';
  switch (language) {
    case 'java-junit5':
      return `${indent}org.junit.jupiter.api.Assertions.fail("${msg}");`;
    case 'java-testng':
      return `${indent}org.testng.Assert.fail("${msg}");`;
    case 'python':
      return `${indent}raise NotImplementedError("${msg}")`;
    case 'nodejs':
      return `${indent}throw new Error('${msg}');`;
  }
}

function buildPlaceholder(language: Language, platform: Platform, indent: string): string {
  const c = language === 'python' ? '#' : '//';
  const idTerm = platform === 'android' ? 'resource-id' : 'accessibility id';
  const banner = [
    `${indent}${c} ============================================================================`,
    `${indent}${c} ⛔ PLACEHOLDER TEST BODY — NOT A RUNNABLE TEST. This is scaffolding only.`,
    `${indent}${c} The example locators below are NOT real. Do NOT deliver this file as a finished test.`,
    `${indent}${c} Replace this entire block with steps built from selectors discovered LIVE:`,
    `${indent}${c}   start_inspection_session -> get_element_tree / find_elements, or open_mobile_studio.`,
    `${indent}${c} NEVER guess a ${idTerm} from the package name or naming conventions.`,
    `${indent}${c} NEVER invent credentials — ask the user for login details.`,
    `${indent}${c} The fail()/raise below is intentional: it stops this scaffold from being mistaken`,
    `${indent}${c} for a passing test until you replace it with verified steps.`,
    `${indent}${c} ============================================================================`,
  ];

  // Example shapes use <…> tokens so they read as obviously-unfilled, never as real selectors.
  let examples: string[];
  if (platform === 'android') {
    if (language === 'java-junit5' || language === 'java-testng') {
      examples = [
        `${indent}${c} Example shape only — every <…> must be replaced with a value from inspection:`,
        `${indent}${c}   driver.findElement(By.id("<resource-id from get_element_tree>")).click();`,
        `${indent}${c}   driver.findElement(By.id("<resource-id>")).sendKeys("<value the user gave you>");`,
        `${indent}${c}   driver.findElement(By.xpath("//*[@text='<visible text>']")); // assert visible`,
      ];
    } else if (language === 'nodejs') {
      examples = [
        `${indent}${c} Example shape only — every <…> must be replaced with a value from inspection:`,
        `${indent}${c}   const btn = await $('id=<resource-id from get_element_tree>'); await btn.click();`,
        `${indent}${c}   const field = await $('//*[@resource-id="<resource-id>"]'); await field.setValue('<value>');`,
        `${indent}${c}   await expect($('//*[@text="<visible text>"]')).toBeExisting();`,
      ];
    } else {
      examples = [
        `${indent}${c} Example shape only — every <…> must be replaced with a value from inspection:`,
        `${indent}${c}   self.driver.find_element(By.ID, "<resource-id from get_element_tree>").click()`,
        `${indent}${c}   self.driver.find_element(By.ID, "<resource-id>").send_keys('<value>')`,
        `${indent}${c}   self.driver.find_element(By.XPATH, "//*[@text='<visible text>']")  # assert visible`,
      ];
    }
  } else {
    if (language === 'java-junit5' || language === 'java-testng') {
      examples = [
        `${indent}${c} Example shape only — every <…> must be replaced with a value from inspection:`,
        `${indent}${c}   driver.findElement(By.xpath("//*[@name='<accessibility id from get_element_tree>']")).click();`,
        `${indent}${c}   driver.findElement(By.xpath("//*[@name='<accessibility id>']")).sendKeys("<value the user gave you>");`,
        `${indent}${c}   driver.findElement(By.xpath("//*[@label='<visible label>']")); // assert visible`,
      ];
    } else if (language === 'nodejs') {
      examples = [
        `${indent}${c} Example shape only — every <…> must be replaced with a value from inspection:`,
        `${indent}${c}   const btn = await $('//*[@name="<accessibility id from get_element_tree>"]'); await btn.click();`,
        `${indent}${c}   const field = await $('//*[@name="<accessibility id>"]'); await field.setValue('<value>');`,
        `${indent}${c}   await expect($('//*[@label="<visible label>"]')).toBeExisting();`,
      ];
    } else {
      examples = [
        `${indent}${c} Example shape only — every <…> must be replaced with a value from inspection:`,
        `${indent}${c}   self.driver.find_element(By.XPATH, "//*[@name='<accessibility id from get_element_tree>']").click()`,
        `${indent}${c}   self.driver.find_element(By.XPATH, "//*[@name='<accessibility id>']").send_keys('<value>')`,
        `${indent}${c}   self.driver.find_element(By.XPATH, "//*[@label='<visible label>']")  # assert visible`,
      ];
    }
  }

  return [...banner, failGuard(language, indent), ...examples].join('\n');
}

function readBoilerplateFile(platform: Platform, language: Language, diskName: string): string {
  const dir = join(BOILERPLATE_DIR, PLATFORM_DIR[platform], LANGUAGE_SUBDIR[platform][language]);
  // Normalize to LF: the marker/injection patterns (DEMO_STEP_PATTERN etc.) match "\n" only. Git stores the templates
  // with LF, but a Windows checkout with core.autocrlf materializes some as CRLF — and then, for those files, the
  // custom-app placeholder never replaced the ExperiBank demo steps (the anti-fabrication guard silently did nothing)
  // and includeAxeScan / includePerformanceTransactions / automotiveProjection were no-ops. Affects local runs and any
  // Docker image built from a Windows working tree.
  return readFileSync(join(dir, diskName), 'utf-8').replace(/\r\n/g, '\n');
}

function substitute(
  content: string,
  language: Language,
  platform: Platform,
  vars: {
    accessKey: string;
    instanceUrl: string;
    instanceHost: string;
    testName: string;
    deviceCategory: string;
    packageName?: string;
    mainActivity?: string;
    bundleIdentifier?: string;
    clearTestBody?: boolean;
    region?: string;
    performanceTransactions?: boolean;
    axeScan?: boolean;
    axeApiKey?: string;
    isAppiumOss?: boolean;
    /** Appium Server only — the caller drops it for Grid projects. */
    automotiveProjection?: AutomotiveResolution;
  }
): string {
  let result = content;

  // Handle demo step markers before other substitutions so package name replacement
  // doesn't corrupt the placeholder comment text.
  if (DEMO_STEP_PATTERN.test(result)) {
    const indentMatch = result.match(/([^\S\n]*)(?:\/\/|#) \[BEGIN_DEMO_STEPS\]/);
    const indent = indentMatch?.[1] ?? '        ';
    if (vars.clearTestBody) {
      let placeholder = buildPlaceholder(language, platform, indent);
      if (vars.axeScan) {
        placeholder += '\n' + appendAxeScan(language, indent, vars.axeApiKey ?? '');
      }
      if (vars.automotiveProjection) {
        placeholder += '\n' + appendAutomotiveCheck(language, indent);
      }
      if (vars.performanceTransactions) {
        placeholder = wrapWithPerformanceTransaction(language, indent, placeholder);
      }
      result = result.replace(DEMO_STEP_PATTERN, placeholder);
    } else if (vars.performanceTransactions || vars.axeScan || vars.automotiveProjection) {
      result = result.replace(DEMO_INNER_PATTERN, (inner) => {
        let content = inner;
        if (vars.axeScan) {
          content += '\n' + appendAxeScan(language, indent, vars.axeApiKey ?? '');
        }
        if (vars.automotiveProjection) {
          content += '\n' + appendAutomotiveCheck(language, indent);
        }
        return vars.performanceTransactions
          ? wrapWithPerformanceTransaction(language, indent, content)
          : content;
      });
      result = result.replace(/[^\S\n]*(?:\/\/|#) \[BEGIN_DEMO_STEPS\]\n/, '');
      result = result.replace(/\n[^\S\n]*(?:\/\/|#) \[END_DEMO_STEPS\]/, '');
    } else {
      // Strip markers, keep content unchanged.
      result = result.replace(/[^\S\n]*(?:\/\/|#) \[BEGIN_DEMO_STEPS\]\n/, '');
      result = result.replace(/\n[^\S\n]*(?:\/\/|#) \[END_DEMO_STEPS\]/, '');
    }
  }

  result = result
    .replaceAll('[Enter Your Access key here]', vars.accessKey)
    .replaceAll('[Enter Instance here]', vars.instanceUrl)
    .replaceAll('[Enter Instance HOST here]', vars.instanceHost)
    .replaceAll('[Enter Test Name here]', vars.testName)
    .replaceAll('[Enter TestName here]', vars.testName)   // iOS Python variant
    .replaceAll('[testNameHere]', vars.testName)          // iOS NodeJS variant
    .replaceAll('[Enter PHONE/TABLET here]', vars.deviceCategory);

  if (vars.packageName) {
    result = result.replaceAll('com.experitest.ExperiBank', vars.packageName);
  }
  if (vars.mainActivity) {
    result = result.replaceAll('.LoginActivity', vars.mainActivity);
  }
  if (vars.bundleIdentifier) {
    result = result.replaceAll('com.experitest.ExperiBank', vars.bundleIdentifier);
  }

  if (vars.region) {
    // Append region to the deviceQuery — fires after the PHONE/TABLET substitution has already run.
    result = result.replace(
      /@category='(PHONE|TABLET)'/g,
      `@category='$1' and @region='${vars.region}'`
    );
  }

  if (vars.axeScan) {
    const automationName = platform === 'android' ? 'AxeUiAutomator2' : 'AxeXCUITest';
    if (language === 'java-junit5' || language === 'java-testng') {
      const obj = vars.isAppiumOss ? 'options' : 'dc';
      result = result.replace(
        /\n( +)(driver = new (?:Android|iOS)Driver)/,
        (_m, sp, line) =>
          `\n${sp}${obj}.setCapability("appium:automationName", "${automationName}");\n` +
          `${sp}${obj}.setCapability("appiumVersion", "2.16.2");\n` +
          `${sp}${line}`
      );
    } else if (language === 'python') {
      if (result.includes('options=options')) {
        result = result.replace(
          /\n( +)(self\.driver = webdriver\.Remote\()/,
          (_m, sp, line) =>
            `\n${sp}options.set_capability('appium:automationName', '${automationName}')\n` +
            `${sp}options.set_capability('appiumVersion', '2.16.2')\n` +
            `${sp}${line}`
        );
      } else {
        result = result.replace(
          /\n( +)(self\.driver = webdriver\.Remote\()/,
          (_m, sp, line) =>
            `\n${sp}desired_caps['appium:automationName'] = '${automationName}'\n` +
            `${sp}desired_caps['appiumVersion'] = '2.16.2'\n` +
            `${sp}${line}`
        );
      }
    } else if (language === 'nodejs') {
      result = result.replace(
        /('digitalai:deviceQuery': [^\n]+)/,
        (match) =>
          `${match}\n        'appium:automationName': '${automationName}',\n        'appiumVersion': '2.16.2',`
      );
    }
  }

  if (vars.automotiveProjection) {
    const res = vars.automotiveProjection;
    if (language === 'java-junit5' || language === 'java-testng') {
      result = result.replace(
        /\n( +)(driver = new (?:Android|iOS)Driver)/,
        (_m, sp, line) => `\n${sp}options.setCapability("digitalai:automotiveProjection", "${res}");\n${sp}${line}`
      );
    } else if (language === 'python') {
      result = result.replace(
        /\n( +)(self\.driver = webdriver\.Remote\()/,
        (_m, sp, line) => `\n${sp}options.set_capability('digitalai:automotiveProjection', '${res}')\n${sp}${line}`
      );
    } else if (language === 'nodejs') {
      result = result.replace(
        /('digitalai:deviceQuery': [^\n]+)/,
        (match) => `${match}\n        'digitalai:automotiveProjection': '${res}',`
      );
    }
  }

  return result;
}

function setupNote(language: Language, isAppiumOss: boolean, projectType?: ProjectType): string {
  switch (language) {
    case 'java-junit5':
    case 'java-testng':
      if (projectType === 'android-gradle-submodule') {
        return (
          'Gradle submodule layout — add the generated files under your existing Android project:\n' +
          '  1. Add  include \':e2e-tests\'  to your root settings.gradle\n' +
          '  2. File → Sync Project with Gradle Files in Android Studio\n' +
          '  3. Open the test file → click the green run gutter icon next to the @Test method → Run'
        );
      }
      if (projectType === 'standalone-maven') {
        return (
          'Standalone Maven project:\n' +
          '  Place pom.xml at the project root and the .java file under src/test/java/\n' +
          '  Then run:  mvn test'
        );
      }
      return (
        'PRIMARY — Android Studio (no additional tools required):\n' +
        '  1. File → Sync Project with Gradle Files\n' +
        '  2. Open the test file → click the green run gutter icon next to the @Test method → Run\n\n' +
        'SECONDARY — command line (requires a standalone install):\n' +
        '  gradle test   — requires Gradle installed globally\n' +
        '  mvn test      — requires Maven installed\n\n' +
        'NOTE: ./gradlew requires gradle/wrapper/gradle-wrapper.jar which is NOT generated\n' +
        '  by this tool (gitignored by default in Android projects). To bootstrap it:\n' +
        '  run  gradle wrapper  (requires a standalone Gradle install), then use ./gradlew test.\n' +
        '  Alternatively, use the Android Studio primary path above — no wrapper jar needed.\n\n' +
        'To use as a Gradle submodule inside an existing Android Studio project:\n' +
        '  - Root settings.gradle: add  include \':e2e-tests\'\n' +
        '  - Place files under e2e-tests/src/test/java/ and e2e-tests/build.gradle\n' +
        '  (Use projectType: android-gradle-submodule to generate paths pre-scoped to e2e-tests/.)'
      );
    case 'nodejs':
      if (isAppiumOss) {
        return (
          'Create a project folder and save the provided files in this layout:\n' +
          '  package.json          ← project root\n' +
          '  wdio.conf.js          ← project root\n' +
          '  test/specs/<TestFile>.js\n\n' +
          'Then run:\n' +
          '  npm install && npm run wdio'
        );
      }
      return (
        'Create a project folder and save the provided files in this layout:\n' +
        '  package.json          ← project root\n' +
        '  wdio.conf.js          ← project root\n' +
        '  test/specs/<TestFile>.js\n\n' +
        'Then run:\n' +
        '  npm install && npm run wdio\n\n' +
        'IMPORTANT: Do NOT run npm init wdio — it installs wdio v9, which this project\'s Appium Grid rejects\n' +
        '  ("Cant run Appium Grid with Appium client 8+"). The Grid requires the legacy desiredCapabilities in the\n' +
        '  session request; wdio v8+ sends W3C capabilities only. The package.json above pins wdio v7.40.0, the last\n' +
        '  release that still sends them (verified live: v9 refused, v7.40 runs). Appium Server projects use wdio v9.'
      );
    case 'python':
      return isAppiumOss
        ? 'Install the dependency with: pip install -r requirements.txt  (Appium-Python-Client>=4.0.0), then run: python -m pytest\n\n' +
          'Parallel execution (recommended on device farms — each test gets its own device):\n' +
          '  pip install pytest-xdist\n' +
          '  pytest -n auto -v   # spawns one worker per test method; each creates its own Appium session'
        : '⚠️  APPIUM GRID (LEGACY): This project uses Appium Grid — a legacy Digital.ai framework\n' +
          'that predates the W3C WebDriver standard. It is NOT the same as standard Appium Server.\n' +
          'All workarounds below exist because of this protocol difference, not Python version conflicts.\n\n' +
          'Install: pip install -r requirements.txt  (appium-python-client==2.2.0 + selenium==4.9.0)\n' +
          'Run:     python -m pytest\n\n' +
          'Parallel execution (recommended — each test method gets its own device from the farm pool):\n' +
          '  pip install pytest-xdist\n' +
          '  pytest -n auto -v   # safe: each worker process creates its own setUp/tearDown session\n' +
          '  Check project concurrency limits first: get_project_admin_settings → maxDevelopmentLicense\n\n' +
          'Protocol requirements (Appium Grid only):\n' +
          '  • desired_capabilities= dict (JWP format) — W3C options= triggers grid rejection\n' +
          '  • Both packages must be pinned — Selenium 4.10+ removed desired_capabilities entirely\n' +
          '  • _elem() wrapper required — JWP sessions return raw dicts from find_element()\n' +
          '  • Use appium.webdriver.webelement.WebElement (not selenium\'s) for is_displayed()\n\n' +
          'If you can migrate this project to Appium Server, all of these workarounds go away.\n' +
          'Error "Cant run Appium Grid with Appium client 8+" = W3C format rejected by grid (not a version issue).';
  }
}

function appNote(
  platform: Platform,
  packageName?: string,
  bundleIdentifier?: string,
  mainActivity?: string,
  resolvedFromAppId?: boolean
): string {
  const source = resolvedFromAppId ? ' (resolved from app record)' : '';
  // NOTE: with a custom app the test body is the v38 placeholder (fails by design until
  // replaced) — phrase these to reinforce that, never as a casual "TODO".
  if (platform === 'android') {
    if (packageName && mainActivity) {
      return `App capabilities pre-filled${source}: package=${packageName}, activity=${mainActivity}. The test body is a PLACEHOLDER that fails by design — replace it with verified selectors from a live inspection before running.`;
    }
    if (packageName) {
      return `App package pre-filled${source}: ${packageName}. Replace .LoginActivity with your main activity. The test body is a PLACEHOLDER that fails by design — replace it with verified selectors from a live inspection.`;
    }
    return 'Replace com.experitest.ExperiBank with your app\'s package name and .LoginActivity with your main activity. Replace the test steps with interactions specific to your app.';
  }
  if (bundleIdentifier) {
    return `Bundle ID pre-filled${source}: ${bundleIdentifier}. The test body is a PLACEHOLDER that fails by design — replace it with verified selectors from a live inspection before running.`;
  }
  return 'Replace com.experitest.ExperiBank with your app\'s bundle ID. Replace the test steps with interactions specific to your app.';
}

export function registerBoilerplateTools(server: McpServer): void {
  server.tool(
    'get_test_boilerplate',
    'STOP — when you target a real app (appId, packageName, or bundleIdentifier) this tool returns NO code unless ' +
    'a live inspection session exists OR you set confirmSelectorsVerified:true. Without a selector source it blocks ' +
    'with a redirect to start_inspection_session — there is nothing to "fill in later". Do not attempt to work around ' +
    'the block by writing the test from scratch; capture real selectors first.\n\n' +
    'AUTONOMOUS TEST CREATION — this tool is the scaffold for writing a complete automated test yourself, ' +
    'without user collaboration. Use it when BOTH hold: ' +
    '(a) the intent is SPECIFIC — a standardized flow ("create a login test") or step-level detail ' +
    '("login, tap Transfer, select account 43x, set $50.00, tap Transfer Now"); ' +
    '(b) you have a SELECTOR SOURCE — the app source code in the workspace, or element IDs captured from an inspection session. ' +
    'If the intent is vague ("I want a test for app X") or there is no selector source, prefer the interactive path: ' +
    'start_inspection_session (or the collaborative_test_creation prompt). ' +
    'VAGUE-INTENT SIGNALS — treat answers like "let\'s decide as we go", "let\'s see what\'s there", or "not sure yet" ' +
    '(at ANY point, including replies to your scoping questions) as a redirect to interactive mode: do NOT generate a script from them. ' +
    'A test-TYPE label alone — "end-to-end", "smoke test", "regression", "login test" picked from a menu — is a CATEGORY, ' +
    'NOT a specification: it does not name screens, actions, or expected results, so it does NOT meet the specific-intent bar. ' +
    'Never treat a menu selection as a flow definition. ' +
    'IF UNSURE WHICH MODE THE USER WANTS, ASK: "Want me to create this test for you based on best practices, ' +
    'or start an interactive session where we build it together?"\n\n' +
    'NEVER call this tool as a discovery/inspection step, and NEVER deliver its output as a finished test when the body is a ' +
    'placeholder — the cleared body ships with a deliberate fail-guard and non-real <…> selectors precisely so a scaffold ' +
    'cannot masquerade as a runnable test. Replace it with verified selectors first.\n\n' +
    'SELECTOR POLICY — NEVER fabricate element selectors OR credentials. Ask the user for login details; do not invent ' +
    'values like "company"/"company" or any default. Source code is authoritative only for classic static IDs ' +
    '(Android View XML android:id; iOS explicit accessibilityIdentifier). Jetpack Compose, SwiftUI, Flutter, and ' +
    'React Native apps often expose NO source-derivable IDs — and the build on the farm may be older than the workspace ' +
    'source (version skew). When source yields clear static IDs, a short inspection-session spot-check of the critical ' +
    'selectors is recommended; when it does not, a no-user-interaction inspection session IS the selector source — ' +
    'capture real IDs there, never guess from naming conventions.\n\n' +
    'OUTPUT LOCATION — in an IDE/workspace context, write the result as a local test automation project ' +
    '(this tool returns all project files). In a chat-only context (no file tools), present the files inline ' +
    'so the user can port them to an IDE or CI system.\n\n' +
    'Use this when you already have the app identifiers (packageName/bundleIdentifier, mainActivity) and want a ' +
    'complete, non-interactive test script ready to trigger against the cloud farm via RemoteWebDriver — ' +
    'no local debug session required. Typical entry points: "generate a test script I can run later", ' +
    '"create a reusable automated test", "set up a CI test for this app".\n\n' +
    'RECOMMENDED WORKFLOW — build a new test for an app:\n' +
    '  1. get_application_info — confirm package name, launch activity, and app ID\n' +
    '  2. find_available_device — select a healthy device; note the region from the response\n' +
    '  3. install_application — install the app on the selected device BEFORE starting a session\n' +
    '  4. start_inspection_session(region) — capture REAL element IDs via get_element_tree / find_elements; share the viewUrl with the user\n' +
    '  5. get_test_boilerplate(region) — generate starter test with capabilities pre-filled (this tool)\n' +
    '  6. [write / run test]\n' +
    '  7. stop_inspection_session + release_device — explicit cleanup on completion\n\n' +
    'ELEMENT INSPECTION — preferred path: start_inspection_session → get_element_tree / find_elements. ' +
    'This provides programmatic element-tree access, screenshot relay, and gesture control — the only way to capture verified selectors inside MCP. ' +
    'open_mobile_studio is a visual-only alternative for ad-hoc browsing and does NOT expose get_element_tree access. ' +
    'get_automation_properties retrieves Appium endpoint details, not element selectors. ' +
    'rdb / adb is a fallback for scenarios that need direct shell access (file push, side-loaded installs). ' +
    'Do NOT use adb shell uiautomator dump on Android 15+ Samsung devices — it exits silently without output on those devices.\n\n' +
    'IMPORTANT: The generated script is an end-product artifact — do NOT execute it as a discovery or inspection step. ' +
    'Running it without known element selectors creates Incomplete sessions in the reporter (visible to the whole team) ' +
    'that cannot be retroactively closed. Use start_inspection_session → get_element_tree for any live inspection before this tool.\n\n' +
    'The Digital.ai access key and server URL are pre-filled from the MCP environment. ' +
    'BEFORE calling this tool: (1) call get_application_info or list_applications to find the appId and confirm package/activity; ' +
    '(2) run release_orphaned_sessions(maxAgeHours=4, dryRun=true) to surface device contention before reserving; ' +
    '(3) call find_available_device for each OS tier you plan to test — read the region from the RESPONSE and pass it ' +
    'as the region parameter so the generated deviceQuery routes only to healthy devices in that region. ' +
    'Also read osVersion from the find_available_device response and use that exact value (e.g. "14.0") in any @version ' +
    'query strings. Do not guess OS versions or use @osVersion/@deviceName (unsupported fields). ' +
    'Provide appId (from list_applications) to auto-resolve app capabilities from the platform record and generate a ' +
    'guided test body placeholder — this is the recommended path for real apps. ' +
    'Alternatively, provide packageName (Android) or bundleIdentifier (iOS) directly. ' +
    'Use projectType to control the output structure: standalone-gradle (default), standalone-maven, or android-gradle-submodule. ' +
    'Returns all files needed to run the test (source file + build/dependency file) with dependency management options where applicable. ' +
    'Pass includePerformanceTransactions: true to bracket the test body with startPerformanceTransaction / endPerformanceTransaction calls — ' +
    'the platform records CPU, memory, battery, and Speed Index metrics for the enclosed flow; results appear in the reporter Transactions tab. ' +
    'Pass includeAxeScan: true to add a Deque Axe DevTools accessibility scan (sets the required automationName capability and injects the mobile: axeScan call). ' +
    'Both flags can be combined. ' +
    'JAVA PITFALL (Appium Client 7.x / Grid): In WebDriverWait lambdas, the parameter d is typed as WebDriver — ' +
    'do NOT call AndroidDriver-specific methods (e.g. currentActivity()) on it. ' +
    'Reference the outer driver field instead: wait.until(d -> !driver.currentActivity().contains("LoginActivity")). ' +
    'DIAGNOSTIC: If a test suite that previously passed begins failing with NoSuchElementException on elements that other ' +
    'tests in the same run find without issue (session connects and app launches normally), this is a device health signal — ' +
    'NOT a code or timing issue. Check device health first with get_device_health_summary or list_devices before modifying test code.',
    {
      platform: z
        .enum(['android', 'ios'])
        .describe("Target mobile platform: 'android' or 'ios'."),
      language: z
        .enum(['java-junit5', 'java-testng', 'nodejs', 'python'])
        .describe("Test framework and language: 'java-junit5', 'java-testng', 'nodejs' (WebDriverIO), or 'python' (Appium)."),
      appId: z
        .number()
        .optional()
        .describe(
          'Numeric application ID from list_applications. When provided, the MCP looks up the app record and ' +
          'auto-fills packageName/mainActivity (Android) or bundleIdentifier (iOS), and replaces the demo test ' +
          'steps with guided placeholder comments — because element IDs are app-specific and cannot be pre-filled. ' +
          'Recommended for any real app.'
        ),
      deviceCategory: z
        .enum(['PHONE', 'TABLET'])
        .optional()
        .default('PHONE')
        .describe("Device form factor to target: 'PHONE' (default) or 'TABLET'."),
      testName: z
        .string()
        .optional()
        .default('My First Mobile Test')
        .describe('Name for the test run as it will appear in the Digital.ai reporting portal. Defaults to "My First Mobile Test".'),
      packageName: z
        .string()
        .optional()
        .describe('(Android only) App package name, e.g. com.mycompany.app. Pre-fills the appPackage capability. Prefer appId — providing packageName also clears the demo test body and inserts guided placeholders.'),
      mainActivity: z
        .string()
        .optional()
        .describe('(Android only) Main activity, e.g. .MainActivity or com.mycompany.app.MainActivity. Pre-fills the appActivity capability. Requires packageName.'),
      bundleIdentifier: z
        .string()
        .optional()
        .describe('(iOS only) App bundle identifier, e.g. com.mycompany.app. Pre-fills the bundleId capability. Prefer appId — providing bundleIdentifier also clears the demo test body and inserts guided placeholders.'),
      projectType: z
        .enum(['standalone-gradle', 'standalone-maven', 'android-gradle-submodule'])
        .optional()
        .describe(
          'Controls output structure for Java variants (ignored for nodejs/python). ' +
          'standalone-gradle (default): src/test/java/ layout with build.gradle + pom.xml. ' +
          'standalone-maven: src/test/java/ layout with pom.xml only. ' +
          'android-gradle-submodule: paths scoped to e2e-tests/ (e2e-tests/src/test/java/ + e2e-tests/build.gradle) for embedding inside an existing Android Studio project.'
        ),
      region: z
        .string()
        .optional()
        .describe(
          'Region code to scope the generated deviceQuery (e.g. "US2", "SG1"). ' +
          'When provided, appends `and @region=\'<value>\'` to the digitalai:deviceQuery capability in the output. ' +
          'STRONGLY RECOMMENDED: pass the region returned by find_available_device. Without this, the deviceQuery ' +
          'is evaluated against all devices in all regions — including devices that have been offline for days or weeks — ' +
          'producing silent routing failures that look like test logic errors at the Python/Java level.'
        ),
      includePerformanceTransactions: z
        .boolean()
        .optional()
        .describe(
          'Wrap the generated test body with startPerformanceTransaction / endPerformanceTransaction calls. ' +
          'The start arg is the NV network profile name ("Monitor" = observe without throttling, no bandwidth changes). ' +
          'The end arg is the transaction name that appears in the reporter and is queryable via list_transactions. ' +
          'Results appear in the reporter Transactions tab approximately 1 minute after endPerformanceTransaction. ' +
          'Pre-requisite: an NV server must be ONLINE and tunnel-connected in the device region — ' +
          'call list_nv_servers(region=<target region>) and verify before running instrumented tests. ' +
          'CONTROLLED COMPARISON REQUIREMENTS: (1) a comparison needs ≥4 samples per side or outlier detection is ' +
          'skipped (detect_performance_outliers / compare_performance_transactions) — plan ≥10 samples for short ' +
          'transactions, ≥5 for long ones. (2) A deviceQuery that matches multiple OS versions can also match multiple ' +
          'HARDWARE models, which confounds the result; pin hardware by adding an exact @model constraint (e.g. ' +
          'and @model=\'SM-G991U\'), or pin a single physical device with @serialNumber=\'<udid>\', so every sample ' +
          'runs on the same hardware. ' +
          'NOTE: startTransaction/endTransaction exist but silently produce no reporter data — they are not the performance transaction API. ' +
          'stopTransaction does not exist and fails with a Java reflection error at every parameter count.'
        ),
      includeAxeScan: z
        .boolean()
        .optional()
        .describe(
          'Add a Deque Axe DevTools accessibility scan to the generated test. ' +
          'When enabled: (1) sets appium:automationName to AxeUiAutomator2 (Android) or AxeXCUITest (iOS) ' +
          'and appiumVersion to "2.16.2" in setUp — required for the Axe integration to function; ' +
          'do NOT raise appiumVersion to 3.3.0 or later — the Axe driver is unavailable on Appium Server >=3.3.0 (platform known issue, 26.6/26.7); ' +
          '(2) injects driver.executeScript("mobile: axeScan", settings) into the test body after the test steps. ' +
          'The Axe API key is read from AXE_DEVTOOLS_API_KEY in the MCP environment; if not set, a placeholder is used. ' +
          'Scan results appear in the Axe DevTools Mobile dashboard. ' +
          'Can be combined with includePerformanceTransactions — the scan runs inside the performance transaction boundary.'
        ),
      automotiveProjection: z
        .enum(AUTOMOTIVE_RESOLUTIONS)
        .optional()
        .describe(
          'Android Auto (Android) / CarPlay (iOS) projection test: sets digitalai:automotiveProjection to this head-unit resolution ' +
          '(projection stays on for the whole session) and appends a head-unit screenshot step plus a commented tap template ' +
          'after the test steps. CarPlay supports 800x480 only. Appium Server projects only — on Appium Grid the classic ' +
          'boilerplate is returned with a note. Build head-unit steps from automotive_control screenshots in an inspection session.'
        ),
      confirmSelectorsVerified: z
        .boolean()
        .optional()
        .describe(
          'Escape hatch for the inspection gate. When you target a real app, this tool refuses to emit code unless a ' +
          'live inspection session exists — UNLESS you set this to true. Set it ONLY if you have ALREADY captured REAL ' +
          'element IDs for this app from a source other than a still-open session: an rdb/UIAutomator dump, ' +
          'open_mobile_studio (including selectors recorded with its iOS Test Recorder), get_automation_properties, ' +
          'or authoritative app source in the workspace. ' +
          'Setting this WITHOUT real captured selectors produces a placeholder scaffold with invalid <…> selectors that ' +
          'fails at runtime, and violates the tool contract. When in doubt, do NOT set it — start_inspection_session instead.'
        ),
      orchestration: z
        .enum(['auto', 'on', 'off'])
        .optional()
        .default('auto')
        .describe(
          'Digital.ai Test Orchestrator (a JVM agent: automatic retries of failed tests, Reporter status sync, test ' +
          'selection, fail-fast, Build/Run IDs — test code unchanged). "auto" (default): ON for Java (java-junit5 / ' +
          'java-testng) on an Appium Server project, OFF otherwise (Appium Grid, Python and NodeJS are not supported). ' +
          '"off": the classic non-orchestrated boilerplate — use when the user explicitly asks for it. "on": require it ' +
          '(an unsupported combination returns the classic output with an explanation). Orchestrated projects attach ' +
          'the agent only when lib/smart-agent.jar is present — install it with install_test_orchestrator_agent.'
        ),
      orchestrationMaxRetries: z
        .number()
        .int()
        .min(0)
        .max(5)
        .optional()
        .describe(
          'Orchestrated projects only: run.maxRetryAttempts in the agent config. Default 2 — or 0 when the test body is ' +
          'a placeholder (fails by design) or includePerformanceTransactions is set (retries would skew samples).'
        ),
      outputFormat: outputFormatParam,
    },
    async ({ platform, language, appId, deviceCategory, testName, packageName, mainActivity, bundleIdentifier, projectType, region, includePerformanceTransactions, includeAxeScan, automotiveProjection, confirmSelectorsVerified, orchestration, orchestrationMaxRetries, outputFormat }) => {
      // ── Inspection gate (v42) ────────────────────────────────────────────────
      // Advisory guards (warning text, a requiresVerifiedSelectors flag, an in-code
      // fail() guard) all lost to task-completion momentum: the agent stripped the
      // fail() and shipped the placeholder as a finished test. The structural fix is
      // to return NO code at all when a real app is targeted and there is no selector
      // source — there is then no scaffold to dress up. A live inspection session in
      // this process counts as a source; so does an explicit confirmSelectorsVerified
      // (rdb/Mobile Studio/source). The built-in ExperiBank demo (no app identifiers)
      // ships real working steps, so it is never gated.
      const targetsCustomApp = appId !== undefined || Boolean(packageName) || Boolean(bundleIdentifier);
      if (targetsCustomApp && confirmSelectorsVerified !== true && listActiveSessions().length === 0) {
        const blocked = {
          status: 'blocked',
          reason: 'no_verified_selectors',
          requiredAction: 'start_inspection_session',
          message:
            'Boilerplate generation is blocked: a real app is targeted but there is no selector source. ' +
            'Element IDs are app-specific and cannot be pre-filled — a scaffold generated now would be a placeholder ' +
            'with invalid selectors, which must NOT be presented as a finished test.',
          howToProceed: [
            'PREFERRED: call start_inspection_session, capture real element IDs (get_element_tree / open_mobile_studio), ' +
              'then re-call this tool while that session is still open.',
            'ALTERNATIVE: if you ALREADY captured real selectors elsewhere (rdb/UIAutomator dump, open_mobile_studio, ' +
              'get_automation_properties, or authoritative workspace source), re-call with confirmSelectorsVerified:true.',
          ],
        };
        const human = [
          '⛔ BLOCKED — no verified selectors for the targeted app.',
          '',
          'A real app is targeted (appId/packageName/bundleIdentifier) but no live inspection session exists, so this',
          'tool will NOT emit a placeholder scaffold — there would be nothing runnable to deliver, only invalid <…>',
          'selectors to fill in later.',
          '',
          'To proceed:',
          '  • PREFERRED — start_inspection_session, capture real element IDs (get_element_tree / open_mobile_studio),',
          '    then re-call get_test_boilerplate while that session is still open.',
          '  • ALTERNATIVE — if you already captured real selectors another way (rdb/UIAutomator dump, open_mobile_studio,',
          '    get_automation_properties, or authoritative workspace source), re-call with confirmSelectorsVerified:true.',
          '',
          'Do NOT work around this by writing the test from scratch — the selectors still have to be real.',
        ].join('\n');
        return { ...respond(outputFormat, blocked, human), isError: true };
      }

      // Active-profile accessors (not process.env) — generated boilerplate must
      // embed the active profile's credential, not the default profile's. With
      // env vars, switching to a project profile still embedded the admin credential.
      const accessKey = getActiveAccessKey();
      const rawBaseUrl = getActiveUrl();

      let instanceHost = rawBaseUrl;
      try {
        instanceHost = new URL(rawBaseUrl).hostname;
      } catch {
        // leave as raw value if URL parsing fails
      }

      // Auto-detect server mode via my-account-info — works for all user roles with Bearer Token.
      // undefined = lookup failed. Templates fall back to Grid (the conservative choice), but the orchestration
      // decision must not then claim the project IS Grid — it reports that the mode could not be determined.
      let detectedAppiumOss: boolean | undefined;
      try {
        const me = await getMyAccountInfo();
        detectedAppiumOss = me.project.isAppiumOss ?? false;
      } catch {
        // don't fail boilerplate generation on lookup error
      }
      const isAppiumOss = detectedAppiumOss ?? false;

      // Automotive projection is verified on Appium Server only; Grid sessions run a different execute layer.
      let automotive: { resolution: AutomotiveResolution; applied: boolean; note: string } | undefined;
      if (automotiveProjection) {
        if (platform === 'ios' && automotiveProjection !== '800x480') {
          return { content: [{ type: 'text', text: 'Error: CarPlay supports automotiveProjection "800x480" only.' }], isError: true };
        }
        automotive = isAppiumOss
          ? { resolution: automotiveProjection, applied: true, note: `digitalai:automotiveProjection=${automotiveProjection} set; the test captures the ${platform === 'ios' ? 'CarPlay' : 'Android Auto'} head unit after its steps. Use automotive_control in an inspection session to explore the head unit and pick tap coordinates.` }
          : { resolution: automotiveProjection, applied: false, note: detectedAppiumOss === undefined ? 'the project mode could not be determined, and projection is only supported here for Appium Server projects.' : 'this project runs on Appium Grid, which does not support projection commands (verified: the Grid execute layer runs digitalai:automotive.* as JavaScript and every command fails).' };
      }

      // Resolve app capabilities from appId if provided.
      let resolvedPackageName = packageName;
      let resolvedMainActivity = mainActivity;
      let resolvedBundleIdentifier = bundleIdentifier;
      let resolvedFromAppId = false;

      if (appId !== undefined) {
        try {
          const app = await getApplicationInfo(appId);
          if (platform === 'android') {
            if (app.packageName) resolvedPackageName = app.packageName;
            if (app.mainActivity) resolvedMainActivity = app.mainActivity;
          } else {
            if (app.bundleIdentifier) resolvedBundleIdentifier = app.bundleIdentifier;
          }
          resolvedFromAppId = true;
        } catch (e) {
          return {
            content: [{
              type: 'text',
              text: `Failed to look up application ID ${appId}: ${(e as Error).message}\n\nVerify the app ID with list_applications, or provide packageName/bundleIdentifier directly.`,
            }],
            isError: true,
          };
        }
      }

      // Clear demo steps whenever a custom (non-ExperiBank) app is specified.
      const clearTestBody = Boolean(
        platform === 'android' ? resolvedPackageName : resolvedBundleIdentifier
      );

      const vars = {
        accessKey,
        instanceUrl: rawBaseUrl,
        instanceHost,
        testName,
        deviceCategory,
        packageName: platform === 'android' ? resolvedPackageName : undefined,
        mainActivity: platform === 'android' ? resolvedMainActivity : undefined,
        bundleIdentifier: platform === 'ios' ? resolvedBundleIdentifier : undefined,
        clearTestBody,
        region,
        performanceTransactions: includePerformanceTransactions,
        axeScan: includeAxeScan,
        axeApiKey: process.env.AXE_DEVTOOLS_API_KEY,
        isAppiumOss,
        automotiveProjection: automotive?.applied ? automotive.resolution : undefined,
      };

      const files = getFilesForVariant(platform, language, isAppiumOss, projectType);

      // Grid scripts carry non-obvious workarounds (pinned clients, JWP capability
      // format, element wrappers). Once the file leaves this response, the
      // serverModeNote leaves with it — so the explanation must live IN the source.
      const gridHeader = (filename: string): string => {
        const isSource =
          filename.endsWith('.java') ||
          filename.endsWith('.py') ||
          (filename.endsWith('.js') && !filename.includes('wdio.conf'));
        if (isAppiumOss || !isSource) return '';
        const text =
          'WHY THIS LOOKS DIFFERENT FROM STANDARD APPIUM DOCS:\n' +
          'This script targets the Digital.ai Appium Grid — a proprietary JWP-era protocol that\n' +
          'predates the W3C WebDriver spec. The pinned client versions, desired-capabilities\n' +
          'session format, and element handling below are REQUIRED by that protocol.\n' +
          'Do not "upgrade" them to match current Appium documentation — the Grid will reject\n' +
          'the session (the error "Cant run Appium Grid with Appium client 8+" means the W3C\n' +
          'request format was rejected, not that your client is too new).\n' +
          'Projects configured for Appium Server (OSS) get standard W3C boilerplate instead.';
        if (filename.endsWith('.py')) {
          return text.split('\n').map(l => `# ${l}`).join('\n') + '\n\n';
        }
        return '/*\n' + text.split('\n').map(l => ` * ${l}`).join('\n') + '\n */\n\n';
      };

      try {
        const resolved = files.map(f => {
          const raw = readBoilerplateFile(platform, language, f.diskName);
          const substituted = substitute(raw, language, platform, vars);
          const content = f.diskName.startsWith('gradle')
            ? adaptGradleForProjectType(substituted, projectType)
            : substituted;
          return { ...f, content: gridHeader(f.filename) + content };
        });

        // ── Test Orchestrator (default ON for Java on Appium Server) ─────────────
        const decision = decideOrchestration({ mode: orchestration, language, isAppiumOss: detectedAppiumOss });
        let orchestrationInfo: OrchestrationInfo = { enabled: false, mode: orchestration, reason: decision.reason };
        if (decision.enabled) {
          const retries = resolveMaxRetryAttempts({
            requested: orchestrationMaxRetries,
            placeholderBody: clearTestBody,
            performanceTransactions: includePerformanceTransactions === true,
          });
          const prefix = projectType === 'android-gradle-submodule' ? 'e2e-tests/' : '';
          for (const f of resolved) {
            if (f.diskName.startsWith('gradle')) f.content = addOrchestrationToGradle(f.content);
            else if (f.diskName.startsWith('maven')) f.content = addOrchestrationToMaven(f.content);
          }
          // No root .gitignore is emitted (it would overwrite the user's). The two files that matter — the rendered
          // key-bearing config and the agent JAR — are ignored by .gitignore files inside directories we own.
          resolved.push(
            {
              filename: `${prefix}${CONFIG_TEMPLATE_PATH}`,
              diskName: '(generated)',
              lang: 'yaml',
              content: buildConfigTemplate({ instanceUrl: rawBaseUrl, maxRetryAttempts: retries.value }),
            },
            { filename: `${prefix}${ORCHESTRATOR_GITIGNORE_PATH}`, diskName: '(generated)', lang: 'gitignore', content: ORCHESTRATOR_GITIGNORE },
            { filename: `${prefix}${LIB_GITIGNORE_PATH}`, diskName: '(generated)', lang: 'gitignore', content: LIB_GITIGNORE },
          );
          // The agent manifest is only needed for a display string here — a missing/corrupt manifest must never sink
          // the boilerplate itself (install_test_orchestrator_agent reports the real error when it is actually needed).
          let agentSource = 'unknown — agent manifest unreadable; install_test_orchestrator_agent will report the cause';
          try {
            const src = resolveAgentSource();
            agentSource = src.label;
          } catch {
            // degrade to the label above
          }
          orchestrationInfo = {
            enabled: true,
            mode: orchestration,
            reason: decision.reason,
            maxRetryAttempts: retries.value,
            ...(retries.note && { maxRetryAttemptsNote: retries.note }),
            agent: {
              projectPath: `${prefix}${AGENT_PROJECT_PATH}`,
              installedByThisTool: false,
              howToInstall:
                'Call install_test_orchestrator_agent with this project\'s directory' +
                (prefix ? ' (the e2e-tests directory, not the Android root)' : '') +
                ` — it places the agent at ${prefix}${AGENT_PROJECT_PATH}. Until it is present the build runs WITHOUT orchestration (and says so).`,
              source: agentSource,
            },
            activation:
              'The agent attaches — and the Java 17 compile level applies — only when the JAR is present AND the DIGITAL_AI_ACCESS_KEY ' +
              'environment variable is set (the agent config requires the key; it is rendered from the env var at build time into ' +
              'orchestrator/rendered/, which is git-ignored, never into a tracked file). Otherwise the project builds and runs exactly like the classic boilerplate.',
            runCommands: { gradle: 'gradle test', maven: 'mvn test' },
            buildId: 'Set BUILD_ID (CI usually does) to group a build\'s results in Reporter; defaults to "local".',
            requirements: 'When attached: Java 17 or 21 JDK; JUnit 5 / TestNG 7+; Appium java-client 8–10 (this boilerplate uses 8.6.0).',
            jdkTrustNote: JDK_TRUST_NOTE,
            gitignore: GITIGNORE_ADVICE,
            logs: 'smart-agent/<run-id>/smartagent-main.log — add smart-agent/ to your .gitignore.',
          };
        }

        const structured = {
          platform,
          language,
          serverMode: isAppiumOss ? 'oss' : 'grid',
          serverModeNote: isAppiumOss
            ? 'Appium Server (OSS) — standard W3C WebDriver protocol. ' +
              'Java: java-client 8.x, Java 11+, UiAutomator2Options/XCUITestOptions (no DesiredCapabilities). ' +
              'Python: appium-python-client 4.x+, AppiumOptions. ' +
              'If you need Grid mode, switch to a Grid-enabled profile and regenerate — the APIs are incompatible.'
            : 'Appium Grid (legacy) — Digital.ai JWP-era protocol, NOT standard Appium Server. ' +
              'Java: java-client 7.6.0, Java 8+, DesiredCapabilities + AndroidElement. ' +
              'Python: appium-python-client 2.2.0 + selenium 4.9.0 pinned, desired_capabilities= dict. ' +
              'All workarounds in this boilerplate exist because of this protocol difference. ' +
              'Switching to an OSS profile requires regenerating the boilerplate — the client versions and capability classes differ.',
          deviceCategory,
          region: region ?? null,
          deviceQueryNote: region
            ? `deviceQuery scoped to region '${region}' — sessions will only route to devices in that region.`
            : "deviceQuery is region-unscoped. Sessions may route to devices in any region, including devices that have been offline for extended periods. Call find_available_device first to get a healthy region, then re-call get_test_boilerplate with that region value.",
          testName,
          projectType: projectType ?? 'standalone-gradle',
          files: resolved.map(f => ({ filename: f.filename, content: f.content })),
          orchestration: orchestrationInfo,
          ...(automotive ? { automotive } : {}),
          setupNote: setupNote(language, isAppiumOss, projectType),
          appNote: appNote(platform, vars.packageName, vars.bundleIdentifier, vars.mainActivity, resolvedFromAppId),
          parallelNote: language === 'python'
            ? 'Device farms support parallel test execution. Each test method already has its own setUp/tearDown session — no code changes needed. Install pytest-xdist (pip install pytest-xdist) and run: pytest -n auto -v. Check maxDevelopmentLicense via get_project_admin_settings to confirm your concurrency limit before scaling workers.'
            : null,
          credentialWarning: '⚠️ SECURITY: The access key embedded in these files is a live credential. Move it to an environment variable (DIGITAL_AI_ACCESS_KEY) and reference it from code before committing to source control.',
          // v38: when a custom app is targeted the test body is a placeholder, NOT a finished test.
          requiresVerifiedSelectors: clearTestBody,
          ...(clearTestBody && {
            placeholderWarning:
              'THIS IS NOT A RUNNABLE TEST. The test body is a placeholder with a deliberate fail()/raise guard and ' +
              'non-real <…> example selectors. Before this is usable you MUST replace the placeholder block with steps ' +
              'using element IDs captured from a live inspection (start_inspection_session -> get_element_tree, or ' +
              'open_mobile_studio), and obtain any credentials from the user. NEVER guess selectors from the package ' +
              'name and NEVER invent credentials. Do NOT present this scaffold to the user as a completed test.',
          }),
        };

        const platformLabel = platform === 'android' ? 'Android' : 'iOS';
        const langLabel: Record<Language, string> = {
          'java-junit5': 'Java JUnit5',
          'java-testng': 'Java TestNG',
          'nodejs':      'NodeJS (WebDriverIO)',
          'python':      'Python (Appium)',
        };

        const serverModeLabel = isAppiumOss ? 'Appium Server (OSS)' : 'Appium Grid';
        const regionLabel = region ? `Region: ${region}` : 'Region: unscoped (all regions)';
        const lines: string[] = [
          `# ${platformLabel} — ${langLabel[language]} Boilerplate (${serverModeLabel})`,
          '',
          `> **Setup:** ${setupNote(language, isAppiumOss, projectType)}`,
          `> **App:** ${appNote(platform, vars.packageName, vars.bundleIdentifier, vars.mainActivity, resolvedFromAppId)}`,
          `> **Device query:** ${regionLabel}${region ? '' : ' — re-call with region=<value> from find_available_device to scope to healthy devices only.'}`,
          `> ⚠️ **Security:** These files contain a live credential — move the access key to an environment variable (\`DIGITAL_AI_ACCESS_KEY\`) before committing to source control.`,
          '',
        ];
        if (orchestrationInfo.enabled && orchestrationInfo.agent) {
          lines.push(
            `> 🔁 **Test Orchestrator: ON** — retries failed tests up to ${orchestrationInfo.maxRetryAttempts}×, syncs real pass/fail to Reporter, ` +
            `groups runs by Build ID. Install the agent with \`install_test_orchestrator_agent\` (→ \`${orchestrationInfo.agent.projectPath}\`) and ` +
            'set `DIGITAL_AI_ACCESS_KEY`; until both are in place the project builds and runs exactly like the classic boilerplate (Gradle prints why). ' +
            'Pass `orchestration: "off"` for the classic boilerplate.' + (orchestrationInfo.maxRetryAttemptsNote ? ` ${orchestrationInfo.maxRetryAttemptsNote}` : ''),
            '> **Java/TLS:** when attached, the agent needs Java 17/21 — use a current update. Older builds (e.g. 21.0.2) lack the cloud\'s root CA ' +
              '("SSL.com TLS RSA Root CA 2022"), so the agent\'s Reporter status sync fails silently.',
            `> **.gitignore:** ${GITIGNORE_ADVICE}`,
            '',
          );
        } else if (decision.requestedButNotApplied) {
          lines.push(`> ⚠️ **Test Orchestrator requested but not applied:** ${decision.reason} Generated the classic boilerplate instead.`, '');
        }
        if (automotive) {
          lines.push(automotive.applied
            ? `> 🚗 **Automotive projection: ON** — ${automotive.note}`
            : `> ⚠️ **Automotive projection requested but not applied:** ${automotive.note} Generated the classic boilerplate instead.`, '');
        }
        if (clearTestBody) {
          lines.push(
            '> ⛔ **NOT A FINISHED TEST.** The test body is a placeholder with a deliberate fail-guard and ' +
            'non-real `<…>` example selectors. Replace it with steps using element IDs from a live inspection ' +
            '(`start_inspection_session` → `get_element_tree`, or `open_mobile_studio`) and get credentials from ' +
            'the user. Never guess selectors from the package name; never invent credentials; never deliver this scaffold as-is.',
            '',
          );
        }

        for (const f of resolved) {
          if (f.isInstructions) {
            lines.push(`## Setup Steps`);
            lines.push('');
            lines.push('```sh');
            lines.push(f.content.trim());
            lines.push('```');
          } else {
            lines.push(`## ${f.filename}`);
            lines.push('');
            lines.push('```' + f.lang);
            lines.push(f.content.trim());
            lines.push('```');
          }
          lines.push('');
        }

        return respond(outputFormat, structured, lines.join('\n'));
      } catch (e) {
        return {
          content: [{
            type: 'text',
            text: `Failed to read boilerplate files: ${(e as Error).message}\n\nEnsure the running build is up to date — the resources/boilerplate directory must be present. ${staleBuildRemedy()}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ── install_test_orchestrator_agent ──────────────────────────────────────────
  // The agent JAR is binary (~12 MB) and cannot travel inside get_test_boilerplate's text response. Under the
  // npm/local install the server can write it straight into the user's project; under Docker/remote it cannot
  // reach the user's filesystem, so it returns a checksum-verifying download command instead. Mode-dependent
  // wording comes from the shared locality builders (evaluated once, at registration).
  const localFs = isLocalFilesystem();
  server.tool(
    'install_test_orchestrator_agent',
    'Install the Digital.ai Test Orchestrator agent (smart-agent.jar) into a test project generated by ' +
    'get_test_boilerplate with orchestration enabled — it belongs at <projectDir>/lib/smart-agent.jar, where the ' +
    'generated Gradle/Maven wiring looks for it (for android-gradle-submodule that is the e2e-tests directory, NOT the ' +
    'Android root). The JAR is not shipped with this server: it is downloaded on demand and always verified against a ' +
    'pinned SHA-256 before it is used — by default from the Digital.ai sample repository at a fixed commit, or from ' +
    'TEST_ORCHESTRATOR_JAR_URL + TEST_ORCHESTRATOR_JAR_SHA256 when configured. If the download fails, the response says ' +
    'where to get the file and how to verify it; the generated project keeps working without it. ' + serverFsInstallNotice(),
    {
      projectDir: z.string().optional().describe(serverFsProjectDirParam()),
      outputFormat: outputFormatParam,
    },
    async ({ projectDir, outputFormat }) => {
      let source;
      try {
        source = resolveAgentSource();
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: cannot resolve the Test Orchestrator agent: ${(e as Error).message} ${staleBuildRemedy()}` }], isError: true };
      }

      if (!localFs) {
        const cmds = buildAgentDownloadCommands(source);
        const structured = {
          installed: false,
          reason: 'MCP server runs in Docker/remote — it cannot write to your filesystem.',
          source: source.kind,
          downloadUrl: source.downloadUrl,
          sha256: source.sha256,
          commands: cmds,
          target: AGENT_PROJECT_PATH,
          sourceLabel: source.label,
          ...(source.homepage && { homepage: source.homepage }),
          runFrom: 'the directory that must receive lib/smart-agent.jar: the generated test project root — for an android-gradle-submodule project, the e2e-tests directory, not the Android root.',
        };
        const human = [
          'Run ONE of these from the directory that must receive lib/smart-agent.jar — the generated test project root',
          '(for an android-gradle-submodule project: the e2e-tests directory, NOT the Android root):',
          '',
          'bash / Git Bash / macOS:',
          '```sh',
          cmds.bash,
          '```',
          'PowerShell:',
          '```powershell',
          cmds.powershell,
          '```',
          `Both verify SHA-256 ${source.sha256} and delete the file on a mismatch, so an unverified JAR is never left where the build would attach it.`,
          `Source: ${source.label}${source.homepage ? ` — ${source.homepage}` : ''}. Without it the project still builds and runs, just without orchestration.`,
        ].join('\n');
        return respond(outputFormat, structured, human);
      }

      if (!projectDir) {
        return { content: [{ type: 'text' as const, text: 'Error: projectDir is required — pass the absolute path of the generated project root (it must already exist).' }], isError: true };
      }
      const pathError = validateOutputPath(projectDir);
      if (pathError) return { content: [{ type: 'text' as const, text: `Error: ${pathError}` }], isError: true };

      try {
        const result = await installAgentIntoProject(projectDir, source);
        const warning = result.buildFileFound
          ? undefined
          : `⚠️ No build.gradle / build.gradle.kts / pom.xml found in ${projectDir}. The agent was written, but the generated wiring only looks for lib/smart-agent.jar in the project root (for android-gradle-submodule: the e2e-tests directory). Check the path.`;
        const structured = {
          installed: true,
          path: result.path,
          bytes: result.bytes,
          sha256: result.sha256,
          replacedExisting: result.replaced,
          buildFileFound: result.buildFileFound,
          ...(warning && { warning }),
          source: { kind: source.kind, label: source.label, url: source.downloadUrl },
          nextStep: 'Set DIGITAL_AI_ACCESS_KEY in the environment, then run gradle test / mvn test — the agent attaches automatically.',
        };
        const human =
          `✅ Test Orchestrator agent ${result.replaced ? 'updated' : 'installed'}: ${result.path} (${(result.bytes / 1048576).toFixed(1)} MB, sha256 ${result.sha256}).\n` +
          `Source: ${source.label} (SHA-256 verified).\n` +
          (warning ? warning + '\n' : '') +
          'Next: set DIGITAL_AI_ACCESS_KEY, then run `gradle test` or `mvn test`.';
        return respond(outputFormat, structured, human);
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error installing the Test Orchestrator agent: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── validate_test_script (v43 Fix D — delivery backstop) ───────────────────
  server.tool(
    'validate_test_script',
    'Backstop check for a generated or hand-written mobile test BEFORE you present or save it. ' +
    'Pass the full script content; this scans for the markers of a non-functional test: unreplaced ' +
    '<…> placeholder selectors, the deliberate scaffold fail-guard, placeholder/fabricated credentials, ' +
    'and resource IDs from a known prior fabrication incident. Returns isError when any high-severity ' +
    'pattern is found — a test that fails this is NOT runnable and must not be delivered as finished. ' +
    'This catches the case the get_test_boilerplate gate cannot: a script you wrote yourself with guessed ' +
    'selectors. A clean result is necessary but not sufficient — it cannot confirm selectors are REAL, only ' +
    'that obvious placeholders are gone; the authoritative source for selectors is still a live inspection.',
    {
      scriptContent: z.string().describe('The full text of the test script to validate.'),
      fileName: z.string().optional().describe('Optional file name, used only to label the result.'),
      outputFormat: outputFormatParam,
    },
    async ({ scriptContent, fileName, outputFormat }) => {
      const issues = detectFabricationIssues(scriptContent);
      const high = issues.filter((i) => i.severity === 'high');
      const label = fileName ? ` (${fileName})` : '';
      const verdict = high.length > 0 ? 'fail' : 'pass';

      const structured = {
        verdict,
        highSeverityCount: high.length,
        issues,
        guidance:
          high.length > 0
            ? 'Do NOT present this script as a finished test. Replace every flagged placeholder with element IDs ' +
              'captured from a live inspection (start_inspection_session -> get_element_tree, or open_mobile_studio), ' +
              'and obtain real credentials from the user.'
            : 'No placeholder/fabrication markers found. This does NOT prove the selectors are real — only that obvious ' +
              'placeholders are absent. If you did not capture these from an inspection or app source, verify before delivering.',
      };

      const lines = [
        `${verdict === 'fail' ? '⛔ FAIL' : '✅ PASS'} — validate_test_script${label}`,
        '',
        ...(issues.length
          ? issues.map((i) => `  ${i.severity === 'high' ? '⛔' : 'ℹ️'} [${i.label}] ${i.detail}`)
          : ['  No issues detected.']),
        '',
        structured.guidance,
      ];

      const res = respond(outputFormat, structured, lines.join('\n'));
      return high.length > 0 ? { ...res, isError: true } : res;
    }
  );

  // ── get_web_test_boilerplate ───────────────────────────────────────────────
  server.tool(
    'get_web_test_boilerplate',
    'Generate a Selenium WebDriver test script for web browser automation against the Digital.ai Selenium Grid. ' +
    '\n\n' +
    'GATE: If a target URL is provided (real site), a live browser inspection session must exist ' +
    '(start_browser_inspection_session → get_page_dom / find_web_elements) OR confirmSelectorsVerified must be true. ' +
    'This prevents fabricated CSS selectors from being shipped as finished tests.\n\n' +
    'By default, the generated test is BROWSER-NEUTRAL — it reads the browser name from an environment variable ' +
    'or config at runtime, so a single script runs on Chrome, Firefox, Edge, or Safari without code changes. ' +
    'Set targetBrowser to generate browser-specific setup code (ChromeOptions, FirefoxOptions, etc.).\n\n' +
    'When shadowDomSupport is enabled, a shadowQuery() helper is included for interacting with elements ' +
    'inside Shadow DOM trees (React, Angular, Web Components).',
    {
      language: z
        .enum(['java-junit5', 'java-testng', 'nodejs', 'python'])
        .describe('Target language and test framework.'),
      testName: z
        .string()
        .optional()
        .default('WebTest')
        .describe('Name for the generated test class/function. Default: "WebTest".'),
      url: z
        .string()
        .optional()
        .describe('Target URL being tested, e.g. "https://our-app.com". Used to fill in navigate calls.'),
      targetBrowser: z
        .string()
        .optional()
        .describe(
          'Generate browser-specific setup code for this browser: "chrome", "firefox", "MicrosoftEdge", "safari" or "opera" ' +
          '(names as list_available_browsers returns them; "edge" is accepted for MicrosoftEdge). ' +
          'If omitted (default), generates browser-neutral code using a BROWSER environment variable.'
        ),
      shadowDomSupport: z
        .enum(['auto', 'always', 'never'])
        .optional()
        .default('auto')
        .describe(
          '"auto" (default): include shadow DOM helper when a live session detected shadow roots. ' +
          '"always": always include the shadowQuery helper. ' +
          '"never": omit the shadow DOM helper.'
        ),
      confirmSelectorsVerified: z
        .boolean()
        .optional()
        .describe(
          'Set to true when CSS selectors were captured from a live browser inspection session ' +
          '(get_page_dom / find_web_elements) or authoritative source. Required when url is provided and no ' +
          'live browser session exists.'
        ),
      outputFormat: outputFormatParam,
    },
    async (args) => {
      const language = args.language;
      const testName = args.testName ?? 'WebTest';
      const targetUrl = args.url ?? '';
      // The grid matches browserName case-sensitively: "microsoftedge" → 400 "No browser found matching the desired
      // capabilities" (verified live 2026-10-09), so a plain toLowerCase() broke Edge. Map to the names
      // list_available_browsers returns; anything else passes through unchanged.
      const targetBrowser = canonicalBrowserName(args.targetBrowser);
      const shadowDomSupport = args.shadowDomSupport ?? 'auto';

      // Gate: if a real URL is specified, require a live browser session or explicit selector confirmation.
      const targetsRealSite = !!targetUrl;
      if (targetsRealSite) {
        const liveBrowserSessions = listActiveSessions().filter((s) => s.platform === 'web');
        const hasLiveSession = liveBrowserSessions.length > 0;
        if (!hasLiveSession && !args.confirmSelectorsVerified) {
          const structured = {
            status: 'blocked',
            reason: 'no_verified_selectors',
            message:
              'Cannot generate a web test for a real URL without verified selectors. ' +
              'Start a browser inspection session first (start_browser_inspection_session), navigate to the target URL, ' +
              'discover element selectors with get_page_dom and find_web_elements, ' +
              'then call get_web_test_boilerplate again. ' +
              'Alternatively, pass confirmSelectorsVerified: true if selectors were captured from a prior session or authoritative source.',
            instructions: [
              '1. start_browser_inspection_session(inspectionBrowser="chrome")',
              '2. navigate_to(handle, "' + targetUrl + '")',
              '3. get_page_dom(handle) — inspect elements; use find_web_elements to verify specific selectors',
              '4. take_inspection_screenshot(handle) — confirm each step visually',
              '5. stop_browser_inspection_session(handle)',
              '6. get_web_test_boilerplate(language="' + language + '", url="' + targetUrl + '", confirmSelectorsVerified=true)',
            ],
          };
          return { ...respond(args.outputFormat, structured, structured.message), isError: true as const };
        }
      }

      const accessKey = getActiveAccessKey() || '[Enter Your Access key here]';
      const baseUrl = getActiveUrl() || '[Enter Instance here]';
      const gridUrl = `${baseUrl}/wd/hub`;

      // Decide whether to include shadow DOM helper.
      // For 'auto', check if the live session detected shadow roots.
      let includeShadowHelper = false;
      if (shadowDomSupport === 'always') {
        includeShadowHelper = true;
      } else if (shadowDomSupport === 'auto') {
        const browserSession = listActiveSessions().find((s) => s.platform === 'web');
        // We can't detect shadow DOM without the session's DOM result, so 'auto' includes
        // the helper if the user had any browser session open (they likely encountered SPAs).
        includeShadowHelper = !!browserSession;
      }

      // ── Inline templates ────────────────────────────────────────────────────

      function webFailGuard(lang: string, indent: string): string {
        const msg = 'Replace this placeholder with real CSS selectors captured from get_page_dom / find_web_elements. Do not run the scaffold as-is.';
        switch (lang) {
          case 'java-junit5':
            return `${indent}org.junit.jupiter.api.Assertions.fail("${msg}");`;
          case 'java-testng':
            return `${indent}org.testng.Assert.fail("${msg}");`;
          case 'python':
            return `${indent}raise NotImplementedError("${msg}")`;
          default:
            return `${indent}throw new Error('${msg}');`;
        }
      }

      function webPlaceholderBody(lang: string, indent: string, url: string): string {
        const c = lang === 'python' ? '#' : '//';
        const banner = [
          `${indent}${c} ============================================================================`,
          `${indent}${c} ⛔ PLACEHOLDER TEST BODY — NOT A RUNNABLE TEST. This is scaffolding only.`,
          `${indent}${c} Replace this block with steps built from selectors discovered LIVE:`,
          `${indent}${c}   start_browser_inspection_session -> get_page_dom / find_web_elements`,
          `${indent}${c} NEVER guess CSS selectors from the page title or URL.`,
          `${indent}${c} NEVER invent credentials — ask the user for login details.`,
          `${indent}${c} ============================================================================`,
        ].join('\n');

        const nav = url ? `"${url}"` : '"[Enter target URL here]"';
        let examples: string;
        if (lang === 'java-junit5' || lang === 'java-testng') {
          examples = [
            `${indent}${c} Example shape — replace <…> with selectors from get_page_dom / find_web_elements:`,
            `${indent}${c}   driver.get(${nav});`,
            `${indent}${c}   driver.findElement(By.cssSelector("<CSS selector from find_web_elements>")).click();`,
            `${indent}${c}   driver.findElement(By.cssSelector("input[name='<name attr>']")).sendKeys("<value>");`,
            `${indent}${c}   driver.findElement(By.id("<id from get_page_dom>")).click();`,
          ].join('\n');
        } else if (lang === 'python') {
          examples = [
            `${indent}${c} Example shape — replace <…> with selectors from get_page_dom / find_web_elements:`,
            `${indent}${c}   self.driver.get(${nav})`,
            `${indent}${c}   self.driver.find_element(By.CSS_SELECTOR, "<CSS selector from find_web_elements>").click()`,
            `${indent}${c}   self.driver.find_element(By.CSS_SELECTOR, "input[name='<name attr>']").send_keys("<value>")`,
            `${indent}${c}   self.driver.find_element(By.ID, "<id from get_page_dom>").click()`,
          ].join('\n');
        } else {
          examples = [
            `${indent}${c} Example shape — replace <…> with selectors from get_page_dom / find_web_elements:`,
            `${indent}${c}   await browser.url(${nav});`,
            `${indent}${c}   await $('<CSS selector from find_web_elements>').click();`,
            `${indent}${c}   await $("input[name='<name attr>']").setValue('<value>');`,
            `${indent}${c}   await $('#<id from get_page_dom>').click();`,
          ].join('\n');
        }

        return [banner, webFailGuard(lang, indent), examples].join('\n');
      }

      function shadowHelperJava(): string {
        return [
          `    // Shadow DOM traversal helper — use when elements are inside a custom element's shadowRoot`,
          `    // (React, Angular, Vue, Web Components). Host = the custom element; selector = CSS inside shadow root.`,
          `    private WebElement shadowQuery(WebElement host, String cssSelector) {`,
          `        return (WebElement) ((JavascriptExecutor) driver)`,
          `            .executeScript("return arguments[0].shadowRoot.querySelector(arguments[1])", host, cssSelector);`,
          `    }`,
          `    // Usage: WebElement btn = shadowQuery(driver.findElement(By.tagName("my-component")), "button.submit");`,
        ].join('\n');
      }

      function shadowHelperPython(): string {
        return [
          `    # Shadow DOM traversal helper — use when elements are inside a custom element's shadow root`,
          `    # Host = the custom element; selector = CSS inside shadow root.`,
          `    def shadow_query(self, host, css_selector):`,
          `        return self.driver.execute_script(`,
          `            "return arguments[0].shadowRoot.querySelector(arguments[1])", host, css_selector`,
          `        )`,
          `    # Usage: btn = self.shadow_query(self.driver.find_element(By.TAG_NAME, "my-component"), "button.submit")`,
        ].join('\n');
      }

      function shadowHelperNodejs(): string {
        return [
          `// Shadow DOM traversal helper — use when elements are inside a custom element's shadow root`,
          `async function shadowQuery(host, cssSelector) {`,
          `    return await browser.execute(`,
          `        (el, sel) => el.shadowRoot.querySelector(sel), host, cssSelector`,
          `    );`,
          `}`,
          `// Usage: const btn = await shadowQuery(await $('my-component'), 'button.submit');`,
          `// Note: shadow DOM elements cannot be found with $() — use shadowQuery() then interact via .click()/.setValue().`,
        ].join('\n');
      }

      function browserCapJava(browser: string | undefined): string {
        if (!browser) {
          return [
            `        // BROWSER-NEUTRAL: reads browser name from BROWSER env var at runtime.`,
            `        // Change BROWSER=chrome / firefox / MicrosoftEdge / safari / opera without touching this file.`,
            `        String browserName = System.getenv().getOrDefault("BROWSER", "chrome");`,
            `        MutableCapabilities caps = new MutableCapabilities();`,
            `        caps.setCapability("browserName", browserName);`,
          ].join('\n');
        }
        switch (browser) {
          case 'chrome':
            return [
              `        ChromeOptions caps = new ChromeOptions();`,
            ].join('\n');
          case 'firefox':
            return [
              `        FirefoxOptions caps = new FirefoxOptions();`,
            ].join('\n');
          case 'safari':
            return [
              `        SafariOptions caps = new SafariOptions();`,
            ].join('\n');
          default:
            return [
              `        // Browser: ${browser}`,
              `        MutableCapabilities caps = new MutableCapabilities();`,
              `        caps.setCapability("browserName", "${browser}");`,
            ].join('\n');
        }
      }

      function browserImportsJava(browser: string | undefined): string {
        if (!browser) return 'import org.openqa.selenium.MutableCapabilities;';
        switch (browser) {
          case 'chrome':  return 'import org.openqa.selenium.chrome.ChromeOptions;';
          case 'firefox': return 'import org.openqa.selenium.firefox.FirefoxOptions;';
          case 'safari':  return 'import org.openqa.selenium.safari.SafariOptions;';
          default: return 'import org.openqa.selenium.MutableCapabilities;';
        }
      }

      // ── Generate the template ───────────────────────────────────────────────

      let code: string;
      let filename: string;
      // "ExampleWebTest" must not become "ExampleWebTestTest" (UAT 2026-10-09) — add the suffix only when missing.
      const testClass = /Test$/.test(testName) ? testName : `${testName}Test`;

      if (language === 'java-junit5' || language === 'java-testng') {
        const framework = language === 'java-junit5' ? 'junit5' : 'testng';
        filename = `${testClass}.java`;
        const isJunit5 = language === 'java-junit5';
        const beforeAnn  = isJunit5 ? '@BeforeAll' : '@BeforeClass';
        const afterAnn   = isJunit5 ? '@AfterAll' : '@AfterClass';
        const testAnn    = '@Test';
        const lifecycle  = isJunit5 ? '@TestInstance(TestInstance.Lifecycle.PER_CLASS)\n' : '';
        const assertion  = isJunit5 ? 'import org.junit.jupiter.api.*;' : 'import org.testng.annotations.*;';
        const byImport   = 'import org.openqa.selenium.By;';
        const browserCap = browserCapJava(targetBrowser);
        const browserImp = browserImportsJava(targetBrowser);
        const shadowHelper = includeShadowHelper ? '\n\n' + shadowHelperJava() : '';
        const placeholder = webPlaceholderBody(language, '        ', targetUrl);

        code = [
          `package com.example.tests;`,
          ``,
          `${assertion}`,
          `${byImport}`,
          `import org.openqa.selenium.JavascriptExecutor;`,
          `import org.openqa.selenium.WebElement;`,
          `import org.openqa.selenium.remote.RemoteWebDriver;`,
          `${browserImp}`,
          ``,
          `import java.net.MalformedURLException;`,
          `import java.net.URL;`,
          `import java.time.Duration;`,
          ``,
          `${lifecycle}public class ${testClass} {`,
          ``,
          `    private RemoteWebDriver driver;`,
          ``,
          `    private static final String ACCESS_KEY = "${accessKey}";`,
          `    private static final String GRID_URL   = "${gridUrl}";`,
          ``,
          `    ${beforeAnn}`,
          `    ${isJunit5 ? '' : 'public static '}void setUp() throws MalformedURLException {`,
          `${browserCap}`,
          `        caps.setCapability("digitalai:accessKey", ACCESS_KEY);`,
          `        caps.setCapability("digitalai:reportName", "${testName}");`,
          ``,
          `        driver = new RemoteWebDriver(new URL(GRID_URL), caps);`,
          `        driver.manage().timeouts().implicitlyWait(Duration.ofSeconds(10));`,
          `        driver.manage().window().maximize();`,
          `    }`,
          ``,
          `    ${afterAnn}`,
          `    ${isJunit5 ? '' : 'public static '}void tearDown() {`,
          `        if (driver != null) driver.quit();`,
          `    }${shadowHelper}`,
          ``,
          `    ${testAnn}`,
          `    ${isJunit5 ? 'void' : 'public void'} testScenario() {`,
          `${placeholder}`,
          `    }`,
          `}`,
        ].join('\n');

        // Build script (Maven + Gradle)
        const pom = [
          `<project>`,
          `  <modelVersion>4.0.0</modelVersion>`,
          `  <groupId>com.example</groupId>`,
          `  <artifactId>selenium-tests</artifactId>`,
          `  <version>1.0</version>`,
          `  <dependencies>`,
          `    <dependency>`,
          `      <groupId>org.seleniumhq.selenium</groupId>`,
          `      <artifactId>selenium-java</artifactId>`,
          `      <version>4.20.0</version>`,
          `    </dependency>`,
          framework === 'junit5' ? [
            `    <dependency>`,
            `      <groupId>org.junit.jupiter</groupId>`,
            `      <artifactId>junit-jupiter</artifactId>`,
            `      <version>5.10.0</version>`,
            `      <scope>test</scope>`,
            `    </dependency>`,
          ].join('\n') : [
            `    <dependency>`,
            `      <groupId>org.testng</groupId>`,
            `      <artifactId>testng</artifactId>`,
            `      <version>7.9.0</version>`,
            `      <scope>test</scope>`,
            `    </dependency>`,
          ].join('\n'),
          `  </dependencies>`,
          `</project>`,
        ].join('\n');

        const structured = {
          language,
          testName,
          targetBrowser: targetBrowser ?? 'browser-neutral (env var BROWSER)',
          shadowDomSupportIncluded: includeShadowHelper,
          files: [
            { filename, language: 'java', content: code },
            { filename: 'pom.xml', language: 'xml', content: pom },
          ],
          guidance: [
            'Replace the placeholder test body with selectors from get_page_dom / find_web_elements.',
            'Set BROWSER=chrome (or firefox/MicrosoftEdge/safari) in your environment to choose the browser at runtime.',
            `Grid URL: ${gridUrl}`,
            includeShadowHelper ? 'Shadow DOM helper included — use shadowQuery(hostEl, cssSelector) for Web Components.' : '',
          ].filter(Boolean),
        };

        const humanText = [
          `Generated: ${filename}`,
          `Browser: ${targetBrowser ?? 'neutral (BROWSER env var)'}`,
          includeShadowHelper ? 'Shadow DOM helper: included' : '',
          ``,
          '```java',
          code,
          '```',
          ``,
          '```xml',
          pom,
          '```',
        ].filter((l) => l !== undefined).join('\n');

        const res = respond(args.outputFormat, structured, humanText);
        return res;
      }

      if (language === 'python') {
        filename = `test_${testName.toLowerCase()}.py`;
        const browserCap = targetBrowser
          ? `caps["browserName"] = "${targetBrowser}"`
          : [
              `# BROWSER-NEUTRAL: reads browser name from BROWSER env var at runtime.`,
              `        browser_name = os.environ.get("BROWSER", "chrome")`,
              `        caps["browserName"] = browser_name`,
            ].join('\n        ');
        const shadowHelper = includeShadowHelper ? '\n\n' + shadowHelperPython() : '';
        const placeholder = webPlaceholderBody(language, '        ', targetUrl);

        code = [
          `import os`,
          `import unittest`,
          `from selenium import webdriver`,
          `from selenium.webdriver.common.by import By`,
          `from selenium.webdriver.remote.webdriver import WebDriver`,
          ``,
          ``,
          `class ${testClass}(unittest.TestCase):`,
          ``,
          `    ACCESS_KEY = "${accessKey}"`,
          `    GRID_URL   = "${gridUrl}"`,
          ``,
          `    def setUp(self):`,
          `        caps = {}`,
          `        ${browserCap}`,
          `        caps["digitalai:accessKey"] = self.ACCESS_KEY`,
          `        caps["digitalai:reportName"] = "${testName}"`,
          ``,
          `        self.driver = webdriver.Remote(`,
          `            command_executor=self.GRID_URL,`,
          `            desired_capabilities=caps`,
          `        )`,
          `        self.driver.implicitly_wait(10)`,
          `        self.driver.maximize_window()`,
          ``,
          `    def tearDown(self):`,
          `        if self.driver:`,
          `            self.driver.quit()${shadowHelper}`,
          ``,
          `    def test_scenario(self):`,
          `${placeholder}`,
          ``,
          ``,
          `if __name__ == "__main__":`,
          `    unittest.main()`,
        ].join('\n');

        const requirements = [
          `selenium>=4.20.0`,
        ].join('\n');

        const structured = {
          language,
          testName,
          targetBrowser: targetBrowser ?? 'browser-neutral (env var BROWSER)',
          shadowDomSupportIncluded: includeShadowHelper,
          files: [
            { filename, language: 'python', content: code },
            { filename: 'requirements.txt', language: 'text', content: requirements },
          ],
          guidance: [
            'Replace the placeholder test body with selectors from get_page_dom / find_web_elements.',
            'Set BROWSER=chrome (or firefox/microsoftedge/safari) in your environment.',
            `Grid URL: ${gridUrl}`,
          ],
        };

        const humanText = [
          `Generated: ${filename}`,
          `Browser: ${targetBrowser ?? 'neutral (BROWSER env var)'}`,
          ``,
          '```python',
          code,
          '```',
          ``,
          '```text',
          requirements,
          '```',
        ].join('\n');

        return respond(args.outputFormat, structured, humanText);
      }

      // Node.js / WebdriverIO
      filename = `test.${testName.toLowerCase()}.js`;
      const shadowHelper = includeShadowHelper ? '\n\n' + shadowHelperNodejs() : '';
      const placeholder = webPlaceholderBody(language, '    ', targetUrl);
      const browserCapNode = targetBrowser
        ? `browserName: '${targetBrowser}'`
        : [
            `// BROWSER-NEUTRAL: reads browser name from BROWSER env var at runtime.`,
            `            browserName: process.env.BROWSER || 'chrome'`,
          ].join('\n            ');

      const wdioConf = [
        `// wdio.conf.js — Digital.ai Selenium Grid configuration`,
        `exports.config = {`,
        `    hostname: '${baseUrl.replace(/^https?:\/\//, '')}',`,
        `    path: '/wd/hub',`,
        `    port: 443,`,
        `    protocol: 'https',`,
        `    capabilities: [{`,
        `        ${browserCapNode},`,
        `        'digitalai:accessKey': '${accessKey}',`,
        `        'digitalai:reportName': '${testName}',`,
        `    }],`,
        `    framework: 'mocha',`,
        `    reporters: ['spec'],`,
        `    specs: ['./test.*.js'],`,
        `    mochaOpts: { timeout: 60000 },`,
        `};`,
      ].join('\n');

      code = [
        `// ${filename}`,
        `// Digital.ai Selenium Grid — browser-neutral web test`,
        `// Run: npx wdio run wdio.conf.js`,
        `${shadowHelper}`,
        `describe('${testName}', () => {`,
        `    it('test scenario', async () => {`,
        `${placeholder}`,
        `    });`,
        `});`,
      ].join('\n');

      const structured = {
        language,
        testName,
        targetBrowser: targetBrowser ?? 'browser-neutral (env var BROWSER)',
        shadowDomSupportIncluded: includeShadowHelper,
        files: [
          { filename: 'wdio.conf.js', language: 'javascript', content: wdioConf },
          { filename, language: 'javascript', content: code },
          { filename: 'package.json', language: 'json', content: JSON.stringify({ scripts: { test: 'npx wdio run wdio.conf.js' }, devDependencies: { '@wdio/cli': '^8.0.0', '@wdio/local-runner': '^8.0.0', '@wdio/mocha-framework': '^8.0.0', '@wdio/spec-reporter': '^8.0.0' } }, null, 2) },
        ],
        guidance: [
          'Replace the placeholder test body with selectors from get_page_dom / find_web_elements.',
          'Set BROWSER=chrome (or firefox/MicrosoftEdge/safari) in your environment.',
          `Grid URL: ${gridUrl}`,
        ],
      };

      const humanText = [
        `Generated: ${filename}`,
        `Browser: ${targetBrowser ?? 'neutral (BROWSER env var)'}`,
        ``,
        '```javascript',
        wdioConf,
        '```',
        ``,
        '```javascript',
        code,
        '```',
      ].join('\n');

      return respond(args.outputFormat, structured, humanText);
    }
  );
}
