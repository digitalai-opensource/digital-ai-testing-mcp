import { z } from 'zod';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getMyAccountInfo } from '../api/users.js';
import { getApplicationInfo } from '../api/applications.js';
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

// Pattern matches the [BEGIN_DEMO_STEPS] ... [END_DEMO_STEPS] block including its leading indent.
const DEMO_STEP_PATTERN = /([^\S\n]*)(?:\/\/|#) \[BEGIN_DEMO_STEPS\]\n[\s\S]*?[^\S\n]*(?:\/\/|#) \[END_DEMO_STEPS\]/;

function buildPlaceholder(language: Language, platform: Platform, indent: string, appIdentifier?: string): string {
  const c = language === 'python' ? '#' : '//';
  const pkg = appIdentifier ?? 'com.yourpackage';

  if (platform === 'android') {
    if (language === 'java-junit5' || language === 'java-testng') {
      return [
        `${indent}${c} TODO: Add your test steps here. Element IDs are app-specific — cannot be pre-filled.`,
        `${indent}${c} Find them via the Digital.ai Session Viewer (UI inspector) or your app's source code.`,
        `${indent}${c} Example patterns (replace IDs with your app's actual resource IDs):`,
        `${indent}${c}   driver.findElement(By.id("${pkg}:id/loginButton")).click();`,
        `${indent}${c}   driver.findElement(By.id("${pkg}:id/usernameField")).sendKeys("myuser");`,
        `${indent}${c}   driver.findElement(By.xpath("//*[@text='Welcome']")); // assert element visible`,
      ].join('\n');
    }
    if (language === 'nodejs') {
      return [
        `${indent}${c} TODO: Add your test steps here. Element IDs are app-specific — cannot be pre-filled.`,
        `${indent}${c} Find them via the Digital.ai Session Viewer (UI inspector) or your app's source code.`,
        `${indent}${c} Example patterns (replace IDs with your app's actual resource IDs):`,
        `${indent}${c}   const btn = await $('id=${pkg}:id/loginButton'); await btn.click();`,
        `${indent}${c}   const field = await $('//*[@resource-id="${pkg}:id/usernameField"]'); await field.setValue('myuser');`,
        `${indent}${c}   await expect($('//*[@text="Welcome"]')).toBeExisting();`,
      ].join('\n');
    }
    // python android
    return [
      `${indent}${c} TODO: Add your test steps here. Element IDs are app-specific — cannot be pre-filled.`,
      `${indent}${c} Find them via the Digital.ai Session Viewer (UI inspector) or your app's source code.`,
      `${indent}${c} Example patterns (replace IDs with your app's actual resource IDs):`,
      `${indent}${c}   self.driver.find_element(By.ID, "${pkg}:id/loginButton").click()`,
      `${indent}${c}   self.driver.find_element(By.ID, "${pkg}:id/usernameField").send_keys('myuser')`,
      `${indent}${c}   self.driver.find_element(By.XPATH, "//*[@text='Welcome']")  # assert visible`,
    ].join('\n');
  }

  // iOS
  if (language === 'java-junit5' || language === 'java-testng') {
    return [
      `${indent}${c} TODO: Add your test steps here. Accessibility names are app-specific — cannot be pre-filled.`,
      `${indent}${c} Find them via the Digital.ai Session Viewer or Xcode Accessibility Inspector.`,
      `${indent}${c} Example patterns (replace names with your app's actual accessibility identifiers):`,
      `${indent}${c}   driver.findElement(By.xpath("//*[@name='loginButton']")).click();`,
      `${indent}${c}   driver.findElement(By.xpath("//*[@name='usernameField']")).sendKeys("myuser");`,
      `${indent}${c}   driver.findElement(By.xpath("//*[@label='Welcome']")); // assert element visible`,
    ].join('\n');
  }
  if (language === 'nodejs') {
    return [
      `${indent}${c} TODO: Add your test steps here. Accessibility names are app-specific — cannot be pre-filled.`,
      `${indent}${c} Find them via the Digital.ai Session Viewer or Xcode Accessibility Inspector.`,
      `${indent}${c} Example patterns (replace names with your app's actual accessibility identifiers):`,
      `${indent}${c}   const btn = await $('//*[@name="loginButton"]'); await btn.click();`,
      `${indent}${c}   const field = await $('//*[@name="usernameField"]'); await field.setValue('myuser');`,
      `${indent}${c}   await expect($('//*[@label="Welcome"]')).toBeExisting();`,
    ].join('\n');
  }
  // python ios
  return [
    `${indent}${c} TODO: Add your test steps here. Accessibility names are app-specific — cannot be pre-filled.`,
    `${indent}${c} Find them via the Digital.ai Session Viewer or Xcode Accessibility Inspector.`,
    `${indent}${c} Example patterns (replace names with your app's actual accessibility identifiers):`,
    `${indent}${c}   self.driver.find_element(By.XPATH, "//*[@name='loginButton']").click()`,
    `${indent}${c}   self.driver.find_element(By.XPATH, "//*[@name='usernameField']").send_keys('myuser')`,
    `${indent}${c}   self.driver.find_element(By.XPATH, "//*[@label='Welcome']")  # assert visible`,
  ].join('\n');
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
  }
): string {
  let result = content;

  // Handle demo step markers before other substitutions so package name replacement
  // doesn't corrupt the placeholder comment text.
  if (DEMO_STEP_PATTERN.test(result)) {
    if (vars.clearTestBody) {
      const indentMatch = result.match(/([^\S\n]*)(?:\/\/|#) \[BEGIN_DEMO_STEPS\]/);
      const indent = indentMatch?.[1] ?? '        ';
      const placeholder = buildPlaceholder(language, platform, indent, vars.packageName ?? vars.bundleIdentifier);
      result = result.replace(DEMO_STEP_PATTERN, placeholder);
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
        : '⚠️  APPIUM GRID (LEGACY): This project uses Appium Grid — a proprietary Experitest framework\n' +
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
  if (platform === 'android') {
    if (packageName && mainActivity) {
      return `App capabilities pre-filled${source}: package=${packageName}, activity=${mainActivity}. Replace the TODO test steps with interactions specific to your app.`;
    }
    if (packageName) {
      return `App package pre-filled${source}: ${packageName}. Replace .LoginActivity with your main activity and update the TODO test steps for your app.`;
    }
    return 'Replace com.experitest.ExperiBank with your app\'s package name and .LoginActivity with your main activity. Replace the test steps with interactions specific to your app.';
  }
  if (bundleIdentifier) {
    return `Bundle ID pre-filled${source}: ${bundleIdentifier}. Replace the TODO test steps with interactions specific to your app.`;
  }
  return 'Replace com.experitest.ExperiBank with your app\'s bundle ID. Replace the test steps with interactions specific to your app.';
}

export function registerBoilerplateTools(server: McpServer): void {
  server.tool(
    'get_test_boilerplate',
    'Returns a complete, pre-configured test script boilerplate for the chosen mobile platform and programming language. ' +
    'The Digital.ai access key and server URL are pre-filled from the MCP environment. ' +
    'BEFORE calling this tool: (1) call list_applications to find the appId for the target app; ' +
    '(2) call find_available_device for each OS tier you plan to test — read the region from the RESPONSE and pass it ' +
    'as the region parameter so the generated deviceQuery routes only to healthy devices in that region. ' +
    'Also read osVersion from the find_available_device response and use that exact value (e.g. "14.0") in any @version ' +
    'query strings. Do not guess OS versions or use @osVersion/@deviceName (unsupported fields). ' +
    'Provide appId (from list_applications) to auto-resolve app capabilities from the platform record and generate a ' +
    'guided test body placeholder — this is the recommended path for real apps. ' +
    'Alternatively, provide packageName (Android) or bundleIdentifier (iOS) directly. ' +
    'Use projectType to control the output structure: standalone-gradle (default), standalone-maven, or android-gradle-submodule. ' +
    'Returns all files needed to run the test (source file + build/dependency file) with dependency management options where applicable. ' +
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
      outputFormat: outputFormatParam,
    },
    async ({ platform, language, appId, deviceCategory, testName, packageName, mainActivity, bundleIdentifier, projectType, region, outputFormat }) => {
      const accessKey = process.env.DIGITAL_AI_ACCESS_KEY ?? '';
      const rawBaseUrl = (process.env.DIGITAL_AI_BASE_URL ?? '').replace(/\/$/, '');

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
      };

      const files = getFilesForVariant(platform, language, isAppiumOss, projectType);

      try {
        const resolved = files.map(f => {
          const raw = readBoilerplateFile(platform, language, f.diskName);
          const content = substitute(raw, language, platform, vars);
          return { ...f, content };
        });

        const structured = {
          platform,
          language,
          serverMode: isAppiumOss ? 'oss' : 'grid',
          serverModeNote: isAppiumOss
            ? 'Appium Server (OSS) — standard W3C WebDriver protocol'
            : 'Appium Grid (legacy) — proprietary Experitest JWP-era protocol, NOT standard Appium Server. All workarounds in this boilerplate exist because of this protocol difference.',
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
}
