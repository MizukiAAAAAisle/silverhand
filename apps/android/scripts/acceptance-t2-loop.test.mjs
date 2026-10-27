// Actual T2 run/AcceptanceRecord failure dispatch. UI/API values are controlled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runT2, T2_CASES } from './acceptance-t2.mjs';
import { runB3 } from './acceptance-b3.mjs';
import { AcceptanceRecord } from './acceptance-record.mjs';
for (const at of ['pre','create']) test('real T2 loop preserves first and blocks later cases: '+at, async()=>{
 const out=mkdtempSync(join(tmpdir(),'t2-loop-'));const first=Error('controlled '+at), record=new AcceptanceRecord(out,['PRE.T2.fixture-login',...T2_CASES]);
 writeFileSync(out+'/t2-observer-private.json',JSON.stringify({version:1,unit:'task-write',active:false}),{mode:0o600});
 writeFileSync(out+'/t2-events.jsonl',JSON.stringify({seq:1,event:'observer_start'})+'\n');
 const calls=[];const ctx={out,token:'private-test',fixture:{userId:'A'},
 c:{evaluate:async x=>x==='STATE'?{route:'#/tasks',boardCount:1,columns:[]}:{ready:true,selector:'button'}},
 call:async()=>{if(at==='pre')throw first;return {me:{status:200,bodyText:'{"id":"A"}'}};},
 api:async path=>path==='/api/workspaces'?{id:'W',name:'W'}:path.endsWith('/channels')?{id:'C',title:'C'}:path.endsWith('/members')?{human_members:[{user_id:'A'}],members:[{kind:'human',user_id:'A'}]}:{id:'C',status:'idle',closed_at:null,archived_at:null},
 input:async()=>{},adb:()=>'',step:(...args)=>record.step(...args),observe:(...args)=>{calls.push(args);if(args[0]==='t2-residue')throw Error('secondary residue writer');}};
 const h={taskStateExpression:()=> 'STATE',clickTaskFilterControl:async()=>{},taskOptionTarget:()=>{},
 searchClick:async(_c,_o,_s,_t,name)=>{calls.push(name);if(name==='t2-new')throw first;}};
 try {await assert.rejects(at==='pre'?runB3({...ctx,unit:'task-write'}):runT2(ctx,h),e=>e===first);record.fail(first);const counts=JSON.parse(readFileSync(out+'/counts.json'));assert.equal(counts.groups.PRE.failed,at==='pre'?1:0);assert.equal(counts.groups.B3.failed,at==='create'?1:0);assert.equal(counts.groups.B3.not_executed,at==='pre'?4:3);assert(!calls.includes('t2-status-open'));assert.equal(record.data.first_error.message,String(first));}
 finally{rmSync(out,{recursive:true,force:true});}
});
