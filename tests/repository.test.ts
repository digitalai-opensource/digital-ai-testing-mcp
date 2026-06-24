import { describe, it, beforeAll } from 'vitest';
import assert from 'node:assert/strict';
import { listFiles, getFileInfo } from './helpers/test-client.js';
import type { RepositoryFile } from '../src/types/digital-ai.js';

describe('Repository API', () => {
  let allFiles: RepositoryFile[];

  beforeAll(async () => {
    allFiles = await listFiles();
  });

  it('GET /api/v1/files — returns array (may be empty)', async () => {
    assert.ok(Array.isArray(allFiles), 'Response should be an array');
  });

  it('Each file has id (number), uniqueName, extension, size, projectName', async () => {
    for (const f of allFiles.slice(0, 5)) {
      assert.ok(typeof f.id === 'number', `id should be a number, got ${typeof f.id}`);
      assert.ok(typeof f.uniqueName === 'string', 'uniqueName should be a string');
      assert.ok(typeof f.extension === 'string', 'extension should be a string');
      assert.ok(typeof f.size === 'number', 'size should be a number');
      assert.ok(typeof f.projectName === 'string', 'projectName should be a string');
    }
  });

  it('GET /api/v1/files/<id> — returns single file detail matching list entry', async () => {
    if (allFiles.length === 0) return;
    const file = await getFileInfo(allFiles[0].id);
    assert.equal(file.id, allFiles[0].id, 'File ID should match');
    assert.equal(file.uniqueName, allFiles[0].uniqueName, 'uniqueName should match');
  });
});
