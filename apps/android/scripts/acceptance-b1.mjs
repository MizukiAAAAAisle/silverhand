// Reuses the B1 accepted case bodies; B2 selects affected cases, never historical passes.
import { connect } from './cdp.mjs';
import https from 'node:https';
import { nativeUI } from './native-ui.mjs';
import { readFileSync, writeFileSync as writeFile } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
// One normal click only. No observer, screenshot, timer or retry between down/up.
async function adjacentPointerClick(client, point) {
  const events = [];
  const mark = (stage) => events.push({ stage, at: new Date().toISOString() });
  try {
    mark('press_sent');
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      clickCount: 1,
      ...point,
    });
    mark('press_ack');
    mark('release_sent');
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      ...point,
    });
    mark('release_ack');
    return { completed: true, events };
  } catch (error) {
    error.pointerTrace = {
      completed: false,
      events,
      errorType: error.constructor.name,
      error: String(error),
    };
    throw error;
  }
}

function assertRestored(record, baseline, { route, identity, value }) {
  const w = record.web,
    o = w.observed;
  assert(
    o.connected && o.rendered && !o.inert,
    'Restoration requires a live rendered current composer',
  );
  assert(
    o.visibility?.visible &&
      o.visibility.cssVisible &&
      o.visibility.clippedIntersection.areaCssPx2 > 0,
    'Restoration requires actual visible composer intersection',
  );
  assert(!w.focus.inComposer && !o.focusWithin, 'Focus has not left composer');
  assert.equal(w.route, route, 'Restoration route differs from action contract');
  assert.equal(record.identitySha256, identity, 'Authenticated identity changed');
  assert.equal(o.value, value, 'Composer content changed');
  assert.deepEqual(
    o.styles,
    baseline.web.observed.styles,
    'Composer styles did not restore to baseline',
  );
}

function beforeLayer(layer, state) {
  assert(['ime', 'modal'].includes(layer), 'Unknown Back layer');
  assert.equal(typeof state.native.imeVisible, 'boolean', 'Native IME state missing');
  assert.equal(state.web.dialogs, 1, 'Exactly one visible modal required');
  assert.equal(
    state.native.imeVisible,
    layer === 'ime',
    'Wrong IME state for requested Back layer',
  );
  assert.equal(state.web.authenticated, true, 'Authenticated fixture required');
  assert.equal(typeof state.web.identitySha256, 'string', 'Authenticated identity missing');
  assert(state.web.identitySha256.length > 0, 'Authenticated identity missing');
}
function afterLayer(layer, before, after) {
  beforeLayer(layer, before);
  assert.equal(after.native.imeVisible, false, 'Back did not leave IME hidden');
  assert.equal(after.web.dialogs, layer === 'ime' ? 1 : 0, 'Wrong modal result for Back layer');
  assert.equal(after.web.route, before.web.route, 'Back changed route');
  assert.equal(after.native.activity, before.native.activity, 'Unexpected Activity replacement');
  assert.equal(after.web.authenticated, true, 'Back lost authenticated identity');
  assert.equal(
    after.web.identitySha256,
    before.web.identitySha256,
    'Back changed authenticated user',
  );
}

