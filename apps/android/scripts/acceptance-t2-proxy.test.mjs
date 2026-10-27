// Actual proxyHandler, in-memory HTTP objects only: no listener/network/API.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proxyHandler } from './acceptance-server.mjs';
import { TaskWriteObserver } from './t2-observer.mjs';
for(const bad of [false,true])test('actual proxy preserves request/response bytes/status with observer '+(bad?'rejection':'success'),async(t)=>{
 const dir=mkdtempSync(join(tmpdir(),'t2-proxy-')),file=join(dir,'private'),events=join(dir,'events');
 writeFileSync(file,JSON.stringify({version:1,unit:'task-write',active:true,userId:'A',workspaceId:'W',channelId:'C',apiToken:'secret',taskId:null,phase:0,marker:'start'}),{mode:0o600});
 const o=new TaskWriteObserver(file,events),req=new PassThrough(),res=new PassThrough();let forwarded='',status,headers,options;
 req.method='POST';req.url='/api/tasks';req.headers={authorization:'Bearer secret','content-type':'application/json'};
 res.writeHead=(s,h)=>{status=s;headers=h;res.headersSent=true;return res;};const chunks=[];res.on('data',b=>chunks.push(b));
 const raw=bad?'malformed backend body':'{"success":true,"task":{"id":"T","task_number":1}}';
 t.mock.method(http,'request',(opts,callback)=>{options=opts;const upstream=new PassThrough();upstream.on('data',b=>forwarded+=b);queueMicrotask(()=>{const reply=new PassThrough();reply.statusCode=201;reply.headers={'content-type':'application/json','x-fixture':'unchanged'};callback(reply);reply.end(raw);});return upstream;});
 try{const done=once(res,'finish');proxyHandler({writeObserver:o})(req,res);const body='{"conversation_id":"C","title":"fresh"}';req.end(body);await done;assert.equal(status,201);assert.equal(headers['x-fixture'],'unchanged');assert.equal(Buffer.concat(chunks).toString(),raw);assert.equal(forwarded,body);assert.equal(options.method,'POST');assert.equal(options.path,'/api/tasks');assert.equal(o.failed,bad);assert(readFileSync(events,'utf8').includes('response_raw'));}finally{rmSync(dir,{recursive:true,force:true});}
});
test('observer byte/event budgets prevent later completeness without large output',()=>{
 const dir=mkdtempSync(join(tmpdir(),'t2-budget-'));try{for(const huge of [true,false]){const o=new TaskWriteObserver(join(dir,'config'),join(dir,huge?'bytes':'events'));if(huge)o.emit('oversized',{raw:'x'.repeat(4*1024*1024)});else for(let i=0;i<513;i++)o.emit('bounded');assert(o.failed);assert(o.journalBytes<=4*1024*1024);assert(o.seq<=512);}}finally{rmSync(dir,{recursive:true,force:true});}
});
