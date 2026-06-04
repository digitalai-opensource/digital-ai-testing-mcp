import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Tool dependency sets for each workflow tool. Kept here as the single source of truth
 *  so startup checks, the readiness tool, and workflow pre-flight guards all agree. */
export const WORKFLOW_DEPS: Record<string, { read: string[]; write: string[] }> = {
  create_poc: {
    read: [
      'list_device_groups',
      'get_devices_in_group',
      'list_projects',
      'list_applications',
    ],
    write: [
      'create_device_group',
      'add_devices_to_group',
      'add_device_tag',
      'remove_devices_from_group',
      'create_project',
      'set_project_notes',
      'create_user',
      'assign_user_to_project',
      'remove_user_from_project',
      'set_user_tags',
      'assign_app_to_project',
    ],
  },
  close_poc: {
    read: [
      'list_projects',
      'list_device_groups',
      'get_devices_in_group',
      'list_users',
    ],
    write: [
      'remove_device_tag',
      'remove_devices_from_group',
      'add_devices_to_group',
      'delete_user',
    ],
  },
  delete_poc: {
    read: [
      'list_projects',
      'list_device_groups',
      'get_devices_in_group',
      'list_users',
    ],
    write: [
      'remove_device_tag',
      'remove_devices_from_group',
      'add_devices_to_group',
      'delete_user',
      'delete_device_group',
      'delete_project',
    ],
  },
  setup_project: {
    read: [
      'list_device_groups',
      'get_devices_in_group',
      'list_projects',
      'list_applications',
    ],
    write: [
      'create_device_group',
      'add_devices_to_group',
      'add_device_tag',
      'remove_devices_from_group',
      'create_project',
      'set_project_notes',
      'create_user',
      'assign_user_to_project',
      'remove_user_from_project',
      'set_user_tags',
      'assign_app_to_project',
    ],
  },
  close_project_resources: {
    read: [
      'list_projects',
      'list_device_groups',
      'get_devices_in_group',
      'list_users',
    ],
    write: [
      'remove_device_tag',
      'remove_devices_from_group',
      'add_devices_to_group',
      'delete_user',
      'remove_user_from_project',
    ],
  },
  teardown_project: {
    read: [
      'list_projects',
      'list_device_groups',
      'get_devices_in_group',
      'list_users',
    ],
    write: [
      'remove_device_tag',
      'remove_devices_from_group',
      'add_devices_to_group',
      'delete_user',
      'remove_user_from_project',
      'delete_device_group',
      'delete_project',
    ],
  },
};

export interface WorkflowReadinessResult {
  workflowPresent: boolean;
  ready: boolean;
  missingRead: string[];
  missingWrite: string[];
  registeredCount: number;
}

/** Returns the names of all tools currently registered on the server instance.
 *  Uses _registeredTools (plain object, keys = tool names) which is populated
 *  synchronously as each server.tool() call fires at startup. */
export function getLiveToolNames(server: McpServer): string[] {
  const rt = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  return rt ? Object.keys(rt) : [];
}

/** Computes readiness for one or all workflow tools against the live server registry. */
export function computeWorkflowReadiness(
  server: McpServer,
  workflow?: string
): Record<string, WorkflowReadinessResult> {
  const registered = new Set(getLiveToolNames(server));
  const toCheck =
    workflow && workflow !== 'all' && WORKFLOW_DEPS[workflow]
      ? { [workflow]: WORKFLOW_DEPS[workflow] }
      : WORKFLOW_DEPS;

  const result: Record<string, WorkflowReadinessResult> = {};
  for (const [wf, deps] of Object.entries(toCheck)) {
    const missingRead = deps.read.filter(t => !registered.has(t));
    const missingWrite = deps.write.filter(t => !registered.has(t));
    result[wf] = {
      workflowPresent: registered.has(wf),
      ready: registered.has(wf) && missingRead.length === 0 && missingWrite.length === 0,
      missingRead,
      missingWrite,
      registeredCount: registered.size,
    };
  }
  return result;
}