export async function runB1(context, selected) {
  const { run, out } = context;
  function writeFileSync(path, value, options) {
    if (path.endsWith('.json') && path.startsWith(out + '/'))
      context.observe(path.slice(out.length + 1), JSON.parse(value));
    else if (path.endsWith('.log') && path.startsWith(out + '/'))
      context.observe(path.slice(out.length + 1), { text: value });
    else writeFile(path, value, options);
  }
  let protocol = '';
  let spawnError = null;
  let primaryError = null;
  const child = spawn(
    process.env.ANDROID_HOME + '/platform-tools/adb',
    [
      '-s',
      'emulator-5584',
      'shell',
      'am',
      'instrument',
      '-w',
      '-r',
      'com.silverhand.android.stage1.test/com.silverhand.android.B1Instrumentation',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const exited = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => {
      spawnError = error;
      resolve({ code: null, error: String(error) });
    });
  });
  for (const pipe of [child.stdout, child.stderr])
    pipe.on('data', (data) => {
      protocol += data;
      process.stdout.write(data);
    });
  try {
    const deadline = Date.now() + 60000;
    while (!protocol.includes('B1_DEVICE_CONTROL_READY')) {
      if (spawnError || child.exitCode !== null || Date.now() > deadline)
        throw Error('B1 instrumentation did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const adbBin = process.env.ANDROID_HOME + '/platform-tools/adb',
      serial = 'emulator-5584',
      pkg = 'com.silverhand.android.stage1';
    const adb = (...args) =>
      execFileSync(adbBin, ['-s', serial, ...args], { encoding: 'utf8', timeout: 30000 }).trim();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ca = readFileSync(run + '/acceptance/certs/ca.pem');
    const names = [
      'actual-activity-identity',
      'native-chinese-composition-selection-send',
      'legacy-ime229-no-send',
      'visible-ime-and-back-priority',
      'modal-back-once',
      'panel-page-back-once',
      'page-touchcancel-no-navigation',
      'system-back-gesture-cancel',
      'system-back-gesture-commit',
      'rotation-font-ime-layout',
      'actual-recreate-session-events',
      'root-background-session',
    ];
    let c;
    let seq = 0;
    async function test(name, fn) {
      if (!selected.includes(names.indexOf(name) + 1)) return;
      await context.step('B1.' + name, fn);
    }
    function api(path, method = 'GET', body, token) {
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
            let data = '';
            res.on('data', (x) => (data += x));
            res.on('end', () => {
              if (res.statusCode >= 300) return reject(Error(path + ' HTTP ' + res.statusCode));
              try {
                resolve(JSON.parse(data));
              } catch {
                resolve(data);
              }
            });
          },
        );
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
      });
    }
    async function control(operation, fields = {}) {
      const id = String(++seq) + '-' + randomUUID();
      const request = { id, operation, ...fields };
      execFileSync(
        adbBin,
        [
          '-s',
          serial,
          'shell',
          `run-as ${pkg} sh -c 'cat > files/b1-request.tmp && mv files/b1-request.tmp files/b1-request.json'`,
        ],
        { input: JSON.stringify(request), timeout: 10000 },
      );
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        try {
          const reply = JSON.parse(adb('exec-out', 'run-as', pkg, 'cat', 'files/b1-response.json'));
          if (reply.id === id) {
            writeFileSync(
              out + '/control-' + String(seq).padStart(3, '0') + '.json',
              JSON.stringify({ request, response: reply }, null, 2),
            );
            assert(reply.ok, reply.error);
            if (operation.startsWith('ime-')) {
              const r = reply.result;
              assert.equal(
                r.connectionActivity,
                r.activity,
                'InputConnection Activity owner mismatch',
              );
              assert.equal(
                r.connectionWebView,
                r.webView,
                'InputConnection WebView owner mismatch',
              );
              assert(
                r.generation > 0 && Number.isInteger(r.connection),
                'InputConnection identity missing',
              );
              if (operation !== 'ime-show')
                assert.equal(r.accepted, true, 'IME action rejected: ' + operation);
            }
            return reply.result;
          }
        } catch (error) {
          if (String(error).includes('AssertionError')) throw error;
        }
        await sleep(100);
      }
      throw Error('Device control timeout: ' + operation);
    }
    async function wait(expr, timeout = 15000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await c.evaluate(expr)) return;
        await sleep(100);
      }
      throw Error('B1 UI timeout: ' + expr);
    }
    const call = (method, args = {}) =>
      c.evaluate(
        `window.Capacitor.nativePromise('SilverhandClient',${JSON.stringify(method)},${JSON.stringify(args)})`,
      );
    async function input(selector, value) {
      await c.evaluate(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing field');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
      );
    }
    async function screenshot(name) {
      writeFileSync(
        out + '/' + name + '.png',
        execFileSync(adbBin, ['-s', serial, 'exec-out', 'screencap', '-p']),
      );
    }
    const textArea = `[...document.querySelectorAll('textarea')].find(e=>!e.closest('[inert]')&&e.getBoundingClientRect().height>0)`;
    async function composerFocus() {
      const box = await c.evaluate(
        `(()=>{const e=${textArea};const b=e.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`,
      );
      await c.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        button: 'left',
        clickCount: 1,
        ...box,
      });
      await c.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        button: 'left',
        clickCount: 1,
        ...box,
      });
    }
    async function go(url) {
      await c.evaluate('location.hash=' + JSON.stringify(url));
      await wait('location.hash===' + JSON.stringify('#' + url));
      await sleep(450);
    }
    async function openSettings() {
      await wait(
        `!![...document.querySelectorAll('button[aria-label="Channel settings"]')].find(e=>!e.closest('[inert]')&&e.getBoundingClientRect().width>0)`,
      );
      const box = await c.evaluate(
        `(()=>{const e=[...document.querySelectorAll('button[aria-label="Channel settings"]')].find(e=>!e.closest('[inert]')&&e.getBoundingClientRect().width>0);const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      );
      await c.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        button: 'left',
        clickCount: 1,
        ...box,
      });
      await c.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        button: 'left',
        clickCount: 1,
        ...box,
      });
      await wait(
        'location.hash===' + JSON.stringify('#' + channelUrl + '?settings=' + fixture.channel),
      );
      await sleep(400);
    }
    async function geometry(name) {
      const native = await control('identity');
      const web = await c.evaluate(
        `(()=>{const e=${textArea};const r=e?.getBoundingClientRect();const v=visualViewport;const b=selector=>{const x=e?.closest('[data-composer]')?.querySelector(selector)?.getBoundingClientRect();return x&&{left:x.left,top:x.top,right:x.right,bottom:x.bottom,width:x.width,height:x.height}};return{innerWidth,innerHeight,viewport:{width:v.width,height:v.height,top:v.offsetTop},composer:r&&{left:r.left,top:r.top,right:r.right,bottom:r.bottom},send:b('[data-composer-action="send"]'),attach:b('[data-composer-toolbar] button[title="Attach a file"]'),safe:[...['top','right','bottom','left'].map(s=>getComputedStyle(document.documentElement).getPropertyValue('--safe-area-inset-'+s))],bodyWidth:document.body.scrollWidth}})()`,
      );
      const record = { native, web };
      writeFileSync(out + '/' + name + '.json', JSON.stringify(record, null, 2));
      await screenshot(name);
      assert(web.composer, 'Actual composer missing');
      for (const [kind, box] of Object.entries({
        composer: web.composer,
        send: web.send,
        attach: web.attach,
      })) {
        assert(box, kind + ' missing');
        assert(
          box.left >= -1 && box.right <= web.viewport.width + 1,
          kind + ' clipped horizontally',
        );
        assert(
          box.top >= web.viewport.top - 1 &&
            box.bottom <= web.viewport.top + web.viewport.height + 2,
          kind + ' hidden by keyboard/bounds',
        );
      }
      return record;
    }

    const original = {
      font: adb('shell', 'settings', 'get', 'system', 'font_scale'),
      rotation: adb('shell', 'settings', 'get', 'system', 'user_rotation'),
      auto: adb('shell', 'settings', 'get', 'system', 'accelerometer_rotation'),
    };
    let token, fixture, path, channelUrl, oldIdentity, caseError;
    try {
      const stamp = Date.now(),
        email = `b1${stamp}@example.test`,
        password = 'B1-Isolated-Only!';
      const user = await api('/auth/signup', 'POST', { email, name: 'b1' + stamp, password });
      token = user.user_token;
      assert(token);
      const wb = await api('/api/workspaces', 'POST', { name: 'B1 ' + stamp }, token);
      const w = wb.workspace || wb;
      const cb = await api(
        `/api/workspaces/${w.id}/channels`,
        'POST',
        { title: 'B1 foundations' },
        token,
      );
      const ch = cb.channel || cb;
      path = `/api/channels/${ch.id}/messages`;
      const seed = await api(path, 'POST', { content: 'B1 seed ' + stamp }, token);
      channelUrl = '/chat/w/' + w.id + '/c/' + ch.id;
      fixture = { email, password, workspace: w.id, channel: ch.id };
      writeFileSync(run + '/acceptance/b1-fixture.json', JSON.stringify(fixture), { mode: 0o600 });
      c = context.reconnect ? await context.reconnect() : await connect();
      await call('clearProfile');
      await call('saveProfile', { serverUrl: 'https://localhost:29443' });
      await c.evaluate('location.reload()');
      await wait(`!!document.querySelector('#auth-email')`);
      await input('#auth-email', email);
      await input('input[autocomplete="current-password"]', password);
      await c.evaluate(`document.querySelector('button[type=submit]').click()`);
      await wait(
        `!document.querySelector('#auth-email')&&(document.body?.innerText??'').includes('New project')`,
      );
      await go(channelUrl);
      await wait(`!!(${textArea})`);
      writeFileSync(
        out + '/continuation-preconditions.json',
        JSON.stringify(
          {
            identity: await control('identity'),
            route: await c.evaluate('location.hash'),
            freshFixture: true,
            selectedCases: selected,
            historicalPassesUsed: false,
          },
          null,
          2,
        ),
      );
      await test('actual-activity-identity', async () => {
        oldIdentity = await control('identity');
        assert(oldIdentity.activity);
        return oldIdentity;
      });
      await test('native-chinese-composition-selection-send', async () => {
        await composerFocus();
        await control('ime-show');
        await wait(`document.activeElement?.tagName==='TEXTAREA'`);
        await c.evaluate(
          `window.__b1Composition=[];for(const name of ['compositionstart','compositionupdate','compositionend'])(${textArea}).addEventListener(name,e=>window.__b1Composition.push({type:e.type,data:e.data}));true`,
        );
        assert((await control('ime-compose', { text: '中文' })).accepted);
        await wait(`(${textArea}).value==='中文'`);
        await control('ime-finish');
        await sleep(300);
        assert(
          !JSON.stringify(await api(path, 'GET', undefined, token)).includes('中文'),
          'Composing/committing text sent a message',
        );
        await control('ime-select', { start: 0, end: 2 });
        await control('ime-commit', { text: '汉字' });
        await control('ime-commit', { text: '\nB1 ' + stamp });
        await wait(`(${textArea}).value.includes('B1 '+${stamp})`);
        const typed = await c.evaluate(`(${textArea}).value`);
        assert(typed.includes('\n'), 'Line break missing');
        const events = await c.evaluate('window.__b1Composition');
        assert(
          events.some((x) => x.type === 'compositionstart') &&
            events.some((x) => x.type === 'compositionend'),
        );
        await control('ime-enter');
        await wait(`(${textArea}).value===''`);
        let saved;
        for (let i = 0; i < 100; i++) {
          saved = await api(path, 'GET', undefined, token);
          if (JSON.stringify(saved).includes('B1 ' + stamp)) break;
          await sleep(100);
        }
        assert(JSON.stringify(saved).includes('B1 ' + stamp));
        return {
          events,
          selectionReplacement: true,
          newline: true,
          content: typed,
          path: 'Android WebView InputConnection; not a Chinese candidate-dictionary UI test',
        };
      });
      await test('legacy-ime229-no-send', async () => {
        await input('textarea', 'legacy-' + stamp);
        await c.evaluate(
          `(${textArea}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:229,bubbles:true,cancelable:true}));true`,
        );
        await sleep(250);
        assert.equal(await c.evaluate(`(${textArea}).value`), 'legacy-' + stamp);
        assert(
          !JSON.stringify(await api(path, 'GET', undefined, token)).includes('legacy-' + stamp),
        );
        await input('textarea', '');
        return {
          path: 'Synthetic Web keyCode229 regression on real page, separate from native InputConnection',
        };
      });
      await test('visible-ime-and-back-priority', async () => {
        await composerFocus();
        await control('ime-show');
        for (let i = 0; i < 40; i++) {
          if ((await control('identity')).imeVisible) break;
          await sleep(100);
        }
        assert((await control('identity')).imeVisible, 'Real IME not visible');
        const before = await geometry('portrait-ime');
        const hash = await c.evaluate('location.hash');
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
        for (let i = 0; i < 30; i++) {
          if (!(await control('identity')).imeVisible) break;
          await sleep(100);
        }
        assert(!(await control('identity')).imeVisible);
        assert.equal(await c.evaluate('location.hash'), hash);
        return {
          before,
          routeUnchangedAfterIMEBack: true,
          defaultInputMethod: adb('shell', 'settings', 'get', 'secure', 'default_input_method'),
        };
      });
      await test('modal-back-once', async () => {
        await go('/chat');
        await c.evaluate(
          `Array.from(document.querySelectorAll('button')).find(e=>e.textContent.includes('New project')).click()`,
        );
        await wait(`!!document.querySelector('[role=dialog]')`);
        async function state(name) {
          const native = await control('identity');
          const auth = await call('authState');
          const authenticated = auth.me?.status === 200;
          const userId = authenticated ? JSON.parse(auth.me.bodyText).id : null;
          assert.equal(typeof userId, 'string', 'Authenticated user id missing');
          const web = await c.evaluate(
            `({route:location.hash,focusedTag:document.activeElement?.tagName,dialogs:[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getBoundingClientRect().width>0).length})`,
          );
          web.authenticated = authenticated;
          web.identitySha256 = createHash('sha256').update(userId).digest('hex');
          const value = { native, web, at: new Date().toISOString() };
          writeFileSync(out + '/' + name + '.json', JSON.stringify(value, null, 2));
          await screenshot(name);
          return value;
        }
        async function ime(expected) {
          const deadline = Date.now() + 8000;
          while (Date.now() < deadline) {
            if ((await control('identity')).imeVisible === expected) {
              await sleep(250);
              if ((await control('identity')).imeVisible === expected) return;
            }
            await sleep(100);
          }
          throw Error('Native IME precondition/transition timeout: ' + expected);
        }
        await control('ime-show');
        await ime(true);
        const beforeIME = await state('modal-before-ime-back');
        beforeLayer('ime', beforeIME);
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
        await ime(false);
        const afterIME = await state('modal-after-ime-back');
        afterLayer('ime', beforeIME, afterIME);
        const beforeModal = await state('modal-before-modal-back');
        beforeLayer('modal', beforeModal);
        const prior = adb('logcat', '-d', '-s', 'SilverhandBack:I', '*:S');
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
        await wait(`!document.querySelector('[role=dialog]')`);
        const afterModal = await state('modal-after-modal-back');
        afterLayer('modal', beforeModal, afterModal);
        const logs = adb('logcat', '-d', '-s', 'SilverhandBack:I', '*:S').slice(prior.length);
        writeFileSync(out + '/modal-commit.log', logs);
        assert.equal(
          (logs.match(/commit activity=/g) || []).length,
          1,
          'Expected one modal-level Activity commit',
        );
        return {
          beforeIME,
          afterIME,
          beforeModal,
          afterModal,
          oneBackPerValidatedLayer: true,
          modalCommitCount: 1,
        };
      });
      await test('panel-page-back-once', async () => {
        await go(channelUrl);
        await openSettings();
        await screenshot('settings-before-back');
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
        await wait('location.hash===' + JSON.stringify('#' + channelUrl));
        assert((await call('authState')).me?.status === 200);
        await screenshot('settings-after-back');
        return {
          settingsPeelOnce: true,
          identityRetained: true,
          precondition:
            'Real visible Channel settings button via pointer → nav.openChannelSettings push',
        };
      });
      await test('page-touchcancel-no-navigation', async () => {
        await openSettings();
        await c.evaluate(
          `window.__b1TouchCancel=0;window.addEventListener('touchcancel',()=>window.__b1TouchCancel++);true`,
        );
        const hash = await c.evaluate('location.hash');
        const injection = await control('page-touch-cancel');
        await sleep(600);
        assert((await c.evaluate('window.__b1TouchCancel')) > 0, 'No Web touchcancel observed');
        assert.equal(await c.evaluate('location.hash'), hash);
        await screenshot('page-cancel-preserved');
        return { injection, webTouchCancelObserved: true, routeUnchanged: true };
      });
      await test('system-back-gesture-cancel', async () => {
        const prior = adb('logcat', '-d', '-s', 'SilverhandBack:I', '*:S');
        const hash = await c.evaluate('location.hash');
        const injection = await control('system-gesture-cancel');
        await sleep(600);
        const logs = adb('logcat', '-d', '-s', 'SilverhandBack:I', '*:S').slice(prior.length);
        writeFileSync(out + '/system-gesture-cancel.log', logs);
        assert(
          logs.includes('gesture-start') && logs.includes('gesture-cancel'),
          'System cancellation callback not independently observed',
        );
        assert(!logs.includes(' commit '), 'Cancel committed');
        assert.equal(await c.evaluate('location.hash'), hash);
        await screenshot('system-cancel-preserved');
        return { injection, systemCallbacksObserved: true, routeUnchanged: true };
      });
      await test('system-back-gesture-commit', async () => {
        await go(channelUrl);
        await openSettings();
        const prior = adb('logcat', '-d', '-s', 'SilverhandBack:I', '*:S');
        await control('system-gesture-commit');
        await wait('location.hash===' + JSON.stringify('#' + channelUrl));
        const logs = adb('logcat', '-d', '-s', 'SilverhandBack:I', '*:S').slice(prior.length);
        writeFileSync(out + '/system-gesture-commit.log', logs);
        assert.equal((logs.match(/commit activity=/g) || []).length, 1);
        await screenshot('system-commit-once');
        return { oneSystemCommit: true, onePagePop: true };
      });
      await test('rotation-font-ime-layout', async () => {
        async function focusObservation(name) {
          const native = await control('identity');
          const auth = await call('authState');
          assert.equal(auth.me?.status, 200);
          const identitySha256 = createHash('sha256')
            .update(JSON.parse(auth.me.bodyText).id)
            .digest('hex');
          const web = await c.evaluate(`(()=>{
    const field=window.__b1ObservedField,composer=field?.closest('[data-composer]'),active=document.activeElement,chain=[];
    for(let n=active;n&&chain.length<7;n=n.parentElement)chain.push({tag:n.tagName,composer:n.hasAttribute('data-composer'),inert:n.hasAttribute('inert'),label:n.getAttribute('aria-label'),title:n.getAttribute('title')});
    const style=node=>node&&getComputedStyle(node),root=style(composer),shell=style(composer?.querySelector('[data-composer-shell]')),r=field?.getBoundingClientRect(),v=visualViewport;
    const viewport={left:v?.offsetLeft??0,top:v?.offsetTop??0,width:v?.width??innerWidth,height:v?.height??innerHeight};
    let left=Math.max(r?.left??0,viewport.left),top=Math.max(r?.top??0,viewport.top),right=Math.min(r?.right??0,viewport.left+viewport.width),bottom=Math.min(r?.bottom??0,viewport.top+viewport.height),cssVisible=true;
    const clips=[];
    for(let n=field;n;n=n.parentElement){const st=style(n);if(st.display==='none'||st.visibility==='hidden'||st.visibility==='collapse'||Number(st.opacity)===0)cssVisible=false;if(n===field)continue;
     const nr=n.getBoundingClientRect(),clipX=/^(auto|scroll|hidden|clip)$/.test(st.overflowX),clipY=/^(auto|scroll|hidden|clip)$/.test(st.overflowY);
     if(clipX||clipY){const box={left:nr.left+n.clientLeft,top:nr.top+n.clientTop,right:nr.left+n.clientLeft+n.clientWidth,bottom:nr.top+n.clientTop+n.clientHeight};clips.push({tag:n.tagName,clipX,clipY,box});if(clipX){left=Math.max(left,box.left);right=Math.min(right,box.right);}if(clipY){top=Math.max(top,box.top);bottom=Math.min(bottom,box.bottom);}}
    }
    const area=Math.max(0,right-left)*Math.max(0,bottom-top),visibility={cssVisible,viewport,rect:r&&{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},clippedIntersection:{left,top,right,bottom,areaCssPx2:area},clips,visible:!!field?.isConnected&&cssVisible&&area>0};
    return{route:location.hash,mediaMatches:matchMedia('(max-height: 320px)').matches,focus:{tag:active?.tagName,label:active?.getAttribute('aria-label'),title:active?.getAttribute('title'),inComposer:!!active?.closest('[data-composer]'),ancestors:chain},observed:{connected:!!field?.isConnected,rendered:!!r&&r.width>0&&r.height>0,visibility,inert:!!field?.closest('[inert]'),focusWithin:!!composer?.matches(':focus-within'),value:field?.value,styles:composer&&{paddingTop:root.paddingTop,paddingRight:root.paddingRight,paddingBottom:root.paddingBottom,paddingLeft:root.paddingLeft,shellDisplay:shell.display,fontSize:style(field).fontSize}}};
   })()`);
          const record = { at: new Date().toISOString(), native, identitySha256, web };
          writeFileSync(out + '/' + name + '.json', JSON.stringify(record, null, 2));
          await screenshot(name);
          return record;
        }
        await go(channelUrl);
        if ((await control('identity')).imeVisible) {
          adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
          for (let i = 0; i < 30; i++) {
            if (!(await control('identity')).imeVisible) break;
            await sleep(100);
          }
        }
        assert(!(await control('identity')).imeVisible, 'Layout baseline requires hidden IME');
        assert.equal(
          await c.evaluate(`(${textArea}).value`),
          '',
          'Layout baseline requires empty draft',
        );
        const observations = {};
        const base = await geometry('portrait-normal');
        const activity = await control('identity');
        adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
        adb('shell', 'settings', 'put', 'system', 'user_rotation', '1');
        await sleep(1200);
        assert.equal(
          (await control('identity')).activity,
          activity.activity,
          'Rotation unexpectedly recreated Activity',
        );
        observations.landscapeNormal = await geometry('landscape-normal');
        async function showKeyboard() {
          await composerFocus();
          await control('ime-show');
          for (let i = 0; i < 40; i++) {
            if ((await control('identity')).imeVisible) return;
            await sleep(100);
          }
          throw Error('Actual IME did not become visible');
        }
        await showKeyboard();
        await sleep(400);
        observations.landscapeNormalIME = await geometry('landscape-normal-ime');
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
        adb('shell', 'settings', 'put', 'system', 'font_scale', '1.3');
        await sleep(1600);
        c.close();
        c = await connect();
        await go(channelUrl);
        await wait(`!!(${textArea})`);
        if ((await control('identity')).imeVisible) {
          adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
          for (let i = 0; i < 30; i++) {
            if (!(await control('identity')).imeVisible) break;
            await sleep(100);
          }
        }
        assert(!(await control('identity')).imeVisible);
        await c.evaluate(`window.__b1ObservedField=(${textArea});true`);
        const styleBaseline = await focusObservation('large-landscape-no-ime-style-baseline');
        assert(!styleBaseline.web.mediaMatches, 'No tall baseline for style restoration');
        await showKeyboard();
        await sleep(500);
        observations.large = await geometry('landscape-large-ime');
        assert(Math.abs(observations.large.native.fontScale - 1.3) < 0.01);
        const draft =
          'B1 short viewport ' +
          stamp +
          '\n' +
          Array.from({ length: 24 }, (_, i) => 'editable line ' + i + ' 中文').join('\n');
        const readEditor = () =>
          c.evaluate(
            `(()=>{const e=${textArea};const b=e.getBoundingClientRect();return{value:e.value,start:e.selectionStart,end:e.selectionEnd,focused:document.activeElement===e,scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,fontSize:getComputedStyle(e).fontSize,rect:{x:b.x,y:b.y,width:b.width,height:b.height}}})()`,
          );
        const commit = await control('ime-commit', { text: draft });
        await sleep(150);
        writeFileSync(
          out + '/short-after-commit.json',
          JSON.stringify({ commit, observed: await readEditor() }, null, 2),
        );
        await wait(`(${textArea}).value===${JSON.stringify(draft)}`);
        const selection = await control('ime-select', { start: 3, end: 8 });
        await sleep(150);
        const beforeEditor = await readEditor();
        writeFileSync(
          out + '/short-editor-precondition.json',
          JSON.stringify({ commit, selection, observed: beforeEditor }, null, 2),
        );
        assert.equal(beforeEditor.value, draft, 'Draft not established before scrolling');
        assert(beforeEditor.focused);
        assert.equal(beforeEditor.start, 3);
        assert.equal(beforeEditor.end, 8);
        if (observations.large.native.activity !== observations.landscapeNormalIME.native.activity)
          assert(
            observations.large.native.connectionGeneration >
              observations.landscapeNormalIME.native.connectionGeneration,
            'Connection generation did not advance after Activity replacement',
          );
        await c.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: beforeEditor.rect.x + beforeEditor.rect.width / 2,
          y: beforeEditor.rect.y + beforeEditor.rect.height / 2,
          deltaX: 0,
          deltaY: 180,
        });
        await sleep(250);
        const afterEditor = await readEditor();
        writeFileSync(
          out + '/short-editor-scroll.json',
          JSON.stringify(
            {
              before: beforeEditor,
              after: afterEditor,
              inputPath:
                'CDP trusted wheel on actual WebView; separate from Android system gesture',
            },
            null,
            2,
          ),
        );
        assert(beforeEditor.scrollHeight > beforeEditor.clientHeight, 'Long editor not scrollable');
        assert(afterEditor.scrollTop > beforeEditor.scrollTop, 'Editor content did not scroll');
        assert.equal(afterEditor.value, draft);
        assert(afterEditor.focused);
        assert.equal(afterEditor.start, beforeEditor.start);
        assert.equal(afterEditor.end, beforeEditor.end);
        await c.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: 2,
          y: Math.max(2, observations.large.web.viewport.height / 2),
          deltaX: 0,
          deltaY: -800,
        });
        await sleep(300);
        const nav = await c.evaluate(
          `(()=>{const v=visualViewport;return{shellScrollTop:document.querySelector('.app-shell').scrollTop,focused:document.activeElement?.tagName,buttons:[...document.querySelectorAll('button[aria-label="Back"],button[aria-label="Channel settings"]')].filter(e=>!e.closest('[inert]')&&e.getBoundingClientRect().width>0).map(e=>{const b=e.getBoundingClientRect();return{label:e.getAttribute('aria-label'),top:b.top,bottom:b.bottom,left:b.left,right:b.right}}),height:v.height}})()`,
        );
        writeFileSync(out + '/short-navigation-reached.json', JSON.stringify(nav, null, 2));
        await screenshot('short-navigation-reached');
        assert(
          nav.buttons.some((b) => b.label === 'Channel settings'),
          'Settings entry disappeared',
        );
        for (const b of nav.buttons)
          assert(
            b.top >= -1 && b.bottom <= nav.height + 2,
            'Rendered navigation button cannot be reached by outer scroll',
          );
        await c.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: 2,
          y: Math.max(2, nav.height / 2),
          deltaX: 0,
          deltaY: 800,
        });
        await sleep(300);
        await geometry('short-editor-restored-by-manual-scroll');
        const afterOuter = await readEditor();
        assert.equal(afterOuter.value, draft);
        assert(afterOuter.focused);
        assert.equal(afterOuter.start, beforeEditor.start);
        assert.equal(afterOuter.end, beforeEditor.end);
        async function clickComposer(selector) {
          const box = await c.evaluate(
            `(()=>{const e=(${textArea}).closest('[data-composer]').querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Composer action unavailable');const b=e.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`,
          );
          await c.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            button: 'left',
            clickCount: 1,
            ...box,
          });
          await c.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            button: 'left',
            clickCount: 1,
            ...box,
          });
        }
        await clickComposer('[data-composer-action="send"]');
        await wait(`(${textArea}).value===''`);
        let received = [];
        for (let i = 0; i < 100; i++) {
          received = (await api(path, 'GET', undefined, token)).messages.filter(
            (m) => m.content === draft,
          );
          if (received.length) break;
          await sleep(100);
        }
        writeFileSync(
          out + '/short-send-received.json',
          JSON.stringify(
            {
              expectedContent: draft,
              messages: received.map((m) => ({ id: m.id, content: m.content })),
            },
            null,
            2,
          ),
        );
        assert.equal(
          received.length,
          1,
          'Short-viewport send not received exactly once with full content',
        );
        await showKeyboard();
        await sleep(300);
        await geometry('short-before-attachment');
        await clickComposer('[data-composer-toolbar] button[title="Attach a file"]');
        const picker = await nativeUI(serial).waitFor((n) =>
          (n.package ?? '').includes('documentsui'),
        );
        writeFileSync(
          out + '/short-file-picker.json',
          JSON.stringify(
            { package: picker.package, observed: true, cancelResult: 'pending' },
            null,
            2,
          ),
        );
        await screenshot('short-file-picker');
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
        await wait(`document.hasFocus()&&location.hash===${JSON.stringify('#' + channelUrl)}`);
        assert.equal(await c.evaluate(`(${textArea}).value`), '');
        assert.equal((await call('authState')).me?.status, 200);
        writeFileSync(
          out + '/short-file-picker-cancel.json',
          JSON.stringify(
            { returnedToChannel: true, composerEmpty: true, authenticated: true },
            null,
            2,
          ),
        );
        await screenshot('short-file-picker-cancelled');
        await focusObservation('picker-return-focus');
        await showKeyboard();
        await sleep(250);
        await geometry('short-before-focus-exit');
        await c.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: 2,
          y: 40,
          deltaX: 0,
          deltaY: -800,
        });
        await sleep(250);
        const beforeFocusExit = await focusObservation('before-noncomposer-action');
        assert.equal(beforeFocusExit.web.route, '#' + channelUrl);
        assert(
          beforeFocusExit.native.imeVisible &&
            beforeFocusExit.web.focus.inComposer &&
            beforeFocusExit.web.mediaMatches,
          'Actual short-viewport focus and IME precondition missing',
        );
        assert(
          beforeFocusExit.web.observed.connected &&
            beforeFocusExit.web.observed.visibility.visible &&
            !beforeFocusExit.web.observed.inert,
          'Original composer must remain visibly present before focus-exit action',
        );
        assert.equal(beforeFocusExit.web.observed.value, '');
        async function settingsTarget(originalPoint = null) {
          return c.evaluate(`(()=>{
   const candidates=[...document.querySelectorAll('button[aria-label="Channel settings"]')].filter(e=>!e.closest('[inert]')&&e.getBoundingClientRect().width>0);
   if(candidates.length!==1)throw Error('Expected exactly one current settings entry');const e=candidates[0],r=e.getBoundingClientRect(),v=visualViewport;
   const rect={left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},point={x:r.x+r.width/2,y:r.y+r.height/2};
   const hit=document.elementFromPoint(point.x,point.y),priorPoint=${JSON.stringify(originalPoint)},priorHit=priorPoint&&document.elementFromPoint(priorPoint.x,priorPoint.y);
   return{at:new Date().toISOString(),rect,point,viewport:{left:v.offsetLeft,top:v.offsetTop,width:v.width,height:v.height},visible:r.top>=v.offsetTop&&r.bottom<=v.offsetTop+v.height&&r.left>=v.offsetLeft&&r.right<=v.offsetLeft+v.width,disabled:e.disabled,centerHitsTarget:!!hit&&e.contains(hit),originalPointHitsTarget:priorPoint?!!priorHit&&e.contains(priorHit):null};
  })()`);
        }
        // Scene A observes focus while held; release navigation is deliberately not a product assertion.
        const focusTarget = await settingsTarget();
        writeFileSync(out + '/focus-scene-press-target.json', JSON.stringify(focusTarget, null, 2));
        assert(focusTarget.visible && focusTarget.centerHitsTarget && !focusTarget.disabled);
        const focusEvents = [];
        const focusMark = (stage) => focusEvents.push({ stage, at: new Date().toISOString() });
        focusMark('press_sent');
        await c.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          button: 'left',
          clickCount: 1,
          ...focusTarget.point,
        });
        focusMark('press_ack');
        let pressedFocusExit;
        try {
          await sleep(60);
          pressedFocusExit = await focusObservation('noncomposer-pointer-pressed');
          const heldTarget = await settingsTarget(focusTarget.point);
          writeFileSync(out + '/focus-scene-held-target.json', JSON.stringify(heldTarget, null, 2));
        } finally {
          focusMark('release_sent');
          try {
            await c.send('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              button: 'left',
              clickCount: 1,
              ...focusTarget.point,
            });
            focusMark('release_ack');
          } finally {
            writeFileSync(out + '/focus-scene-events.json', JSON.stringify(focusEvents, null, 2));
          }
        }
        assertRestored(pressedFocusExit, styleBaseline, {
          route: beforeFocusExit.web.route,
          identity: beforeFocusExit.identitySha256,
          value: beforeFocusExit.web.observed.value,
        });
        const focusAfterRelease = await focusObservation('focus-scene-after-release');
        writeFileSync(
          out + '/focus-scene-verdict.json',
          JSON.stringify(
            {
              passed: true,
              pressedFocusExit,
              focusAfterRelease,
              releaseNavigationIsNotACriterion: true,
            },
            null,
            2,
          ),
        );
        // Scene B creates an independent channel precondition before a normal adjacent down/up click.
        await go(channelUrl);
        await wait(`!!(${textArea})`);
        await c.evaluate(`window.__b1ObservedField=(${textArea});true`);
        const navigationStart = await focusObservation('navigation-scene-start');
        assert.equal(navigationStart.web.route, '#' + channelUrl);
        assert(
          !navigationStart.native.imeVisible && !navigationStart.web.focus.inComposer,
          'Normal navigation requires hidden IME and focus outside composer',
        );
        assert.equal(navigationStart.web.observed.value, '');
        assert.equal(navigationStart.identitySha256, beforeFocusExit.identitySha256);
        const stableTarget1 = await settingsTarget();
        await sleep(100);
        const normalTarget = await settingsTarget();
        writeFileSync(
          out + '/navigation-scene-targets.json',
          JSON.stringify({ first: stableTarget1, second: normalTarget }, null, 2),
        );
        assert.deepEqual(
          normalTarget.rect,
          stableTarget1.rect,
          'Settings target not stable before normal click',
        );
        assert(normalTarget.visible && normalTarget.centerHitsTarget && !normalTarget.disabled);
        async function clickAndRecord(name, target) {
          let result;
          try {
            result = await adjacentPointerClick(c, target.point);
            return result;
          } catch (error) {
            result = error.pointerTrace ?? { completed: false, error: String(error) };
            throw error;
          } finally {
            writeFileSync(out + '/' + name + '.json', JSON.stringify({ target, result }, null, 2));
          }
        }
        await clickAndRecord('normal-settings-click', normalTarget);
        await wait(
          'location.hash===' + JSON.stringify('#' + channelUrl + '?settings=' + fixture.channel),
        );
        const settingsFocus = await focusObservation('noncomposer-settings-open');
        writeFileSync(
          out + '/settings-page-node-state.json',
          JSON.stringify(
            {
              connected: settingsFocus.web.observed.connected,
              rendered: settingsFocus.web.observed.rendered,
              visibility: settingsFocus.web.observed.visibility,
              inert: settingsFocus.web.observed.inert,
              note: 'Post-navigation node disappearance/hidden state is recorded separately, never counted as style restoration',
            },
            null,
            2,
          ),
        );
        const closeTarget = await c.evaluate(
          `(()=>{const candidates=[...document.querySelectorAll('[data-pane="channel-settings"] button[aria-label="Close"]')].filter(e=>!e.closest('[inert]')&&e.getBoundingClientRect().width>0);if(candidates.length!==1)throw Error('Expected one actual Close entry');const e=candidates[0],b=e.getBoundingClientRect(),v=visualViewport,point={x:b.x+b.width/2,y:b.y+b.height/2},hit=document.elementFromPoint(point.x,point.y);return{at:new Date().toISOString(),point,rect:{left:b.left,top:b.top,right:b.right,bottom:b.bottom},visible:b.top>=v.offsetTop&&b.bottom<=v.offsetTop+v.height&&b.left>=v.offsetLeft&&b.right<=v.offsetLeft+v.width,centerHitsTarget:!!hit&&e.contains(hit),disabled:e.disabled};})()`,
        );
        writeFileSync(out + '/normal-close-target.json', JSON.stringify(closeTarget, null, 2));
        assert(closeTarget.visible && closeTarget.centerHitsTarget && !closeTarget.disabled);
        await clickAndRecord('normal-close-click', closeTarget);
        await wait('location.hash===' + JSON.stringify('#' + channelUrl));
        await wait(`!!(${textArea})`);
        const originalNodeRetained = await c.evaluate(`window.__b1ObservedField===(${textArea})`);
        await c.evaluate(`window.__b1ObservedField=(${textArea});true`);
        const returnedFocus = await focusObservation('normal-close-return-to-channel');
        assertRestored(returnedFocus, styleBaseline, {
          route: '#' + channelUrl,
          identity: beforeFocusExit.identitySha256,
          value: '',
        });
        const returnedGeometry = await geometry('channel-after-settings-close');
        const blur = {
          beforeFocusExit,
          pressedFocusExit,
          focusAfterRelease,
          navigationStart,
          settingsFocus,
          returnedFocus,
          returnedGeometry,
          originalNodeRetained,
          action:
            'Scene A focus observation; Scene B independent stable normal settings click → actual Close',
        };
        writeFileSync(out + '/focus-exit-verdict.json', JSON.stringify(blur, null, 2));
        if ((await control('identity')).imeVisible)
          adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
        adb('shell', 'settings', 'put', 'system', 'user_rotation', '0');
        await sleep(1200);
        await showKeyboard();
        await sleep(300);
        observations.portraitLargeIME = await geometry('portrait-large-ime');
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
        adb('shell', 'settings', 'put', 'system', 'font_scale', original.font);
        await sleep(1400);
        c.close();
        c = await connect();
        await go(channelUrl);
        await wait(`!!(${textArea})`);
        observations.restored = await geometry('portrait-restored');
        return {
          base,
          ...observations,
          rotationSameIdentity: true,
          largeFontScale: 1.3,
          editorContentAndSelectionPreserved: true,
          manualScrollReturnsToNavigationAndEditor: true,
          shortSendReceivedByRealFixture: true,
          realFileChooserAndCancel: true,
          blurRestoration: blur,
        };
      });
      await test('actual-recreate-session-events', async () => {
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
        await go(channelUrl);
        await input('textarea', 'unsent B1 draft');
        const before = await control('identity');
        c.close();
        const after = await control('recreate');
        assert.notEqual(after.activity, before.activity);
        assert.equal(after.oldActivity, before.activity);
        assert.equal(after.lastDestroyed, before.activity);
        let connected = false;
        for (let i = 0; i < 100; i++) {
          try {
            c = await connect();
            connected = true;
            break;
          } catch {
            await sleep(100);
          }
        }
        assert(connected);
        await wait(
          `!document.querySelector('#auth-email')&&(document.body?.innerText??'').includes('New project')`,
        );
        assert.equal((await call('authState')).me?.status, 200);
        await go(channelUrl);
        const draftAfter = await c.evaluate(`(${textArea}).value`);
        await composerFocus();
        const rebound = await control('ime-show');
        const currentAfterRecreate = await control('identity');
        assert.equal(rebound.activity, after.activity);
        assert.equal(rebound.webView, currentAfterRecreate.webViewIdentity);
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
        for (let i = 0; i < 30; i++) {
          if (!(await control('identity')).imeVisible) break;
          await sleep(100);
        }
        assert(!(await control('identity')).imeVisible, 'Post-recreate IME not hidden');
        const incoming = 'after recreate ' + stamp;
        await api(path, 'POST', { content: incoming }, token);
        await wait(`(document.body?.innerText??'').includes(${JSON.stringify(incoming)})`);
        assert.equal(
          await c.evaluate(
            `(document.body.innerText.match(new RegExp(${JSON.stringify(incoming)},'g'))||[]).length`,
          ),
          1,
        );
        await screenshot('after-real-recreate');
        return {
          before,
          after,
          rebound,
          currentAfterRecreate,
          authenticated: true,
          oneLiveMessage: true,
          draftAfter,
          contract:
            'Draft cache is JS-memory-only, no new cross-Activity persistence promised; route/session observed explicitly',
        };
      });
      await test('root-background-session', async () => {
        await go('/chat');
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
        await sleep(500);
        const state = adb('shell', 'dumpsys', 'activity', 'activities');
        assert(
          !state.split('\n').some((l) => l.includes('mResumedActivity') && l.includes(pkg)),
          'Root Back did not leave Activity foreground',
        );
        adb('shell', 'am', 'start', '-n', pkg + '/com.silverhand.android.MainActivity');
        await sleep(600);
        assert.equal((await call('authState')).me?.status, 200);
        assert.equal(await c.evaluate('location.hash'), '#/chat');
        return { backgrounded: true, sessionRetained: true };
      });
    } catch (error) {
      caseError = error;
      try {
        writeFileSync(
          out + '/failure-state.json',
          JSON.stringify(
            await c.evaluate(
              `({hash:location.hash,activeTag:document.activeElement?.tagName,visibleDialogs:[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getBoundingClientRect().width>0).length})`,
            ),
            null,
            2,
          ),
        );
        await screenshot('first-failure');
      } catch {}
      throw error;
    } finally {
      c?.close();
      const cleaned = [];
      for (const [key, value] of [
        ['font_scale', original.font],
        ['user_rotation', original.rotation],
        ['accelerometer_rotation', original.auto],
      ]) {
        try {
          if (value === 'null') adb('shell', 'settings', 'delete', 'system', key);
          else adb('shell', 'settings', 'put', 'system', key, value);
          cleaned.push({ key, status: 'passed' });
        } catch (error) {
          cleaned.push({ key, status: 'failed', error: String(error) });
        }
      }
      context.observe('b1-settings-cleanup', cleaned);
      try {
        execFileSync(
          adbBin,
          [
            '-s',
            serial,
            'shell',
            `run-as ${pkg} sh -c 'cat > files/b1-request.tmp && mv files/b1-request.tmp files/b1-request.json'`,
          ],
          {
            input: JSON.stringify({ id: 'stop-' + randomUUID(), operation: 'stop' }),
            timeout: 10000,
          },
        );
      } catch (error) {
        context.observe('b1-stop-request', { error: String(error) });
      }
      if (!caseError && cleaned.some((row) => row.status === 'failed'))
        throw Error('B1 settings cleanup failed');
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      execFileSync(
        process.env.ANDROID_HOME + '/platform-tools/adb',
        [
          '-s',
          'emulator-5584',
          'shell',
          "run-as com.silverhand.android.stage1 sh -c 'cat > files/b1-request.tmp && mv files/b1-request.tmp files/b1-request.json'",
        ],
        {
          input: JSON.stringify({ id: 'stop-' + randomUUID(), operation: 'stop' }),
          timeout: 10000,
        },
      );
      let timeout;
      const result = await Promise.race([
        exited,
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(null), 20000);
        }),
      ]);
      clearTimeout(timeout);
      context.observe('instrumentation', {
        exit: result,
        protocolSuccess:
          result?.code === 0 &&
          protocol.includes('INSTRUMENTATION_CODE: -1') &&
          protocol.includes('B1_DEVICE_CONTROL_COMPLETED') &&
          !protocol.includes('B1_DEVICE_CONTROL_FAILED'),
      });
      assert(
        result?.code === 0 &&
          protocol.includes('INSTRUMENTATION_CODE: -1') &&
          protocol.includes('B1_DEVICE_CONTROL_COMPLETED') &&
          !protocol.includes('B1_DEVICE_CONTROL_FAILED'),
        'B1 instrumentation protocol did not complete',
      );
    } catch (error) {
      context.observe('instrumentation-cleanup-error', { error: String(error) });
      if (!primaryError) throw error;
    } finally {
      if (child.exitCode === null) {
        execFileSync(
          process.env.ANDROID_HOME + '/platform-tools/adb',
          ['-s', 'emulator-5584', 'shell', 'am', 'force-stop', 'com.silverhand.android.stage1'],
          { timeout: 10000 },
        );
        child.kill('SIGTERM');
      }
    }
  }
}
