/**
 * Digital.ai Test Orchestrator ("Smart Agent") — pure generation helpers for get_test_boilerplate.
 *
 * The orchestrator is a JVM agent attached with `-javaagent:<jar>=<config.yml>`. It hooks the test runner
 * (JUnit 5 / TestNG) and the Appium driver: automatic retries, Reporter status sync, test selection, fail-fast,
 * Build/Run IDs. Test code does not change. Release notes (26.9): "Available for Appium Server tests with JUnit
 * and TestNG" — so it applies ONLY to the Java templates on Appium Server (OSS) projects.
 *
 * Verified live (2026-10-08, uscloud, java-client 8.6.0 + UiAutomator2Options/XCUITestOptions, TestNG and JUnit 5,
 * Gradle and Maven): the agent injected digitalai:testCaseId / runId / retryAttempt, retried a failed test in a fresh
 * session, and stamped buildId/runId on the Reporter records. Its status-sync calls use java.net.http and need a JDK
 * whose truststore holds "SSL.com TLS RSA Root CA 2022" (uscloud's chain root): JDK 21.0.2 lacks it and the sync
 * fails silently, leaving Reporter with the Appium session's status; JDK 25.0.1 has it.
 *
 * Generated wiring is "orchestration-ready": the agent is attached — and the Java 17 compile level applied — only
 * when lib/smart-agent.jar exists AND DIGITAL_AI_ACCESS_KEY is set (the agent's YAML requires cloud.accessKey; it is
 * rendered from that env var at build time into orchestrator/rendered/, which is git-ignored by a file we own, so the
 * key never lands in a tracked file and no root .gitignore has to be touched). Otherwise tests run exactly as the
 * classic boilerplate does.
 *
 * Pure: no filesystem, no network — unit-tested in tests/test-orchestrator.test.ts.
 */

export type OrchestrationMode = 'auto' | 'on' | 'off';
type Language = 'java-junit5' | 'java-testng' | 'nodejs' | 'python';

export const AGENT_PROJECT_PATH = 'lib/smart-agent.jar';
export const CONFIG_TEMPLATE_PATH = 'orchestrator/config.template.yml';
/** Rendered (key-bearing) copies land here; ORCHESTRATOR_GITIGNORE keeps them out of git regardless of the root .gitignore. */
export const RENDERED_CONFIG_DIR = 'orchestrator/rendered';
export const ORCHESTRATOR_GITIGNORE_PATH = 'orchestrator/.gitignore';
export const ORCHESTRATOR_GITIGNORE = '# Rendered agent config — contains the access key. Never commit.\nrendered/\n';
export const LIB_GITIGNORE_PATH = 'lib/.gitignore';
export const LIB_GITIGNORE = '# Test Orchestrator agent (~12 MB binary) — install with install_test_orchestrator_agent, do not commit.\nsmart-agent.jar\n';
export const GITIGNORE_ADVICE =
  'No root .gitignore is generated (it would overwrite yours). The key-bearing rendered config and the agent JAR are ' +
  'already covered by orchestrator/.gitignore and lib/.gitignore. Add `smart-agent/` (per-run agent logs) and, if not ' +
  'already present, `build/` / `target/` / `.gradle/` to your own .gitignore.';
export const DEFAULT_MAX_RETRY_ATTEMPTS = 2;

export interface OrchestrationDecision {
  enabled: boolean;
  /** Human-readable why — always set, also when enabled. */
  reason: string;
  /** True when the caller explicitly asked for 'on' but it could not be applied (unsupported, or mode undeterminable). */
  requestedButNotApplied: boolean;
}

