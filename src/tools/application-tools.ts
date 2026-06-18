import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getApplications,
  getApplicationInfo,
  uploadApplication,
  uploadApplicationFromUrl,
  deleteApplication,
  updateApplicationPlugins,
  installApplication,
  uninstallApplication,
  uninstallApplicationByPackage,
  uninstallApplicationByPackageFromDevices,
  extractLanguageFiles,
} from '../api/applications.js';
import { getDevicesInDeviceGroup } from '../api/device-groups.js';
import { getMyAccountInfo } from '../api/users.js';
import { listActiveSessions } from '../api/webdriver.js';
import { resolveDevice } from '../utils/device-resolver.js';
import { checkDestructiveGuard } from '../utils/destructive-guard.js';
import { validateOutputPath, validateInputPath } from '../utils/path-guard.js';
import { applyMaxResults, appendTruncationNotice } from '../utils/pagination.js';
import { formatApplicationList } from '../utils/response-formatter.js';
import { outputFormatParam, respond } from '../utils/output-format.js';
import { getActiveAccessKey, getActiveUrl, getActiveKeyType } from '../api/client.js';

// v43 Fix C — structured (not prose) test-creation guidance, attached to the entry-point
// tools an agent calls first when building a test. The doc's argument: agents treat a
// structured response field as fact to act on, but treat description prose as background
// context. `liveInspectionSession` is the one selector source the MCP can actually verify.
function testCreationGuidance() {
  return {
    decideModeFirst:
      'If you are creating a test: INTERACTIVE (start_inspection_session) when intent is vague, you lack the app source, ' +
      'or you have no captured element IDs; AUTONOMOUS (get_test_boilerplate) only with specific intent AND a real selector source.',
    liveInspectionSession: listActiveSessions().length > 0,
    prohibited:
      'Authoring a test from guessed/placeholder element IDs or fabricated credentials and presenting it as finished — ' +
      'including by writing the file yourself instead of using get_test_boilerplate.',
    beforeDelivering: 'Run validate_test_script on any test you produce; do not present a script it flags.',
  };
}

