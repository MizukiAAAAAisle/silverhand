// @vitest-environment happy-dom
// Actual runT2 + observer + StatusPicker; remaining UI/CDP/API state is controlled.
import { expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { PassThrough } from 'node:stream';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync,writeFileSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStatusBadge } from './task-status-badge';
import { runT2,T2_CASES } from '../../../../../../apps/android/scripts/acceptance-t2.mjs';
import { TaskWriteObserver } from '../../../../../../apps/android/scripts/t2-observer.mjs';
import { AcceptanceRecord } from '../../../../../../apps/android/scripts/acceptance-record.mjs';

it.each([true,false])('actual driver completes PRE/four cases with independent read=%s and real StatusPicker',async(qualified)=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const out=mkdtempSync(join(tmpdir(),'t2-success-')),file=out+'/t2-observer-private.json',events=out+'/t2-events.jsonl';
 writeFileSync(file,'{"version":1,"unit":"task-write","active":false}',{mode:0o600});const observer=new TaskWriteObserver(file,events);
 const record=new AcceptanceRecord(out,['PRE.T2.fixture-login',...T2_CASES]),evidence:any[]=[];
 let task:any=null,route='#/chat',detail=false,dialogs=0,editing:string|null=null,draft='',createTitle='',createBody='',pending:Promise<any>|null=null;
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 async function frame(method:string,path:string,body:any,status:number,answer:any){
  const req=new PassThrough() as any;Object.assign(req,{method,url:path,headers:{authorization:'Bearer private-token'}});const res=new EventEmitter() as any;res.writableFinished=false;
  const ctx=observer.attach(req,res),ended=once(req,'end');req.resume();req.end(body===undefined?'':JSON.stringify(body));await ended;
  if(ctx){const reply=new PassThrough() as any;reply.statusCode=status;ctx.reply(reply);const end=once(reply,'end');reply.end(JSON.stringify(answer));await end;}
  res.writableFinished=true;res.emit('finish');return structuredClone(answer);
 }
 async function api(path:string,method='GET',body:any=undefined){
  if(path==='/api/workspaces')return{id:'W',name:'workspace'};
  if(path==='/api/workspaces/W/channels')return{id:'C',title:'channel'};
  if(path.endsWith('/members'))return{human_members:[{user_id:'A'}],members:[{kind:'human',user_id:'A'}]};
  if(path==='/api/channels/C')return{id:'C',status:'idle',closed_at:null,archived_at:null};
  if(path==='/api/tasks/T')return frame('GET',path,undefined,200,{task});
  throw Error('unexpected controlled API '+path);
 }
 function snapshot(){return{route,pageCount:1,layout:'compact',dialogs,toolbars:0,boardCount:route==='#/tasks'&&!detail?1:0,detailCount:detail?1:0,taskId:detail?'T':null,detailText:detail?task.title+' '+task.content:null,detailMeta:{status:task?.status},columns:['todo','in_progress','in_review','done','closed'].map(status=>({status,loading:false,truncated:false,rows:task&&task.status===status?[{id:'T',number:'7',title:task.title}]:[]}))};}
 const c={evaluate:async(expression:string)=>expression==='STATE'?snapshot():expression.includes('textarea[aria-label')?draft:{ready:true,selector:'button'},send:async(_m:string,p:any)=>{if(p.type!=='keyDown')return;if(p.key==='Escape'){editing=null;return;}if(p.key==='Enter'&&editing){const body=editing==='title'?{title:draft}:{body:draft};if(editing==='title')task.title=draft;else task.content=draft;await frame('POST','/api/tasks/T/edit',body,200,{success:true,task});editing=null;}}};
 const helpers={taskStateExpression:()=> 'STATE',taskOptionTarget:()=>{},clickTaskFilterControl:async()=>{},imeShown:()=>false,
  clickTaskCard:async()=>{detail=true;},searchClick:async(_c:any,_o:any,selector:string,text:string|undefined,name:string)=>{
   evidence.push({action:name,selector,text});
   if(name==='t2-tasks')route='#/tasks';
   else if(name==='t2-new')dialogs=1;
   else if(name==='t2-create-once'){
    task={id:'T',task_number:7,title:createTitle,content:createBody,status:'todo',assignee:null,place:{kind:'workspace',workspace_id:'W',conversation_id:'C'}};
    await frame('POST','/api/tasks',{conversation_id:'C',title:createTitle,body:createBody},201,{success:true,task:{id:'T',task_number:7,title:createTitle}});dialogs=0;
    await frame('GET','/api/tasks/board/column?container=workspace&workspace_id=W&channel_id=C&status='+(qualified?'todo':'done')+'&limit=20',undefined,200,{status:qualified?'todo':'done',items:qualified?[task]:[]});
   }else if(['t2-cancel-edit','t2-cancel-reenter','t2-title-edit','t2-content-edit'].includes(name)){editing=name==='t2-content-edit'?'content':'title';draft=task[editing];}
   else if(name==='t2-status-open'){
    await act(async()=>root.render(React.createElement(TaskStatusBadge,{status:'todo',onChange:next=>{pending=(async()=>{task.status=next;await frame('POST','/api/tasks/T/status',{status:next},200,{success:true});})();}})));
    await act(async()=>{(host.querySelector('button[data-task-status="todo"]') as HTMLButtonElement).click();});
    const actual=[...document.querySelectorAll('[data-popover-frame="info"] button')];
    expect(actual.filter(x=>x.textContent!.trim()==='In progress')).toHaveLength(0);
    expect(actual.filter(x=>x.textContent!.trim()==='in progress')).toHaveLength(1);
    evidence.push({oldLabelMatches:0,actualLabel:'in progress'});
   }else if(name==='t2-status-select'){
    const actual=[...document.querySelectorAll(selector)].filter(x=>text===undefined||x.textContent!.trim()===text);expect(actual).toHaveLength(1);
    expect(actual[0]!.textContent!.trim()).toBe('in progress');
    await act(async()=>{(actual[0] as HTMLButtonElement).click();});await pending;
    evidence.push({correctedTargetMatches:actual.length,status:task.status});
   }else if(name==='t2-back-board')detail=false;
   else if(name==='t2-chats'){detail=false;route='#/chat';}
  }};
 try{
  await runT2({c,api,call:async()=>({me:{status:200,bodyText:'{"id":"A"}'}}),adb:()=> 'mInputShown=false',input:async(sel:string,value:string)=>{if(sel==='#create-task-title')createTitle=value;else if(sel==='#create-task-body')createBody=value;else draft=value;},out,token:'private-token',fixture:{userId:'A'},step:(...args:any[])=>record.step(...args),observe:(name:string,value:any)=>evidence.push({name,value})},helpers);
  record.complete();const counts=JSON.parse(readFileSync(out+'/counts.json','utf8'));
  expect(counts.groups.PRE.passed).toBe(1);expect(counts.groups.B3.passed).toBe(4);expect(counts.groups.B3.failed).toBe(0);
  expect(evidence.find(x=>x.name==='t2-board-read-layer').value.independentReadObtained).toBe(qualified);
  expect(evidence.find(x=>x.name==='t2-cancel-window').value.observedWrites).toBe(0);
  const ending=evidence.find(x=>x.name==='t2-residue').value;expect([ending.workspaceId,ending.channelId,ending.taskId]).toEqual(['W','C','T']);
  expect(task.status).toBe('in_progress');expect(task.assignee).toBe(null);expect(route).toBe('#/chat');expect(observer.failed).toBe(false);
  if (process.env.SILVERHAND_T2_HOST_EVIDENCE_ROOT) writeFileSync(process.env.SILVERHAND_T2_HOST_EVIDENCE_ROOT + '/driver-' + (qualified ? 'qualified' : 'missing-read') + '.json', JSON.stringify({oldLabelMatches:0,correctedTargetMatches:1,independentReadObtained:qualified,PRE:counts.groups.PRE,B3:counts.groups.B3,finalStatus:task.status,route,residue:ending},null,2));
  console.log('CONTROLLED_T2_DRIVER',JSON.stringify({oldLabelMatches:0,correctedTargetMatches:1,independentReadObtained:qualified,PRE:counts.groups.PRE,B3:counts.groups.B3,finalStatus:task.status,route,residue:ending}));
 }finally{await act(async()=>root.unmount());host.remove();rmSync(out,{recursive:true,force:true});}
});
