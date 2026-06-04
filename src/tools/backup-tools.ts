import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createBackup } from '../api/backup.js';

export function registerBackupTools(server: McpServer): void {
  server.tool(
    'create_backup',
    'Triggers a live backup of the Digital.ai server configuration. The backup runs without requiring server downtime. Optionally skip app binaries (noApps: true) to make the backup faster and smaller. Cloud Admin only.',
    {
      noApps: z
        .boolean()
        .optional()
        .default(false)
        .describe('Set to true to skip app binary files — makes the backup faster and smaller. Default: false (include all apps).'),
    },
    async ({ noApps }) => {
      try {
        const result = await createBackup(noApps);
        return {
          content: [
            {
              type: 'text',
              text: [
                '✅ Backup initiated.',
                `Message: ${result.message}`,
                noApps ? 'Note: App binaries were excluded from this backup.' : '',
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
