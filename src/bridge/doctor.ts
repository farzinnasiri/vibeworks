import { z } from 'zod';
import { commandError, commandFailureSchema, requiresHumanSchema, type ConnectionDiagnosis, type LocalConnection } from '../shared/protocol.ts';
import { readConnection } from './connection.ts';
import { CONTRACT_FINGERPRINT, workspaceFingerprint } from './fingerprint.ts';
import { connectionIssues, deduplicateIssues, versionIssues } from './diagnosis.ts';
import { readJson } from './http.ts';

const event = z.object({ at: z.string(), code: z.string(), message: z.string(), closeCode: z.number().optional(), requiresHuman: requiresHumanSchema.optional(), fingerprint: z.string().optional() });
const diagnosisSchema = z.object({
  bridgeReachable: z.boolean(), browserConnected: z.boolean().nullable(),
  fingerprints: z.object({ workspace: z.string().optional(), bridge: z.string().optional(), browser: z.string().optional(), adapter: z.string().optional() }),
  kernel: z.object({ authority:z.literal('node'), phase:z.enum(['initializing','ready','unavailable']), error:z.string().optional(), workers:z.array(z.unknown()), pending:z.number(), queueLimit:z.number(), renderer:z.object({phase:z.string(),error:z.string().optional()}), rssBytes:z.number() }).optional(),
  issues: z.array(commandFailureSchema), lastRejection: event.optional(), lastDisconnect: event.optional(),
});

export async function doctor(readLocal: () => Promise<LocalConnection> = readConnection, adapter = CONTRACT_FINGERPRINT): Promise<ConnectionDiagnosis> {
  const fingerprints: ConnectionDiagnosis['fingerprints'] = { workspace: workspaceFingerprint(), adapter };
  let connection: LocalConnection;
  try { connection = await readLocal(); }
  catch (error) {
    return { bridgeReachable: false, browserConnected: null, fingerprints, issues: [commandError('inspect_model', 'BRIDGE_NOT_RUNNING', `Cannot read a valid private connection file for this checkout: ${error instanceof Error ? error.message : 'unknown read failure'}`).error!] };
  }
  fingerprints.bridge = connection.fingerprint;
  try {
    const response = await fetch(`${connection.httpUrl}/health`, { headers: { 'X-Vibeworks-Fingerprint': adapter }, signal: AbortSignal.timeout(3000), redirect: 'error' });
    const value = await readJson(response, 64 * 1024);
    if (!response.ok) throw new Error(`Health returned HTTP ${response.status}`);
    const parsed = z.object({ diagnosis: diagnosisSchema.optional() }).parse(value);
    if (!parsed.diagnosis) return { bridgeReachable: true, browserConnected: null, fingerprints, issues: [commandError('inspect_model', 'VERSION_SKEW', 'The bridge does not support contract diagnosis.', undefined, { reason: 'The bridge uses an older handshake.', steps: ['Restart make dev in this checkout.'] }).error!] };
    const result: ConnectionDiagnosis = parsed.diagnosis;
    // Use this adapter's checkout as the reference, not a possibly different bridge checkout.
    result.fingerprints = { ...result.fingerprints, workspace: fingerprints.workspace, adapter };
    result.issues = deduplicateIssues(result.kernel ? [...result.issues.filter(issue=>issue.code!=='VERSION_SKEW'), ...versionIssues(result.fingerprints)] : connectionIssues(result.fingerprints, result.browserConnected, result.lastRejection, result.lastDisconnect));
    return result;
  } catch (error) {
    return { bridgeReachable: false, browserConnected: null, fingerprints, issues: [commandError('inspect_model', 'BRIDGE_TRANSPORT_ERROR', `The bridge did not return a valid health response: ${error instanceof Error ? error.message : 'unknown transport failure'}. No modeling command was sent.`).error!] };
  }
}

export function formatDoctor(result: ConnectionDiagnosis): string {
  result = { ...result, issues: deduplicateIssues(result.issues) };
  const lines = [
    `Bridge: ${result.bridgeReachable ? 'reachable' : 'unreachable'}`,
    ...(result.kernel ? [`Kernel: ${result.kernel.phase} (Node authority, ${result.kernel.workers.length} bounded workers)`, `Renderer: ${result.kernel.renderer.phase}${result.kernel.renderer.error ? ': '+result.kernel.renderer.error : ''}`, `Queue: ${result.kernel.pending}/${result.kernel.queueLimit}`] : []),
    ...(result.kernel?.workers.map((value, index) => {
      const worker = value as { phase?: string; lastError?: string };
      return `Worker ${index}: ${worker.phase ?? 'unknown'}${worker.lastError ? ': '+worker.lastError : ''}`;
    }) ?? []),
    `Browser: ${result.browserConnected === null ? 'unknown' : result.browserConnected ? 'connected' : 'disconnected'}`,
    ...Object.entries(result.fingerprints).map(([process, hash]) => `${process} fingerprint: ${hash}`),
    `Contract: ${result.issues.some(issue => issue.code === 'VERSION_SKEW') ? 'VERSION_SKEW' : result.kernel ? 'matches across workspace, bridge and adapter' : result.browserConnected ? 'matches across workspace, bridge, adapter and browser' : 'browser match not verified'}`,
    ...(result.lastRejection ? [`Last rejection: ${result.lastRejection.code}: ${result.lastRejection.message}${result.lastRejection.fingerprint ? ` [fingerprint ${result.lastRejection.fingerprint}]` : ''} (${result.lastRejection.at})`] : ['Last rejection: none recorded']),
    ...(result.lastDisconnect ? [`Last disconnect: ${result.lastDisconnect.code}${result.lastDisconnect.closeCode === undefined ? '' : ` / ${result.lastDisconnect.closeCode}`}: ${result.lastDisconnect.message} (${result.lastDisconnect.at})`] : ['Last disconnect: none recorded']),
    ...result.issues.map(issue => `${issue.code}: ${issue.message}`),
  ];
  const steps = [...new Set(result.issues.flatMap(issue => issue.requiresHuman?.steps ?? []))];
  if (steps.length) lines.push('Human steps:', ...steps.map((step, i) => `${i + 1}. ${step}`));
  return lines.join('\n');
}
