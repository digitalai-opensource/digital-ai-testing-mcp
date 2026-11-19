/**
 * Setup mode — the server starts without credentials instead of exiting (src/utils/setup-guidance.ts, src/index.ts).
 *
 * The stdio cases start the real entry point the way an AI client does (a child process over stdio, run through tsx),
 * from an empty temp folder so no .env is picked up, with every credential variable removed from the environment.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { setupContext, setupGuidance, setupInstructionsBlock } from '../src/utils/setup-guidance.js';

const ENTRY = resolve(__dirname, '..', 'src', 'index.ts');
// Resolved here: the child starts in an empty temp folder, where a bare 'tsx' cannot be found.
const TSX_LOADER = import.meta.resolve('tsx');

describe('setupContext', () => {
  const base = { deploymentModeEnv: undefined, inContainer: false };
  it('npx and npm installs are client-config, even with a docker marker', () => {
    expect(setupContext({ ...base, modulePath: 'C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\digital-ai-testing-mcp\\dist\\utils\\setup-guidance.js' })).toBe('client-config');
    expect(setupContext({ ...base, modulePath: '/usr/lib/node_modules/digital-ai-testing-mcp/dist/utils/setup-guidance.js', inContainer: true })).toBe('client-config');
  });
  it('a container marker or an explicit MCP_DEPLOYMENT_MODE=docker is docker', () => {
    expect(setupContext({ ...base, modulePath: '/app/dist/utils/setup-guidance.js', inContainer: true })).toBe('docker');
    expect(setupContext({ ...base, modulePath: '/app/dist/utils/setup-guidance.js', deploymentModeEnv: ' Docker ' })).toBe('docker');
  });
  it('anything else is a source checkout', () => {
    expect(setupContext({ ...base, modulePath: 'C:/projects/digital-ai-testing-mcp/dist/utils/setup-guidance.js' })).toBe('source');
    expect(setupContext({ ...base, modulePath: '/home/u/mcp/dist/utils/setup-guidance.js', deploymentModeEnv: 'local' })).toBe('source');
  });
});

describe('setupGuidance', () => {
  it('names the missing variables with the right verb', () => {
    expect(setupGuidance(['DIGITAL_AI_ACCESS_KEY'], 'client-config')).toContain('DIGITAL_AI_ACCESS_KEY is not set');
    expect(setupGuidance(['DIGITAL_AI_BASE_URL', 'DIGITAL_AI_ACCESS_KEY'], 'source')).toContain(
      'DIGITAL_AI_BASE_URL and DIGITAL_AI_ACCESS_KEY are not set'
    );
  });
  it('says where to set them for each kind of install', () => {
    expect(setupGuidance(['DIGITAL_AI_ACCESS_KEY'], 'client-config')).toMatch(/Easiest: run "npx(.cmd)? -y digital-ai-testing-mcp@(latest|next) setup"/);
    expect(setupGuidance(['DIGITAL_AI_ACCESS_KEY'], 'docker')).toContain('--env-file');
    expect(setupGuidance(['DIGITAL_AI_ACCESS_KEY'], 'source')).toContain('.env file in the folder the server starts from');
  });
  it('tells the agent not to collect the key in chat', () => {
    expect(setupGuidance(['DIGITAL_AI_ACCESS_KEY'], 'docker')).toContain('Do not ask them to paste an access key');
  });
  it('explains that named profiles do not replace the default connection', () => {
    expect(setupGuidance(['DIGITAL_AI_BASE_URL', 'DIGITAL_AI_ACCESS_KEY'], 'source', ['qa', 'staging'])).toContain(
      'Named profiles were found (qa, staging)'
    );
    expect(setupGuidance(['DIGITAL_AI_ACCESS_KEY'], 'source', [])).not.toContain('Named profiles');
  });
  it('the instructions block leads with SETUP REQUIRED', () => {
    expect(setupInstructionsBlock(['DIGITAL_AI_ACCESS_KEY']).startsWith('SETUP REQUIRED')).toBe(true);
  });
});

/** Starts the entry point over stdio with only `extraEnv` set among the credential variables. */
async function startServer(extraEnv: Record<string, string>) {
  const cwd = mkdtempSync(join(tmpdir(), 'dai-setup-mode-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(DIGITAL_AI_|DAI_PROFILE_|MCP_)/.test(k)) continue;
    env[k] = v;
  }
  // The store folder is the empty temp folder unless a test supplies one, so a real profiles.json never interferes.
  Object.assign(env, { MCP_UPDATE_CHECK: 'false', MCP_DEBUG_MODE: 'false', MCP_CREDENTIAL_STORE_DIR: cwd }, extraEnv);
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', TSX_LOADER, ENTRY], env, cwd, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  const client = new Client({ name: 'setup-mode-test', version: '1.0.0' });
  await client.connect(transport);
  return {
    client,
    stderr: () => stderr,
    async close() {
      await client.close();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

const textOf = (r: unknown) =>
  ((r as { content: Array<{ type: string; text?: string }> }).content ?? []).map((c) => c.text ?? '').join('\n');

describe('starting without credentials (stdio)', () => {
  it('starts in setup mode instead of exiting, and every tool returns the setup instructions', async () => {
    const s = await startServer({});
    try {
      expect(s.client.getInstructions()?.startsWith('SETUP REQUIRED')).toBe(true);
      const { tools } = await s.client.listTools();
      expect(tools.length).toBeGreaterThan(100); // every tool keeps its name
      for (const name of ['get_server_info', 'list_devices', 'check_connectivity']) {
        const r = await s.client.callTool({ name, arguments: {} });
        expect(r.isError).toBe(true);
        expect(textOf(r)).toContain('DIGITAL_AI_BASE_URL and DIGITAL_AI_ACCESS_KEY are not set');
      }
      expect(s.stderr()).toContain('NOT CONFIGURED');
    } finally {
      await s.close();
    }
  }, 60_000);

  it('names only the missing variable, mentions named profiles, and never echoes a key', async () => {
    const secret = 'aut_1_setupModeTestSecretValue';
    const s = await startServer({
      DIGITAL_AI_BASE_URL: 'https://example.invalid',
      DAI_PROFILE_QA_URL: 'https://example.invalid',
      DAI_PROFILE_QA_KEY: secret,
    });
    try {
      const text = textOf(await s.client.callTool({ name: 'get_server_info', arguments: {} }));
      expect(text).toContain('DIGITAL_AI_ACCESS_KEY is not set');
      expect(text).not.toContain('DIGITAL_AI_BASE_URL is not set');
      expect(text).toContain('Named profiles were found (qa)');
      expect(text).not.toContain(secret);
      expect(s.client.getInstructions()).not.toContain(secret);
      expect(s.stderr()).not.toContain(secret);
    } finally {
      await s.close();
    }
  }, 60_000);

  it('with only a credential store (no variables), starts normally on the store default', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'dai-setup-store-'));
    const key = 'aut_1_setupModeStoreKey';
    writeFileSync(
      join(storeDir, 'profiles.json'),
      JSON.stringify({ version: 1, default: 'team', profiles: { team: { url: 'http://127.0.0.1:9', key } } })
    );
    const s = await startServer({ MCP_CREDENTIAL_STORE_DIR: storeDir });
    try {
      expect(s.client.getInstructions()).not.toContain('SETUP REQUIRED');
      expect(s.stderr()).toContain('profile "team" from the credential store');
      const text = textOf(await s.client.callTool({ name: 'list_environments', arguments: {} }));
      expect(text).toContain('team ← active');
      expect(text).toContain('credential store');
      expect(text).not.toContain(key);
      expect(s.stderr()).not.toContain(key);
    } finally {
      await s.close();
      rmSync(storeDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('with an unusable credential store and no variables, setup mode explains the store problem', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'dai-setup-store-'));
    writeFileSync(join(storeDir, 'profiles.json'), '{"profiles": {"team": {"url": "http://127.0.0.1:9", "key": aut_1_x}}}');
    const s = await startServer({ MCP_CREDENTIAL_STORE_DIR: storeDir });
    try {
      const text = textOf(await s.client.callTool({ name: 'get_server_info', arguments: {} }));
      expect(text).toContain('SETUP REQUIRED');
      expect(text).toContain('could not be used: the file is not valid JSON');
      expect(text).not.toContain('aut_1_x');
    } finally {
      await s.close();
      rmSync(storeDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('with credentials set, starts normally (no setup block)', async () => {
    const s = await startServer({ DIGITAL_AI_BASE_URL: 'http://127.0.0.1:9', DIGITAL_AI_ACCESS_KEY: 'aut_1_offline' });
    try {
      expect(s.client.getInstructions()).not.toContain('SETUP REQUIRED');
      expect(s.stderr()).not.toContain('NOT CONFIGURED');
    } finally {
      await s.close();
    }
  }, 60_000);
});
