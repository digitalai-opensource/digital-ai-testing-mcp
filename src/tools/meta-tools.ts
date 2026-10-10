import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getMyAccountInfo } from '../api/users.js';
import { resetClient, getActiveProfileName, getActiveUrl } from '../api/client.js';
import { getToolCatalog } from '../utils/tool-catalog.js';
import { getAccessInfo, resolveProfileAccess, primeAccessInfoFromAccount } from '../api/access-level.js';
import { describeLevel, isKnownNotCloudAdmin } from '../utils/access-level.js';
import { getServerVersion } from '../utils/version.js';
import { listProfiles, getProfileCredentials, profileCount } from '../utils/profile-loader.js';
import { computeWorkflowReadiness, WORKFLOW_DEPS } from '../utils/tool-registry.js';
import { staleBuildRemedy } from '../utils/locality.js';

// Canonical list of every tool registered by this server.
// Update this when adding or removing tools so get_server_info stays accurate.
export const REGISTERED_TOOLS = [
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
  'delete_test_reports_before_date', 'delete_test_reports_by_name', 'download_test_attachments', 'download_test_video',
  'get_test_attachments_download_command', 'get_test_log', 'summarize_test_failures',
  'list_test_attachments', 'list_active_test_executions', 'share_test_report', 'get_root_cause_analysis',
  // Test Views
  'list_test_views', 'search_test_views', 'get_test_view', 'get_test_view_summary',
  'create_test_view', 'update_test_view', 'delete_test_view',
  // Meta
  'get_server_info', 'check_connectivity', 'check_workflow_readiness',
  'list_environments', 'switch_environment', 'enable_toolset',
  // Workflows — POC lifecycle
  'create_poc', 'close_poc', 'delete_poc',
  // Workflows — General project lifecycle
  'setup_project', 'close_project_resources', 'teardown_project',
  // Boilerplate
  'get_test_boilerplate', 'get_web_test_boilerplate', 'validate_test_script', 'install_test_orchestrator_agent',
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
  'list_inspection_sessions', 'cleanup_inspection_sessions', 'mock_authentication', 'automotive_control',
  // Inspection sessions — web (Selenium Grid, browser inspection)
  'start_browser_inspection_session', 'stop_browser_inspection_session',
  'navigate_to', 'get_page_dom', 'browser_action', 'find_web_elements',
  'list_browser_inspection_sessions', 'cleanup_browser_inspection_sessions',
  // Performance comparison (all roles; transaction-control is session-based)
  'compare_performance_transactions', 'assess_comparison_confounds',
  'detect_performance_outliers', 'performance_transaction_control',
  // Usage reports (v2, Cloud Admin only)
  'download_usage_report', 'get_usage_report_download_command', 'summarize_usage_report',
  // Test runs — Espresso / XCUITest / Maestro executed by the platform
  'execute_test_run', 'get_test_run_status', 'cancel_test_run', 'get_test_run_command', 'generate_maestro_flow',
  // Debug mode only (MCP_DEBUG_MODE=true) — not registered otherwise, so not in TOOL_COUNT
  'record_remediation_note',
] as const;

export const DEBUG_ONLY_TOOLS: readonly string[] = ['record_remediation_note'];
export const TOOL_COUNT = REGISTERED_TOOLS.length - DEBUG_ONLY_TOOLS.length;

// Short descriptions per tool module; counts come from the registrations themselves (src/utils/tool-catalog.ts).
const DOMAINS: Array<[module: string, label: string, note: string]> = [
  ['users', 'Users', 'list, create, delete, assign, tag'],
  ['devices', 'Devices', 'list, detail, control, tag, find available, release orphaned sessions'],
  ['device-groups', 'Device Groups', 'list, create, edit, delete, assign'],
  ['reservations', 'Reservations', 'list, create, reserve now, delete, availability window'],
  ['applications', 'Applications', 'list, upload, install, uninstall, bulk install, plugins, language files'],
  ['repository', 'File Repository', 'list, upload, download, update, delete'],
  ['provisioning-profiles', 'Provisioning', 'list, detail, upload, download, delete'],
  ['browsers', 'Browsers', 'list, Selenium session, manual session'],
  ['projects', 'Projects', 'list, create, delete, users, tokens, settings, admin settings'],
  ['backup', 'Backup', 'create'],
  ['health', 'Health & Platform', 'environment summary, iOS readiness, agent status, active sessions, storage, license, utilization'],
  ['agents', 'Agents', 'list, devices (Cloud Admin)'],
  ['regions', 'Regions', 'list, topology (Cloud Admin)'],
  ['nv-servers', 'NV Servers', 'list, detail (Cloud Admin)'],
  ['reporting', 'Reporting', 'search, summaries, failures, root-cause analysis, stability, trends, logs, video, share links, delete'],
  ['test-views', 'Test Views', 'list, search, detail, summary, create, update, delete'],
  ['coverage', 'Coverage', 'device and regional coverage'],
  ['transactions', 'Transactions', 'list, detail, performance summary, trend (all roles)'],
  ['performance', 'Performance Comparison', 'compare, confounds, outliers, transaction control (all roles)'],
  ['usage-reports', 'Usage Reports', 'summarize, download, download command (Cloud Admin)'],
  ['boilerplate', 'Boilerplate', 'Appium/Selenium test projects, Test Orchestrator agent, validate_test_script'],
  ['test-runs', 'Test Runs', 'Espresso/XCUITest/Maestro runs, status, cancel, command, Maestro flow generation'],
  ['inspection', 'Mobile Inspection', 'live sessions: element tree, find, tap, type, gestures, keys, app/device control, Android Auto / CarPlay'],
  ['web-inspection', 'Browser Inspection', 'live browser sessions: DOM, find, navigate, actions'],
  ['debug', 'Remote Debug', 'get_remote_debug_command'],
  ['workflows', 'Workflows', 'POC and project setup / teardown (Cloud Admin)'],
  ['meta', 'Server', 'server info, connectivity, workflow readiness, environments'],
  ['toolsets', 'Toolsets', 'enable_toolset'],
  ['remediation', 'Debug Mode', 'record_remediation_note'],
];

