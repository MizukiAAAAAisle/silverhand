// Actual runT2 -> searchClick -> leftControlTarget over controlled DOM/clock/CDP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync,writeFileSync,mkdtempSync,rmSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runT2 as currentRun } from './acceptance-t2.mjs';
import { searchClick } from './acceptance-b3.mjs';
const uiRequire=createRequire(new URL('../../../packages/app-ui/package.json',import.meta.url));
const { Window }=await import(uiRequire.resolve('happy-dom'));
const hash=x=>createHash('sha256').update(x).digest('hex');
let beforeRun;
if(process.env.T2_CLICK_BEFORE){
 const source=readFileSync(process.env.T2_CLICK_BEFORE,'utf8').replace(/from '(\.\/[^']+)'/g,(_all,p)=>`from '${new URL(p,import.meta.url).href}'`);
 beforeRun=(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).runT2;
}
async function seam(mode,run=currentRun){
 const out=mkdtempSync(join(tmpdir(),'t2-click-ready-'));const window=new Window({url:'https://localhost/#/tasks'}),document=window.document;
 Object.defineProperty(window,'innerWidth',{value:412});Object.defineProperty(window,'innerHeight',{value:839});document.documentElement.dataset.layout='compact';
 document.body.innerHTML='<main data-page><nav aria-label="Main navigation"><button>Tasks</button></nav></main>';
 const initialDOM=document.body.innerHTML;let button=document.querySelector('button'),readCount=0,now=0,occluded=true;const dispatched=[],observations=[],steps=[];
 const stop=Error('controlled stop after actual click consumer');
 function setup(){button.getBoundingClientRect=()=>({x:occluded?402.946:360,y:66,width:18,height:18});document.elementFromPoint=()=>occluded?null:button;}
 setup();writeFileSync(out+'/t2-observer-private.json',JSON.stringify({version:1,unit:'task-write',active:false}));writeFileSync(out+'/t2-events.jsonl',JSON.stringify({seq:1,event:'observer_start'})+'\n');
 const c={evaluate:async expression=>{
  if(expression.startsWith('(function leftControlTarget')){
   readCount++;occluded=mode==='permanent'||mode==='before'||readCount<=2;
   if(mode==='final-hit-changed')occluded=readCount!==1;
   if(mode==='duplicate'&&readCount===1){document.querySelector('nav').append(button.cloneNode(true));document.querySelector('nav').lastChild.getBoundingClientRect=button.getBoundingClientRect;}
   if(mode==='replacement'&&readCount===2){const next=button.cloneNode(true);button.replaceWith(next);button=next;setup();}
   if(mode==='route-change'&&readCount===2)window.location.hash='#/different';
   if(mode==='document-change'&&readCount===2)window.happyDOM.setURL('https://different/#/tasks');
  }
  const value=window.eval(expression);return value===undefined?undefined:JSON.parse(JSON.stringify(value));
 },send:async(method,event)=>{dispatched.push({method,event});}};
 const context={c,out,token:'controlled',fixture:{userId:'A'},observe:(name,value)=>observations.push({name,value}),step:async(id,fn)=>{steps.push(id);return fn();},call:async()=>({me:{status:200,bodyText:'{"id":"A"}'}}),api:async path=>{
  if(path==='/api/workspaces')return{id:'W',name:'W'};if(path==='/api/workspaces/W/channels')return{id:'C',title:'C'};
  if(path==='/api/workspaces/W/members')return{human_members:[{user_id:'A'}]};if(path==='/api/conversations/C/members')return{members:[{kind:'human',user_id:'A'}]};if(path==='/api/channels/C')return{id:'C',status:'idle',closed_at:null,archived_at:null};throw Error('Unexpected controlled API '+path);
 }};
 const helpers={clock:{now:()=>now,sleep:async ms=>{now+=ms;}},searchClick,clickTaskFilterControl:async()=>{throw stop;}};
 let caught;
 try{await run(context,helpers);}catch(error){caught=error;}
 try{
  assert.deepEqual(steps,['PRE.T2.fixture-login']);
  if(mode==='transient') {assert.equal(caught,stop);assert.equal(dispatched.length,2);assert.equal(dispatched[0].event.type,'mousePressed');assert.equal(dispatched[1].event.type,'mouseReleased');assert.equal(dispatched[0].event.x,369);assert(readCount>=4);assert(now>0&&now<10000);}
  else {assert.notEqual(caught,stop);assert.equal(dispatched.length,0);}
  if(mode==='before')assert.match(String(caught),/click rejected: occluded/);
  if(mode==='permanent'){assert.match(String(caught),/T2 bounded condition/);assert.equal(readCount,100);assert(now<=10000);const last=observations.find(x=>x.name==='t2-tasks-wait-last').value;assert.equal(last.reason,'occluded');assert.equal(last.ready,false);assert.equal(last.hit,null);assert(last.target&&Array.isArray(last.clippingAncestors));}
  if(mode==='replacement')assert.match(String(caught),/target_replaced/);
  if(mode==='route-change')assert.match(String(caught),/route_changed/);
  if(mode==='document-change')assert.match(String(caught),/document changed/);
  if(mode==='duplicate')assert.match(String(caught),/target_not_unique/);
  if(mode==='final-hit-changed')assert.match(String(caught),/identity\/hit rejected: occluded/);
  assert.equal(window.__b2LeftClickTarget,undefined);
  if(process.env.T2_CLICK_EVIDENCE){const dir=join(process.env.T2_CLICK_EVIDENCE,mode);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'result.json'),JSON.stringify({mode,initial_DOM_sha256:hash(initialDOM),readCount,elapsed_model_ms:now,dispatched,observations,stopped:String(caught),boundary:'actual runT2/searchClick/leftControlTarget;API/native/DOM geometry/clock/CDP dispatch model only,no device'},null,2)+'\n');}
 }finally{await window.happyDOM.close();rmSync(out,{recursive:true,force:true});}
}
if(beforeRun)test('retained runT2 before wait: first occluded sample fails',()=>seam('before',beforeRun));
for(const mode of ['transient','permanent','replacement','route-change','document-change','duplicate','final-hit-changed'])test('actual T2 pre-dispatch wait '+mode,()=>seam(mode));
