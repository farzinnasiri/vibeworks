import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Include transitive contract inputs. Paths and normalized bytes make this independent
// of checkout location, mtimes and platform line endings. Never recompute the loaded value.
export const CONTRACT_FILES = ['src/shared/protocol.ts', 'src/shared/display.ts', 'src/shared/materials.ts', 'src/bridge/validation.ts'];
export function workspaceFingerprint(): string {
  const hash = createHash('sha256');
  for (const path of CONTRACT_FILES) {
    hash.update(path + '\0');
    hash.update(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n'));
    hash.update('\0');
  }
  return hash.digest('hex');
}
export const CONTRACT_FINGERPRINT = workspaceFingerprint();
