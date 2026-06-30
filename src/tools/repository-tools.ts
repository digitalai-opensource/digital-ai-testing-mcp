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
import {
  SERVER_FS_DOWNLOAD_NOTICE,
  SERVER_FS_UPLOAD_NOTICE,
  SERVER_FS_OUTPUT_PARAM,
  SERVER_FS_INPUT_PARAM,
} from '../utils/locality.js';
import { buildUploadCommand } from '../utils/upload-command.js';
import { buildDownloadCommand } from '../utils/download-command.js';
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
    'Uploads a file to the repository. You can assign it a unique name for easy reference in test scripts. Returns the numeric file ID — save this for future updates or downloads.' + SERVER_FS_UPLOAD_NOTICE +
    ' For a remote/Docker server, use get_repository_upload_command to get a command you run on your own machine instead.',
    {
      localFilePath: z.string().describe('Absolute path to the local file to upload. ' + SERVER_FS_INPUT_PARAM),
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
    'get_repository_upload_command',
    'Generates a ready-to-run curl or PowerShell command for uploading a file to the repository directly from the user\'s local machine. ' +
    'Use this instead of upload_repository_file when the MCP server runs in Docker/remote and cannot read the local file. The user runs the generated command locally so the file never passes through the container.\n\n' +
    'WARNING: The generated command embeds the active access key in plaintext. Instruct the user to run it immediately and not save or share the output.',
    {
      localFilePath: z.string().describe('Full path to the file on the user\'s local machine, used verbatim in the command.'),
      uniqueName: z.string().optional().describe('A short unique alias for this file.'),
      description: z.string().max(255).optional().describe('Description of the file (max 255 characters).'),
      projectId: z.string().optional().describe('Project ID to associate with.'),
      projectName: z.string().optional().describe('Project name to associate with.'),
      localPlatform: z.enum(['windows', 'macos', 'linux']).describe('Platform of the machine that will run the command. "windows" emits both Git Bash curl and PowerShell. Cannot be inferred — the MCP runs in Docker.'),
      outputFormat: outputFormatParam,
    },
    async ({ localFilePath, uniqueName, description, projectId, projectName, localPlatform, outputFormat }) => {
      const fields: Array<[string, string]> = [];
      if (uniqueName) fields.push(['uniqueName', uniqueName]);
      if (description) fields.push(['description', description]);
      if (projectId) fields.push(['projectId', projectId]);
      if (projectName) fields.push(['projectName', projectName]);
      const result = buildUploadCommand({
        path: '/api/v1/files',
        files: [['file', localFilePath]],
        fields,
        localPlatform,
      });
      return respond(outputFormat, { endpoint: result.endpoint, curlCommand: result.curlCommand, psCommand: result.psCommand }, result.humanText);
    }
  );

  server.tool(
    'download_repository_file',
    'Downloads a file from the repository using its numeric ID.' + SERVER_FS_DOWNLOAD_NOTICE,
    {
      fileId: z.number().describe('The numeric file ID.'),
      localPath: z.string().describe(SERVER_FS_OUTPUT_PARAM),
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
    'get_repository_file_download_command',
    'Generates a ready-to-run curl or PowerShell command for downloading a repository file directly to the user\'s local machine. ' +
    'Use this instead of download_repository_file when the MCP server runs in Docker/remote and the written file would be inaccessible to the user.\n\n' +
    'WARNING: The generated command embeds the active access key in plaintext. Instruct the user to run it immediately and not save or share the output.',
    {
      fileId: z.number().describe('The numeric file ID.'),
      localPath: z.string().describe('Path on the user\'s local machine to save the file.'),
      localPlatform: z.enum(['windows', 'macos', 'linux']).describe('Platform of the machine that will run the command. "windows" emits both Git Bash curl and PowerShell. Cannot be inferred — the MCP runs in Docker.'),
      outputFormat: outputFormatParam,
    },
    async ({ fileId, localPath, localPlatform, outputFormat }) => {
      const result = buildDownloadCommand({ path: `/api/v1/files/${fileId}/download`, localPath, localPlatform });
      return respond(outputFormat, { endpoint: result.endpoint, curlCommand: result.curlCommand, psCommand: result.psCommand }, result.humanText);
    }
  );

  server.tool(
    'update_repository_file',
    "Replaces a file's content in-place while keeping the same numeric ID. Useful for updating test data files that your test scripts already reference by ID. You can also update the unique name or description.",
    {
      fileId: z.number().describe('The numeric file ID to update.'),
      localFilePath: z.string().optional().describe('New file path (replaces file content). ' + SERVER_FS_INPUT_PARAM),
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
