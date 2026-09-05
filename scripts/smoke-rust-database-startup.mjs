// Run with the Node ABI matching the test-only better-sqlite3 binding. The child
// under test is the release Rust executable with an EMPTY PATH, not a TS runner.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [binary,fixture]=process.argv.slice(2);
assert.ok(binary && fixture,'usage: smoke-rust-database-startup.mjs <binary> <native-generated-step87-fixture>');
assert.ok(realpathSync(fixture).startsWith(join(repo,'.cache')+'/'),'fixture must be workspace-isolated');
const Database=createRequire(join(repo,'packages/backend/package.json'))('better-sqlite3');
const root=join(repo,'.cache/task2352/process-smoke',randomUUID());mkdirSync(root,{recursive:true});
const data=join(root,'data');cpSync(fixture,data,{recursive:true});
let sequence=0;
async function launch(dir,permission,refusal=false){
  const generation=`migration-smoke-${++sequence}`;
  const child=spawn(resolve(binary),[],{env:{
    PATH:'',RUST_LOG:'info',SILVERHAND_DATABASE_PATH:join(dir,'database.sqlite'),
    SILVERHAND_BLOBS_ROOT:join(dir,'blobs'),SILVERHAND_LOG_DIR:join(root,`logs-${sequence}`),
    SILVERHAND_LISTEN_ADDR:'127.0.0.1:0',SILVERHAND_ALLOWED_ORIGINS:'http://localhost:5173',
    SILVERHAND_DEPLOYMENT_PROFILE:'remote-only',SILVERHAND_STARTUP_GENERATION:generation,
    SILVERHAND_MIGRATE:permission,
  },stdio:['ignore','pipe','pipe']});
  let stderr='',stdout='';child.stderr.on('data',b=>stderr+=b);child.stdout.on('data',b=>stdout+=b);
  let ended=false;
  const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{ended=true;resolve({code,signal});});});
  const stop=async()=>{
    if(!ended)child.kill('SIGTERM');
    const timer=setTimeout(()=>{if(!ended)child.kill('SIGKILL');},2000);
    try{await closed;}finally{clearTimeout(timer);writeFileSync(join(root,`${generation}.log`),stderr+'\nSTDOUT\n'+stdout);}
  };
  try{
    if(refusal){
      const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
      let exit;try{exit=await closed;}finally{clearTimeout(timer);}
      assert.equal(exit.code,1);assert.match(stderr,/schema_upgrade_disabled/);
      assert.deepEqual(stdout.trim().split('\n').map(JSON.parse),[{v:2,kind:'preparing',generation}]);return;
    }
    const deadline=Date.now()+10000;
    while(stdout.trim().split('\n').length<3&&!ended&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
    const frames=stdout.trim().split('\n').map(JSON.parse);
    assert.deepEqual(frames.map(f=>f.kind),['preparing','prepared','bound']);
    assert.ok(frames.every(f=>f.v===2&&f.generation===generation));
    const frame=frames[2];
    const ready=await fetch(new URL('/readyz',frame.url));assert.equal(ready.status,200);
    const info=await fetch(new URL('/api/server/info',frame.url));assert.equal(info.status,200);
  }finally{await stop();}
}
function inspect(dir){const db=new Database(join(dir,'database.sqlite'),{readonly:true});try{
  return {step:db.prepare('SELECT MAX(version) AS step FROM _migrations').get().step,
    messages:db.prepare('SELECT id,content,seq FROM messages ORDER BY id').all(),
    users:db.prepare('SELECT id,name FROM users ORDER BY id').all(),
    sessions:db.prepare('SELECT id,token_hash FROM auth_sessions ORDER BY id').all(),
    preferences:db.prepare("SELECT scope FROM user_list_sort_mode WHERE list_key='workspaces' ORDER BY scope").all()};
}finally{db.close();}}
const before=inspect(data);assert.equal(before.step,87);assert.ok(before.messages.length>0);
await launch(data,'0',true);assert.deepEqual(inspect(data),before);
await launch(data,'1');const after=inspect(data);assert.equal(after.step,89);
for(const key of ['messages','users','sessions'])assert.deepEqual(after[key],before[key]);
assert.deepEqual(after.preferences,before.preferences.filter(x=>!['','pinned','starred'].includes(x.scope)));
const backups=readdirSync(root).filter(n=>n.startsWith('data-backup-'));assert.equal(backups.length,1);
const restored=join(root,'restored');cpSync(join(root,backups[0]),restored,{recursive:true});assert.deepEqual(inspect(restored),before);
await launch(data,'0');assert.deepEqual(inspect(data),after);
await launch(restored,'1');assert.deepEqual(inspect(restored),after);
const empty=join(root,'empty');mkdirSync(empty);await launch(empty,'0');assert.equal(inspect(empty).step,89);
console.log(JSON.stringify({pass:true,root,checks:'remote-only: disabled refusal, nonempty87→89, exact selected data preservation, restore87→89, current restart, empty startup; PATH empty; all children exited'}));
