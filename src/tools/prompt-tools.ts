import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerPrompts(server: McpServer): void {
  // ─── Create POC Environment ────────────────────────────────────────────────

  server.prompt(
    'create_poc',
    'Guided 10-step workflow to set up a complete POC environment: device group, device selection and tagging, project, users, and app assignment. Collects all required parameters upfront and confirms with the operator before executing each major phase.',
    {
      customerName: z
        .string()
        .describe('Customer name, e.g. "Acme Corp". The POC display name will be "<name> POC" and the tag will be the lowercase alphanumeric form.'),
      region: z
        .string()
        .describe('Region code where the customer will test, e.g. "US2", "EU", "SG". Used to select geographically close devices.'),
      deviceCount: z
        .string()
        .optional()
        .describe('Total number of phones to allocate (default: 6).'),
      iosCount: z
        .string()
        .optional()
        .describe('Number of iOS phones in the mix. Defaults to half of deviceCount.'),
      androidCount: z
        .string()
        .optional()
        .describe('Number of Android phones in the mix. Defaults to half of deviceCount.'),
      automationType: z
        .string()
        .optional()
        .describe('"appium-server" (default) or "appium-grid". Controls the project automation mode.'),
      salesforceUrl: z
        .string()
        .describe('Salesforce Opportunity URL — recorded in project notes.'),
      endDate: z
        .string()
        .describe('POC end date, e.g. "2026-08-31" — recorded in project notes alongside the Salesforce URL.'),
      users: z
        .string()
        .describe(
          'JSON array of users to create. Each object must have: email (string), firstName (string), lastName (string), role ("User" or "ProjectAdmin"). ' +
          'Example: [{"email":"alice@co.com","firstName":"Alice","lastName":"Smith","role":"User"},{"email":"bob@co.com","firstName":"Bob","lastName":"Jones","role":"ProjectAdmin"}]'
        ),
      appName: z
        .string()
        .optional()
        .describe('Name of the demo app to assign (default: "ExperiBank"). Must exist in the Default project app repository.'),
      appVersion: z
        .string()
        .optional()
        .describe('Version of the demo app to assign (default: "1.0").'),
    },
    ({ customerName, region, deviceCount, iosCount, androidCount, automationType, salesforceUrl, endDate, users, appName, appVersion }) => {
      const pocName = `${customerName.trim()} POC`;
      const pocTag = customerName.toLowerCase().replace(/[^a-z0-9]/g, '') + 'poc';
      const appiumOSS = (automationType ?? 'appium-server') !== 'appium-grid';
      const automationLabel = appiumOSS ? 'Appium Server (appiumOSS: true)' : 'Appium Grid (appiumOSS: false)';

      const total = parseInt(deviceCount ?? '6', 10);
      const ios = iosCount ? parseInt(iosCount, 10) : Math.ceil(total / 2);
      const android = androidCount ? parseInt(androidCount, 10) : Math.floor(total / 2);
      const deviceDesc = `${total} phones total — ${ios} iOS + ${android} Android`;
      const targetAppName = appName ?? 'ExperiBank';
      const targetAppVersion = appVersion ?? '1.0';

      const lines = [
        `You are executing a guided POC setup workflow. Work through each step in order.`,
        `Do not skip steps or reorder them — later steps depend on IDs returned by earlier steps.`,
        ``,
        `═══════════════════════════════════════════════`,
        `CONFIRMED PARAMETERS`,
        `═══════════════════════════════════════════════`,
        `POC Display Name : ${pocName}`,
        `POC Device Tag   : ${pocTag}  (lowercase, alphanumeric only — spaces and special chars stripped)`,
        `Target Region    : ${region}`,
        `Device Mix       : ${deviceDesc}`,
        `Automation Type  : ${automationLabel}`,
        `Salesforce URL   : ${salesforceUrl}`,
        `POC End Date     : ${endDate}`,
        `Users            : ${users}`,
        ``,
        `─── STEP 0 — Operator confirmation ──────────────────────────────────────`,
        `Before executing anything, present the parameters above to the operator in a`,
        `clean summary and ask for explicit confirmation to proceed.`,
        `If the operator wants to change anything, stop and collect corrections.`,
        `Only proceed past this step when the operator says yes.`,
        ``,
        `─── STEP 1 — Create the POC device group ────────────────────────────────`,
        `Call: create_device_group`,
        `  name: "${pocName}"`,
        `  acceptNewDevices: false`,
        ``,
        `SAVE the returned device group ID as <POC_GROUP_ID>.`,
        ``,
        `─── STEP 2 — Locate the Default device group ────────────────────────────`,
        `Call: list_device_groups`,
        `Find the entry whose name is exactly "Default" and note its ID as <DEFAULT_GROUP_ID>.`,
        ``,
        `─── STEP 3 — Select devices for the POC ─────────────────────────────────`,
        `Call: get_devices_in_group`,
        `  groupId: <DEFAULT_GROUP_ID>`,
        ``,
        `From the returned list, select devices that satisfy ALL of the following rules:`,
        ``,
        `  REQUIRED — include only:`,
        `    • deviceCategory === "PHONE"  (never TABLET, WATCH, or UNKNOWN)`,
        `    • displayStatus === "Available"  (skip Offline, Cleanup, Initializing, or any error state)`,
        `    • region contains "${region}" (case-insensitive partial match)`,
        ``,
        `  REQUIRED — exclude any device whose tags array contains a value that (case-insensitive):`,
        `    • contains "DONOTUSE" or "DO NOT USE"`,
        `    • contains "POC"`,
        `    • contains "INUSE" or "IN USE"`,
        `    • otherwise suggests the device is restricted, reserved by another team, or in conflict`,
        `    (Tags used for data centre or support group assignment are fine — exclude only conflict indicators)`,
        ``,
        `  TARGET MIX: ${deviceDesc}`,
        `    • Prefer modern models (last 2–3 device generations)`,
        `    • If fewer than ${total} devices pass all filters, select all that do and report the shortfall`,
        `    • If the iOS/Android split cannot be met exactly, fill with available devices from the other OS`,
        ``,
        `Present the proposed selection to the operator as a table:`,
        `  Device Name | OS | Model | Region | Tags`,
        `Ask for confirmation before proceeding to Step 4.`,
        `Save the confirmed device IDs as <SELECTED_DEVICE_IDS>.`,
        ``,
        `─── STEP 4 — Add selected devices to the POC group ──────────────────────`,
        `Call: add_devices_to_group`,
        `  groupId: <POC_GROUP_ID>`,
        `  deviceIds: <SELECTED_DEVICE_IDS>`,
        ``,
        `─── STEP 5 — Tag all selected devices with the POC tag ──────────────────`,
        `For each device in <SELECTED_DEVICE_IDS>, call: add_device_tag`,
        `  deviceId: <device ID>`,
        `  tag: "${pocTag}"`,
        ``,
        `Run these calls sequentially. If any individual tag call fails, report the failure`,
        `and continue tagging the remaining devices — do not abort the workflow.`,
        ``,
        `─── STEP 6 — Remove selected devices from the Default device group ───────`,
        `Call: remove_devices_from_group`,
        `  groupId: <DEFAULT_GROUP_ID>`,
        `  deviceIds: <SELECTED_DEVICE_IDS>`,
        `  confirmDeletion: true`,
        ``,
        `NOTE: confirmDeletion:true is correct here. This removal is an intentional`,
        `step in this scripted workflow, not an ad-hoc destructive action.`,
        ``,
        `─── STEP 7 — Create the POC project ─────────────────────────────────────`,
        `Call: create_project`,
        `  name: "${pocName}"`,
        `  deviceGroupName: "${pocName}"`,
        `  appiumOSS: ${appiumOSS}`,
        ``,
        `SAVE the returned project ID as <POC_PROJECT_ID>.`,
        ``,
        `Immediately after, call: set_project_notes`,
        `  projectId: <POC_PROJECT_ID>`,
        `  notes: "Salesforce Opportunity: ${salesforceUrl}\\nPOC End Date: ${endDate}"`,
        ``,
        `─── STEP 8 — Find the Default project ID ────────────────────────────────`,
        `Call: list_projects`,
        `Find the project named exactly "Default" and note its ID as <DEFAULT_PROJECT_ID>.`,
        `You will need this in Step 9 to remove users from the Default project.`,
        ``,
        `─── STEP 9 — Create users and assign them to the POC project ────────────`,
        ``,
        `CRITICAL RULES — enforce these without exception:`,
        `  • Never grant Cloud Admin access to any user`,
        `  • Every user must be removed from the Default project after creation`,
        `  • role must be "User" or "ProjectAdmin" only — if any entry specifies "Admin", refuse and flag it`,
        ``,
        `Parse the users JSON: ${users}`,
        ``,
        `For each user, execute these sub-steps in order:`,
        ``,
        `  9a. Call: create_user`,
        `        username: <email>`,
        `        firstName: <firstName>`,
        `        lastName: <lastName>`,
        `        email: <email>`,
        `        role: <role>  ("User" or "ProjectAdmin")`,
        `        authenticationType: "BASIC"`,
        `      SAVE the returned user ID as <USER_ID>.`,
        ``,
        `  9b. Call: assign_user_to_project`,
        `        projectId: <POC_PROJECT_ID>`,
        `        userId: <USER_ID>`,
        `        role: <role>`,
        ``,
        `  9c. Call: remove_user_from_project`,
        `        projectId: <DEFAULT_PROJECT_ID>`,
        `        userId: <USER_ID>`,
        `        confirmDeletion: true`,
        `      NOTE: confirmDeletion:true is correct — removing POC users from Default`,
        `      is an intentional step in this workflow.`,
        ``,
        `If step 9a (create_user) fails, report it and continue with the next user.`,
        `If step 9b or 9c fails, report it in the completion summary — the user exists but`,
        `needs manual project assignment or Default project removal. Continue with remaining users.`,
        ``,
        `─── STEP 10 — Assign ${targetAppName} ${targetAppVersion} to the POC project ──────────────────`,
        `Call: list_applications`,
        `Search for an application whose name contains "${targetAppName}" and whose version is "${targetAppVersion}".`,
        `If multiple matches are found, prefer the most recently uploaded one.`,
        ``,
        `If no matching app is found:`,
        `  • Report this clearly in the completion summary`,
        `  • Do not abort — mark Step 10 as incomplete and note manual action is required`,
        ``,
        `If found, call: assign_app_to_project`,
        `  projectId: <POC_PROJECT_ID>`,
        `  applicationId: <app ID>`,
        ``,
        `NOTE: This grants the POC project access to the same shared app binary — it is not`,
        `an independent copy. If an independent copy is needed (e.g. for separate versioning),`,
        `a manual download and re-upload to the new project will be required.`,
        ``,
        `═══════════════════════════════════════════════`,
        `COMPLETION SUMMARY`,
        `═══════════════════════════════════════════════`,
        `After all steps complete, present a final summary:`,
        ``,
        `  ✅ POC Name         : ${pocName}`,
        `  ✅ Device Group ID  : <POC_GROUP_ID>`,
        `  ✅ Devices allocated: <count> (<iOS count> iOS, <Android count> Android)`,
        `  ✅ POC Tag applied  : ${pocTag}`,
        `  ✅ Project ID       : <POC_PROJECT_ID>`,
        `  ✅ Project Notes    : Salesforce URL + End Date recorded`,
        `  ✅ Users created    : <count> (list names and roles)`,
        `  ✅ ${targetAppName} ${targetAppVersion}: assigned to project (or ⚠️ not found — manual action needed)`,
        `  ⚠️  Any warnings, shortfalls, or individual step failures`,
      ];

      return {
        messages: [{
          role: 'user',
          content: { type: 'text', text: lines.join('\n') },
        }],
      };
    }
  );

  // ─── Investigate Test Failures ─────────────────────────────────────────────

  server.prompt(
    'investigate_test_failures',
    'Guide a structured investigation of recent test failures for a project. Produces a triage report with failure counts, top failing tests, and suggested next steps.',
    {
      projectName: z.string().optional().describe('Project to investigate. Leave blank to investigate all projects.'),
      hoursBack: z.string().optional().describe('How many hours of history to examine (default: 24).'),
    },
    ({ projectName, hoursBack }) => {
      const hours = parseInt(hoursBack ?? '24', 10);
      const since = new Date(Date.now() - hours * 3_600_000).toISOString();
      const scope = projectName ? `project "${projectName}"` : 'all projects';

      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Please investigate test failures in ${scope} over the last ${hours} hours (since ${since}).`,
              '',
              'Use these tools in order:',
              `1. get_project_test_summary with startDate="${since}"${projectName ? ` and projectName="${projectName}"` : ''} — get overall pass/fail counts and top failing tests.`,
              `2. list_test_reports with filter status=Failed, sort start_time descending, limit 10${projectName ? `, projectName="${projectName}"` : ''} — see the most recent failures in detail.`,
              `3. get_distinct_test_key_values with keys=["device.os","status"]${projectName ? `, projectName="${projectName}"` : ''} — check if failures are concentrated on a specific OS or device type.`,
              '',
              'After gathering the data, provide:',
              '  • A one-paragraph summary of the failure situation.',
              '  • A bullet list of the top failing tests with failure counts.',
              '  • Whether failures appear to be device/OS-specific or widespread.',
              '  • Recommended next steps (e.g. re-run, investigate a specific device, check a specific test).',
            ].join('\n'),
          },
        }],
      };
    }
  );

  // ─── Device Farm Health Check ──────────────────────────────────────────────

  server.prompt(
    'device_farm_health_check',
    'Run a full device farm health check: device availability, agent connectivity, and orphaned session detection.',
    {},
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            'Please run a complete device farm health check using these tools:',
            '',
            '1. get_environment_summary — overall environment snapshot.',
            '2. get_agent_status — check which agents are connected and report any offline agents.',
            '3. check_ios_readiness — verify iOS devices and provisioning profiles are ready.',
            '4. check_android_readiness — verify Android devices are ready.',
            '5. release_orphaned_sessions with maxAgeHours=4 (dry run, no confirmDeletion) — identify any stuck sessions.',
            '',
            'After gathering the data, provide:',
            '  • Overall farm health: Healthy / Degraded / Critical.',
            '  • Count of available vs. in-use vs. offline devices.',
            '  • Any agents that are offline or have connectivity issues.',
            '  • Any orphaned sessions that should be released.',
            '  • Recommended actions to restore full capacity.',
          ].join('\n'),
        },
      }],
    })
  );

  // ─── Prepare for Test Run ──────────────────────────────────────────────────

  server.prompt(
    'prepare_test_run',
    'Check device availability and app readiness before starting a test run.',
    {
      os: z.string().optional().describe('Target OS: "iOS" or "Android".'),
      appName: z.string().optional().describe('App unique name to verify is uploaded and available.'),
      projectName: z.string().optional().describe('Project the test run belongs to.'),
    },
    ({ os, appName, projectName }) => {
      const steps: string[] = [
        'Please prepare the environment for an upcoming test run:',
        '',
      ];

      if (os) {
        steps.push(`1. find_available_device with os="${os}" — confirm at least one target device is free.`);
      } else {
        steps.push('1. find_available_device — find any available device to confirm farm capacity.');
      }

      if (appName) {
        steps.push(`2. list_applications with uniqueName filter for "${appName}" — confirm the app is uploaded and note its ID and version.`);
      }

      if (projectName) {
        steps.push(`3. get_automation_properties with projectName="${projectName}" — retrieve Appium/automation connection details.`);
      }

      steps.push(
        `${appName ? '3' : '2'}. get_agent_status — confirm at least one agent is online and connected.`,
        '',
        'After checking, summarise:',
        '  • Whether the farm is ready to run tests (yes/no).',
        '  • Available device count and which device to target.',
        appName ? `  • App "${appName}" version and ID.` : '',
        '  • Any blockers that need resolving before starting.',
      );

      return {
        messages: [{
          role: 'user',
          content: { type: 'text', text: steps.filter(Boolean).join('\n') },
        }],
      };
    }
  );
}
