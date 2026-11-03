import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PROTOCOL_VERSION, type LocalConnection } from '../shared/protocol.ts';

export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CONNECTION_FILE = process.env.VIBEWORKS_CONNECTION_FILE ?? fileURLToPath(new URL('../../.cad-local.json', import.meta.url));
export const ARTIFACTS_DIR = fileURLToPath(new URL('../../artifacts/', import.meta.url));
const localConnectionSchema = z.object({
  httpUrl: z.string().regex(/^http:\/\/127\.0\.0\.1:\d+$/),
  wsUrl: z.string(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  pid: z.number().int().positive(), protocolVersion: z.literal(PROTOCOL_VERSION),
}).strict().superRefine((value, ctx) => {
  const port = Number(value.httpUrl.slice(value.httpUrl.lastIndexOf(':') + 1));
  if (port > 65535 || port < 1 || value.wsUrl !== `${value.httpUrl.replace(/^http:/, 'ws:')}/runtime`) ctx.addIssue({ code: 'custom', message: 'Connection URLs must use the same loopback port.' });
});

export async function readConnection(connectionFile = CONNECTION_FILE): Promise<LocalConnection> {
  const file = await open(connectionFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('Connection file must be an owner-only regular file, mode 0600.');
    }
    const value = localConnectionSchema.parse(JSON.parse(await file.readFile('utf8')));
    return { ...value, fingerprint: value.fingerprint ?? 'legacy' };
  } finally {
    await file.close();
  }
}
