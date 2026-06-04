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
