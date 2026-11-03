import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/bridge/sqlite-store';
import { emptyDocument } from '../src/cad/document';
import { parseCommand } from '../src/shared/protocol';

const present=(documentId:string,extra={})=>{
  const command=parseCommand({type:'workspace_view',params:{action:'present',documentId,state:{panes:[{view:'top'}]},...extra}});
  assert.equal(command.type,'workspace_view');
  return command.params as Extract<typeof command,{type:'workspace_view'}>['params'];
};
test('saved presentation is not applied until its viewer acknowledges; model and undo remain unchanged',async()=>{
  const store=new SqliteStore(':memory:');
  try{
    const doc=emptyDocument();await store.put(doc);
    const before=await store.read(doc.documentId),views=store.workspaceViews,viewer=randomUUID(),session=randomUUID();
    const saved=views.command(present(doc.documentId));assert.equal(saved.request!.status,'saved');
    const received=views.poll(viewer,session);assert.equal(received.request!.requestId,saved.request!.requestId);assert.equal(received.request!.status,'pending');
    assert.throws(()=>views.acknowledge(viewer,randomUUID(),saved.request!.requestId,'applied'),{code:'VIEWER_SESSION_MISMATCH'});
    const applied=views.acknowledge(viewer,session,saved.request!.requestId,'applied');assert.ok(applied.request!.appliedAt);
    assert.equal(views.poll(viewer,session).request,undefined);
    assert.deepEqual(await store.read(doc.documentId),before);
  }finally{store.close();}
});
test('presentation resolves viewers explicitly, preserves request identity, rejects stale models and supersedes pending views',async()=>{
  const store=new SqliteStore(':memory:');
  try{
    const doc=emptyDocument();await store.put(doc);const views=store.workspaceViews;
    const first=randomUUID(),second=randomUUID();views.poll(first,randomUUID());views.poll(second,randomUUID());
    assert.throws(()=>views.command(present(doc.documentId)),{code:'VIEWER_REQUIRED'});
    assert.throws(()=>views.command(present(doc.documentId,{viewerId:first,expectedRevision:1})),{code:'REVISION_CONFLICT'});
    const requestId=randomUUID(),input=present(doc.documentId,{viewerId:first,requestId});
    const saved=views.command(input);assert.equal(views.command(input).request!.requestId,requestId);
    assert.throws(()=>views.command(present(doc.documentId,{viewerId:second,requestId})),{code:'REQUEST_ID_CONFLICT'});
    views.command(present(doc.documentId,{viewerId:first}));
    assert.equal(views.command({action:'status',requestId:saved.request!.requestId}).request!.status,'cancelled');
    assert.throws(()=>views.command(present(doc.documentId,{viewerId:first,state:{selection:['missing']}})),{code:'FEATURE_NOT_FOUND'});
  }finally{store.close();}
});
test('offline prepared views survive reopening but an interrupted acknowledgment is never reported as applied',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cad-workspace-views-')),path=join(dir,'workspace.db');let store=new SqliteStore(path);
  try{
    const doc=emptyDocument();await store.put(doc);const saved=store.workspaceViews.command(present(doc.documentId));store.close();
    store=new SqliteStore(path);assert.equal(store.workspaceViews.command({action:'status',requestId:saved.request!.requestId}).request!.status,'saved');
    store.workspaceViews.poll(randomUUID(),randomUUID());store.close();store=new SqliteStore(path);
    const interrupted=store.workspaceViews.command({action:'status',requestId:saved.request!.requestId}).request!;
    assert.equal(interrupted.status,'error');assert.match(interrupted.error!,/unverified/);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
