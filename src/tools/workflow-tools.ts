import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { computeWorkflowReadiness } from '../utils/tool-registry.js';

/** Normalise an end-date string to YYYY-MM-DD.
 *  Accepts ISO dates, relative offsets (+14d, +2w, "in 2 weeks"), or
 *  any string that JavaScript's Date constructor can parse.
 *  Falls back to the raw string if it cannot be parsed so no input is lost.
 */
function normalizeEndDate(raw: string): string {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const daysMatch = trimmed.match(/^\+?(\d+)\s*d(?:ays?)?$/i);
  if (daysMatch) {
    const d = new Date();
    d.setDate(d.getDate() + parseInt(daysMatch[1], 10));
    return d.toISOString().slice(0, 10);
  }

  const weeksMatch = trimmed.match(/^\+?(\d+)\s*w(?:eeks?)?$/i);
  if (weeksMatch) {
    const d = new Date();
    d.setDate(d.getDate() + parseInt(weeksMatch[1], 10) * 7);
    return d.toISOString().slice(0, 10);
  }

  const inMatch = trimmed.match(/^in\s+(\d+)\s*(weeks?|days?|months?)/i);
  if (inMatch) {
    const n = parseInt(inMatch[1], 10);
    const unit = inMatch[2].toLowerCase();
    const d = new Date();
    if (unit.startsWith('week')) d.setDate(d.getDate() + n * 7);
    else if (unit.startsWith('day')) d.setDate(d.getDate() + n);
    else if (unit.startsWith('month')) d.setMonth(d.getMonth() + n);
    return d.toISOString().slice(0, 10);
  }

  const parsed = new Date(trimmed);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);

  return trimmed;
}

