// Actual passive observer/proxy/TLS producer/PRE consumer; memory HTTP only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync,mkdirSync,unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskWriteObserver,readT2Events } from './t2-observer.mjs';
import { T1TlsEvidence,nativeTlsMatch,traceHeader } from './t1-tls-evidence.mjs';
import { proxyHandler } from './acceptance-server.mjs';
import { runT2,T2_CASES } from './acceptance-t2.mjs';
import { AcceptanceRecord } from './acceptance-record.mjs';
const certificate=Buffer.from('controlled public certificate bytes');
const certHash=createHash('sha256').update(certificate).digest('hex');
const inactive={version:1,unit:'task-write',active:false};
const active={...inactive,active:true,userId:'A',workspaceId:'W',channelId:'C',apiToken:'private-api',taskId:null,phase:0,marker:'prepared'};
function setup(t, initial=active){
 const dir=mkdtempSync(join(tmpdir(),'t2-tls-wiring-')),file=join(dir,'t2-observer-private.json'),events=join(dir,'t2-events.jsonl'),tlsFile=join(dir,'t2-tls-events.jsonl');
 writeFileSync(file,JSON.stringify(initial),{mode:0o600});const observer=new TaskWriteObserver(file,events),tls=new T1TlsEvidence(tlsFile,{attempt:dir});
 t.after(()=>rmSync(dir,{recursive:true,force:true}));return {dir,file,events,tlsFile,observer,tls};
}
async function exchange(t,s,{body='{"id":"A"}',beforeReply=()=>{},status=200}={}){
 const req=new PassThrough(),res=new PassThrough(),chunks=[];req.method='GET';req.url='/api/me';req.headers={authorization:'Bearer native-session',host:'localhost:29443'};
 req.socket={encrypted:true,getProtocol:()=> 'TLSv1.3',localAddress:'127.0.0.1',localPort:29443,remoteAddress:'127.0.0.1',remotePort:40000,getCertificate:()=>({raw:certificate})};
 let responseHeaders,responseStatus;res.writeHead=(code,headers)=>{responseStatus=code;responseHeaders=headers;res.headersSent=true;return res;};res.on('data',b=>chunks.push(b));
 const mocked=t.mock.method(http,'request',(_opts,callback)=>{const up=new PassThrough();up.resume();queueMicrotask(()=>{beforeReply();const reply=new PassThrough();reply.statusCode=status;reply.headers={'content-type':'application/json','x-preserved':'same'};callback(reply);reply.end(body);});return up;});
 try{const done=once(res,'finish');proxyHandler({writeObserver:s.observer,tlsEvidence:s.tls})(req,res);req.end();await done;await new Promise(r=>setImmediate(r));}
 finally{mocked.mock.restore();req.destroy();res.destroy();}
 assert.equal(responseStatus,status);assert.equal(responseHeaders['x-preserved'],'same');assert.equal(Buffer.concat(chunks).toString(),body);
 return {serverUrl:'https://localhost:29443',info:{status:200},me:{status,headers:responseHeaders,bodyText:body}};
}
test('inactive attach keeps native me transparent without TLS fixture trace',async t=>{
 const s=setup(t,inactive),native=await exchange(t,s);assert.equal(native.me.headers[traceHeader],undefined);assert.equal(existsSync(s.tlsFile),false);assert.equal(s.observer.failed,false);
});
test('actual proxy uses one attach snapshot after config changes, preserves response and matches native trace/body/cert',async t=>{
 const s=setup(t);let reads=0;const spec=s.observer.spec.bind(s.observer);s.observer.spec=()=>{reads++;return spec();};
 const native=await exchange(t,s,{beforeReply:()=>writeFileSync(s.file,JSON.stringify({...active,userId:'B'}))});
 assert.equal(reads,1);const matched=nativeTlsMatch(native,{userId:'A',serverCertificateSha256:certHash},s.tlsFile);assert.equal(matched.fixtureUserId,'A');assert.equal(s.observer.failed,false);assert(!readFileSync(s.tlsFile,'utf8').includes('private-api'));
});
test('config read refusal or sticky observer failure cannot publish positive TLS evidence',async t=>{
 for(const failure of ['read','sticky']){const s=setup(t);if(failure==='read')writeFileSync(s.file,'not JSON');else s.observer.fail('controlled-first');const native=await exchange(t,s);assert.equal(s.observer.failed,true);assert.equal(existsSync(s.tlsFile),false);assert.equal(native.me.headers[traceHeader],undefined);}
});
test('actual TLS file write failure is sticky and cannot alter original HTTP response or escape end callback',async t=>{
 const s=setup(t);mkdirSync(s.tlsFile);await exchange(t,s);assert(s.observer.failed);assert(readFileSync(s.events,'utf8').includes('tls_publish'));
});
test('actual me body cap fails observation while passing exact original bytes',async t=>{
 const s=setup(t),body=JSON.stringify({id:'A',padding:'x'.repeat(65536)});await exchange(t,s,{body});assert(s.observer.failed);assert.equal(existsSync(s.tlsFile),false);assert(readFileSync(s.events,'utf8').includes('tls_body_bound'));
});
test('native matcher rejects wrong cert/user/body/duplicate trace and incomplete original row',async t=>{
 const s=setup(t),native=await exchange(t,s),text=readFileSync(s.tlsFile,'utf8');
 assert.throws(()=>nativeTlsMatch(native,{userId:'A',serverCertificateSha256:certHash,attempt:s.dir+'-other'},s.tlsFile),/attempt/);
 assert.throws(()=>nativeTlsMatch(native,{userId:'A',serverCertificateSha256:'0'.repeat(64)},s.tlsFile),/metadata/);
 assert.throws(()=>nativeTlsMatch(native,{userId:'B',serverCertificateSha256:certHash},s.tlsFile),/fixture/);
 assert.throws(()=>nativeTlsMatch({...native,me:{...native.me,bodyText:'{"id":"A","changed":true}'}},{userId:'A',serverCertificateSha256:certHash},s.tlsFile),/body/);
 writeFileSync(s.tlsFile,text+text);assert.throws(()=>nativeTlsMatch(native,{userId:'A',serverCertificateSha256:certHash},s.tlsFile),/repeated/);
 writeFileSync(s.tlsFile,text.trimEnd());assert.throws(()=>nativeTlsMatch(native,{userId:'A',serverCertificateSha256:certHash},s.tlsFile),/incomplete/);
});
for(const mode of ['valid','wrong-cert','missing-row'])test('actual runT2 PRE consumes same native result before Tasks: '+mode,async t=>{
 const s=setup(t,inactive),record=new AcceptanceRecord(s.dir,['PRE.T2.fixture-login',...T2_CASES]),first=Error('controlled stop before any task create');let calls=0,tasks=0,now=0;
 const ctx={out:s.dir,token:'private-api',fixture:{userId:'A'},newOrigin:{server_certificate_der_sha256:mode==='wrong-cert'?'0'.repeat(64):certHash},
 c:{evaluate:async expr=>expr==='STATE'?{route:'#/tasks',boardCount:1,columns:[]}:{ready:true,selector:'option'}},
 call:async()=>{calls++;const native=await exchange(t,s);if(calls===2&&mode==='missing-row')unlinkSync(s.tlsFile);return native;},
 api:async path=>path==='/api/workspaces'?{id:'W',name:'W'}:path.endsWith('/channels')?{id:'C',title:'C'}:path.endsWith('/members')?{human_members:[{user_id:'A'}],members:[{kind:'human',user_id:'A'}]}:{id:'C',status:'idle',closed_at:null,archived_at:null},
 input:async()=>{},adb:()=>'',step:(...args)=>record.step(...args),observe:(...args)=>record.observe(...args)};
 const h={clock:{now:()=>now,sleep:async ms=>{now+=ms;}},taskStateExpression:()=> 'STATE',clickTaskFilterControl:async()=>{},taskOptionTarget:()=>{},searchClick:async(_c,_o,_s,_t,name)=>{if(name==='t2-tasks')tasks++;if(name==='t2-new')throw first;}};
 let caught;try{await runT2(ctx,h);}catch(error){caught=error;record.fail(error);}assert(caught);assert.equal(calls,2,'one activated native call,never retried');
 if(mode==='valid'){assert.equal(caught,first);assert.equal(record.data.steps[0].status,'passed');assert.equal(tasks,1);const markers=record.data.observations.filter(x=>x.name==='t2-new-origin-native-tls-complete');assert.equal(markers.length,1);assert.equal(markers[0].value.nativeTraceId,markers[0].value.response.id);assert.equal(record.data.steps[1].status,'failed');}
 else{assert.equal(record.data.steps[0].status,'failed');assert(record.data.steps.slice(1).every(x=>x.status==='not_executed'));assert.equal(tasks,0);assert(!record.data.observations.some(x=>x.name==='t2-new-origin-native-tls-complete'));assert.match(String(caught),mode==='wrong-cert'?/metadata/:/bounded condition/);}
 assert(readT2Events(readFileSync(s.events,'utf8')).length>0);
});
