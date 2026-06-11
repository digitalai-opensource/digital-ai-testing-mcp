/**
 * Tool-layer regression tests.
 *
 * Exercises the REGISTERED tool handlers through an in-memory MCP transport —
 * the layer the live API tests never touch. Covers the invariants found broken
 * in code review: destructive guards, JWT gates, and upload path validation.
 *
 * No live API access: the client is pointed at an unreachable host, and every
 * asserted path returns BEFORE any HTTP call. If a guard regresses to fire
 * after an API call, the test fails with a network error instead of guard text
 * — which is exactly the regression signal we want.
 */
import { describe, it, beforeAll } from 'vitest';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { registerDeviceTools } from '../src/tools/device-tools.js';
import { registerApplicationTools } from '../src/tools/application-tools.js';
import { registerReportingTools } from '../src/tools/reporting-tools.js';
import { registerRepositoryTools } from '../src/tools/repository-tools.js';
import { registerProvisioningProfileTools } from '../src/tools/provisioning-profile-tools.js';
import { resetClient, getActiveKeyType, getActiveAccessKey, getActiveUrl } from '../src/api/client.js';
import { validateInputPath, validateOutputPath } from '../src/utils/path-guard.js';

dotenv.config();

// Unreachable on purpose — any HTTP attempt fails fast instead of touching live data.
const FAKE_URL = 'https://unreachable.invalid';
const FAKE_PROJECT_KEY = 'aut_1_fake_harness_key';
const FAKE_JWT_KEY = 'eyJfakeharnessjwt';

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

let client: Client;

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}

function textOf(r: ToolResult): string {
  return r.content.map((c) => c.text ?? '').join('\n');
}

