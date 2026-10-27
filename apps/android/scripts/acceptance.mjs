// Run only against the dedicated emulator and disposable local Rust server.
import { connect } from './cdp.mjs';
import { nativeUI } from './native-ui.mjs';
import https from 'node:https';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { runB1 } from './acceptance-b1.mjs';
import { runB2 } from './acceptance-b2.mjs';
import { runB3, b3ScenarioKey } from './acceptance-b3.mjs';
import { AcceptanceRecord } from './acceptance-record.mjs';
const serial = process.env.ANDROID_SERIAL || 'emulator-5584';
assert(serial.startsWith('emulator-'));
const root = process.env.SILVERHAND_ANDROID_RUN_ROOT
  ? resolve(process.env.SILVERHAND_ANDROID_RUN_ROOT, 'acceptance') + '/'
  : new URL('../.generated/acceptance/', import.meta.url).pathname;
const ca = readFileSync(root + 'certs/ca.pem');
const suite = process.argv[2] ?? 'original12';
assert(['original12', 'b2', 'b3'].includes(suite), 'Unknown acceptance suite');
const unit = suite === 'b3' ? process.argv[4] : undefined;
const selection = suite === 'b3' ? process.argv[5] : undefined;
const scenarioKey = suite === 'b3' ? b3ScenarioKey(unit,selection) : undefined;
const diagnostic = suite === 'b3' ? undefined : process.argv[4];
assert(diagnostic === undefined || (suite === 'b2' && ['appearance-startup', 'appearance-short', 'photo-picker-menu', 'coverage-short', 'coverage-bars', 'coverage-b1'].includes(diagnostic)), 'Unknown diagnostic selection');
const out = process.argv[3] ?? root;
mkdirSync(out, { recursive: true });
const table = JSON.parse(readFileSync(new URL('./acceptance-scenarios.json', import.meta.url)));
const active = suite === 'b3' ? [...table.B3[scenarioKey].preconditions, ...table.B3[scenarioKey].cases] : diagnostic ? table.diagnostics[diagnostic] : [
  ...table.original12,
  ...(suite === 'b2'
    ? [
        ...table.B2.filter((row) => row.scope === 'device').map((row) => 'B2.' + row.id),
        ...table.B1_affected.map((i) => 'B1.' + table.B1[i - 1]),
      ]
    : []),
];
function coverageMetadata(table, diagnostic) {
  if (!['coverage-short','coverage-bars','coverage-b1'].includes(diagnostic)) return null;
  const full=[...table.original12,...table.B2.filter(row=>row.scope==='device').map(row=>'B2.'+row.id),...table.B1_affected.map(i=>'B1.'+table.B1[i-1])], selected=table.diagnostics[diagnostic];
  return {kind:'grouped',selector:diagnostic,planned:selected.length,selected_ids:selected,ordinary33_count:full.length,ordinary33_selected:full.filter(id=>selected.includes(id)),ordinary33_not_selected:full.filter(id=>!selected.includes(id)),partial_of:table.coverage_partial?.[diagnostic]??null,group_counts_not_aggregated:true};
}
function groupedB1Observation(report, root, table) {
  let prepared=false;
  return (name,value)=>{
    report.observe(name,value);
    if(name!=='continuation-preconditions.json')return;
    assert(!prepared,'Repeated B1 initialization observation');
    const current=JSON.parse(readFileSync(root+'b1-fixture.json'));
    assert(typeof current.workspace==='string'&&current.workspace&&typeof current.channel==='string'&&current.channel,'B1 fixture identity missing');
    assert.equal(value.route,'#/chat/w/'+current.workspace+'/c/'+current.channel,'B1 initialization route does not match current fixture');
    assert.deepEqual(value.selectedCases,table.B1_affected,'B1 initialization case set changed');
    assert(value.freshFixture===true&&value.historicalPassesUsed===false,'B1 initialization fixture provenance changed');
    assert(Number.isSafeInteger(value.identity?.activity)&&value.identity.activity>=0&&Number.isSafeInteger(value.identity?.webViewIdentity)&&value.identity.webViewIdentity>=0,'B1 initialization identity missing');
    prepared=true;
    report.pass('DIAG.b1-preconditions',{route:value.route,selectedCases:value.selectedCases,identity:value.identity,credit:'readiness only; no B1 functional case credited',source:'existing runB1 instrumentation/fixture/reconnect/React login and textarea checks before this observation'});
  };
}
const report = new AcceptanceRecord(out, active);
let newOrigin;
if (suite === 'b3') {
  assert(report.data.suite === 'b3' && report.data.unit === unit, 'B3 requires its independent workflow binding');
  assert.equal(report.data.selection?.selector, selection, 'B3 fixed selection changed');
  assert.deepEqual(report.data.selection?.selected_ids, active, 'B3 selected cases changed');
  assert(report.data.bindings?.packages?.product && report.data.bindings?.reviewed_binding, 'Missing B3 package/source binding');
  newOrigin = report.data.bindings?.product_origin ?? undefined;
  const originKinds = { 'task-read': 'fixed-f7-ca-asset-origin-v1', 'task-write': 't2-renewed-ca-asset-origin-v1' };
  assert(unit !== 'task-write' || newOrigin?.kind === originKinds['task-write'], 'T2 entry requires its new product origin');
  if (newOrigin) assert(Object.hasOwn(originKinds, unit) && newOrigin.kind === originKinds[unit], 'B3 entry origin unit/kind differs');
}
const coverage=coverageMetadata(table,diagnostic);
if(coverage) assert.deepEqual(report.data.coverage,coverage,'Coverage metadata must match reviewed entry');
const startupDiagnostic = diagnostic === 'appearance-startup' ? report.data.bindings?.startup_diagnostic : undefined;
if (diagnostic === 'appearance-startup') assert(startupDiagnostic?.kind === diagnostic && startupDiagnostic.nonce, 'Missing isolated diagnostic binding');
if (['appearance-short', 'photo-picker-menu', 'coverage-short', 'coverage-bars', 'coverage-b1'].includes(diagnostic))
  assert(report.data.bindings?.packages?.product && !report.data.bindings?.startup_diagnostic, 'Diagnostic requires the ordinary product binding');
