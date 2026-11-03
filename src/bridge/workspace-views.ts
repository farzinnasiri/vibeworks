import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CadError } from '../cad/document';
import { workspaceViewRequestSchema, type CadCommand, type CadDocument, type WorkspaceViewer, type WorkspaceViewRequest } from '../shared/protocol';

type Command = Extract<CadCommand,{type:'workspace_view'}>['params'];
const VIEWER_LEASE_MS = 10_000;

/** Durable view requests, with acknowledgments separate from model storage and revisions. */
export class WorkspaceViews {
  private viewers = new Map<string,WorkspaceViewer & {sessionId:string}>();
  constructor(private db:DatabaseSync, private document:(id:string)=>CadDocument|undefined, private now=Date.now) {
    db.exec('CREATE TABLE IF NOT EXISTS workspace_views(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL, identity TEXT NOT NULL, sequence INTEGER NOT NULL);');
    for(const row of db.prepare('SELECT body FROM workspace_views').all()){
      const request=workspaceViewRequestSchema.parse(JSON.parse(String(row.body)));
      if(request.status==='pending'){
        request.status='error';request.error='Bridge restarted before viewer acknowledgment; display outcome is unverified. Present again.';this.save(request);
      }
    }
  }
  private active() {
    for(const [id,v] of this.viewers)if(this.now()-Date.parse(v.lastSeenAt)>VIEWER_LEASE_MS)this.viewers.delete(id);
    return [...this.viewers.values()].map(({sessionId:_,...v})=>v);
  }
  private read(id:string):WorkspaceViewRequest|undefined {
    const row=this.db.prepare('SELECT body FROM workspace_views WHERE id=?').get(id);
    return row ? workspaceViewRequestSchema.parse(JSON.parse(String(row.body))) : undefined;
  }
  private save(request:WorkspaceViewRequest, identity?:string) {
    if(identity!==undefined){
      const sequence=Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM workspace_views').get()!.n);
      this.db.prepare('INSERT INTO workspace_views VALUES(?,?,?,?,?)').run(request.requestId,request.projectId,JSON.stringify(request),identity,sequence);
      this.db.exec('DELETE FROM workspace_views WHERE id IN (SELECT id FROM workspace_views ORDER BY sequence DESC LIMIT -1 OFFSET 64)');
    } else this.db.prepare('UPDATE workspace_views SET body=? WHERE id=?').run(JSON.stringify(request),request.requestId);
  }
  command(params:Command) {
    const viewers=this.active();
    if(params.action==='get'){
      const row=params.projectId ? this.db.prepare('SELECT body FROM workspace_views WHERE project_id=? ORDER BY sequence DESC LIMIT 1').get(params.projectId)
        : this.db.prepare('SELECT body FROM workspace_views ORDER BY sequence DESC LIMIT 1').get();
      return {viewers,...(row?{request:workspaceViewRequestSchema.parse(JSON.parse(String(row.body)))}:{})};
    }
    if(params.action==='status'||params.action==='cancel'){
      const request=this.read(params.requestId);
      if(!request)throw new CadError('VIEW_REQUEST_NOT_FOUND','This view request is no longer retained.');
      if(params.action==='cancel'){
        if(request.status==='applied')throw new CadError('VIEW_ALREADY_APPLIED','The viewer already applied this view. Present another view to change it.');
        request.status='cancelled';this.save(request);
      }
      return {viewers,request};
    }
    if(params.action!=='present')throw new CadError('INVALID_COMMAND','Unknown workspace view action.');
    const requestId=params.requestId??randomUUID();
    const identity=JSON.stringify({documentId:params.documentId,expectedRevision:params.expectedRevision,viewerId:params.viewerId,state:params.state});
    const previous=this.db.prepare('SELECT identity FROM workspace_views WHERE id=?').get(requestId);
    if(previous){
      if(previous.identity!==identity)throw new CadError('REQUEST_ID_CONFLICT','This requestId belongs to a different prepared view.');
      return {viewers,request:this.read(requestId)!};
    }
    const doc=this.document(params.documentId);
    if(!doc)throw new CadError('DOCUMENT_NOT_FOUND','The presented document does not exist.');
    if(params.expectedRevision!==undefined&&params.expectedRevision!==doc.revision)throw new CadError('REVISION_CONFLICT','The document changed before presentation. Inspect and present its current revision.');
    const ids=new Set(doc.features.map(f=>f.id));
    const requested=[...(params.state.highlight??[]).map(h=>h.feature),...params.state.selection,...(params.state.isolate??[]),...params.state.panes.flatMap(s=>[...(s.hide??[]),...(s.ghost??[]),...(s.frame&&'featureIds'in s.frame?s.frame.featureIds:[])])];
    if(requested.some(id=>!ids.has(id)))throw new CadError('FEATURE_NOT_FOUND','A selected, isolated or framed feature does not exist in this document.');
    if(!params.viewerId&&viewers.length>1)throw new CadError('VIEWER_REQUIRED','Several viewers are open. Use workspace_view get and choose viewerId.');
    const viewerId=params.viewerId??viewers[0]?.viewerId;
    if(viewerId&&!viewers.some(v=>v.viewerId===viewerId))throw new CadError('VIEWER_NOT_FOUND','That viewer is offline. Omit viewerId to save a view for the next viewer.');
    const request:WorkspaceViewRequest={requestId,documentId:doc.documentId,projectId:doc.projectId!,revision:doc.revision,
      state:params.state,createdAt:new Date(this.now()).toISOString(),status:viewerId?'pending':'saved',...(viewerId?{viewerId}:{})};
    for(const row of this.db.prepare('SELECT body FROM workspace_views').all()){
      const old=workspaceViewRequestSchema.parse(JSON.parse(String(row.body)));
      if((old.status==='saved'||old.status==='pending')&&(!old.viewerId||old.viewerId===viewerId)){
        old.status='cancelled';this.save(old);
      }
    }
    this.save(request,identity);
    return {viewers,request};
  }
  poll(viewerId:string,sessionId:string,current:Omit<WorkspaceViewer,'viewerId'|'lastSeenAt'>={}) {
    this.active();
    const prior=this.viewers.get(viewerId);
    if(prior&&prior.sessionId!==sessionId)throw new CadError('VIEWER_SESSION_MISMATCH','This viewer belongs to another browser session.');
    if(!prior&&this.viewers.size>=32)throw new CadError('VIEWER_LIMIT','At most 32 viewers may register.');
    this.viewers.set(viewerId,{...current,viewerId,sessionId,lastSeenAt:new Date(this.now()).toISOString()});
    const rows=this.db.prepare('SELECT body FROM workspace_views ORDER BY sequence DESC').all();
    for(const row of rows){
      const request=workspaceViewRequestSchema.parse(JSON.parse(String(row.body)));
      if(request.status!=='saved'&&request.status!=='pending')continue;
      if(request.viewerId&&request.viewerId!==viewerId)continue;
      if(!request.viewerId){request.viewerId=viewerId;request.status='pending';this.save(request);}
      return {viewers:this.active(),request};
    }
    return {viewers:this.active()};
  }
  acknowledge(viewerId:string,sessionId:string,requestId:string,status:'applied'|'error',error?:string) {
    const viewer=this.viewers.get(viewerId),request=this.read(requestId);
    if(!viewer||viewer.sessionId!==sessionId||request?.viewerId!==viewerId)throw new CadError('VIEWER_SESSION_MISMATCH','Only the receiving viewer may acknowledge a prepared view.');
    if(request.status==='cancelled')throw new CadError('VIEW_CANCELLED','This request was cancelled before acknowledgment.');
    if(request.status==='applied'||request.status==='error'){
      if(request.status===status)return {viewers:this.active(),request};
      throw new CadError('VIEW_ALREADY_APPLIED','This request already has a terminal acknowledgment.');
    }
    request.status=status;
    if(status==='applied')request.appliedAt=new Date(this.now()).toISOString();
    else request.error=error??'The viewer could not apply this view.';
    this.save(request);
    return {viewers:this.active(),request};
  }
}
