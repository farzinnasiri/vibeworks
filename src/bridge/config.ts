import { BRIDGE_PORT } from '../shared/protocol.ts';

function port(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error(`${name} must be an integer from 1 to 65535.`);
  return Number(value);
}
export const bridgePort = () => port('VIBEWORKS_BRIDGE_PORT', BRIDGE_PORT);
export const webPort = () => port('VIBEWORKS_WEB_PORT', 5173);
export const plainWebOrigin = () => `http://127.0.0.1:${webPort()}`;
/** Geometry worker count, 1–4 (each keeps its own exact cache and up to 2.5 GiB of OCCT heap). */
export const workerCount = () => {
  const value = process.env.VIBEWORKS_WORKERS;
  if (value === undefined) return 2;
  if (!/^[1-4]$/.test(value)) throw new Error('VIBEWORKS_WORKERS must be an integer from 1 to 4.');
  return Number(value);
};
