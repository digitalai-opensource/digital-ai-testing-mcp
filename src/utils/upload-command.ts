import { getActiveAccessKey, getActiveUrl, getActiveKeyType } from '../api/client.js';

// Shared builder for "run this on your own machine" multipart-upload commands.
// The MCP server typically runs in Docker, so it cannot read a file from the
// caller's filesystem. These tools emit a curl / PowerShell command the user
// runs locally, so the binary never has to pass through the container.
// Mirrors the auth + plaintext-key-warning behavior of get_application_upload_command.

export interface UploadCommandSpec {
  /** Full endpoint URL is built from the active base URL + this path (leading slash). */
  path: string;
  /** Multipart file fields: [formFieldName, localFilePath]. */
  files: Array<[string, string]>;
  /** Multipart scalar fields: [formFieldName, value]. */
  fields: Array<[string, string]>;
  /** Platform of the machine that will RUN the command (cannot be inferred — MCP runs in Docker). */
  localPlatform: 'windows' | 'macos' | 'linux';
  /** Optional extra advisory lines inserted before the command blocks. */
  notes?: string[];
}

export interface UploadCommandResult {
  endpoint: string;
  curlCommand: string;
  psCommand: string | null;
  humanText: string;
}

export function buildUploadCommand(spec: UploadCommandSpec): UploadCommandResult {
  const accessKey = getActiveAccessKey();
  const baseUrl = getActiveUrl();
  const isJwt = getActiveKeyType() === 'jwt';
  const isWindows = spec.localPlatform === 'windows';
  const endpoint = `${baseUrl}${spec.path}`;

  // curl — works on macOS, Linux, Git Bash, and WSL
  const curlLines: string[] = ['curl -X POST \\'];
  if (isJwt) {
    curlLines.push(`  -H "Authorization: Bearer ${accessKey}" \\`);
  } else {
    curlLines.push(`  -H "X-API-KEY: ${accessKey}" \\`);
    curlLines.push(`  -H "Authorization: Bearer ${accessKey}" \\`);
  }
  for (const [field, filePath] of spec.files) {
    curlLines.push(`  -F "${field}=@${filePath.replace(/\\/g, '/')}" \\`);
  }
  for (const [k, v] of spec.fields) curlLines.push(`  -F "${k}=${v}" \\`);
  curlLines.push(`  "${endpoint}"`);
  const curlCommand = curlLines.join('\n');

  // PowerShell (Invoke-RestMethod) — Windows native
  const psLines: string[] = ['$headers = @{'];
  if (isJwt) {
    psLines.push(`    "Authorization" = "Bearer ${accessKey}"`);
  } else {
    psLines.push(`    "X-API-KEY"     = "${accessKey}"`);
    psLines.push(`    "Authorization" = "Bearer ${accessKey}"`);
  }
  psLines.push('}');
  psLines.push('$form = @{');
  for (const [field, filePath] of spec.files) psLines.push(`    "${field}" = Get-Item "${filePath}"`);
  for (const [k, v] of spec.fields) psLines.push(`    "${k}" = "${v}"`);
  psLines.push('}');
  psLines.push(`Invoke-RestMethod -Uri "${endpoint}" \``);
  psLines.push('    -Method POST `');
  psLines.push('    -Headers $headers `');
  psLines.push('    -Form $form');
  const psCommand = psLines.join('\n');

  // Human-readable output
  const lines: string[] = [
    '⚠️  WARNING: The commands below embed your access key in plaintext.',
    '   Run immediately — do not save, share, or commit this output.',
    '',
  ];
  for (const note of spec.notes ?? []) lines.push(note);
  if ((spec.notes ?? []).length > 0) lines.push('');

  if (isWindows) {
    lines.push('─── Git Bash / WSL / macOS curl ─────────────────────────────────', '', '```bash', curlCommand, '```', '');
    lines.push('─── PowerShell (Invoke-RestMethod) ──────────────────────────────', '', '```powershell', psCommand, '```');
  } else {
    lines.push('```bash', curlCommand, '```');
  }

  return { endpoint, curlCommand, psCommand: isWindows ? psCommand : null, humanText: lines.join('\n') };
}
