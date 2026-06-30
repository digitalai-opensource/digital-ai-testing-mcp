// Shared notices for tools that read or write a file on the MCP SERVER's own
// filesystem. The server typically runs in Docker / a remote container, so its
// filesystem is NOT the caller's machine and is NOT visible to the agent's bash
// or file tools. A path that "succeeds" here may write to an inaccessible
// location (the v47 download_test_attachments failure). Append these to the
// relevant tool/param descriptions so the locality constraint is explicit.

/** Append to the DESCRIPTION of any tool that writes a file to a local path. */
export const SERVER_FS_DOWNLOAD_NOTICE =
  ' WARNING: the file is written to the MCP server\'s own filesystem, not your local machine. ' +
  'If the server runs in Docker or a remote container, the path must be valid on that container ' +
  'and the file will NOT be accessible from your local machine or bash/file tools.';

/** Append to the DESCRIPTION of any tool that reads a local file to upload. */
export const SERVER_FS_UPLOAD_NOTICE =
  ' WARNING: the path is read from the MCP server\'s own filesystem, not your local machine. ' +
  'If the server runs in Docker or a remote container, you cannot place a file there directly — ' +
  'use the matching *_upload_command tool to get a command you run locally instead.';

/** Use as the DESCRIBE() text of a localPath param on a download tool. */
export const SERVER_FS_OUTPUT_PARAM =
  'Absolute path on the MCP server\'s own filesystem where the file will be saved ' +
  '(e.g. "/tmp/out.zip" for a Linux/Docker deployment) — NOT a path on your local machine.';

/** Use as the DESCRIBE() text of a localPath param on an upload tool. */
export const SERVER_FS_INPUT_PARAM =
  'Absolute path on the MCP server\'s own filesystem to read from ' +
  '(e.g. "/tmp/in.bin" for a Linux/Docker deployment) — NOT a path on your local machine. ' +
  'If the server is remote, use the matching *_upload_command tool instead.';