export function registerWorkflowTools(server: McpServer): void {
  /** Returns a hard-error response if any dependency of `workflow` is not registered,
   *  or null if the workflow is ready to run. */
  function preflightCheck(workflow: string): { content: Array<{ type: 'text'; text: string }>; isError: true } | null {
    const readiness = computeWorkflowReadiness(server, workflow);
    const status = readiness[workflow];
    if (!status || status.ready) return null;
    const missing = [...status.missingRead, ...status.missingWrite];
    return {
      content: [{
        type: 'text',
        text: [
          `❌ ${workflow} cannot execute — ${missing.length} required tool(s) are not registered in this runtime:`,
          ...missing.map(t => `  • ${t}`),
          '',
          'This indicates the deployed Docker image is incomplete or a module failed to load at startup.',
          'Call check_workflow_readiness for the full dependency report.',
          'To fix: docker build -t digital-ai-testing-mcp:latest . then restart the container.',
        ].join('\n'),
      }],
      isError: true,
    };
  }

  // ─── create_poc ────────────────────────────────────────────────────────────

  server.tool(
    'create_poc',
    'Guided 10-step workflow to set up a complete POC environment: device group, device selection and tagging, project creation, user provisioning, and app assignment. Call this tool with all required parameters — it returns step-by-step instructions that you will then execute using the individual MCP tools.',
    {
      customerName: z
        .string()
        .describe('Customer name, e.g. "Acme Corp". POC display name will be "<name> POC"; device tag will be the lowercase alphanumeric form (e.g. "acmecorppoc").'),
      region: z
        .string()
        .describe('Region code where the customer will test, e.g. "US2", "EU", "SG". Used to select geographically close devices from the Default device group.'),
      deviceCount: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Total number of phones to allocate (default: 6). Tablets are never selected.'),
      iosCount: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Number of iOS phones. Defaults to ceil(deviceCount / 2).'),
      androidCount: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Number of Android phones. Defaults to floor(deviceCount / 2).'),
      automationType: z
        .enum(['appium-server', 'appium-grid'])
        .optional()
        .describe('"appium-server" (default, recommended) or "appium-grid".'),
      salesforceUrl: z
        .string()
        .describe('Salesforce Opportunity URL — recorded in project notes.'),
      endDate: z
        .string()
        .describe('POC end date. Accepts ISO format ("2026-08-31"), relative offsets ("+14d", "+2w"), or natural language ("in 2 weeks"). Stored in project notes.'),
      users: z
        .array(
          z.object({
            email: z.string().describe('Email address, also used as the login username.'),
            firstName: z.string().describe('First name.'),
            lastName: z.string().describe('Last name.'),
            role: z
              .enum(['User', 'ProjectAdmin'])
              .describe('"User" for standard access, "ProjectAdmin" for project management access. Cloud Admin is never permitted for POC users.'),
          })
        )
        .min(1)
        .describe('Users to create. Each user gets the email as username, is assigned to the POC project, and is removed from the Default project.'),
      appName: z
        .string()
        .optional()
        .describe('Display name of the demo app used in notes and summaries (default: "ExperiBank").'),
      androidPackageName: z
        .string()
        .optional()
        .describe('Android package name used to locate the APK in the repository (default: "com.experitest.ExperiBank"). Searched via the packageName filter — more reliable than display name.'),
      iosBundleId: z
        .string()
        .optional()
        .describe('iOS bundle identifier used to locate the IPA in the repository (default: "com.experitest.ExperiBank"). Searched via the bundleIdentifier filter — more reliable than display name.'),
    },
    ({ customerName, region, deviceCount, iosCount, androidCount, automationType, salesforceUrl, endDate, users, appName, androidPackageName, iosBundleId }) => {
      const guard = preflightCheck('create_poc');
      if (guard) return guard;

      const pocName = `${customerName.trim()} POC`;
      const pocTag = customerName.toLowerCase().replace(/[^a-z0-9]/g, '') + 'poc';
      const appiumOSS = (automationType ?? 'appium-server') !== 'appium-grid';
      const automationLabel = appiumOSS ? 'Appium Server (appiumOSS: true)' : 'Appium Grid (appiumOSS: false)';

      const total = deviceCount ?? 6;
      const ios = iosCount ?? Math.ceil(total / 2);
      const android = androidCount ?? Math.floor(total / 2);
      const deviceDesc = `${total} phones total — ${ios} iOS + ${android} Android`;
      const targetAppName = appName ?? 'ExperiBank';
      const targetAndroidPkg = androidPackageName ?? 'com.experitest.ExperiBank';
      const targetIosBundleId = iosBundleId ?? 'com.experitest.ExperiBank';
      const resolvedEndDate = normalizeEndDate(endDate);

      const userLines = users.map(
        (u, i) => `  User ${i + 1}: ${u.firstName} ${u.lastName} <${u.email}> — role: ${u.role}`
      ).join('\n');

      const instructions = [
        `You are executing a guided POC setup workflow. Work through each numbered step in order.`,
        `Do not skip steps or reorder them — later steps depend on IDs returned by earlier ones.`,
        `This workflow is idempotent: if a group or project named "${pocName}" already exists,`,
        `reuse it rather than creating a duplicate. See individual steps for details.`,
        ``,
        `═══════════════════════════════════════════════`,
        `CONFIRMED PARAMETERS`,
        `═══════════════════════════════════════════════`,
        `POC Display Name : ${pocName}`,
        `POC Device Tag   : ${pocTag}  (lowercase alphanumeric — spaces and special chars stripped)`,
        `Target Region    : ${region}`,
        `Device Mix       : ${deviceDesc}`,
        `Automation Type  : ${automationLabel}`,
        `Salesforce URL   : ${salesforceUrl}`,
        `POC End Date     : ${resolvedEndDate}`,
        `Users to create  :`,
        userLines,
        ``,
        `─── STEP 0 — App pre-flight check + Operator confirmation ──────────────`,
        `Before presenting parameters to the operator, verify app availability:`,
        ``,
        ...(android > 0 ? [
          `Android check — call: list_applications`,
          `  packageName: "${targetAndroidPkg}"`,
          `  outputFormat: "json"`,
          `Set ANDROID_APP_FOUND = true if any result is returned, and note the app ID of the`,
          `most recently uploaded entry as ANDROID_APP_ID.`,
          ``,
        ] : []),
        ...(ios > 0 ? [
          `iOS check — call: list_applications`,
          `  bundleIdentifier: "${targetIosBundleId}"`,
          `  outputFormat: "json"`,
          `Set iOS_APP_FOUND = true if any result is returned, and note the app ID of the`,
          `most recently uploaded entry as IOS_APP_ID.`,
          ``,
        ] : []),
        ...(ios > 0 ? [
          `⚠️ iOS devices requested (${ios}) — if iOS_APP_FOUND is false:`,
          `  Include in the summary: "WARNING: No iOS binary for bundle ID '${targetIosBundleId}' found in repository."`,
          `  Ask the operator to proceed without it or upload an IPA first.`,
        ] : []),
        ...(android > 0 ? [
          `⚠️ Android devices requested (${android}) — if ANDROID_APP_FOUND is false:`,
          `  Include in the summary: "WARNING: No Android binary for package '${targetAndroidPkg}' found in repository."`,
          `  Ask the operator to proceed without it or upload an APK first.`,
        ] : []),
        ``,
        `Then present the full parameters above in a clean summary table, include any`,
        `app warnings, and ask for explicit operator confirmation before executing any steps.`,
        `If the operator wants to change anything, stop and collect corrections.`,
        `Only proceed past this step when the operator confirms.`,
        ``,
        `─── STEP 1 — Create or reuse the POC device group ───────────────────────`,
        `First call: list_device_groups`,
        `  outputFormat: "json"`,
        `Check if a group named exactly "${pocName}" already exists in deviceGroups[].`,
        ``,
        `  IF IT EXISTS:`,
        `    • Note its id as POC_GROUP_ID and skip the create_device_group call.`,
        `    • Report "Device group reused (not created)" in the completion summary.`,
        ``,
        `  IF IT DOES NOT EXIST:`,
        `    Call: create_device_group`,
        `      name: "${pocName}"`,
        `      acceptNewDevices: false`,
        `    SAVE the returned device group ID as POC_GROUP_ID.`,
        ``,
        `─── STEP 2 — Locate the Default device group ────────────────────────────`,
        `Call: list_device_groups (you may already have this from Step 1)`,
        `  outputFormat: "json"`,
        `Find the entry whose name is exactly "Default" and note its id as DEFAULT_GROUP_ID.`,
        ``,
        `─── STEP 3 — Select devices for the POC ─────────────────────────────────`,
        `Call: get_devices_in_group`,
        `  groupId: DEFAULT_GROUP_ID`,
        `  category: "PHONE"`,
        `  status: "Available"`,
        `  excludeTags: ["DoNotTake", "DONTTAKE", "DONOTUSE", "Worksoft", "Worksoft_Temp"]`,
        `  outputFormat: "json"`,
        ``,
        `The server pre-filters to Available phones and strips all known restriction-tagged devices.`,
        `From the returned list apply these additional rules:`,
        ``,
        `  INCLUDE only devices where:`,
        `    • region contains "${region}" (case-insensitive partial match)`,
        ``,
        `  EXCLUDE any remaining device whose tags array:`,
        `    • contains "POC" (case-insensitive) — already in another active POC`,
        `    • otherwise clearly indicates restriction (e.g. "INUSE", "reserved") not already filtered`,
        ``,
        `  TARGET MIX: ${deviceDesc}`,
        `    • Prefer modern models (last 2–3 device generations)`,
        `    • Aim for ${ios} iOS and ${android} Android phones`,
        `    • If the split cannot be met exactly, fill the shortfall from the other OS`,
        `    • If fewer than ${total} devices pass all filters, select all that qualify and report the gap`,
        ``,
        `Present the proposed device selection as a table to the operator:`,
        `  Device Name | OS | Model | Region | Tags`,
        `Ask for confirmation before continuing. Save confirmed device IDs as SELECTED_DEVICE_IDS.`,
        ``,
        `─── STEP 4 — Add selected devices to the POC device group ───────────────`,
        `Call: add_devices_to_group`,
        `  groupId: POC_GROUP_ID`,
        `  deviceIds: SELECTED_DEVICE_IDS`,
        ``,
        `─── STEP 5 — Tag all selected devices with the POC tag ──────────────────`,
        `For each device in SELECTED_DEVICE_IDS:`,
        `  • Check the device's existing tags (visible in the Step 3 response).`,
        `  • If the device already has the tag "${pocTag}", skip it — no action needed.`,
        `  • Otherwise call: add_device_tag`,
        `      deviceId: <device ID>`,
        `      tag: "${pocTag}"`,
        ``,
        `Call this for every untagged device individually. If a tag call fails on one device,`,
        `report it and continue with the remaining devices — do not abort.`,
        ``,
        `─── STEP 6 — Create or reuse the POC project ────────────────────────────`,
        `(Project creation comes BEFORE removing devices from Default — if it fails,`,
        `the devices are still in the Default group and nothing needs to be unwound.)`,
        ``,
        `First call: list_projects`,
        `  outputFormat: "json"`,
        `Check if a project named exactly "${pocName}" already exists in projects[].`,
        ``,
        `  IF IT EXISTS:`,
        `    • Note its ID as POC_PROJECT_ID and skip the create_project call.`,
        `    • Report "Project reused (not created)" in the completion summary.`,
        ``,
        `  IF IT DOES NOT EXIST:`,
        `    Call: create_project`,
        `      name: "${pocName}"`,
        `      deviceGroupName: "${pocName}"`,
        `      appiumOSS: ${appiumOSS}`,
        `    SAVE the returned project ID as POC_PROJECT_ID.`,
        ``,
        `In both cases (reuse or create), call: set_project_notes`,
        `  projectId: POC_PROJECT_ID`,
        `  notes: "Salesforce Opportunity: ${salesforceUrl}\\nPOC End Date: ${resolvedEndDate}"`,
        ``,
        `─── STEP 7 — Remove selected devices from the Default device group ───────`,
        `Do this ONLY after Step 6 succeeded — the project must exist before devices`,
        `leave the Default pool, or a failure would strand them in a project-less group.`,
        ``,
        `Call: remove_devices_from_group`,
        `  groupId: DEFAULT_GROUP_ID`,
        `  deviceIds: SELECTED_DEVICE_IDS`,
        `  confirmDeletion: true`,
        ``,
        `confirmDeletion:true is correct here — this removal is an intentional,`,
        `pre-authorised step in this scripted workflow.`,
        ``,
        `─── STEP 8 — Locate the Default project ID ──────────────────────────────`,
        `Call: list_projects (you may already have this from Step 6)`,
        `  outputFormat: "json"`,
        `Find the project named exactly "Default" and note its id as DEFAULT_PROJECT_ID.`,
        `You will need this in Step 9 to remove users from the Default project.`,
        ``,
        `─── STEP 9 — Create users and assign them to the POC project ────────────`,
        ``,
        `CRITICAL RULES — enforce without exception:`,
        `  • Never grant Cloud Admin access to any user`,
        `  • Every user must be removed from the Default project after creation`,
        `  • role must be "User" or "ProjectAdmin" only`,
        ``,
        `For each user listed below, execute sub-steps a → b → c → d in order:`,
        ``,
        userLines,
        ``,
        `  a. Call: create_user`,
        `       username: <email>`,
        `       firstName: <firstName>`,
        `       lastName: <lastName>`,
        `       email: <email>`,
        `       role: <role>  ("User" or "ProjectAdmin" — never "Admin")`,
        `       authenticationType: "BASIC"`,
        `     SAVE the returned user ID as USER_ID.`,
        ``,
        `  b. Call: assign_user_to_project`,
        `       projectId: POC_PROJECT_ID`,
        `       userId: USER_ID`,
        `       role: <role>`,
        ``,
        `  c. Call: remove_user_from_project`,
        `       projectId: DEFAULT_PROJECT_ID`,
        `       userId: USER_ID`,
        `       confirmDeletion: true`,
        `     confirmDeletion:true is correct — removing POC users from Default`,
        `     is an intentional, pre-authorised step in this workflow.`,
        ``,
        `  d. Call: set_user_tags`,
        `       userId: USER_ID`,
        `       tags: ["${pocTag}"]`,
        `     ⚠️ REQUIRED — do not skip. This tag is how close_poc and delete_poc identify`,
        `     POC-created users. Without it, those workflows cannot auto-identify this user`,
        `     and the operator will have to find and remove them manually.`,
        `     If this call fails, record it explicitly in the completion summary as a WARNING`,
        `     (not just a note) — the account works, but manual tracking is now required.`,
        ``,
        `Failure handling (isolate — do not abort the whole workflow):`,
        `  • If 9a (create_user) fails: record the failure, skip 9b, 9c, and 9d for this user,`,
        `    continue with the next user. The operator will need to create this account manually.`,
        `  • If 9b (assign_user_to_project) fails: record it and attempt 9c and 9d anyway, then`,
        `    continue. The account exists but needs manual project assignment.`,
        `  • If 9c (remove_user_from_project) fails: record it and continue.`,
        `    The account exists and is assigned to the POC project; Default project removal`,
        `    will need to be done manually.`,
        `  • If 9d (set_user_tags) fails: record it as a WARNING in the completion summary.`,
        `    The account works but will not be found by close_poc/delete_poc tag filter.`,
        ``,
        `─── STEP 10 — Assign ${targetAppName} apps to the POC project ──────────────────────`,
        `Use the app IDs already resolved during the Step 0 pre-flight check.`,
        ``,
        ...(android > 0 ? [
          `Android assignment:`,
          `  If ANDROID_APP_FOUND is true (ANDROID_APP_ID is known from Step 0):`,
          `    Call: assign_app_to_project`,
          `      projectId: POC_PROJECT_ID`,
          `      applicationId: ANDROID_APP_ID`,
          `  If ANDROID_APP_FOUND is false:`,
          `    Report in summary: "Android binary for '${targetAndroidPkg}' not found — manual upload required."`,
          `    Do not abort — mark Android app assignment as incomplete.`,
          ``,
        ] : []),
        ...(ios > 0 ? [
          `iOS assignment:`,
          `  If iOS_APP_FOUND is true (IOS_APP_ID is known from Step 0):`,
          `    Call: assign_app_to_project`,
          `      projectId: POC_PROJECT_ID`,
          `      applicationId: IOS_APP_ID`,
          `  If iOS_APP_FOUND is false:`,
          `    Report in summary: "iOS binary for '${targetIosBundleId}' not found — manual upload required."`,
          `    Do not abort — mark iOS app assignment as incomplete.`,
          ``,
        ] : []),
        `NOTE: assign_app_to_project grants the POC project access to the shared binary.`,
        `It is not an independent copy — both projects reference the same record.`,
        ``,
        `═══════════════════════════════════════════════`,
        `IF ANY STEP FAILS`,
        `═══════════════════════════════════════════════`,
        `Stop at the failed step — do not improvise later steps out of order.`,
        `Report exactly which steps completed and include every resource ID created so far`,
        `(POC_GROUP_ID, POC_PROJECT_ID, SELECTED_DEVICE_IDS, user IDs) so the operator can:`,
        `  • Resume: re-invoke create_poc with the same parameters — Steps 1 and 6 detect`,
        `    and reuse the existing group/project instead of creating duplicates. Re-verify`,
        `    the Step 3 device selection (previously selected devices may already carry the`,
        `    POC tag or sit in the POC group — verify with get_devices_in_group before adding).`,
        `  • Unwind: run delete_poc, which returns devices to Default and removes the`,
        `    group, project, and users created so far.`,
        ``,
        `═══════════════════════════════════════════════`,
        `COMPLETION SUMMARY`,
        `═══════════════════════════════════════════════`,
        `After all steps complete, present a final summary:`,
        ``,
        `  ✅ POC Name         : ${pocName}`,
        `  ✅ Device Group     : <POC_GROUP_ID> (created or reused)`,
        `  ✅ Devices allocated: <count> (<iOS> iOS, <Android> Android)`,
        `  ✅ POC Tag applied  : ${pocTag}`,
        `  ✅ Project          : <POC_PROJECT_ID> (created or reused)`,
        `  ✅ Project Notes    : Salesforce URL + End Date recorded`,
        `  ✅ Users created    : <count> — for each user list: name, role, and tag status`,
        `                        e.g. "Jane Doe (ProjectAdmin) — tagged ✅" or "tagged ⚠️ FAILED"`,
        `  ✅ ${targetAppName}: Android and/or iOS assigned to project (or ⚠️ not found — see above)`,
        `  ⚠️  Any warnings, shortfalls, skipped steps, or individual step failures`,
        `  ⚠️  If any user tag failed: explicitly name each untagged user — they must be tracked manually`,
      ].join('\n');

      return {
        content: [{ type: 'text', text: instructions }],
      };
    }
  );

  // ─── close_poc ─────────────────────────────────────────────────────────────

  server.tool(
    'close_poc',
    'Guided workflow to cleanly close an active POC: removes the POC tag from devices, moves devices back to the Default group, and permanently deletes the user accounts that were created for the POC (identified by their POC tag, with per-user operator confirmation). Does not delete the project or device group — use delete_poc for full teardown.',
    {
      customerName: z
        .string()
        .describe('Customer name exactly as used when the POC was created (e.g. "Acme Corp"). Used to derive the POC project name and device tag.'),
    },
    ({ customerName }) => {
      const guard = preflightCheck('close_poc');
      if (guard) return guard;

      const pocName = `${customerName.trim()} POC`;
      const pocTag = customerName.toLowerCase().replace(/[^a-z0-9]/g, '') + 'poc';

      const instructions = [
        `You are executing a guided POC close-down workflow. Work through each step in order.`,
        ``,
        `═══════════════════════════════════════════════`,
        `CONFIRMED PARAMETERS`,
        `═══════════════════════════════════════════════`,
        `POC Name  : ${pocName}`,
        `POC Tag   : ${pocTag}`,
        ``,
        `─── STEP 0 — Operator confirmation ──────────────────────────────────────`,
        `Present the parameters above and ask the operator to confirm before proceeding.`,
        ``,
        `─── STEP 1 — Locate the POC project and device group ────────────────────`,
        `Call: list_projects`,
        `  outputFormat: "json"`,
        `Find the project named exactly "${pocName}" and note its id as POC_PROJECT_ID.`,
        `If no POC project exists, stop and report: "POC project not found — nothing to close."`,
        ``,
        `Call: list_device_groups`,
        `  outputFormat: "json"`,
        `Find the group named exactly "${pocName}" and note its id as POC_GROUP_ID.`,
        `Also find the group named exactly "Default" and note its id as DEFAULT_GROUP_ID.`,
        `If POC_GROUP_ID is not found, note this — Steps 2–4 will be skipped.`,
        ``,
        `─── STEP 2 — Get devices in the POC device group ─────────────────────────`,
        `If POC_GROUP_ID was found:`,
        `  Call: get_devices_in_group`,
        `    groupId: POC_GROUP_ID`,
        `    outputFormat: "json"`,
        `  Save all returned device IDs as POC_DEVICE_IDS.`,
        `  Present the device list to the operator (Device Name | OS | Tags) before continuing.`,
        ``,
        `If POC_GROUP_ID was not found, skip Steps 3 and 4.`,
        ``,
        `─── STEP 3 — Remove the POC tag from each device ────────────────────────`,
        `For each device in POC_DEVICE_IDS, call: remove_device_tag`,
        `  deviceId: <device ID>`,
        `  tag: "${pocTag}"`,
        ``,
        `Only remove the "${pocTag}" tag — leave all other tags on the device untouched.`,
        `If a remove_device_tag call fails (e.g. tag was already absent), record it and continue.`,
        ``,
        `─── STEP 4 — Move devices from POC group to Default group ───────────────`,
        `Call: remove_devices_from_group`,
        `  groupId: POC_GROUP_ID`,
        `  deviceIds: POC_DEVICE_IDS`,
        `  confirmDeletion: true`,
        `confirmDeletion:true is correct — this removal is an intentional step in this workflow.`,
        ``,
        `Call: add_devices_to_group`,
        `  groupId: DEFAULT_GROUP_ID`,
        `  deviceIds: POC_DEVICE_IDS`,
        ``,
        `─── STEP 5 — Identify and process POC user accounts ────────────────────`,
        `Call: list_users`,
        `  tag: "${pocTag}"`,
        `  outputFormat: "json"`,
        ``,
        `This returns only users who were tagged with "${pocTag}" during create_poc.`,
        `Users added to the project after POC creation will not have this tag and are not affected.`,
        ``,
        `For each returned user, inspect their "roles" field (a map of role → [project names]).`,
        `The exact shape is: {"<roleName>": ["<projectName>", ...], ...} — for example:`,
        `  "roles": { "ProjectAdmin": ["${pocName}"], "User": ["QA Team", "Staging"] }`,
        `Flatten all project names across all role keys (here: ["${pocName}", "QA Team", "Staging"])`,
        `and remove "${pocName}" from the list.`,
        `If a user's roles field is missing or not in this shape, STOP and show the raw record`,
        `to the operator — do not guess a classification that leads to account deletion.`,
        ``,
        `  • If the remaining project list is EMPTY → user belongs only to this POC → ELIGIBLE FOR DELETION`,
        `  • If the remaining project list is NON-EMPTY → user belongs to other projects → DO NOT DELETE`,
        `    Instead, only remove them from the POC project.`,
        ``,
        `Present the full list to the operator as a summary table with the recommended action:`,
        `  Name | Email | Other Projects | Action`,
        `  e.g. "Jane Doe | jane@co.com | (none) | Delete account"`,
        `  e.g. "Bob Smith | bob@co.com | QA Team, Staging | Remove from POC only"`,
        ``,
        `⚠️  IMPORTANT — Per-user confirmation is REQUIRED before acting on each account.`,
        `Although the tag filter is reliable, an admin may have temporarily added themselves`,
        `to the POC project (e.g. to impersonate a user), which could cause them to be`,
        `inadvertently caught in the tag filter if they were also tagged. Review each user`,
        `individually before proceeding.`,
        ``,
        `For EACH user in the list, in sequence:`,
        ``,
        `  1. Display the user record and recommended action:`,
        `       Name          : <firstName> <lastName>`,
        `       Email         : <email>`,
        `       Other projects: <list, or "(none)" if POC-only>`,
        `       Recommended   : <"Delete account" or "Remove from POC only">`,
        ``,
        `  2. Ask the operator: "<recommended action>? (yes / skip)"`,
        `     — Wait for an explicit answer before proceeding.`,
        `     — If the operator says SKIP: record the user as skipped and move on.`,
        ``,
        `  3a. If user is POC-only AND operator confirms YES:`,
        `      Call: delete_user`,
        `        userId: <user ID>`,
        `        confirmDeletion: true`,
        `      This cannot be undone. If this call fails, record it and continue.`,
        ``,
        `  3b. If user has other projects AND operator confirms YES:`,
        `      Call: remove_user_from_project`,
        `        projectId: POC_PROJECT_ID`,
        `        userId: <user ID>`,
        `        confirmDeletion: true`,
        `      This only removes their access to the POC project — their account and`,
        `      membership in all other projects is preserved.`,
        `      If this call fails, record it and continue.`,
        ``,
        `Record each user's outcome (deleted / removed from POC / skipped / failed) in the completion summary.`,
        ``,
        `═══════════════════════════════════════════════`,
        `COMPLETION SUMMARY`,
        `═══════════════════════════════════════════════`,
        `  ✅ POC Name        : ${pocName}`,
        `  ✅ Devices moved   : <count> moved from "${pocName}" group back to Default`,
        `  ✅ POC tag removed : "${pocTag}" removed from <count> devices`,
        `  ✅ Users — for each user list outcome:`,
        `       Deleted          : <count> (POC-only accounts permanently removed)`,
        `       Removed from POC : <count> (multi-project accounts — access revoked, account preserved)`,
        `       Skipped          : <count> (operator chose to skip)`,
        `  ⚠️  Project and device group "${pocName}" still exist — run delete_poc to remove them.`,
        `  ⚠️  Any warnings or individual step failures`,
      ].join('\n');

      return { content: [{ type: 'text', text: instructions }] };
    }
  );

  // ─── delete_poc ────────────────────────────────────────────────────────────

  server.tool(
    'delete_poc',
    'Guided workflow for full POC teardown: untags devices, moves them back to the Default group, permanently deletes all POC-tagged user accounts, then deletes the POC device group and project. Requires confirmDeletion: true. Presents a full pre-deletion inventory before any destructive action occurs.',
    {
      customerName: z
        .string()
        .describe('Customer name exactly as used when the POC was created (e.g. "Acme Corp"). Used to derive the POC project name and device tag.'),
      confirmDeletion: z
        .boolean()
        .describe('Must be true to receive the workflow instructions. Without this, no changes are made. The workflow will still present a pre-deletion inventory and require operator confirmation before any delete call.'),
    },
    ({ customerName, confirmDeletion }) => {
      const guard = preflightCheck('delete_poc');
      if (guard) return guard;

      const pocName = `${customerName.trim()} POC`;
      const pocTag = customerName.toLowerCase().replace(/[^a-z0-9]/g, '') + 'poc';

      if (confirmDeletion !== true) {
        return {
          content: [{
            type: 'text',
            text: [
              `⚠️  Safety guard triggered.`,
              ``,
              `"Delete POC \\"${pocName}\\"" permanently removes the device group and project and cannot be undone.`,
              ``,
              `To proceed with full deletion, call delete_poc again with confirmDeletion: true.`,
              ``,
              `💡 Best practice: Consider running close_poc first instead.`,
              `   close_poc safely winds down the POC — it returns devices to the Default group,`,
              `   removes the POC device tag, and revokes user access — without permanently deleting`,
              `   the project or device group. The data is preserved and the teardown is fully reversible.`,
              `   You can always run delete_poc later once you are confident nothing needs to be recovered.`,
              ``,
              `No changes were made.`,
            ].join('\n'),
          }],
        };
      }

      const instructions = [
        `You are executing a guided POC deletion workflow. Work through each step in order.`,
        `This workflow permanently deletes the POC device group and project. It cannot be undone.`,
        ``,
        `═══════════════════════════════════════════════`,
        `CONFIRMED PARAMETERS`,
        `═══════════════════════════════════════════════`,
        `POC Name  : ${pocName}`,
        `POC Tag   : ${pocTag}`,
        ``,
        `─── STEP 0 — Gather inventory and confirm with operator ──────────────────`,
        `Before executing anything, collect the full picture of what will be affected:`,
        ``,
        `  a. Call: list_projects`,
        `       outputFormat: "json"`,
        `     Find "${pocName}", note POC_PROJECT_ID.`,
        `     If not found, stop and report: "POC project not found — nothing to delete."`,
        ``,
        `  b. Call: list_device_groups`,
        `       outputFormat: "json"`,
        `     Find "${pocName}", note POC_GROUP_ID.`,
        `     Also find "Default" and note DEFAULT_GROUP_ID.`,
        `     If POC_GROUP_ID is not found, note this — Steps 1 and 2 will be skipped.`,
        ``,
        `  c. Call: get_devices_in_group`,
        `       groupId: POC_GROUP_ID`,
        `       outputFormat: "json"`,
        `     Record device count and names as POC_DEVICE_IDS.`,
        ``,
        `  d. Call: list_users`,
        `       tag: "${pocTag}"`,
        `       outputFormat: "json"`,
        `     These are POC_USERS — accounts tagged during create_poc.`,
        `     Any users added to the project after POC creation will not have this tag`,
        `     and are treated as OTHER_USERS (not affected by this workflow).`,
        ``,
        `     For each POC_USER, inspect their "roles" field and flatten all project names.`,
        `     The shape is {"<roleName>": ["<projectName>", ...]} — e.g.`,
        `       "roles": { "ProjectAdmin": ["${pocName}"], "User": ["QA Team"] } → ["${pocName}", "QA Team"]`,
        `     Remove "${pocName}" from the list.`,
        `       • If the remaining list is EMPTY → user is POC-only → classify as DELETE_USERS`,
        `       • If the remaining list is NON-EMPTY → user has other projects → classify as REVOKE_USERS`,
        `     If a user's roles field is missing or not in this shape, classify them as REVOKE_USERS`,
        `     (the safe action) and flag the raw record to the operator in the Step 0 inventory.`,
        ``,
        `Present this pre-deletion inventory to the operator and require explicit confirmation`,
        `before proceeding. Do not continue until the operator confirms:`,
        ``,
        `  WILL BE PERMANENTLY DELETED:`,
        `    • Device group : "${pocName}" (ID: <POC_GROUP_ID>)`,
        `    • Project      : "${pocName}" (ID: <POC_PROJECT_ID>)`,
        `    • <count> user accounts (POC-only, no other projects): <list names>`,
        ``,
        `  WILL HAVE POC ACCESS REVOKED (account preserved):`,
        `    • <count> user accounts with other project memberships: <list names + their other projects>`,
        ``,
        `  WILL BE MODIFIED (reversible):`,
        `    • <count> devices — POC tag removed, moved back to Default group`,
        ``,
        `  NOT AFFECTED:`,
        `    • Users in the POC project without the "${pocTag}" tag (added after POC creation)`,
        ``,
        `Only proceed past Step 0 when the operator gives explicit confirmation.`,
        ``,
        `─── STEP 1 — Remove the POC tag from each device ────────────────────────`,
        `For each device in POC_DEVICE_IDS, call: remove_device_tag`,
        `  deviceId: <device ID>`,
        `  tag: "${pocTag}"`,
        `Only remove the "${pocTag}" tag — leave all other tags untouched.`,
        `If a call fails, record it and continue — do not abort.`,
        ``,
        `─── STEP 2 — Move devices from POC group to Default group ───────────────`,
        `Call: remove_devices_from_group`,
        `  groupId: POC_GROUP_ID`,
        `  deviceIds: POC_DEVICE_IDS`,
        `  confirmDeletion: true`,
        ``,
        `Call: add_devices_to_group`,
        `  groupId: DEFAULT_GROUP_ID`,
        `  deviceIds: POC_DEVICE_IDS`,
        ``,
        `─── STEP 3 — Process POC user accounts ─────────────────────────────────`,
        `POC_USERS were classified in Step 0d into DELETE_USERS and REVOKE_USERS.`,
        `The operator confirmed the full inventory in Step 0 — do NOT ask for per-user`,
        `confirmation here. Process all users in sequence without pausing.`,
        ``,
        `For each user in DELETE_USERS (POC-only, no other projects):`,
        `  Call: delete_user`,
        `    userId: <user ID>`,
        `    confirmDeletion: true`,
        `  The Step 0 inventory confirmation covers this batch.`,
        `  If a call fails, record it and continue — do not abort.`,
        ``,
        `For each user in REVOKE_USERS (has other project memberships):`,
        `  Call: remove_user_from_project`,
        `    projectId: POC_PROJECT_ID`,
        `    userId: <user ID>`,
        `    confirmDeletion: true`,
        `  This removes their access to the POC project only — their account and`,
        `  memberships in all other projects are fully preserved.`,
        `  If a call fails, record it and continue — do not abort.`,
        ``,
        `Do not touch OTHER_USERS — they were added to the project after the POC was created.`,
        ``,
        `─── STEP 4 — Delete the POC device group ────────────────────────────────`,
        `PRECONDITION: only proceed if the Step 2 add_devices_to_group call succeeded.`,
        `If it failed or you are unsure, call get_devices_in_group on DEFAULT_GROUP_ID and`,
        `verify every device in POC_DEVICE_IDS is present — deleting the group while`,
        `devices never made it back to Default orphans them with no group membership.`,
        ``,
        `Call: delete_device_group`,
        `  groupId: POC_GROUP_ID`,
        `  confirmDeletion: true`,
        ``,
        `─── STEP 5 — Delete the POC project ─────────────────────────────────────`,
        `Call: delete_project`,
        `  projectId: POC_PROJECT_ID`,
        `  deleteUsers: false`,
        `  confirmDeletion: true`,
        `deleteUsers:false — POC user accounts were already permanently deleted in Step 3.`,
        ``,
        `═══════════════════════════════════════════════`,
        `COMPLETION SUMMARY`,
        `═══════════════════════════════════════════════`,
        `  ✅ POC tag removed  : "${pocTag}" removed from <count> devices`,
        `  ✅ Devices moved    : <count> moved to Default group`,
        `  ✅ Users deleted         : <count> permanently deleted (POC-only accounts, list names)`,
        `  ✅ Users POC access revoked: <count> removed from POC project only (multi-project, list names)`,
        `  ✅ Device group     : "${pocName}" permanently deleted`,
        `  ✅ Project          : "${pocName}" permanently deleted`,
        `  ⚠️  Any warnings or individual step failures`,
      ].join('\n');

      return { content: [{ type: 'text', text: instructions }] };
    }
  );

  // ─── setup_project ─────────────────────────────────────────────────────────

  server.tool(
    'setup_project',
    'Guided workflow to set up a project environment. Starts by asking whether the user wants a simple project record or a fully provisioned environment (device group, device allocation, user provisioning, app assignment). The full path mirrors the POC workflow but is generalized for any project type, with an optional memo in place of a Salesforce URL and a choice of whether to isolate devices exclusively for this project.',
    {
      projectName: z
        .string()
        .describe('Name of the project to create.'),
      region: z
        .string()
        .optional()
        .describe('Region code for device selection, e.g. "US2", "SG1". Required for the full setup path.'),
      deviceCount: z
        .number().int().min(1).max(50)
        .optional()
        .describe('Total number of phones to allocate (full path only, default: 6).'),
      iosCount: z.number().int().min(0).optional().describe('Number of iOS phones (default: ceil(deviceCount/2)).'),
      androidCount: z.number().int().min(0).optional().describe('Number of Android phones (default: floor(deviceCount/2)).'),
      automationType: z
        .enum(['appium-server', 'appium-grid'])
        .optional()
        .describe('"appium-server" (default) or "appium-grid".'),
      projectMemo: z
        .string()
        .optional()
        .describe('Optional free-text memo recorded in the project notes (replaces the Salesforce URL used in POC workflows).'),
      isolateDevices: z
        .boolean()
        .optional()
        .describe('If true, allocated devices will be removed from ALL other device groups (not just Default) to ensure exclusive availability. Default: false — only removes from the Default group, same as the POC workflow.'),
      users: z
        .array(z.object({
          email: z.string(),
          firstName: z.string(),
          lastName: z.string(),
          role: z.enum(['User', 'ProjectAdmin']),
        }))
        .optional()
        .describe('Users to create or add (full path only). Each user is tagged and assigned exclusively to this project.'),
      appName: z.string().optional().describe('Display name of the app to assign (full path only, default: "ExperiBank").'),
      androidPackageName: z.string().optional().describe('Android package name for app lookup (default: "com.experitest.ExperiBank").'),
      iosBundleId: z.string().optional().describe('iOS bundle ID for app lookup (default: "com.experitest.ExperiBank").'),
    },
    ({ projectName, region, deviceCount, iosCount, androidCount, automationType, projectMemo, isolateDevices, users, appName, androidPackageName, iosBundleId }) => {
      const guard = preflightCheck('setup_project');
      if (guard) return guard;

      const projTag = projectName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const appiumOSS = (automationType ?? 'appium-server') !== 'appium-grid';
      const total = deviceCount ?? 6;
      const ios = iosCount ?? Math.ceil(total / 2);
      const android = androidCount ?? Math.floor(total / 2);
      const targetAppName = appName ?? 'ExperiBank';
      const targetAndroidPkg = androidPackageName ?? 'com.experitest.ExperiBank';
      const targetIosBundleId = iosBundleId ?? 'com.experitest.ExperiBank';
      const isFullSetup = !!(region || deviceCount || users?.length);

      const instructions = [
        `You are executing a guided project setup workflow.`,
        ``,
        `═══════════════════════════════════════════════`,
        `CONFIRMED PARAMETERS`,
        `═══════════════════════════════════════════════`,
        `Project Name : ${projectName}`,
        `Project Tag  : ${projTag}  (used to identify devices and users belonging to this project)`,
        `Memo         : ${projectMemo ?? '(none)'}`,
        ``,
        `─── STEP 0 — Confirm setup scope ────────────────────────────────────────`,
        isFullSetup
          ? [
              `Full setup parameters were provided. Confirm the following with the operator before proceeding:`,
              ``,
              `  Project Name    : ${projectName}`,
              `  Project Tag     : ${projTag}`,
              `  Region          : ${region ?? '(not specified — device selection will not filter by region)'}`,
              `  Device Mix      : ${total} phones (${ios} iOS + ${android} Android)`,
              `  Automation Type : ${appiumOSS ? 'Appium Server (appiumOSS: true)' : 'Appium Grid (appiumOSS: false)'}`,
              `  Device Isolation: ${isolateDevices ? 'YES — devices removed from ALL other groups' : 'NO — only removed from Default group'}`,
              `  Memo            : ${projectMemo ?? '(none)'}`,
              `  Users           : ${users?.length ?? 0}`,
              ...(users ?? []).map((u, i) => `    User ${i + 1}: ${u.firstName} ${u.lastName} <${u.email}> — ${u.role}`),
              ``,
              `If the operator wants to change anything, stop and collect corrections.`,
              `Only proceed when the operator confirms.`,
            ].join('\n')
          : [
              `No device or user parameters were provided. Ask the operator:`,
              ``,
              `  "Would you like to:`,
              `   A) Create a simple project record only (no device group, no users, no app assignment)`,
              `   B) Fully provision the project environment (device group, devices, users, app assignment)"`,
              ``,
              `  If A: proceed only to Step 1 (create project + memo), then stop.`,
              `  If B: ask the operator to provide:`,
              `    • Region code (e.g. "US2", "SG1")`,
              `    • Device count and iOS/Android split`,
              `    • Device isolation preference (remove from Default only, or from ALL other groups)`,
              `    • User list (email, firstName, lastName, role)`,
              `    • App name / package name (or use ExperiBank default)`,
              `  Then re-invoke setup_project with the collected parameters.`,
            ].join('\n'),
        ``,
        `─── STEP 1 — Create or reuse the project ────────────────────────────────`,
        `Call: list_projects`,
        `  outputFormat: "json"`,
        `If a project named exactly "${projectName}" already exists, note its ID as PROJECT_ID and skip creation.`,
        ``,
        `Otherwise call: create_project`,
        `  name: "${projectName}"`,
        `  appiumOSS: ${appiumOSS}`,
        `SAVE the returned project ID as PROJECT_ID.`,
        ``,
        `In both cases call: set_project_notes`,
        `  projectId: PROJECT_ID`,
        `  notes: "${projectMemo ?? ''}"`,
        ``,
        `If the operator chose simple setup (Step 0 option A), stop here and report:`,
        `  ✅ Project "${projectName}" created (ID: PROJECT_ID)${projectMemo ? ` — memo recorded` : ''}.`,
        `  No device group, devices, or users were provisioned.`,
        ``,
        `Otherwise continue with Steps 2–9 for full provisioning.`,
        ``,
        `─── STEP 2 — Create or reuse a device group and link it to the project ──`,
        `Call: list_device_groups  outputFormat: "json"`,
        `If a group named exactly "${projectName}" exists, note its ID as PROJECT_GROUP_ID.`,
        `Otherwise call: create_device_group  name: "${projectName}"  acceptNewDevices: false`,
        `SAVE the ID as PROJECT_GROUP_ID.`,
        ``,
        `Then link the group to the project — REQUIRED. Without this, devices added to`,
        `the group are not accessible to the project:`,
        `Call: assign_group_to_project  projectId: PROJECT_ID  deviceGroupId: PROJECT_GROUP_ID`,
        ``,
        `Also find the group named "Default" and note its ID as DEFAULT_GROUP_ID.`,
        ``,
        `─── STEP 3 — App pre-flight check ───────────────────────────────────────`,
        android > 0 ? `Android: call list_applications  packageName: "${targetAndroidPkg}"  — note ANDROID_APP_ID if found.` : '',
        ios > 0     ? `iOS:     call list_applications  bundleIdentifier: "${targetIosBundleId}"  — note IOS_APP_ID if found.` : '',
        ``,
        `─── STEP 4 — Select devices ─────────────────────────────────────────────`,
        `Call: get_devices_in_group`,
        `  groupId: DEFAULT_GROUP_ID`,
        `  category: "PHONE"`,
        `  status: "Available"`,
        `  excludeTags: ["DoNotTake", "DONTTAKE", "DONOTUSE"]`,
        `  outputFormat: "json"`,
        ``,
        region ? `Apply additional client-side filter: region contains "${region}" (case-insensitive).` : `No region filter specified — select from all available phones.`,
        `Also exclude devices whose tags contain "${projTag}" (already in this project) or "poc" (in an active POC).`,
        ``,
        `Target mix: ${total} phones (${ios} iOS + ${android} Android). Prefer recent models.`,
        `Present proposed selection as a table and wait for operator confirmation.`,
        `Save confirmed IDs as SELECTED_DEVICE_IDS.`,
        ``,
        `─── STEP 5 — Add devices to the project group ───────────────────────────`,
        `Call: add_devices_to_group  groupId: PROJECT_GROUP_ID  deviceIds: SELECTED_DEVICE_IDS`,
        ``,
        `─── STEP 6 — Tag devices ────────────────────────────────────────────────`,
        `For each device in SELECTED_DEVICE_IDS that does not already have the tag "${projTag}":`,
        `  Call: add_device_tag  deviceId: <id>  tag: "${projTag}"`,
        ``,
        `─── STEP 7 — Remove devices from other groups ───────────────────────────`,
        isolateDevices
          ? [
              `Device isolation is ENABLED — remove devices from ALL other groups.`,
              `For each device in SELECTED_DEVICE_IDS:`,
              `  Call: get_device_detail  deviceId: <id>  outputFormat: "json"`,
              `  This returns a deviceGroups object (groupId → groupName).`,
              `  For each group ID in deviceGroups OTHER THAN PROJECT_GROUP_ID:`,
              `    Call: remove_devices_from_group  groupId: <other group ID>  deviceIds: [<device id>]  confirmDeletion: true`,
              `This ensures the device is exclusively available in the "${projectName}" group.`,
            ].join('\n')
          : `Device isolation is DISABLED — existing group memberships (including Default) are left untouched.`,
        ``,
        `─── STEP 8 — Create and assign users ────────────────────────────────────`,
        `For each user, execute sub-steps a → b → c → d in order:`,
        ``,
        ...(users ?? []).map((u, i) => `  User ${i + 1}: ${u.firstName} ${u.lastName} <${u.email}> — ${u.role}`),
        users?.length ? `` : `  (No users specified — skip this step.)`,
        ``,
        `  a. Call: create_user  username: <email>  firstName/lastName/email: as above`,
        `           role: <role>  authenticationType: "BASIC"  → SAVE as USER_ID`,
        `  b. Call: assign_user_to_project  projectId: PROJECT_ID  userId: USER_ID  role: <role>`,
        `  c. Call: remove_user_from_project  projectId: DEFAULT_PROJECT_ID  userId: USER_ID  confirmDeletion: true`,
        `     (Call list_projects first if DEFAULT_PROJECT_ID is not yet known.)`,
        `  d. Call: set_user_tags  userId: USER_ID  tags: ["${projTag}"]`,
        `     ⚠️ Required — without this tag, close_project_resources and teardown_project`,
        `     cannot auto-identify this user for cleanup.`,
        ``,
        `─── STEP 9 — Assign app to project ──────────────────────────────────────`,
        android > 0 ? `If ANDROID_APP_ID known: call assign_app_to_project  projectId: PROJECT_ID  applicationId: ANDROID_APP_ID` : '',
        ios > 0     ? `If IOS_APP_ID known:     call assign_app_to_project  projectId: PROJECT_ID  applicationId: IOS_APP_ID` : '',
        ``,
        `IF ANY STEP FAILS: stop, report which steps completed with all created resource IDs`,
        `(PROJECT_ID, PROJECT_GROUP_ID, SELECTED_DEVICE_IDS, user IDs). Re-invoking`,
        `setup_project with the same parameters resumes safely — Steps 1 and 2 reuse the`,
        `existing project/group. To unwind instead, run teardown_project.`,
        ``,
        `═══════════════════════════════════════════════`,
        `COMPLETION SUMMARY`,
        `═══════════════════════════════════════════════`,
        `  ✅ Project         : "${projectName}" (ID: PROJECT_ID)`,
        `  ✅ Memo            : ${projectMemo ? 'recorded' : '(none)'}`,
        `  ✅ Device Group    : PROJECT_GROUP_ID`,
        `  ✅ Devices         : <count> allocated — isolation: ${isolateDevices ? 'full (removed from all other groups)' : 'none (existing group links preserved)'}`,
        `  ✅ Tag applied     : "${projTag}"`,
        `  ✅ Users           : <count> — list names and tag status`,
        `  ✅ App             : ${targetAppName} assigned (or ⚠️ not found)`,
        `  ⚠️  Any warnings or failures`,
      ].filter(s => s != null).join('\n');

      return { content: [{ type: 'text', text: instructions }] };
    }
  );

  // ─── close_project_resources ───────────────────────────────────────────────

  server.tool(
    'close_project_resources',
    'Guided workflow to wind down a project environment: removes the project tag from devices, returns devices to the Default group, and removes user access (deleting accounts with no other project memberships; revoking only POC access for multi-project users). Does not delete the project or device group — use teardown_project for full removal.',
    {
      projectName: z
        .string()
        .describe('Exact project name as used when the project was created.'),
    },
    ({ projectName }) => {
      const guard = preflightCheck('close_project_resources');
      if (guard) return guard;

      const projTag = projectName.toLowerCase().replace(/[^a-z0-9]/g, '');

      const instructions = [
        `You are executing a guided project close-down workflow.`,
        `This returns devices to the Default group and removes user access.`,
        `The project and device group are preserved — run teardown_project to delete them.`,
        ``,
        `═══════════════════════════════════════════════`,
        `CONFIRMED PARAMETERS`,
        `═══════════════════════════════════════════════`,
        `Project Name : ${projectName}`,
        `Project Tag  : ${projTag}`,
        ``,
        `─── STEP 0 — Operator confirmation ──────────────────────────────────────`,
        `Present parameters and wait for explicit confirmation before proceeding.`,
        ``,
        `─── STEP 1 — Locate project, device group, and Default group ────────────`,
        `Call: list_projects  outputFormat: "json"`,
        `Find "${projectName}" → PROJECT_ID. If not found, stop: "Project not found."`,
        ``,
        `Call: list_device_groups  outputFormat: "json"`,
        `Find "${projectName}" → PROJECT_GROUP_ID (may not exist — Steps 2–4 skipped if absent).`,
        `Find "Default" → DEFAULT_GROUP_ID.`,
        ``,
        `─── STEP 2 — Get devices in the project group ───────────────────────────`,
        `If PROJECT_GROUP_ID was found:`,
        `  Call: get_devices_in_group  groupId: PROJECT_GROUP_ID  outputFormat: "json"`,
        `  Save all device IDs as PROJECT_DEVICE_IDS.`,
        `  Show the device list to the operator before continuing.`,
        ``,
        `─── STEP 3 — Remove the project tag from each device ────────────────────`,
        `For each device in PROJECT_DEVICE_IDS:`,
        `  Call: remove_device_tag  deviceId: <id>  tag: "${projTag}"`,
        `Only remove "${projTag}" — all other tags are left untouched.`,
        ``,
        `─── STEP 4 — Move devices back to Default group ─────────────────────────`,
        `Call: remove_devices_from_group  groupId: PROJECT_GROUP_ID  deviceIds: PROJECT_DEVICE_IDS  confirmDeletion: true`,
        `Call: add_devices_to_group  groupId: DEFAULT_GROUP_ID  deviceIds: PROJECT_DEVICE_IDS`,
        ``,
        `─── STEP 5 — Identify and process project user accounts ─────────────────`,
        `Call: list_users  tag: "${projTag}"  outputFormat: "json"`,
        ``,
        `For each returned user, inspect their "roles" field. The shape is`,
        `{"<roleName>": ["<projectName>", ...]} — e.g.`,
        `  "roles": { "ProjectAdmin": ["${projectName}"], "User": ["QA Team"] } → ["${projectName}", "QA Team"]`,
        `Flatten all project names across all role keys and remove "${projectName}" from the list.`,
        `If a user's roles field is missing or not in this shape, STOP and show the raw record`,
        `to the operator — do not guess a classification that leads to account deletion.`,
        `  • Remaining list EMPTY → user belongs only to this project → ELIGIBLE FOR DELETION`,
        `  • Remaining list NON-EMPTY → user belongs to other projects → REMOVE FROM PROJECT ONLY`,
        ``,
        `Present the list with recommended action:`,
        `  Name | Email | Other Projects | Action`,
        ``,
        `For EACH user, ask the operator to confirm the recommended action (yes / skip).`,
        ``,
        `  If project-only AND confirmed: call delete_user  userId: <id>  confirmDeletion: true`,
        `  If multi-project AND confirmed: call remove_user_from_project  projectId: PROJECT_ID  userId: <id>  confirmDeletion: true`,
        `  If skipped: record and move on.`,
        ``,
        `═══════════════════════════════════════════════`,
        `COMPLETION SUMMARY`,
        `═══════════════════════════════════════════════`,
        `  ✅ Project tag removed : "${projTag}" removed from <count> devices`,
        `  ✅ Devices moved       : <count> returned to Default group`,
        `  ✅ Users deleted             : <count> (project-only accounts)`,
        `  ✅ Users removed from project: <count> (multi-project — accounts preserved)`,
        `  ✅ Users skipped             : <count>`,
        `  ⚠️  Project and device group "${projectName}" still exist — run teardown_project to remove them.`,
        `  ⚠️  Any failures`,
      ].join('\n');

      return { content: [{ type: 'text', text: instructions }] };
    }
  );

  // ─── teardown_project ──────────────────────────────────────────────────────

  server.tool(
    'teardown_project',
    'Guided workflow for full project removal: untags devices, returns them to Default, handles user accounts (deleting project-only users, revoking access for multi-project users), then permanently deletes the device group and project. Requires confirmDeletion: true. Presents a full pre-deletion inventory before any destructive action.',
    {
      projectName: z
        .string()
        .describe('Exact project name as used when the project was created.'),
      confirmDeletion: z
        .boolean()
        .describe('Must be true to proceed. Without this, a safety summary is shown and no changes are made.'),
    },
    ({ projectName, confirmDeletion }) => {
      const guard = preflightCheck('teardown_project');
      if (guard) return guard;

      const projTag = projectName.toLowerCase().replace(/[^a-z0-9]/g, '');

      if (confirmDeletion !== true) {
        return {
          content: [{
            type: 'text',
            text: [
              `⚠️  Safety guard triggered.`,
              ``,
              `"Tear down project \\"${projectName}\\"" permanently deletes the device group and project.`,
              ``,
              `To proceed, call teardown_project again with confirmDeletion: true.`,
              ``,
              `💡 Consider running close_project_resources first — it safely revokes access and`,
              `   returns devices without permanently deleting the project or group.`,
              ``,
              `No changes were made.`,
            ].join('\n'),
          }],
        };
      }

      const instructions = [
        `You are executing a guided project teardown workflow.`,
        `This permanently deletes the project and device group. It cannot be undone.`,
        ``,
        `═══════════════════════════════════════════════`,
        `CONFIRMED PARAMETERS`,
        `═══════════════════════════════════════════════`,
        `Project Name : ${projectName}`,
        `Project Tag  : ${projTag}`,
        ``,
        `─── STEP 0 — Gather inventory and confirm with operator ──────────────────`,
        `  a. Call: list_projects  outputFormat: "json"`,
        `     Find "${projectName}" → PROJECT_ID. If not found, stop: "Project not found."`,
        ``,
        `  b. Call: list_device_groups  outputFormat: "json"`,
        `     Find "${projectName}" → PROJECT_GROUP_ID.`,
        `     Find "Default" → DEFAULT_GROUP_ID.`,
        ``,
        `  c. Call: get_devices_in_group  groupId: PROJECT_GROUP_ID  outputFormat: "json"`,
        `     Record as PROJECT_DEVICE_IDS.`,
        ``,
        `  d. Call: list_users  tag: "${projTag}"  outputFormat: "json"`,
        `     For each user, inspect their "roles" field — shape {"<roleName>": ["<projectName>", ...]},`,
        `     e.g. "roles": { "User": ["${projectName}", "QA Team"] }. Flatten all project names,`,
        `     remove "${projectName}" from the list.`,
        `       • Remaining EMPTY → classify as DELETE_USERS`,
        `       • Remaining NON-EMPTY → classify as REVOKE_USERS`,
        `     If a roles field is missing or malformed, classify as REVOKE_USERS (the safe`,
        `     action) and flag the raw record in the Step 0 inventory.`,
        ``,
        `Present the pre-deletion inventory and require explicit operator confirmation:`,
        ``,
        `  WILL BE PERMANENTLY DELETED:`,
        `    • Device group  : "${projectName}" (ID: PROJECT_GROUP_ID)`,
        `    • Project       : "${projectName}" (ID: PROJECT_ID)`,
        `    • <count> user accounts (project-only): <names>`,
        ``,
        `  WILL HAVE PROJECT ACCESS REVOKED (account preserved):`,
        `    • <count> users with other project memberships: <names + their other projects>`,
        ``,
        `  WILL BE MODIFIED (reversible):`,
        `    • <count> devices — tag removed, returned to Default group`,
        ``,
        `  NOT AFFECTED:`,
        `    • Users in the project without the "${projTag}" tag`,
        ``,
        `Only proceed past Step 0 when the operator explicitly confirms.`,
        ``,
        `─── STEP 1 — Remove project tag from each device ────────────────────────`,
        `For each device in PROJECT_DEVICE_IDS:`,
        `  Call: remove_device_tag  deviceId: <id>  tag: "${projTag}"`,
        ``,
        `─── STEP 2 — Move devices to Default group ──────────────────────────────`,
        `Call: remove_devices_from_group  groupId: PROJECT_GROUP_ID  deviceIds: PROJECT_DEVICE_IDS  confirmDeletion: true`,
        `Call: add_devices_to_group  groupId: DEFAULT_GROUP_ID  deviceIds: PROJECT_DEVICE_IDS`,
        ``,
        `─── STEP 3 — Process user accounts ──────────────────────────────────────`,
        `The Step 0 confirmation covers this batch — no per-user pause.`,
        ``,
        `For each user in DELETE_USERS:`,
        `  Call: delete_user  userId: <id>  confirmDeletion: true`,
        ``,
        `For each user in REVOKE_USERS:`,
        `  Call: remove_user_from_project  projectId: PROJECT_ID  userId: <id>  confirmDeletion: true`,
        `  Account and all other project memberships are fully preserved.`,
        ``,
        `─── STEP 4 — Delete the device group ────────────────────────────────────`,
        `PRECONDITION: only proceed if the Step 2 add_devices_to_group call succeeded.`,
        `If it failed or you are unsure, verify with get_devices_in_group on DEFAULT_GROUP_ID`,
        `that every device in PROJECT_DEVICE_IDS is present — deleting the group while devices`,
        `never made it back to Default orphans them with no group membership.`,
        ``,
        `Call: delete_device_group  groupId: PROJECT_GROUP_ID  confirmDeletion: true`,
        ``,
        `─── STEP 5 — Delete the project ─────────────────────────────────────────`,
        `Call: delete_project  projectId: PROJECT_ID  deleteUsers: false  confirmDeletion: true`,
        `deleteUsers:false — accounts were already handled in Step 3.`,
        ``,
        `═══════════════════════════════════════════════`,
        `COMPLETION SUMMARY`,
        `═══════════════════════════════════════════════`,
        `  ✅ Project tag removed        : "${projTag}" removed from <count> devices`,
        `  ✅ Devices returned to Default: <count>`,
        `  ✅ Users deleted              : <count> (project-only accounts)`,
        `  ✅ Users — access revoked     : <count> (multi-project — accounts preserved)`,
        `  ✅ Device group deleted       : "${projectName}"`,
        `  ✅ Project deleted            : "${projectName}"`,
        `  ⚠️  Any warnings or failures`,
      ].join('\n');

      return { content: [{ type: 'text', text: instructions }] };
    }
  );
}