const results = [];
function adb(...args) {
  return execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', ...(suite === 'b3' ? { timeout: 10000 } : {}) }).trim();
}
function record(name, detail) {
  results.push({ name, detail, passed: true });
  report.pass(name, detail);
  console.log('PASS ' + name);
}
function api(path, method = 'GET', body, token) {
  return new Promise((ok, no) => {
    const req = https.request(
      'https://localhost:29443' + path,
      {
        method,
        ca,
        headers: {
          'content-type': 'application/json',
          'x-silverhand-desktop-api-epoch': '4',
          ...(token ? { authorization: 'Bearer ' + token } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 300)
            return no(Error(path + ' HTTP ' + res.statusCode + ' ' + data));
          try {
            ok(JSON.parse(data));
          } catch {
            ok(data);
          }
        });
      },
    );
    if (suite === 'b3') req.setTimeout(10000, () => req.destroy(Error('B3 fixture API timeout: ' + path)));
    req.on('error', no);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const stamp = Date.now();
const email = `android${stamp}@example.test`;
const password = 'Stage1-Isolated-Only!';
const user = await api('/auth/signup', 'POST', { email, name: `android${stamp}`, password }).catch(error => { if (suite === 'b3') report.fail(error); throw error; });
const token = user.user_token;
assert(token, 'Signup must provide fixture token');
const wb = suite === 'b3' ? {} : await api('/api/workspaces', 'POST', { name: 'Android Stage 1 ' + stamp }, token);
const workspace = wb.workspace || wb;
const cb = suite === 'b3' ? {} : await api(
  `/api/workspaces/${workspace.id}/channels`,
  'POST',
  { title: 'Stage 1 closed loop' },
  token,
);
const channel = cb.channel || cb;
const path = `/api/channels/${channel.id}/messages`;
if (suite !== 'b3') await api(path, 'POST', { content: 'Seed history ' + stamp }, token);
const fixture = { email, password, workspace: workspace.id, channel: channel.id, ...(suite === 'b3' ? { userId: user.user.id } : {}) };
// Disposable credentials stay in ignored evidence, never committed or printed.
writeFileSync(suite === 'b3' ? out + '/fixture-private.json' : root + 'fixture.json', JSON.stringify(fixture), { mode: 0o600 });
async function reconnect() {
  c.close();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const pid = adb('shell', 'pidof', 'com.silverhand.android.stage1');
      adb('forward', 'tcp:19322', 'localabstract:webview_devtools_remote_' + pid);
      c = await connect();
      return c;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw Error('WebView reconnect timeout');
}
async function waitPersisted(text) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (JSON.stringify(await api(path, 'GET', undefined, token)).includes(text)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error('Message did not persist: ' + text);
}
let c = await connect().catch(error => { if (suite === 'b3') report.fail(error); throw error; });
const wait = async (expression) => {
  for (let i = 0; i < 150; i++) {
    if (await c.evaluate(expression)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error(
    'UI timed out: ' +
      expression +
      ' BODY ' +
      (await c.evaluate('(document.body?.innerText ?? "")')),
  );
};
const call = (method, args = {}) =>
  c.evaluate(
    `window.Capacitor.nativePromise('SilverhandClient',${JSON.stringify(method)},${JSON.stringify(args)})`,
  );
const input = async (selector, value) => {
  await c.evaluate(
    `(()=>{const f=document.querySelector(${JSON.stringify(selector)}); if(!f)throw Error('Missing field');Object.getOwnPropertyDescriptor(f.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(f,${JSON.stringify(value)});f.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
};
try {
  await call('clearProfile');
  await call('saveProfile', { serverUrl: 'https://localhost:29443' });
  await c.evaluate('location.reload()');
  await wait(`!!document.querySelector('#auth-email')`);
  await input('#auth-email', email);
  await input('input[autocomplete="current-password"]', password);
  await c.evaluate(`document.querySelector('button[type=submit]').click()`);
  await wait(
    `(document.body?.innerText ?? "").includes('New project') && !document.querySelector('#auth-email')`,
  );
  if (suite === 'b3') {
    await runB3({ c, api, call, adb, input, serial, out, token, fixture, unit, selection, newOrigin, step: (...args) => report.step(...args), observe: (...args) => report.observe(...args) });
  } else {
  await c.evaluate(
    `location.hash=${JSON.stringify('/chat/w/' + workspace.id + '/c/' + channel.id)}`,
  );
  await wait(
    `(document.body?.innerText ?? "").includes(${JSON.stringify('Seed history ' + stamp)}) && !!document.querySelector('textarea')`,
  );
  record(diagnostic ? 'DIAG.real-page-login' : 'real-page-login', 'Shared React auth form → Capacitor → Kotlin → JNI → Swift → Rust');
  }
  if (!diagnostic && suite !== 'b3') {
  const outgoing = 'Android UI sent ' + stamp;
  await input('textarea', outgoing);
  await c.evaluate(
    `document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}))`,
  );
  await wait(
    `(document.body?.innerText ?? "").includes(${JSON.stringify(outgoing)}) && document.querySelector('textarea').value===''`,
  );
  await waitPersisted(outgoing);
  record('message-send', 'Real composer and persisted backend history');
  const incoming = 'Other client live ' + stamp;
  await api(path, 'POST', { content: incoming }, token);
  await wait(`(document.body?.innerText ?? "").includes(${JSON.stringify(incoming)})`);
  record('message-receive', 'Server event received by active shared React conversation');
  const bytes = Buffer.concat([
    Buffer.from([0, 255, 128]),
    Buffer.from('Stage1 attachment 中文\n' + stamp),
  ]);
  const local = root + 'stage1-attachment.bin';
  writeFileSync(local, bytes);
  adb('push', local, '/sdcard/Download/stage1-attachment.bin');
  await c.send('Runtime.evaluate', {
    expression: 'document.querySelector("input[type=file]").click()',
    userGesture: true,
  });
  await nativeUI(serial).chooseFile('stage1-attachment.bin');
  await wait(`(document.body?.innerText ?? "").includes('stage1-attachment.bin')`);
  await input('textarea', 'Attachment message ' + stamp);
  await wait(
    `Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Send' && !b.disabled)`,
  );
  await c.evaluate(
    `document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}))`,
  );
  await wait(`document.querySelector('textarea').value===''`);
  await waitPersisted('Attachment message ' + stamp);
  const history = await api(path, 'GET', undefined, token);
  report.observe('original-message-history', history);
  record(
    'attachment-ui-send',
    'File input → shared upload logic → native multipart → Rust; byte check follows',
  );
  // Identify uploaded attachment through real channel API, then binary native proxy.
  const listing = await api(`/api/channels/${channel.id}/attachments`, 'GET', undefined, token);
  report.observe('original-attachment-list', listing);
  const candidates = listing.attachments || listing.items || listing;
  assert(Array.isArray(candidates), 'Unknown attachment list shape');
  const attachment = candidates
    .map((a) => a.attachment || a)
    .find((a) => (a.filename || a.name) === 'stage1-attachment.bin');
  assert(attachment, 'Uploaded attachment missing');
  const binary = await call('request', {
    path: `/api/attachments/${attachment.id}`,
    responseType: 'arrayBuffer',
  });
  assert.equal(binary.status, 200);
  assert.deepEqual(Buffer.from(binary.bodyBase64, 'base64'), bytes);
  record('attachment-byte-roundtrip', 'Upload and binary download exact byte equality');
  const exportName = `stage1-saved-${stamp}.bin`;
  await c.evaluate(
    `window.__stage1Export=null; window.Capacitor.nativePromise('SilverhandClient','saveAttachment',${JSON.stringify({ filename: exportName, base64: bytes.toString('base64') })}).then(x=>window.__stage1Export=x,e=>window.__stage1Export={error:String(e)});true`,
  );
  await nativeUI(serial).tap((n) => n['resource-id'] === 'android:id/button1' && n.text === 'SAVE');
  await wait('window.__stage1Export !== null');
  assert.deepEqual(await c.evaluate('window.__stage1Export'), { completed: true });
  assert.deepEqual(
    execFileSync('adb', ['-s', serial, 'exec-out', 'cat', '/sdcard/Download/' + exportName]),
    bytes,
  );
  record('system-file-save', 'ACTION_CREATE_DOCUMENT completed and exported bytes match');
  await c.evaluate(
    `window.__stage1Cancel=null; window.Capacitor.nativePromise('SilverhandClient','saveAttachment',{filename:'cancel-me.bin',base64:'AA=='}).then(x=>window.__stage1Cancel=x);true`,
  );
  await nativeUI(serial).waitFor(
    (n) => n['resource-id'] === 'android:id/button1' && n.text === 'SAVE',
  );
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await wait('window.__stage1Cancel !== null');
  assert.deepEqual(await c.evaluate('window.__stage1Cancel'), { completed: false });
  record('system-file-cancel', 'Cancel resolves completed=false, not success');

  await c.evaluate('window.__stage1ResumeMarker=42');
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await new Promise((r) => setTimeout(r, 700));
  const resumed = 'While background ' + stamp;
  await api(path, 'POST', { content: resumed }, token);
  adb(
    'shell',
    'am',
    'start',
    '-n',
    'com.silverhand.android.stage1/com.silverhand.android.MainActivity',
  );
  await wait(`(document.body?.innerText ?? "").includes(${JSON.stringify(resumed)})`);
  const liveAgain = 'Live after resume ' + stamp;
  await api(path, 'POST', { content: liveAgain }, token);
  await wait(`(document.body?.innerText ?? "").includes(${JSON.stringify(liveAgain)})`);
  assert.equal(await c.evaluate('window.__stage1ResumeMarker'), 42);
  record('background-resume', 'History refresh and renewed live events without page replacement');
  await new Promise((r) => setTimeout(r, 1000)); // Let the native Activity transition settle before visual evidence.
  writeFileSync(
    out + '/original12-closed-loop.png',
    execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p']),
  );
  // Persisted credentials must remain native-only.
  const webState = await c.evaluate(
    'JSON.stringify({local:{...localStorage},session:{...sessionStorage}})',
  );
  assert(!webState.includes(token));
  assert(!webState.includes(password));
  assert.equal(
    await c.evaluate(
      `Object.keys({...localStorage,...sessionStorage}).some(k=>/token|password/i.test(k))`,
    ),
    false,
  );
  assert(!JSON.stringify(await call('getProfile')).includes('token'));
  const disk = adb('shell', 'run-as', 'com.silverhand.android.stage1', 'ls', 'no_backup');
  assert(disk.includes('session-v1.bin'));
  const encrypted = execFileSync('adb', [
    '-s',
    serial,
    'exec-out',
    'run-as',
    'com.silverhand.android.stage1',
    'cat',
    'no_backup/session-v1.bin',
  ]);
  assert(!encrypted.includes(Buffer.from('https://localhost:29443')));
  assert(!encrypted.includes(Buffer.from('serverURL')));
  record(
    'credential-boundary',
    'Token absent from browser storage; native encrypted record exists',
  );
  let tlsError = '';
  try {
    await call('saveProfile', { serverUrl: 'https://127.0.0.1:29443' });
  } catch (error) {
    tlsError = String(error);
  }
  assert.match(tlsError, /SSL|certificate|secure connection/i);
  assert.equal((await call('getProfile')).server_url, 'https://localhost:29443');
  record('tls-hostname-negative', 'Mismatched certificate rejected; active server unchanged');
  const oldPid = adb('shell', 'pidof', 'com.silverhand.android.stage1');
  c.close();
  adb('shell', 'am', 'force-stop', 'com.silverhand.android.stage1');
  adb(
    'shell',
    'am',
    'start',
    '-n',
    'com.silverhand.android.stage1/com.silverhand.android.MainActivity',
  );
  let restored = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const pid = adb('shell', 'pidof', 'com.silverhand.android.stage1');
      assert.notEqual(pid, oldPid);
      adb('forward', 'tcp:19322', 'localabstract:webview_devtools_remote_' + pid);
      c = await connect();
      restored = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  assert(restored, 'WebView did not restart');
  await wait(`(document.body?.innerText ?? "").includes('New project')`);
  assert.equal((await call('authState')).me.status, 200);
  await c.evaluate(
    `location.hash=${JSON.stringify('/chat/w/' + workspace.id + '/c/' + channel.id)}`,
  );
  await wait(`(document.body?.innerText ?? "").includes(${JSON.stringify(outgoing)})`);
  record(
    'process-restart',
    'Different process PID restored encrypted native session and real conversation',
  );
  }
  if (suite === 'b2' && diagnostic !== 'coverage-b1')
    await runB2({
      c,
      reconnect,
      api,
      call,
      input,
      wait,
      adb,
      serial,
      root,
      out,
      token,
      fixture,
      path,
      channelUrl: '/chat/w/' + workspace.id + '/c/' + channel.id,
      step: (...args) => report.step(...args),
      observe: (...args) => report.observe(...args),
      startupDiagnostic,
      diagnostic,
    });
  if (suite !== 'b3' && (!diagnostic || diagnostic === 'coverage-b1')) {
  const logout = async () => {
  await c.evaluate("location.hash='/settings?settingsSection=account'");
  await wait(
    `Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Log out')`,
  );
  await c.evaluate(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Log out').click()`,
  );
  await wait(`!!document.querySelector('#auth-email')`);
  const state = await call('authState');
  assert(!state.me || state.me.status !== 200);
    return 'Native credential cleared and shared login page restored';
  };
  if (diagnostic === 'coverage-b1') await report.step('DIAG.logout-before-b1', logout);
  else record('logout', await logout());
  if (suite === 'b2') {
    await runB1(
      {
        run: resolve(root, '..'),
        out,
        reconnect: async () => {
          try { return await reconnect(); }
          finally { c = null; } // Prior client closed; runB1 owns any returned client.
        },
        step: (...args) => report.step(...args),
        observe: diagnostic === 'coverage-b1' ? groupedB1Observation(report, root, table) : (...args) => report.observe(...args),
      },
      table.B1_affected,
    );
  }
  }
  report.complete();
} catch (error) {
  report.fail(error);
  throw error;
} finally {
  c?.close();
}
