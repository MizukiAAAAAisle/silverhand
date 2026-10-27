import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t2Until,t2IndependentTodoRead,runT2,T2_CASES } from './acceptance-t2.mjs';
import { AcceptanceRecord } from './acceptance-record.mjs';
test('actual condition consumer rejects late true/read and enforces unit deadline without real sleep',async()=>{
 for(const [unitDeadline,slow] of [[240000,10000],[5000,5000],[240000,10001]]){let t=0,accepted=0;await assert.rejects(t2Until('slow',()=>true,async()=>{t+=slow;return true;},{now:()=>t,sleep:async ms=>{t+=ms;},unitDeadline,observe:()=>accepted++}),/bounded/);assert.equal(accepted,0);}
 let t=0,n=0;assert.equal(await t2Until('early',v=>v===2,async()=>++n,{now:()=>t,sleep:async ms=>{t+=ms;},unitDeadline:240000}),2);
 t=0;n=0;await assert.rejects(t2Until('reads',()=>false,async()=>++n,{now:()=>t,sleep:async ms=>{t+=ms;},unitDeadline:240000}));assert.equal(n,100);
});
test('actual independent read consumer needs post-ACK same scope todo exact canonical identity and terminal',()=>{
 const ack={seq:5},target={workspaceId:'W',channelId:'C',task:{id:'T',task_number:7}};
 const base=[{seq:6,event:'request',request:1,method:'GET',path:'/api/tasks/board/column',params:{container:'workspace',workspace_id:'W',channel_id:'C',status:'todo'}},{seq:7,event:'response',request:1,status:200,body:{status:'todo',items:[{id:'T',task_number:7}]}},{seq:8,event:'terminal',request:1}];
 assert(t2IndependentTodoRead(base,ack,target));
 for(const change of [r=>r[0].params.status='done',r=>r[0].params.workspace_id='other',r=>r[0].params.channel_id='other',r=>r[0].seq=4,r=>r[1].body.items=[],r=>r[1].body.items[0].id='other',r=>r[1].body.items[0].task_number=8,r=>r[1].body.items.push({id:'T',task_number:7}),r=>r.pop(),r=>r[2].seq=6,r=>r[1].status=503]){const rows=structuredClone(base);change(rows);assert.equal(t2IndependentTodoRead(rows,ack,target),null);}
 assert.equal(t2IndependentTodoRead([],ack,target),null);
});
for(const at of ['channel','members'])test('actual PRE preserves each committed resource ID after '+at+' failure',async()=>{
 const out=mkdtempSync(join(tmpdir(),'t2-residue-'));const first=Error(at),observed=[];const record=new AcceptanceRecord(out,['PRE.T2.fixture-login',...T2_CASES]);writeFileSync(out+'/t2-observer-private.json','{"version":1,"unit":"task-write","active":false}',{mode:0o600});
 const ctx={out,token:'private',fixture:{userId:'A'},c:{},input:()=>{},adb:()=>'',step:(...a)=>record.step(...a),observe:(name,value)=>observed.push({name,value}),call:async()=>({me:{status:200,bodyText:'{"id":"A"}'}}),api:async path=>{if(path==='/api/workspaces')return{id:'W'};if(path.endsWith('/channels')){if(at==='channel')throw first;return{id:'C'};}throw first;}};
 try{await assert.rejects(runT2(ctx,{}),e=>e===first);const residue=observed.find(x=>x.name==='t2-residue').value;assert.equal(residue.workspaceId,'W');assert.equal(residue.channelId,at==='members'?'C':null);assert.equal(residue.taskId,null);}finally{rmSync(out,{recursive:true,force:true});}
});
