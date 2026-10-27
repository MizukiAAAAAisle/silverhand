// Execute the actual acceptance.mjs B3 preflight and runB3 argument block.
// This does not import/run the service/signup/CDP main body; runB3 is a capture boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
const source=readFileSync(new URL('./acceptance.mjs',import.meta.url),'utf8');
const start=source.indexOf("let newOrigin;\nif (suite === 'b3') {");
const end=source.indexOf('const coverage=coverageMetadata',start);
assert(start>0&&end>start,'Actual B3 entry block unavailable');
const preflight=source.slice(start,end);
const calls=source.split('\n').filter(line=>/^\s*await runB3\(/.test(line));
assert.equal(calls.length,1,'Actual B3 dispatch must be unique');
const dispatch=calls[0];
assert(source.indexOf(preflight)<source.indexOf("const user = await api('/auth/signup'"),'Origin rejection must precede fixture API');
if(process.env.T2_ENTRY_CONTROL_EVIDENCE){
 mkdirSync(process.env.T2_ENTRY_CONTROL_EVIDENCE,{recursive:true});
 writeFileSync(join(process.env.T2_ENTRY_CONTROL_EVIDENCE,'actual-preflight.js'),preflight);
 writeFileSync(join(process.env.T2_ENTRY_CONTROL_EVIDENCE,'actual-dispatch.js'),dispatch+'\n');
}
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const execute=new AsyncFunction('assert','suite','report','unit','selection','active','runB3','c','api','call','adb','input','serial','out','token','fixture',preflight+'\n'+dispatch);
async function entry(unit,origin,runner){
 const ids=['PRE.controlled'];const data={suite:'b3',unit,selection:{selected_ids:ids},bindings:{packages:{product:{sha256:'controlled'}},reviewed_binding:{path:'/controlled/binding'}}};
 if(origin!==undefined)data.bindings.product_origin=origin;
 return execute(assert,'b3',{data,step:()=>{},observe:()=>{}},unit,undefined,ids,runner,{},()=>{throw Error('Unexpected API');},()=>{throw Error('Unexpected bridge');},()=>{throw Error('Unexpected ADB');},()=>{throw Error('Unexpected input');},'controlled','/controlled/out','controlled',{userId:'A'});
}
test('actual entry preflight and dispatch pass the same new T2 origin object',async()=>{
 const origin={kind:'t2-renewed-ca-asset-origin-v1',server_certificate_der_sha256:'1'.repeat(64)};let calls=0;
 await entry('task-write',origin,async context=>{calls++;assert.equal(context.unit,'task-write');assert.equal(context.newOrigin,origin);});assert.equal(calls,1);
});
test('actual entry refuses missing or wrong T2 kind before runner/business',async()=>{
 for(const origin of [undefined,{}, {kind:'fixed-f7-ca-asset-origin-v1'}, {kind:'t2-renewed-ca-asset-origin-v2'}]){
  let calls=0;await assert.rejects(entry('task-write',origin,async()=>{calls++;}),/T2 entry requires/);assert.equal(calls,0);
 }
});
test('actual entry retains supported T1 origin and historical no-origin behavior',async()=>{
 for(const origin of [undefined,{kind:'fixed-f7-ca-asset-origin-v1'}]){
  let calls=0;await entry('task-read',origin,async context=>{calls++;assert.equal(context.newOrigin,origin);});assert.equal(calls,1);
 }
});
test('actual entry refuses crossed unit/kind mapping',async()=>{
 for(const [unit,origin] of [['task-read',{kind:'t2-renewed-ca-asset-origin-v1'}],['search-normal',{kind:'fixed-f7-ca-asset-origin-v1'}]]){
  let calls=0;await assert.rejects(entry(unit,origin,async()=>{calls++;}),/unit\/kind differs/);assert.equal(calls,0);
 }
});
