import path from 'path';

/**
 * Validates that a user-supplied output path is safe to write to.
 * Returns an error message string if invalid, or null if the path is acceptable.
 *
 * Guards against:
 *   - Relative paths (must be absolute so the destination is unambiguous)
 *   - Path traversal sequences (..) that could escape an intended directory
 */
export function validateOutputPath(localPath: string): string | null {
  if (!path.isAbsolute(localPath)) {
    return `Invalid path: "${localPath}" must be an absolute path.`;
  }
  // Split on both separators so this works cross-platform, and check raw segments
  // before any normalization resolves them away.
  if (localPath.split(/[\\/]/).includes('..')) {
    return `Invalid path: "${localPath}" contains path traversal sequences.`;
  }
  return null;
}

// Filenames that are credentials by convention. Uploading these to the cloud
// repository would publish them to every project member — the server's own
// .env holds the Cloud Admin JWT.
const SENSITIVE_FILENAME_RE = /^(\.env(\..*)?|id_(rsa|dsa|ecdsa|ed25519)(\..*)?)$/i;

/**
 * Validates that a user-supplied local path is safe to READ and upload to the
 * Digital.ai cloud. Same shape rules as validateOutputPath, plus a denylist of
 * credential-file names so a steered request cannot exfiltrate secrets
 * (e.g. "upload .env as a repository file").
 */
export function validateInputPath(localPath: string): string | null {
  const shapeErr = validateOutputPath(localPath);
  if (shapeErr) return shapeErr;
  const basename = localPath.split(/[\\/]/).pop() ?? '';
  if (SENSITIVE_FILENAME_RE.test(basename)) {
    return `Refusing to read "${localPath}": "${basename}" matches a credential-file pattern (.env*, SSH private keys). These must not be uploaded to the cloud repository.`;
  }
  return null;
}
