import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getAllProvisioningProfiles,
  getProvisioningProfile,
  uploadProvisioningProfile,
  downloadProvisioningProfile,
  deleteProvisioningProfile,
} from '../api/provisioning-profiles.js';
import { checkDestructiveGuard } from '../utils/destructive-guard.js';
import { validateOutputPath, validateInputPath } from '../utils/path-guard.js';
import { applyMaxResults, appendTruncationNotice } from '../utils/pagination.js';
import { formatProvisioningProfileList } from '../utils/response-formatter.js';
import { outputFormatParam, respond } from '../utils/output-format.js';

export function registerProvisioningProfileTools(server: McpServer): void {
  server.tool(
    'list_provisioning_profiles',
    'Lists all iOS provisioning profiles (signing certificates) uploaded to Digital.ai. Shows expiry status — red for expired, yellow for expiring within 30 days, green for valid. Cloud Admin only.',
    {
      maxResults: z
        .number()
        .optional()
        .default(50)
        .describe('Maximum number of results to return (default: 50, max: 500).'),
      outputFormat: outputFormatParam,
    },
    async ({ maxResults, outputFormat }) => {
      try {
        const profiles = await getAllProvisioningProfiles();
        const paged = applyMaxResults(profiles, maxResults);
        const structured = {
          profiles: paged.items.map(p => ({
            profileUUID: p.profileUUID,
            profileName: p.profileName,
            applicationPrefix: p.applicationPrefix,
            expirationDate: p.expirationDate,
          })),
        };
        const humanText = appendTruncationNotice(
          `iOS Provisioning Profiles (${paged.total} total):\n\n${formatProvisioningProfileList(paged.items)}`,
          paged
        );
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_provisioning_profile',
    'Gets full details for a specific iOS provisioning profile by its UUID.',
    {
      profileUUID: z.string().describe('The UUID of the provisioning profile.'),
      outputFormat: outputFormatParam,
    },
    async ({ profileUUID, outputFormat }) => {
      try {
        const profile = await getProvisioningProfile(profileUUID);
        const expiry = new Date(profile.expirationDate);
        const daysLeft = Math.floor((expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        const expiryStatus =
          daysLeft < 0
            ? '🔴 EXPIRED'
            : daysLeft <= 30
            ? `🟡 EXPIRING SOON (${daysLeft} days)`
            : `🟢 VALID (${daysLeft} days left)`;

        const humanText = [
          `📜 ${profile.profileName}`,
          `UUID: ${profile.profileUUID}`,
          `App Prefix: ${profile.applicationPrefix}`,
          `Expiry: ${profile.expirationDate} — ${expiryStatus}`,
          profile.notes ? `Notes: ${profile.notes}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        return respond(outputFormat, profile, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'upload_provisioning_profile',
    'Uploads an iOS provisioning profile (P12 certificate + .mobileprovision file) to Digital.ai for use in app signing. Cloud Admin only.',
    {
      p12FilePath: z.string().describe('Absolute path to the .p12 certificate file.'),
      password: z.string().describe('Password for the .p12 certificate file.'),
      mobileprovisionFilePath: z
        .string()
        .describe('Absolute path to the .mobileprovision file.'),
      notes: z
        .string()
        .max(255)
        .optional()
        .describe('Optional notes about this profile (max 255 chars).'),
    },
    async ({ p12FilePath, password, mobileprovisionFilePath, notes }) => {
      for (const p of [p12FilePath, mobileprovisionFilePath]) {
        const inputErr = validateInputPath(p);
        if (inputErr) return { content: [{ type: 'text', text: `Error: ${inputErr}` }], isError: true };
      }
      try {
        await uploadProvisioningProfile(p12FilePath, password, mobileprovisionFilePath, notes);
        return {
          content: [
            { type: 'text', text: '✅ Provisioning profile uploaded successfully.' },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'download_provisioning_profile',
    'Downloads a provisioning profile to a local file by UUID. Cloud Admin only.',
    {
      profileUUID: z.string().describe('The UUID of the provisioning profile.'),
      localPath: z.string().describe('Local file path where the profile will be saved.'),
    },
    async ({ profileUUID, localPath }) => {
      const pathErr = validateOutputPath(localPath);
      if (pathErr) return { content: [{ type: 'text', text: `Error: ${pathErr}` }], isError: true };
      try {
        await downloadProvisioningProfile(profileUUID, localPath);
        return {
          content: [
            { type: 'text', text: `✅ Provisioning profile downloaded to: ${localPath}` },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'delete_provisioning_profile',
    'Permanently deletes a provisioning profile. Any apps signed with this profile will need to be re-signed. Cloud Admin only. Requires confirmDeletion: true.',
    {
      profileUUID: z.string().describe('The UUID of the provisioning profile to delete.'),
      confirmDeletion: z
        .boolean()
        .describe('Must be true to confirm this destructive, irreversible operation. No changes are made without this.'),
    },
    async ({ profileUUID, confirmDeletion }) => {
      const guard = checkDestructiveGuard(
        confirmDeletion,
        `Delete provisioning profile ${profileUUID}`
      );
      if (guard) return { content: [{ type: 'text', text: guard }] };
      try {
        await deleteProvisioningProfile(profileUUID);
        return {
          content: [
            { type: 'text', text: `✅ Provisioning profile ${profileUUID} deleted.` },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