export function capabilityLines(): string[] {
  const catalog = getToolCatalog();
  const known = new Set(DOMAINS.map(([m]) => m));
  const line = (label: string, note: string, n: number) => `  ${label.padEnd(22)} — ${note} (${n} tool${n === 1 ? '' : 's'})`;
  const lines = DOMAINS.filter(([m]) => (catalog.get(m)?.length ?? 0) > 0).map(([m, label, note]) => line(label, note, catalog.get(m)!.length));
  // A module added later without a description still shows up, with its tool names.
  for (const [m, tools] of catalog) if (!known.has(m) && tools.length) lines.push(line(m, tools.join(', '), tools.length));
  return lines;
}

export function registerMetaTools(server: McpServer): void {
  // ─── get_server_info ───────────────────────────────────────────────────────

  server.tool(
    'get_server_info',
    'Returns the running server version, target API URL, registered tool count, and capability domains. Call this first to verify the running build matches the expected version — if tools are missing, update it: ' + staleBuildRemedy(),
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
        primeAccessInfoFromAccount(me); // one request serves both the project line and the access level below
        const mode = me.project.isAppiumOss ? 'Appium Server (OSS)' : 'Appium Grid';
        projectLine = `Project:          ${me.project.name} (ID: ${me.project.id}) — ${mode} — Role: ${me.role}`;
      } catch {
        // non-fatal — server info still useful without project details
      }

      const keyLabel = describeLevel(await getAccessInfo());
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
        `Registered tools: ${TOOL_COUNT} tools + 2 resources + 7 prompts`,
        '',
        'Capability domains:',
        ...capabilityLines(),
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
        'If a tool you expect is missing, the running build is stale.',
        staleBuildRemedy(),
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
      // The ACTIVE profile's URL — process.env reflects the default profile only and ignores switch_environment.
      const baseUrl = getActiveUrl() || '(not set)';
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
    'Call this first when diagnosing workflow execution failures — a stale build is the most common cause of missing tools. ' +
    'If any workflow shows ready: false, update: ' + staleBuildRemedy(),
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
    'Each profile typically corresponds to either a specific project (Project Admin or Project User) or full platform access (Cloud Admin). ' +
    'Shows profile name, target URL, and the access level DETECTED FROM THE API for each (role + accessLevel) — key format is not a privilege indicator: a Cloud Admin may hold either a long eyJ... key or a short aut_1_... key. API keys are never included in the response. ' +
    'Use this when the user asks which projects or environments are available. ' +
    'Use switch_environment to activate a different profile — that is how you change which project you are working with.',
    {},
    async () => {
      const active = getActiveProfileName();
      const profiles = await Promise.all(
        listProfiles().map(async (p) => {
          const info = await resolveProfileAccess(p.name);
          return { ...p, accessLevel: info.level, role: info.role ?? null };
        })
      );
      const lines = profiles.map(p => {
        const marker = p.name === active ? ' ← active' : '';
        return `  ${p.name}${marker}: ${p.url} (${describeLevel({ level: p.accessLevel, role: p.role ?? undefined, source: 'role' })})`;
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
    'Each profile holds a distinct set of credentials — typically either a project-scoped key (Project Admin or Project User) or a Cloud Admin key (full platform access); the level is detected from the API, not from the key format. ' +
    'TRIGGER PHRASES: "switch projects", "change project", "change project context", "use a different project", "access project X", "work on project X" — all of these mean the user wants to switch to the profile that holds the target project\'s key. ' +
    '"Switch to cloud admin", "switch to admin", "switch to full access" — these mean the user wants the Cloud Admin profile. ' +
    'Project-scoped credentials are single-project scoped: there is no API call to change project within a key — the only way to work with a different project is to switch to a profile that holds that project\'s credentials. ' +
    'Use list_environments first to show the user available profiles so they can pick the right one. ' +
    'All subsequent tool calls use the new profile\'s URL and credentials immediately — no restart required. ' +
    'Accepts either the exact profile name OR role-based aliases: "cloud admin" / "admin" / "full access" resolve to the Cloud Admin profile; "project" resolves to the only project-scoped profile (or lists options if multiple exist).',
    {
      profileName: z
        .string()
        .describe('Profile name (case-insensitive) OR a role alias: "cloud admin", "admin", "full access" → first Cloud Admin profile; "project" → first/only project-level profile. Use list_environments to see available names.'),
    },
    async ({ profileName }) => {
      const profiles = listProfiles();
      let resolvedName = profileName;
      // Access levels resolved lazily — only needed for alias resolution / disambiguation.
      const levelsOf = () => Promise.all(profiles.map(async (p) => ({ ...p, info: await resolveProfileAccess(p.name) })));

      // Role-based fuzzy resolution — only when the exact name is not found.
      if (!getProfileCredentials(profileName)) {
        const lower = profileName.toLowerCase().trim();
        const isAdminAlias = ['cloud admin', 'cloudadmin', 'admin', 'full access', 'cloud'].includes(lower);
        const isProjectAlias = ['project', 'project key', 'project-level', 'project admin', 'project user'].includes(lower);

        if (isAdminAlias) {
          const adminProfiles = (await levelsOf()).filter(p => p.info.level === 'cloud-admin');
          if (adminProfiles.length === 1) {
            resolvedName = adminProfiles[0].name;
          } else if (adminProfiles.length > 1) {
            const names = adminProfiles.map(p => `"${p.name}"`).join(', ');
            return {
              content: [{ type: 'text' as const, text: `Multiple Cloud Admin profiles found: ${names}. Which one do you want to switch to?` }],
            };
          } else {
            return {
              content: [{ type: 'text' as const, text: `No Cloud Admin profile detected. Add a Cloud Admin key to your .env (either key format works — access is detected from the API):\n  DAI_PROFILE_ADMIN_URL=https://your-tenant.experitest.com/\n  DAI_PROFILE_ADMIN_KEY=<your-cloud-admin-key>` }],
            };
          }
        } else if (isProjectAlias) {
          const projectProfiles = (await levelsOf()).filter(p => isKnownNotCloudAdmin(p.info.level));
          if (projectProfiles.length === 1) {
            resolvedName = projectProfiles[0].name;
          } else if (projectProfiles.length > 1) {
            const names = projectProfiles.map(p => `"${p.name}"`).join(', ');
            return {
              content: [{ type: 'text' as const, text: `Multiple project profiles found: ${names}. Which project do you want to switch to?` }],
            };
          } else {
            return {
              content: [{ type: 'text' as const, text: `No project-scoped profiles detected. Add a project key to your .env:\n  DAI_PROFILE_PROJECT_URL=https://your-tenant.experitest.com/\n  DAI_PROFILE_PROJECT_KEY=<your-project-key>` }],
            };
          }
        } else {
          // Unrecognized name — return helpful disambiguation without isError
          const available = (await levelsOf()).map(p => `"${p.name}" (${describeLevel(p.info)})`).join(', ');
          return {
            content: [{ type: 'text' as const, text: `Profile "${profileName}" not found. Available profiles: ${available}.\n\nYou can also use aliases: "cloud admin" → Cloud Admin profile; "project" → project-scoped profile.` }],
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
        primeAccessInfoFromAccount(me); // avoids a second my-account-info probe for the access line below
        verifyLine = `Connected as: ${me.username} — Project: ${me.project.name} (${me.project.isAppiumOss ? 'Appium Server' : 'Appium Grid'})`;
      } catch {
        verifyLine = '⚠️  Connection established but account verification failed — check that the key is valid for this environment.';
      }

      const activeProfile = profiles.find(p => p.name === resolvedName.toLowerCase());
      const accessLine = describeLevel(await getAccessInfo());

      return {
        content: [{
          type: 'text',
          text: [
            `✅ Switched from "${previousProfile}" to "${resolvedName.toLowerCase()}"${resolvedName.toLowerCase() !== profileName.toLowerCase() ? ` (resolved from "${profileName}")` : ''}`,
            `   URL: ${activeProfile?.url ?? creds.url}`,
            `   Access: ${accessLine}`,
            `   ${verifyLine}`,
          ].join('\n'),
        }],
      };
    }
  );
}
