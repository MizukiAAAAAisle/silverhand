import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter, once } from 'node:events';
import { TaskWriteObserver, readT2Events, assertT2ZeroWrites } from './t2-observer.mjs';
import { b3ScenarioKey } from './acceptance-b3.mjs';
import { T2_CASES } from './acceptance-t2.mjs';
function setup(options) {
 const dir=mkdtempSync(join(tmpdir(),'t2-memory-')),file=join(dir,'private.json'),events=join(dir,'events.jsonl');
 const spec={version:1,unit:'task-write',active:true,userId:'A',workspaceId:'W',channelId:'C',apiToken:'private-test-token',taskId:null,phase:0,marker:'start'};
 const save=()=>writeFileSync(file,JSON.stringify(spec),{mode:0o600});save();
 const o=new TaskWriteObserver(file,events,options);
 async function frame(method,path,body,status,answer) {
  const req=new PassThrough();Object.assign(req,{method,url:path,headers:{authorization:'Bearer private-test-token'}});
  const res=new EventEmitter();res.writableFinished=false;
  const c=o.attach(req,res);const done=once(req,'end');req.resume();req.end(body===undefined?'':JSON.stringify(body));await done;
  if(c){const reply=new PassThrough();reply.statusCode=status;c.reply(reply);const ended=once(reply,'end');reply.end(typeof answer==='string'?answer:JSON.stringify(answer));await ended;}
  res.writableFinished=true;res.emit('finish');return c;
 }
 return{spec,save,o,frame,rows:()=>readT2Events(readFileSync(events,'utf8')),raw:()=>readFileSync(events,'utf8'),close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('T2 registry/dispatch has only the selected normal write set',()=>{assert.equal(b3ScenarioKey('task-write'),'task-write');assert.equal(T2_CASES.length,4);assert.throws(()=>b3ScenarioKey('task-write','faults'));});
test('create request precedes 201 identity learning; original response retained and no token printed',async()=>{
 const x=setup();try{await x.frame('POST','/api/tasks',{conversation_id:'C',title:'new'},201,{success:true,task:{id:'T',task_number:1}});const r=x.rows();assert(r.find(v=>v.event==='request').seq<r.find(v=>v.event==='response').seq);assert.equal(x.o.taskId,'T');assert(r.some(v=>v.event==='response_raw'&&v.status===201));assert(!x.raw().includes('private-test-token'));assert.equal(x.o.pending.size,0);}finally{x.close();}
});
test('201 malformed response preserves raw value and rejects observation instead of retrying',async()=>{
 const x=setup();try{await x.frame('POST','/api/tasks',{conversation_id:'C',title:'new'},201,'bad-json');const r=JSON.parse('['+x.raw().trim().split('\n').join(',')+']');assert(r.some(v=>v.event==='request'));assert(r.some(v=>v.event==='response_raw'&&v.raw==='bad-json'));assert.equal(x.o.taskId,undefined);assert.throws(()=>x.rows());}finally{x.close();}
});
test('client pending/disconnect cannot become a complete zero-write window',async()=>{
 const x=setup();try{const req=new PassThrough();Object.assign(req,{method:'POST',url:'/api/tasks',headers:{authorization:'Bearer private-test-token'}});const res=new EventEmitter();res.writableFinished=false;x.o.attach(req,res);assert.equal(x.o.pending.size,1);res.emit('close');assert.throws(()=>x.rows());}finally{x.close();}
});
test('actor/phase/task substitution and oversized request fail closed',async()=>{
 for(const change of ['actor','phase','task','bytes']){const x=setup();try{if(change==='actor')x.spec.apiToken='other';if(change==='phase')x.spec.phase=2;if(change==='task')x.spec.taskId='unproved';x.save();await x.frame('POST','/api/tasks',{conversation_id:'C',title:change==='bytes'?'x'.repeat(17000):'x'},500,{});assert.throws(()=>x.rows());}finally{x.close();}}
});
test('zero writes requires contiguous journal, both bounded markers and all preceding terminals',()=>{
 const base=[{seq:1,event:'observer_start'},{seq:2,event:'marker',marker:'a',pending:[]},{seq:3,event:'request',request:1,method:'GET',path:'/api/tasks/T'},{seq:4,event:'terminal',request:1},{seq:5,event:'marker',marker:'b',pending:[]}];
 const read=x=>readT2Events(x.map(v=>JSON.stringify(v)).join('\n')+'\n');assert.equal(assertT2ZeroWrites(read(base),'a','b','T').observedWrites,0);
 for(const f of [r=>r[4].pending=[2],r=>r.splice(3,1),r=>r[2].method='POST',r=>r[2].path='/api/tasks/T/edit']){const r=structuredClone(base);f(r);if(r[2].path.endsWith('/edit'))r[2].method='POST';assert.throws(()=>assertT2ZeroWrites(read(r),'a','b','T'));}
});
test('append failure prevents later marker from claiming completeness',()=>{
 let calls=0;const x=setup({append:()=>{if(++calls>1)throw Error('disk');}});try{x.o.emit('marker',{marker:'end'});assert(x.o.failed);assert.throws(()=>x.rows());}finally{x.close();}
});
