import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CadError } from '../cad/document';
import {
  type CadCommand, type CadResult, type AgentIdentity, type AgentSession, type Participant,
  type ActivityOperation, type OperationContext, type OperationIntent, type RejectedAttempt, type CadDocument,
} from '../shared/protocol';

export const SESSION_LEASE_MS = 45_000;
const adjectives = ['amber','bright','calm','clever','copper','daring','gentle','golden','keen','lucid','mellow','nimble','quiet','rapid','silver','steady'];
const nouns = ['badger','crane','falcon','finch','fox','heron','ibis','kite','lynx','otter','owl','panda','raven','robin','swift','wren'];
const iso = (time = Date.now()) => new Date(time).toISOString();
const json = <T>(row: any): T => JSON.parse(row.body);
type SessionCommand = Extract<CadCommand, {type:'agent_session'}>['params'];

/** Workspace identity and an attributed work ledger. All model commit hooks use the owning SQLite transaction. */
export class Collaboration {
  constructor(private db: DatabaseSync, private now = Date.now, private workspace?: () => CadDocument[]) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_sessions(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), lease_until INTEGER NOT NULL, ended_at INTEGER, body TEXT NOT NULL, owner_pid INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_agent ON agent_sessions(agent_id,lease_until);
      CREATE TABLE IF NOT EXISTS agent_projects(agent_id TEXT NOT NULL REFERENCES agents(id), project_id TEXT NOT NULL, PRIMARY KEY(agent_id,project_id));
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, agent_id TEXT, session_id TEXT, kind TEXT NOT NULL, project_id TEXT, document_id TEXT, status TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL, owner_pid INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS operations_scope ON operations(project_id,sequence);
      CREATE INDEX IF NOT EXISTS operations_agent ON operations(agent_id,sequence);
      CREATE TABLE IF NOT EXISTS operation_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL REFERENCES operations(id), status TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revision_context(document_id TEXT NOT NULL, version INTEGER NOT NULL, operation_id TEXT NOT NULL REFERENCES operations(id), session_id TEXT, sources TEXT NOT NULL, snapshot_id TEXT, PRIMARY KEY(document_id,version));
    `);
    for(const row of db.prepare('SELECT * FROM agent_sessions WHERE ended_at IS NULL').all()){
      let alive=true;try{process.kill(Number(row.owner_pid),0);}catch{alive=false;}
      if(!alive){const session=json<AgentSession>(row);session.endedAt=iso(this.now());this.saveSession(session);}
    }
    // A restarted authority cannot certify the outcome of an interrupted request. Existing commit links remain intact.
    const pending = db.prepare("SELECT * FROM operations WHERE status IN ('queued','running')").all();
    for (const row of pending) {
      let alive=true;try{process.kill(Number(row.owner_pid),0);}catch{alive=false;}
      if(!alive)this.change(String(row.id), {status:'unknown',completedAt:iso(this.now()),error:{code:'AUTHORITY_RESTARTED',message:'Authority restarted before delivery. Inspect linked committed versions before retrying.'}});
    }
    // Import only facts that legacy storage actually recorded. Do not invent an author, operation or rationale.
    const legacy = db.prepare(`SELECT c.sequence,c.document_id,c.project_id,c.version,r.revision,r.updated_at FROM changes c JOIN revisions r ON r.document_id=c.document_id AND r.version=c.version LEFT JOIN revision_context x ON x.document_id=c.document_id AND x.version=c.version WHERE x.document_id IS NULL`).all();
    for (const row of legacy) {
      const id = 'legacy-' + row.sequence;
      if (db.prepare('SELECT 1 FROM operations WHERE id=?').get(id)) continue;
      const operation: ActivityOperation = {operationId:randomUUID(),sequence:0,kind:'system',operation:'legacy_revision',projectId:String(row.project_id),documentId:String(row.document_id),featureIds:[],status:'success',startedAt:String(row.updated_at),completedAt:String(row.updated_at),toVersion:Number(row.version),revision:Number(row.revision),commitSequence:Number(row.sequence)};
      // The deterministic marker prevents reimport while the public operation identity remains a UUID.
      db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,null,null,'system',row.project_id,row.document_id,'success',0,JSON.stringify(operation),process.pid);
      this.change(id,{});
    }
  }
  private transaction<T>(fn:()=>T):T {
    this.db.exec('BEGIN IMMEDIATE');
    try {const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  private identity(idOrName: string): AgentIdentity {
    const row=this.db.prepare('SELECT body FROM agents WHERE id=? OR name=? COLLATE NOCASE').get(idOrName,idOrName);
    if(!row)throw new CadError('AGENT_NOT_FOUND','No participant has that UUID or name.');
    return json(row);
  }
  private saveSession(session: AgentSession) {
    session.projectIds=session.projectIds.filter(id=>!!this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(id));
    this.db.prepare('INSERT INTO agent_sessions VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET lease_until=excluded.lease_until,ended_at=excluded.ended_at,body=excluded.body').run(session.sessionId,session.agentId,Date.parse(session.leaseUntil),session.endedAt?Date.parse(session.endedAt):null,JSON.stringify(session),process.pid);
    for(const project of session.projectIds){if(!this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(project))throw new CadError('PROJECT_NOT_FOUND','Project is not in this workspace.');this.db.prepare('INSERT OR IGNORE INTO agent_projects VALUES(?,?)').run(session.agentId,project);}
  }
  require(sessionId?: string): AgentSession {
    if(!sessionId)throw new CadError('AGENT_SESSION_REQUIRED','Join with agent_session {action:"join",client:"codex"} first. MCP binds the session; CLI passes --session or VIBEWORKS_AGENT_SESSION.');
    const row=this.db.prepare('SELECT * FROM agent_sessions WHERE id=?').get(sessionId);
    if(!row || row.ended_at || Number(row.lease_until)<=this.now())throw new CadError('AGENT_SESSION_EXPIRED','Session ended or expired. Resume the participant with agent_session {action:"resume",agent:"name",client:"codex"}.');
    return json(row);
  }
  /** Called inside the document transaction too, so a displaced/ended session cannot commit late. */
  validate(context?: OperationContext) {if(context?.sessionId)this.require(context.sessionId);}
  command(params: SessionCommand, sessionId?: string): {agent:AgentIdentity;session:AgentSession} {
    return this.transaction(()=>{
      let agent:AgentIdentity, session:AgentSession, continuing:AgentSession|undefined;
      if(params.action==='join' || params.action==='resume') {
        if(!params.client)throw new CadError('INVALID_ARGUMENT','client is required when joining or resuming.');
        if(params.action==='resume') {
          if(!params.agent)throw new CadError('INVALID_ARGUMENT','agent name or UUID is required to resume.');
          agent=this.identity(params.agent);
          const active=this.db.prepare('SELECT body FROM agent_sessions WHERE agent_id=? AND ended_at IS NULL AND lease_until>?').get(agent.agentId,this.now());
          if(active){
            const own=json<AgentSession>(active);
            if(sessionId===own.sessionId || params.clientInstanceId && params.clientInstanceId===own.clientInstanceId)continuing=own;
            else throw new CadError('AGENT_ACTIVE','This identity belongs to another active session. Reuse your existing sessionId for update/heartbeat, or resume from its original adapter. A different agent must join with continuedFrom.');
          }
        } else {
          const name=this.name(params.kind??'agent');
          agent={agentId:randomUUID(),name,kind:params.kind??'agent',createdAt:iso(this.now()),...(params.continuedFrom?{continuedFrom:this.identity(params.continuedFrom).agentId}:{})};
          this.db.prepare('INSERT INTO agents VALUES(?,?,?)').run(agent.agentId,agent.name,JSON.stringify(agent));
        }
        const previous=params.action==='resume'?this.db.prepare('SELECT body FROM agent_sessions WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(agent.agentId):undefined;
        if(params.action==='resume'&&!continuing){
          for(const row of this.db.prepare('SELECT body FROM agent_sessions WHERE agent_id=? AND ended_at IS NULL').all(agent.agentId)){const old=json<AgentSession>(row);old.endedAt=iso(this.now());this.saveSession(old);}
        }
        session=continuing??{...(previous?{handoff:json<AgentSession>(previous).handoff}:{}),sessionId:randomUUID(),agentId:agent.agentId,client:params.client,projectIds:params.projectIds??[],startedAt:iso(this.now()),lastSeenAt:iso(this.now()),leaseUntil:iso(this.now()+SESSION_LEASE_MS)};
      } else {
        if(params.action==='heartbeat'&&sessionId){
          const row=this.db.prepare('SELECT * FROM agent_sessions WHERE id=?').get(sessionId);
          if(row&&!row.ended_at&&!this.db.prepare('SELECT 1 FROM agent_sessions WHERE agent_id=? AND id<>? AND ended_at IS NULL AND lease_until>?').get(row.agent_id,sessionId,this.now()))session=json(row);else session=this.require(sessionId);
        }else session=this.require(sessionId);
        agent=this.identity(session.agentId);
      }
      for(const key of ['model','role','task','focus','handoff','parentAgentId','clientInstanceId','phase','workState'] as const)if(params[key]!==undefined)(session as any)[key]=params[key];
      if(params.parentAgentId){this.identity(params.parentAgentId);if(params.parentAgentId===agent.agentId)throw new CadError('INVALID_PARENT','An agent cannot coordinate itself.');}
      if(params.action==='handoff'&&!params.handoff)throw new CadError('INVALID_ARGUMENT','A concise handoff is required.');
      if(params.projectIds){for(const project of params.projectIds)if(!this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(project))throw new CadError('PROJECT_NOT_FOUND','Project is not in this workspace.');session.projectIds=params.projectIds;}
      if(params.focus){
        delete session.lastTarget;
        const focus=params.focus;
        if(focus.documentId){const doc=this.db.prepare('SELECT project_id,body FROM documents WHERE id=?').get(focus.documentId);if(!doc||doc.project_id!==focus.projectId)throw new CadError('INVALID_FOCUS','Focus document must belong to the selected project.');const ids=new Set(JSON.parse(String(doc.body)).features.map((f:any)=>f.id));if(focus.featureIds?.some(id=>!ids.has(id)))throw new CadError('FEATURE_NOT_FOUND','A focused feature no longer exists.');}
        session.projectIds=[...new Set([...session.projectIds,focus.projectId])];
      }
      session.lastSeenAt=iso(this.now());session.leaseUntil=iso(this.now()+SESSION_LEASE_MS);
      if(params.action==='leave')session.endedAt=iso(this.now());
      this.saveSession(session);
      if(params.action==='handoff'){
        const operation:ActivityOperation={operationId:randomUUID(),sequence:0,agentId:agent.agentId,sessionId:session.sessionId,kind:agent.kind,operation:'handoff',projectId:session.focus?.projectId,documentId:session.focus?.documentId,featureIds:session.focus?.featureIds??[],status:'success',startedAt:iso(this.now()),completedAt:iso(this.now()),handoff:params.handoff};
        this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?)').run(operation.operationId,agent.agentId,session.sessionId,agent.kind,operation.projectId??null,operation.documentId??null,'success',0,JSON.stringify(operation),process.pid);this.change(operation.operationId,{});
      }
      return {agent,session};
    });
  }
  private name(kind: 'agent'|'human') {
    for(let attempt=0;attempt<32;attempt++){
      const name=(kind==='human'?'you':adjectives[Math.floor(Math.random()*adjectives.length)])+'_'+nouns[Math.floor(Math.random()*nouns.length)]+(attempt>15?'_'+randomUUID().slice(0,4):'');
      if(!this.db.prepare('SELECT 1 FROM agents WHERE name=? COLLATE NOCASE').get(name))return name;
    }
    return 'agent_'+randomUUID().slice(0,12);
  }
  actor(sessionId:string){const row=this.db.prepare('SELECT body FROM agent_sessions WHERE id=?').get(sessionId);if(!row)throw new CadError('AGENT_SESSION_EXPIRED','Unknown session.');const s=json<AgentSession>(row);return {agentId:s.agentId,sessionId:s.sessionId,...(s.clientInstanceId?{clientInstanceId:s.clientInstanceId}:{})};}
  reject(attempt:RejectedAttempt){
    return this.transaction(()=>{
      const session=this.require(attempt.sessionId),agent=this.identity(session.agentId);if(this.db.prepare('SELECT 1 FROM operations WHERE id=?').get(attempt.requestId))return this.actor(attempt.sessionId);
      const target=attempt.documentId?this.db.prepare('SELECT project_id FROM documents WHERE id=?').get(attempt.documentId):undefined;
      const projectId=target?String(target.project_id):session.focus?.projectId??session.lastTarget?.projectId??session.projectIds[0];
      const operation:ActivityOperation={operationId:attempt.requestId,sequence:0,agentId:agent.agentId,sessionId:session.sessionId,kind:agent.kind,operation:attempt.operation,projectId,documentId:attempt.documentId,featureIds:[],status:'error',startedAt:iso(this.now()),completedAt:iso(this.now()),error:{code:attempt.code,message:attempt.message},validationFields:attempt.fields};
      this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?)').run(operation.operationId,agent.agentId,session.sessionId,agent.kind,projectId??null,attempt.documentId??null,'error',0,JSON.stringify(operation),process.pid);this.change(operation.operationId,{});return this.actor(session.sessionId);
    });
  }
  begin(operationId: string, sessionId: string, command: CadCommand, intent?: OperationIntent): OperationContext {
    return this.transaction(()=>{
      const session=this.require(sessionId),agent=this.identity(session.agentId),p=command.params as any;
      const documentId=p.documentId,doc=documentId?this.db.prepare('SELECT project_id FROM documents WHERE id=?').get(documentId):undefined;
      const projectId=doc?String(doc.project_id):p.projectId;
      const featureIds:string[]=p.featureIds??(p.featureId?[p.featureId]:p.edits?.flatMap((e:any)=>e.feature?[e.feature.id]:e.id?[e.id]:[])??[]);
      const operation:ActivityOperation={operationId,sequence:0,agentId:agent.agentId,sessionId,kind:agent.kind,operation:command.type,...(p.action?{action:p.action}:{}),projectId,documentId,featureIds:[...new Set(featureIds)],status:'queued',startedAt:iso(this.now()),...(intent?{intent}:{})};
      this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?)').run(operationId,agent.agentId,sessionId,agent.kind,projectId??null,documentId??null,'queued',0,JSON.stringify(operation),process.pid);
      if(projectId){session.projectIds=[...new Set([...session.projectIds,projectId])];session.lastTarget={projectId,...(documentId?{documentId,featureIds:operation.featureIds}:{})};}
      session.lastSeenAt=iso(this.now());session.leaseUntil=iso(this.now()+120_000);this.saveSession(session);
      this.change(operationId,{});return {operationId,sessionId,kind:agent.kind,...(intent?{intent}:{})};
    });
  }
  start(id:string){this.transaction(()=>this.change(id,{status:'running'}));}
  private change(id:string,patch:Partial<ActivityOperation>) {
    const row=this.db.prepare('SELECT body FROM operations WHERE id=?').get(id);if(!row)return;
    const op={...json<ActivityOperation>(row),...patch};
    const sequence=Number(this.db.prepare('INSERT INTO operation_events(operation_id,status,at) VALUES(?,?,?)').run(id,op.status,iso(this.now())).lastInsertRowid);
    op.sequence=sequence;
    this.db.prepare('UPDATE operations SET status=?,sequence=?,project_id=?,document_id=?,body=? WHERE id=?').run(op.status,sequence,op.projectId??null,op.documentId??null,JSON.stringify(op),id);
  }
  /** Same transaction as document, revision, undo and change-feed writes. */
  committed(context:OperationContext|undefined,documentId:string,projectId:string,fromVersion:number|undefined,toVersion:number,revision:number,commitSequence:number,sources:Record<string,number>,snapshotId?:string) {
    if(!context)return;
    this.validate(context);
    this.db.prepare('INSERT INTO revision_context VALUES(?,?,?,?,?,?)').run(documentId,toVersion,context.operationId,context.sessionId??null,JSON.stringify(sources),snapshotId??null);
    this.committedEvent(context,documentId,projectId,fromVersion,toVersion,commitSequence,{revision,snapshotId});
  }
  committedEvent(context:OperationContext|undefined,documentId:string|undefined,projectId:string,fromVersion:number|undefined,toVersion:number,commitSequence:number,extra:Partial<ActivityOperation>={}) {
    if(!context)return;
    const affected=new Set(documentId?[documentId]:[]),projects=new Set([projectId]);
    const docs=this.workspace?this.workspace().map(document=>({id:document.documentId,project:String(document.projectId),document})):this.db.prepare('SELECT id,project_id,body FROM documents').all().map(row=>({id:String(row.id),project:String(row.project_id),document:JSON.parse(String(row.body))}));
    let changed=true;while(changed){changed=false;for(const row of docs)if(!affected.has(row.id)&&row.document.features.some((f:any)=>f.kind==='instance'&&affected.has(f.params.document))){affected.add(row.id);projects.add(row.project);changed=true;}}
    const op=this.db.prepare('SELECT agent_id,body FROM operations WHERE id=?').get(context.operationId);
    if(op){const previous=json<ActivityOperation>(op);if(previous.projectId)projects.add(previous.projectId);}
    for(const project of projects)if(op?.agent_id)this.db.prepare('INSERT OR IGNORE INTO agent_projects VALUES(?,?)').run(op.agent_id,project);
    this.change(context.operationId,{documentId,projectId,fromVersion,toVersion,commitSequence,affectedDocumentIds:[...affected],affectedProjectIds:[...projects],...extra});
  }
  finish(id:string,result:CadResult) {
    this.transaction(()=>{
      const row=this.db.prepare('SELECT body FROM operations WHERE id=?').get(id);if(!row)return;
      const op=json<ActivityOperation>(row);
      const implicitDocument=op.operation!=='documents'||['create','duplicate'].includes(op.action??'');
      const documentId=op.documentId??(implicitDocument?result.documentId:undefined);
      const target=documentId?this.db.prepare('SELECT project_id FROM documents WHERE id=?').get(documentId):undefined;
      const projectId=op.projectId??(target?String(target.project_id):undefined);
      if(op.agentId&&projectId)this.db.prepare('INSERT OR IGNORE INTO agent_projects VALUES(?,?)').run(op.agentId,projectId);
      this.change(id,{documentId,projectId,status:result.status==='success'?'success':result.error?.outcomeUnknown?'unknown':'error',completedAt:iso(this.now()),...(result.error?{error:{code:result.error.code,message:result.error.message}}:{})});
    });
  }
  disconnect(){this.transaction(()=>{
    for(const row of this.db.prepare('SELECT body FROM agent_sessions WHERE ended_at IS NULL AND owner_pid=?').all(process.pid)){const session=json<AgentSession>(row);session.endedAt=iso(this.now());this.saveSession(session);}
  });}
  query(params:Extract<CadCommand,{type:'activity'}>['params']):{participants:Participant[];operations:ActivityOperation[];sessions:AgentSession[];cursor:number} {
    const filters:string[]=[],values:any[]=[];
    for(const [key,column,affected]of [['projectId','project_id','affectedProjectIds'],['documentId','document_id','affectedDocumentIds'],['agentId','agent_id',undefined]] as const)if(params[key]){
      filters.push(affected?`(${column}=? OR EXISTS(SELECT 1 FROM json_each(operations.body,'$.${affected}') WHERE value=?))`:column+'=?');values.push(params[key]);if(affected)values.push(params[key]);
    }
    if(params.after!==undefined){filters.push('sequence>?');values.push(params.after);}
    if(params.before!==undefined){filters.push('sequence<?');values.push(params.before);}
    if(params.changesOnly)filters.push("json_extract(body,'$.toVersion') IS NOT NULL");
    const where=filters.length?' WHERE '+filters.join(' AND '):'';
    const rows=this.db.prepare('SELECT body FROM operations'+where+' ORDER BY sequence '+(params.after!==undefined?'ASC':'DESC')+' LIMIT ?').all(...values,params.limit??50);
    const operations=rows.map(row=>json<ActivityOperation>(row));if(params.after===undefined)operations.reverse();
    const participants=this.db.prepare('SELECT body FROM agents'+(params.projectId?' WHERE id IN (SELECT agent_id FROM agent_projects WHERE project_id=?)':'')+' ORDER BY name').all(...(params.projectId?[params.projectId]:[])).map(row=>{
      const identity=json<AgentIdentity>(row),record=this.db.prepare('SELECT * FROM agent_sessions WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(identity.agentId);
      const session=record?json<AgentSession>(record):undefined,connected=!!record&&!record.ended_at&&Number(record.lease_until)>this.now();
      const count=(status:string)=>Number(this.db.prepare('SELECT COUNT(*) AS n FROM operations WHERE agent_id=? AND status=?').get(identity.agentId,status)!.n);
      const activeWork=connected?this.db.prepare("SELECT body FROM operations WHERE agent_id=? AND status IN ('queued','running') ORDER BY sequence LIMIT 32").all(identity.agentId).map(row=>{const o=json<ActivityOperation>(row);return {operationId:o.operationId,operation:o.operation,documentId:o.documentId,projectId:o.projectId,featureIds:o.featureIds,status:o.status as 'queued'|'running',startedAt:o.startedAt};}):[];
      const latest=this.db.prepare('SELECT body FROM operations WHERE agent_id=? ORDER BY sequence DESC LIMIT 1').get(identity.agentId);
      return {identity,session,connected,activeWork,...(latest?{lastAction:json<ActivityOperation>(latest)}:{}),running:connected?count('running'):0,queued:connected?count('queued'):0};
    }).filter(p=>!params.agentId||p.identity.agentId===params.agentId);
    const sessions=[...new Set(operations.flatMap(o=>o.sessionId?[o.sessionId]:[]))].map(id=>this.db.prepare('SELECT body FROM agent_sessions WHERE id=?').get(id)).filter(Boolean).map(row=>json<AgentSession>(row));
    return {participants,operations,sessions,cursor:operations.at(-1)?.sequence??params.after??0};
  }
}
