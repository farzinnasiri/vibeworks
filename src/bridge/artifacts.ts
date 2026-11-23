import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ARTIFACTS_DIR } from './connection.ts';
import { MAX_ARTIFACT_BYTES } from './validation.ts';

export interface SavedArtifact { filename: string; path: string; uri: string; mimeType: string; byteLength: number; sha256: string }

export async function saveArtifact(bytes: Buffer, filename: string, mimeType: string, directory = ARTIFACTS_DIR, maxBytes = MAX_ARTIFACT_BYTES): Promise<SavedArtifact> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,120}$/.test(filename) || basename(filename) !== filename || !bytes.length || bytes.length > maxBytes) throw new Error('Artifact must have a safe basename and nonempty bytes within the export limit.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The artifacts directory must be a real directory, not a symlink.');
  const root = await realpath(directory);
  // A unique exclusive file prevents overwrite, including symlink targets.
  const outputName = `${randomUUID()}-${filename}`;
  const path = join(root, outputName);
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); }
  catch (error) { await unlink(path).catch(() => {}); throw error; }
  finally { await file.close(); }
  return { filename: outputName, path, uri: pathToFileURL(path).href, mimeType, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
