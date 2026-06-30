import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getMyAccountInfo } from '../api/users.js';
import { resetClient, getActiveProfileName, getActiveUrl, getActiveKeyType } from '../api/client.js';
import { getServerVersion } from '../utils/version.js';
import { listProfiles, getProfileCredentials, profileCount } from '../utils/profile-loader.js';
import { computeWorkflowReadiness, WORKFLOW_DEPS } from '../utils/tool-registry.js';

// Canonical list of every tool registered by this server.
// Update this when adding or removing tools so get_server_info stays accurate.
const REGISTERED_TOOLS = [
  // Users
  'list_users', 'create_user', 'delete_user', 'get_my_account_info',
  'assign_user_to_projects', 'unassign_user_from_projects',
  'get_user_tags', 'set_user_tags',
  // Devices
  'list_devices', 'get_device_detail', 'edit_device', 'release_device',
  'reboot_device', 'reset_device_usb', 'start_device_web_control',
  'open_mobile_studio', 'create_mobile_manual_test', 'download_ios_app_container',
  'get_ios_app_container_download_command',
  'get_device_tags', 'add_device_tag', 'remove_device_tag', 'remove_all_device_tags',
  'get_device_ca_certificates', 'get_device_health_summary',
  'find_available_device', 'release_orphaned_sessions',
  // Device Groups
  'list_device_groups', 'get_devices_in_group', 'get_projects_in_group',
  'create_device_group', 'edit_device_group', 'delete_device_group',
  'add_devices_to_group', 'remove_devices_from_group', 'assign_group_to_project',
  // Reservations
  'list_reservations', 'create_reservation', 'reserve_device_for_duration',
  'delete_reservation', 'check_device_availability_window',
  // Applications
  'list_applications', 'get_application_info', 'upload_application_file',
  'upload_application_from_url', 'get_application_upload_command', 'delete_application', 'update_application_plugins',
  'install_application', 'uninstall_application',
  'uninstall_application_by_package', 'uninstall_application_by_package_from_devices',
  'find_latest_application', 'extract_app_language_files', 'get_app_language_files_download_command',
  'bulk_install_to_group',
  // Repository
  'list_repository_files', 'get_repository_file_info', 'upload_repository_file',
  'get_repository_upload_command',
  'download_repository_file', 'get_repository_file_download_command', 'update_repository_file', 'delete_repository_file',
  // Browsers
  'list_available_browsers', 'start_selenium_session', 'start_manual_test_session',
  // Projects
  'list_projects', 'create_project', 'delete_project',
  'list_project_users', 'assign_user_to_project', 'remove_user_from_project',
  'get_project_tokens', 'set_project_tokens', 'get_project_settings',
  'update_project_settings', 'set_telephony_status',
  'get_project_notes', 'set_project_notes', 'get_project_devices',
  'get_automation_properties', 'assign_app_to_project',
  // Provisioning
  'list_provisioning_profiles', 'get_provisioning_profile',
  'upload_provisioning_profile', 'get_provisioning_profile_upload_command',
  'download_provisioning_profile', 'get_provisioning_profile_download_command',
  'delete_provisioning_profile',
  // Backup
  'create_backup',
  // Health
  'get_environment_summary', 'check_ios_readiness', 'get_agent_status',
  // Reporting
  'get_test_report', 'get_test_by_report_id', 'list_test_reports',
  'find_latest_test_for_name', 'get_grouped_test_reports',
  'get_project_test_summary', 'get_failure_rate_by_app_version',
  'get_distinct_test_key_values', 'delete_test_reports',
  'delete_test_reports_before_date', 'delete_test_reports_by_name', 'download_test_attachments',
  'get_test_attachments_download_command', 'get_test_log', 'summarize_test_failures',
  'list_test_attachments', 'list_active_test_executions',
  // Test Views
  'list_test_views', 'search_test_views', 'get_test_view', 'get_test_view_summary',
  'create_test_view', 'update_test_view', 'delete_test_view',
  // Meta
  'get_server_info', 'check_connectivity', 'check_workflow_readiness',
  'list_environments', 'switch_environment',
  // Workflows — POC lifecycle
  'create_poc', 'close_poc', 'delete_poc',
  // Workflows — General project lifecycle
  'setup_project', 'close_project_resources', 'teardown_project',
  // Boilerplate
  'get_test_boilerplate', 'get_web_test_boilerplate', 'validate_test_script',
  // Agents (v2, Cloud Admin only)
  'list_agents', 'get_agent_devices',
  // Regions (v2, Cloud Admin only)
  'list_regions', 'get_region_topology',
  // NV Servers (v2, Cloud Admin only)
  'list_nv_servers', 'get_nv_server',
  // Sessions / Storage / License (Cloud Admin only)
  'list_active_sessions', 'get_reporter_project_storage', 'get_license_info',
  // Project admin (v2, Project Admin or higher)
  'get_project_admin_settings',
  // Transactions / Performance reporting (all roles; project-scoped for project-level keys)
  'list_transactions', 'get_transaction', 'get_transaction_performance_summary',
  'get_performance_trend',
  // Aggregation / analytics
  'get_test_stability_report', 'get_cross_platform_divergence', 'get_daily_execution_trend',
  // Coverage analytics
  'get_device_coverage_summary', 'get_regional_test_coverage',
  // Infrastructure
  'get_license_utilization',
  // Remote debug
  'get_remote_debug_command',
  // Inspection sessions — mobile (WebDriver-based native inspection)
  'start_inspection_session', 'stop_inspection_session',
  'take_inspection_screenshot', 'get_element_tree', 'find_elements',
  'tap_element', 'type_into_element', 'clear_element',
  'swipe_screen', 'launch_app', 'press_back',
  'long_press', 'double_tap', 'drag_and_drop', 'pinch_zoom', 'scroll_to_element',
  'press_key', 'hide_keyboard', 'app_control', 'device_control',
  'list_inspection_sessions', 'cleanup_inspection_sessions', 'mock_authentication',
  // Inspection sessions — web (Selenium Grid, browser inspection)
  'start_browser_inspection_session', 'stop_browser_inspection_session',
  'navigate_to', 'get_page_dom', 'browser_action', 'find_web_elements',
  'list_browser_inspection_sessions', 'cleanup_browser_inspection_sessions',
  // Performance comparison (all roles; transaction-control is session-based)
  'compare_performance_transactions', 'assess_comparison_confounds',
  'detect_performance_outliers', 'performance_transaction_control',
] as const;