export function registerApplicationTools(server: McpServer): void {
  server.tool(
    'list_applications',
    'Lists and searches the app repository. Use nameContains to find apps by name (e.g. "ExperiBank", "demo") without needing a bundle ID or package name. ' +
    'Returns app IDs needed by install_application, assign_app_to_project, and get_application_info. ' +
    'TEST-CREATION NOTE: if this lookup is the first step of creating a test, decide the MODE before going further — ' +
    'autonomous (get_test_boilerplate: specific intent + selectors from source or a session) vs interactive ' +
    '(start_inspection_session: vague intent, "let\'s decide as we go", no source access). If unsure, ask the user which they want. ' +
    'Each result lists its project assignments — when several uploads share a name, PREFER the one assigned to your active project ' +
    '(install and inspection sessions run in the active project context and fail for apps assigned only elsewhere). ' +
    'Also filterable by platform (ios/android), package name, bundle identifier, file type (apk/ipa/aab), and simulator flag. ' +
    'Covers the full app catalog — browse uploaded applications, find a specific version, or search for a demo app.',
    {
      nameContains: z
        .string()
        .optional()
        .describe(
          'Filter by app name — partial, case-insensitive match on applicationName. ' +
          'E.g. "ExperiBank" returns all apps with "ExperiBank" in their name, without needing the bundle ID or package name. ' +
          'Combine with osType to narrow to a specific platform.'
        ),
      osType: z.enum(['ios', 'android']).optional().describe("Filter by platform: 'ios' or 'android'."),
      packageName: z.string().optional().describe('Filter by Android package name (exact server-side filter).'),
      bundleIdentifier: z.string().optional().describe('Filter by iOS bundle identifier (exact server-side filter).'),
      uniqueName: z.string().optional().describe('Filter by unique name alias.'),
      fileType: z
        .enum(['apk', 'ipa', 'aab', 'zip'])
        .optional()
        .describe("Filter by file type: 'apk', 'ipa', 'aab', or 'zip'."),
      isForSimulator: z.boolean().optional().describe('Filter simulator/emulator builds only.'),
      sortBy: z
        .enum(['applicationName', 'releaseVersion', 'buildVersion', 'createdAt', 'osType', 'fileType'])
        .optional()
        .describe('Sort results by this field (client-side). Default: newest first.'),
      sortOrder: z
        .enum(['asc', 'desc'])
        .optional()
        .default('desc')
        .describe("Sort direction: 'asc' or 'desc'. Default: 'desc' (newest first)."),
      maxResults: z
        .number()
        .optional()
        .default(50)
        .describe('Maximum number of results to return (default: 50, max: 500).'),
      outputFormat: outputFormatParam,
    },
    async ({ nameContains, osType, packageName, bundleIdentifier, uniqueName, fileType, isForSimulator, sortBy, sortOrder, maxResults, outputFormat }) => {
      try {
        let apps = await getApplications({
          osType,
          packageName,
          bundleIdentifier,
          uniqueName,
          fileType,
          isForSimulator,
        });
        if (nameContains) {
          const q = nameContains.toLowerCase();
          apps = apps.filter(a => a.applicationName.toLowerCase().includes(q));
        }
        if (sortBy) {
          apps = [...apps].sort((a, b) => {
            if (sortBy === 'createdAt') {
              const av = a.createdAt ?? 0;
              const bv = b.createdAt ?? 0;
              return sortOrder === 'desc' ? bv - av : av - bv;
            }
            const av = String(a[sortBy as keyof typeof a] ?? '').toLowerCase();
            const bv = String(b[sortBy as keyof typeof b] ?? '').toLowerCase();
            return sortOrder === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv);
          });
        } else {
          apps = [...apps].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        }
        const paged = applyMaxResults(apps, maxResults);
        const structured = {
          applications: paged.items.map(a => ({
            id: a.id,
            name: a.applicationName,
            osType: a.osType,
            version: a.releaseVersion,
            uploadedAt: a.createdAtFormatted || new Date(a.createdAt).toISOString().slice(0, 10),
            // Install/inspection run in the ACTIVE project context — pick a copy
            // assigned to it when several uploads share a name (v36).
            projects: (a.projectsInfo ?? []).map(p => p.name),
          })),
          _testCreationGuidance: testCreationGuidance(),
        };
        const humanText = appendTruncationNotice(
          `Found ${paged.total} application(s):\n\n${formatApplicationList(paged.items)}`,
          paged
        );
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_application_info',
    'Gets full details for a specific app by its numeric ID, including signing configuration, plugins, project assignments, ' +
    'and the launch activity (mainActivity, Android) needed for start_inspection_session and launch_app.',
    {
      applicationId: z.number().describe('The numeric application ID. Use list_applications to find it.'),
      outputFormat: outputFormatParam,
    },
    async ({ applicationId, outputFormat }) => {
      try {
        const app = await getApplicationInfo(applicationId);
        const humanText = [
          `📦 ${app.applicationName} (ID: ${app.id})`,
          `Platform: ${app.osType}`,
          `Version: ${app.releaseVersion} (build ${app.buildVersion})`,
          `File Type: ${app.fileType.toUpperCase()}`,
          `Package: ${app.packageName ?? app.bundleIdentifier ?? 'N/A'}`,
          app.mainActivity ? `Main Activity: ${app.mainActivity}` : '',
          `Unique Name: ${app.uniqueName ?? 'none'}`,
          `Camera Support: ${app.cameraSupport}`,
          `Network Capture: ${app.networkCaptureSupport}`,
          `For Simulator: ${app.isForSimulator}`,
          `Can Delete: ${app.canDelete}`,
          `Uploaded: ${app.createdAtFormatted}`,
          app.plugins && app.plugins.length > 0
            ? `Plugins: ${app.plugins.map((p) => `${p.name} (${p.uuid})`).join(', ')}`
            : '',
          app.projectsInfo && app.projectsInfo.length > 0
            ? `Projects: ${app.projectsInfo.map((p) => `${p.name} (${p.id})`).join(', ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n');
        return respond(outputFormat, { ...app, _testCreationGuidance: testCreationGuidance() }, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'upload_application_file',
    'Uploads an app binary (APK, IPA, AAB) from a local file path visible to the MCP server process. IMPORTANT: the MCP server runs in Docker — host machine paths (e.g. C:\\AppSec\\app.apk) are NOT accessible unless the directory is volume-mounted into the container. Mount the directory when starting the container (e.g. -v /host/apk-dir:/uploads) and pass the in-container path (e.g. /uploads/app.apk). If mounting is not possible, use upload_application_from_url instead with a direct artifact URL.',
    {
      filePath: z.string().describe('Absolute path inside the MCP container (not the host path). Volume-mount the directory first. Example: /uploads/MyApp.apk'),
      uniqueName: z.string().optional().describe('A short unique alias for this app (optional).'),
      camera: z.boolean().optional().describe('Enable camera support instrumentation.'),
      touchId: z.boolean().optional().describe('Enable Touch ID support (iOS).'),
      project: z.string().optional().describe('Project name to assign the app to. Cloud Admin only — project-level keys (Project Admin and Project User) upload to their assigned project and this parameter is ignored by the platform.'),
      uuid: z.string().optional().describe('iOS provisioning profile UUID for signing.'),
      fixKeychainAccess: z.boolean().optional().describe('Fix keychain access for iOS.'),
      allowResign: z.boolean().optional().describe('Allow app re-signing for iOS.'),
      signPlugins: z.boolean().optional().describe('Sign app plugins/extensions for iOS.'),
      installMDM: z.boolean().optional().describe('Install via MDM for iOS.'),
      installAttributesMDM: z
        .string()
        .optional()
        .describe('MDM installation attributes as JSON string.'),
      autoTrustEnterpriseDeveloper: z
        .boolean()
        .optional()
        .describe('Auto-trust enterprise developer for iOS.'),
      keystorePassword: z.string().optional().describe('Keystore password for Android custom signing.'),
      keyAlias: z.string().optional().describe('Key alias for Android custom signing.'),
      keyPassword: z.string().optional().describe('Key password for Android custom signing.'),
      networkCaptureSupport: z.boolean().optional().describe('Enable network capture for Android.'),
    },
    async (params) => {
      const { filePath, installAttributesMDM, ...rest } = params;

      // Detect host-machine paths that are unreachable inside the Docker container.
      const isWindowsHostPath = /^[A-Za-z]:[\\\/]/.test(filePath);
      const isHostHomePath = /^\/(Users|home|root)\//.test(filePath);
      if (isWindowsHostPath || isHostHomePath) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            error: 'HOST_PATH_UNREACHABLE',
            message: `The path '${filePath}' looks like a host machine path. The MCP server runs inside Docker and cannot access host filesystem paths unless the directory is volume-mounted into the container. ` +
              `Options: (1) Use upload_application_from_url with a publicly reachable artifact URL. ` +
              `(2) Mount the directory when starting the container: -v /host/apk-dir:/uploads, then pass /uploads/app.apk as the path.`,
          }) }],
          isError: true,
        };
      }

      const inputErr = validateInputPath(filePath);
      if (inputErr) return { content: [{ type: 'text', text: `Error: ${inputErr}` }], isError: true };

      try {
        const uploadParams = {
          ...rest,
          installAttributesMDM: installAttributesMDM
            ? (JSON.parse(installAttributesMDM) as Record<string, unknown>)
            : undefined,
        };
        const result = await uploadApplication(filePath, uploadParams);
        const text = [
          result.created ? '✅ Application uploaded successfully.' : '✅ Application updated (existing version replaced).',
          `App ID: ${result.id}`,
          result.name ? `Name: ${result.name}` : '',
          result.buildVersion ? `Build Version: ${result.buildVersion}` : '',
          result.releaseVersion ? `Release Version: ${result.releaseVersion}` : '',
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
    'upload_application_from_url',
    'Uploads an app by having the Digital.ai platform fetch it from a URL. Ideal for CI/CD artifact servers. IMPORTANT: the URL must be a direct, stable, publicly reachable artifact URL — the platform fetches it server-side. Redirecting URLs (e.g. APKPure links, GitHub "latest" release assets, short URLs) and URLs that require authentication or cookies are likely to fail with a 400 validation error. Use a permanent direct download link from your artifact storage (Nexus, Artifactory, S3, Azure Blobs, etc.). Same signing options as upload_application_file.',
    {
      url: z.string().describe('Direct, stable artifact URL reachable by the Digital.ai platform server. Must not redirect or require authentication.'),
      uniqueName: z.string().optional().describe('A short unique alias for this app.'),
      camera: z.boolean().optional().describe('Enable camera support.'),
      touchId: z.boolean().optional().describe('Enable Touch ID support (iOS).'),
      project: z.string().optional().describe('Project name to assign the app to. Cloud Admin only — project-level keys (Project Admin and Project User) upload to their assigned project and this parameter is ignored by the platform.'),
      uuid: z.string().optional().describe('iOS provisioning profile UUID.'),
      fixKeychainAccess: z.boolean().optional().describe('Fix keychain access (iOS).'),
      allowResign: z.boolean().optional().describe('Allow re-signing (iOS).'),
      signPlugins: z.boolean().optional().describe('Sign plugins (iOS).'),
      installMDM: z.boolean().optional().describe('Install via MDM (iOS).'),
      autoTrustEnterpriseDeveloper: z.boolean().optional().describe('Auto-trust enterprise developer (iOS).'),
      networkCaptureSupport: z.boolean().optional().describe('Network capture support (Android).'),
    },
    async ({ url, ...rest }) => {
      try {
        const result = await uploadApplicationFromUrl(url, rest);
        const text = [
          result.created ? '✅ Application fetched and uploaded.' : '✅ Application updated from URL.',
          `App ID: ${result.id}`,
          result.name ? `Name: ${result.name}` : '',
          result.buildVersion ? `Build: ${result.buildVersion}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('[400]')) {
          return {
            content: [{
              type: 'text',
              text: `Error: URL upload rejected by platform (400 validation error).\n\n` +
                `Common causes:\n` +
                `  • Redirecting URL — the platform fetches server-side and does not follow redirects. Use a permanent direct download link.\n` +
                `  • Authentication required — URLs that need cookies, tokens, or login cannot be fetched by the platform.\n` +
                `  • Unsupported file type — only APK, IPA, AAB, and ZIP are accepted.\n` +
                `  • URL not reachable from the platform server — verify the artifact URL is publicly accessible.\n\n` +
                `Tested URL: ${url}\n\n` +
                `If you cannot provide a direct artifact URL, use upload_application_file with a volume-mounted local path instead.`,
            }],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_application_upload_command',
    'Generates a ready-to-run curl or PowerShell command for uploading an app binary directly from the user\'s local machine to the Digital.ai platform. ' +
    'The MCP server itself does not handle the binary — the user runs the generated command locally so the file never passes through the Docker container. ' +
    'Use this instead of upload_application_file when the binary is on a local machine and volume-mounting is not practical.\n\n' +
    'WARNING: The generated command embeds the active access key in plaintext. ' +
    'Instruct the user to run it immediately and not save or share the output.',
    {
      localFilePath: z.string().describe(
        'Full path to the binary on the user\'s local machine, used verbatim in the generated command. ' +
        'Examples: "C:\\\\Downloads\\\\MyApp.apk" (Windows), "/Users/joe/Downloads/MyApp.ipa" (macOS).'
      ),
      localPlatform: z.enum(['windows', 'macos', 'linux']).describe(
        'Platform of the machine where the command will be run. ' +
        '"windows" produces both a Git Bash curl command and a PowerShell alternative. ' +
        '"macos"/"linux" produce a bash curl command. Cannot be inferred — the MCP runs in Docker.'
      ),
      uniqueName: z.string().optional().describe('Short unique alias to assign to the uploaded app.'),
      project: z.string().optional().describe(
        'Project name to assign the app to. Cloud Admin only — project-level keys (Project Admin and Project User) upload to their assigned project and this parameter is ignored by the platform.'
      ),
      camera: z.boolean().optional().describe('Enable camera support instrumentation.'),
      touchId: z.boolean().optional().describe('Enable Touch ID support (iOS).'),
      uuid: z.string().optional().describe('iOS provisioning profile UUID for signing.'),
      fixKeychainAccess: z.boolean().optional().describe('Fix keychain access for iOS.'),
      allowResign: z.boolean().optional().describe('Allow app re-signing for iOS.'),
      signPlugins: z.boolean().optional().describe('Sign app plugins/extensions for iOS.'),
      installMDM: z.boolean().optional().describe('Install via MDM (iOS).'),
      autoTrustEnterpriseDeveloper: z.boolean().optional().describe('Auto-trust enterprise developer (iOS).'),
      keystorePassword: z.string().optional().describe('Keystore password for Android custom signing. Will appear in plaintext in the generated command.'),
      keyAlias: z.string().optional().describe('Key alias for Android custom signing.'),
      keyPassword: z.string().optional().describe('Key password for Android custom signing. Will appear in plaintext in the generated command.'),
      networkCaptureSupport: z.boolean().optional().describe('Enable network capture for Android.'),
      outputFormat: outputFormatParam,
    },
    async ({
      localFilePath, localPlatform, uniqueName, project, camera, touchId, uuid,
      fixKeychainAccess, allowResign, signPlugins, installMDM, autoTrustEnterpriseDeveloper,
      keystorePassword, keyAlias, keyPassword, networkCaptureSupport, outputFormat,
    }) => {
      const accessKey = getActiveAccessKey();
      const baseUrl = getActiveUrl();
      const isJwt = getActiveKeyType() === 'jwt';
      const isWindows = localPlatform === 'windows';
      const endpoint = `${baseUrl}/api/v1/applications/new`;

      // Collect optional form fields in declaration order (mirrors upload_application_file)
      const fields: [string, string][] = [];
      if (uniqueName) fields.push(['uniqueName', uniqueName]);
      if (camera !== undefined) fields.push(['camera', String(camera)]);
      if (touchId !== undefined) fields.push(['touchId', String(touchId)]);
      if (project) fields.push(['project', project]);
      if (uuid) fields.push(['uuid', uuid]);
      if (fixKeychainAccess !== undefined) fields.push(['fixKeychainAccess', String(fixKeychainAccess)]);
      if (allowResign !== undefined) fields.push(['allowResign', String(allowResign)]);
      if (signPlugins !== undefined) fields.push(['signPlugins', String(signPlugins)]);
      if (installMDM !== undefined) fields.push(['installMDM', String(installMDM)]);
      if (autoTrustEnterpriseDeveloper !== undefined) fields.push(['autoTrustEnterpriseDeveloper', String(autoTrustEnterpriseDeveloper)]);
      if (keystorePassword) fields.push(['keystorePassword', keystorePassword]);
      if (keyAlias) fields.push(['keyAlias', keyAlias]);
      if (keyPassword) fields.push(['keyPassword', keyPassword]);
      if (networkCaptureSupport !== undefined) fields.push(['networkCaptureSupport', String(networkCaptureSupport)]);

      // curl — works on macOS, Linux, Git Bash, and WSL
      const curlFilePath = localFilePath.replace(/\\/g, '/');
      const curlLines: string[] = ['curl -X POST \\'];
      if (isJwt) {
        curlLines.push(`  -H "Authorization: Bearer ${accessKey}" \\`);
      } else {
        curlLines.push(`  -H "X-API-KEY: ${accessKey}" \\`);
        curlLines.push(`  -H "Authorization: Bearer ${accessKey}" \\`);
      }
      curlLines.push(`  -F "file=@${curlFilePath}" \\`);
      for (const [k, v] of fields) curlLines.push(`  -F "${k}=${v}" \\`);
      curlLines.push(`  "${endpoint}"`);
      const curlCommand = curlLines.join('\n');

      // PowerShell (Invoke-RestMethod) — Windows native
      const psLines: string[] = [];
      psLines.push('$headers = @{');
      if (isJwt) {
        psLines.push(`    "Authorization" = "Bearer ${accessKey}"`);
      } else {
        psLines.push(`    "X-API-KEY"     = "${accessKey}"`);
        psLines.push(`    "Authorization" = "Bearer ${accessKey}"`);
      }
      psLines.push('}');
      psLines.push('$form = @{');
      psLines.push(`    "file" = Get-Item "${localFilePath}"`);
      for (const [k, v] of fields) psLines.push(`    "${k}" = "${v}"`);
      psLines.push('}');
      psLines.push(`Invoke-RestMethod -Uri "${endpoint}" \``);
      psLines.push('    -Method POST `');
      psLines.push('    -Headers $headers `');
      psLines.push('    -Form $form');
      const psCommand = psLines.join('\n');

      // Build human-readable output
      const lines: string[] = [];
      lines.push('⚠️  WARNING: The commands below embed your access key in plaintext.');
      lines.push('   Run immediately — do not save, share, or commit this output.');
      lines.push('');

      if (!isJwt && project) {
        lines.push('⚠️  NOTE: The "project" field requires Cloud Admin access. The active key is a project-level key —');
        lines.push('   the platform will ignore "project" and upload to your default project.');
        lines.push('   To target a specific project: switch_environment("<admin-profile>") → re-run → switch back.');
        lines.push('');
      }

      if (isWindows) {
        lines.push('─── Git Bash / WSL / macOS curl ─────────────────────────────────');
        lines.push('');
        lines.push('```bash');
        lines.push(curlCommand);
        lines.push('```');
        lines.push('');
        lines.push('─── PowerShell (Invoke-RestMethod) ──────────────────────────────');
        lines.push('');
        lines.push('```powershell');
        lines.push(psCommand);
        lines.push('```');
      } else {
        lines.push('```bash');
        lines.push(curlCommand);
        lines.push('```');
      }

      return respond(outputFormat, { endpoint, curlCommand, psCommand: isWindows ? psCommand : null }, lines.join('\n'));
    }
  );

  server.tool(
    'delete_application',
    'Permanently removes an app from the repository. Any test scripts using this app may break. Requires confirmDeletion: true.',
    {
      applicationId: z.number().describe('The numeric application ID to delete.'),
      confirmDeletion: z
        .boolean()
        .describe('Must be true to confirm this destructive, irreversible operation. No changes are made without this.'),
    },
    async ({ applicationId, confirmDeletion }) => {
      const guard = checkDestructiveGuard(confirmDeletion, `Delete application ${applicationId}`);
      if (guard) return { content: [{ type: 'text', text: guard }] };
      try {
        await deleteApplication(applicationId);
        return {
          content: [
            { type: 'text', text: `✅ Application ${applicationId} permanently deleted.` },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'update_application_plugins',
    "Updates the signing profiles (provisioning profiles) assigned to iOS app extensions/plugins. Use 'Auto' as the UUID to use the default profile. iOS only.",
    {
      applicationId: z.number().describe('The numeric iOS application ID.'),
      plugins: z
        .array(
          z.object({
            name: z.string().describe('Name of the plugin/extension.'),
            uuid: z.string().describe("Provisioning profile UUID, or 'Auto' for default."),
          })
        )
        .describe("List of plugins with their signing profile UUIDs. Use 'Auto' for the default profile."),
    },
    async ({ applicationId, plugins }) => {
      try {
        const result = await updateApplicationPlugins(applicationId, plugins);
        const lines = result.map((p) => `  • ${p.name}: ${p.uuid}`);
        return {
          content: [
            {
              type: 'text',
              text: `✅ App ${applicationId} plugins updated:\n${lines.join('\n')}`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'install_application',
    'Installs an app on one or more devices. The device(s) must be available and not reserved. ' +
    'IMPORTANT: If you plan to use get_remote_debug_command, install the app FIRST — installation fails ' +
    'while a device is reserved via an rdb tunnel. ' +
    'PREREQUISITE: The app must be assigned to a project that contains the target device. ' +
    'If you get a 400 error, call assign_app_to_project(projectId, applicationId) first, then retry. ' +
    'For Android, use keepData: true to upgrade the app without losing existing app data.',
    {
      applicationId: z.number().describe('The numeric application ID.'),
      deviceId: z.string().optional().describe('Single device to install on — numeric platform ID, serial number/UDID, or unambiguous device name. Serials are resolved to the numeric ID automatically.'),
      devicesList: z
        .string()
        .optional()
        .describe('Comma-separated list of numeric device IDs (e.g. "8,235,54").'),
      allDevices: z
        .boolean()
        .optional()
        .describe('Install on all available matching devices.'),
      instrument: z.boolean().optional().default(false).describe('Instrument the app during install.'),
      keepData: z
        .boolean()
        .optional()
        .default(false)
        .describe('Keep existing app data during install (Android only).'),
    },
    async ({ applicationId, deviceId, devicesList, allDevices, instrument, keepData }) => {
      try {
        if (!deviceId && !devicesList && !allDevices) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: You must specify at least one of: deviceId, devicesList, or allDevices: true.',
              },
            ],
            isError: true,
          };
        }
        // The install endpoint requires the numeric platform ID — resolve serials/UDIDs/names.
        let resolvedDeviceId = deviceId;
        if (deviceId && !/^\d+$/.test(deviceId.trim())) {
          const resolved = await resolveDevice(deviceId);
          resolvedDeviceId = resolved.id;
        }
        const result = await installApplication(applicationId, {
          deviceId: resolvedDeviceId,
          devicesList,
          allDevices,
          instrument,
          keepData,
        });
        const lines = Object.entries(result).map(([device, status]) => `  • Device ${device}: ${status}`);
        return {
          content: [
            {
              type: 'text',
              text: `✅ Install results for app ${applicationId}:\n${lines.join('\n')}`,
            },
          ],
        };
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        let hint = '';
        if (msg.includes("long parameter 'deviceId' is invalid")) {
          hint = ' — deviceId must be the numeric platform ID (e.g. 16751287), not the device serial number. ' +
            'Pass the serial as deviceId and this tool will resolve it, or use list_devices(@serialNumber=\'...\') to look up the ID.';
        } else if (msg.includes('400')) {
          hint = ' — 400 errors on install usually mean the app is not assigned to the target device\'s project ' +
            '(call assign_app_to_project(projectId, applicationId) and retry), or the device is currently reserved ' +
            '(e.g. by an rdb tunnel or an inspection session — release it first).';
        }
        return { content: [{ type: 'text', text: `Error: ${msg}${hint}` }], isError: true };
      }
    }
  );

  server.tool(
    'uninstall_application',
    'Uninstalls an app from one or more devices. App data on the device is lost. Requires confirmDeletion: true.',
    {
      applicationId: z.number().describe('The numeric application ID.'),
      deviceId: z.string().optional().describe('Single device ID.'),
      devicesList: z.string().optional().describe('Comma-separated device IDs.'),
      allDevices: z.boolean().optional().describe('Uninstall from all devices.'),
      confirmDeletion: z
        .boolean()
        .optional()
        .describe('Must be true to confirm this destructive operation. No changes are made without this.'),
    },
    async ({ applicationId, deviceId, devicesList, allDevices, confirmDeletion }) => {
      try {
        if (!deviceId && !devicesList && !allDevices) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: You must specify at least one of: deviceId, devicesList, or allDevices: true.',
              },
            ],
            isError: true,
          };
        }
        const target = allDevices ? 'ALL devices' : devicesList ? `devices ${devicesList}` : `device ${deviceId}`;
        const guard = checkDestructiveGuard(confirmDeletion, `Uninstall application ${applicationId} from ${target}`);
        if (guard) return { content: [{ type: 'text', text: guard }] };
        const result = await uninstallApplication(applicationId, {
          deviceId,
          devicesList,
          allDevices,
        });
        const lines = Object.entries(result).map(([device, status]) => `  • Device ${device}: ${status}`);
        return {
          content: [
            {
              type: 'text',
              text: `✅ Uninstall results for app ${applicationId}:\n${lines.join('\n')}`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'uninstall_application_by_package',
    'Uninstalls an app from a single device using the package name (Android) or bundle ID (iOS), without needing the app\'s numeric ID. App data on the device is lost. Requires confirmDeletion: true.',
    {
      deviceId: z.string().describe('The numeric device ID.'),
      packageName: z
        .string()
        .describe('Android package name (e.g. com.mycompany.app) or iOS bundle identifier.'),
      confirmDeletion: z
        .boolean()
        .optional()
        .describe('Must be true to confirm this destructive operation. No changes are made without this.'),
    },
    async ({ deviceId, packageName, confirmDeletion }) => {
      try {
        const guard = checkDestructiveGuard(confirmDeletion, `Uninstall "${packageName}" from device ${deviceId}`);
        if (guard) return { content: [{ type: 'text', text: guard }] };
        await uninstallApplicationByPackage(deviceId, packageName);
        return {
          content: [
            {
              type: 'text',
              text: `✅ App "${packageName}" uninstalled from device ${deviceId}.`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'uninstall_application_by_package_from_devices',
    'Uninstalls an app from multiple devices at once using the package name or bundle ID. App data on the devices is lost. Requires confirmDeletion: true.',
    {
      devicesList: z
        .string()
        .describe('Comma-separated device IDs, e.g. "8,235,54".'),
      packageName: z
        .string()
        .describe('Android package name or iOS bundle identifier.'),
      confirmDeletion: z
        .boolean()
        .optional()
        .describe('Must be true to confirm this destructive operation. No changes are made without this.'),
    },
    async ({ devicesList, packageName, confirmDeletion }) => {
      try {
        const guard = checkDestructiveGuard(confirmDeletion, `Uninstall "${packageName}" from devices ${devicesList}`);
        if (guard) return { content: [{ type: 'text', text: guard }] };
        await uninstallApplicationByPackageFromDevices(devicesList, packageName);
        return {
          content: [
            {
              type: 'text',
              text: `✅ App "${packageName}" uninstall command sent to devices: ${devicesList}`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'find_latest_application',
    'Finds the most recently uploaded version of an app. ' +
    'Search by appName (partial, case-insensitive — e.g. "ExperiBank") without needing the bundle ID or package name. ' +
    'Or search by bundleIdentifier (iOS) or packageName (Android) for exact matching. ' +
    'osType is optional when searching by appName; omit it to search across all platforms. ' +
    'PROJECT-AWARE: when several uploads match, the newest one assigned to your ACTIVE project is preferred ' +
    '(install/session run in the active project context — an app assigned only to another project will fail there). ' +
    'The response lists each app\'s project assignments; heed the projectWarning if present. ' +
    'Returns the app ID needed by assign_app_to_project. ' +
    'Used in create_poc Step 10 to locate a demo app before assigning it to the POC project.',
    {
      appName: z
        .string()
        .optional()
        .describe(
          'Find by app name — partial, case-insensitive match. E.g. "ExperiBank" finds the latest upload whose name contains "ExperiBank". ' +
          'Use this when you do not know the bundle identifier or package name.'
        ),
      osType: z.enum(['ios', 'android']).optional().describe("Platform: 'ios' or 'android'. Optional when searching by appName alone."),
      packageName: z
        .string()
        .optional()
        .describe('Android package name (e.g. com.mycompany.app). Exact server-side filter.'),
      bundleIdentifier: z
        .string()
        .optional()
        .describe('iOS bundle identifier (e.g. com.mycompany.app). Exact server-side filter.'),
      outputFormat: outputFormatParam,
    },
    async ({ appName, osType, packageName, bundleIdentifier, outputFormat }) => {
      try {
        // Guard against mis-named parameters (e.g. name= / os=): with no criteria
        // this tool would otherwise "find" the newest app in the entire catalog.
        if (!appName && !packageName && !bundleIdentifier) {
          return {
            content: [{
              type: 'text',
              text: 'Error: provide at least one search criterion — appName (partial match), packageName (Android), or bundleIdentifier (iOS). ' +
                'Parameter names matter: use appName (not "name") and osType (not "os").',
            }],
            isError: true,
          };
        }

        let apps = await getApplications({ osType, packageName, bundleIdentifier });
        if (appName) {
          const q = appName.toLowerCase();
          apps = apps.filter(a => a.applicationName.toLowerCase().includes(q));
        }
        if (apps.length === 0) {
          return respond(outputFormat, { found: false }, 'No applications found matching your criteria.');
        }
        const sorted = apps.sort((a, b) => b.createdAt - a.createdAt);

        // Prefer the newest upload assigned to the ACTIVE project — install and
        // inspection sessions run in the active project context, so a copy that
        // only lives in another project will fail there (v36).
        let activeProject: { id: number; name: string } | undefined;
        try {
          const me = await getMyAccountInfo();
          activeProject = { id: me.project.id, name: me.project.name };
        } catch {
          // Non-fatal — fall back to global newest
        }
        const inActiveProject = activeProject
          ? sorted.filter(a => (a.projectsInfo ?? []).some(p => p.id === activeProject!.id))
          : [];
        const latest = inActiveProject[0] ?? sorted[0];
        const preferredOverNewer = inActiveProject[0] != null && inActiveProject[0].id !== sorted[0].id;
        const projectWarning =
          activeProject && !(latest.projectsInfo ?? []).some(p => p.id === activeProject!.id)
            ? `App ${latest.id} is NOT assigned to your active project "${activeProject.name}" — install and inspection sessions will fail there. ` +
              `Assign it first (assign_app_to_project) or switch to a project that has it: ${(latest.projectsInfo ?? []).map(p => p.name).join(', ') || '(none)'}.`
            : undefined;

        // Build the ready-to-use `app` capability string for Appium
        let appCapabilityString: string | undefined;
        if (latest.uniqueName) {
          appCapabilityString = `cloud:${latest.uniqueName}`;
        } else if (latest.packageName) {
          appCapabilityString = `cloud:${latest.packageName}`;
        } else if (latest.bundleIdentifier) {
          appCapabilityString = `cloud:${latest.bundleIdentifier}`;
        }

        const structured = {
          ...latest,
          appCapabilityString,
          activeProject,
          ...(projectWarning && { projectWarning }),
        };

        const humanText = [
          `📦 Latest: ${latest.applicationName}`,
          `ID: ${latest.id}`,
          `Version: ${latest.releaseVersion} (build ${latest.buildVersion})`,
          `File Type: ${latest.fileType.toUpperCase()}`,
          `Package: ${latest.packageName ?? latest.bundleIdentifier ?? 'N/A'}`,
          `Uploaded: ${latest.createdAtFormatted}`,
          `Unique Name: ${latest.uniqueName ?? 'none'}`,
          `Projects: ${(latest.projectsInfo ?? []).map(p => p.name).join(', ') || '(none)'}`,
          appCapabilityString ? `App Capability: ${appCapabilityString}` : '',
          preferredOverNewer
            ? `\nNote: a newer upload exists (ID ${sorted[0].id}, ${sorted[0].createdAtFormatted}) but is not assigned to your active project "${activeProject?.name}" — returned the newest copy that is.`
            : '',
          projectWarning ? `\n⚠️  ${projectWarning}` : '',
          apps.length > 1
            ? `\nNote: ${apps.length - 1} other matching upload(s) in the repository.`
            : '',
        ]
          .filter(Boolean)
          .join('\n');
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'extract_app_language_files',
    'Downloads the localization/language files from an app as a ZIP archive. Useful for reviewing or auditing app translations. APK and IPA only.',
    {
      applicationId: z.number().describe('The numeric application ID (APK or IPA only).'),
      localPath: z.string().describe('Local file path where the ZIP will be saved.'),
    },
    async ({ applicationId, localPath }) => {
      const pathErr = validateOutputPath(localPath);
      if (pathErr) return { content: [{ type: 'text', text: `Error: ${pathErr}` }], isError: true };
      try {
        await extractLanguageFiles(applicationId, localPath);
        return {
          content: [
            {
              type: 'text',
              text: `✅ Language files for app ${applicationId} extracted to: ${localPath}`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── bulk_install_to_group ────────────────────────────────────────────────

  server.tool(
    'bulk_install_to_group',
    'Install an app on every device in a device group in a single call. Replaces the tedious one-device-at-a-time workflow when setting up a test run. Reports per-device success/failure so you can see which devices had problems.',
    {
      applicationId: z
        .number()
        .int()
        .describe('Numeric application ID to install. Use list_applications to find it.'),
      deviceGroupId: z
        .string()
        .describe('Device group ID whose devices will receive the app. Use list_device_groups to find it.'),
      instrument: z
        .boolean()
        .optional()
        .describe('If true, the app is instrumented for test automation. Default: false.'),
      keepData: z
        .boolean()
        .optional()
        .describe('If true, existing app data is preserved on reinstall. Default: false.'),
    },
    async ({ applicationId, deviceGroupId, instrument, keepData }) => {
      try {
        const devices = await getDevicesInDeviceGroup(deviceGroupId);

        if (devices.length === 0) {
          return { content: [{ type: 'text', text: `Device group ${deviceGroupId} has no devices.` }] };
        }

        const results: string[] = [`Installing app ${applicationId} on ${devices.length} device(s) in group ${deviceGroupId}:\n`];

        for (const device of devices) {
          try {
            await installApplication(applicationId, {
              deviceId: device.id,
              instrument: instrument ?? false,
              keepData: keepData ?? false,
            });
            results.push(`  ✅ ${device.deviceName} (ID: ${device.id})`);
          } catch (err) {
            results.push(`  ❌ ${device.deviceName} (ID: ${device.id}) — ${(err as Error).message}`);
          }
        }

        const succeeded = results.filter((l) => l.includes('✅')).length;
        const failed = results.filter((l) => l.includes('❌')).length;
        results.push(`\nDone: ${succeeded} succeeded, ${failed} failed.`);

        return { content: [{ type: 'text', text: results.join('\n') }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
