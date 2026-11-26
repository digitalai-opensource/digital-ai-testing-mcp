import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Write a downloaded file to the path the caller named, creating its folder when it does not exist yet. Without that a
 * new folder gave a raw "ENOENT: no such file or directory, open '<path>'", which read as if the remote file were
 * missing (UAT 2026-11-24). The path has passed validateOutputPath in the tool handler before this runs.
 */
export async function writeDownloadFile(localPath: string, data: Buffer | string | Uint8Array): Promise<void> {
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, data);
}