export function decideOrchestration(opts: {
  mode: OrchestrationMode;
  language: Language;
  /** undefined = the project's server mode could not be determined (account lookup failed). */
  isAppiumOss: boolean | undefined;
}): OrchestrationDecision {
  const { mode, language, isAppiumOss } = opts;
  if (mode === 'off') {
    return { enabled: false, reason: 'Disabled by request (orchestration: "off") — classic non-orchestrated boilerplate.', requestedButNotApplied: false };
  }
  const notApplied = (reason: string): OrchestrationDecision => ({ enabled: false, reason, requestedButNotApplied: mode === 'on' });
  if (language !== 'java-junit5' && language !== 'java-testng') {
    return notApplied('Test Orchestrator is a Java agent — it supports JUnit 5 and TestNG only, not ' + (language === 'python' ? 'Python' : 'NodeJS/WebdriverIO') + '.');
  }
  if (isAppiumOss === undefined) {
    return notApplied(
      'The project\'s server mode (Appium Server vs Appium Grid) could not be determined because the account lookup failed, ' +
      'so orchestration was not applied. Retry, or pass orchestration: "on" once the lookup succeeds.'
    );
  }
  if (!isAppiumOss) {
    return notApplied('This project runs on Appium Grid; Test Orchestrator supports Appium Server (OSS) projects only.');
  }
  return {
    enabled: true,
    reason: mode === 'on'
      ? 'Enabled by request (Java + Appium Server project).'
      : 'Enabled by default for Java (JUnit 5 / TestNG) on an Appium Server project. Pass orchestration: "off" for the classic boilerplate.',
    requestedButNotApplied: false,
  };
}

/**
 * Retries default to 2, but a test that is DESIGNED to fail (the placeholder scaffold) or one whose samples feed a
 * performance comparison must not be re-run: retries would multiply failed reports / skew transaction sample counts.
 */
export function resolveMaxRetryAttempts(opts: { requested?: number; placeholderBody: boolean; performanceTransactions: boolean }): {
  value: number;
  note?: string;
} {
  if (opts.requested !== undefined) return { value: opts.requested };
  if (opts.placeholderBody) {
    return { value: 0, note: 'maxRetryAttempts set to 0: the test body is a placeholder that fails by design — retries would only multiply failed reports. Raise it once real steps are in place.' };
  }
  if (opts.performanceTransactions) {
    return { value: 0, note: 'maxRetryAttempts set to 0: retried attempts would add extra performance transactions and skew comparison sample counts.' };
  }
  return { value: DEFAULT_MAX_RETRY_ATTEMPTS };
}

/**
 * YAML for the agent. Only cloud + run settings — device query, app and region stay in code (one source of truth).
 * The access-key placeholder appears EXACTLY once (the accessKey line): both Gradle's ReplaceTokens and Maven's
 * resource filtering substitute every occurrence of the delimited token, so the comments must not spell it out.
 */
export function buildConfigTemplate(opts: { instanceUrl: string; maxRetryAttempts: number }): string {
  const hub = opts.instanceUrl.replace(/\/+$/, '').replace(/\/wd\/hub$/, '') + '/wd/hub';
  return [
    '# Digital.ai Test Orchestrator (Smart Agent) configuration — generated by digital-ai-testing-mcp.',
    '#',
    `# This is a TEMPLATE. The build renders it into ${RENDERED_CONFIG_DIR}/ (git-ignored), replacing the`,
    '# access-key token below with the DIGITAL_AI_ACCESS_KEY environment variable — so the key never lands in a',
    '# file under source control. Do not paste the key here.',
    '#',
    '# Capabilities set in your test code still apply. Anything ALSO set in this file overrides the code value;',
    '# device query, app and region are deliberately left in code. Indent with spaces only.',
    '',
    'cloud:',
    `  url: ${hub}`,
    '  accessKey: @DIGITAL_AI_ACCESS_KEY@',
    '',
    'run:',
    '  # Retry each FAILED test up to N more times. Every attempt is reported separately in Reporter.',
    `  maxRetryAttempts: ${opts.maxRetryAttempts}`,
    '',
    '  # Run only some tests (empty = all):  ClassName  or  ClassName#methodName',
    '  # testSelection:',
    '  #   - LocalAndroidTest#quickStartAndroidNativeDemo',
    '',
    '  # Fail fast: if a critical test still fails after its retries, remaining queued tests are Skipped.',
    '  # criticalTests:',
    '  #   - LocalAndroidTest#quickStartAndroidNativeDemo',
    '',
  ].join('\n');
}

