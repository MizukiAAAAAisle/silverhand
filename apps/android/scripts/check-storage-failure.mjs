// Corrupt only the dedicated acceptance app's encrypted record, then restore it.
import { connect } from './cdp.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const serial = process.env.ANDROID_SERIAL || 'emulator-5584';
assert(serial.startsWith('emulator-'));
const pkg = 'com.silverhand.android.stage1',
  activity = pkg + '/com.silverhand.android.MainActivity';
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8' }).trim();
const original = execFileSync('adb', [
  '-s',
  serial,
  'exec-out',
  'run-as',
  pkg,
  'cat',
  'no_backup/session-v1.bin',
]);
assert(original.length > 28);
const corrupt = Buffer.from(original);
corrupt[20] ^= 1;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function reconnect() {
  for (let i = 0; i < 100; i++) {
    try {
      const pid = adb('shell', 'pidof', pkg);
      adb('forward', 'tcp:19322', 'localabstract:webview_devtools_remote_' + pid);
      const c = await connect();
      if (await c.evaluate('!!document.body')) return c;
      c.close();
    } catch {}
    await delay(200);
  }
  throw Error('App did not restart');
}
function write(bytes) {
  execFileSync(
    'adb',
    ['-s', serial, 'shell', 'run-as', pkg, 'sh', '-c', "'cat > no_backup/session-v1.bin'"],
    { input: bytes },
  );
}
let c;
try {
  adb('shell', 'am', 'force-stop', pkg);
  write(corrupt);
  adb('shell', 'am', 'start', '-n', activity);
  c = await reconnect();
  let body = '';
  for (let i = 0; i < 100; i++) {
    body = await c.evaluate('document.body.innerText');
    if (body.startsWith('Unable to start Silverhand:')) break;
    await delay(100);
  }
  assert(body.startsWith('Unable to start Silverhand:'));
  assert.equal(await c.evaluate("!!document.querySelector('textarea')"), false);
  writeFileSync(
    new URL('../.generated/acceptance/storage-failure.json', import.meta.url),
    JSON.stringify(
      {
        status: 'passed',
        scenario:
          'AES-GCM record tamper rejected; no authenticated UI; original encrypted bytes restored in finally',
      },
      null,
      2,
    ),
  );
  console.log('PASS storage tamper rejected');
} finally {
  c?.close();
  adb('shell', 'am', 'force-stop', pkg);
  write(original);
  adb('shell', 'am', 'start', '-n', activity);
}
