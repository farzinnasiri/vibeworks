import test from 'node:test';
import assert from 'node:assert/strict';
import {ManualHistory} from '../src/web/manual-history';
import type {CadCommand,CadResult} from '../src/shared/protocol';
const edit={type:'apply_edits',params:{}} as CadCommand;
const result=(documentId:string,revision=1,storageVersion=2):CadResult=>({operation:'apply_edits',status:'success',documentId,revision,storageVersion,created:[],updated:[],warnings:[]});
test('manual undo follows source color edits after returning to an assembly; redo preserves the source target',()=>{
 const history=new ManualHistory();history.record(edit,result('assembly'),'Machine');history.record(edit,result('source'),'Frame');
 assert.equal(history.target('undo')?.documentId,'source');history.moved('undo',result('source',2,3));
 assert.equal(history.target('undo')?.documentId,'assembly');assert.equal(history.target('redo')?.documentId,'source');
 history.moved('redo',result('source',3,4));assert.equal(history.target('undo')?.documentId,'source');
});
test('external changes block undo and repeated local undos follow advancing storage guards',()=>{
 const history=new ManualHistory();history.record(edit,result('source'),'Frame');history.record(edit,result('source',2,3),'Frame');
 assert.equal(history.matches(history.target('undo')!,result('source',3,4)),false);
 history.moved('undo',result('source',3,4));assert.equal(history.matches(history.target('undo')!,result('source',3,4)),true);
});
test('dry runs, failures and reads do not consume manual history; a fresh edit clears redo',()=>{
 const history=new ManualHistory();history.record(edit,{...result('source'),dryRun:true},'Frame');history.record({type:'inspect_model',params:{}},result('source'),'Frame');assert.equal(history.target('undo'),undefined);
 history.record(edit,result('source'),'Frame');history.moved('undo',result('source',2,3));history.record(edit,result('other'),'Other');assert.equal(history.target('redo'),undefined);
});
