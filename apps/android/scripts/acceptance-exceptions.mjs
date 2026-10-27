// Dedicated emulator + disposable Rust fixture only. No synthetic API responses.
import { connect } from './cdp.mjs';
import { nativeUI } from './native-ui.mjs';
import { readFileSync, writeFileSync, openSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import https from 'node:https';
import assert from 'node:assert/strict';
const serial = process.env.ANDROID_SERIAL || 'emulator-5584';
assert(serial.startsWith('emulator-'));
const root = new URL('../.generated/acceptance/', import.meta.url).pathname;
const fixture = JSON.parse(readFileSync(root + 'fixture.json'));
const ca = readFileSync(root + 'certs/ca.pem');
const packageName = 'com.silverhand.android.stage1';
const activity = packageName + '/com.silverhand.android.MainActivity';
const results = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...a) => execFileSync('adb', ['-s', serial, ...a], { encoding: 'utf8' }).trim();
let c = await connect(),
  proxyStopped = false;
const call = (method, args = {}) =>
  c.evaluate(
    `window.Capacitor.nativePromise('SilverhandClient',${JSON.stringify(method)},${JSON.stringify(args)})`,
  );
function record(name, detail) {
  results.push({ name, detail, passed: true });
  writeFileSync(root + 'exceptions.json', JSON.stringify({ status: 'running', results }, null, 2));
  console.log('PASS ' + name);
}
async function wait(expression) {
  for (let i = 0; i < 150; i++) {
    if (await c.evaluate(expression)) return;
    await delay(200);
  }
  throw Error('Timeout: ' + expression);
}
async function input(selector, value) {
  await c.evaluate(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
}
function api(path, method, body, token) {
  return new Promise((resolve, reject) => {
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
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => {
          if (res.statusCode >= 300) return reject(Error('HTTP ' + res.statusCode + ' ' + path));
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(text);
          }
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
async function login(password = fixture.password) {
  await wait(`!!document.querySelector('#auth-email')`);
  await input('#auth-email', fixture.email);
  await input('input[autocomplete="current-password"]', password);
  await c.evaluate(`document.querySelector('button[type=submit]').click()`);
  await wait(
    `document.body.innerText.includes('New project')&&!document.querySelector('#auth-email')`,
  );
  await c.evaluate(
    `location.hash=${JSON.stringify('/chat/w/' + fixture.workspace + '/c/' + fixture.channel)}`,
  );
  await wait(`!!document.querySelector('textarea')`);
}
async function screenshot(name) {
  await delay(1000);
  assert(adb('shell', 'dumpsys', 'activity', 'activities').includes(packageName));
  writeFileSync(
    root + name + '.png',
    execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p']),
  );
}
function startProxy() {
  const log = openSync(root + 'proxy.log', 'a');
  const child = spawn(
    'node',
    [new URL('./acceptance-server.mjs', import.meta.url).pathname, root + 'certs'],
    { stdio: ['ignore', log, log], detached: true },
  );
  child.unref();
  writeFileSync(root + 'proxy.pid', String(child.pid));
  proxyStopped = false;
}
async function reconnect() {
  c.close();
  for (let i = 0; i < 80; i++) {
    try {
      const pid = adb('shell', 'pidof', packageName);
      adb('forward', 'tcp:19322', 'localabstract:webview_devtools_remote_' + pid);
      c = await connect();
      if (await c.evaluate(`!!document.body`)) return;
    } catch {}
    await delay(200);
  }
  throw Error('Restart failed');
}
try {
  if (await c.evaluate(`!!document.querySelector('#auth-email')`)) await login();
  const second = await api('/auth/login', 'POST', {
    email: fixture.email,
    password: fixture.password,
  });
  const token = second.user_token;
  await screenshot('visual-before');
  // Exercise the real IME, without synthesizing input focus via JavaScript.
  await nativeUI(serial).tap((n) => n.class === 'android.widget.EditText');
  await wait(`visualViewport.height<innerHeight || document.activeElement?.tagName==='TEXTAREA'`);
  assert.match(adb('shell', 'dumpsys', 'input_method'), /mInputShown=true|isInputViewShown=true/);
  await screenshot('visual-ime');
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await delay(500);
  for (let i = 0; i < 3; i++) {
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await delay(500);
    adb('shell', 'am', 'start', '-n', activity);
    await delay(1000);
  }
  await screenshot('visual-resumed');
  assert.equal(await c.evaluate(`document.querySelectorAll('textarea').length`), 1);
  record(
    'ime-and-resume',
    'Real IME and three foreground cycles; screenshots require visual review',
  );
  const proxyPid = Number(readFileSync(root + 'proxy.pid', 'utf8'));
  assert(
    execFileSync('ps', ['-p', String(proxyPid), '-o', 'command='], { encoding: 'utf8' }).includes(
      'acceptance-server.mjs',
    ),
  );
  process.kill(proxyPid, 'SIGTERM');
  proxyStopped = true;
  await delay(800);
  let failed = false;
  try {
    await call('request', { path: '/api/me' });
  } catch {
    failed = true;
  }
  assert(failed, 'Offline request must reject');
  startProxy();
  await delay(600);
  assert.equal((await call('authState')).me.status, 200);
  const missed = 'Network recovered ' + Date.now();
  await api(`/api/channels/${fixture.channel}/messages`, 'POST', { content: missed }, token);
  await wait(`document.body.innerText.includes(${JSON.stringify(missed)})`);
  record(
    'transport-outage-recovery',
    'TLS/WSS proxy terminated, request rejected, native session retained and shared event stream recovered',
  );
  // Larger binary through actual picker and shared upload path, not a native-only shortcut.
  const bytes = Buffer.alloc(8 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  writeFileSync(root + 'stage1-large.bin', bytes);
  adb('push', root + 'stage1-large.bin', '/sdcard/Download/stage1-large.bin');
  await c.send('Runtime.evaluate', {
    expression: `document.querySelector('input[type=file]').click()`,
    userGesture: true,
  });
  await nativeUI(serial).chooseFile('stage1-large.bin');
  await wait(`document.body.innerText.includes('stage1-large.bin')`);
  await input('textarea', 'Large attachment ' + Date.now());
  await wait(
    `Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Send'&&!b.disabled)`,
  );
  await c.evaluate(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Send').click()`,
  );
  await wait(`document.querySelector('textarea').value===''`);
  let attachment;
  for (let i = 0; i < 100; i++) {
    const list = await api(`/api/channels/${fixture.channel}/attachments`, 'GET', null, token);
    attachment = list.items
      .map((a) => a.attachment || a)
      .find((a) => a.filename === 'stage1-large.bin');
    if (attachment) break;
    await delay(200);
  }
  assert(attachment);
  const download = await call('request', {
    path: `/api/attachments/${attachment.id}`,
    responseType: 'arrayBuffer',
  });
  assert(Buffer.from(download.bodyBase64, 'base64').equals(bytes));
  record(
    '8MiB-attachment',
    'Real picker/upload plus exact binary download equality; not an unlimited-size guarantee',
  );
  await c.send('Runtime.evaluate', {
    expression: `document.querySelector('input[type=file]').click()`,
    userGesture: true,
  });
  await nativeUI(serial).waitFor(
    (n) => n['content-desc'] === 'Show roots' || n.text === 'Downloads',
  );
  const oldPid = adb('shell', 'pidof', packageName);
  adb('shell', 'am', 'force-stop', packageName);
  adb('shell', 'am', 'start', '-n', activity);
  await reconnect();
  assert.notEqual(adb('shell', 'pidof', packageName), oldPid);
  await wait(`document.body.innerText.includes('New project')`);
  assert.equal((await call('authState')).me.status, 200);
  await c.evaluate(
    `location.hash=${JSON.stringify('/chat/w/' + fixture.workspace + '/c/' + fixture.channel)}`,
  );
  await wait(`!!document.querySelector('textarea')`);
  await c.evaluate(
    `window.__cancel=null;window.Capacitor.nativePromise('SilverhandClient','saveAttachment',{filename:'post-restart.bin',base64:'AA=='}).then(x=>window.__cancel=x);true`,
  );
  await nativeUI(serial).waitFor((n) => n.text === 'SAVE');
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await wait(`window.__cancel!==null`);
  assert.equal((await c.evaluate('window.__cancel')).completed, false);
  record(
    'picker-process-death',
    'Killed app while picker active; restored session and new file operation completed cancellation without a stale pending lock',
  );
  const newPassword = fixture.password + '-changed';
  await api(
    '/api/me/password',
    'POST',
    { current_password: fixture.password, new_password: newPassword },
    token,
  );
  // Real server revokes sessions; authState also covers the HTTP invalidation path.
  try {
    await call('authState');
  } catch {}
  await wait(`!!document.querySelector('#auth-email')`);
  const state = await call('authState');
  assert(!state.me);
  record(
    'server-session-revocation',
    'Second client changes password; native token invalidated and actual login page restored',
  );
  fixture.password = newPassword;
  writeFileSync(root + 'fixture.json', JSON.stringify(fixture), { mode: 0o600 });
  await login(newPassword);
  await c.evaluate(`location.hash='/settings?settingsSection=account'`);
  await wait(
    `Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Log out')`,
  );
  await c.evaluate(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Log out').click()`,
  );
  await wait(`!!document.querySelector('#auth-email')`);
  record(
    'reauthenticate-after-revocation',
    'New password login and real settings logout still work',
  );
  writeFileSync(root + 'exceptions.json', JSON.stringify({ status: 'passed', results }, null, 2));
} catch (error) {
  writeFileSync(
    root + 'exceptions.json',
    JSON.stringify({ status: 'failed', results, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  if (proxyStopped) startProxy();
  c.close();
}
