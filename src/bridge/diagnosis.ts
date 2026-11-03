import { commandError, type BridgeEvent, type CommandFailure, type ConnectionDiagnosis } from '../shared/protocol.ts';

/** Preserve distinct causes, merging recovery steps when the same cause arrives twice. */
export function deduplicateIssues(issues: CommandFailure[]): CommandFailure[] {
  const unique = new Map<string, CommandFailure>();
  for (const issue of issues) {
    const key = JSON.stringify([issue.code, issue.message]), previous = unique.get(key);
    const requiresHuman = previous?.requiresHuman ?? issue.requiresHuman;
    unique.set(key, {
      ...issue, ...previous,
      ...(requiresHuman ? { requiresHuman: { ...requiresHuman, steps: [...new Set([
        ...(previous?.requiresHuman?.steps ?? []), ...(issue.requiresHuman?.steps ?? []),
      ])] } } : {}),
    });
  }
  return [...unique.values()];
}

/** Hashes identify differences, not chronological age. Compare each loaded copy to disk. */
export function versionIssues(fingerprints: ConnectionDiagnosis['fingerprints']): CommandFailure[] {
  const current = fingerprints.workspace ?? fingerprints.bridge;
  if (!current) return [];
  const processes = [
    ['bridge', 'The bridge contract differs from this checkout. Wait for the supplied human steps, then inspect_model.', 'Restart make dev in this checkout.'],
    ['browser', 'The browser tab contract differs from this checkout. Wait for the supplied human steps, then inspect_model.', 'Reload the intended browser tab. If serving a production bundle, rebuild it first.'],
    ['adapter', "Your agent's MCP server or CLI contract differs from this checkout. Wait for the supplied human steps, then inspect_model.", "Restart the agent session or its MCP server from this checkout; rerun the CLI command if using the CLI."],
  ] as const;
  return processes.flatMap(([key, message, step]) => fingerprints[key] !== undefined && fingerprints[key] !== current
    ? [{ code: 'VERSION_SKEW', message, requiresHuman: { reason: `${key} loaded a different shared contract.`, steps: [step] } }]
    : []);
}

export function diagnosisError(diagnosis: ConnectionDiagnosis): CommandFailure | undefined {
  diagnosis = { ...diagnosis, issues: deduplicateIssues(diagnosis.issues) };
  if (!diagnosis.issues.length) return undefined;
  const first = diagnosis.issues[0];
  const steps = [...new Set(diagnosis.issues.flatMap(issue => issue.requiresHuman?.steps ?? []))];
  return { ...first, message: diagnosis.issues.map(issue => issue.message).join(' '), details: { diagnosis },
    ...(steps.length ? { requiresHuman: { reason: 'A person must restore the local connection.', steps } } : {}) };
}

function disconnectedIssue(): CommandFailure {
  return commandError('inspect_model', 'BROWSER_DISCONNECTED', 'No browser is connected. Wait for the human steps, then call inspect_model before editing.').error!;
}

/** A rejected tab is not a controller. Retain its cause only while it is the latest failure. */
export function connectionIssues(fingerprints: ConnectionDiagnosis['fingerprints'], browserConnected: boolean | null, lastRejection?: BridgeEvent, lastDisconnect?: BridgeEvent): CommandFailure[] {
  const issues = versionIssues(fingerprints);
  if (!browserConnected) {
    if (lastRejection?.requiresHuman && (!lastDisconnect || lastRejection.at > lastDisconnect.at)) {
      issues.push({ code: lastRejection.code, message: lastRejection.message, requiresHuman: lastRejection.requiresHuman });
    }
    issues.push(disconnectedIssue());
  }
  return deduplicateIssues(issues);
}
