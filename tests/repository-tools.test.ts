/**
 * Repository tool handlers against a stub API (tests/api/repository.test.ts covers the live API itself).
 * Regression target (repo scan 2026-10-16, verified live): GET /api/v1/files ignores uniqueName / projectName /
 * projectId — every filter returned all 210 files — so list_repository_files filters client-side.
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { registerRepositoryTools } from '../src/tools/repository-tools.js';
import { startStubApi, connectTools, accountInfo, type StubApi, type ToolClient } from './helpers/offline.js';

const file = (id: number, uniqueName: string, projectName: string) => ({
  id, uniqueName, projectName, description: null, extension: 'mp3', size: 1, uploadedBySystem: false,
  uploadTime: '10/16/2026 10:00:00', lastUpdate: '10/16/2026 10:00:00', uploadedUser: 'u', lastUpdatedUser: 'u',
});
const FILES = [file(1, 'hello', 'Default'), file(2, 'Hello', 'POC'), file(3, 'other', 'POC')];

let api: StubApi;
let tools: ToolClient;

beforeAll(async () => {
  api = await startStubApi((req) => {
    if (req.path === '/api/v1/users/my-account-info') return accountInfo('Admin', 'Default');
    // Like the platform: query parameters are ignored, everything comes back.
    if (req.path === '/api/v1/files') return { status: 'SUCCESS', data: FILES, code: 'OK' };
    if (req.path === '/api/v1/projects') return [{ id: 7, name: 'POC' }, { id: 2, name: 'Default' }];
    return undefined;
  });
  tools = await connectTools(registerRepositoryTools);
});
afterAll(async () => { await tools.close(); await api.close(); });

const ids = (j: Record<string, unknown>) => (j.files as Array<{ id: number }>).map((f) => f.id).sort();

describe('list_repository_files filters client-side', () => {
  it('uniqueName and projectName match exactly, case-insensitively', async () => {
    assert.deepEqual(ids(await tools.callJson('list_repository_files', { uniqueName: 'HELLO' })), [1, 2]);
    assert.deepEqual(ids(await tools.callJson('list_repository_files', { projectName: 'poc' })), [2, 3]);
    assert.deepEqual(ids(await tools.callJson('list_repository_files', { uniqueName: 'hello', projectName: 'POC' })), [2]);
    assert.deepEqual(ids(await tools.callJson('list_repository_files', { uniqueName: 'nope' })), []);
  });

  it('projectId is resolved to the project name', async () => {
    assert.deepEqual(ids(await tools.callJson('list_repository_files', { projectId: '7' })), [2, 3]);
    const { res, text } = await tools.call('list_repository_files', { projectId: '999' });
    assert.equal(res.isError, true);
    assert.match(text, /not visible to this credential/);
  });

  it('sends no filter parameters the platform would ignore', async () => {
    await tools.callJson('list_repository_files', { uniqueName: 'hello' });
    const last = api.requests.filter((r) => r.path === '/api/v1/files').at(-1)!;
    assert.equal(last.query.toString(), '');
  });
});
