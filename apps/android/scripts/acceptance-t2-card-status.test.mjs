// One before/after call-contract seam. Actual runT2 and locator consumers;
// UI/backend/bridge/journal/clock/DOM geometry/CDP transport are a fixed model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { clickTaskCard } from './acceptance-b3.mjs';
import { AcceptanceRecord } from './acceptance-record.mjs';
const uiRequire=createRequire(new URL('../../../packages/app-ui/package.json',import.meta.url));
const { Window }=await import(uiRequire.resolve('happy-dom'));
const mode=process.env.T2_CARD_STATUS_MODE;
assert(['before','after'].includes(mode),'Explicit source variant required');
const original=mode==='before'?readFileSync(process.env.T2_CARD_STATUS_BEFORE,'utf8'):readFileSync(new URL('./acceptance-t2.mjs',import.meta.url),'utf8');
// Only relocate the two relative imports of a retained source copy;no runtime-body mutation.
const imports=[];const relocated=original.replace(/from '(\.\/[^']+)'/g,(_all,relative)=>{imports.push(relative);return `from '${new URL(relative,import.meta.url).href}'`;});
assert.deepEqual(imports,['./t2-observer.mjs','./t1-tls-evidence.mjs']);
const {runT2,T2_CASES}=await import('data:text/javascript;base64,'+Buffer.from(relocated).toString('base64'));
const hash=x=>createHash('sha256').update(x).digest('hex');
test('actual runT2 passes card target into unchanged real locator: '+mode,async()=>{
 const out=mkdtempSync(join(tmpdir(),'t2-card-status-'));const window=new Window({url:'https://localhost/#/tasks'}),document=window.document;
 Object.defineProperty(window,'innerWidth',{value:412});Object.defineProperty(window,'innerHeight',{value:839});document.documentElement.dataset.layout='compact';
 document.body.innerHTML='<main data-page><div data-tasks-board><section data-tasks-column data-status="todo"></section><section data-tasks-column data-status="in_progress"></section></div></main>';
 const record=new AcceptanceRecord(out,['PRE.T2.fixture-login',...T2_CASES]);
 writeFileSync(out+'/t2-observer-private.json',JSON.stringify({version:1,unit:'task-write',active:false}),{mode:0o600});
 const journal=[{seq:1,event:'observer_start'}],observations=[],dispatches=[],targets=[],reads=[];let task,now=0,clicked=0;const values={};const sentinel=Error('controlled stop after actual locator/click seam');
 const save=()=>writeFileSync(out+'/t2-events.jsonl',journal.map(x=>JSON.stringify(x)).join('\n')+'\n');
 const emit=(event,fields)=>{journal.push({seq:journal.length+1,event,...fields});save();};save();
 const rect=(x,y,width,height)=>({x,y,width,height,left:x,top:y,right:x+width,bottom:y+height});
 function cardDom(){
  const todo=document.querySelector('[data-status="todo"]');todo.innerHTML='<div data-task-id="T" data-task-number="7"><button aria-label="Open task detail">Open</button></div>';
  const card=todo.firstElementChild,button=card.firstElementChild,board=document.querySelector('[data-tasks-board]');
  card.scrollIntoView=()=>{};button.scrollIntoView=()=>{};board.getBoundingClientRect=()=>rect(0,100,412,500);card.getBoundingClientRect=()=>rect(12,170,388,40);button.getBoundingClientRect=()=>rect(12,170,388,40);
  document.elementFromPoint=(x,y)=>x>=12&&x<400&&y>=170&&y<210?button:document.body;
  button.addEventListener('click',()=>clicked++);
 }
 const state=()=>({route:'#/tasks',boardCount:1,dialogs:0,columns:[{status:'todo',loading:false,truncated:false,rows:task?[{id:'T',number:'7'}]:[]},{status:'in_progress',loading:false,truncated:false,rows:[]}]});
 const c={evaluate:async expression=>{if(expression==='STATE')return state();reads.push(expression);const value=window.eval(expression);return value===undefined?undefined:JSON.parse(JSON.stringify(value));},send:async(method,event)=>{dispatches.push({method,event});if(event.type==='mouseReleased')document.elementFromPoint(event.x,event.y).click();}};
 const ctx={c,out,token:'controlled-api-token',fixture:{userId:'A'},
  step:(...a)=>record.step(...a),observe:(name,value)=>{observations.push({name,value});record.observe(name,value);},
  input:async(selector,value)=>{values[selector]=value;},adb:()=>'',call:async()=>({me:{status:200,bodyText:'{"id":"A"}'}}),
  api:async path=>{
   if(path==='/api/workspaces')return{id:'W',name:'W'};
   if(path==='/api/workspaces/W/channels')return{id:'C',title:'C'};
   if(path==='/api/workspaces/W/members')return{human_members:[{user_id:'A'}]};
   if(path==='/api/conversations/C/members')return{members:[{kind:'human',user_id:'A'}]};
   if(path==='/api/channels/C')return{id:'C',status:'idle',closed_at:null,archived_at:null};
   if(path==='/api/tasks/T')return{task};
   throw Error('Unlisted model API '+path);
  }};
 const h={clock:{now:()=>now,sleep:async ms=>{now+=ms;}},taskStateExpression:()=> 'STATE',clickTaskFilterControl:async()=>{},taskOptionTarget:function(){return{ready:true,selector:'#controlled-filter'};},
  searchClick:async(_c,_o,_s,_t,name)=>{
   if(name!=='t2-create-once')return;
   task={id:'T',task_number:7,title:values['#create-task-title'],content:values['#create-task-body'],status:'todo',assignee:null,place:{workspace_id:'W',conversation_id:'C'}};
   emit('request',{request:1,method:'POST',path:'/api/tasks'});emit('response',{request:1,status:201,body:{task}});emit('terminal',{request:1});
   emit('request',{request:2,method:'GET',path:'/api/tasks/board/column',params:{container:'workspace',workspace_id:'W',channel_id:'C',status:'todo'}});emit('response',{request:2,status:200,body:{status:'todo',items:[task]}});emit('terminal',{request:2});cardDom();
  },
  clickTaskCard:async(...args)=>{targets.push(args[2]);await clickTaskCard(...args);throw sentinel;}};
 let caught;
 try{await runT2(ctx,h);}catch(error){caught=error;record.fail(error);}
 try{
  assert.equal(targets.length,1);assert.equal(record.data.steps[0].status,'passed');
  const alignment=observations.find(x=>x.name==='t2-open-task-alignment').value;
  assert.equal(targets[0].id,'T');assert.equal(targets[0].number,7);assert.equal(document.querySelectorAll('[data-task-id="T"]').length,1);
  if(mode==='before'){
   assert(!Object.hasOwn(targets[0],'status'));assert.notEqual(caught,sentinel);assert.match(String(caught),/task_card_not_unique/);
   assert.deepEqual(alignment.counts,{pages:1,boards:1,columns:0,cards:0});assert.equal(dispatches.length,0);assert.equal(clicked,0);
  }else{
   assert.equal(targets[0].status,'todo');assert.equal(caught,sentinel);assert.equal(alignment.ready,true);assert.deepEqual(alignment.counts,{pages:1,boards:1,columns:1,cards:1});
   assert(alignment.selector.includes('[data-status="todo"]'));assert.equal(dispatches.length,2);assert.equal(clicked,1);
   assert.equal(document.querySelector(alignment.selector),document.querySelector('[data-status="todo"] [data-task-id="T"] button'));
  }
  assert.equal(window.__b3TaskCardTarget,undefined);assert.equal(window.__b2LeftClickTarget,undefined);
  if(process.env.T2_CARD_STATUS_EVIDENCE){mkdirSync(process.env.T2_CARD_STATUS_EVIDENCE,{recursive:true});writeFileSync(join(process.env.T2_CARD_STATUS_EVIDENCE,'result.json'),JSON.stringify({mode,source_sha256:hash(original),import_relocations:imports,dom:document.body.innerHTML,dom_sha256:hash(document.body.innerHTML),target:targets[0],alignment,dispatches,clicked,observations,raw:record.data,caught:String(caught),stopped_after_seam:true,boundary:'actual runT2/clickTaskCard/taskAlignCard/searchClick/leftControlTarget;API/native/UI/clock/geometry/CDP transport/journal are models,no device'},null,2)+'\n');}
 }finally{await window.happyDOM.close();rmSync(out,{recursive:true,force:true});}
});