const GRADLE_BLOCK = `
// ── Digital.ai Test Orchestrator ───────────────────────────────────────────────
// Attaches ${AGENT_PROJECT_PATH} to the test JVM when the JAR is present AND DIGITAL_AI_ACCESS_KEY is set; otherwise
// tests run exactly as without orchestration (a warning says why). Install the agent with the MCP tool
// install_test_orchestrator_agent. Requires a Java 17/21 JDK whose truststore includes your cloud's root CA.
def orchestratorJar = file('${AGENT_PROJECT_PATH}')
def orchestratorKey = System.getenv('DIGITAL_AI_ACCESS_KEY')
def orchestratorActive = orchestratorJar.exists() && orchestratorKey

if (orchestratorActive) {
    // The agent needs a Java 17+ JVM — raised only when it is actually attached, so a JDK 11 build
    // without the agent keeps working.
    java {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

tasks.register('renderOrchestratorConfig', Copy) {
    from '${CONFIG_TEMPLATE_PATH}'
    into '${RENDERED_CONFIG_DIR}'
    rename { 'config.yml' }
    // The key is a real input: a rotated key must re-render. Hashed, so the credential never lands in task metadata.
    inputs.property('orchestratorKeyFingerprint', (orchestratorKey ?: '').digest('SHA-256'))
    filter(org.apache.tools.ant.filters.ReplaceTokens, tokens: [DIGITAL_AI_ACCESS_KEY: orchestratorKey ?: ''])
}
clean { delete '${RENDERED_CONFIG_DIR}' }

test {
    if (orchestratorActive) {
        dependsOn 'renderOrchestratorConfig'
        jvmArgs "-javaagent:\${orchestratorJar.absolutePath}=\${file('${RENDERED_CONFIG_DIR}/config.yml').absolutePath}",
                "-Dbuild.id=\${System.getenv('BUILD_ID') ?: 'local'}"
    } else {
        def why = orchestratorJar.exists() ? 'DIGITAL_AI_ACCESS_KEY is not set' : '${AGENT_PROJECT_PATH} not found'
        doFirst { logger.warn("Digital.ai Test Orchestrator NOT attached (\${why}) — running without retries or Reporter status sync.") }
    }
}
`;

/** Append the conditional agent wiring to a generated build.gradle. */
export function addOrchestrationToGradle(buildGradle: string): string {
  return buildGradle.replace(/\s*$/, '\n') + GRADLE_BLOCK;
}

