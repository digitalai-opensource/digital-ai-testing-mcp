// Shared notices for tools that read or write a file on the MCP SERVER's own
// filesystem. Whether that filesystem is the caller's own machine depends on
// deployment: under Docker (or any remote/sandboxed host) it is NOT the
// caller's, and NOT visible to the agent's bash or file tools — a path that
// "succeeds" there may write to an inaccessible location (the v47
// download_test_attachments failure). Under the npm package, running
// directly on the user's own machine, it IS the caller's filesystem and none
// of this applies. getDeploymentMode() resolves which is true for this
// process (see deployment-mode.ts); these builders are called once, at tool
// registration time, so each tool's description/param text is already
// correct for however this server instance is actually running — the agent
// never sees the env var or has to reason about it itself.
import { getDeploymentMode } from './deployment-mode.js';

/** Append to the DESCRIPTION of any tool that writes a file to a local path. */
export function serverFsDownloadNotice(): string {
  if (isLocal()) {
    return ' The file is written directly to your own machine\'s filesystem — this server runs locally via the npm package.';
  }
  return (
    ' WARNING: the file is written to the MCP server\'s own filesystem, not your local machine. ' +
    'If the server runs in Docker or a remote container, the path must be valid on that container ' +
    'and the file will NOT be accessible from your local machine or bash/file tools.'
  );
}

/** Append to the DESCRIPTION of any tool that reads a local file to upload. */
export function serverFsUploadNotice(): string {
  if (isLocal()) {
    return ' The path is read directly from your own machine\'s filesystem — this server runs locally via the npm package.';
  }
  return (
    ' WARNING: the path is read from the MCP server\'s own filesystem, not your local machine. ' +
    'If the server runs in Docker or a remote container, you cannot place a file there directly — ' +
    'use the matching *_upload_command tool to get a command you run locally instead.'
  );
}

/** Use as the DESCRIBE() text of a localPath param on a download tool. */
export function serverFsOutputParam(): string {
  if (isLocal()) {
    return 'Absolute path on your machine where the file will be saved (e.g. "C:\\Users\\you\\Downloads\\out.zip" or "/Users/you/Downloads/out.zip").';
  }
  return (
    'Absolute path on the MCP server\'s own filesystem where the file will be saved ' +
    '(e.g. "/tmp/out.zip" for a Linux/Docker deployment) — NOT a path on your local machine.'
  );
}

/** Use as the DESCRIBE() text of a localPath param on an upload tool. */
export function serverFsInputParam(): string {
  if (isLocal()) {
    return 'Absolute path on your machine to read from (e.g. "C:\\Users\\you\\Downloads\\in.bin" or "/Users/you/Downloads/in.bin").';
  }
  return (
    'Absolute path on the MCP server\'s own filesystem to read from ' +
    '(e.g. "/tmp/in.bin" for a Linux/Docker deployment) — NOT a path on your local machine. ' +
    'If the server is remote, use the matching *_upload_command tool instead.'
  );
}

/**
 * Trailing clause for a *_command generator tool's description, naming the
 * direct-tool alternative it exists to work around. Under 'local', the
 * generator is optional (the direct tool already works) rather than the only
 * viable path.
 */
export function commandGeneratorNotice(directToolName: string, verb: 'download' | 'upload'): string {
  const action = verb === 'download' ? 'downloading' : 'uploading';
  if (isLocal()) {
    return (
      `This is usually unnecessary here: running locally via the npm package, ${directToolName} already reads/writes ` +
      'your own machine\'s filesystem directly. Use this generator only if you need a portable command to run elsewhere ' +
      '(e.g. a different machine, or scripting outside this session).'
    );
  }
  return (
    `Use this instead of ${directToolName} when the MCP server runs in Docker/remote and the ` +
    `${action === 'downloading' ? 'written file would be inaccessible' : 'server cannot read the local file'} to the user.`
  );
}

/** Use as the DESCRIBE() text of a localPlatform param on a *_command tool. */
export function localPlatformParamNotice(): string {
  if (isLocal()) {
    return (
      '"windows" produces both a Git Bash curl command and a PowerShell alternative. ' +
      '"macos"/"linux" produce a bash curl command. This server runs on your own machine, so pick to match your own OS.'
    );
  }
  return (
    '"windows" produces both a Git Bash curl command and a PowerShell alternative. ' +
    '"macos"/"linux" produce a bash curl command. Cannot be inferred — the MCP runs in Docker.'
  );
}

/** One-line remedy for "tools are missing / build looks stale" diagnostics. */
export function staleBuildRemedy(): string {
  if (isLocal()) {
    return 'Run `npm install -g digital-ai-testing-mcp` again to update to the latest published version.';
  }
  return 'Rebuild: docker build -t digital-ai-testing-mcp:latest .';
}

function isLocal(): boolean {
  return getDeploymentMode() === 'local';
}
