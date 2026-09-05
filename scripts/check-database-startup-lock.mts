// Isolated integration check for the actual Rust preparation owner and retained TS runner.
// Rust's test-only barrier is not compiled into the release artifact.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from '../packages/backend/src/db';

const [mode, first, second] = process.argv.slice(2);
if (mode === 'ts') {
  if (second === 'copy') {
    const fs = require('node:fs');
    const copy = fs.copyFileSync;
    fs.copyFileSync = (...args: unknown[]) => {
      fs.copyFileSync = copy;
      process.stdout.write('PREPARATION_PAUSED:ts-copy\n');
      readSync(0, Buffer.alloc(1), 0, 1, null);
      return copy(...args);
    };
  }
  const db = openDatabase(first!, { allowSchemaUpgrade: true, onMigrationResult: second === 'hold' ? () => {
    process.stdout.write('PREPARATION_PAUSED:ts\n');
    readSync(0, Buffer.alloc(1), 0, 1, null);
  } : undefined });
  assert.equal(db.pragma('locking_mode', {simple:true}), 'normal');
  assert.equal(db.pragma('foreign_keys', {simple:true}), 1);
  db.close();
} else if (mode === 'wal') {
  const db = new Database(first!);
  db.pragma('journal_mode=WAL');db.pragma('wal_autocheckpoint=0');
  db.exec("CREATE TABLE lock_wal_evidence(value TEXT); INSERT INTO lock_wal_evidence VALUES ('committed'); BEGIN; INSERT INTO lock_wal_evidence VALUES ('uncommitted');");
  process.stdout.write('PREPARATION_PAUSED:wal\n');
  readSync(0,Buffer.alloc(1),0,1,null);
  db.close();
} else {
  void run(first!, second!).catch(error => { console.error(error); process.exitCode = 1; });
}

async function run(rustTestBinary: string, oldFixture: string) {
  const repo = resolve(__dirname, '../..'); // emitted into .cache/task2352
  const root = mkdtempSync(join(repo, '.cache/task2352/cross-lock-'));
  const env = {...process.env, NODE_PATH: join(repo, 'packages/backend/node_modules')};
  const children = new Set<ReturnType<typeof spawn>>();
  function child(command: string, args: string[], extra: Record<string,string> = {}) {
    const proc = spawn(command, args, {env:{...env,...extra}, stdio:['pipe','pipe','pipe']});
    children.add(proc);
    let output = '';
    proc.stdout!.on('data', b => {output += b;});
    proc.stderr!.on('data', b => {output += b;});
    const closed = once(proc, 'close').then(([code,signal]) => ({code,signal,output}));
    return {proc,closed,output:()=>output};
  }
  function rust(path: string, phase = '') {
    return child(rustTestBinary, ['--exact','foundation::database_startup::tests::preparation_subprocess_owner','--nocapture'], {
      SILVERHAND_TEST_PREPARATION_DB:path, SILVERHAND_TEST_PREPARATION_PHASE:phase,
    });
  }
  function ts(path: string, hold = '') { return child(process.execPath, [__filename,'ts',path,hold]); }
  async function paused(owner: ReturnType<typeof rust>) {
    const deadline = Date.now()+15_000;
    while (!owner.output().includes('PREPARATION_PAUSED:') && Date.now()<deadline) {
      if(owner.proc.exitCode !== null) break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.match(owner.output(), /PREPARATION_PAUSED:/);
  }
  function fixture(label: string, empty=false) {
    const dir=join(root,label,'data');mkdirSync(dir,{recursive:true});
    if(!empty) cpSync(oldFixture,dir,{recursive:true});
    writeFileSync(join(dir,'backup-test-file'),'retained');
    return join(dir,'database.sqlite');
  }
  function step(path: string) {
    const db=new Database(path,{readonly:true});try{return db.prepare('SELECT MAX(version) AS n FROM _migrations').get() as {n:number};}finally{db.close();}
  }
  try {
    // Both directions: the rejected runner must not even create another backup.
    for(const [direction,phase] of [['rust-ts','backing-up'],['rust-ts','backed-up'],['rust-ts','between-steps'],['ts-rust','copy'],['ts-rust','hold'],['rust-rust','backed-up']]) {
      const path=fixture(`${direction}-${phase}`);
      const wal=child(process.execPath,[__filename,'wal',path]);await paused(wal);
      wal.proc.kill('SIGKILL');await wal.closed;
      const owner=direction==='ts-rust'?ts(path,phase):rust(path,phase);
      await paused(owner);
      const before=readdirSync(resolve(path,'../..')).sort();
      const contender=direction==='rust-ts'?ts(path):rust(path);
      const rejected=await contender.closed;
      assert.notEqual(rejected.code,0,JSON.stringify({direction, owner:owner.output(), contender:rejected.output}));
      assert.match(rejected.output,/locked|SqliteError|code: "5"/i);
      assert.deepEqual(readdirSync(resolve(path,'../..')).sort(),before);
      owner.proc.stdin!.end('\n');
      const released=await owner.closed;assert.equal(released.code,0,released.output);
      assert.equal(step(path).n,88);
      const backup=readdirSync(resolve(path,'../..')).find(x=>x.includes('-backup-')&&!x.endsWith('.partial'));assert.ok(backup);
      assert.equal(step(join(resolve(path,'../..'),backup,'database.sqlite')).n,87);
      const snapshot=new Database(join(resolve(path,'../..'),backup,'database.sqlite'),{readonly:true});
      try {assert.deepEqual(snapshot.prepare('SELECT value FROM lock_wal_evidence').all(),[{value:'committed'}]);} finally {snapshot.close();}
      assert.ok(!readdirSync(join(resolve(path,'../..'),backup)).some(x=>/-wal$|-shm$|-journal$/.test(x)));
      console.log(JSON.stringify({direction,phase,exclusion:true,noContenderBackup:true,backupRestoresStep:87,committedWalOnly:true}));
    }
    for(const empty of [false,true]) {
      const path=fixture(empty?'empty-kill':'old-kill',empty);
      const owner=rust(path,empty?'between-steps':'backed-up');await paused(owner);
      owner.proc.kill('SIGKILL');await owner.closed;
      const restarted=rust(path);const result=await restarted.closed;
      assert.equal(result.code,0,result.output);assert.equal(step(path).n,88);
      console.log(JSON.stringify({empty,strongKillRestart:true,noManualUnlock:true}));
    }
    console.log(JSON.stringify({root,allPassed:true}));
  } finally {
    for(const proc of children) if(proc.exitCode===null&&proc.signalCode===null) proc.kill('SIGKILL');
    await Promise.all([...children].filter(p=>p.exitCode===null&&p.signalCode===null).map(p=>once(p,'close')));
  }
}
