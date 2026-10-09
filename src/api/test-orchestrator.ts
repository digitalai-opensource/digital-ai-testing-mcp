/**
 * Test Orchestrator agent JAR — where it comes from and how it reaches a test project.
 *
 * The JAR is NOT shipped with this package. It is downloaded on demand, at request time, and verified:
 *   1. TEST_ORCHESTRATOR_JAR_URL + TEST_ORCHESTRATOR_JAR_SHA256 — an operator override (e.g. a permanent production
 *      location, or an internal mirror). The checksum is REQUIRED: a URL without one is refused rather than used
 *      unverified.
 *   2. Otherwise the default pinned in resources/test-orchestrator/agent.json — the Digital.ai sample repository at an
 *      immutable commit, with the SHA-256 of that exact file. Moving the default to a permanent location is a one-line
 *      change to that manifest (url + sha256).
 *
 * Delivery: under the npm/local install the server's filesystem IS the user's, so the server downloads, verifies and
 * writes <projectDir>/lib/smart-agent.jar itself. Under Docker/remote it is not, so a checksum-verifying download
 * command is returned instead. Nothing else in the MCP depends on the JAR: get_test_boilerplate never needs it, and a
 * generated project builds and runs normally until it is installed.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import { AGENT_PROJECT_PATH } from '../utils/test-orchestrator.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST_PATH = join(PACKAGE_ROOT, 'resources', 'test-orchestrator', 'agent.json');
const DOWNLOAD_TIMEOUT_MS = 120000;

/** Build files whose presence marks a directory as a generated test project root. */
const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'pom.xml'];

export interface AgentManifest {
  name: string;
  version: string;
  sha256: string;
  size: number;
  source: { repository: string; commit: string; path: string; downloadUrl: string; description: string };
}

export interface AgentSource {
  /** 'pinned' = the default in agent.json; 'url' = the TEST_ORCHESTRATOR_JAR_URL operator override. */
  kind: 'pinned' | 'url';
  /** Human-readable label for responses. */
  label: string;
  downloadUrl: string;
  /** Expected SHA-256 (lowercase hex). Always present — an unverifiable source is never constructed. */
  sha256: string;
  /** Where a human can find the file manually (repository page), when known. */
  homepage?: string;
}

export function readAgentManifest(): AgentManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as AgentManifest;
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Resolve where the agent comes from: the operator override, else the pinned default. Throws when
 * TEST_ORCHESTRATOR_JAR_URL is set without a valid checksum, or when the manifest is unreadable.
 */
export function resolveAgentSource(env: NodeJS.ProcessEnv = process.env): AgentSource {
  const url = env.TEST_ORCHESTRATOR_JAR_URL?.trim();
  if (url) {
    const sha = env.TEST_ORCHESTRATOR_JAR_SHA256?.trim().toLowerCase();
    if (!sha || !/^[0-9a-f]{64}$/.test(sha)) {
      throw new Error(
        'TEST_ORCHESTRATOR_JAR_URL is set but TEST_ORCHESTRATOR_JAR_SHA256 is missing or not a 64-hex SHA-256 — ' +
        'refusing to use an agent that cannot be verified. Set both, or unset the URL to use the default pinned download.'
      );
    }
    return { kind: 'url', label: `configured URL (${url})`, downloadUrl: url, sha256: sha };
  }
  const m = readAgentManifest();
  return {
    kind: 'pinned',
    label: `${m.version} from ${m.source.repository} @ ${m.source.commit.slice(0, 12)}`,
    downloadUrl: m.source.downloadUrl,
    sha256: m.sha256.toLowerCase(),
    homepage: m.source.repository,
  };
}

/** Manual-install instructions, used when the server cannot fetch the file itself (offline, proxy, outage). */
export function manualInstallInstructions(source: AgentSource): string {
  return (
    `Install it manually: download ${source.downloadUrl}` +
    (source.homepage ? ` (from ${source.homepage})` : '') +
    `, check its SHA-256 is ${source.sha256}, and save it as ${AGENT_PROJECT_PATH} in the project root. ` +
    'Until then the project builds and runs normally, just without orchestration.'
  );
}

