import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  listFiles,
  getFileInfo,
  uploadFile,
  downloadFile,
  updateFile,
  deleteFile,
} from '../api/repository.js';
import { checkDestructiveGuard } from '../utils/destructive-guard.js';
import { validateOutputPath, validateInputPath } from '../utils/path-guard.js';
import { applyMaxResults, appendTruncationNotice } from '../utils/pagination.js';
import { formatRepositoryFileList } from '../utils/response-formatter.js';
import { outputFormatParam, respond } from '../utils/output-format.js';

export function registerRepositoryTools(server: McpServer): void {
  server.tool(
    'list_repository_files',
    'Lists files in the Digital.ai file repository. You can filter by project name or unique name. Each file has a numeric ID — use that ID for downloads, updates, and deletes.',
    {
      projectId: z.string().optional().describe('Filter by project ID.'),
      projectName: z.string().optional().describe('Filter by project name.'),
      uniqueName: z.string().optional().describe('Filter by unique name alias.'),
      maxResults: z
        .number()
        .optional()
        .default(50)
        .describe('Maximum number of results to return (default: 50, max: 500).'),
      outputFormat: outputFormatParam,
    },
    async ({ projectId, projectName, uniqueName, maxResults, outputFormat }) => {
      try {
        const files = await listFiles({ projectId, projectName, uniqueName });
        const paged = applyMaxResults(files, maxResults);
        const structured = {
          files: paged.items.map(f => ({
            id: f.id,
            uniqueName: f.uniqueName,
            extension: f.extension,
            size: f.size,
            projectName: f.projectName,
            uploadedUser: f.uploadedUser,
            uploadTime: f.uploadTime,
          })),
        };
        const humanText = appendTruncationNotice(
          `Found ${paged.total} file(s):\n\n${formatRepositoryFileList(paged.items)}`,
          paged
        );
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_repository_file_info',
    'Gets the details of a specific file by its numeric ID.',
    {
      fileId: z.number().describe('The numeric file ID. Use list_repository_files to find it.'),
      outputFormat: outputFormatParam,
    },
    async ({ fileId, outputFormat }) => {
      try {
        const file = await getFileInfo(fileId);
        const sizeKb = (file.size / 1024).toFixed(1);
        const humanText = [
          `📄 ${file.uniqueName} (ID: ${file.id})`,
          `Extension: ${file.extension}`,
          `Size: ${sizeKb} KB`,
          `Project: ${file.projectName}`,
          `Description: ${file.description ?? 'none'}`,
          `Uploaded by: ${file.uploadedUser}`,
          `Upload time: ${file.uploadTime}`,
          `Last updated by: ${file.lastUpdatedUser}`,
          `Last update: ${file.lastUpdate}`,
          `System file: ${file.uploadedBySystem}`,
        ].join('\n');
        return respond(outputFormat, file, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'upload_repository_file',
    'Uploads a file to the repository. You can assign it a unique name for easy reference in test scripts. Returns the numeric file ID — save this for future updates or downloads.',
    {
      localFilePath: z.string().describe('Absolute path to the local file to upload.'),
      uniqueName: z.string().optional().describe('A short unique alias for this file.'),
      description: z
        .string()
        .max(255)
        .optional()
        .describe('Description of the file (max 255 characters).'),
      projectId: z.string().optional().describe('Project ID to associate with.'),
      projectName: z.string().optional().describe('Project name to associate with.'),
    },
    async ({ localFilePath, uniqueName, description, projectId, projectName }) => {
      const inputErr = validateInputPath(localFilePath);
      if (inputErr) return { content: [{ type: 'text', text: `Error: ${inputErr}` }], isError: true };
      try {
        const fileId = await uploadFile(localFilePath, {
          uniqueName,
          description,
          projectId,
          projectName,
        });
        return {
          content: [
            {
              type: 'text',
              text: [
                `✅ File uploaded to repository.`,
                `File ID: ${fileId}`,
                uniqueName ? `Unique Name: ${uniqueName}` : '',
                `Keep this ID to download or update the file later.`,
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

  server.tool(
    'download_repository_file',
    'Downloads a file from the repository to your local machine using its numeric ID.',
    {
      fileId: z.number().describe('The numeric file ID.'),
      localPath: z.string().describe('Local file path where the file will be saved.'),
    },
    async ({ fileId, localPath }) => {
      const pathErr = validateOutputPath(localPath);
      if (pathErr) return { content: [{ type: 'text', text: `Error: ${pathErr}` }], isError: true };
      try {
        await downloadFile(fileId, localPath);
        return {
          content: [{ type: 'text', text: `✅ File ${fileId} downloaded to: ${localPath}` }],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'update_repository_file',
    "Replaces a file's content in-place while keeping the same numeric ID. Useful for updating test data files that your test scripts already reference by ID. You can also update the unique name or description.",
    {
      fileId: z.number().describe('The numeric file ID to update.'),
      localFilePath: z.string().optional().describe('New local file path (replaces file content).'),
      uniqueName: z.string().optional().describe('New unique name alias.'),
      description: z.string().optional().describe('New description.'),
    },
    async ({ fileId, localFilePath, uniqueName, description }) => {
      if (localFilePath) {
        const inputErr = validateInputPath(localFilePath);
        if (inputErr) return { content: [{ type: 'text', text: `Error: ${inputErr}` }], isError: true };
      }
      try {
        await updateFile(fileId, { localPath: localFilePath, uniqueName, description });
        return {
          content: [{ type: 'text', text: `✅ File ${fileId} updated successfully.` }],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'delete_repository_file',
    'Permanently deletes a file from the repository. Any test scripts that reference this file\'s ID or unique name may fail. Requires confirmDeletion: true.',
    {
      fileId: z.number().describe('The numeric file ID to delete.'),
      confirmDeletion: z
        .boolean()
        .describe('Must be true to confirm this destructive, irreversible operation. No changes are made without this.'),
    },
    async ({ fileId, confirmDeletion }) => {
      const guard = checkDestructiveGuard(confirmDeletion, `Delete repository file ${fileId}`);
      if (guard) return { content: [{ type: 'text', text: guard }] };
      try {
        await deleteFile(fileId);
        return {
          content: [{ type: 'text', text: `✅ File ${fileId} permanently deleted from repository.` }],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