beforeAll(async () => {
  const server = new McpServer({ name: 'harness', version: '0.0.0' });
  registerDeviceTools(server);
  registerApplicationTools(server);
  registerReportingTools(server);
  registerRepositoryTools(server);
  registerProvisioningProfileTools(server);

  client = new Client({ name: 'harness-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

describe('Destructive guards fire before any API call, without isError', () => {
  beforeAll(() => {
    resetClient(FAKE_URL, FAKE_JWT_KEY, 'harness-jwt');
  });

  const CASES: Array<{ tool: string; args: Record<string, unknown> }> = [
    { tool: 'uninstall_application', args: { applicationId: 1, deviceId: '1' } },
    { tool: 'uninstall_application_by_package', args: { deviceId: '1', packageName: 'com.x' } },
    { tool: 'uninstall_application_by_package_from_devices', args: { devicesList: '1,2', packageName: 'com.x' } },
    { tool: 'release_device', args: { deviceId: '1' } },
    { tool: 'remove_device_tag', args: { deviceId: '1', tag: 'x', confirmDeletion: false } },
    { tool: 'remove_all_device_tags', args: { deviceId: '1', confirmDeletion: false } },
    { tool: 'delete_application', args: { applicationId: 1, confirmDeletion: false } },
    { tool: 'delete_test_reports', args: { ids: [1] } },
  ];

  for (const { tool, args } of CASES) {
    it(`${tool} without confirmDeletion returns the guard, not an error`, async () => {
      const res = await callTool(tool, args);
      const text = textOf(res);
      assert.match(text, /Safety guard triggered/, `${tool}: expected guard text, got: ${text.slice(0, 200)}`);
      assert.match(text, /confirmDeletion: true/);
      assert.notEqual(res.isError, true, `${tool}: guard must NOT set isError (LLM treats it as failure)`);
    });
  }
});

describe('Reporter delete tools gate on Cloud Admin JWT before guard or API', () => {
  beforeAll(() => {
    resetClient(FAKE_URL, FAKE_PROJECT_KEY, 'harness-project');
  });

  const DELETE_TOOLS: Array<{ tool: string; args: Record<string, unknown> }> = [
    { tool: 'delete_test_reports', args: { ids: [1], confirmDeletion: true } },
    { tool: 'delete_test_reports_before_date', args: { beforeDate: '2020-01-01T00:00:00Z', confirmDeletion: true } },
    { tool: 'delete_test_reports_by_name', args: { nameContains: 'x', confirmDeletion: true } },
  ];

  for (const { tool, args } of DELETE_TOOLS) {
    it(`${tool} with a project API key returns the JWT-gate message`, async () => {
      const res = await callTool(tool, args);
      const text = textOf(res);
      assert.match(text, /Cloud Admin JWT required/, `${tool}: got: ${text.slice(0, 200)}`);
      assert.match(text, /switch_environment/);
      assert.equal(res.isError, true);
    });
  }
});

describe('Upload tools reject unsafe input paths before reading any file', () => {
  beforeAll(() => {
    resetClient(FAKE_URL, FAKE_JWT_KEY, 'harness-jwt');
  });

  it('upload_repository_file refuses to read a .env file', async () => {
    const res = await callTool('upload_repository_file', { localFilePath: 'C:\\projects\\app\\.env' });
    assert.match(textOf(res), /credential-file pattern/);
    assert.equal(res.isError, true);
  });

  it('upload_repository_file refuses an SSH private key', async () => {
    const res = await callTool('upload_repository_file', { localFilePath: '/home/user/.ssh/id_rsa' });
    assert.match(textOf(res), /credential-file pattern/);
    assert.equal(res.isError, true);
  });

  it('upload_repository_file refuses a relative path', async () => {
    const res = await callTool('upload_repository_file', { localFilePath: 'data/testdata.json' });
    assert.match(textOf(res), /must be an absolute path/);
    assert.equal(res.isError, true);
  });

  it('update_repository_file refuses a .env path but allows metadata-only updates past the guard', async () => {
    const blocked = await callTool('update_repository_file', { fileId: 1, localFilePath: 'C:\\x\\.env.production' });
    assert.match(textOf(blocked), /credential-file pattern/);
    // Metadata-only update has no file path — the path guard must not fire.
    // (It then fails at the network layer because the host is unreachable.)
    const metaOnly = await callTool('update_repository_file', { fileId: 1, description: 'x' });
    assert.doesNotMatch(textOf(metaOnly), /credential-file pattern|must be an absolute path/);
  });

  it('upload_provisioning_profile validates both file paths', async () => {
    const res = await callTool('upload_provisioning_profile', {
      p12FilePath: 'C:\\certs\\dist.p12',
      password: 'x',
      mobileprovisionFilePath: 'relative/profile.mobileprovision',
    });
    assert.match(textOf(res), /must be an absolute path/);
    assert.equal(res.isError, true);
  });
});

describe('path-guard unit behavior', () => {
  it('validateInputPath blocks credential filenames and traversal, allows normal files', () => {
    assert.notEqual(validateInputPath('C:\\builds\\.env'), null);
    assert.notEqual(validateInputPath('/srv/keys/id_ed25519'), null);
    assert.notEqual(validateInputPath('C:\\a\\..\\b\\app.apk'), null);
    assert.notEqual(validateInputPath('app.apk'), null);
    assert.equal(validateInputPath('C:\\builds\\app.apk'), null);
    assert.equal(validateInputPath('/builds/dist.p12'), null);
    // 'environment.json' must not be caught by the .env pattern
    assert.equal(validateInputPath('/data/environment.json'), null);
  });

  it('validateOutputPath unchanged: absolute + no traversal', () => {
    assert.equal(validateOutputPath('C:\\tmp\\out.zip'), null);
    assert.notEqual(validateOutputPath('out.zip'), null);
    assert.notEqual(validateOutputPath('C:\\tmp\\..\\out.zip'), null);
  });
});

describe('Active-profile credential accessors follow resetClient', () => {
  it('getActiveKeyType and getActiveAccessKey reflect the switched profile, not env', () => {
    resetClient(FAKE_URL, FAKE_PROJECT_KEY, 'harness-project');
    assert.equal(getActiveKeyType(), 'api-key');
    assert.equal(getActiveAccessKey(), FAKE_PROJECT_KEY);
    assert.equal(getActiveUrl(), FAKE_URL);

    resetClient(FAKE_URL, FAKE_JWT_KEY, 'harness-jwt');
    assert.equal(getActiveKeyType(), 'jwt');
    assert.equal(getActiveAccessKey(), FAKE_JWT_KEY);
  });
});
