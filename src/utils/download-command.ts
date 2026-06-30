import { getActiveAccessKey, getActiveUrl, getActiveKeyType } from '../api/client.js';

// Mirror of buildUploadCommand for the DOWNLOAD direction. The MCP server runs
// in Docker/remote, so a file it writes lands on the server's filesystem, not
// the caller's. These tools emit a curl / Invoke-WebRequest command the user
// runs locally, so the binary (e.g. a session .mp4 or the attachment ZIP)
// downloads straight to THEIR machine — bypassing the filesystem boundary the
// same way the upload-command tools do.

export interface DownloadCommandSpec {
  /** Endpoint path (leading slash); the full URL is built from the active base URL. */
  path: string;
  /** Local path the user saves to, used verbatim in the generated command. */
  localPath: string;
  /** Platform of the machine that will RUN the command (cannot be inferred — MCP runs in Docker). */
  localPlatform: 'windows' | 'macos' | 'linux';
  /** Optional advisory lines inserted before the command blocks. */
  notes?: string[];
}

export interface DownloadCommandResult {
  endpoint: string;
  curlCommand: string;
  psCommand: string | null;
  humanText: string;
}

export function buildDownloadCommand(spec: DownloadCommandSpec): DownloadCommandResult {
  const accessKey = getActiveAccessKey();
  const baseUrl = getActiveUrl();
  const isJwt = getActiveKeyType() === 'jwt';
  const isWindows = spec.localPlatform === 'windows';
  const endpoint = `${baseUrl}${spec.path}`;

  // curl — works on macOS, Linux, Git Bash, and WSL. -L follows the redirect
  // some download endpoints issue to blob storage.
  const curlLines: string[] = ['curl -L \\'];
  if (isJwt) {
    curlLines.push(`  -H "Authorization: Bearer ${accessKey}" \\`);
  } else {
    curlLines.push(`  -H "X-API-KEY: ${accessKey}" \\`);
    curlLines.push(`  -H "Authorization: Bearer ${accessKey}" \\`);
  }
  curlLines.push(`  -o "${spec.localPath.replace(/\\/g, '/')}" \\`);
  curlLines.push(`  "${endpoint}"`);
  const curlCommand = curlLines.join('\n');

  // PowerShell (Invoke-WebRequest) — Windows native, follows redirects, -OutFile
  // streams the binary to disk.
  const psLines: string[] = ['$headers = @{'];
  if (isJwt) {
    psLines.push(`    "Authorization" = "Bearer ${accessKey}"`);
  } else {
    psLines.push(`    "X-API-KEY"     = "${accessKey}"`);
    psLines.push(`    "Authorization" = "Bearer ${accessKey}"`);
  }
  psLines.push('}');
  psLines.push(`Invoke-WebRequest -Uri "${endpoint}" \``);
  psLines.push('    -Headers $headers `');
  psLines.push(`    -OutFile "${spec.localPath}"`);
  const psCommand = psLines.join('\n');

  const lines: string[] = [
    '⚠️  WARNING: The commands below embed your access key in plaintext.',
    '   Run immediately — do not save, share, or commit this output.',
    '',
  ];
  for (const note of spec.notes ?? []) lines.push(note);
  if ((spec.notes ?? []).length > 0) lines.push('');

  if (isWindows) {
    lines.push('─── Git Bash / WSL / macOS curl ─────────────────────────────────', '', '```bash', curlCommand, '```', '');
    lines.push('─── PowerShell (Invoke-WebRequest) ──────────────────────────────', '', '```powershell', psCommand, '```');
  } else {
    lines.push('```bash', curlCommand, '```');
  }

  return { endpoint, curlCommand, psCommand: isWindows ? psCommand : null, humanText: lines.join('\n') };
}
