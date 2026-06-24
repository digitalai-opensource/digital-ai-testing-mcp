import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { getUsers, getMyAccountInfo } from './helpers/test-client.js';
import { assertDefined } from './helpers/test-client.js';

describe('Users API', () => {
  it('GET /api/v1/users — returns array with id, userName, email, roles', async () => {
    const users = await getUsers();
    assert.ok(Array.isArray(users), 'Response should be an array');
    assert.ok(users.length > 0, 'Should have at least one user');

    for (const u of users.slice(0, 5)) {
      assertDefined(u.id, 'user.id');
      assertDefined(u.userName, 'user.userName');
      assertDefined(u.email, 'user.email');
      assert.ok(typeof u.roles === 'object', 'user.roles should be an object');
    }
  });

  it('GET /api/v1/users/my-account-info — returns username, role, project', async () => {
    const info = await getMyAccountInfo();
    assertDefined(info.username, 'accountInfo.username');
    assertDefined(info.role, 'accountInfo.role');
    assertDefined(info.project, 'accountInfo.project');
    assert.ok(typeof info.project.id === 'number', 'project.id should be a number');
    assert.ok(typeof info.project.name === 'string', 'project.name should be a string');
  });

  it('Each user has authenticationType of BASIC, SSO, or TWO_FA', async () => {
    const users = await getUsers();
    const validTypes = ['BASIC', 'SSO', 'TWO_FA'];
    for (const u of users.slice(0, 5)) {
      assert.ok(
        validTypes.includes(u.authenticationType),
        `authenticationType should be one of ${validTypes.join(', ')}, got: ${u.authenticationType}`
      );
    }
  });

  it('Users response includes at least the Cloud Admin account', async () => {
    const users = await getUsers();
    const info = await getMyAccountInfo();
    const found = users.find(
      (u) => u.userName.toLowerCase() === info.username.toLowerCase()
    );
    assert.ok(found, `Current user "${info.username}" should appear in the users list`);
  });
});
