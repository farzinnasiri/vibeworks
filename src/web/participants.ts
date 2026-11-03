import type {Participant,AgentSession} from '../shared/protocol';

/** Actual command target takes precedence; passive reads retain the reported feature focus. */
export function participantFocus(participant:Participant) {
  const session=participant.session;
  const operation=participant.activeWork?.find(o=>o.documentId);
  const target=operation?.documentId?{projectId:operation.projectId,documentId:operation.documentId,featureIds:operation.featureIds}:session?.lastTarget;
  const reported=session?.focus;
  if(!target?.documentId)return reported;
  return {...target,projectId:target.projectId??reported?.projectId,
    featureIds:target.featureIds?.length?target.featureIds:reported?.documentId===target.documentId?reported.featureIds:[]};
}
export function participantState(participant:Participant) {
  if(participant.session?.workState==='completed')return 'Completed';
  if(!participant.connected)return 'Disconnected';
  if(participant.running)return 'Running command';
  if(participant.queued)return 'Queued';
  if(participant.session?.workState==='working')return 'Working (reported)';
  if(participant.session?.workState==='waiting')return 'Waiting (reported)';
  return 'Connected';
}
export function mergeSessions(...groups:AgentSession[][]):AgentSession[] {
  return [...new Map(groups.flat().map(s=>[s.sessionId,s])).values()];
}

/** Shared, fully mixed identity seed. Similar generated IDs must not produce similar marks. */
export function agentVisualSeed(id: string, salt = '') {
  let hash = 2166136261;
  for (const char of `${salt}:${id}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}
/** Identity colors are shared by marks, attribution and highlights; they do not encode work status. */
const AGENT_COLORS = ['#365dc5', '#9460c9', '#16827d', '#b54b86', '#977123', '#52778f',
  '#b45e35', '#6d6abf', '#357f9d', '#9b5070', '#667e34', '#a4744e'];
export function agentColor(agentId: string) {
  return AGENT_COLORS[agentVisualSeed(agentId, 'color') % AGENT_COLORS.length];
}
/** Display form of a generated agent name. Stored identity is unchanged; existing capitals are kept. */
export const agentLabel = (name: string) => name.replaceAll('_', ' ').trim().split(/\s+/)
  .map(word => word && word === word.toLowerCase() ? word[0].toUpperCase() + word.slice(1) : word).join(' ');
export function agentInitials(name: string) {
  const words = agentLabel(name).split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0]?.slice(0, 2) ?? '?').toUpperCase();
}

/** The short state shown in lists. Declared states (from the agent's own report) are marked as such. */
export function participantStatus(participant: Participant): { label: string; tone: 'live' | 'busy' | 'idle' | 'off' | 'done'; declared: boolean } {
  const state = participantState(participant);
  if (state === 'Completed') return { label: 'Reported done', tone: 'done', declared: true };
  if (state === 'Disconnected') return { label: 'Disconnected', tone: 'off', declared: false };
  if (state === 'Running command') return { label: participant.running > 1 ? `Running ${participant.running} commands` : 'Running a command', tone: 'busy', declared: false };
  if (state === 'Queued') return { label: 'Queued', tone: 'busy', declared: false };
  if (state === 'Working (reported)') return { label: 'Reported working', tone: 'live', declared: true };
  if (state === 'Waiting (reported)') return { label: 'Reported waiting', tone: 'idle', declared: true };
  return { label: 'Connected', tone: 'idle', declared: false };
}

const commandNames: Record<string, string> = {
  apply_edits: 'edit', select_features: 'selection', inspect_model: 'inspection', analyze_model: 'analysis',
  documents: 'document request', render_views: 'render', render_image: 'image render', export_model: 'export',
  document_action: 'document action', workspace_view: 'workspace view', describe: 'description', activity: 'activity read',
};
export const commandName = (operation: string) => commandNames[operation] ?? operation.replaceAll('_', ' ');

export type AgentTone = 'busy' | 'live' | 'idle' | 'waiting' | 'off' | 'done' | 'attention' | 'error';
export interface AgentActivity {
  label: string; tone: AgentTone;
  /** True when the label repeats the agent's own report rather than an observed command or contact. */
  reported: boolean;
  /** Start of the observed queued/running command, for elapsed time. */
  since?: string;
}

/**
 * One status from the evidence the bridge actually records: queued/running commands first, then the last
 * command outcome and contact, then the agent's own report. No inactivity timeout: a long exact command keeps
 * reporting Running with its elapsed time, and silence never becomes "blocked" or "idle" by itself.
 */
export function agentActivity(participant: Participant): AgentActivity {
  const session = participant.session, last = participant.lastAction;
  const running = participant.activeWork?.filter(o => o.status === 'running') ?? [];
  const queued = participant.activeWork?.filter(o => o.status === 'queued') ?? [];
  const earliest = (list: { startedAt: string }[]) => list.map(o => o.startedAt).sort()[0];
  if (participant.running > 0) return {
    label: participant.running > 1 ? `Running ${participant.running} commands` : `Running ${running[0] ? commandName(running[0].operation) : 'a command'}`,
    tone: 'busy', reported: false, since: earliest(running),
  };
  if (participant.queued > 0) return { label: participant.queued > 1 ? `${participant.queued} commands queued` : 'Command queued', tone: 'busy', reported: false, since: earliest(queued) };
  if (session?.workState === 'completed') return { label: 'Reported done', tone: 'done', reported: true };
  if (!participant.connected) return { label: session?.endedAt ? 'Left' : 'Disconnected', tone: 'off', reported: false };
  if (last?.status === 'error') return { label: 'Last command failed', tone: 'error', reported: false };
  if (last?.status === 'unknown') return { label: 'Outcome unknown', tone: 'attention', reported: false };
  if (session?.workState === 'working') return { label: 'Reported working', tone: 'live', reported: true };
  if (session?.workState === 'waiting') return { label: 'Reported waiting', tone: 'waiting', reported: true };
  return { label: 'Connected', tone: 'idle', reported: false };
}

const at = (iso?: string) => iso ? Date.parse(iso) : Number.NaN;
/** "just now", "45 s ago", "3 min ago", "2 h ago", then a date. */
export function relativeTime(iso: string | undefined, now = Date.now()) {
  const ms = now - at(iso);
  if (!Number.isFinite(ms)) return 'unknown time';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(at(iso)).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
/** Elapsed time of an observed command: "12 s", "3 min 4 s", "1 h 2 min". */
export function elapsed(iso: string | undefined, now = Date.now()) {
  const ms = now - at(iso);
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min`;
}

/**
 * Drops a leading "Project prefix |" segment that repeats the project's own name, for display only.
 * Stored document names are unchanged; callers keep the full name in a title or accessible label.
 */
export function shortDocumentName(name: string | undefined, projectName?: string) {
  if (!name) return 'Untitled';
  const parts = name.split('|');
  if (parts.length < 2) return name;
  const prefix = parts[0].trim().toLowerCase(), project = (projectName ?? '').toLowerCase();
  const projectPrefix = project.split('|')[0].trim();
  const rest = parts.slice(1).join('|').trim();
  return rest && prefix && (!projectName || project.startsWith(prefix) || projectPrefix === prefix) ? rest : name;
}