const cache = new Map<string, Buffer>();

/** Download the agent for the resolved source and verify its checksum. Cached per URL+checksum for the process. */
export async function loadAgentBytes(source: AgentSource = resolveAgentSource()): Promise<Buffer> {
  const cacheKey = `${source.downloadUrl}#${source.sha256}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  let bytes: Buffer;
  try {
    const res = await axios.get<ArrayBuffer>(source.downloadUrl, { responseType: 'arraybuffer', timeout: DOWNLOAD_TIMEOUT_MS, maxRedirects: 5 });
    bytes = Buffer.from(res.data);
  } catch (e) {
    throw new Error(`Could not download the Test Orchestrator agent from ${source.downloadUrl}: ${(e as Error).message}. ${manualInstallInstructions(source)}`);
  }
  const got = sha256Hex(bytes);
  if (got !== source.sha256) {
    throw new Error(
      `Downloaded Test Orchestrator agent failed checksum verification (expected ${source.sha256}, got ${got}). ` +
      'Nothing was installed. If the file was intentionally updated at its source, update the pinned checksum ' +
      '(resources/test-orchestrator/agent.json, or TEST_ORCHESTRATOR_JAR_SHA256).'
    );
  }
  cache.set(cacheKey, bytes);
  return bytes;
}

/**
 * Download, verify and write the agent into <projectDir>/lib/smart-agent.jar (local/npm deployments). The directory
 * must already exist — a mistyped path must not be silently materialised into an empty tree the build never looks at.
 * `buildFileFound` tells the caller whether the directory looks like a project root at all (no build.gradle / pom.xml
 * → warn). Nothing is written unless the checksum matches.
 */
export async function installAgentIntoProject(projectDir: string, source: AgentSource = resolveAgentSource()): Promise<{
  path: string; bytes: number; sha256: string; replaced: boolean; buildFileFound: boolean;
}> {
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    throw new Error(`projectDir does not exist or is not a directory: ${projectDir}. Write the generated project files first, then install the agent into that directory.`);
  }
  const buildFileFound = BUILD_FILES.some((f) => existsSync(join(projectDir, f)));
  const bytes = await loadAgentBytes(source);
  const target = join(projectDir, ...AGENT_PROJECT_PATH.split('/'));
  const replaced = existsSync(target);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  return { path: target, bytes: bytes.length, sha256: sha256Hex(bytes), replaced, buildFileFound };
}

/**
 * Checksum-verifying download commands for Docker/remote deployments (the user runs them in their project dir).
 * Both variants REMOVE the file on a mismatch — the Gradle/Maven wiring attaches whatever sits at lib/smart-agent.jar,
 * so an unverified download must never be left in place. The bash form ends in `false`, not `exit`, so pasting it
 * into an interactive shell cannot close the shell.
 */
export function buildAgentDownloadCommands(source: AgentSource): { bash: string; powershell: string } {
  const rel = AGENT_PROJECT_PATH;
  const relWin = rel.replace(/\//g, '\\');
  const line = `${source.sha256}  ${rel}`;
  return {
    bash:
      `mkdir -p lib && curl -fL -o ${rel} "${source.downloadUrl}" && ` +
      // Pick ONE checker (Linux/Git Bash have sha256sum; macOS has shasum) — chaining them with || would re-check on a
      // genuine mismatch and print FAILED twice.
      `{ if command -v sha256sum >/dev/null 2>&1; then echo "${line}" | sha256sum -c -; else echo "${line}" | shasum -a 256 -c -; fi; } || ` +
      `{ rm -f ${rel}; echo "Checksum mismatch or download failed — agent removed" >&2; false; }`,
    powershell:
      `New-Item -ItemType Directory -Force lib | Out-Null; Invoke-WebRequest -Uri "${source.downloadUrl}" -OutFile ${relWin}; ` +
      `if ((Get-FileHash ${relWin} -Algorithm SHA256).Hash.ToLower() -ne "${source.sha256}") { Remove-Item ${relWin}; throw "Checksum mismatch — agent removed" }`,
  };
}
