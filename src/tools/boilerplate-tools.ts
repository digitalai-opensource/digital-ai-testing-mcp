import { z } from 'zod';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getMyAccountInfo } from '../api/users.js';
import { getApplicationInfo } from '../api/applications.js';
import { getActiveAccessKey, getActiveUrl } from '../api/client.js';
import { listActiveSessions } from '../api/webdriver.js';
import { outputFormatParam, respond } from '../utils/output-format.js';

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

const BOILERPLATE_DIR = join(process.cwd(), 'resources', 'boilerplate');

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
  const angle = content.match(/<[^>\n]*(resource-id|selector|element|value|visible text|udid|enter |your )[^>\n]*>/gi);
  if (angle) add('high', 'placeholder selectors', `Unreplaced placeholder token(s): ${[...new Set(angle)].slice(0, 4).join(', ')}`);

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
  return readFileSync(join(dir, diskName), 'utf-8');
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
      if (vars.performanceTransactions) {
        placeholder = wrapWithPerformanceTransaction(language, indent, placeholder);
      }
      result = result.replace(DEMO_STEP_PATTERN, placeholder);
    } else if (vars.performanceTransactions || vars.axeScan) {
      result = result.replace(DEMO_INNER_PATTERN, (inner) => {
        let content = inner;
        if (vars.axeScan) {
          content += '\n' + appendAxeScan(language, indent, vars.axeApiKey ?? '');
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
        'IMPORTANT: Do NOT run npm init wdio — it installs wdio v9 which is rejected by\n' +
        '  the Digital.ai Appium Grid ("Cant run Appium Grid with Appium client 8+").\n' +
        '  The package.json above pins wdio to v7.40.0, which is the last compatible version.'
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
    '  2. get_test_boilerplate — generate starter test with capabilities pre-filled (this tool)\n' +
    '  3. open_mobile_studio OR get_automation_properties — inspect live element IDs (no ADB required)\n' +
    '  4. list_active_sessions + release_orphaned_sessions(maxAgeHours=4, dryRun=true) — pre-flight device check\n' +
    '  5. find_available_device — select a healthy device in a known region\n' +
    '  6. [write / run test]\n' +
    '  7. release_device — explicit cleanup on completion\n\n' +
    'ELEMENT INSPECTION — preferred path: call open_mobile_studio first. It is the platform\'s native UI Inspector — ' +
    'shows resource IDs, XPaths, and accessibility IDs in a live interactive tree with zero local tooling. ' +
    'For programmatic extraction, use get_automation_properties. ' +
    'rdb / adb is a fallback for scenarios that need direct shell access (file push, side-loaded installs). ' +
    'Do NOT use adb shell uiautomator dump on Android 15+ Samsung devices — it exits silently without output on those devices; use open_mobile_studio instead.\n\n' +
    'IMPORTANT: The generated script is an end-product artifact — do NOT execute it as a discovery or inspection step. ' +
    'Running it without known element selectors creates Incomplete sessions in the reporter (visible to the whole team) ' +
    'that cannot be retroactively closed. Use open_mobile_studio or get_automation_properties for any live inspection before this tool.\n\n' +
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
          '(2) injects driver.executeScript("mobile: axeScan", settings) into the test body after the test steps. ' +
          'The Axe API key is read from AXE_DEVTOOLS_API_KEY in the MCP environment; if not set, a placeholder is used. ' +
          'Scan results appear in the Axe DevTools Mobile dashboard. ' +
          'Can be combined with includePerformanceTransactions — the scan runs inside the performance transaction boundary.'
        ),
      confirmSelectorsVerified: z
        .boolean()
        .optional()
        .describe(
          'Escape hatch for the inspection gate. When you target a real app, this tool refuses to emit code unless a ' +
          'live inspection session exists — UNLESS you set this to true. Set it ONLY if you have ALREADY captured REAL ' +
          'element IDs for this app from a source other than a still-open session: an rdb/UIAutomator dump, ' +
          'open_mobile_studio, get_automation_properties, or authoritative app source in the workspace. ' +
          'Setting this WITHOUT real captured selectors produces a placeholder scaffold with invalid <…> selectors that ' +
          'fails at runtime, and violates the tool contract. When in doubt, do NOT set it — start_inspection_session instead.'
        ),
      outputFormat: outputFormatParam,
    },
    async ({ platform, language, appId, deviceCategory, testName, packageName, mainActivity, bundleIdentifier, projectType, region, includePerformanceTransactions, includeAxeScan, confirmSelectorsVerified, outputFormat }) => {
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
      // env vars, switching to a project profile still embedded the admin JWT.
      const accessKey = getActiveAccessKey();
      const rawBaseUrl = getActiveUrl();

      let instanceHost = rawBaseUrl;
      try {
        instanceHost = new URL(rawBaseUrl).hostname;
      } catch {
        // leave as raw value if URL parsing fails
      }

      // Auto-detect server mode via my-account-info — works for all user roles with Bearer Token.
      let isAppiumOss = false;
      try {
        const me = await getMyAccountInfo();
        isAppiumOss = me.project.isAppiumOss ?? false;
      } catch {
        // leave as false — don't fail boilerplate generation on lookup error
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
          const content = substitute(raw, language, platform, vars);
          return { ...f, content: gridHeader(f.filename) + content };
        });

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
          setupNote: setupNote(language, isAppiumOss, projectType),
          appNote: appNote(platform, vars.packageName, vars.bundleIdentifier, vars.mainActivity, resolvedFromAppId),
          parallelNote: language === 'python'
            ? 'Device farms support parallel test execution. Each test method already has its own setUp/tearDown session — no code changes needed. Install pytest-xdist (pip install pytest-xdist) and run: pytest -n auto -v. Check maxDevelopmentLicense via get_project_admin_settings to confirm your concurrency limit before scaling workers.'
            : null,
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
          '',
        ];
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
            text: `Failed to read boilerplate files: ${(e as Error).message}\n\nEnsure the Docker image was built from the latest source — the resources/boilerplate directory must be present in the image.`,
          }],
          isError: true,
        };
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
}
