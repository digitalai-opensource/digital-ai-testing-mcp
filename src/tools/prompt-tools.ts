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

  // ─── Performance Comparison Report ─────────────────────────────────────────

  server.prompt(
    'performance_comparison_report',
    'Plan and run a rigorous performance comparison between two sets of conditions (app versions, device models, ' +
    'OS versions, regions, network profiles, or two automation scripts), using Digital.ai performance transactions. ' +
    'Scrubs confounds, negotiates sample size, REQUIRES explicit plan confirmation, runs the series with outlier-driven ' +
    'reruns, then reports the Speed Index delta (trimmed mean + median + raw mean) with root-cause reasoning.',
    {
      comparisonGoal: z.string().describe('What to compare, in the user\'s words — e.g. "sampleapp v1.0 vs v2.0 on a Galaxy S21" or "Login speed US2 vs SG1".'),
      appName: z.string().optional().describe('App name to scope the analysis (used with list_applications / list_transactions).'),
      mode: z.string().optional().describe('"existing" to analyze transactions already in the reporter, "fresh" to generate a new sample series via inspection sessions, or blank to let the agent recommend.'),
    },
    ({ comparisonGoal, appName, mode }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `I want a performance comparison report. Goal: ${comparisonGoal}`,
            appName ? `App: ${appName}` : '',
            mode ? `Preferred data source: ${mode}` : '',
            '',
            'Performance transactions work for all access levels — Cloud Admin sees all projects; project-level keys see only their own project\'s transactions.',
            'If you need cross-project transaction data, switch to Cloud Admin with switch_environment("default") before proceeding.',
            '',
            'Follow these phases IN ORDER. Do not skip the confirmation gate in Phase 3.',
            '',
            '═══ PHASE 0 — Define the comparison axis and the two sides ═══',
            'State precisely what is SUPPOSED to differ (the comparison axis: appVersion / deviceModel / deviceOs /',
            'deviceVersion / networkProfile / region / testId) and what should be held constant. Define side A and side B',
            'in one sentence each. If my goal is ambiguous about the axis, ask me before continuing.',
            '',
            '═══ PHASE 1 — Source the data and scrub confounds ═══',
            'Decide existing-data vs fresh-generation:',
            '  • EXISTING (prefer when suitable transactions already exist): use list_transactions to gather candidate',
            '    transactions for each side. Then call assess_comparison_confounds with the comparisonAxis from Phase 0.',
            '    Present the validity verdict (clean / caveated / confounded) and every flag. If CONFOUNDED, work with me',
            '    to re-select the sides to hold the confounding factor constant — do NOT proceed to a delta on confounded data.',
            '  • FRESH (when no clean historical data exists): minimize extraneous noise before generating:',
            '      - Device health: get_device_health_summary and list_devices for each candidate device; exclude any with',
            '        Offline status or statusAge > 1440 min. If comparing something OTHER than device, ensure both sides use',
            '        similar-capability devices (or the same device) and similar configuration (same networkProfile unless',
            '        that IS the axis).',
            '      - Pin the hardware: a deviceQuery matching multiple OS versions can also match multiple device MODELS,',
            '        which confounds the comparison. Constrain each side to a single model (@model=\'<code>\') or one',
            '        physical device (@serialNumber=\'<udid>\') so every sample of that side runs on identical hardware.',
            '      - NV server: performance transactions record NOTHING unless an NV server in the device\'s region is ONLINE',
            '        and tunnel-connected. Call list_nv_servers(region=<device region>) and confirm one is up BEFORE generating.',
            '        If none is available, stop and tell me — fresh generation cannot proceed.',
            '      - Network profile: default to "Monitor" (pass-through — measures real performance without throttling).',
            '        Only use a throttling profile ("3G-average", "wifi", …) if constrained network IS the comparison axis.',
            '      - Recent reliability: get_test_stability_report / recent results for the chosen devices to avoid a flaky one.',
            '      - Verify the test flow is fully functional on each target platform FIRST (real selectors from a live',
            '        inspection — never fabricated). A broken flow produces garbage samples.',
            '      - Note honestly that true host/background interference is not directly observable — approximate via idle,',
            '        healthy status, and no concurrent reservation; state this limitation in the final report.',
            '',
            '═══ PHASE 2 — Negotiate sample size and build the plan ═══',
            'Recommend a per-side sample size based on transaction length: SHORT transactions (≲5 s) → at least 10 samples',
            'per side; LONG transactions → as few as 5. HARD FLOOR: never fewer than 4 per side — below 4, outlier',
            'detection is skipped entirely and a single bad run silently dominates the aggregate. Ask me to confirm or adjust.',
            'Then assemble a PLAN NARRATIVE containing: the axis, both sides, the controlled factors, the device(s),',
            'the networkProfile (state "Monitor" unless throttling is the axis), the per-side sample size, the TOTAL',
            'number of discrete transactions to run, and an ESTIMATED wall-clock time (≈ transaction duration × total',
            'runs + overhead + ~1 min reporter-write delay per transaction).',
            '',
            '═══ PHASE 3 — MANDATORY CONFIRMATION GATE ═══',
            'Present the full plan narrative and scope. Then STOP and ask: "Run this plan? It will execute N discrete',
            'transactions across both sides, taking roughly T minutes." DO NOT execute anything until I explicitly confirm.',
            'If I want changes, revise and re-confirm. This gate is required — never run the series without my yes.',
            '',
            '═══ PHASE 4 — Execute the series (only after confirmation) ═══',
            'For FRESH generation, per comparison point repeat N times: performance_transaction_control(action:"start",',
            'networkProfile) → run the SAME verified flow with tap/type/launch → performance_transaction_control(action:"end",',
            'transactionName). Wait ~1 minute, then read each record with list_transactions → get_transaction.',
            'After collecting each side, run detect_performance_outliers on Speed Index. If a sample is flagged as a wild',
            'outlier, treat it as a candidate failure: re-run that one sample (excluding the bad result). If the SAME sample',
            'fails/outlies MORE THAN ONCE, STOP and ask me how to proceed (e.g. try a different device or host) — do not',
            'silently keep a bad data point or loop forever.',
            'For EXISTING data, run detect_performance_outliers and decide exclusions with me.',
            '',
            '═══ PHASE 5 — Compare and report ═══',
            'Call compare_performance_transactions with both sides, metrics including speedIndex (add cpuAvg/memAvg if telemetry',
            'is present), comparisonAxis from Phase 0, and excludeOutliers:true. Report, for Speed Index, the TRIMMED MEAN,',
            'MEDIAN, and RAW MEAN per side, the delta and % change, and the per-side sample counts (with any exclusions).',
            'Re-run assess_comparison_confounds on the final sets and include the validity verdict.',
            'Speed Index is a COMPOSITE visual-progress score (area above the render curve), NOT elapsed time — report its',
            'delta in "SI" units and describe it as "more/less complete rendering earlier in the window", NEVER as',
            '"rendered N ms faster". Reserve wall-clock language for the duration metric.',
            'Write a report that: (1) states the delta and whether it is meaningful given the spread (CV) and sample size;',
            '(2) attributes it to the axis ONLY if the confound assessment is clean/caveated, otherwise says it cannot be',
            'attributed; (3) offers a plausible root cause where reasonable (e.g. larger asset in v2, slower GPU on device B,',
            'higher network latency in region Y); (4) lists the limitations (missing telemetry, small N, unobservable host load).',
            'Be honest when a delta is within noise — a "no significant difference" result is a valid, useful outcome.',
          ].filter(Boolean).join('\n'),
        },
      }],
    })
  );

  // ─── Collaborative Test Creation ───────────────────────────────────────────

  server.prompt(
    'collaborative_test_creation',
    'Build a mobile test script together with the user: live inspection session with a shareable device view, ' +
    'element discovery, interactive verification of each step, and final script generation with verified selectors.',
    {
      appName: z.string().optional().describe('App name to search for (e.g. "Sample App"). Used with list_applications.'),
      language: z.string().optional().describe('Target script language: "java", "python", or "nodejs". Default python.'),
    },
    ({ appName, language }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            'I want to create a mobile test script collaboratively. Follow this procedure exactly:',
            '',
            'MODE CHECK — this prompt drives the INTERACTIVE experience (live device, shared view URL, step-by-step ' +
            'collaboration). If my answers below reveal that my intent is actually fully specified (a standardized flow ' +
            'or complete step-level detail) AND you can derive verified selectors (app source code or a quick silent ' +
            'inspection session), offer the faster autonomous path: "I have everything I need — want me to just build ' +
            'this test for you, or continue interactively?"',
            '',
            'FIRST — before any tool calls — explain the plan to me:',
            '  "Here\'s how we\'ll build this together:',
            '   1. Find (or upload) the app and an available device near the cloud server',
            '   2. Install the app, then start a live inspection session — I\'ll share a live view URL so you can follow along',
            '   3. Launch the app and capture element selectors from the real UI',
            '   4. Interact with the UI to observe real behavior (success and failure states)',
            '   5. Generate the test script with verified selectors and assertions"',
            '',
            'Then execute:',
            '',
            `1. list_applications${appName ? ` with nameContains="${appName}"` : ''} — check what is in the repository.`,
            '   IF NOT FOUND: ask — "That app isn\'t in the Digital.ai repository yet. Do you have a local',
            '   binary (APK / IPA / AAB) to upload? If so, share the full path and your OS (Windows, macOS,',
            '   or Linux)." Call get_application_upload_command(localFilePath, localPlatform, uniqueName),',
            '   share the command, WAIT for upload confirmation, then re-run list_applications.',
            '   IF FOUND: surface the version to me — "I found [App Name] build [buildVersion] / release',
            '   [releaseVersion] in the repository. Is this the version you want to test, or do you have',
            '   a newer build to upload?" WAIT for my answer. If I want to upload a newer build, ask for',
            '   the file path and OS, call get_application_upload_command, share the command, WAIT for',
            '   confirmation, then re-run list_applications to get the updated appId.',
            '   Do NOT proceed past step 1 until I have confirmed which version to use.',
            '2. get_application_info(appId) — note packageName AND mainActivity (needed to launch the app).',
            '3. find_available_device(os="Android") — region preference is automatic; note the device id and region.',
            '4. install_application(applicationId, deviceId) — install BEFORE starting the session; ' +
            'installation fails while the device is reserved by a session.',
            '5. start_inspection_session(region from step 3) — the response includes viewUrl and debugUrl. ' +
            'IMMEDIATELY share both URLs with me before doing anything else so I can watch.',
            '6. launch_app(handle, packageName, mainActivity from step 2) — bring the app to the foreground.',
            '7. take_inspection_screenshot — confirm the expected screen is visible.',
            '8. get_element_tree — capture locators for the screen under test.',
            '9. Walk through the test flow with me step by step: type_into_element / tap_element / swipe_screen, ' +
            'screenshotting after each action and narrating what you observe. Verify both the success path ' +
            'and at least one failure path (e.g. wrong credentials) so the script has real assertions.',
            '',
            '   STEP CONFIRMATION GATE — mandatory after EVERY completed scenario:',
            '     a. Show me a running numbered list of all steps captured so far.',
            '     b. Ask: "I\'ve captured [summary of step just done]. Want to add another step — ',
            '        for example a success path, a failure path, a different screen, or a different scenario —',
            '        or are you ready for me to generate the script?"',
            '     c. WAIT for my explicit answer before calling get_test_boilerplate or stop_inspection_session.',
            '     d. If my phrasing included "start with", "first", or "begin by" — treat that as a signal',
            '        more steps are planned: do NOT finalize after only the first step.',
            '     e. Keep the session alive between steps: call take_inspection_screenshot periodically',
            '        if I am thinking (resets the idle timeout without moving on).',
            '     f. Only when I say "that\'s it" / "generate it" / "done" / "looks good" proceed to step 10.',
            '',
            `10. ONLY after I confirm all steps are captured: get_test_boilerplate(appId, platform="android", language="${language ?? 'python'}", region from step 3) — use as the scaffold.`,
            '11. stop_inspection_session — always, even on error; but only AFTER step 10 completes (or on my explicit stop request).',
            '12. Present the final test file using the locators and behaviors verified in steps 8-9.',
            '',
            'Throughout: narrate each step before you take it, and pause to ask me before changing direction.',
          ].join('\n'),
        },
      }],
    })
  );
}
