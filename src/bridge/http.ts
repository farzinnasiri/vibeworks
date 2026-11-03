import { MAX_RESPONSE_BYTES } from './validation.ts';

export async function readJson(response: Response, limit = MAX_RESPONSE_BYTES): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Bridge response exceeds the payload limit.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Bridge returned no response body.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) throw new Error('Bridge response exceeds the payload limit.');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
