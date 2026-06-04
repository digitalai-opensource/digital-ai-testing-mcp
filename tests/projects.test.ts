import { describe, it, beforeAll } from 'vitest';
import assert from 'node:assert/strict';
import {
  getAllProjects,
  getUsersInProject,
  getAutomationProperties,
} from './helpers/test-client.js';
import type { Project } from '../src/types/digital-ai.js';

describe('Projects API', () => {
  let allProjects: Project[];
  let defaultProject: Project | undefined;

  beforeAll(async () => {
    allProjects = await getAllProjects();
    defaultProject = allProjects.find((p) => p.name.toLowerCase() === 'default');
  });

  it('GET /api/v1/projects — returns array with at least the Default project', async () => {
    assert.ok(Array.isArray(allProjects), 'Response should be an array');
    assert.ok(allProjects.length > 0, 'Should have at least one project');
  });

  it('Each project has id (number) and name (string)', async () => {
    for (const p of allProjects.slice(0, 5)) {
      assert.ok(typeof p.id === 'number', `id should be a number, got ${typeof p.id}`);
      assert.ok(typeof p.name === 'string', 'name should be a string');
    }
  });

  it('Default project exists in list', async () => {
    assert.ok(defaultProject !== undefined, 'Default project should exist in the list');
  });

  it('GET /api/v1/projects/<id>/users — returns array for Default project', async () => {
    if (!defaultProject) return;
    const users = await getUsersInProject(defaultProject.id);
    assert.ok(Array.isArray(users), 'Users should be an array');
    for (const u of users.slice(0, 3)) {
      assert.ok(typeof u.id === 'number', 'user.id should be a number');
      assert.ok(typeof u.username === 'string', 'user.username should be a string');
    }
  });

  it('GET /api/v1/projects/automationProperties — returns array', async () => {
    const props = await getAutomationProperties();
    assert.ok(Array.isArray(props), 'Response should be an array');
    for (const p of props.slice(0, 3)) {
      assert.ok(typeof p.propertyName === 'string', 'propertyName should be a string');
      assert.ok(typeof p.propertyValue === 'string', 'propertyValue should be a string');
    }
  });
});
