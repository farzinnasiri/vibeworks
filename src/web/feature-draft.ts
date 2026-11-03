import { pruneBindings } from '../cad/parameters';
import type { Feature } from '../shared/protocol';

const shape = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === 'number' ? 0 : v);

/** The profile editors retain surviving array entries by reference in their immutable drafts. */
function survivingPath(before: unknown, after: unknown, keys: string[]): string[] | undefined {
  if (before === after) return keys;
  if (!keys.length || !before || !after || typeof before !== 'object' || typeof after !== 'object') return;
  const [key, ...rest] = keys;
  if (Array.isArray(before) && Array.isArray(after)) {
    let index = Number(key);
    const entry: unknown = before[index];
    if (entry && typeof entry === 'object') {
      const moved = after.indexOf(entry);
      if (moved >= 0) index = moved;
      // A removed entry must never transfer its bindings to its replacement at the same index.
      else if (before.length !== after.length || before.includes(after[index])) return;
    }
    const tail = survivingPath(entry, after[index], rest);
    return tail && [String(index), ...tail];
  }
  const old = before as Record<string, unknown>, next = after as Record<string, unknown>;
  if (old.type !== next.type) return;
  const tail = survivingPath(old[key], next[key], rest);
  return tail && [key, ...tail];
}

/** Apply a structural form edit to params and its bindings together. */
export function changeFeatureParams(feature: Feature, params: Record<string, unknown>, reset: string[] = []): Feature {
  const reshaped = Object.keys(params).filter(key => shape((feature.params as Record<string, unknown>)[key]) !== shape(params[key]));
  const bindings = Object.fromEntries(Object.entries(feature.bindings ?? {}).flatMap(([path, expression]) => {
    const [key, ...tail] = path.split('.');
    if (reset.includes(key)) return [];
    if (Object.hasOwn(params, key) && ['sections', 'profile', 'path'].includes(key)) {
      const kept = survivingPath((feature.params as Record<string, unknown>)[key], params[key], tail);
      return kept ? [[[key, ...kept].join('.'), expression]] : [];
    }
    // Keep the established behavior of the other feature editors outside this correction.
    return reshaped.includes(key) && tail.length ? [] : [[path, expression]];
  }));
  const { bindings: _bindings, ...rest } = feature;
  return pruneBindings({ ...rest, params: { ...feature.params, ...params }, ...(Object.keys(bindings).length ? { bindings } : {}) } as Feature);
}
