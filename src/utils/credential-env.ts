/**
 * Generated tests read the Digital.ai access key from the environment — never from a literal in the files.
 * User decision 2026-11-12 ("Nowhere"): no generated file carries the key, not even as a fallback; a missing variable
 * fails fast with a message that says what to set. Closes the "Credential Handling in Generated Boilerplate" backlog item
 * (open since v45). The Test Orchestrator wiring already reads the same variable.
 */

export const ACCESS_KEY_ENV = 'DIGITAL_AI_ACCESS_KEY';
const MISSING = `Set the ${ACCESS_KEY_ENV} environment variable to your Digital.ai access key`;

/** Java: fails at class initialisation with the message instead of sending a null capability. */
export const JAVA_KEY_EXPR = `java.util.Objects.requireNonNull(System.getenv("${ACCESS_KEY_ENV}"), "${MISSING}")`;
/** Python: a missing variable raises KeyError('DIGITAL_AI_ACCESS_KEY') when the module loads. Needs `import os`. */
export const PYTHON_KEY_EXPR = `os.environ["${ACCESS_KEY_ENV}"]`;
export const JS_KEY_EXPR = `process.env.${ACCESS_KEY_ENV}`;
/** First line of a generated JS config: stop before any session request when the key is missing. */
export const JS_KEY_GUARD = `if (!process.env.${ACCESS_KEY_ENV}) throw new Error('${MISSING} before running the tests.');`;
/** Robot Framework: `%{VAR}` without a default fails with "Environment variable '%{…}' not found". */
export const ROBOT_KEY_EXPR = `%{${ACCESS_KEY_ENV}}`;

/** Add `import os` to a Python module that lacks it (before the first import). */
export function ensurePythonImportOs(src: string): string {
  if (/^import os\s*$/m.test(src)) return src;
  return /^(import |from )/m.test(src) ? src.replace(/^(import |from )/m, 'import os\n$1') : `import os\n${src}`;
}

/** Prepend the JS guard after any leading comment lines. */
export function addJsKeyGuard(src: string): string {
  if (src.includes(JS_KEY_GUARD)) return src;
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length && /^\s*(\/\/.*)?$/.test(lines[i])) i++;
  lines.splice(i, 0, JS_KEY_GUARD);
  return lines.join('\n');
}

/** A key-free .env.example listing what the generated project needs. */
export const ENV_EXAMPLE_FILE = {
  filename: '.env.example',
  content: [
    '# Environment the generated tests need. Never commit real values.',
    `# Set it in your shell or CI secrets; if you copy this to .env, add .env to .gitignore first.`,
    `${ACCESS_KEY_ENV}=`,
    '',
  ].join('\n'),
};

export interface CredentialSetup {
  envVar: string;
  bash: string;
  powershell: string;
  ci: string;
  gitignore: string;
}

export const CREDENTIAL_SETUP: CredentialSetup = {
  envVar: ACCESS_KEY_ENV,
  bash: `export ${ACCESS_KEY_ENV}='<your access key>'`,
  powershell: `$env:${ACCESS_KEY_ENV} = '<your access key>'   # current session; setx ${ACCESS_KEY_ENV} "<key>" to persist`,
  ci: `Store the key as a CI secret and expose it as ${ACCESS_KEY_ENV} to the test step.`,
  gitignore: 'The generated files contain no key. If you keep the key in a .env file, add .env to .gitignore before committing.',
};

/** One paragraph for the human-readable output. */
export const CREDENTIAL_SETUP_TEXT =
  `**Access key:** the generated files contain no key — they read \`${ACCESS_KEY_ENV}\` and stop with a clear message if ` +
  `it is unset. Set it before the first run: \`${CREDENTIAL_SETUP.bash}\` (macOS/Linux) or ` +
  `\`$env:${ACCESS_KEY_ENV} = '<your access key>'\` (PowerShell). In CI, store it as a secret. Use the key from your ` +
  'Digital.ai profile — the agent should ask the user rather than paste it into chat or files.';