const MAVEN_PROFILES = `
    <!--
      Digital.ai Test Orchestrator: these profiles activate only when ${AGENT_PROJECT_PATH} exists AND the
      DIGITAL_AI_ACCESS_KEY environment variable is set (Maven ANDs activation conditions). Otherwise tests run
      exactly as without orchestration. Install the agent with the MCP tool install_test_orchestrator_agent.
      Requires a Java 17/21 JDK whose truststore includes your cloud's root CA.
    -->
    <profiles>
        <profile>
            <id>digitalai-test-orchestrator</id>
            <activation>
                <file><exists>\${basedir}/${AGENT_PROJECT_PATH}</exists></file>
                <property><name>env.DIGITAL_AI_ACCESS_KEY</name></property>
            </activation>
            <properties>
                <DIGITAL_AI_ACCESS_KEY>\${env.DIGITAL_AI_ACCESS_KEY}</DIGITAL_AI_ACCESS_KEY>
            </properties>
            <build>
                <plugins>
                    <!-- The agent needs a Java 17+ JVM — raised only inside this profile, i.e. only when it is attached. -->
                    <plugin>
                        <groupId>org.apache.maven.plugins</groupId>
                        <artifactId>maven-compiler-plugin</artifactId>
                        <configuration>
                            <release>17</release>
                        </configuration>
                    </plugin>
                    <plugin>
                        <groupId>org.apache.maven.plugins</groupId>
                        <artifactId>maven-resources-plugin</artifactId>
                        <version>3.3.1</version>
                        <executions>
                            <execution>
                                <id>render-orchestrator-config</id>
                                <phase>process-test-resources</phase>
                                <goals><goal>copy-resources</goal></goals>
                                <configuration>
                                    <outputDirectory>\${basedir}/${RENDERED_CONFIG_DIR}</outputDirectory>
                                    <resources>
                                        <resource>
                                            <directory>\${basedir}/orchestrator</directory>
                                            <includes><include>config.template.yml</include></includes>
                                            <filtering>true</filtering>
                                        </resource>
                                    </resources>
                                </configuration>
                            </execution>
                        </executions>
                    </plugin>
                    <plugin>
                        <groupId>org.apache.maven.plugins</groupId>
                        <artifactId>maven-surefire-plugin</artifactId>
                        <configuration>
                            <!-- Quoted: Surefire splits argLine on whitespace, so unquoted paths with spaces would break the JVM start. -->
                            <argLine>"-javaagent:\${basedir}/${AGENT_PROJECT_PATH}=\${basedir}/${RENDERED_CONFIG_DIR}/config.template.yml" -Dbuild.id=\${orchestrator.buildId}</argLine>
                        </configuration>
                    </plugin>
                </plugins>
            </build>
        </profile>
        <!-- Build ID groups a CI build's results in Reporter: BUILD_ID when CI provides it, else "local". -->
        <profile>
            <id>digitalai-test-orchestrator-build-id</id>
            <activation><property><name>env.BUILD_ID</name></property></activation>
            <properties><orchestrator.buildId>\${env.BUILD_ID}</orchestrator.buildId></properties>
        </profile>
    </profiles>
`;

/**
 * Wire the agent into a generated pom.xml: a default Build ID property plus the activation profiles. The base compile
 * level is left untouched — Java 17 is required only inside the agent profile.
 */
export function addOrchestrationToMaven(pom: string): string {
  const props = '    <properties>\n        <orchestrator.buildId>local</orchestrator.buildId>\n    </properties>\n';
  let out = /<properties>/.test(pom)
    ? pom.replace('<properties>', '<properties>\n        <orchestrator.buildId>local</orchestrator.buildId>')
    : pom.replace(/(\n\s*<build>)/, `\n${props}$1`);
  out = out.replace(/\s*<\/project>\s*$/, `\n${MAVEN_PROFILES}</project>\n`);
  return out;
}

/** Structured `orchestration` block on the get_test_boilerplate response — one type for both JSON and human output. */
export interface OrchestrationInfo {
  enabled: boolean;
  mode: OrchestrationMode;
  reason: string;
  maxRetryAttempts?: number;
  maxRetryAttemptsNote?: string;
  agent?: {
    projectPath: string;
    installedByThisTool: false;
    howToInstall: string;
    source: string;
  };
  activation?: string;
  runCommands?: { gradle: string; maven: string };
  buildId?: string;
  requirements?: string;
  jdkTrustNote?: string;
  gitignore?: string;
  logs?: string;
}

export const JDK_TRUST_NOTE =
  'The agent reports retries and final status to Reporter over HTTPS using the JDK\'s own truststore. ' +
  'Use a current Java 17/21 update: the cloud\'s certificate chains to "SSL.com TLS RSA Root CA 2022", which older ' +
  'JDK builds (e.g. 21.0.2) do not include — there the sync fails silently and Reporter keeps the Appium session\'s ' +
  'status instead of the test\'s real result. Look for "Async cloud API call failed" in smart-agent/<run-id>/*.log.';