export const TOOL_COUNT = REGISTERED_TOOLS.length;

export function registerMetaTools(server: McpServer): void {
  // ─── get_server_info ───────────────────────────────────────────────────────

  server.tool(
    'get_server_info',
    'Returns the running server version, target API URL, registered tool count, and capability domains. Call this first to verify the deployed Docker image matches the expected build — if tools are missing, rebuild the image.',
    {},
    async () => {
      const name = process.env['MCP_SERVER_NAME'] ?? 'digital-ai-testing-mcp';
      const version = getServerVersion();
      const activeProfile = getActiveProfileName();
      const activeUrl = getActiveUrl();
      const requestTimeout = process.env['REQUEST_TIMEOUT_MS'] ?? '30000';
      const uploadTimeout = process.env['UPLOAD_TIMEOUT_MS'] ?? '120000';
      const envCount = profileCount();

      let projectLine = 'Project:          (unknown)';
      try {
        const me = await getMyAccountInfo();
        const mode = me.project.isAppiumOss ? 'Appium Server (OSS)' : 'Appium Grid';
        projectLine = `Project:          ${me.project.name} (ID: ${me.project.id}) — ${mode} — Role: ${me.role}`;
      } catch {
        // non-fatal — server info still useful without project details
      }

      const keyType = getActiveKeyType();
      const keyLabel = keyType === 'jwt' ? 'Cloud Admin — full access' : 'project-level key (Project Admin or Project User) — scoped access (some Cloud Admin tools return 403)';
      const envLine = envCount > 1
        ? `Active profile:   "${activeProfile}" — ${keyLabel} (${envCount} profiles — use list_environments / switch_environment)`
        : `Active profile:   "${activeProfile}" — ${keyLabel}`;

      const lines = [
        `Server:           ${name} v${version}`,
        `Target API:       ${activeUrl}`,
        envLine,
        projectLine,
        `Request timeout:  ${requestTimeout}ms`,
        `Upload timeout:   ${uploadTimeout}ms`,
        '',
        `Registered tools: ${TOOL_COUNT} tools + 2 resources + 6 prompts`,
        '',
        'Capability domains:',
        '  Users              — list, create, delete, assign, tag, get-tags (8 tools)',
        '  Devices            — list, detail, control, tag, health, find, release-orphaned (19 tools)',
        '  Device Groups      — list, create, edit, delete, assign (9 tools)',
        '  Reservations       — list, create, reserve-now, delete, check-window (5 tools)',
        '  Applications       — list, upload, upload-command, install, uninstall, bulk-install, plugins, download-command (15 tools)',
        '  Repository         — list, upload, upload-command, download, download-command, update, delete (8 tools)',
        '  Browsers           — list, selenium-session, manual-session (3 tools)',
        '  Projects           — list, create, delete, users (by id OR name), tokens, settings (16 tools)',
        '  Provisioning       — list, detail, upload, upload-command, download, download-command, delete (7 tools)',
        '  Backup             — create (1 tool)',
        '  Health             — environment, iOS-readiness, Android-readiness, agent-status (4 tools)',
        '  Reporting          — list+date-filter, find-latest, grouped, summary, failure-summary, attachments, download-command, logs, delete, active-executions (17 tools)',
        '  Test Views         — list, search, detail, summary, create, update, delete (7 tools)',
        '  Meta               — get_server_info, check_connectivity, check_workflow_readiness, list_environments, switch_environment (5 tools)',
        '  Workflows — POC    — create_poc, close_poc, delete_poc (3 tools, Cloud Admin only)',
        '  Workflows — Project— setup_project, close_project_resources, teardown_project (3 tools, Cloud Admin only)',
        '  Boilerplate        — get_test_boilerplate, validate_test_script (2 tools)',
        '  Agents             — list_agents, get_agent_devices (2 tools, Cloud Admin only)',
        '  Regions            — list_regions, get_region_topology (2 tools, Cloud Admin only)',
        '  NV Servers         — list_nv_servers, get_nv_server (2 tools, Cloud Admin only)',
        '  Sessions/Storage   — list_active_sessions, get_reporter_project_storage, get_license_info (3 tools, Cloud Admin only)',
        '  Project Admin      — get_project_admin_settings (1 tool, Project Admin or higher — 35+ config fields in one call)',
        '  Transactions       — list_transactions, get_transaction, get_transaction_performance_summary, get_performance_trend (4 tools, all roles — project-scoped for project-level keys)',
        '  Analytics          — get_test_stability_report, get_cross_platform_divergence, get_daily_execution_trend (3 tools)',
        '  Coverage           — get_device_coverage_summary, get_regional_test_coverage (2 tools)',
        '  Utilization        — get_license_utilization (1 tool, Cloud Admin only)',
        '  Remote Debug       — get_remote_debug_command (1 tool)',
        '  Inspection         — start/stop session, screenshot, element tree, find, tap, type, clear, gestures (swipe/long-press/double-tap/drag/pinch/scroll-to), keys, keyboard, app/device control, launch-app, list, cleanup (22 tools)',
        '',
        '── High-value analytics (35 of 50 industry-standard queries fully supported) ──',
        '  Functional quality:',
        '    • Overall pass rate + top failing tests for a date window  →  get_project_test_summary',
        '    • Pass/fail breakdown by OS, app version, device model     →  get_grouped_test_reports',
        '    • Execution history + stability trend for a named test     →  get_test_stability_report',
        '    • Tests failing on Android but passing on iOS (or reverse) →  get_cross_platform_divergence',
        '    • All failures today / tests over N seconds duration       →  list_test_reports',
        '    • Step-level detail for a specific failure                 →  get_test_report',
        '    • Status distribution (Error vs Failed vs Incomplete)      →  get_grouped_test_reports',
        '    • Daily/weekly execution volume + pass rate trend          →  get_daily_execution_trend',
        '  Performance:',
        '    • CPU / memory / battery / Speed Index by app version      →  get_transaction_performance_summary',
        '    • Performance by device type, model, screen, or NV profile →  get_transaction_performance_summary',
        '    • Slowest transactions ranked by Speed Index               →  get_transaction_performance_summary',
        '    • CPU / memory time-series for a specific transaction      →  get_transaction',
        '    • Performance trend over time (day/week/month)             →  get_performance_trend',
        '  Coverage:',
        '    • OS values, models, manufacturers tested vs. in inventory →  get_device_coverage_summary',
        '    • Device farm layout and availability by region            →  get_regional_test_coverage',
        '    • App versions that have appeared in test history          →  get_failure_rate_by_app_version',
        '  Infrastructure:',
        '    • Device farm health (Available / Offline / Error counts)  →  get_device_health_summary',
        '    • Orphaned sessions (In Use > N hours)                     →  release_orphaned_sessions',
        '    • Agent health + device counts by region                   →  list_agents',
        '    • Region topology (NV servers, Selenium agents, signers)   →  get_region_topology',
        '    • License usage vs purchased limits                        →  get_license_utilization',
        '    • Per-project storage usage and quota proximity            →  get_reporter_project_storage',
        '    • Active browser/Selenium sessions by user and project     →  list_active_sessions',
        '  See docs/analytics-gap-analysis.md for the full 50-item capability map.',
        '',
        'If a tool you expect is missing, the Docker image is stale.',
        'Rebuild: docker build -t digital-ai-testing-mcp:latest .',
        'Then call check_connectivity to verify the backend is reachable.',
      ];

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // ─── check_connectivity ────────────────────────────────────────────────────

  server.tool(
    'check_connectivity',
    'Verifies that this MCP server can reach the Digital.ai backend API. Makes a single lightweight call to the account-info endpoint and reports success or the error. Use this immediately after confirming get_server_info to validate end-to-end connectivity.',
    {},
    async () => {
      const baseUrl = process.env['DIGITAL_AI_BASE_URL'] ?? '(not set)';
      try {
        const info = await getMyAccountInfo();
        const lines = [
          `✅ Connectivity OK — ${baseUrl}`,
          `   Authenticated as: ${info.username} (${info.firstName} ${info.lastName})`,
          `   Role: ${info.role}`,
          `   Project context: ${info.project?.name ?? 'none'} (ID: ${info.project?.id ?? 'n/a'})`,
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (e) {
        return {
          content: [{ type: 'text', text: `❌ Connectivity FAILED — ${baseUrl}\n   Error: ${(e as Error).message}\n\n   Check: DIGITAL_AI_BASE_URL and DIGITAL_AI_ACCESS_KEY in your .env file.` }],
          isError: true,
        };
      }
    }
  );

  // ─── check_workflow_readiness ──────────────────────────────────────────────

  server.tool(
    'check_workflow_readiness',
    'Returns a structured readiness report for all six workflow tools (create_poc, close_poc, delete_poc, setup_project, close_project_resources, teardown_project). ' +
    'For each workflow, reports whether the tool itself is registered and whether every tool it depends on ' +
    '(read and write) is available in the current runtime. ' +
    'Call this first when diagnosing workflow execution failures — a stale Docker image is the most common cause of missing tools. ' +
    'If any workflow shows ready: false, rebuild the image: docker build -t digital-ai-testing-mcp:latest .',
    {},
    async () => {
      const readiness = computeWorkflowReadiness(server);
      const allReady = Object.values(readiness).every(s => s.ready);

      const structured = {
        allWorkflowsReady: allReady,
        registeredToolCount: Object.values(readiness)[0]?.registeredCount ?? 0,
        workflows: Object.fromEntries(
          Object.entries(readiness).map(([wf, s]) => [
            wf,
            {
              ready: s.ready,
              workflowToolPresent: s.workflowPresent,
              missingRead: s.missingRead,
              missingWrite: s.missingWrite,
              requiredRead: WORKFLOW_DEPS[wf]?.read ?? [],
              requiredWrite: WORKFLOW_DEPS[wf]?.write ?? [],
            },
          ])
        ),
      };

      const lines: string[] = [
        allReady
          ? `✅ All workflow tools ready (${structured.registeredToolCount} tools registered)`
          : `⚠️ One or more workflows have missing dependencies`,
        '',
      ];

      for (const [wf, s] of Object.entries(readiness)) {
        const icon = s.ready ? '✅' : '❌';
        lines.push(`${icon} ${wf}: ${s.ready ? 'ready' : 'NOT READY'}`);
        if (!s.workflowPresent) {
          lines.push(`     ⚠️ Workflow tool itself is not registered`);
        }
        if (s.missingRead.length > 0) {
          lines.push(`     Missing read tools : ${s.missingRead.join(', ')}`);
        }
        if (s.missingWrite.length > 0) {
          lines.push(`     Missing write tools: ${s.missingWrite.join(', ')}`);
        }
      }

      if (!allReady) {
        lines.push('');
        lines.push('To fix: docker build -t digital-ai-testing-mcp:latest . then restart the container.');
      }

      return { content: [{ type: 'text', text: JSON.stringify(structured) + '\n\n' + lines.join('\n') }] };
    }
  );

  // ─── list_environments ────────────────────────────────────────────────────

  server.tool(
    'list_environments',
    'List all named connection profiles configured in the environment. ' +
    'Each profile typically corresponds to either a specific project (project-level key — Project Admin or Project User, aut_1_...) or full platform access (Cloud Admin). ' +
    'Shows profile name, target URL, and auth type for each. API keys are never included in the response. ' +
    'Use this when the user asks which projects or environments are available. ' +
    'Use switch_environment to activate a different profile — that is how you change which project you are working with.',
    {},
    () => {
      const profiles = listProfiles();
      const active = getActiveProfileName();
      const lines = profiles.map(p => {
        const marker = p.name === active ? ' ← active' : '';
        return `  ${p.name}${marker}: ${p.url} (${p.keyType})`;
      });
      const structured = {
        activeProfile: active,
        profiles: profiles.map(p => ({ ...p, active: p.name === active })),
      };
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(structured) + '\n\n' +
            `Configured profiles (${profiles.length}):\n` + lines.join('\n') +
            (profiles.length === 1 ? '\n\nNo named profiles found. Add DAI_PROFILE_*_URL / DAI_PROFILE_*_KEY pairs to your .env to configure additional environments.' : ''),
        }],
      };
    }
  );

  // ─── switch_environment ───────────────────────────────────────────────────

  server.tool(
    'switch_environment',
    'Switch the active API connection to a different named profile. ' +
    'Each profile holds a distinct set of credentials — typically either a project-level key (Project Admin or Project User, scoped to one project) or a Cloud Admin key (full platform access). ' +
    'TRIGGER PHRASES: "switch projects", "change project", "change project context", "use a different project", "access project X", "work on project X" — all of these mean the user wants to switch to the profile that holds the target project\'s key. ' +
    '"Switch to cloud admin", "switch to admin", "switch to full access" — these mean the user wants the Cloud Admin profile. ' +
    'Project-level keys are single-project scoped: there is no API call to change project within a key — the only way to work with a different project is to switch to a profile that holds that project\'s credentials. ' +
    'Use list_environments first to show the user available profiles so they can pick the right one. ' +
    'All subsequent tool calls use the new profile\'s URL and credentials immediately — no restart required. ' +
    'Accepts either the exact profile name OR role-based aliases: "cloud admin" / "admin" / "full access" resolve to the first Cloud Admin profile; "project" resolves to the only project-level profile (or lists options if multiple exist).',
    {
      profileName: z
        .string()
        .describe('Profile name (case-insensitive) OR a role alias: "cloud admin", "admin", "full access" → first Cloud Admin profile; "project" → first/only project-level profile. Use list_environments to see available names.'),
    },
    async ({ profileName }) => {
      const profiles = listProfiles();
      let resolvedName = profileName;

      // Role-based fuzzy resolution — only when the exact name is not found.
      if (!getProfileCredentials(profileName)) {
        const lower = profileName.toLowerCase().trim();
        const isAdminAlias = ['cloud admin', 'cloudadmin', 'admin', 'full access', 'cloud', 'jwt'].includes(lower);
        const isProjectAlias = ['project', 'project key', 'project-level', 'project admin', 'project user'].includes(lower);

        if (isAdminAlias) {
          const adminProfiles = profiles.filter(p => p.keyType === 'jwt');
          if (adminProfiles.length === 1) {
            resolvedName = adminProfiles[0].name;
          } else if (adminProfiles.length > 1) {
            const names = adminProfiles.map(p => `"${p.name}"`).join(', ');
            return {
              content: [{ type: 'text' as const, text: `Multiple Cloud Admin profiles found: ${names}. Which one do you want to switch to?` }],
            };
          } else {
            return {
              content: [{ type: 'text' as const, text: `No Cloud Admin profiles configured. Add a Cloud Admin key to your .env:\n  DAI_PROFILE_ADMIN_URL=https://your-tenant.experitest.com/\n  DAI_PROFILE_ADMIN_KEY=eyJ...your-cloud-admin-key...` }],
            };
          }
        } else if (isProjectAlias) {
          const projectProfiles = profiles.filter(p => p.keyType === 'api-key');
          if (projectProfiles.length === 1) {
            resolvedName = projectProfiles[0].name;
          } else if (projectProfiles.length > 1) {
            const names = projectProfiles.map(p => `"${p.name}"`).join(', ');
            return {
              content: [{ type: 'text' as const, text: `Multiple project profiles found: ${names}. Which project do you want to switch to?` }],
            };
          } else {
            return {
              content: [{ type: 'text' as const, text: `No project-level profiles configured. Add a project key to your .env:\n  DAI_PROFILE_PROJECT_URL=https://your-tenant.experitest.com/\n  DAI_PROFILE_PROJECT_KEY=aut_1_...your-project-key...` }],
            };
          }
        } else {
          // Unrecognized name — return helpful disambiguation without isError
          const available = profiles.map(p => {
            const type = p.keyType === 'jwt' ? 'Cloud Admin' : 'project-level';
            return `"${p.name}" (${type})`;
          }).join(', ');
          return {
            content: [{ type: 'text' as const, text: `Profile "${profileName}" not found. Available profiles: ${available}.\n\nYou can also use aliases: "cloud admin" → Cloud Admin profile; "project" → project-level profile.` }],
          };
        }
      }

      const creds = getProfileCredentials(resolvedName);
      if (!creds) {
        const available = profiles.map(p => `"${p.name}"`).join(', ');
        return {
          content: [{
            type: 'text',
            text: `Profile "${resolvedName}" not found. Available profiles: ${available}.\n\nTo add a profile, add these lines to your .env and restart:\n  DAI_PROFILE_${profileName.toUpperCase()}_URL=https://your-tenant.experitest.com/\n  DAI_PROFILE_${profileName.toUpperCase()}_KEY=your_access_key`,
          }],
          isError: true,
        };
      }

      const previousProfile = getActiveProfileName();
      resetClient(creds.url, creds.key, resolvedName.toLowerCase());

      // Verify the new connection works
      let verifyLine = '';
      try {
        const me = await getMyAccountInfo();
        verifyLine = `Connected as: ${me.username} — Project: ${me.project.name} (${me.project.isAppiumOss ? 'Appium Server' : 'Appium Grid'})`;
      } catch {
        verifyLine = '⚠️  Connection established but account verification failed — check that the key is valid for this environment.';
      }

      const activeProfile = profiles.find(p => p.name === resolvedName.toLowerCase());

      return {
        content: [{
          type: 'text',
          text: [
            `✅ Switched from "${previousProfile}" to "${resolvedName.toLowerCase()}"${resolvedName.toLowerCase() !== profileName.toLowerCase() ? ` (resolved from "${profileName}")` : ''}`,
            `   URL: ${activeProfile?.url ?? creds.url}`,
            `   Auth: ${activeProfile?.keyType ?? 'unknown'}`,
            `   ${verifyLine}`,
          ].join('\n'),
        }],
      };
    }
  );
}
