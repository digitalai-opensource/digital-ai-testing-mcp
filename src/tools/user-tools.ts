import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getUsers,
  createUser,
  deleteUser,
  getMyAccountInfo,
  assignUserToProjects,
  unassignUserFromProjects,
  setUserTags,
  getUserTags,
} from '../api/users.js';
import { checkDestructiveGuard } from '../utils/destructive-guard.js';
import { applyMaxResults, appendTruncationNotice } from '../utils/pagination.js';
import { formatUserList } from '../utils/response-formatter.js';
import { outputFormatParam, respond } from '../utils/output-format.js';

export function registerUserTools(server: McpServer): void {
  server.tool(
    'list_users',
    'Lists all user accounts you have access to. As a Cloud Admin, you see all users on the platform. Supports filtering by name, email, role, status, and auth type (all applied client-side). Shows each person\'s name, email, role, and project assignments.',
    {
      firstName: z.string().optional().describe('Filter by first name (partial match, case-insensitive).'),
      lastName: z.string().optional().describe('Filter by last name (partial match, case-insensitive).'),
      email: z.string().optional().describe('Filter by email address (partial match, case-insensitive).'),
      authenticationType: z
        .enum(['BASIC', 'SSO', 'TWO_FA'])
        .optional()
        .describe("Filter by authentication type: 'BASIC', 'SSO', or 'TWO_FA'."),
      isCloudAdmin: z
        .boolean()
        .optional()
        .describe("If true, return only Cloud Admins (users whose roles object contains the 'Admin' key). If false, return only non-admins."),
      tag: z
        .string()
        .optional()
        .describe('Filter by tag (exact match, case-insensitive). Returns only users who have this tag assigned.'),
      sortBy: z
        .enum(['firstName', 'lastName', 'email', 'userName', 'authenticationType'])
        .optional()
        .describe('Sort results by this field (client-side). Default: platform order.'),
      sortOrder: z
        .enum(['asc', 'desc'])
        .optional()
        .default('asc')
        .describe("Sort direction: 'asc' or 'desc'. Default: 'asc'."),
      maxResults: z
        .number()
        .optional()
        .default(50)
        .describe('Maximum number of results to return (default: 50, max: 500).'),
      outputFormat: outputFormatParam,
    },
    async ({ firstName, lastName, email, authenticationType, isCloudAdmin, tag, sortBy, sortOrder, maxResults, outputFormat }) => {
      try {
        let users = await getUsers();

        if (firstName) {
          const q = firstName.toLowerCase();
          users = users.filter(u => u.firstName.toLowerCase().includes(q));
        }
        if (lastName) {
          const q = lastName.toLowerCase();
          users = users.filter(u => u.lastName.toLowerCase().includes(q));
        }
        if (email) {
          const q = email.toLowerCase();
          users = users.filter(u => u.email.toLowerCase().includes(q));
        }
        if (authenticationType) {
          users = users.filter(u => u.authenticationType === authenticationType);
        }
        if (isCloudAdmin !== undefined) {
          users = users.filter(u => {
            const cloudAdminRole = Object.keys(u.roles ?? {}).includes('Admin');
            return isCloudAdmin ? cloudAdminRole : !cloudAdminRole;
          });
        }
        if (tag) {
          const q = tag.toLowerCase();
          users = users.filter(u => (u.tags ?? []).some(t => t.toLowerCase() === q));
        }

        if (sortBy) {
          users = [...users].sort((a, b) => {
            const av = String(a[sortBy as keyof typeof a] ?? '').toLowerCase();
            const bv = String(b[sortBy as keyof typeof b] ?? '').toLowerCase();
            return sortOrder === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv);
          });
        }
        const paged = applyMaxResults(users, maxResults);
        const structured = {
          users: paged.items.map(u => ({
            id: u.id,
            username: u.userName,
            firstName: u.firstName,
            lastName: u.lastName,
            email: u.email,
            roles: u.roles,
            tags: u.tags,
          })),
        };
        const filterDesc = [
          firstName ? `firstName~"${firstName}"` : '',
          lastName ? `lastName~"${lastName}"` : '',
          email ? `email~"${email}"` : '',
          authenticationType ? `authType=${authenticationType}` : '',
          isCloudAdmin !== undefined ? `isCloudAdmin=${isCloudAdmin}` : '',
          tag ? `tag="${tag}"` : '',
        ].filter(Boolean).join(', ');
        const summary = filterDesc
          ? `Found ${paged.total} user(s) matching [${filterDesc}]:\n\n`
          : `Found ${paged.total} user(s):\n\n`;
        const humanText = appendTruncationNotice(
          `${summary}${formatUserList(paged.items)}`,
          paged
        );
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'create_user',
    "Creates a new user account. Roles: 'Admin' = full platform access (Cloud Admin only), 'ProjectAdmin' = can manage their project, 'User' = can run tests and reserve devices. A temporary password is generated and returned — share it securely. The user should change it on first login.",
    {
      username: z.string().describe('The login username for the new account.'),
      firstName: z.string().describe('First name of the user.'),
      lastName: z.string().describe('Last name of the user.'),
      email: z.string().describe('Email address for the user.'),
      role: z
        .enum(['Admin', 'ProjectAdmin', 'User'])
        .describe("Role: 'Admin' = full access, 'ProjectAdmin' = project manager, 'User' = regular user."),
      project: z.number().optional().describe('Project ID to assign the user to (optional).'),
      authenticationType: z
        .enum(['BASIC', 'SSO', 'TWO_FA'])
        .optional()
        .default('BASIC')
        .describe("Authentication method: 'BASIC' (default), 'SSO', or 'TWO_FA'."),
    },
    async ({ username, firstName, lastName, email, role, project, authenticationType }) => {
      try {
        const result = await createUser({
          username,
          firstName,
          lastName,
          email,
          role,
          project,
          authenticationType,
        });
        const text = [
          `✅ User created successfully.`,
          `Username: ${username}`,
          `User ID: ${result.id}`,
          `Status: ${result.users}`,
          result.password ? `Note: ${result.password.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'delete_user',
    "Permanently deletes a user account. Cannot be undone. Use list_users to find the user's numeric ID first. Requires confirmDeletion: true.",
    {
      userId: z.number().describe("The numeric ID of the user to delete. Use list_users to find it."),
      confirmDeletion: z
        .boolean()
        .describe('Must be true to confirm this destructive, irreversible operation. No changes are made without this.'),
    },
    async ({ userId, confirmDeletion }) => {
      const guard = checkDestructiveGuard(confirmDeletion, `Delete user ${userId}`);
      if (guard) return { content: [{ type: 'text', text: guard }] };
      try {
        await deleteUser(userId);
        return { content: [{ type: 'text', text: `✅ User ${userId} has been permanently deleted.` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_my_account_info',
    "Shows the account details for the API key this MCP server is using — useful for confirming what access level and project context is active.",
    {
      outputFormat: outputFormatParam,
    },
    async ({ outputFormat }) => {
      try {
        const info = await getMyAccountInfo();
        const structured = {
          username: info.username,
          firstName: info.firstName,
          lastName: info.lastName,
          role: info.role,
          project: info.project,
        };
        const humanText = [
          `📋 Current API Account`,
          `Username: ${info.username}`,
          `Name: ${info.firstName} ${info.lastName}`,
          `Role: ${info.role}`,
          `Default Project: ${info.project.name} (ID: ${info.project.id})`,
        ].join('\n');
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'assign_user_to_projects',
    "Grants a user access to one or more projects with specified roles. Cloud Admin only. You can also control whether they can reserve devices.",
    {
      userId: z.number().describe('The numeric ID of the user.'),
      assignments: z
        .array(
          z.object({
            projectId: z.number().describe('The numeric project ID.'),
            role: z
              .enum(['User', 'ProjectAdmin'])
              .optional()
              .describe("Role in the project: 'User' or 'ProjectAdmin'."),
            allowToReserveDevice: z
              .boolean()
              .optional()
              .describe('Whether this user can reserve devices in this project.'),
          })
        )
        .describe('List of project assignments with optional roles and device reservation permissions.'),
    },
    async ({ userId, assignments }) => {
      try {
        const user = await assignUserToProjects(userId, assignments);
        const projectIds = assignments.map((a) => a.projectId).join(', ');
        return {
          content: [
            {
              type: 'text',
              text: `✅ User ${user.userName} (ID: ${userId}) assigned to project(s): ${projectIds}`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'unassign_user_from_projects',
    "Removes a user from one or more projects. Their account is not deleted. Cloud Admin only. Requires confirmDeletion: true.",
    {
      userId: z.number().describe('The numeric ID of the user.'),
      projectIds: z.array(z.number()).describe('List of project IDs to remove the user from.'),
      confirmDeletion: z
        .boolean()
        .describe('Must be true to confirm this destructive, irreversible operation. No changes are made without this.'),
    },
    async ({ userId, projectIds, confirmDeletion }) => {
      const guard = checkDestructiveGuard(
        confirmDeletion,
        `Remove user ${userId} from projects ${projectIds.join(', ')}`
      );
      if (guard) return { content: [{ type: 'text', text: guard }] };
      try {
        await unassignUserFromProjects(userId, projectIds);
        return {
          content: [
            {
              type: 'text',
              text: `✅ User ${userId} removed from project(s): ${projectIds.join(', ')}. Their account remains active.`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_user_tags',
    'Returns the list of tags currently assigned to a user account.',
    {
      userId: z.number().describe('The numeric ID of the user. Use list_users to find it.'),
      outputFormat: outputFormatParam,
    },
    async ({ userId, outputFormat }) => {
      try {
        const tags = await getUserTags(userId);
        const tagList = tags.length > 0 ? tags.join(', ') : '(none)';
        const structured = { userId, tags };
        const humanText = `Tags for user ${userId}: ${tagList}`;
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'set_user_tags',
    "Replaces all tags on a user with the list you provide (max 10). Tags help organize users by team, office, or role — e.g. ['iOS Team', 'London']. This completely replaces existing tags. Cloud Admin only.",
    {
      userId: z.number().describe('The numeric ID of the user.'),
      tags: z.array(z.string()).max(10).describe('List of tags to assign (max 10). Replaces all existing tags.'),
    },
    async ({ userId, tags }) => {
      try {
        await setUserTags(userId, tags);
        const tagList = tags.length > 0 ? tags.join(', ') : '(none)';
        return {
          content: [
            {
              type: 'text',
              text: `✅ Tags updated for user ${userId}. Current tags: ${tagList}`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
