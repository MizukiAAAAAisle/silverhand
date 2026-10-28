import { test, mock } from 'node:test';
import { continueAfterRestart, reconnectWebView, coverageMetadata, groupedB1Observation } from './acceptance-continuation.mjs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { AcceptanceRecord } from './acceptance-record.mjs';
import { nativeFileTarget, nativeUI } from './native-ui.mjs';
import { messageMenuTarget, fileComposer, assertSavedAvatarDesign, photoPickerMoreTarget, inspectPhotoPickerMore, chooseAvatarPickerFile, avatarFileCapture, themeRestartPage, shortSelectionLayout, previewDialogState, shortSelectionWindow, shortMenuTarget, leftControlTarget, waitLeftControl, shortMenuCapture, shortContextMenu, restoreGroupedNightMode, barPageState, observeBarScreenshot, runB2 } from './acceptance-b2.mjs';
import { AVATAR_MAX_BYTES, validateAvatarFile } from '../../../packages/shared/src/api/avatar.ts';

const avatarRecoveryParameters = JSON.parse(readFileSync(new URL('./acceptance-scenarios.json', import.meta.url))).B2.find((row) => row.id === 'avatar.error-recovery').parameters;

test('saved avatar design requires the non-null design and its wire fields', () => {
  const response = { design: { parts_version: 1, config: { parts: { eyes: 1 }, bg: 0 } } };
  const before = structuredClone(response);
  assert.doesNotThrow(() => assertSavedAvatarDesign(response));
  assert.deepEqual(response, before);
  for (const design of [null, {}, { parts_version: 0, config: {} }, { parts_version: 1.5, config: {} }, { parts_version: 0x100000000, config: {} }, { parts_version: '1', config: {} }, { parts_version: 1 }, { parts_version: 1, config: null }, { parts_version: 1, config: [] }])
    assert.throws(() => assertSavedAvatarDesign({ design }), /Saved avatar design/);
});

test('null saved avatar design fails the recorded step and retains the original response', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'avatar-design-'));
  try {
    const record = new AcceptanceRecord(directory, ['B2.avatar.web-save-cancel', 'B2.avatar.error-recovery']);
    const response = { design: null };
    await assert.rejects(record.step('B2.avatar.web-save-cancel', async () => {
      record.observe('avatar-design-response', response);
      assertSavedAvatarDesign(response);
    }), /Saved avatar design is missing/);
    const raw = JSON.parse(readFileSync(join(directory, 'raw.json')));
    const counts = JSON.parse(readFileSync(join(directory, 'counts.json')));
    assert.deepEqual(raw.observations[0].value, response);
    assert.deepEqual(raw.steps.map((row) => row.status), ['failed', 'not_executed']);
    assert.equal(counts.passed, 0);
    assert.equal(counts.failed, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fileFixture({ disabled = false, uploading = false, filename = true, text = 'expected', extra = false } = {}) {
  const textarea = { value: text, disabled: false };
  const send = { disabled };
  const controls = { 'textarea[data-composer-input]': textarea, '[data-composer-action="send"]': send, 'input[type=file]': {} };
  const form = {
    innerText: (filename ? 'fixture.bin' : '') + (uploading ? ' Uploading…' : ''),
    closest: () => null,
    getBoundingClientRect: () => ({ width: 300, height: 100 }),
    querySelector: (selector) => controls[selector],
  };
  const inert = { ...form, closest: () => ({}) };
  return { defaultView: { location: { hash: '#channel' } }, activeElement: textarea, querySelectorAll: () => [inert, form, ...(extra ? [form] : [])] };
}

test('file composer serializes to the current form and actual Send readiness', () => {
  const document = fileFixture();
  const state = runInNewContext(`(${fileComposer.toString()})(document,"fixture.bin","expected").state`, { document });
  assert.equal(state.ready, true);
  assert.equal(state.targetFocused, true);
  assert.equal(state.sendDisabled, false);
});

test('file composer does not treat a filename or error-disabled Send as ready', () => {
  for (const options of [{ disabled: true }, { uploading: true }, { filename: false }, { text: 'other' }])
    assert.equal(fileComposer(fileFixture(options), 'fixture.bin', 'expected').state.ready, false);
  assert.throws(() => fileComposer(fileFixture({ extra: true }), 'fixture.bin', 'expected'), /Expected one current/);
});

function menuFixture({ missing=false, offscreen=false, occluded=false, bounds, scrollBox, outerBox, visual, height=800, replaceRow=false, replaceBody=false, hidden=false, nearestWrong=false, noScroller=false, paneBox, chromeBox, chromeMissing=false, chromeDuplicate=false, chromePosition='absolute', chromeHidden=false, chromeWrongKind=false, replaceChrome=false } = {}) {
  let scrolled=false, scrollCount=0, idReads=0, bodyReads=0, chromeReads=0, lastPoint;
  const rectangle=({left=0,top=0,width=400,height=800})=>({left,top,right:left+width,bottom:top+height,width,height});
  const attributes={getAttribute:()=>null,hasAttribute:()=>false,closest:()=>null,isConnected:true,getBoundingClientRect:()=>rectangle({left:0,top:0,width:400,height})};
  const pb=paneBox??{left:0,top:0,width:400,height}, cb=chromeBox??{left:pb.left,top:pb.top,width:pb.width,height:30};
  const pane={...attributes,tagName:'MAIN',id:'pane',parentElement:null,getAttribute:(name)=>name==='data-panel'?'chat':null,getBoundingClientRect:()=>rectangle(pb),clientLeft:0,clientTop:0,clientWidth:pb.width,clientHeight:pb.height,contains:(n)=>[pane,scroller,row,body,chrome].includes(n),querySelectorAll:(selector)=>{if(selector==='button[data-scroll-bottom]')return [];chromeReads++;return chromeMissing?[]:chromeDuplicate?[chrome,{...chrome}]:[replaceChrome&&chromeReads>1?{...chrome}:chrome];}};
  const chrome={...attributes,tagName:'DIV',id:'chrome',parentElement:pane,getAttribute:(name)=>name==='data-pane-chrome'?(chromeWrongKind?'sibling':'scroller'):name==='class'?'current-chrome':null,getBoundingClientRect:()=>rectangle(cb)};
  const outer=outerBox ? {...attributes,tagName:'DIV',id:'outer',getBoundingClientRect:()=>rectangle(outerBox),clientLeft:0,clientTop:0,clientWidth:outerBox.width,clientHeight:outerBox.height,parentElement:pane} : null;
  const s=scrollBox??{left:0,top:0,width:400,height};
  const scroller={...attributes,tagName:'DIV',id:'scroll',getBoundingClientRect:()=>rectangle(s),clientLeft:0,clientTop:0,clientWidth:s.width,clientHeight:s.height,parentElement:outer??pane,contains:(n)=>[scroller,row,body].includes(n)};
  const row={...attributes,tagName:'ARTICLE',id:'msg-committed',parentElement:scroller,
    closest:(selector)=>selector==='[data-panel="chat"]'?pane:null,scrollIntoView:()=>{scrolled=true;scrollCount++;},querySelector:()=>{bodyReads++;return replaceBody&&bodyReads>1?{...body}:body;},contains:(n)=>n===body};
  const body={...attributes,tagName:'P',id:'body',parentElement:row,hasAttribute:(name)=>name==='data-message-body',contains:(n)=>n===body,
    getBoundingClientRect:()=>rectangle(bounds??{left:10,top:scrolled&&!offscreen?40:-500,width:100,height:20}),
    closest:(selector)=>selector==='[data-virtuoso-scroller]'?(noScroller?null:scroller):selector==='[data-message-row]'?(nearestWrong?{}:row):null};
  const foreign={...attributes,tagName:'BUTTON',id:'foreign',parentElement:null,closest:()=>null};
  const document={defaultView:{innerWidth:400,innerHeight:height,visualViewport:visual,
      getComputedStyle:(e)=>({display:'block',visibility:(hidden&&e===body)||(chromeHidden&&e===chrome)?'hidden':'visible',opacity:'1',overflowX:e===outer?'hidden':'visible',overflowY:e===scroller?'auto':e===outer?'hidden':'visible',position:e===chrome?chromePosition:e===pane?'relative':'static',zIndex:e===chrome?'2':'auto',pointerEvents:e===chrome?'none':'auto'})},
    getElementById:(id)=>{idReads++;return missing||id!==row.id?null:replaceRow&&idReads>1?{...row}:row;},
    elementFromPoint:(x,y)=>{lastPoint={x,y};return occluded?foreign:body;}};
  return{document,row,body,pane,chrome,scrolled:()=>scrolled,scrollCount:()=>scrollCount,lastPoint:()=>lastPoint};
}

test('preview target scrolls the committed row and verifies its actual hit', () => {
  const fixture = menuFixture();
  const target = JSON.parse(JSON.stringify(runInNewContext(`(${messageMenuTarget.toString()})(document,"committed")`, { document: fixture.document })));
  assert(fixture.scrolled());
  assert.equal(target.rowId, 'msg-committed');
  assert.deepEqual(target.point, { x: 60, y: 50 });
  assert.equal(target.hitTag, 'P');
});

test('preview target rejects missing, offscreen and wrong-row hits before input', () => {
  for (const [options, message] of [[{ missing: true }, /unavailable/], [{ offscreen: true }, /no visible body intersection/], [{ occluded: true }, /another row/]]) {
    const fixture = menuFixture(options);
    assert.throws(() => messageMenuTarget(fixture.document, 'committed'), message);
  }
});

test('unexpected first error leaves later scenarios unexecuted and preserves entry fields', async () => {
  const out = mkdtempSync(join(tmpdir(), 'b2-record-'));
  try {
    writeFileSync(
      join(out, 'raw.json'),
      JSON.stringify({ entry: { raw_returncode: null }, bindings: { fixture: true } }),
    );
    const record = new AcceptanceRecord(out, ['a', 'B2.b', 'B1.c']);
    record.pass('a', 'observed');
    await assert.rejects(
      record.step('B2.b', async () => {
        throw Error('controlled-first-error');
      }),
    );
    record.fail(Error('controlled-first-error'));
    const raw = JSON.parse(readFileSync(join(out, 'raw.json'))),
      counts = JSON.parse(readFileSync(join(out, 'counts.json')));
    assert.deepEqual(
      raw.steps.map((row) => row.status),
      ['passed', 'failed', 'not_executed'],
    );
    assert.equal(raw.bindings.fixture, true);
    assert.equal(raw.entry.raw_returncode, null);
    assert.equal(counts.passed, 1);
    assert.equal(counts.failed, 1);
    assert.equal(counts.not_executed, 1);
    assert.equal(counts.groups.B1.not_executed, 1);
    assert.equal(raw.first_error.message, 'Error: controlled-first-error');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
test('does not overwrite completed steps or call partial execution complete', () => {
  const out = mkdtempSync(join(tmpdir(), 'b2-record-'));
  try {
    const record = new AcceptanceRecord(out, ['a', 'b']);
    record.pass('a', 'observed');
    assert.throws(() => record.pass('a', 'replayed'), /Repeated/);
    assert.throws(() => record.complete(), /did not execute/);
    assert.throws(() => new AcceptanceRecord(out, ['a', 'b']), /Refusing/);
    const raw = JSON.parse(readFileSync(join(out, 'raw.json')));
    assert.equal(raw.steps[0].detail, 'observed');
    assert.equal(raw.steps[1].status, 'not_executed');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// Execute the actual short branch with controlled CDP/ADB replies, no SDK process.
async function shortAppearanceFixture(retained, confirmation = 'confirmed') {
  const { runB2 } = await import('./acceptance-b2.mjs');
  const childProcess = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const directory = mkdtempSync(join(tmpdir(), 'appearance-short-'));
  const record = new AcceptanceRecord(directory, ['DIAG.real-page-login', 'DIAG.theme-short-path']);
  record.pass('DIAG.real-page-login', 'controlled login prerequisite');
  const events = [], commands = [];
  let changed = false, restarted = false, route = '#/chat';
  const state = () => ({ route, theme: changed && (!restarted || retained) ? 'glass' : 'studio-light', confirmation: 'confirmed', appearance: changed && (!restarted || retained) ? '{"theme":"glass"}' : null });
  const c = {
    evaluate: async (expression) => {
      if (expression.startsWith('location.hash=')) { route = '#' + JSON.parse(expression.slice(14)); return; }
      if (expression.startsWith('delete window.')) return true;
      if (expression.startsWith('(function appearanceState')) return state();
      if (expression.startsWith('({...')) return { ...state(), origin: 'https://localhost', href: 'https://localhost/' + route };
      if (expression.includes('leftControlTarget')) return { route, ready: true, fatal: false, notificationHit: false, point: { x: 100, y: 20 } };
      if (expression.includes('const candidates=')) return { x: 100, y: 100 };
      throw Error('Unexpected short-path read ' + expression); // Includes any startup-script read.
    },
    send: async (method, args) => {
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: restarted ? 'new' : 'old', type: 'page', url: 'https://localhost/' + route } };
      assert.equal(method, 'Input.dispatchMouseEvent'); events.push(args);
      if (args.type === 'mouseReleased') changed = true;
    },
  };
  const originalExec = childProcess.default.execFileSync;
  childProcess.default.execFileSync = (_file, args) => {
    assert.deepEqual(args.slice(2), ['exec-out', 'screencap', '-p']);
    return Buffer.from('controlled screenshot, not device evidence');
  };
  syncBuiltinESMExports();
  let error;
  try {
    try {
      await runB2({ c, diagnostic: 'appearance-short', serial: 'emulator-controlled', out: directory, root: directory + '/', fixture: {},
        adb: (...args) => {
          if (args[1] === 'pidof') return restarted ? '202' : '101';
          commands.push(args); if (args.includes('start')) { restarted = true; route = ''; } return '';
        }, reconnect: async () => c,
        wait: async (expression) => {
          if (expression.startsWith('document.documentElement.dataset.theme===')) {
            assert.equal(expression, 'document.documentElement.dataset.theme==="glass"&&document.documentElement.dataset.themePersistence==="confirmed"');
            // The theme may match from a fallback mirror; that is not confirmation.
            if (!retained || confirmation !== 'confirmed') throw Error('UI timed out: ' + expression + ' BODY controlled');
          }
        }, observe: (...args) => record.observe(...args), step: (...args) => record.step(...args),
        api: () => assert.fail('Unexpected file/server action'), call: () => assert.fail('Unexpected bridge action'), input: () => assert.fail('Unexpected form input'),
      });
      record.complete();
    } catch (caught) { error = caught; record.fail(caught); }
    const raw = JSON.parse(readFileSync(join(directory, 'raw.json')));
    const counts = JSON.parse(readFileSync(join(directory, 'counts.json')));
    return { error, raw, counts, commands, events };
  } finally {
    childProcess.default.execFileSync = originalExec; syncBuiltinESMExports();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('appearance-short uses the original Glass actions without a startup asset and credits only DIAG', async () => {
  const result = await shortAppearanceFixture(true);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.events.map((e) => e.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.deepEqual(result.commands.map((args) => args.slice(0, 3)), [['shell', 'am', 'force-stop'], ['shell', 'am', 'start']]);
  assert.equal(result.raw.steps[1].detail.persistenceAssertion, 'passed');
  assert.equal(result.counts.groups.DIAG.passed, 2); assert.equal(result.counts.groups.B2.passed, 0);
  assert(!result.raw.observations.some((o) => o.name.includes('startup-')));
});

test('appearance-short persistence failure fails the actual DIAG step and preserves the thrown first error', async () => {
  const result = await shortAppearanceFixture(false);
  assert.match(result.error.message, /^UI timed out: document.documentElement.dataset.theme===/);
  assert.equal(result.raw.status, 'failed'); assert.equal(result.raw.steps[1].status, 'failed');
  assert.equal(result.raw.first_error.message, String(result.error));
  const assertion = result.raw.observations.find((o) => o.name.endsWith('-restart-persistence-assertion'));
  assert.equal(assertion.value.value.status, 'failed');
  assert.equal(result.counts.groups.DIAG.passed, 1); assert.equal(result.counts.groups.DIAG.failed, 1);
  assert.equal(result.counts.groups.B2.passed, 0);
  assert.equal(result.events.filter((e) => e.type === 'mouseReleased').length, 1);
  assert.equal(result.commands.filter((args) => args.includes('force-stop')).length, 1);
});

test('a matching degraded or pending restart theme cannot pass the persistence assertion', async () => {
  for (const status of ['pending', 'unconfirmed']) {
    const result = await shortAppearanceFixture(true, status);
    assert.match(result.error.message, /themePersistence/);
    assert.equal(result.raw.steps[1].status, 'failed');
    assert.equal(result.counts.groups.DIAG.failed, 1);
    assert.equal(result.commands.filter((args) => args.includes('force-stop')).length, 1);
  }
});

// Exercise the actual avatar handler/guard with controlled DOM and ADB replies.
async function avatarPickerFixture({ reject, pickerFailure = false, diagnosticsFail = false, diagnostic, photoPicker = false, postBrowse, describedFiles = false, lateFileEvent = false, fileEvent, errorText, captureReadFails = false, oldAvatarChanged = false } = {}) {
  const { runB2 } = await import('./acceptance-b2.mjs');
  const childProcess = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const directory = mkdtempSync(join(tmpdir(), 'avatar-picker-'));
  const record = new AcceptanceRecord(directory, diagnostic ? ['DIAG.real-page-login', 'DIAG.photo-picker-menu'] : ['B2.avatar.error-recovery']);
  if (diagnostic) record.pass('DIAG.real-page-login', 'controlled login prerequisite');
  const validName = JSON.parse(readFileSync(new URL('./acceptance-scenarios.json', import.meta.url))).images[0].name;
  const mainError = Error('controlled-picker-failure');
  const events = [], chosen = [], captures = [], nativeTaps = [], adbCalls = [], waits = [];
  let menuOpen = false, uploads = 0, filename, treeReads = 0, moreTapped = false, browseTapped = false, lookupFailed = false, pendingFile = null;
  let avatarErrorText = null, documentTimeOrigin = 77;
  let route = '#/settings?settingsSection=account';
  const location = {
    get hash() { return route; },
    set hash(value) { route = value.startsWith('#') ? value : '#' + value; },
  };
  const view = { location, innerWidth: 400, innerHeight: 800, getComputedStyle: () => ({}) };
  const control = (label, text, rect) => ({
    label, textContent: text, tagName: 'BUTTON', parentElement: null, disabled: false,
    closest: () => null, getBoundingClientRect: () => rect, scrollIntoView: () => {},
    getAttribute: (name) => name === 'aria-label' ? label : null,
    hasAttribute: () => false, contains(node) { return node === this; },
  });
  const avatar = control(diagnostic ? 'Add avatar' : 'Change avatar', '', { x: 10, y: 20, width: 80, height: 80 });
  const fileInput = { tagName: 'INPUT', type: 'file', id: '', name: '', accept: 'image/png,image/jpeg,image/gif,image/webp', isConnected: true, files: [] };
  avatar.previousElementSibling = fileInput;
  const fileListeners = new Map();
  const deliverFile = (file) => {
    fileInput.files = [file];
    if (fileEvent !== 'missing') fileListeners.get('change')?.({ type: 'change', target: fileInput, isTrusted: fileEvent !== 'untrusted' });
    fileInput.files = [];
    avatarErrorText = validateAvatarFile(file)?.message ?? null;
    if (errorText !== undefined) avatarErrorText = errorText;
    if (fileEvent === 'document') { documentTimeOrigin++; document = { ...document }; }
    if (fileEvent === 'target') { fileInput.isConnected = false; avatar.previousElementSibling = { ...fileInput, isConnected: true }; }
  };
  const upload = control('Upload photo', 'Upload photo', { x: 20, y: 130, width: 120, height: 24 });
  if (reject === 'disabled') avatar.disabled = true;
  let document = {
    defaultView: view, body: { innerText: 'Account' },
    addEventListener: (type, handler, capture) => { assert.equal(capture, true); fileListeners.set(type, handler); },
    removeEventListener: (type, handler, capture) => { assert.equal(capture, true); assert.equal(fileListeners.get(type), handler); fileListeners.delete(type); },
    querySelector: (selector) => selector === '[data-testid="human-avatar-error"]' ? (avatarErrorText ? { textContent: avatarErrorText } : null) : null,
    querySelectorAll: (selector) => selector === 'input[type="file"]' ? [fileInput] : selector === '[role=menuitem]' ? (menuOpen ? [upload] : []) :
      selector === 'button[aria-label=' + JSON.stringify(avatar.label) + ']' ? (reject === 'ambiguous' ? [avatar, { ...avatar }] : [avatar]) : [],
    elementFromPoint: (_x, y) => (reject === 'avatar-hit' && y < 100) || (reject === 'upload-hit' && y > 100) ? avatar : (y < 100 ? avatar : upload),
  };
  // A blocker distinct from the first target makes the first refusal observable.
  if (reject === 'avatar-hit') document.elementFromPoint = () => upload;
  const c = {
    evaluate: async (expression) => {
      if (reject === 'route' && expression.startsWith('(function leftControlTarget')) location.hash = '#/elsewhere';
      if (captureReadFails && expression.startsWith('(function avatarFileCapture') && expression.endsWith('("read")')) throw Error('controlled File capture read failure');
      const value = runInNewContext(expression, { document, window: view, location, performance: { timeOrigin: documentTimeOrigin } });
      // Runtime.evaluate(returnByValue) crosses the CDP JSON boundary; VM prototypes do not.
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    },
    send: async (method, args) => {
      assert.equal(method, 'Input.dispatchMouseEvent');
      const target = view.__b2LeftClickTarget;
      assert(target, 'Checked input must retain its actual target through dispatch');
      events.push({ target: target.label, ...args });
      if (args.type === 'mouseReleased') {
        if (target === avatar) menuOpen = true;
        else { menuOpen = false; filename = ++uploads === 1 ? avatarRecoveryParameters.filename : validName; moreTapped = browseTapped = false; }
      }
    },
  };
  const originalExec = childProcess.default.execFileSync;
  childProcess.default.execFileSync = (_file, args) => {
    const command = args.slice(2);
    if (command[0] === 'shell' && ['rm', 'test', 'uiautomator'].includes(command[1])) return '';
    if (command[0] === 'shell' && command[1] === 'cat') {
      treeReads++;
      if (pickerFailure && treeReads === 2) { lookupFailed = true; throw mainError; }
      if (diagnosticsFail && lookupFailed) throw Error('controlled UI diagnostic failure');
      if (diagnostic) {
        const nodes = photoPickerFixtureNodes();
        if (moreTapped) nodes.push({ ...nodes[1], text: 'controlled unknown menu content' });
        return '<hierarchy>' + nodes.map((node) => '<node ' + Object.entries(node).map(([key, value]) => `${key}="${value}"`).join(' ') + ' />').join('') + '</hierarchy>';
      }
      if (photoPicker && !browseTapped) {
        const nodes = moreTapped ? photoPickerBrowseFixture() : photoPickerFixtureNodes();
        return '<hierarchy>' + nodes.map((node) => '<node ' + Object.entries(node).map(([key, value]) => `${key}="${value}"`).join(' ') + ' />').join('') + '</hierarchy>';
      }
      return `<hierarchy><node package="${postBrowse === 'identity' ? 'other.package' : 'com.google.android.documentsui'}" text="${postBrowse === 'control' ? 'unrelated text' : describedFiles ? '' : filename}" content-desc="${describedFiles ? filename + ', ' + (filename === avatarRecoveryParameters.filename ? avatarRecoveryParameters.bytes : 117) + ' B, 10:12 AM' : ''}" enabled="true" clickable="false" focusable="true" bounds="[0,0][100,100]" /></hierarchy>`;
    }
    if (command[0] === 'shell' && command[1] === 'input') {
      nativeTaps.push(command);
      if (diagnostic) moreTapped = true;
      else if (photoPicker && !moreTapped) moreTapped = true;
      else if (photoPicker && !browseTapped) browseTapped = true;
      else {
        chosen.push(filename);
        const invalid = filename === avatarRecoveryParameters.filename;
        const file = { name: filename, type: 'image/png', size: invalid ? readFileSync(join(directory, filename)).length : 117, contents: 'never export file contents' };
        if (invalid && fileEvent === 'name') file.name = 'different.png';
        if (invalid && fileEvent === 'type') file.type = 'image/jpeg';
        if (invalid && fileEvent === 'size') file.size++;
        if (lateFileEvent) pendingFile = file; else deliverFile(file);
      }
      return '';
    }
    if (command[0] === 'shell' && command[1] === 'dumpsys') {
      if (diagnosticsFail && lookupFailed) throw Error('controlled window diagnostic failure');
      return 'mCurrentFocus=controlled-picker';
    }
    if (command[0] === 'exec-out' && command[1] === 'screencap') {
      if (diagnosticsFail && lookupFailed) throw Error('controlled screenshot failure');
      captures.push(filename);
      return Buffer.from('controlled image, not device evidence');
    }
    assert.fail('Unexpected ADB command ' + JSON.stringify(command));
  };
  syncBuiltinESMExports();
  let error;
  try {
    try {
      await runB2({ c, diagnostic, serial: 'emulator-controlled', root: directory + '/', out: directory, fixture: {},
        token: 'controlled', adb: (...args) => { adbCalls.push(args); return ''; }, wait: async (expression) => {
          waits.push(expression);
          if (pendingFile) { deliverFile(pendingFile); pendingFile = null; }
          if (expression.includes('human-avatar-error'))
            assert(runInNewContext(expression, { document }), 'controlled avatar error predicate not satisfied');
        },
        api: async () => { assert(!diagnostic, 'Menu diagnostic must not run upload API actions'); return { avatar_url: chosen.includes(validName) ? 'new-avatar' : oldAvatarChanged && chosen.length ? 'unexpected-avatar' : 'old-avatar' }; },
        observe: (...args) => record.observe(...args),
        step: async (id, fn) => { if (diagnostic || id === 'B2.avatar.error-recovery') await record.step(id, fn); },
      });
      record.complete();
    } catch (caught) { error = caught; record.fail(caught); }
    const generated = diagnostic ? null : readFileSync(join(directory, avatarRecoveryParameters.filename));
    return { error, mainError, events, chosen, captures, nativeTaps, adbCalls, waits,
      generated: generated ? { size: generated.length, sha256: createHash('sha256').update(generated).digest('hex') } : null,
      targetReleased: view.__b2LeftClickTarget === undefined,
      files: [...new Set(record.data.observations.filter((o) => o.name.endsWith('-screenshot') && o.value.status === 'observed').map((o) => o.value.value.file))],
      raw: JSON.parse(readFileSync(join(directory, 'raw.json'))), validName };
  } finally {
    childProcess.default.execFileSync = originalExec; syncBuiltinESMExports();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('avatar file picker rejects the actual target before dispatch and releases its reference', async () => {
  for (const reject of ['avatar-hit', 'ambiguous', 'disabled', 'route', 'upload-hit']) {
    const result = await avatarPickerFixture({ reject });
    assert(result.error, reject);
    assert.match(result.error.message, reject === 'ambiguous' ? /Expected one visible control/ :
      reject === 'disabled' ? /Control disabled/ : reject === 'route' ? /route_changed/ : /occluded/);
    assert.equal(result.events.filter((e) => e.target === 'Upload photo').length, 0, reject);
    assert.equal(result.events.filter((e) => e.target === 'Change avatar').length, reject === 'upload-hit' ? 2 : 0, reject);
    assert.equal(result.chosen.length, 0);
    assert.equal(result.targetReleased, true);
  }
});

test('avatar file picker uses one guarded pair per control on both existing upload paths', async () => {
  const result = await avatarPickerFixture();
  assert.equal(result.error, undefined);
  assert.deepEqual(result.chosen, [avatarRecoveryParameters.filename, result.validName]);
  assert.deepEqual(result.events.map((e) => [e.target, e.type]), [
    ['Change avatar', 'mousePressed'], ['Change avatar', 'mouseReleased'],
    ['Upload photo', 'mousePressed'], ['Upload photo', 'mouseReleased'],
    ['Change avatar', 'mousePressed'], ['Change avatar', 'mouseReleased'],
    ['Upload photo', 'mousePressed'], ['Upload photo', 'mouseReleased'],
  ]);
  assert.deepEqual(result.files, ['avatar-file-invalid-before-lookup.png', 'avatar-file-valid-before-lookup.png']);
  const targets = result.raw.observations.filter((o) => o.name.endsWith('-target') && o.value.ready !== undefined);
  assert.equal(targets.length, 4);
  assert(targets.every((o) => o.value.ready && Number.isFinite(o.value.sampledAt)));
  assert.equal(result.raw.steps[0].status, 'passed');
  assert.equal(result.targetReleased, true);
});

test('avatar file picker diagnostics retain the original lookup failure', async () => {
  const result = await avatarPickerFixture({ pickerFailure: true, diagnosticsFail: true });
  assert.equal(result.error.cause, result.mainError);
  assert.match(result.error.message, /Native UI tree read failed: controlled-picker-failure/);
  assert.equal(result.raw.first_error.message, String(result.error));
  const unknown = result.raw.observations.filter((o) => o.value.status === 'unknown');
  const readFailure = unknown.filter((o) => o.name.endsWith('avatar-file-selection-read-error'));
  assert.equal(readFailure.length, 1); assert.equal(readFailure[0].value.nodes, undefined); assert(readFailure[0].value.at);
  const failedSamples = unknown.filter((o) => o !== readFailure[0]);
  assert.equal(failedSamples.length, 4);
  assert(failedSamples.every((o) => o.value.sampleStartedAt && o.value.sampleFinishedAt));
  assert.equal(result.raw.observations.find((o) => o.name === 'avatar-file-invalid-first-error').value.value.stage, 'file-lookup');
  assert.equal(result.events.length, 4);
  assert.equal(result.targetReleased, true);
});

function photoPickerFixtureNodes() {
  const node = (attributes) => ({ package: 'com.google.android.photopicker', text: '', 'content-desc': '', enabled: 'true', clickable: 'false', bounds: '[0,0][400,800]', ...attributes });
  return [node({}), node({ text: 'Photos' }), node({ text: 'Albums' }),
    node({ 'content-desc': 'More', bounds: '[320,110][340,130]' }),
    node({ clickable: 'true', bounds: '[310,100][350,140]' })];
}

test('photo picker More refuses missing, ambiguous, disabled and offscreen targets before tap', async () => {
  const cases = [
    ['identity', (n) => { n[0].package = 'other'; }, /Not the observed Photo Picker/],
    ['surface', (n) => { n[1].text = 'other'; }, /main surface changed/],
    ['missing', (n) => { n[3]['content-desc'] = ''; }, /label missing or ambiguous/],
    ['ambiguous', (n) => { n.push({ ...n[4] }); }, /clickable target missing or ambiguous/],
    ['disabled', (n) => { n[4].enabled = 'false'; }, /target disabled/],
    ['offscreen', (n) => { n[4].bounds = '[310,100][450,140]'; }, /target outside screen/],
    ['malformed', (n) => { n[3].bounds = 'bad'; }, /label outside screen/],
  ];
  for (const [name, alter, expected] of cases) {
    const nodes = photoPickerFixtureNodes(); alter(nodes); let taps = 0;
    assert.throws(() => photoPickerMoreTarget(nodes), expected, name);
    await assert.rejects(inspectPhotoPickerMore({ adb: () => taps++, nodes: () => assert.fail('Invalid before-state must stop') }, () => {}, () => {}, { status: 'observed', value: nodes, capture: { window: 'observed', screenshot: 'observed' } }), expected, name);
    assert.equal(taps, 0, name);
  }
});

test('photo picker More uses fresh geometry once and stops on a changed interface or unchanged result', async () => {
  const before = photoPickerFixtureNodes(), events = [], observations = [];
  const snapshot = (value) => ({ status: 'observed', value, capture: { window: 'observed', screenshot: 'observed' } });
  const after = [...before, { ...before[1], text: 'controlled unknown menu content' }];
  const result = await inspectPhotoPickerMore({ nodes: () => structuredClone(before), adb: (...args) => events.push(args) }, (name, value) => observations.push({ name, value }),
    async () => snapshot(after), snapshot(before));
  assert.deepEqual(events, [['shell', 'input', 'tap', '330', '120']]);
  assert.equal(result.errorRecoveryValidated, false);
  assert.equal(result.tapAttempts, 1);
  const moved = structuredClone(before); moved[4].bounds = '[311,100][351,140]';
  await assert.rejects(inspectPhotoPickerMore({ nodes: () => moved, adb: () => assert.fail('Changed tree must not tap') }, () => {}, () => {}, snapshot(before)), /changed before More tap/);
  let attempts = 0;
  await assert.rejects(inspectPhotoPickerMore({ nodes: () => before, adb: () => attempts++ }, () => {}, async () => snapshot(before), snapshot(before)), /made no visible change/);
  assert.equal(attempts, 1);
  for (const field of ['ui', 'screenshot', 'window']) {
    let failedCaptureTaps = 0;
    const failedObservations = [];
    const failed = snapshot(after);
    if (field === 'ui') failed.status = 'unknown'; else failed.capture[field] = 'unknown';
    await assert.rejects(inspectPhotoPickerMore({ nodes: () => before, adb: () => failedCaptureTaps++ }, (name, value) => failedObservations.push({ name, value }), async () => failed, snapshot(before)), new RegExp('after-menu ' + (field === 'ui' ? 'UI' : field) + ' unavailable'));
    assert.equal(failedCaptureTaps, 1, 'Capture failure must not retry the returned tap');
    assert.equal(failedObservations.find((o) => o.name === 'photo-picker-more-dispatch-returned').value.status, 'observed');
    assert.equal(failedObservations.find((o) => o.name === 'photo-picker-more-first-error').value.value.stage, 'after-menu');
  }
});

test('photo picker More normal-product DIAG opens Add avatar and records only menu inspection', async () => {
  const result = await avatarPickerFixture({ diagnostic: 'photo-picker-menu' });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.events.map((e) => e.target), ['Add avatar', 'Add avatar', 'Upload photo', 'Upload photo']);
  assert.deepEqual(result.nativeTaps, [['shell', 'input', 'tap', '330', '120']]);
  assert.deepEqual(result.chosen, []);
  assert(!result.adbCalls.some((args) => args[0] === 'push'));
  assert.deepEqual(result.raw.steps.map((s) => s.id), ['DIAG.real-page-login', 'DIAG.photo-picker-menu']);
  assert.equal(result.raw.steps[1].detail.errorRecoveryValidated, false);
  assert.deepEqual(result.files, ['avatar-file-menu-before-more-menu.png', 'photo-picker-after-menu.png']);
  assert.equal(result.targetReleased, true);
});

function photoPickerBrowseFixture() {
  const node = (attributes) => ({ package: 'com.google.android.photopicker', text: '', 'content-desc': '', enabled: 'true', clickable: 'false', ...attributes });
  return [node({ bounds: '[60,200][380,300]' }),
    node({ text: 'Browse…', bounds: '[70,210][200,240]' }),
    node({ clickable: 'true', bounds: '[60,200][380,250]' }),
    node({ text: 'Cloud media app', bounds: '[70,260][300,290]' })];
}

async function avatarBrowserNavigationFixture({ alterMenu, changeFresh, postBrowser, chooserError, direct = false } = {}) {
  const filename = 'b2-invalid.png';
  const picker = photoPickerFixtureNodes(), menu = photoPickerBrowseFixture();
  if (alterMenu) alterMenu(menu);
  const browser = postBrowser ?? [{ package: 'com.google.android.documentsui', text: filename, enabled: 'true', bounds: '[0,0][100,100]' }];
  const snapshot = (nodes) => ({ status: 'observed', value: nodes, capture: { window: 'observed', screenshot: 'observed' } });
  const taps = [], reads = [], captures = [], chosen = [], observations = [];
  let error;
  try {
    await chooseAvatarPickerFile({
      nodes: () => {
        const fresh = structuredClone(reads.length ? menu : picker); reads.push(fresh);
        if (changeFresh && reads.length === 2) fresh[2].bounds = '[61,200][381,250]';
        return fresh;
      },
      adb: (...args) => taps.push(args),
      chooseFile: (name) => { chosen.push(name); if (chooserError) throw chooserError; },
    }, filename, (name, value) => observations.push({ name, value }), async (phase) => {
      captures.push(phase); return snapshot(phase === 'after-menu' ? menu : browser);
    }, snapshot(direct ? browser : picker));
  } catch (caught) { error = caught; }
  return { error, taps, reads, captures, chosen, observations };
}

test('avatar browser navigation rejects Browse mismatch before its tap', async () => {
  const cases = [
    ['identity', (n) => { n[0].package = 'other'; }, /Left Photo Picker after More tap/],
    ['missing', (n) => { n[1].text = 'other'; }, /label missing or ambiguous/],
    ['ambiguous', (n) => { n.push({ ...n[2] }); }, /clickable target missing or ambiguous/],
    ['disabled', (n) => { n[2].enabled = 'false'; }, /target disabled/],
    ['offscreen', (n) => { n[2].bounds = '[60,200][450,250]'; }, /target outside screen/],
    ['malformed', (n) => { n[1].bounds = 'invalid'; }, /label outside screen/],
  ];
  for (const [name, alterMenu, expected] of cases) {
    const result = await avatarBrowserNavigationFixture({ alterMenu });
    assert.match(result.error.message, expected, name);
    assert.equal(result.taps.length, 1, 'Only the preceding More tap may have happened');
    assert.deepEqual(result.chosen, []);
  }
  const changed = await avatarBrowserNavigationFixture({ changeFresh: true });
  assert.match(changed.error.message, /changed before Browse tap/);
  assert.equal(changed.taps.length, 1);
  assert.deepEqual(changed.chosen, []);
});

test('avatar browser navigation connects one More and Browse tap to the original chooser or preserves failure', async () => {
  const result = await avatarBrowserNavigationFixture();
  assert.equal(result.error, undefined);
  assert.deepEqual(result.taps, [['shell', 'input', 'tap', '330', '120'], ['shell', 'input', 'tap', '220', '225']]);
  assert.deepEqual(result.captures, ['after-menu', 'after-browse']);
  assert.equal(result.reads.length, 2); // Two fresh reads + two captured reads, beyond the existing before snapshot.
  assert.deepEqual(result.chosen, ['b2-invalid.png']);
  const direct = await avatarBrowserNavigationFixture({ direct: true });
  assert.equal(direct.error, undefined); assert.deepEqual(direct.taps, []); assert.deepEqual(direct.reads, []);
  assert.deepEqual(direct.chosen, ['b2-invalid.png']);
  const original = Error('controlled original chooseFile failure');
  const failed = await avatarBrowserNavigationFixture({ chooserError: original });
  assert.equal(failed.error, original); assert.equal(failed.taps.length, 2);
  assert.equal(failed.observations.at(-1).value.value.stage, 'choose-file');
  for (const postBrowser of [
    [{ package: 'unknown', text: 'b2-invalid.png', enabled: 'true' }],
    [{ package: 'com.google.android.documentsui', text: 'unknown control', enabled: 'true' }],
  ]) {
    const rejected = await avatarBrowserNavigationFixture({ postBrowser });
    assert.match(rejected.error.message, /existing file-browser contract/);
    assert.equal(rejected.taps.length, 2); assert.deepEqual(rejected.chosen, []);
    assert.equal(rejected.observations.at(-1).value.value.stage, 'after-browse');
  }
});

test('avatar browser navigation wires both ordinary uploads and rejects an unknown post-Browse surface', async () => {
  const result = await avatarPickerFixture({ photoPicker: true });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.chosen, [avatarRecoveryParameters.filename, result.validName]);
  assert.equal(result.nativeTaps.length, 6); // More, Browse, original file tap for each upload.
  assert.equal(result.events.length, 8);
  assert.equal(result.raw.steps[0].status, 'passed');
  assert.deepEqual(result.files, ['avatar-file-invalid-before-lookup.png', 'avatar-file-invalid-after-menu.png', 'avatar-file-invalid-after-browse.png', 'avatar-file-valid-before-lookup.png', 'avatar-file-valid-after-menu.png', 'avatar-file-valid-after-browse.png']);
  for (const postBrowse of ['identity', 'control']) {
    const failed = await avatarPickerFixture({ photoPicker: true, postBrowse });
    assert.match(failed.error.message, /existing file-browser contract/);
    assert.deepEqual(failed.chosen, []); assert.equal(failed.nativeTaps.length, 2);
    assert.equal(failed.raw.status, 'failed'); assert.equal(failed.raw.steps[0].status, 'failed');
    assert.match(failed.raw.first_error.message, /existing file-browser contract/);
    assert.equal(failed.targetReleased, true);
    assert(failed.files.includes('avatar-file-invalid-after-browse.png') && failed.files.includes('avatar-file-invalid-after-first-error.png'));
  }
});

function strictFileNodes(filename = 'b2-invalid.png') {
  return [{ text: '', bounds: '[0,0][400,800]' },
    { text: '', 'content-desc': filename + ', 12 B, 10:12 AM', enabled: 'true', clickable: 'false', focusable: 'true', bounds: '[20,100][180,300]' },
    { text: '', 'content-desc': 'Preview the file ' + filename, 'resource-id': 'com.google.android.documentsui:id/preview_icon', enabled: 'true', clickable: 'true', bounds: '[130,100][180,150]' }];
}

test('strict native file target accepts full names and rejects prefixes Preview ambiguity and bad geometry', () => {
  const filename = 'b2-invalid.png', nodes = strictFileNodes(filename);
  const target = nativeFileTarget(nodes, filename);
  assert.equal(target.matchedBy, 'content-desc');
  assert.equal(target.node.clickable, 'false');
  assert.deepEqual(target.point, { x: 100, y: 200 });
  for (const desc of [filename + '.other, 12 B, 10:12 AM', 'Preview the file ' + filename, filename + ', ']) {
    const wrong = structuredClone(nodes); wrong[1]['content-desc'] = desc;
    assert.equal(nativeFileTarget(wrong, filename), null, desc);
  }
  const legacy = structuredClone(nodes); legacy[1].text = filename; legacy[1]['content-desc'] = '';
  assert.equal(nativeFileTarget(legacy, filename).matchedBy, 'text');
  const previewText = structuredClone(nodes); previewText[1].text = filename; previewText[1]['resource-id'] = 'other:id/preview_icon';
  assert.equal(nativeFileTarget(previewText, filename), null);
  for (const [name, alter, expected] of [
    ['ambiguous', (n) => n.push({ ...n[1] }), /Ambiguous native file target/],
    ['disabled', (n) => { n[1].enabled = 'false'; }, /target disabled/],
    ['bounds', (n) => { n[1].bounds = 'bad'; }, /invalid or offscreen bounds/],
    ['offscreen', (n) => { n[1].bounds = '[20,100][450,300]'; }, /invalid or offscreen bounds/],
    ['preview overlap', (n) => { n[2].bounds = '[90,190][110,210]'; }, /center overlaps Preview/],
  ]) {
    const rejected = structuredClone(nodes); alter(rejected);
    assert.throws(() => nativeFileTarget(rejected, filename), expected, name);
  }
});

async function strictNativeChooserFixture(trees, { observerFails = false, readFailureAt } = {}) {
  const childProcess = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const original = childProcess.default.execFileSync, commands = [], observations = [];
  let reads = 0, error;
  const readError = Error('controlled native tree read failure');
  childProcess.default.execFileSync = (_file, args) => {
    const cmd = args.slice(2); commands.push(cmd);
    if (['rm', 'test', 'uiautomator'].includes(cmd[1])) return '';
    if (cmd[1] === 'cat') {
      reads++;
      if (reads === readFailureAt) throw readError;
      const nodes = trees[Math.min(reads - 1, trees.length - 1)];
      return '<hierarchy>' + nodes.map((node) => '<node ' + Object.entries(node).map(([key, value]) => `${key}="${value}"`).join(' ') + ' />').join('') + '</hierarchy>';
    }
    if (cmd[1] === 'input') return '';
    assert.fail(JSON.stringify(cmd));
  };
  syncBuiltinESMExports();
  try { await nativeUI('emulator-controlled').chooseFile('b2-invalid.png', (phase, value) => { observations.push({ phase, value }); if (observerFails) throw Error('controlled callback failure'); }); }
  catch (caught) { error = caught; }
  finally { childProcess.default.execFileSync = original; syncBuiltinESMExports(); }
  return { error, reads, readError, observations, taps: commands.filter((cmd) => cmd[1] === 'input') };
}

function downloadsFileNodes({ mode = 'grid', target = false } = {}) {
  const prefix = 'com.google.android.documentsui:id/';
  return [strictFileNodes()[0],
    { text: 'Downloads', 'resource-id': prefix + 'breadcrumb_text', enabled: 'true', bounds: '[0,0][100,30]' },
    { 'resource-id': prefix + 'dir_list', enabled: 'true', bounds: '[0,80][400,800]' },
    { 'resource-id': prefix + (mode === 'grid' ? 'sub_menu_list' : 'sub_menu_grid'), 'content-desc': mode === 'grid' ? 'List view' : 'Grid view', enabled: 'true', clickable: 'true', bounds: '[300,30][380,70]' },
    ...(target ? strictFileNodes().slice(1) : []),
  ].map((node) => ({ ...node, package: 'com.google.android.documentsui' }));
}

test('Downloads initial exact target keeps direct selection without switching either mode', async () => {
  for (const mode of ['grid', 'list']) {
    const first = downloadsFileNodes({ mode, target: true }), fresh = structuredClone(first);
    fresh[4].bounds = '[30,110][190,310]';
    const result = await strictNativeChooserFixture([first, fresh]);
    assert.equal(result.error, undefined); assert.equal(result.reads, 2);
    assert.deepEqual(result.taps, [['shell', 'input', 'tap', '110', '210']]);
    assert(!result.observations.some((o) => o.phase === 'view-target'));
    assert.equal(result.observations.find((o) => o.phase === 'target').value.directory.mode, mode);
  }
});

test('Downloads already-list lookup uses its original reads with zero root or view navigation', async () => {
  const list = downloadsFileNodes({ mode: 'list' }), found = downloadsFileNodes({ mode: 'list', target: true });
  const result = await strictNativeChooserFixture([list, list, found]);
  assert.equal(result.error, undefined); assert.equal(result.reads, 3);
  assert.deepEqual(result.taps, [['shell', 'input', 'tap', '100', '200']]);
  assert.equal(result.observations.filter((o) => o.value.nodes).length, 3);
});

test('Downloads missing grid target switches once then uses a fresh exact file point without roots', async () => {
  const grid = downloadsFileNodes(), list = downloadsFileNodes({ mode: 'list' }), fresh = downloadsFileNodes({ mode: 'list', target: true });
  fresh[4].bounds = '[30,110][190,310]';
  const result = await strictNativeChooserFixture([grid, list, fresh]);
  assert.equal(result.error, undefined); assert.equal(result.reads, 3);
  assert.deepEqual(result.taps, [['shell', 'input', 'tap', '340', '50'], ['shell', 'input', 'tap', '110', '210']]);
  assert.equal(result.observations.filter((o) => o.phase === 'view-target').length, 1);
  assert.equal(result.observations.filter((o) => o.phase === 'view-dispatch-returned').length, 1);
  assert.equal(result.observations.filter((o) => o.phase === 'dispatch-returned').length, 1);
  assert.equal(result.observations.filter((o) => o.value.nodes).length, 3);
});

test('Downloads view control missing ambiguity disabled wrong identity or invalid geometry refuses before input', async () => {
  for (const [alter, expected] of [
    [(n) => n.splice(3, 1), /view control missing or ambiguous/],
    [(n) => n.push({ ...n[3] }), /view control missing or ambiguous/],
    [(n) => { n[3].enabled = 'false'; }, /view control unavailable/],
    [(n) => { n[3].clickable = 'false'; }, /view control unavailable/],
    [(n) => { n[3]['content-desc'] = 'other'; }, /view control identity changed/],
    [(n) => { n[3].bounds = 'bad'; }, /invalid or offscreen bounds/],
    [(n) => { n[3].bounds = '[300,30][450,70]'; }, /invalid or offscreen bounds/],
  ]) {
    const nodes = downloadsFileNodes(); alter(nodes);
    const result = await strictNativeChooserFixture([nodes]);
    assert.match(result.error.message, expected); assert.equal(result.reads, 1); assert.equal(result.taps.length, 0);
    assert.deepEqual(result.observations.find((o) => o.phase === 'target-rejected').value.nodes, nodes);
  }
});

test('Downloads directory and positive view mode are checked on every lookup before a file tap', async () => {
  for (const [alter, expected] of [
    [(n) => { n[1].text = 'Recent'; }, /Downloads directory missing or ambiguous/],
    [(n) => n.splice(1, 1), /Downloads directory missing or ambiguous/],
    [(n) => n.push({ ...n[1] }), /Downloads directory missing or ambiguous/],
    [(n) => { n[0].package = 'unknown.dialog'; }, /Downloads picker identity changed/],
    [(n) => n.splice(2, 1), /Downloads file container missing or ambiguous/],
    [(n) => n.splice(3, 1), /Downloads view control missing or ambiguous/],
    [(n) => { n[3]['resource-id'] = 'com.google.android.documentsui:id/sub_menu_list'; n[3]['content-desc'] = 'List view'; }, /Downloads view mode changed or not established/],
  ]) {
    const grid = downloadsFileNodes(), list = downloadsFileNodes({ mode: 'list' });
    const drift = downloadsFileNodes({ mode: 'list', target: true }); alter(drift);
    for (const trees of [[grid, drift], [grid, list, drift]]) {
      const result = await strictNativeChooserFixture(trees);
      assert.match(result.error.message, expected); assert.equal(result.reads, trees.length);
      assert.deepEqual(result.taps, [['shell', 'input', 'tap', '340', '50']]);
      const refused = result.observations.find((o) => o.phase === 'target-rejected');
      assert.deepEqual(refused.value.nodes, drift); assert.equal(refused.value.readIndex, trees.length - 1);
    }
  }
});

test('Downloads direct target cannot bypass later directory or mode drift', async () => {
  const first = downloadsFileNodes({ target: true }), changed = downloadsFileNodes({ mode: 'list', target: true });
  const result = await strictNativeChooserFixture([first, changed]);
  assert.match(result.error.message, /Downloads view mode changed or not established/);
  assert.equal(result.reads, 2); assert.equal(result.taps.length, 0);
});

test('Downloads full filename and Preview rules remain strict after switching', async () => {
  const first = downloadsFileNodes(), wrong = downloadsFileNodes({ mode: 'list', target: true });
  wrong[4]['content-desc'] = 'b2-invalid.png.other, 12 B';
  const ambiguous = downloadsFileNodes({ mode: 'list', target: true }); ambiguous.push({ ...ambiguous[4] });
  const result = await strictNativeChooserFixture([first, wrong, ambiguous]);
  assert.match(result.error.message, /Ambiguous native file target/); assert.equal(result.reads, 13);
  assert.deepEqual(result.taps, [['shell', 'input', 'tap', '340', '50']]);
  assert.equal(result.observations.find((o) => o.phase === 'lookup-first-miss').value.target, null);
  assert.equal(result.observations.find((o) => o.phase === 'lookup-last').value.decision, 'ambiguous');
});

test('Downloads exhausted lookup retains original read budget and three trees despite observer errors', async () => {
  const result = await strictNativeChooserFixture([downloadsFileNodes(), downloadsFileNodes({ mode: 'list' })], { observerFails: true });
  assert.match(result.error.message, /^Native UI control not found$/); assert.equal(result.reads, 13);
  assert.deepEqual(result.taps, [['shell', 'input', 'tap', '340', '50']]);
  const trees = result.observations.filter((o) => o.value.nodes);
  assert.deepEqual(trees.map((o) => o.phase), ['initial', 'lookup-first-miss', 'lookup-last']);
  assert.equal(trees.at(-1).value.readIndex, 12);
});

test('Downloads failed post-switch acquisition remains unknown and preserves its original cause', async () => {
  const result = await strictNativeChooserFixture([downloadsFileNodes()], { readFailureAt: 2 });
  assert.equal(result.error.cause, result.readError); assert.equal(result.reads, 2);
  assert.deepEqual(result.taps, [['shell', 'input', 'tap', '340', '50']]);
  const unknown = result.observations.find((o) => o.phase === 'read-error');
  assert.equal(unknown.value.status, 'unknown'); assert.equal(unknown.value.nodes, undefined);
  assert.equal(result.observations.filter((o) => o.value.nodes).length, 1);
});

function ambiguousDownloadsNodes(distinct = false) {
  const tree = downloadsFileNodes({ mode: 'list', target: true });
  tree.push({ ...tree[4], ...(distinct ? { bounds: '[210,110][390,310]' } : {}) });
  return tree;
}

test('file ambiguity waits for one fresh unique Downloads tree and uses only its new point', async () => {
  const initial = downloadsFileNodes({ mode: 'list', target: true }), ambiguous = ambiguousDownloadsNodes();
  const unique = downloadsFileNodes({ mode: 'list', target: true }); unique[4].bounds = '[30,110][190,310]';
  for (const observerFails of [false, true]) {
    const result = await strictNativeChooserFixture([initial, ambiguous, unique], { observerFails });
    assert.equal(result.error, undefined); assert.equal(result.reads, 3);
    assert.deepEqual(result.taps, [['shell', 'input', 'tap', '110', '210']]);
    const first = result.observations.find((o) => o.phase === 'lookup-first-miss');
    assert.equal(first.value.decision, 'ambiguous'); assert.equal(first.value.candidateCount, 2);
    assert.deepEqual(first.value.nodes, ambiguous);
    const target = result.observations.find((o) => o.phase === 'target');
    assert.deepEqual(target.value.nodes, unique); assert.equal(target.value.readIndex, 2);
    assert.equal(result.observations.filter((o) => o.value.nodes).length, 3);
  }
});

test('file ambiguity never merges coincident or separate candidates and ends with the last ambiguity', async () => {
  for (const distinct of [false, true]) {
    const initial = downloadsFileNodes({ mode: 'list' }), ambiguous = ambiguousDownloadsNodes(distinct);
    const result = await strictNativeChooserFixture([initial, ambiguous]);
    assert.match(result.error.message, /Ambiguous native file target/); assert.equal(result.error.name, 'AssertionError');
    assert.equal(result.reads, 13); assert.equal(result.taps.length, 0);
    const trees = result.observations.filter((o) => o.value.nodes);
    assert.deepEqual(trees.map((o) => o.phase), ['initial', 'lookup-first-miss', 'lookup-last']);
    assert.equal(trees.at(-1).value.readIndex, 12); assert.equal(trees.at(-1).value.decision, 'ambiguous');
    assert.equal(trees.at(-1).value.candidateCount, 2); assert.deepEqual(trees.at(-1).value.nodes, ambiguous);
    assert.equal(result.observations.at(-1).value.error.message, result.error.message);
  }
});

test('file ambiguity without confirmed Downloads still refuses immediately', async () => {
  const ambiguous = strictFileNodes(); ambiguous.push({ ...ambiguous[1] });
  for (const trees of [[ambiguous], [strictFileNodes(), ambiguous]]) {
    const result = await strictNativeChooserFixture(trees);
    assert.match(result.error.message, /Ambiguous native file target/);
    assert.equal(result.reads, trees.length); assert.equal(result.taps.length, 0);
    assert.equal(result.observations.find((o) => o.phase === 'target-rejected').value.decision, 'rejected');
  }
});

test('file ambiguity does not swallow later disabled geometry Preview directory or mode failures', async () => {
  for (const [alter, expected] of [
    [(n) => { n[4].enabled = 'false'; }, /Native file target disabled/],
    [(n) => { n[4].bounds = 'bad'; }, /Native file target has invalid or offscreen bounds/],
    [(n) => { n[5].bounds = '[90,190][110,210]'; }, /Native file target center overlaps Preview/],
    [(n) => { n[1].text = 'Recent'; }, /Downloads directory missing or ambiguous/],
    [(n) => { n[3]['resource-id'] = 'com.google.android.documentsui:id/sub_menu_list'; n[3]['content-desc'] = 'List view'; }, /Downloads view mode changed or not established/],
  ]) {
    const fatal = downloadsFileNodes({ mode: 'list', target: true }); alter(fatal);
    const result = await strictNativeChooserFixture([downloadsFileNodes({ mode: 'list' }), ambiguousDownloadsNodes(), fatal]);
    assert.match(result.error.message, expected); assert.equal(result.reads, 3); assert.equal(result.taps.length, 0);
    const refused = result.observations.find((o) => o.phase === 'target-rejected');
    assert.deepEqual(refused.value.nodes, fatal); assert.equal(refused.value.readIndex, 2);
    assert.equal(result.observations.filter((o) => o.value.nodes).length, 3);
  }
});

test('file ambiguity followed by a read failure records unknown rather than reusing its earlier tree', async () => {
  const result = await strictNativeChooserFixture([downloadsFileNodes({ mode: 'list' }), ambiguousDownloadsNodes()], { readFailureAt: 3 });
  assert.equal(result.error.cause, result.readError); assert.equal(result.reads, 3); assert.equal(result.taps.length, 0);
  const failed = result.observations.find((o) => o.phase === 'read-error');
  assert.equal(failed.value.status, 'unknown'); assert.equal(failed.value.nodes, undefined); assert.equal(failed.value.readIndex, 2);
  assert.equal(result.observations.at(-1).value.error.message, result.error.message);
});

test('file ambiguity timeout reports the actual last judgment instead of a stale earlier refusal', async () => {
  const initial = downloadsFileNodes({ mode: 'list' }), ambiguous = ambiguousDownloadsNodes(), missing = downloadsFileNodes({ mode: 'list' });
  for (const [trees, decision, expected] of [
    [[initial, ambiguous, missing], 'not_found', /^Native UI control not found$/],
    [[initial, missing, ambiguous], 'ambiguous', /Ambiguous native file target/],
  ]) {
    const result = await strictNativeChooserFixture(trees, { observerFails: true });
    assert.match(result.error.message, expected); assert.equal(result.reads, 13); assert.equal(result.taps.length, 0);
    const last = result.observations.find((o) => o.phase === 'lookup-last');
    assert.equal(last.value.readIndex, 12); assert.equal(last.value.decision, decision);
    assert.deepEqual(last.value.nodes, trees.at(-1)); assert.equal(result.observations.filter((o) => o.value.nodes).length, 3);
  }
});

test('strict native file chooser uses the same identity on fresh reads and selects the current directory once', async () => {
  const first = strictFileNodes(), fresh = structuredClone(first); fresh[1].bounds = '[30,110][190,310]';
  const direct = await strictNativeChooserFixture([first, fresh]);
  assert.equal(direct.error, undefined); assert.equal(direct.reads, 2);
  assert.deepEqual(direct.taps, [['shell', 'input', 'tap', '110', '210']]);
  assert.deepEqual(direct.observations.map((o) => o.phase), ['initial', 'target', 'dispatch-returned']);
  assert.equal(direct.observations[0].value.alreadyPresent, true);
  assert.deepEqual(direct.observations[1].value.point, { x: 110, y: 210 });
  assert.equal(direct.observations[2].value.eventConsumption, 'not_observed');
  const root = first[0], roots = [root, { 'content-desc': 'Show roots', enabled: 'true', bounds: '[0,0][20,20]' }];
  const downloads = [root, { text: 'Downloads', enabled: 'true', bounds: '[0,20][100,60]' }];
  const fallback = await strictNativeChooserFixture([[root], roots, downloads, first]);
  assert.equal(fallback.error, undefined); assert.equal(fallback.reads, 4);
  assert.equal(fallback.taps.length, 3); assert.equal(fallback.observations[0].value.alreadyPresent, false);
  const bad = strictFileNodes(); bad.push({ ...bad[1] });
  const refused = await strictNativeChooserFixture([first, bad]);
  assert.match(refused.error.message, /Ambiguous native file target/); assert.equal(refused.taps.length, 0);
});

test('strict native file chooser connects both ordinary avatar uploads using described file tiles', async () => {
  const result = await avatarPickerFixture({ photoPicker: true, describedFiles: true });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.chosen, [avatarRecoveryParameters.filename, result.validName]);
  assert.equal(result.nativeTaps.length, 6); // More/Browse/file once, twice; no roots navigation.
  assert.equal(result.events.length, 8); assert.equal(result.raw.steps[0].status, 'passed');
  const targets = result.raw.observations.filter((o) => o.name.endsWith('avatar-file-selection-target'));
  assert.equal(targets.length, 2); assert(targets.every((o) => o.value.matchedBy === 'content-desc' && o.value.node.clickable === 'false'));
  const returned = result.raw.observations.filter((o) => o.name.endsWith('avatar-file-selection-dispatch-returned'));
  assert.equal(returned.length, 2); assert(returned.every((o) => o.value.eventConsumption === 'not_observed'));
  assert.equal(result.targetReleased, true);
});

function avatarCaptureFixture() {
  const input = { tagName: 'INPUT', type: 'file', id: 'avatar-input', name: 'avatar', accept: 'image/png', isConnected: true, files: [] };
  const button = { previousElementSibling: input }, listeners = new Map();
  let ambiguous = false;
  const document = {
    querySelectorAll: () => ambiguous ? [button, button] : [button],
    addEventListener: (type, handler, capture) => { assert.equal(capture, true); listeners.set(type, handler); },
    removeEventListener: (type, handler, capture) => { assert.equal(capture, true); assert.equal(listeners.get(type), handler); listeners.delete(type); },
  };
  const context = { document, window: {}, location: { origin: 'https://localhost', href: 'https://localhost/#/settings?settingsSection=account' }, performance: { timeOrigin: 123 } };
  const read = (action) => JSON.parse(JSON.stringify(runInNewContext(`(${avatarFileCapture.toString()})(${JSON.stringify(action)})`, context)));
  const fire = (type, target = input) => listeners.get(type)?.({ type, target, isTrusted: true });
  return { input, button, listeners, context, read, fire, ambiguous: () => { ambiguous = true; } };
}

test('avatar file capture synchronously preserves metadata before React clears files and removes both listeners', () => {
  const f = avatarCaptureFixture();
  assert.equal(f.read('install').installed, true);
  f.input.files = [{ name: 'b2-invalid.png', type: 'image/png', size: 12, contents: 'private bytes' }];
  f.fire('change'); f.input.files = []; // The following React handler clears the live FileList.
  f.fire('cancel'); f.fire('change', { files: [] });
  const captured = f.read('read');
  assert.equal(captured.observedEventCount, 2);
  assert.deepEqual(captured.events[0].file, { name: 'b2-invalid.png', type: 'image/png', size: 12 });
  assert.equal(captured.events[1].type, 'cancel'); assert.equal(captured.events[1].file, null);
  assert(!JSON.stringify(captured).includes('private bytes'));
  assert.equal(captured.target.sameCurrentInput, true); assert.equal(captured.sameDocument, true);
  assert(f.read('release').release.every((r) => r.status === 'released'));
  assert.equal(f.listeners.size, 0); assert.equal(f.read('read').status, 'unknown');
});

test('avatar file capture bounds records and reports replacement and zero events without claiming cancellation', () => {
  const f = avatarCaptureFixture(); f.read('install');
  f.input.isConnected = false; f.button.previousElementSibling = { ...f.input, isConnected: true };
  f.fire('change', f.button.previousElementSibling);
  const zero = f.read('read');
  assert.equal(zero.observedEventCount, 0); assert.equal(zero.target.connected, false); assert.equal(zero.target.sameCurrentInput, false);
  assert.match(zero.zeroEventMeaning, /not proof of cancellation/); f.read('release');
  const bounded = avatarCaptureFixture(); bounded.read('install');
  for (let i = 0; i < 6; i++) bounded.fire('cancel');
  const result = bounded.read('release'); assert.equal(result.events.length, 4); assert.equal(result.observedEventCount, 6);
  const ambiguous = avatarCaptureFixture(); ambiguous.ambiguous();
  assert.throws(() => ambiguous.read('install'), /Unique avatar file input/); assert.equal(ambiguous.listeners.size, 0);
});

test('avatar file capture spans the native picker and original predicate waits for both ordinary uploads', async () => {
  const result = await avatarPickerFixture({ photoPicker: true, describedFiles: true, lateFileEvent: true });
  assert.equal(result.error, undefined); assert.equal(result.raw.steps[0].status, 'passed');
  const row = (name) => result.raw.observations.find((o) => o.name === 'avatar-file-capture-' + name).value.value;
  assert.equal(row('install').installed, true);
  assert.equal(row('invalid-after-picker').observedEventCount, 0); // Event arrives during the unchanged predicate wait.
  assert.equal(row('invalid-feedback').observedEventCount, 1);
  const released = row('release');
  assert.equal(released.observedEventCount, 2);
  assert.deepEqual(released.events.map((e) => e.file.name), [avatarRecoveryParameters.filename, result.validName]);
  assert(released.release.every((r) => r.status === 'released'));
  assert.equal(result.targetReleased, true);
});

test('avatar size scenario follows the real shared boundary and exact validation message', () => {
  const parameters = avatarRecoveryParameters;
  assert.equal(parameters.validation, 'frontend-size');
  assert.equal(parameters.maxBytes, AVATAR_MAX_BYTES);
  assert.equal(parameters.bytes, AVATAR_MAX_BYTES + 1);
  assert.equal(validateAvatarFile({ size: AVATAR_MAX_BYTES, type: parameters.mime }), null);
  assert.deepEqual(validateAvatarFile({ size: parameters.bytes, type: parameters.mime }), {
    code: 'avatar_too_large', message: parameters.expectedError,
  });
});

test('avatar size fixture is deterministic and its real generated size and digest match the record', async () => {
  const first = await avatarPickerFixture({ lateFileEvent: true }), second = await avatarPickerFixture();
  for (const result of [first, second]) {
    assert.equal(result.error, undefined); assert.equal(result.raw.steps[0].status, 'passed');
    assert.equal(result.generated.size, AVATAR_MAX_BYTES + 1);
    const fixture = result.raw.observations.find((o) => o.name === 'avatar-size-fixture').value;
    assert.equal(fixture.size, result.generated.size); assert.equal(fixture.sha256, result.generated.sha256);
    assert.equal(fixture.name, avatarRecoveryParameters.filename); assert.equal(fixture.type, 'image/png');
    assert.equal(fixture.construction, 'existing PNG seed + zero padding');
    const feedback = result.raw.observations.find((o) => o.name === 'avatar-file-capture-invalid-feedback').value.value;
    assert.deepEqual(feedback.events[0].file, { name: avatarRecoveryParameters.filename, type: 'image/png', size: AVATAR_MAX_BYTES + 1 });
    assert.deepEqual(result.chosen, [avatarRecoveryParameters.filename, result.validName]);
    assert(result.waits.some((expression) => expression.includes('textContent.trim()===') && expression.includes(JSON.stringify(avatarRecoveryParameters.expectedError))));
    assert(result.waits.some((expression) => expression === `!document.querySelector('[data-testid="human-avatar-error"]')`));
    assert(result.targetReleased);
  }
  assert.equal(first.generated.sha256, second.generated.sha256);
});

test('avatar size assertion refuses a different visible error and retains cleanup and the first failure', async () => {
  const result = await avatarPickerFixture({ errorText: 'Some other error' });
  assert.match(result.error.message, /controlled avatar error predicate not satisfied/);
  assert.deepEqual(result.chosen, [avatarRecoveryParameters.filename]);
  assert.equal(result.raw.first_error.message, String(result.error)); assert.equal(result.raw.steps[0].status, 'failed');
  const release = result.raw.observations.find((o) => o.name === 'avatar-file-capture-release').value.value;
  assert(release.release.every((row) => row.status === 'released')); assert(result.targetReleased);
});

test('avatar size assertion rejects missing untrusted mismatched or replaced File observations before valid recovery', async () => {
  for (const [fileEvent, expected] of [
    ['missing', /Expected one trusted avatar size File change/],
    ['untrusted', /Expected one trusted avatar size File change/],
    ['name', /Avatar size File metadata mismatch/],
    ['type', /Avatar size File metadata mismatch/],
    ['size', /Avatar size File metadata mismatch/],
    ['document', /Avatar size File capture identity changed/],
    ['target', /Avatar size File capture identity changed/],
  ]) {
    const result = await avatarPickerFixture({ fileEvent });
    assert.match(result.error.message, expected, fileEvent);
    assert.deepEqual(result.chosen, [avatarRecoveryParameters.filename]);
    assert.equal(result.raw.steps[0].status, 'failed'); assert.equal(result.raw.first_error.message, String(result.error));
    const release = result.raw.observations.find((o) => o.name === 'avatar-file-capture-release').value.value;
    assert(release.release.every((row) => row.status === 'released')); assert(result.targetReleased);
  }
});

test('avatar size unavailable capture and changed old avatar cannot pass the recovery step', async () => {
  for (const [options, expected] of [[{ captureReadFails: true }, /Avatar size File capture unavailable/], [{ oldAvatarChanged: true }, /unexpected-avatar/]]) {
    const result = await avatarPickerFixture(options);
    assert.match(result.error.message, expected);
    assert.deepEqual(result.chosen, [avatarRecoveryParameters.filename]);
    assert.equal(result.raw.steps[0].status, 'failed'); assert.equal(result.raw.first_error.message, String(result.error));
    const release = result.raw.observations.find((o) => o.name === 'avatar-file-capture-release').value.value;
    assert(release.release.every((row) => row.status === 'released')); assert(result.targetReleased);
  }
});

function restartPageDocument({ theme = 'glass', confirmation = 'confirmed', shell = 1, frame = 1, page = 1, inert = false, hidden = false, element = true } = {}) {
  const live = () => ({ isConnected: true, hasAttribute: (name) => name === 'inert' && inert, getAttribute: (name) => name === 'aria-hidden' && hidden ? 'true' : null });
  const frames = Array.from({ length: frame }, () => ({ isConnected: true, querySelectorAll: () => Array.from({ length: page }, live) }));
  const shells = Array.from({ length: shell }, () => ({ isConnected: true, querySelectorAll: () => frames }));
  return { documentElement: element ? { dataset: { theme, themePersistence: confirmation } } : null, readyState: 'complete', querySelectorAll: () => shells };
}

test('named restart readiness requires both theme confirmation and the real shell/current-page cold projection', () => {
  const inspect = (options = {}, route = '#/chat') => runInNewContext(`(${themeRestartPage.toString()})('glass')`, {
    document: restartPageDocument(options), location: { origin: 'https://localhost', href: 'https://localhost/' + route, hash: route }, performance: { timeOrigin: 17 },
  });
  assert.equal(inspect().ready, true);
  assert.equal(inspect({}, '').ready, false);
  assert.equal(inspect({}, '#/settings?settingsSection=appearance').ready, false);
  for (const options of [{ shell: 0 }, { shell: 2 }, { frame: 0 }, { page: 0 }, { page: 2 }, { inert: true }, { hidden: true }]) {
    const state = inspect(options); assert.equal(state.themeHeld, true); assert.equal(state.navigationReady, false); assert.equal(state.ready, false);
  }
  for (const options of [{ theme: 'poster' }, { confirmation: 'pending' }, { confirmation: 'unconfirmed' }, { element: false }]) {
    const state = inspect(options); assert.equal(state.navigationReady, true); assert.equal(state.themeHeld, false); assert.equal(state.ready, false);
  }
});

// Actual ordinary named handler, with a delayed renderer mount/projection and no device.
async function namedRestartFixture({ projected = true, retained = true, replaceBeforeGo = false, navigationFailure = false, diagnosticsFail = false } = {}) {
  const { runB2 } = await import('./acceptance-b2.mjs');
  const childProcess = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const directory = mkdtempSync(join(tmpdir(), 'named-restart-'));
  const record = new AcceptanceRecord(directory, ['B2.theme.named-and-restart', 'B2.avatar.error-recovery']);
  const themes = ['glass', 'studio-light', 'poster', 'iris', 'slack-dark'];
  const assignments = [], polls = [], commands = [], events = [];
  let route = '#/chat', theme = 'studio-light', selected = 0, restarts = 0, stage = 2, inWait = false, readyReads = 0, timeOrigin = 100;
  const pageState = () => ({ route, theme, confirmation: 'confirmed', appearance: JSON.stringify({ theme }) });
  const location = { origin: 'https://localhost', get hash() { return route; }, get href() { return 'https://localhost/' + route; } };
  const read = (expression) => runInNewContext(expression, {
    document: { ...restartPageDocument({ theme, shell: stage > 0 ? 1 : 0 }), body: { innerText: 'controlled registered page' } },
    location, performance: { timeOrigin }, getComputedStyle: () => ({ backgroundColor: 'rgb(1, 2, 3)' }), localStorage: { getItem: () => JSON.stringify({ theme }) },
  });
  let waitError;
  const c = {
    evaluate: async (expression) => {
      if (/^location\.hash=(?!=)/.test(expression)) {
        assignments.push({ restarts, stage, route, timeOrigin });
        route = '#' + JSON.parse(expression.slice(14));
        if (navigationFailure && restarts) route = '#/chat';
        return;
      }
      if (expression.includes('themeRestartPage')) {
        if (diagnosticsFail && expression.includes('bodyText:')) throw Error('controlled navigation diagnostic failure');
        if (!inWait && restarts) {
          readyReads++;
          if (replaceBeforeGo && readyReads === 2) timeOrigin++;
        }
        return read(expression);
      }
      if (expression.startsWith('delete window.')) return true;
      if (expression.startsWith('(function appearanceState')) return pageState();
      if (expression.startsWith('({...')) return { ...pageState(), origin: location.origin, href: location.href };
      if (expression.includes('leftControlTarget')) return { route, ready: true, fatal: false, notificationHit: false, point: { x: 100, y: 20 } };
      if (expression.includes('const candidates=')) return { x: 100, y: 100 };
      if (expression.startsWith('({theme:')) return { theme, stored: { theme }, background: 'rgb(1, 2, 3)' };
      return read(expression);
    },
    send: async (method, args) => {
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'target-' + restarts, type: 'page', url: location.href } };
      assert.equal(method, 'Input.dispatchMouseEvent'); events.push(args);
      if (args.type === 'mouseReleased') theme = themes[selected++];
    },
  };
  const originalExec = childProcess.default.execFileSync;
  childProcess.default.execFileSync = (_file, args) => {
    assert.deepEqual(args.slice(2), ['exec-out', 'screencap', '-p']);
    if (diagnosticsFail) throw Error('controlled screenshot failure');
    return Buffer.from('controlled screenshot, not device evidence');
  };
  syncBuiltinESMExports();
  let error;
  try {
    try {
      await runB2({ c, serial: 'emulator-controlled', out: directory, root: directory + '/', fixture: {},
        adb: (...args) => {
          if (args[1] === 'pidof') return String(100 + restarts);
          commands.push(args);
          if (args.includes('start')) { restarts++; stage = 0; route = ''; timeOrigin += 100; readyReads = 0; if (!retained) theme = 'studio-light'; }
          return '';
        }, reconnect: async () => c,
        wait: async (expression) => {
          if (expression.includes('themeRestartPage')) {
            inWait = true;
            try {
              for (let i = 0; i < 3; i++) {
                const value = await c.evaluate(expression);
                polls.push({ restart: restarts, stage, route, value, assignments: assignments.length });
                if (value) return;
                stage = Math.min(2, stage + 1);
                if (stage === 2 && projected) route = '#/chat';
              }
            } finally { inWait = false; }
          } else if (await c.evaluate(expression)) return;
          waitError = Error('UI timed out: ' + expression + ' BODY controlled'); throw waitError;
        }, observe: (...args) => record.observe(...args),
        step: (name, action) => name === 'B2.theme.named-and-restart' ? record.step(name, action) : undefined,
        api: () => assert.fail('Unexpected file/server action'), call: () => assert.fail('Unexpected bridge action'), input: () => assert.fail('Unexpected form input'),
      });
    } catch (caught) { error = caught; record.fail(caught); }
    return { error, waitError, assignments, polls, commands, events, raw: JSON.parse(readFileSync(join(directory, 'raw.json'))) };
  } finally {
    childProcess.default.execFileSync = originalExec; syncBuiltinESMExports();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('named restart waits for delayed shell and address projection before each single navigation', async () => {
  const result = await namedRestartFixture();
  assert.equal(result.error, undefined); assert.equal(result.raw.steps[0].status, 'passed');
  assert.equal(result.assignments.length, 6); // Initial Appearance plus one after each restart.
  assert(result.assignments.slice(1).every((row) => row.stage === 2 && row.route === '#/chat'));
  for (let restart = 1; restart <= 5; restart++) {
    const polls = result.polls.filter((row) => row.restart === restart);
    assert.deepEqual(polls.map((row) => row.value), [false, false, true]);
    assert(polls.every((row) => row.assignments === restart)); // No navigation during either rejected read.
  }
  const observations = result.raw.observations;
  assert.equal(observations.filter((row) => row.name.endsWith('-restart-navigation-ready')).length, 5);
  assert.equal(observations.filter((row) => row.name.endsWith('-navigation-before')).length, 5);
  const after = observations.filter((row) => row.name.endsWith('-navigation-after'));
  assert.equal(after.length, 5); assert(after.every((row) => row.value.value.route === '#/settings?settingsSection=appearance'));
  assert.equal(result.commands.filter((args) => args.includes('force-stop')).length, 5);
});

test('named restart missing projection expires the original wait without dispatching another navigation', async () => {
  const result = await namedRestartFixture({ projected: false });
  assert.equal(result.error, result.waitError); assert.equal(result.assignments.length, 1);
  const last = result.raw.observations.find((row) => row.name.endsWith('-restart-navigation-last'));
  assert.equal(last.value.value.themeHeld, true); assert.equal(last.value.value.navigationReady, false);
  assert.deepEqual(result.raw.steps.map((row) => row.status), ['failed', 'not_executed']);
  assert.equal(result.raw.first_error.message, String(result.error));
});

test('named restart navigation readiness cannot hide a failed theme holding predicate', async () => {
  const result = await namedRestartFixture({ retained: false });
  assert.equal(result.error, result.waitError); assert.equal(result.assignments.length, 1);
  const last = result.raw.observations.find((row) => row.name.endsWith('-restart-navigation-last'));
  assert.equal(last.value.value.navigationReady, true); assert.equal(last.value.value.themeHeld, false);
});

test('named restart document replacement at the immediate pre-go check refuses navigation without another wait', async () => {
  const result = await namedRestartFixture({ replaceBeforeGo: true });
  assert.match(result.error.message, /Restart document changed before named theme navigation/);
  assert.equal(result.assignments.length, 1); assert.equal(result.polls.length, 3);
  assert(result.raw.observations.some((row) => row.name.endsWith('-navigation-failure-screenshot') && row.value.status === 'observed'));
});

test('named restart navigation failure stays the first error despite failed page and image diagnostics', async () => {
  const result = await namedRestartFixture({ navigationFailure: true, diagnosticsFail: true });
  assert.equal(result.error, result.waitError); assert.equal(result.assignments.length, 2);
  assert.equal(result.raw.first_error.message, String(result.error));
  const diagnostics = result.raw.observations.filter((row) => row.name.endsWith('-navigation-failure') || row.name.endsWith('-navigation-failure-screenshot'));
  assert.equal(diagnostics.length, 2); assert(diagnostics.every((row) => row.value.status === 'unknown'));
  assert.equal(result.commands.filter((args) => args.includes('force-stop')).length, 1);
});

async function nativeTreeFixture({ cleanupFails = false, cleanupIncomplete = false, dumpFails = false, missing = false, readFails = false, content = '<hierarchy><node package="fresh.picker" text="Fresh tree" /></hierarchy>' } = {}) {
  const childProcess = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const original = childProcess.default.execFileSync, calls = [];
  const file = '/sdcard/silverhand-stage1-ui.xml';
  let artifact = '<hierarchy><node package="old.chooser" text="Old Sharing image" /></hierarchy>', nodes, error;
  childProcess.default.execFileSync = (_file, args) => {
    const command = args.slice(2); calls.push(command);
    assert.equal(command.at(-1), file, 'Only the dedicated UI XML may be touched');
    if (command[1] === 'rm') {
      assert.deepEqual(command, ['shell', 'rm', '-f', file]);
      if (cleanupFails) throw Error('controlled rm failure');
      if (!cleanupIncomplete) artifact = null;
      return '';
    }
    if (command[1] === 'test') {
      assert.deepEqual(command, ['shell', 'test', '!', '-e', file]);
      if (artifact !== null) throw Error('controlled old artifact remains');
      return '';
    }
    if (command[1] === 'uiautomator') {
      assert.deepEqual(command, ['shell', 'uiautomator', 'dump', file]);
      if (dumpFails) throw Error('controlled dump failure');
      if (!missing) artifact = content;
      return missing ? 'controlled dump produced no file despite returning zero' : 'controlled successful dump';
    }
    if (command[1] === 'cat') {
      if (readFails) throw Error('controlled cat failure');
      if (artifact === null) throw Error('controlled file missing');
      return artifact;
    }
    assert.fail(JSON.stringify(command));
  };
  syncBuiltinESMExports();
  try { nodes = nativeUI('emulator-controlled').nodes(); }
  catch (caught) { error = caught; }
  finally { childProcess.default.execFileSync = original; syncBuiltinESMExports(); }
  return { nodes, error, calls };
}

test('native UI fresh tree removes the old dedicated artifact and reads only the new dump', async () => {
  const result = await nativeTreeFixture();
  assert.equal(result.error, undefined);
  assert.deepEqual(result.nodes, [{ package: 'fresh.picker', text: 'Fresh tree' }]);
  assert.deepEqual(result.calls.map((command) => command[1]), ['rm', 'test', 'uiautomator', 'cat']);
});

test('native UI fresh tree refuses an old artifact when a zero-return dump produces no new file', async () => {
  const result = await nativeTreeFixture({ missing: true });
  assert.equal(result.nodes, undefined); assert.match(result.error.message, /Native UI tree read failed: controlled file missing/);
  assert.equal(result.error.cause.message, 'controlled file missing');
  assert.deepEqual(result.calls.map((command) => command[1]), ['rm', 'test', 'uiautomator', 'cat']);
});

test('native UI fresh tree cleanup failure or surviving old artifact stops before dump or read', async () => {
  for (const options of [{ cleanupFails: true }, { cleanupIncomplete: true }]) {
    const result = await nativeTreeFixture(options);
    assert.equal(result.nodes, undefined); assert.match(result.error.message, /Native UI tree cleanup failed/);
    assert(!result.calls.some((command) => ['uiautomator', 'cat'].includes(command[1])));
  }
});

test('native UI fresh tree propagates dump and read failures and rejects empty or node-free products', async () => {
  const dump = await nativeTreeFixture({ dumpFails: true });
  assert.match(dump.error.message, /Native UI tree dump failed/); assert(!dump.calls.some((command) => command[1] === 'cat'));
  const read = await nativeTreeFixture({ readFails: true });
  assert.match(read.error.message, /Native UI tree read failed: controlled cat failure/);
  for (const content of ['', '<hierarchy></hierarchy>']) {
    const result = await nativeTreeFixture({ content });
    assert.equal(result.nodes, undefined); assert.match(result.error.message, /Native UI tree read failed: Native UI dump (returned empty XML|contains no nodes)/);
    assert.equal(result.calls.filter((command) => command[1] === 'uiautomator').length, 1);
  }
});

test('file picker lookup records initial first miss and final existing tree without extra reads or taps', async () => {
  const first = strictFileNodes(), misses = Array.from({ length: 12 }, (_, i) => [{ text: 'unrelated read ' + (i + 1), bounds: '[0,0][400,800]' }]);
  const result = await strictNativeChooserFixture([first, ...misses]);
  assert.match(result.error.message, /^Native UI control not found$/); assert.equal(result.reads, 13); assert.equal(result.taps.length, 0);
  const trees = result.observations.filter((o) => o.value.nodes);
  assert.deepEqual(trees.map((o) => o.phase), ['initial', 'lookup-first-miss', 'lookup-last']);
  assert.deepEqual(trees[0].value.nodes, first); assert.deepEqual(trees[1].value.nodes, misses[0]); assert.deepEqual(trees[2].value.nodes, misses[11]);
  assert.equal(trees[2].value.readIndex, 12); assert.equal(trees[2].value.target, null); assert.equal(trees[2].value.decision, 'not_found');
  assert.equal(result.observations.at(-1).phase, 'failure'); assert.equal(result.observations.at(-1).value.error.message, result.error.message);
});

test('file picker lookup successful target retains that fresh tree and dispatches only once', async () => {
  const first = strictFileNodes(), miss = [{ text: 'not the target', bounds: '[0,0][400,800]' }], fresh = structuredClone(first); fresh[1].bounds = '[30,110][190,310]';
  const result = await strictNativeChooserFixture([first, miss, fresh]);
  assert.equal(result.error, undefined); assert.equal(result.reads, 3); assert.deepEqual(result.taps, [['shell', 'input', 'tap', '110', '210']]);
  const trees = result.observations.filter((o) => o.value.nodes);
  assert.equal(trees.length, 3); assert.equal(trees[2].phase, 'target'); assert.deepEqual(trees[2].value.nodes, fresh); assert.equal(trees[2].value.decision, 'matched');
});

test('file picker lookup refusal retains the same-read tree and original target rejection', async () => {
  const first = strictFileNodes(), miss = [{ text: '', bounds: '[0,0][400,800]' }], ambiguous = structuredClone(first); ambiguous.push({ ...ambiguous[1] });
  const result = await strictNativeChooserFixture([first, miss, ambiguous]);
  assert.match(result.error.message, /Ambiguous native file target/); assert.equal(result.reads, 3); assert.equal(result.taps.length, 0);
  const trees = result.observations.filter((o) => o.value.nodes); assert.equal(trees.length, 3);
  assert.equal(trees[2].phase, 'target-rejected'); assert.deepEqual(trees[2].value.nodes, ambiguous); assert.equal(trees[2].value.error.message, result.error.message);
});

test('file picker lookup failed acquisition is unknown and does not label an earlier tree as current', async () => {
  const result = await strictNativeChooserFixture([strictFileNodes()], { readFailureAt: 2 });
  assert.equal(result.error.cause, result.readError); assert.equal(result.reads, 2); assert.equal(result.taps.length, 0);
  const unknown = result.observations.find((o) => o.phase === 'read-error');
  assert.equal(unknown.value.status, 'unknown'); assert.equal(unknown.value.nodes, undefined); assert.equal(unknown.value.stage, 'lookup');
  assert.equal(result.observations.filter((o) => o.value.nodes).length, 1);
  assert.equal(result.observations.at(-1).value.error.message, result.error.message);
});

test('file picker lookup callback failures cannot replace an exhausted lookup error', async () => {
  const result = await strictNativeChooserFixture([strictFileNodes(), [{ text: 'no target', bounds: '[0,0][400,800]' }]], { observerFails: true });
  assert.match(result.error.message, /^Native UI control not found$/); assert.equal(result.reads, 13); assert.equal(result.taps.length, 0);
  assert.equal(result.observations.filter((o) => o.value.nodes).length, 3);
});

test('file picker lookup sendFile connects the existing callback using its filename scene', async () => {
  const { runB2 } = await import('./acceptance-b2.mjs');
  const childProcess = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const original = childProcess.default.execFileSync, directory = mkdtempSync(join(tmpdir(), 'send-file-lookup-'));
  const record = new AcceptanceRecord(directory, ['B2.files.choose-upload-bytes', 'B2.files.choose-cancel']);
  const mainError = Error('controlled after-file-selection wait'); const taps = [];
  childProcess.default.execFileSync = (_file, args) => {
    const cmd = args.slice(2);
    if (cmd[0] === 'exec-out') return Buffer.from('controlled screenshot');
    if (['rm', 'test', 'uiautomator'].includes(cmd[1])) return '';
    if (cmd[1] === 'cat') return '<hierarchy>' + strictFileNodes('b2-文件.bin').map((node) => '<node ' + Object.entries(node).map(([key, value]) => `${key}="${value}"`).join(' ') + ' />').join('') + '</hierarchy>';
    if (cmd[1] === 'input') { taps.push(cmd); return ''; }
    assert.fail(JSON.stringify(cmd));
  };
  syncBuiltinESMExports(); let error;
  try {
    try {
      await runB2({ c: { evaluate: async () => ({}), send: async () => ({}) }, serial: 'emulator-controlled', root: directory + '/', out: directory,
        fixture: { channel: 'controlled' }, channelUrl: '/chat/controlled', path: '/messages', token: 'controlled',
        adb: () => '', wait: async (expression) => { if (!expression.startsWith('location.hash===')) throw mainError; },
        api: async (path) => path === '/messages' ? { messages: [] } : { attachments: [] },
        step: (name, action) => name === 'B2.files.choose-upload-bytes' ? record.step(name, action) : undefined,
        observe: (...args) => record.observe(...args),
      });
    } catch (caught) { error = caught; record.fail(caught); }
    assert.equal(error, mainError); assert.equal(taps.length, 1);
    const raw = JSON.parse(readFileSync(join(directory, 'raw.json')));
    const picker = raw.observations.filter((o) => o.name.startsWith('file-picker-b2-文件.bin-'));
    assert.deepEqual(picker.map((o) => o.name.slice('file-picker-b2-文件.bin-'.length)), ['initial', 'target', 'dispatch-returned']);
    assert(picker.slice(0, 2).every((o) => o.value.nodes.length === 3));
    assert.equal(raw.first_error.message, String(mainError)); assert.equal(raw.steps[1].status, 'not_executed');
  } finally { childProcess.default.execFileSync = original; syncBuiltinESMExports(); rmSync(directory, { recursive: true, force: true }); }
});

// Execute the actual module initialization and parent tail with controlled IO.
async function b1InitialFixture({ parent = false, rejectReconnect = false } = {}) {
  const { EventEmitter } = await import('node:events');
  const directory = mkdtempSync(join(tmpdir(), 'b1-reconnect-'));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(directory, 'acceptance'));
  const error = Error('controlled B1 reconnect failure');
  const trace = [], observed = [];
  let closed = 0, direct = 0, inherited = 0, request;
  const child = new EventEmitter(); child.exitCode = null;
  let stdout;
  child.stdout = { on: (_event, callback) => { stdout = callback; trace.push('ready'); callback(Buffer.from('B1_DEVICE_CONTROL_READY\n')); } };
  child.stderr = { on: () => {} };
  const client = { close: () => { closed++; }, evaluate: async (expression) => { trace.push(expression); return true; } };
  const runB1Source = readFileSync(new URL('./acceptance-b1.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export async function runB1', 'async function runB1');
  const runB1 = runInNewContext(runB1Source + '\nrunB1', {
    assert, Buffer, connect: async () => { direct++; trace.push('direct-connect'); return client; },
    process: { env: { ANDROID_HOME: '/controlled-sdk' }, stdout: { write: () => {} } },
    readFileSync: () => Buffer.from('controlled CA'), writeFile: writeFileSync,
    randomUUID: () => 'controlled-id',
    spawn: () => child,
    execFileSync: (_bin, args, options) => {
      if (options?.input) {
        request = JSON.parse(options.input);
        if (request.operation === 'stop' && child.exitCode === null) {
          stdout(Buffer.from('B1_DEVICE_CONTROL_COMPLETED\nINSTRUMENTATION_CODE: -1\n'));
          child.exitCode = 0; child.emit('close', 0, null);
        }
      }
      if (args.includes('files/b1-response.json')) return JSON.stringify({ id: request.id, ok: true, result: { activity: 1 } });
      return '1';
    },
    https: { request: (_url, _options, callback) => ({
      on: () => {}, write: () => {}, end: () => callback({ statusCode: 200, on: (event, handler) => {
        if (event === 'data') handler(JSON.stringify({ user_token: 'controlled-token', id: 'controlled-id' }));
        if (event === 'end') handler();
      } }),
    }) },
    setTimeout: (fn, ms) => setTimeout(fn, ms === 20000 ? ms : 0), clearTimeout,
  });
  let thrown;
  try {
    await runB1({ run: directory, out: join(directory, 'out'),
      ...(parent ? { reconnect: async () => { inherited++; trace.push('parent-reconnect'); if (rejectReconnect) throw error; return client; } } : {}),
      step: async () => { throw Error('No test body selected'); },
      observe: (name, value) => observed.push({ name, value }),
    }, []);
  } catch (value) { thrown = value; }
  finally { rmSync(directory, { recursive: true, force: true }); }
  return { thrown, error, trace, observed, closed, direct, inherited };
}

test('B1 initial connection uses parent reconnect after ready and releases its current client once', async () => {
  const result = await b1InitialFixture({ parent: true });
  assert.equal(result.thrown, undefined);
  assert.equal(result.direct, 0); assert.equal(result.inherited, 1); assert.equal(result.closed, 1);
  assert(result.trace.indexOf('ready') < result.trace.indexOf('parent-reconnect'));
  assert(result.trace.some((x) => x.includes('nativePromise') && x.includes('clearProfile')));
  assert.equal(result.observed.find((o) => o.name === 'instrumentation').value.protocolSuccess, true);
});

test('B1 initial reconnect failure preserves the same error without logging in or closing an empty reference', async () => {
  const result = await b1InitialFixture({ parent: true, rejectReconnect: true });
  assert.equal(result.thrown, result.error);
  assert.equal(result.direct, 0); assert.equal(result.inherited, 1); assert.equal(result.closed, 0);
  assert.equal(result.trace.some((x) => x.includes('nativePromise')), false);
  assert.equal(result.observed.find((o) => o.name === 'instrumentation').value.protocolSuccess, true);
});

test('B1 standalone initial connection retains direct connect and its original cleanup', async () => {
  const result = await b1InitialFixture();
  assert.equal(result.thrown, undefined);
  assert.equal(result.direct, 1); assert.equal(result.inherited, 0); assert.equal(result.closed, 1);
});

async function b1ParentTailFixture(mode) {
  const events = []; let oldClosed = 0, newClosed = 0, clock = 0, childCalled = false;
  const originalError = Error('controlled child failure');
  const next = { close: () => { newClosed++; } };
  let c = { close: () => { oldClosed++; }, evaluate: async () => {} }, thrown;
  const now = mock.method(Date, 'now', () => { clock += 8000; return clock; });
  try {
    await continueAfterRestart({
      suite: 'b2', diagnostic: undefined,
      runB2: async () => { if (mode === 'b2-failure') throw originalError; },
      logout: async () => 'controlled logout', record: () => {}, report: {},
      b1Context: { reconnect: async () => {
        c = await reconnectWebView(c, (...args) => { events.push(args); return args.includes('pidof') ? '4242' : ''; },
          async () => { if (mode === 'connect-failure') throw Error('controlled socket'); return next; });
        return c;
      } },
      selectedB1: [4, 5, 6, 9, 10, 11, 12],
      releaseParent: () => { c = null; },
      runB1: async (context) => {
        childCalled = true;
        if (mode === 'before-transfer-failure') throw originalError;
        const client = await context.reconnect();
        assert.equal(client, next);
        try { if (mode === 'after-transfer-failure') throw originalError; }
        finally { client.close(); }
      },
    });
  } catch (error) { thrown = error; }
  finally { now.mock.restore(); c?.close(); }
  return { events, oldClosed, newClosed, childCalled, thrown, originalError };
}

test('B2 to B1 transfers the actual reconnect result and avoids both parent double-close paths', async () => {
  const result = await b1ParentTailFixture('success');
  assert.equal(result.thrown, undefined); assert.equal(result.childCalled, true);
  assert.equal(result.oldClosed, 1); assert.equal(result.newClosed, 1);
  assert.deepEqual(result.events, [['shell', 'pidof', 'com.silverhand.android.stage1'], ['forward', 'tcp:19322', 'localabstract:webview_devtools_remote_4242']]);
});

test('B2 failure before B1 dispatch keeps its primary error and prior ownership', async () => {
  const result = await b1ParentTailFixture('b2-failure');
  assert.equal(result.thrown, result.originalError);
  assert.equal(result.childCalled, false);
  assert.equal(result.oldClosed, 1); assert.equal(result.newClosed, 0);
});

test('B2 to B1 failures before transfer or during reconnect release only the owned prior client', async () => {
  for (const mode of ['before-transfer-failure', 'connect-failure']) {
    const result = await b1ParentTailFixture(mode);
    assert.equal(result.oldClosed, 1); assert.equal(result.newClosed, 0);
    if (mode === 'connect-failure') assert.match(String(result.thrown), /WebView reconnect timeout/);
    else assert.equal(result.thrown, result.originalError);
  }
});

test('B2 to B1 child failure after transfer retains its primary error with one child close', async () => {
  const result = await b1ParentTailFixture('after-transfer-failure');
  assert.equal(result.thrown, result.originalError); assert.equal(result.oldClosed, 1); assert.equal(result.newClosed, 1);
});

test('Android prepare-web emits explicit DARK bars with unchanged origin and public bytes', async () => {
  const { mkdirSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const directory = mkdtempSync(join(tmpdir(), 'bars-config-'));
  try {
    mkdirSync(join(directory, 'web'));
    writeFileSync(join(directory, 'web', 'index.html'), '<html>controlled public bytes</html>');
    execFileSync(process.execPath, [new URL('./prepare-web.mjs', import.meta.url).pathname], { env: { ...process.env, SILVERHAND_ANDROID_RUN_ROOT: directory } });
    const assets = join(directory, 'app-build', 'web-assets');
    assert.deepEqual(JSON.parse(readFileSync(join(assets, 'capacitor.config.json'))), {
      appId: 'com.silverhand.android.stage1', appName: 'Silverhand', webDir: 'dist', loggingBehavior: 'none',
      plugins: { SystemBars: { style: 'DARK' } }, server: { hostname: 'localhost', androidScheme: 'https' },
    });
    assert.equal(readFileSync(join(assets, 'public', 'index.html'), 'utf8'), '<html>controlled public bytes</html>');
    assert.deepEqual(JSON.parse(readFileSync(join(assets, 'capacitor.plugins.json'))), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// A real WM override is restored even when the scene/diagnostics fail.
test('short selection window restores the prior override and verifies after restoring size', async () => {
  const calls = [], seen = [];
  const result = await shortSelectionWindow((...args) => { calls.push(args); return 'Physical size: 1080x2400\nOverride size: 1080x2000'; },
    (name) => seen.push(name), async () => { calls.push(['scene']); return 'scene-result'; },
    async () => { calls.push(['page-exit']); }, async () => { calls.push(['verify']); });
  assert.equal(result, 'scene-result');
  assert.deepEqual(calls, [['shell','wm','size'], ['shell','wm','size','1080x900'], ['scene'], ['page-exit'], ['shell','wm','size','1080x2000'], ['verify']]);
  assert(seen.includes('short-selection-window-restored'));
});

test('short selection preserves the scene error across page, WM and diagnostic failures and still verifies', async () => {
  const primary = Error('controlled short scene'); let verified = false; const calls = [];
  await assert.rejects(shortSelectionWindow((...args) => {
    calls.push(args); if (args.at(-1) === 'reset') throw Error('controlled WM restore'); return 'Physical size: 1080x2400';
  }, () => { throw Error('controlled diagnostic'); }, async () => { throw primary; },
  async () => { throw Error('controlled page restore'); }, async () => { verified = true; throw Error('controlled verification'); }), (error) => error === primary);
  assert.equal(verified, true); assert.equal(calls.filter((x) => x.at(-1) === 'reset').length, 1);
});

test('short selection refuses unknown WM state before mutation and fails a restore error after scene success', async () => {
  const calls = [];
  await assert.rejects(shortSelectionWindow((...args) => { calls.push(args); return 'unknown'; }, () => {}, async () => {}, async () => {}, async () => {}), /Unknown WM size/);
  assert.equal(calls.length, 1);
  let verified = false;
  await assert.rejects(shortSelectionWindow((...args) => {
    if (args.at(-1) === 'reset') throw Error('failed reset'); return 'Physical size: 1080x2400';
  }, () => {}, async () => {}, async () => {}, async () => { verified = true; }), /failed reset/);
  assert.equal(verified, true);
});

function shortLayoutFixture(height = 300, hidden = false) {
  const rectangle = (left, top, right, bottom) => ({ left, top, right, bottom, width: right-left, height: bottom-top });
  const styles = new Map();
  const panel = { getBoundingClientRect: () => rectangle(0,0,400,height), parentElement: null };
  const scroller = { getBoundingClientRect: () => rectangle(0,100,400,250), parentElement: panel, scrollTop: 10, scrollHeight: 700, clientHeight: 150 };
  const row = { getBoundingClientRect: () => rectangle(20,120,200,200), parentElement: scroller, isConnected: true, querySelector: () => ({ getAttribute: () => 'true' }) };
  const spacer = {};
  panel.querySelector = (s) => s === '[data-virtuoso-scroller]' ? scroller : spacer;
  panel.querySelectorAll = () => [{}];
  scroller.contains = (e) => e === row;
  scroller.querySelectorAll = () => [row];
  styles.set(panel, { overflowX:'hidden', overflowY:'hidden', display:'block', visibility:hidden?'hidden':'visible', opacity:'1', getPropertyValue:()=>'60px' });
  styles.set(scroller, { overflowX:'hidden', overflowY:'auto', display:'block', visibility:'visible', opacity:'1' });
  styles.set(spacer, { height:'0px' });
  styles.set(row, { display:'block', visibility:'visible', opacity:'1' });
  return { defaultView: { innerWidth:400, innerHeight:height, location:{ origin:'https://localhost', hash:'#channel' }, performance:{ timeOrigin:1 }, matchMedia:()=>({ matches:height<=320 }), getComputedStyle:(e)=>styles.get(e) },
    querySelector:()=>panel, querySelectorAll:()=>[], getElementById:()=>row, elementFromPoint:()=>row };
}

test('short selection layout reports actual media, clipping, visible messages and scroll range', () => {
  const state = shortSelectionLayout(shortLayoutFixture(), 'fixture');
  assert.equal(state.viewport.media, true); assert.equal(state.viewport.height, 300);
  assert.equal(state.message.intersection.area, 14400); assert.equal(state.scroller.hit, true);
  assert.equal(state.scroller.visibleMessages, 1); assert.equal(state.scroller.max, 550);
  assert.equal(state.expectedSpacerHeight, 72);
  assert.equal(shortSelectionLayout(shortLayoutFixture(839), 'fixture').viewport.media, false);
  assert.equal(shortSelectionLayout(shortLayoutFixture(300, true), 'fixture').message.intersection.area, 0);
});

function scrollPointFixture(options={}) {
  const document=shortLayoutFixture(),view=document.defaultView,panel=document.querySelector(),scroller=panel.querySelector('[data-virtuoso-scroller]'),row=document.getElementById(),spacer=panel.querySelector('[data-pane-chrome-spacer]');
  const rect=(left,top,right,bottom)=>({left,top,right,bottom,width:right-left,height:bottom-top});
  const oldStyle=view.getComputedStyle;let panelReads=0,scrollerReads=0,buttonReads=0,rowReads=0,hits=0;
  for(const e of [panel,scroller,row])Object.assign(e,{isConnected:true,hasAttribute:()=>false,getAttribute:()=>null,closest:()=>null});
  Object.assign(panel,{tagName:'MAIN',id:'chat',getAttribute:n=>n==='data-panel'?'chat':null,contains:e=>[scroller,row,button].includes(e)});
  Object.assign(scroller,{tagName:'DIV',id:'scroll',closest:s=>s==='[data-panel]'?panel:null});
  Object.assign(row,{tagName:'ARTICLE',id:'msg-fixture',getBoundingClientRect:()=>rect(20,120,380,210),closest:s=>s==='[data-panel]'?panel:s==='[data-virtuoso-scroller]'?scroller:null});
  if(options.unselected)row.querySelector=()=>({getAttribute:()=> 'false'});
  const b=options.buttonBox??{left:180,top:150,right:216,bottom:186};
  const button={tagName:'BUTTON',id:'bottom',isConnected:true,parentElement:panel,getAttribute:n=>n==='aria-label'||n==='title'?'Scroll to bottom':null,hasAttribute:n=>n==='data-scroll-bottom',closest:s=>s==='[data-panel]'?panel:null,getBoundingClientRect:()=>rect(b.left,b.top,b.right,b.bottom)};
  view.getComputedStyle=e=>e===button?{display:'block',visibility:'visible',opacity:'1',position:options.buttonPosition??'absolute',pointerEvents:'auto'}:{...oldStyle(e),pointerEvents:'auto'};
  panel.querySelectorAll=s=>{
    if(s==='[data-virtuoso-scroller]'){scrollerReads++;return options.scrollerMissing?[]:options.scrollerDuplicate?[scroller,{...scroller}]:[options.replaceScroller&&scrollerReads>1?{...scroller}:scroller];}
    if(s==='button[data-scroll-bottom]'){buttonReads++;if(options.documentDrift&&buttonReads>1)view.performance.timeOrigin=2;if(options.none)return[];return options.multiple?[button,{...button}]:[options.replaceButton&&buttonReads>1?{...button}:button,...(options.foreign?[{...button,closest:()=>({})}]:[])];}
    return[{}];
  };
  document.querySelectorAll=s=>{if(s.includes('data-panel')){panelReads++;return options.paneMissing?[]:options.paneDuplicate?[panel,{...panel}]:[options.replacePane&&panelReads>1?{...panel}:panel];}return[];};
  document.getElementById=()=>{rowReads++;return options.replaceRow&&rowReads>1?{...row}:row;};
  document.elementFromPoint=(x,y)=>{hits++;return options.otherOverlay?{...button,id:'other',closest:()=>null}:!options.none&&x>=b.left&&x<b.right&&y>=b.top&&y<b.bottom?button:row;};
  if(options.visual)view.visualViewport=options.visual;
  if(options.documentChanged)view.performance.timeOrigin=2;
  if(options.foreignRow)row.closest=s=>s==='[data-panel]'?panel:s==='[data-virtuoso-scroller]'?{}:null;
  return{document,view,panel,scroller,row,button,guard:{expectedIdentity:{origin:'https://localhost',hash:'#channel',timeOrigin:1}},hits:()=>hits};
}

test('short scroll before projection serializes unique ownership and deterministic finite avoidance with one hit',()=>{
  const f=scrollPointFixture({foreign:true});const r=JSON.parse(JSON.stringify(runInNewContext(`(${shortSelectionLayout.toString()})(document,'fixture',guard)`,{document:f.document,guard:f.guard})));
  assert.equal(r.scrollTarget.ready,true);assert.equal(r.scrollTarget.paneCount,1);assert.equal(r.scrollTarget.scrollerCount,1);assert.equal(r.scrollTarget.avoidance.count,1);assert.equal(r.scrollTarget.avoidance.selected.side,'right');assert.deepEqual(r.scroller.point,{x:308,y:175});assert.equal(r.scrollTarget.hit.id,'msg-fixture');assert.equal(r.scrollTarget.hit.nearestPanel,'chat');assert.equal(r.scrollTarget.hitChecks,1);assert.equal(f.hits(),1);assert.equal(r.scroller.max,550);assert.equal(r.scroller.hit,true);
  assert.deepEqual(r.scrollTarget.avoidance.candidates.map(e=>[e.side,e.area]),[['right',27600],['left',27000],['down',25600],['up',20000]]);assert(r.scrollTarget.hitAncestors.length<=6);
});

test('short scroll keeps center without a matching button or overlap and only exact ties use fixed order',()=>{
  for(const options of [{none:true},{buttonBox:{left:500,top:150,right:536,bottom:186}}]){const f=scrollPointFixture(options),r=shortSelectionLayout(f.document,'fixture',f.guard);assert.equal(r.scrollTarget.ready,true);assert.deepEqual(r.scroller.point,{x:200,y:175});assert.equal(r.scrollTarget.avoidance.selected,null);assert.equal(f.hits(),1);}
  for(const [left,right,side]of [[182,218,'right'],[182.0001,218.0001,'left']]){const f=scrollPointFixture({buttonBox:{left,top:150,right,bottom:186}}),r=shortSelectionLayout(f.document,'fixture',f.guard);assert.equal(r.scrollTarget.avoidance.selected.side,side);assert.equal(f.hits(),1);}
  const f=scrollPointFixture({visual:{offsetLeft:60,offsetTop:140,width:280,height:100}}),r=shortSelectionLayout(f.document,'fixture',f.guard);assert.deepEqual(r.scrollTarget.intersection,{left:60,top:140,right:340,bottom:240,area:28000});assert.equal(r.scrollTarget.ready,true);assert.equal(f.hits(),1);
});

test('short scroll rejects identity relationship geometry and candidate ambiguity with explicit zero-hit reasons',()=>{
  for(const [options,reason]of [
    [{documentChanged:true},/document identity changed/],[{paneMissing:true},/pane missing or ambiguous/],[{paneDuplicate:true},/pane missing or ambiguous/],
    [{scrollerMissing:true},/scroller missing or ambiguous/],[{scrollerDuplicate:true},/scroller missing or ambiguous/],
    [{unselected:true},/message relationship changed/],[{foreignRow:true},/message relationship changed/],
    [{replacePane:true},/node identity changed/],[{replaceScroller:true},/node identity changed/],[{replaceRow:true},/node identity changed/],[{replaceButton:true},/node identity changed/],
    [{documentDrift:true},/node identity changed/],
    [{multiple:true},/bottom button ambiguous/],[{buttonPosition:'fixed'},/geometry unavailable/],
    [{buttonBox:{left:NaN,top:150,right:216,bottom:186}},/geometry unavailable/],
    [{buttonBox:{left:0,top:0,right:400,bottom:300}},/no remaining rectangle/],
    [{visual:{offsetLeft:0,offsetTop:260,width:400,height:40}},/visible intersection unavailable/],
  ]){const f=scrollPointFixture(options),r=shortSelectionLayout(f.document,'fixture',f.guard);assert.equal(r.scrollTarget.ready,false,JSON.stringify(options));assert.match(r.scrollTarget.reason,reason);assert.equal(r.scrollTarget.hitChecks,0);assert.equal(f.hits(),0);}
  const f=scrollPointFixture({otherOverlay:true}),r=shortSelectionLayout(f.document,'fixture',f.guard);assert.equal(r.scrollTarget.ready,false);assert.match(r.scrollTarget.reason,/does not hit current scroller/);assert.equal(r.scrollTarget.hit.id,'other');assert.equal(r.scrollTarget.hit.scrollBottom,true);assert.equal(r.scrollTarget.hitChecks,1);assert.equal(f.hits(),1);assert.equal(r.scroller.hit,false);
});

test('short scroll leaves baseline after-scroll and restoration projections on their original path',()=>{
  const f=scrollPointFixture({documentChanged:true,paneDuplicate:true,multiple:true});const r=shortSelectionLayout(f.document,'fixture');assert.equal(r.scrollTarget,undefined);assert.equal(f.hits(),1);assert.deepEqual(r.scroller.point,{x:200,y:175});
});

async function shortPreviewFixture(failure, short = true, options = {}) {
  const source = readFileSync(new URL('./acceptance-b2.mjs', import.meta.url), 'utf8');
  const actual = source.slice(source.indexOf('  async function preview('), source.indexOf('  async function shortPreview('));
  const events = [], observations = [], inputs=[];
  let layoutReads = 0, finalStateReads = 0, fallbackReleaseReads = 0;
  const baseline = { origin:'https://localhost', hash:'#channel', timeOrigin:1, viewport:{ media:true, height:300 }, selected:true, message:{ connected:true, intersection:{ area:50 } }, scroller:{ hit:true, max:100, top:20, point:{x:10,y:120}, visibleMessages:1 },scrollTarget:{ready:true} };
  const preview = runInNewContext(actual + '\npreview', {
    assert, messageMenuTarget, shortSelectionLayout, previewDialogState, shortMenuCapture, leftControlTarget,
    shortContextMenu: options.shortContextMenu ?? (async(c,_observe,_name,point)=>{await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'right',...point});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'right',...point});}),
    shortMenuTarget: options.shortMenuTarget ?? (async()=>({ready:true,point:{x:10,y:10},captureInstall:{identity:{origin:'https://localhost',hash:'#channel',timeOrigin:1}}})),
    Date:{ now:()=>1 }, go:async()=>{}, path:'/controlled', fixture:{channel:'fixture'}, token:'controlled', channelUrl:'channel',
    api:async()=>{if(options.postFailure)throw options.postFailure;return {message:{id:options.invalidId?null:options.menuDocument?'committed':'fixture'}};}, wait:async()=>{if(options.domFailure)throw options.domFailure;}, delay:async()=>{},
    observe:(name,value)=>{observations.push({name,value});if(options.throwMenuObservation&&name.endsWith('-menu-target'))throw Error('controlled target recorder');}, screenshot:()=>{},
    click:async(_selector,text)=>events.push(text), console,
    c:{ send:async(_method,args)=>{events.push(args.type);inputs.push(args);if(args.type==='mouseWheel')options.wheelMutate?.();}, evaluate:async(expression)=>{
      if (expression.includes('function messageMenuTarget')&&!expression.includes('const capture=')) return options.menuDocument ? JSON.parse(JSON.stringify(runInNewContext(expression,{document:options.menuDocument}))) : {target:{ready:true,point:{x:10,y:10}},error:null};
      if (expression.includes('function shortSelectionLayout')) {
        layoutReads++;
        if(options.layoutDocument)return JSON.parse(JSON.stringify(runInNewContext(expression,{document:options.layoutDocument})));
        const state=structuredClone(baseline); if(layoutReads>1) state.scroller.top=failure==='scroll'?20:0;
        if(failure==='viewport') state.viewport={media:false,height:839};
        if(failure==='message') state.message.intersection.area=0;
        if(failure==='document'&&layoutReads>1) state.timeOrigin=2;
        return state;
      }
      if(expression.startsWith("['Cancel'")) return options.controlsDocument ? JSON.parse(JSON.stringify(runInNewContext(expression,{document:options.controlsDocument}))) : [1,2,3].map(()=>({ready:failure!=='control',fatal:false}));
      if(expression.includes('const shown=')) {finalStateReads++;if(options.stateFailure)throw options.stateFailure;if(options.stateDocument)return JSON.parse(JSON.stringify(runInNewContext(expression,{document:options.stateDocument,location:options.stateDocument.defaultView.location,Date})));return {route:'#channel',toolbarCount:1,targetSelected:true,dialogShareReady:true,previewReady:true,previewIdentity:{origin:'https://localhost',href:'https://localhost/#channel',hash:'#channel',timeOrigin:1},capture:{release:options.releaseUnknown?'unknown':'released'}};}
      if(expression.includes('function shortMenuCapture')){if(options.captureDocument)return JSON.parse(JSON.stringify(runInNewContext(expression,{document:options.captureDocument,Date})));fallbackReleaseReads++;if(options.fallbackFailure)throw options.fallbackFailure;return {status:'observed',release:'released',events:[]};}
      if(expression.includes('button[title]')) return ['Share'];
      return true;
    } },
  });
  let error;
  try { await preview(short, 10000, options.onCommitted, options.onPreviewReady); } catch(value) { error=value; }
  return { events, observations, inputs, error, layoutReads, finalStateReads, fallbackReleaseReads };
}

test('short selection preview requires actual short media, visible message, scrolling and reachable actions before Save', async () => {
  const good=await shortPreviewFixture();
  assert.equal(good.error, undefined); assert.equal(good.events.filter(x=>x==='mouseWheel').length,1);
  assert.equal(good.events.filter(x=>x==='Save image').length,1);
  for (const failure of ['viewport','message','scroll','control','document']) {
    const result=await shortPreviewFixture(failure);
    assert(result.error, failure+' must fail');
    assert.equal(result.events.includes('Save image'),false,failure+' must not reach Save');
    if(failure==='scroll') assert.equal(result.layoutReads,5); // initial + four bounded wheel observations.
  }
});

test('short scroll original preview dispatches one checked wheel and credits only changed readback before Save',async()=>{
  const f=scrollPointFixture();const r=await shortPreviewFixture(undefined,true,{layoutDocument:f.document,wheelMutate:()=>{f.scroller.scrollTop=0;}});
  assert.equal(r.error,undefined);assert.equal(r.layoutReads,2);assert.equal(r.inputs.filter(e=>e.type==='mouseWheel').length,1);const wheel=r.inputs.find(e=>e.type==='mouseWheel');assert.equal(wheel.x,308);assert.equal(wheel.y,175);assert.equal(wheel.deltaY,-120);assert.equal(r.events.filter(e=>e==='Save image').length,1);
  const before=r.observations.find(o=>o.name==='short-selection-before-scroll').value,after=r.observations.find(o=>o.name==='short-selection-after-scroll').value;
  assert.equal(before.scrollTarget.hitChecks,1);assert.equal(before.scrollTarget.ready,true);assert.equal(before.scroller.top,10);assert.equal(after.scroller.top,0);assert.equal(after.scrollTarget,undefined);
  const frozen=scrollPointFixture();const bad=await shortPreviewFixture(undefined,true,{layoutDocument:frozen.document});assert.match(String(bad.error),/wheel did not preserve/);assert.equal(bad.inputs.filter(e=>e.type==='mouseWheel').length,1);assert.equal(bad.layoutReads,5);assert.equal(bad.events.includes('Save image'),false);
});

test('short scroll before refusal records cause before assertion sends zero wheel and original finally restores',async()=>{
  for(const options of [{documentChanged:true},{multiple:true},{otherOverlay:true}]){
    const f=scrollPointFixture(options),r=await shortPreviewFixture(undefined,true,{layoutDocument:f.document});assert(r.error);const before=r.observations.find(o=>o.name==='short-selection-before-scroll').value;
    assert.equal(before.scrollTarget.ready,false);assert(String(r.error).includes(before.scrollTarget.reason));assert.equal(r.layoutReads,1);assert.equal(r.inputs.filter(e=>e.type==='mouseWheel').length,0);assert.equal(r.events.includes('Save image'),false);
    const restored=await shortSceneFixture(r.error);assert.equal(restored.error,r.error);assert.equal(restored.height,839);assert.equal(restored.toolbar,0);assert.equal(restored.dialogs,0);assert.equal(restored.calls.filter(c=>c.at(-1)==='reset').length,1);
  }
});


test('short selection addition leaves the normal preview free of window geometry and wheel input', async () => {
  const result = await shortPreviewFixture(undefined, false);
  assert.equal(result.error, undefined); assert.equal(result.layoutReads, 0);
  assert.equal(result.events.includes('mouseWheel'), false);
  assert.equal(result.events.filter((x) => x === 'Save image').length, 1);
});

async function shortSceneFixture(failPreview, options = {}) {
  const source = readFileSync(new URL('./acceptance-b2.mjs', import.meta.url), 'utf8');
  const actual = source.slice(source.indexOf('  async function shortPreview('), source.indexOf('  async function receiver('));
  let height = 839, dialogs = 0, toolbar = 0, deleted = 0;
  const calls = [], observed = [], primary = Error('controlled preview failure');
  const shortPreview = runInNewContext(actual + '\nshortPreview', {
    assert, shortSelectionLayout, previewDialogState, shortSelectionWindow, channelUrl:'channel',
    adb: (...args) => {
      calls.push(args);
      if (args.length === 3) return 'Physical size: 1080x2400';
      height = args.at(-1) === 'reset' ? 839 : 300;
      return '';
    },
    observe:(name,value)=>observed.push({name,value}), screenshot:()=>{}, delay:async()=>{},
    preview:async(short,_deadline,onCommitted,onPreviewReady)=>{ assert.equal(short,true);onCommitted('fixture');dialogs=options.noDialog?0:1;toolbar=1;if(!options.beforePreview)onPreviewReady({origin:'https://localhost',href:'https://localhost/#channel',hash:'#channel',timeOrigin:1});if(failPreview)throw failPreview instanceof Error?failPreview:primary;return{messageId:'fixture'}; },
    click:async(_selector,text)=>{ calls.push(['click',text??'Close']); if(text==='Cancel')toolbar=0;else dialogs=0; },
    c:{evaluate:async(expression)=>{
      if(expression.includes('delete window.')){deleted++;return true;}
      return{origin:'https://localhost',hash:'#channel',timeOrigin:1,viewport:{width:412,height,media:height<=320,visualViewport:{height}},dialogs:options.restoredUnknown&&calls.some(x=>x.at(-1)==='reset')&&height===839&&toolbar===0?1:dialogs,previewReady:!options.unknownPreview,previewIdentity:{origin:'https://localhost',href:'https://localhost/#channel',hash:'#channel',timeOrigin:1},toolbarCount:toolbar,selected:toolbar===1,spacerHeight:toolbar?0:72,expectedSpacerHeight:72,messageIdInRead:expression.includes('\"fixture\"')};
    }},
  });
  let error;
  try{await shortPreview();}catch(value){error=value;}
  return{error,primary,height,dialogs,toolbar,deleted,calls,observed};
}

test('short selection scene finally exits actual surfaces, restores WM and verifies the page even after preview failure', async () => {
  for(const failure of [false,true]){
    const result=await shortSceneFixture(failure);
    assert.equal(result.error,failure?result.primary:undefined);
    assert.equal(result.height,839);assert.equal(result.dialogs,0);assert.equal(result.toolbar,0);assert.equal(result.deleted,1);
    assert.deepEqual(result.calls.filter((x)=>x[0]==='click'),[['click','Close'],['click','Cancel']]);
    assert.equal(result.calls.filter((x)=>x.at(-1)==='reset').length,1);
    assert.equal(result.observed.find((o)=>o.name==='short-selection-page-restored').value.viewport.height,839);
  }
});

test('visible menu target uses the body and actual scroll-viewport intersection center', () => {
  const fixture=menuFixture({height:291,bounds:{left:50,top:-200,width:300,height:600},scrollBox:{left:0,top:150,width:400,height:100}});
  const target=messageMenuTarget(fixture.document,'committed');
  assert.equal(target.ready,true);assert.deepEqual(target.point,{x:200,y:200});
  assert.deepEqual(target.intersection,{left:50,top:150,right:350,bottom:250,width:300,height:100});
  assert.equal(target.body.top+target.body.height/2,100); // Whole center was outside the scroll viewport.
  assert.equal(target.scrollViewport.top,150);assert.equal(target.clips.length,1);
});

test('visible menu target intersects visualViewport offsets and every clipping ancestor', () => {
  const fixture=menuFixture({height:291,bounds:{left:20,top:0,width:300,height:400},scrollBox:{left:0,top:100,width:400,height:150},outerBox:{left:40,top:130,width:260,height:110},visual:{offsetLeft:50,offsetTop:150,width:240,height:140,scale:1}});
  const target=messageMenuTarget(fixture.document,'committed');
  assert.deepEqual(target.point,{x:170,y:195});assert.equal(target.clipCount,2);
  assert.deepEqual(target.intersection,{left:50,top:150,right:290,bottom:240,width:240,height:90});
});

test('visible menu target preserves empty, occluded, foreign-row, hidden and node-replacement refusals with finite state', () => {
  const cases=[
    [{bounds:{left:10,top:400,width:100,height:20},height:291},/no visible body intersection/],
    [{occluded:true},/occluded or belongs to another row/],
    [{nearestWrong:true},/occluded or belongs to another row/],
    [{hidden:true},/not visually rendered/],
    [{noScroller:true},/no current message scroll viewport/],
    [{replaceRow:true},/row replaced after scroll/],
    [{replaceBody:true},/node identity changed/],
  ];
  for(const [options,expected] of cases){
    const fixture=menuFixture(options);let rejected;
    assert.throws(()=>messageMenuTarget(fixture.document,'committed'),(error)=>{rejected=error;return expected.test(error.message);});
    const state=JSON.parse(JSON.stringify(rejected.targetState));
    assert.equal(state.ready,false);assert.match(state.reason,expected);assert.equal(state.rowId,'msg-committed');
    assert(state.clips.length<=8&&state.hitAncestors.length<=6);
  }
});

test('visible menu target is recorded before the real preview host assertion and refusal dispatches zero input', async () => {
  for(const [options, expected] of [
    [{occluded:true},/occluded or belongs to another row/],
    [{replaceRow:true},/row replaced after scroll/],
    [{replaceBody:true},/node identity changed/],
    [{nearestWrong:true},/occluded or belongs to another row/],
    [{offscreen:true},/no visible body intersection/],
    [{noScroller:true},/no current message scroll viewport/],
  ]){
    const fixture=menuFixture(options);
    const result=await shortPreviewFixture(undefined,false,{menuDocument:fixture.document});
    assert(result.error);assert.equal(result.events.length,0);
    const observed=result.observations.find((o)=>o.name==='preview-menu-target').value;
    assert.equal(observed.ready,false);assert.equal(observed.rowId,'msg-committed');
    assert.match(observed.reason,expected);assert.match(observed.error.message,expected);assert.match(String(result.error),expected);
    if(options.occluded){assert.equal(observed.hit.id,'foreign');assert(observed.body&&observed.point&&observed.intersection);}
  }
});

test('visible menu target success dispatches one right-click pair from the new read without alternate points', async () => {
  const fixture=menuFixture({height:291,bounds:{left:50,top:-200,width:300,height:600},scrollBox:{left:0,top:150,width:400,height:100}});
  const result=await shortPreviewFixture(undefined,false,{menuDocument:fixture.document});
  assert.equal(result.error,undefined);
  assert.equal(result.events.filter((x)=>x==='mousePressed').length,1);assert.equal(result.events.filter((x)=>x==='mouseReleased').length,1);
  assert.deepEqual(result.observations.find((o)=>o.name==='preview-menu-target').value.point,{x:200,y:200});
  assert.equal(result.events.filter((x)=>x==='Share…').length,1);assert.equal(result.events.filter((x)=>x==='Save image').length,1);
});

test('visible menu target diagnostic failure cannot replace the original rejection', async () => {
  const result=await shortPreviewFixture(undefined,false,{menuDocument:menuFixture({occluded:true}).document,throwMenuObservation:true});
  assert.match(String(result.error),/Preview target point is occluded/);assert.equal(result.events.length,0);
});


async function shortMenuFixture(options = {}) {
  const fixture=menuFixture({height:291,...options.geometry}), document=fixture.document, view=document.defaultView;
  view.location={origin:'https://localhost',href:'https://localhost/#channel',hash:'#channel'};view.performance={timeOrigin:1};
  let clock=100, reads=0, evaluations=0, hover=true, released=0;
  const events=[], observations=[], pauses=[];
  const box={x:0,y:200,left:0,top:200,right:400,bottom:250,width:400,height:50};
  const anchor={tagName:'TEXTAREA',id:'composer',isConnected:true,disabled:options.anchor==='disabled',parentElement:null,
    getBoundingClientRect:()=>options.anchor==='outside'?{...box,y:400,top:400,bottom:450}:box,
    getAttribute:()=>null,hasAttribute:()=>false,closest:()=>null,contains:(n)=>n===anchor};
  const toaster={tagName:'OL',id:'toast-region',isConnected:true,hasAttribute:()=>false,parentElement:null,getBoundingClientRect:()=>box,getAttribute:(name)=>name==='data-expanded'?String(hover):null,matches:()=>hover};
  const toast={tagName:'LI',id:'saved',isConnected:true,hasAttribute:()=>false,parentElement:toaster,getBoundingClientRect:()=>box,getAttribute:()=>null,closest:(selector)=>selector==='[data-sonner-toaster]'?toaster:null};
  const foreign={...toast,id:'foreign',closest:()=>null};
  const originalHit=document.elementFromPoint,originalId=document.getElementById;
  document.querySelectorAll=(selector)=>selector==='form[data-composer] textarea[data-composer-input]'?options.anchor==='missing'?[]:options.anchor==='duplicate'?[anchor,{...anchor}]:[anchor]:selector==='[data-sonner-toaster]'?[toaster]:selector==='[data-sonner-toast]'?[toaster]:[];
  document.elementFromPoint=(x,y)=>y>=200 ? options.anchor==='occluded'?foreign:options.anchor==='notification'?toast:anchor : reads<=(options.blockedReads??0)?toast:options.foreign?foreign:originalHit(x,y);
  if(options.anchor==='route')view.location.hash='#other';
  document.addEventListener=()=>{};document.removeEventListener=()=>{};
  const context={document,window:view,location:view.location,performance:view.performance,Date:{now:()=>clock}};
  const c={
    evaluate:async(expression)=>{
      evaluations++;
      if(expression.includes('let target=null;')){
        reads++;
        if(options.change&&reads===2){
          if(options.change==='route')view.location.hash='#other';
          if(options.change==='document')view.performance.timeOrigin=2;
          if(options.change==='row')document.getElementById=()=>({...fixture.row});
          if(options.change==='body')fixture.row.querySelector=()=>({...fixture.body});
          if(options.change==='anchor')anchor.isConnected=false;
        }
      }
      if(expression.startsWith('delete window.__b2ShortMenuPointer')){released++;if(options.releaseError)throw Error('controlled release failure');}
      return JSON.parse(JSON.stringify(runInNewContext(expression,context)));
    },
    send:async(method,event)=>{events.push({method,event:JSON.parse(JSON.stringify(event))});if(event.type==='mouseMoved')hover=false;},
  };
  const execute=runInNewContext('('+shortMenuTarget.toString()+')',{assert,leftControlTarget,messageMenuTarget,shortMenuCapture,Date:{now:()=>clock},delay:async(ms)=>{pauses.push(ms);if(!options.frozenClock)clock+=ms;},console});
  let error,target;
  try {target=await execute(c,(name,value)=>{observations.push(JSON.parse(JSON.stringify({name,value})));if(options.recorderError)throw Error('controlled recorder failure');},'short-preview','committed','#channel',options.deadline??30100);
    events.push({event:{type:'mousePressed',button:'right',...target.point}},{event:{type:'mouseReleased',button:'right',...target.point}});
  }catch(value){error=value;}
  return{error,target,events,observations,pauses,reads,evaluations,released,view,clock,fixture};
}

test('short menu anchor rejects unavailable, ambiguous, disabled, occluded, notification, outside and route mismatch with zero movement', async()=>{
  const cases=[['missing',/target_not_unique/],['duplicate',/target_not_unique/],['disabled',/disabled/],['occluded',/occluded/],['notification',/occluded/],['outside',/outside_viewport/],['route',/route_changed/]];
  for(const[anchor,expected]of cases){const r=await shortMenuFixture({anchor});assert.match(String(r.error),expected,anchor);assert.equal(r.events.length,0,anchor);assert.equal(r.reads,0);assert.equal(r.released,1);assert.equal(r.view.__b2ShortMenuPointer,undefined);assert.equal(r.view.__b2LeftClickTarget,undefined);}
});

test('short menu notification hit can recover while toast still exists after exactly one pointer move and one right-click pair', async()=>{
  const r=await shortMenuFixture({blockedReads:1});assert.equal(r.error,undefined);assert.equal(r.reads,2);
  assert.deepEqual(r.events.map(x=>x.event.type),['mouseMoved','mousePressed','mouseReleased']);
  assert.deepEqual(r.events[0].event,{type:'mouseMoved',button:'none',buttons:0,x:200,y:225});
  assert.equal(r.observations.find(o=>o.name.endsWith('-pointer-before')).value.notificationInteraction.toasters[0].hover,true);
  const first=r.observations.find(o=>o.name.endsWith('-menu-first')).value;assert.equal(first.retryable,true);assert.equal(first.target.notificationHit,true);assert.equal(first.notificationInteraction.toasters[0].hover,false);
  const last=r.observations.find(o=>o.name.endsWith('-menu-last')).value;assert.equal(last.reads,2);assert.equal(last.value.target.ready,true);assert.equal(last.value.notificationInteraction.toasters.length,1);
  assert.equal(r.released,1);assert.equal(r.view.__b2ShortMenuPointer,undefined);assert.equal(r.fixture.scrolled(),true);assert.equal(r.fixture.scrollCount(),1);
});

test('short menu persistent notification consumes the same deadline and never dispatches right-click', async()=>{
  const r=await shortMenuFixture({blockedReads:1000,deadline:500});assert.match(String(r.error),/budget exhausted waiting for message hit/);assert.equal(r.clock,500);assert.equal(r.reads,2);assert.deepEqual(r.events.map(x=>x.event.type),['mouseMoved']);assert.deepEqual(r.pauses,[200,200]);assert.equal(r.released,1);assert.equal(r.observations.find(o=>o.name.endsWith('-menu-last')).value.reads,2);
  const cap=await shortMenuFixture({blockedReads:1000,frozenClock:true});assert.match(String(cap.error),/read limit exhausted/);assert.equal(cap.reads,150);assert.equal(cap.evaluations,152);assert.deepEqual(cap.events.map(x=>x.event.type),['mouseMoved']);
});

test('short menu document, route, row, body or anchor identity changes stop immediately without right-click or retry', async()=>{
  for(const change of ['route','document','row','body','anchor']){const r=await shortMenuFixture({blockedReads:1000,change});assert.match(String(r.error),change==='route'||change==='document'?/document\/route changed/:/node identity changed/);assert.equal(r.reads,2);assert.equal(r.pauses.length,1);assert.deepEqual(r.events.map(x=>x.event.type),['mouseMoved']);assert.equal(r.released,1);}
});

test('short menu non-notification occlusion and empty intersection are not retryable and release cannot hide the first refusal', async()=>{
  for(const [options,expected]of [[{foreign:true},/occluded or belongs to another row/],[{geometry:{bounds:{left:10,top:400,width:100,height:20}}},/no visible body intersection/]]){
    const r=await shortMenuFixture({...options,recorderError:true,releaseError:true});assert.match(String(r.error),expected);assert.equal(r.reads,1);assert.equal(r.pauses.length,0);assert.deepEqual(r.events.map(x=>x.event.type),['mouseMoved']);assert.equal(r.observations.at(-1).value.status,'unknown');
  }
});

test('short preview dispatches no right-click when its actual new target wait rejects and normal preview does not call that wait', async()=>{
  const failure=Error('controlled short target refusal');let calls=0;
  const helper=async()=>{calls++;throw failure;};
  const short=await shortPreviewFixture(undefined,true,{shortMenuTarget:helper});assert.equal(short.error,failure);assert.equal(short.events.length,0);assert.equal(calls,1);
  const normal=await shortPreviewFixture(undefined,false,{shortMenuTarget:helper});assert.equal(normal.error,undefined);assert.equal(calls,1);assert.equal(normal.events.filter(e=>e==='mousePressed').length,1);
});


function initialAmbiguousNodes(mode='list') {
  const tree=ambiguousDownloadsNodes(true);
  if(mode==='grid'){tree[3]['resource-id']='com.google.android.documentsui:id/sub_menu_list';tree[3]['content-desc']='List view';}
  return tree;
}

test('initial ambiguity in confirmed Downloads keeps its mode and uses one fresh unique target without navigation', async()=>{
  for(const mode of ['list','grid']){
    const initial=initialAmbiguousNodes(mode),fresh=downloadsFileNodes({mode,target:true});fresh[4].bounds='[30,110][190,310]';
    const r=await strictNativeChooserFixture([initial,fresh]);assert.equal(r.error,undefined);assert.equal(r.reads,2);assert.deepEqual(r.taps,[['shell','input','tap','110','210']]);
    const first=r.observations.find(o=>o.phase==='initial').value;assert.equal(first.decision,'ambiguous');assert.equal(first.candidateCount,2);assert.equal(first.directory.mode,mode);assert.deepEqual(first.nodes,initial);
    assert.equal(r.observations.some(o=>o.phase==='view-target'||o.phase==='view-dispatch-returned'),false);
    const target=r.observations.find(o=>o.phase==='target').value;assert.equal(target.readIndex,1);assert.equal(target.directory.mode,mode);assert.deepEqual(target.nodes,fresh);
  }
});

test('initial ambiguity is distinct from not_found and never causes a delayed grid switch or root navigation', async()=>{
  const initial=initialAmbiguousNodes('grid'),missing=downloadsFileNodes({mode:'grid'}),unique=downloadsFileNodes({mode:'grid',target:true});
  const r=await strictNativeChooserFixture([initial,missing,unique]);assert.equal(r.error,undefined);assert.equal(r.reads,3);assert.deepEqual(r.taps,[['shell','input','tap','100','200']]);
  assert.equal(r.observations.find(o=>o.phase==='initial').value.decision,'ambiguous');assert.equal(r.observations.find(o=>o.phase==='lookup-first-miss').value.decision,'not_found');assert.equal(r.observations.some(o=>o.phase.startsWith('view-')),false);
});

test('initial ambiguity that stays nonunique consumes only original12 lookup reads and dispatches zero input', async()=>{
  for(const mode of ['list','grid']){
    const initial=initialAmbiguousNodes(mode);const r=await strictNativeChooserFixture([initial]);assert.match(r.error.message,/Ambiguous native file target/);assert.equal(r.reads,13);assert.equal(r.taps.length,0);
    const samples=r.observations.filter(o=>o.value.nodes);assert.deepEqual(samples.map(o=>o.phase),['initial','lookup-first-miss','lookup-last']);assert.equal(samples[0].value.decision,'ambiguous');assert.equal(samples.at(-1).value.readIndex,12);assert.equal(samples.at(-1).value.decision,'ambiguous');assert.equal(samples.at(-1).value.candidateCount,2);
  }
});

test('initial ambiguity never bypasses unknown directory package or invalid positive mode', async()=>{
  const cases=[
    [(n)=>{n[1].text='Recent';},/Ambiguous native file target/],
    [(n)=>{n[0].package='unknown.dialog';},/Downloads picker identity changed/],
    [(n)=>{n[3]['content-desc']='unknown';},/Downloads view control identity changed/],
    [(n)=>n.splice(3,1),/Downloads view control missing or ambiguous/],
    [(n)=>{n[3].enabled='false';},/Downloads view control unavailable/],
  ];
  for(const[alter,expected]of cases){const tree=initialAmbiguousNodes();alter(tree);const r=await strictNativeChooserFixture([tree]);assert.match(r.error.message,expected);assert.equal(r.reads,1);assert.equal(r.taps.length,0);assert.equal(r.observations.find(o=>o.phase==='target-rejected').value.stage,'initial');}
});

test('initial ambiguity preserves all unique-target guards and refuses each later directory or mode drift', async()=>{
  const cases=[
    [(n)=>{n[4].enabled='false';},/Native file target disabled/],
    [(n)=>{n[4].bounds='bad';},/Native file target has invalid or offscreen bounds/],
    [(n)=>{n[5].bounds='[90,190][110,210]';},/Native file target center overlaps Preview/],
    [(n)=>{n[1].text='Recent';},/Downloads directory missing or ambiguous/],
    [(n)=>{n[3]['resource-id']='com.google.android.documentsui:id/sub_menu_list';n[3]['content-desc']='List view';},/Downloads view mode changed or not established/],
  ];
  for(const[alter,expected]of cases){const initial=initialAmbiguousNodes(),fatal=downloadsFileNodes({mode:'list',target:true});alter(fatal);const r=await strictNativeChooserFixture([initial,fatal]);assert.match(r.error.message,expected);assert.equal(r.reads,2);assert.equal(r.taps.length,0);const rejected=r.observations.find(o=>o.phase==='target-rejected').value;assert.equal(rejected.stage,'lookup');assert.equal(rejected.readIndex,1);assert.deepEqual(rejected.nodes,fatal);}
});

test('initial ambiguity does not replace a later missing judgment or failed new-tree acquisition', async()=>{
  const initial=initialAmbiguousNodes(),missing=downloadsFileNodes({mode:'list'});
  const r=await strictNativeChooserFixture([initial,missing]);assert.match(r.error.message,/^Native UI control not found$/);assert.equal(r.reads,13);assert.equal(r.taps.length,0);assert.equal(r.observations.find(o=>o.phase==='lookup-last').value.decision,'not_found');
  const failed=await strictNativeChooserFixture([initial],{readFailureAt:2});assert.equal(failed.error.cause,failed.readError);assert.equal(failed.reads,2);assert.equal(failed.taps.length,0);assert.equal(failed.observations.find(o=>o.phase==='read-error').value.status,'unknown');
});


test('short chrome boundary uses actual viewport-coordinate lower edge through pane and scroll offsets and height changes',()=>{
  for(const[geometry,expectedY]of [
    [{paneBox:{left:0,top:50,width:400,height:241},chromeBox:{left:0,top:50,width:400,height:60},scrollBox:{left:0,top:50,width:400,height:200}},180],
    [{paneBox:{left:0,top:0,width:400,height:291},chromeBox:{left:0,top:0,width:400,height:100},scrollBox:{left:0,top:0,width:400,height:166}},133],
    [{paneBox:{left:0,top:-20,width:400,height:311},chromeBox:{left:0,top:-20,width:400,height:90},scrollBox:{left:0,top:-20,width:400,height:220}},135],
  ]){
    const f=menuFixture({height:291,bounds:{left:50,top:-200,width:300,height:600},...geometry});f.chrome.offsetTop=9999;f.pane.scrollTop=8888;
    const target=messageMenuTarget(f.document,'committed',true,true);assert.equal(target.ready,true);assert.equal(target.point.y,expectedY);assert.equal(target.point.x,200);assert.equal(target.chromeRelation.boundary,target.chrome.rect.bottom);assert.equal(target.rowContainsHit,true);assert.equal(target.bodyContainsHit,true);assert.equal(target.scrollerContainsHit,true);assert.equal(target.nearestRowId,'msg-committed');
  }
});

test('short chrome boundary refuses missing ambiguous hidden wrong-position and partial-width topology without fallback',()=>{
  for(const[options,expected]of [
    [{chromeMissing:true},/chrome missing or ambiguous/],
    [{chromeDuplicate:true},/chrome missing or ambiguous/],
    [{chromeHidden:true},/chrome top relationship unknown/],
    [{chromePosition:'static'},/chrome top relationship unknown/],
    [{chromeWrongKind:true},/chrome top relationship unknown/],
    [{chromeBox:{left:0,top:10,width:400,height:90}},/chrome top relationship unknown/],
    [{chromeBox:{left:100,top:0,width:150,height:50}},/chrome top relationship unknown/],
  ]){const f=menuFixture({height:291,...options});let state;assert.throws(()=>messageMenuTarget(f.document,'committed',true,true),error=>{state=error.targetState;return expected.test(error.message);});assert.equal(state.ready,false);assert.equal(state.point,null);assert.equal(f.lastPoint(),undefined);}
});

test('short chrome boundary rejects no remaining region, other occlusion and replaced identities with bounded hit diagnostics',()=>{
  for(const[options,expected]of [
    [{chromeBox:{left:0,top:0,width:400,height:291}},/no visible body intersection/],
    [{occluded:true},/occluded or belongs to another row/],
    [{replaceRow:true},/row replaced after scroll/],
    [{replaceBody:true},/node identity changed/],
    [{replaceChrome:true},/chrome node identity changed/],
  ]){const f=menuFixture({height:291,...options});let state;assert.throws(()=>messageMenuTarget(f.document,'committed',true,true),error=>{state=error.targetState;return expected.test(error.message);});assert.equal(state.ready,false);if(options.occluded){assert.equal(state.hit.id,'foreign');assert.equal(state.rowContainsHit,false);assert.equal(state.bodyContainsHit,false);assert.equal(state.scrollerContainsHit,false);assert.equal(state.hit.className,'');assert(state.hit.rect);assert.equal(state.hit.pointerEvents,'auto');assert(state.hitAncestors.length<=6);}}
});

test('normal-height menu path does not require chrome or narrow its old center',()=>{
  const f=menuFixture({chromeMissing:true});const normal=messageMenuTarget(f.document,'committed');assert.equal(normal.ready,true);assert.deepEqual(normal.point,{x:60,y:50});assert.equal(normal.chrome,undefined);assert.equal(normal.chromeCount,undefined);
});

test('short chrome boundary is applied by the real pointer-wait serialization and invalid geometry dispatches no right-click',async()=>{
  const good=await shortMenuFixture({geometry:{bounds:{left:50,top:-200,width:300,height:600},scrollBox:{left:0,top:0,width:400,height:166},chromeBox:{left:0,top:0,width:400,height:100}}});assert.equal(good.error,undefined);assert.equal(good.target.point.y,133);assert.equal(good.target.chromeRelation.boundary,100);assert.deepEqual(good.events.map(x=>x.event.type),['mouseMoved','mousePressed','mouseReleased']);
  for(const[geometry,expected]of [[{chromeMissing:true},/chrome missing or ambiguous/],[{chromeBox:{left:0,top:0,width:400,height:291}},/no visible body intersection/],[{chromeDuplicate:true},/chrome missing or ambiguous/]]){const r=await shortMenuFixture({geometry});assert.match(String(r.error),expected);assert.equal(r.reads,1);assert.equal(r.pauses.length,0);assert.deepEqual(r.events.map(x=>x.event.type),['mouseMoved']);assert.equal(r.released,1);}
});

function shortCaptureFixture(options={}) {
  const f=menuFixture({height:291}),document=f.document,view=document.defaultView;
  f.row.scrollIntoView(); // The preceding real target guard has already aligned this row.
  view.location={origin:'https://localhost',hash:'#channel'};view.performance={timeOrigin:1};
  let clock=100,removed=0,added=0,state='closed',menuTexts=[];
  const listeners=new Map(),calls=[];
  document.addEventListener=(type,handler,capture)=>{assert.equal(capture,true);if(options.installFailure&&++added===3)throw Error('controlled install failure');if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(handler);};
  document.removeEventListener=(type,handler,capture)=>{assert.equal(capture,true);removed++;if(options.releaseFailure)throw Error('controlled remove failure');listeners.get(type)?.delete(handler);};
  const rowGet=f.row.getAttribute;
  f.row.getAttribute=(name)=>name==='data-state'?state:name==='aria-haspopup'?'menu':rowGet(name);
  document.querySelectorAll=(s)=>s==='[role=menuitem]'?menuTexts.map(text=>({textContent:text,getAttribute:()=>null})):s==='[role=menu]'&&menuTexts.length?[{}]:[];
  const context={document,window:view,Date:{now:()=>clock}};
  const capture=(action='sample')=>JSON.parse(JSON.stringify(runInNewContext(`(${shortMenuCapture.toString()})(document,'committed','#channel',${JSON.stringify(action)})`,context)));
  const emit=(type='contextmenu',extra={})=>{const event={type,target:f.body,eventPhase:1,isTrusted:true,timeStamp:clock,defaultPrevented:false,button:2,buttons:0,pointerType:'mouse',clientX:20,clientY:60,composedPath:()=>[f.body,f.row,document,view],...extra};for(const handler of listeners.get(type)??[])handler(event);return event;};
  return {...f,view,context,capture,emit,listeners,calls,removed:()=>removed,clock:()=>clock,advance:(ms)=>clock+=ms,menu:(texts)=>{menuTexts=texts;state=texts.length?'open':'closed';},listenerCount:()=>[...listeners.values()].reduce((n,set)=>n+set.size,0)};
}

test('short context capture serializes a bounded synchronous capture-phase snapshot without cancelling or invoking handlers',()=>{
  const f=shortCaptureFixture();const installed=f.capture('install');assert.equal(installed.status,'installed');assert.equal(installed.identityCurrent,true);assert.equal(f.listenerCount(),7);
  const event=f.emit();event.defaultPrevented=true;
  for(let i=0;i<25;i++)f.emit('mousedown');
  const value=f.capture();assert.equal(value.events.length,16);assert.equal(value.total,26);assert.equal(value.dropped,10);assert.equal(value.events[0].defaultPreventedAtCapture,false);assert.equal(value.events[0].samplingPhase,'document_capture');assert.equal(value.events[0].isTrusted,true);assert.equal(value.events[0].rowContainsTarget,true);assert.equal(value.events[0].bodyContainsTarget,true);assert.equal(value.events[0].scrollerContainsTarget,true);assert(value.events.every(e=>e.path.length<=8));assert.equal(event.defaultPrevented,true);
  const released=f.capture('release');assert.equal(released.release,'released');assert.equal(released.events.length,16);assert.equal(f.listenerCount(),0);assert.equal(f.view.__b2ShortMenuCapture,undefined);assert.equal(f.capture().status,'not_installed');
});

test('short context capture records zero observed events, refuses duplicate installation and preserves explicit identity and release failures',()=>{
  for(const change of ['route','document','row','body']){
    const f=shortCaptureFixture();f.capture('install');assert.equal(f.capture('install').reason,'capture_already_installed');
    if(change==='route')f.view.location.hash='#other';if(change==='document')f.view.performance.timeOrigin=2;if(change==='row')f.document.getElementById=()=>({...f.row});if(change==='body')f.row.querySelector=()=>({...f.body});
    const value=f.capture('release');assert.equal(value.identityCurrent,false,change);assert.equal(value.events.length,0);assert.equal(value.total,0);assert.equal(value.release,'released');assert.equal(f.listenerCount(),0);
  }
  const bad=shortCaptureFixture({installFailure:true});assert.equal(bad.capture('install').status,'unknown');assert.equal(bad.listenerCount(),0);assert.equal(bad.capture('release').release,'not_installed');
  const failure=shortCaptureFixture({releaseFailure:true});failure.capture('install');assert.equal(failure.capture('release').release,'unknown');assert.equal(failure.removed(),7);assert.equal(failure.listenerCount(),7);
});

async function shortContextFixture(options={}) {
  const f=shortCaptureFixture(options), observations=[],inputs=[],pauses=[];
  const install=f.capture('install');assert.equal(install.status,'installed');let reads=0,checkReads=0;
  const c={evaluate:async expression=>{
    if(expression.includes('function messageMenuTarget')){checkReads++;if(options.checkChange)options.checkChange(f);if(options.checkCost)f.advance(options.checkCost);}
    else {reads++;if(options.change&&reads===1)f.view.location.hash='#other';f.menu(options.menus?.[reads-1]??[]);if(options.readCost)f.advance(options.readCost);}
    return JSON.parse(JSON.stringify(runInNewContext(expression,f.context)));
  },send:async(_method,event)=>{inputs.push(event);f.emit(event.type==='mousePressed'?'mousedown':'mouseup');if(event.type==='mouseReleased')f.emit('contextmenu');if(options.sendFailure)throw options.sendFailure;}};
  const execute=runInNewContext('('+shortContextMenu.toString()+')',{assert,shortMenuCapture,messageMenuTarget,Date:{now:()=>f.clock()},delay:async ms=>{pauses.push(ms);if(!options.frozen)f.advance(ms);},console});let error,value;
  try{value=await execute(c,(name,value)=>{observations.push(JSON.parse(JSON.stringify({name,value})));if(options.observerFailure)throw Error('controlled observer failure');},'short-preview',{x:20,y:50},'committed','#channel',options.deadline??30100);}catch(e){error=e;}
  return{f,error,value,reads,checkReads,inputs,observations,pauses};
}

function bottomButtonFixture(options={}) {
  const f=menuFixture({height:291,bounds:{left:60,top:80,width:300,height:100},chromeBox:{left:0,top:0,width:400,height:100},scrollBox:{left:0,top:0,width:400,height:166},...options.geometry});
  const box=options.buttonBox??{left:180,top:114,width:36,height:36};
  const button={isConnected:true,tagName:'BUTTON',id:'bottom',parentElement:f.pane,
    getAttribute:n=>n==='aria-label'||n==='title'?'Scroll to bottom':null,hasAttribute:n=>n==='data-scroll-bottom',
    closest:s=>s==='[data-panel]'?f.pane:null,
    getBoundingClientRect:()=>({...box,right:box.left+box.width,bottom:box.top+box.height})};
  const originalQuery=f.pane.querySelectorAll,originalStyle=f.document.defaultView.getComputedStyle;
  let buttonReads=0,hitReads=0;
  f.pane.querySelectorAll=s=>{
    if(s!=='button[data-scroll-bottom]')return originalQuery(s);
    buttonReads++;
    if(options.none)return [];
    if(options.replaceButton&&buttonReads>1)return[{...button}];
    const foreign={...button,closest:()=>({})};
    return options.multiple?[button,{...button}]:options.foreign?[button,foreign]:[button];
  };
  f.document.defaultView.getComputedStyle=e=>({...originalStyle(e),...(e===button?{position:options.position??'absolute',pointerEvents:'auto',visibility:options.hidden?'hidden':'visible'}:{})});
  f.document.elementFromPoint=(x,y)=>{hitReads++;if(options.otherOverlay)return{...button,id:'other-overlay',closest:()=>null};return x>=box.left&&x<box.left+box.width&&y>=box.top&&y<box.top+box.height&&!options.none?button:f.body;};
  return{...f,button,buttonReads:()=>buttonReads,hitReads:()=>hitReads};
}

test('short bottom avoidance serializes the same-pane actual rectangle and chooses one largest free rectangle with one hit',()=>{
  const f=bottomButtonFixture({foreign:true});
  const r=JSON.parse(JSON.stringify(runInNewContext(`(${messageMenuTarget.toString()})(document,'committed',false,true,{originalPoint:{x:210,y:133}})`,{document:f.document})));
  assert.equal(r.bottomButtonAvoidance.count,1);assert.equal(r.bottomButtonAvoidance.ownedByCurrentPane,true);
  assert.deepEqual(r.intersection,{left:60,top:100,right:360,bottom:166,width:300,height:66});
  assert.deepEqual(r.bottomButtonAvoidance.candidates.map(c=>[c.side,c.area]),[['right',9504],['left',7920],['down',4800],['up',4200]]);
  assert.equal(r.bottomButtonAvoidance.selected.side,'right');assert.deepEqual(r.point,{x:288,y:133});assert.equal(r.ready,true);assert.equal(f.hitReads(),1);assert.equal(f.scrollCount(),0);
});

test('short bottom avoidance uses only exact area ties in fixed right left down up order',()=>{
  for(const [buttonBox,selected]of [[{left:192,top:114,width:36,height:36},'right'],[{left:192,top:114,width:200,height:36},'left'],[{left:60,top:125,width:300,height:16},'down']]){
    const f=bottomButtonFixture({buttonBox});const r=messageMenuTarget(f.document,'committed',false,true,{originalPoint:{x:210,y:133}});
    assert.equal(r.bottomButtonAvoidance.selected.side,selected);assert.equal(f.hitReads(),1);
  }
  const f=bottomButtonFixture({buttonBox:{left:192.0001,top:114,width:36,height:36}});const r=messageMenuTarget(f.document,'committed',false,true,{originalPoint:{x:210,y:133}});assert.equal(r.bottomButtonAvoidance.selected.side,'left');assert.equal(f.hitReads(),1);
});

test('short bottom avoidance preserves the original point without a button or intersection and does not activate at normal height',()=>{
  for(const options of [{none:true},{buttonBox:{left:10,top:200,width:36,height:36}}]){
    const f=bottomButtonFixture(options);const r=messageMenuTarget(f.document,'committed',false,true,{originalPoint:{x:220,y:133}});
    assert.deepEqual(r.point,{x:220,y:133});assert.equal(r.bottomButtonAvoidance.overlap,null);assert.equal(r.bottomButtonAvoidance.selected,null);assert.equal(r.bottomButtonAvoidance.candidates.length,0);assert.equal(f.hitReads(),1);
  }
  const f=bottomButtonFixture({buttonBox:{left:10,top:200,width:36,height:36}});const r=messageMenuTarget(f.document,'committed',false,false);assert.equal(r.bottomButtonAvoidance,undefined);assert.equal(f.buttonReads(),0);assert.equal(f.hitReads(),1);
});

test('short bottom avoidance rejects complete coverage ambiguous or invalid geometry and replacement without trying another point',()=>{
  for(const [options,expected,hits]of [
    [{buttonBox:{left:0,top:0,width:400,height:291}},/no remaining rectangle/,0],
    [{multiple:true},/bottom button ambiguous/,0],
    [{position:'fixed'},/geometry unavailable/,0],
    [{hidden:true},/geometry unavailable/,0],
    [{buttonBox:{left:NaN,top:114,width:36,height:36}},/geometry unavailable/,0],
    [{replaceButton:true},/button identity changed/,0],
    [{geometry:{replaceRow:true}},/row replaced after scroll/,0],
    [{geometry:{replaceBody:true}},/node identity changed/,0],
    [{otherOverlay:true},/occluded or belongs to another row/,1],
  ]){
    const f=bottomButtonFixture(options);let state;assert.throws(()=>messageMenuTarget(f.document,'committed',false,true,{originalPoint:{x:210,y:133}}),e=>{state=e.targetState;return expected.test(e.message);});assert.equal(state.ready,false);assert.match(state.reason,expected);assert.equal(f.hitReads(),hits);
    if(options.otherOverlay){assert.equal(state.bottomButtonAvoidance.selected.side,'right');assert.equal(state.hit.id,'other-overlay');assert.equal(state.rowContainsHit,false);}
  }
});

test('short bottom avoidance retains the existing single evaluate and one right pair using only its newly checked point',async()=>{
  let hits=0;
  const r=await shortContextFixture({menus:[['Share…']],checkChange:f=>{
    const b=bottomButtonFixture();
    f.pane.querySelectorAll=b.pane.querySelectorAll;
    // Keep the original captured identities and make the one owned button refer to their pane.
    b.button.closest=s=>s==='[data-panel]'?f.pane:null;
    const query=f.pane.querySelectorAll,style=f.view.getComputedStyle;
    f.pane.querySelectorAll=s=>s==='button[data-scroll-bottom]'?[b.button]:s===':scope > [data-pane-chrome]'?[f.chrome]:query(s);
    f.view.getComputedStyle=e=>e===b.button?{...style(e),position:'absolute'}:style(e);
    f.body.getBoundingClientRect=()=>({left:60,top:80,right:360,bottom:180,width:300,height:100});
    const scroller=f.body.closest('[data-virtuoso-scroller]');scroller.clientHeight=166;scroller.getBoundingClientRect=()=>({left:0,top:0,right:400,bottom:166,width:400,height:166});
    f.chrome.getBoundingClientRect=()=>({left:0,top:0,right:400,bottom:100,width:400,height:100});
    f.document.elementFromPoint=()=>{hits++;return f.body;};
  }});
  assert.equal(r.error,undefined);assert.equal(r.checkReads,1);assert.equal(r.reads,1);assert.equal(hits,1);assert.equal(r.inputs.length,2);assert(r.inputs.every(e=>e.x===288&&e.y===133));
  const check=r.observations.find(o=>o.name.endsWith('-point-check')).value;assert.equal(check.pointCheck.bottomButtonAvoidance.selected.side,'right');assert.equal(r.f.capture('release').release,'released');assert.equal(r.f.listenerCount(),0);
});

test('short bottom refusal preserves zero right input and releases the original preview capture',async()=>{
  for(const variant of ['ambiguous','cover','other-overlay']){
    const f=shortCaptureFixture();const button={...f.body,tagName:'BUTTON',id:'bottom',closest:s=>s==='[data-panel]'?f.pane:null,getBoundingClientRect:()=>({left:0,top:0,right:400,bottom:291,width:400,height:291})};
    const query=f.pane.querySelectorAll,style=f.view.getComputedStyle;
    f.pane.querySelectorAll=s=>s==='button[data-scroll-bottom]'?(variant==='ambiguous'?[button,{...button}]:variant==='cover'?[button]:[]):query(s);
    f.view.getComputedStyle=e=>e===button?{...style(e),position:'absolute'}:style(e);
    const helper=runInNewContext('('+shortContextMenu.toString()+')',{assert,shortMenuCapture,messageMenuTarget,Date:{now:()=>1},delay:async()=>{},console});
    const r=await shortPreviewFixture(undefined,true,{menuDocument:f.document,stateDocument:f.document,captureDocument:f.document,shortContextMenu:helper,shortMenuTarget:async()=>{f.capture('install');if(variant==='other-overlay')f.document.elementFromPoint=()=>button;return{ready:true,point:{x:20,y:50}};}});
    const reason=variant==='ambiguous'?/button ambiguous/:variant==='cover'?/no remaining rectangle/:/occluded or belongs to another row/;
    assert.match(String(r.error),reason);assert.equal(r.events.filter(e=>e==='mousePressed'||e==='mouseReleased').length,0);assert.equal(f.listenerCount(),0);
    const check=r.observations.find(o=>o.name==='short-preview-point-check').value.pointCheck;assert.equal(check.ready,false);assert.match(check.reason,reason);assert.equal(r.observations.find(o=>o.name==='short-preview-menu-failure').value.capture.release,'released');
  }
});

test('short context menu polls a transient Share state in the original deadline and uses exactly one right pair',async()=>{
  const r=await shortContextFixture({menus:[[],['Share…']]});assert.equal(r.error,undefined);assert.equal(r.reads,2);assert.equal(r.value.shareCount,1);assert.equal(r.value.trigger.state,'open');assert.deepEqual(r.inputs.map(e=>e.type),['mousePressed','mouseReleased']);assert.deepEqual(r.pauses,[200]);
  assert.equal(r.checkReads,1);assert(r.inputs.every(e=>e.x===20&&e.y===50));
  assert.equal(r.observations.find(o=>o.name.endsWith('-wait-first')).value.shareCount,0);assert.equal(r.observations.at(-1).value.reads,2);assert.equal(r.value.capture.events.filter(e=>e.type==='contextmenu').length,1);
  assert.equal(r.observations.filter(o=>/-mouse(Pressed|Released)-(start|end)$/.test(o.name)).length,4);assert.equal(r.observations.find(o=>o.name.endsWith('-wait-start')).value.deadline,30100);
  r.f.menu([]);assert.equal(r.f.capture('release').release,'released');assert.equal(r.f.listenerCount(),0);
});

test('short context menu truncates intervals at the existing deadline, rejects late reads and caps frozen-clock polls at 150',async()=>{
  const r=await shortContextFixture({deadline:450});assert.match(String(r.error),/deadline exhausted/);assert.equal(r.f.clock(),450);assert.deepEqual(r.pauses,[200,150]);assert.equal(r.reads,2);assert.equal(r.inputs.length,2);assert.equal(r.f.capture('release').release,'released');
  const cap=await shortContextFixture({frozen:true});assert.match(String(cap.error),/read limit exhausted/);assert.equal(cap.reads,150);assert.equal(cap.pauses.length,149);assert.equal(cap.inputs.length,2);cap.f.capture('release');
  const late=await shortContextFixture({deadline:200,readCost:200,menus:[['Share…']]});assert.match(String(late.error),/budget exhausted after menu read/);assert.equal(late.reads,1);late.f.capture('release');
});

test('short context menu rejects changed identity immediately and diagnostic observer errors preserve the original dispatch error',async()=>{
  const r=await shortContextFixture({change:true});assert.match(String(r.error),/identity changed or unavailable/);assert.equal(r.reads,1);assert.equal(r.pauses.length,0);r.f.capture('release');
  const primary=Error('controlled right dispatch failure');const bad=await shortContextFixture({sendFailure:primary,observerFailure:true});assert.equal(bad.error,primary);assert.equal(bad.inputs.length,1);assert.equal(bad.reads,0);bad.f.capture('release');
});

test('short context preview releases from its existing success and failure state reads, and normal preview retains its old menu wait',async()=>{
  let calls=0;const helper=async()=>{calls++;};const ok=await shortPreviewFixture(undefined,true,{shortContextMenu:helper});assert.equal(ok.error,undefined);assert.equal(calls,1);assert.equal(ok.observations.find(o=>o.name==='short-preview-menu-open').value.capture.release,'released');
  const primary=Error('controlled menu timeout');const fail=await shortPreviewFixture(undefined,true,{shortContextMenu:async()=>{throw primary;}});assert.equal(fail.error,primary);assert.equal(fail.observations.find(o=>o.name==='short-preview-menu-failure').value.capture.release,'released');
  const normal=await shortPreviewFixture(undefined,false,{shortContextMenu:async()=>{throw Error('must not run');}});assert.equal(normal.error,undefined);assert.equal(normal.events.filter(e=>e==='mousePressed').length,1);
});


test('short context final state and fallback release failures remain distinct, with one bounded fallback and the original error',async()=>{
  const primary=Error('controlled menu timeout'),stateFailure=Error('controlled final state read'),fallbackFailure=Error('controlled release read');
  const r=await shortPreviewFixture(undefined,true,{shortContextMenu:async()=>{throw primary;},stateFailure,fallbackFailure});
  assert.equal(r.error,primary);assert.equal(r.finalStateReads,1);assert.equal(r.fallbackReleaseReads,1);assert.equal(r.events.length,0);
  const last=r.observations.find(o=>o.name==='short-preview-menu-final-state-unknown').value;assert.equal(last.status,'unknown');assert.match(last.error,/controlled final state read/);assert.equal(last.captureRelease,'unconfirmed');
  const release=r.observations.find(o=>o.name==='short-preview-capture-release-fallback').value;assert.equal(release.release,'unconfirmed');assert.match(release.error,/controlled release read/);
  const normal=await shortPreviewFixture(undefined,false,{shortContextMenu:async()=>{throw primary;}});assert.equal(normal.fallbackReleaseReads,0);
});


test('short context real preview final-state serialization collects and releases the actual listener after a menu error',async()=>{
  const f=shortCaptureFixture();const primary=Error('controlled real menu wait failure');
  // The actual preview posts this committed id when a menuDocument is supplied.
  const r=await shortPreviewFixture(undefined,true,{menuDocument:f.document,stateDocument:f.document,shortContextMenu:async()=>{f.capture('install');f.emit();throw primary;}});
  assert.equal(r.error,primary);assert.equal(r.fallbackReleaseReads,0);assert.equal(f.listenerCount(),0);assert.equal(f.view.__b2ShortMenuCapture,undefined);
  const final=r.observations.find(o=>o.name==='short-preview-menu-failure').value;assert.equal(final.capture.release,'released');assert.equal(final.capture.events[0].type,'contextmenu');assert.equal(final.capture.identityCurrent,true);
});

test('short context expired existing deadline performs no right input or menu read',async()=>{
  const r=await shortContextFixture({deadline:100});assert.match(String(r.error),/budget exhausted before menu/);assert.equal(r.inputs.length,0);assert.equal(r.reads,0);assert.equal(r.f.capture('release').release,'released');
});

const coverageTable=JSON.parse(readFileSync(new URL('./acceptance-scenarios.json',import.meta.url)));
const actualCoverageMetadata = () => coverageMetadata;

test('grouped coverage selects exactly2/2/10 and preserves the original33 and old diagnostic plans',()=>{
  const metadata=actualCoverageMetadata(),full=[...coverageTable.original12,...coverageTable.B2.filter(r=>r.scope==='device').map(r=>'B2.'+r.id),...coverageTable.B1_affected.map(i=>'B1.'+coverageTable.B1[i-1])];assert.equal(full.length,33);
  for(const [selector,count,ordinary]of [['coverage-short',2,0],['coverage-bars',2,1],['coverage-b1',10,7]]){
    const m=metadata(coverageTable,selector);assert.equal(m.planned,count);assert.equal(m.selected_ids.length,count);assert.equal(new Set(m.selected_ids).size,count);assert.equal(m.ordinary33_selected.length,ordinary);assert.equal(m.ordinary33_not_selected.length,33-ordinary);assert.equal(m.group_counts_not_aggregated,true);assert.equal(m.kind,'grouped');
  }
  assert.equal(metadata(coverageTable,undefined),null);assert.equal(metadata(coverageTable,'appearance-short'),null);
  assert.deepEqual(coverageTable.B1_affected,[4,5,6,9,10,11,12]);assert.deepEqual(coverageTable.diagnostics['photo-picker-menu'],['DIAG.real-page-login','DIAG.photo-picker-menu']);assert.deepEqual(coverageTable.diagnostics['appearance-short'],['DIAG.real-page-login','DIAG.theme-short-path']);assert.deepEqual(coverageTable.diagnostics['appearance-startup'],['DIAG.real-page-login','DIAG.theme-startup']);
});

async function coverageDispatchFixture(diagnostic,fail=false) {
  let source=runB2.toString().replace("new URL('./acceptance-scenarios.json', import.meta.url)","'controlled-table'");const a=source.indexOf('  async function shortPreview()'),b=source.indexOf('  async function receiver()',a);source=source.slice(0,a)+"  async function shortPreview(){calls.push('original-short-scene');if(fail)throw primary;return{short:true};}\n"+source.slice(b);
  const x=source.indexOf("    'theme.os-and-bars': async () => {"),y=source.indexOf("    'avatar.web-save-cancel':",x);source=source.slice(0,x)+"    'theme.os-and-bars': async()=>{calls.push('original-bars-scene');if(fail)throw primary;return{four:true};},\n"+source.slice(y);
  const calls=[],steps=[],primary=Error('controlled grouped scene failure');const actual=runInNewContext('('+source+')',{assert,Buffer,readFileSync:()=>JSON.stringify(coverageTable),nativeUI:()=>({}),calls,fail,primary});let error;
  try{await actual({diagnostic,fixture:{},root:'/controlled/',out:'/controlled',step:async(id,fn)=>{steps.push(id);if(diagnostic==='coverage-short'||diagnostic==='coverage-bars')return fn();}});}catch(e){error=e;}
  return{calls,steps,error,primary};
}

test('grouped coverage dispatches only the existing short or bars body without any upload or full share tail',async()=>{
  for(const [selector,id,body]of [['coverage-short','DIAG.short-selection','original-short-scene'],['coverage-bars','B2.theme.os-and-bars','original-bars-scene']]){
    const r=await coverageDispatchFixture(selector);assert.equal(r.error,undefined);assert.deepEqual(r.steps,[id]);assert.deepEqual(r.calls,[body]);
    const bad=await coverageDispatchFixture(selector,true);assert.equal(bad.error,bad.primary);assert.deepEqual(bad.steps,[id]);
  }
  const normal=await coverageDispatchFixture(undefined);assert.deepEqual(normal.steps,coverageTable.B2.filter(r=>r.scope==='device').map(r=>'B2.'+r.id));assert.equal(normal.calls.length,0);
  for(const old of ['appearance-short','photo-picker-menu']){const r=await coverageDispatchFixture(old);assert.equal(r.error,undefined);assert.deepEqual(r.steps,coverageTable.diagnostics[old].slice(1));}
  for(const bad of ['coverage-b1','coverage-unknown']){const r=await coverageDispatchFixture(bad);assert.match(String(r.error),/Unknown B2 diagnostic/);assert.equal(r.steps.length,0);}
});

function groupedObserverFixture(change) {
  const dir=mkdtempSync(join(tmpdir(),'grouped-b1-'));const names=coverageTable.diagnostics['coverage-b1'];const report=new AcceptanceRecord(dir,names);report.pass(names[0],'controlled real login');report.pass(names[1],'controlled actual logout');
  writeFileSync(join(dir,'b1-fixture.json'),JSON.stringify({workspace:'w',channel:'c'}));const value={route:'#/chat/w/w/c/c',freshFixture:true,historicalPassesUsed:false,selectedCases:coverageTable.B1_affected.slice(),identity:{activity:1,webViewIdentity:2}};
  if(change==='route')value.route='#/chat';if(change==='cases')value.selectedCases=[4];if(change==='identity')delete value.identity.webViewIdentity;if(change==='provenance')value.freshFixture=false;if(change==='fixture')writeFileSync(join(dir,'b1-fixture.json'),'{}');
  const fn = groupedB1Observation;
  return{dir,report,value,observe:fn(report,dir+'/',coverageTable)};
}

test('grouped B1 readiness validates the actual fixture route seven-case set and identity before counting only the DIAG precondition',async()=>{
  const f=groupedObserverFixture();try{
    f.observe('unrelated-observation',{});assert.equal(f.report.data.steps[2].status,'not_executed');f.observe('continuation-preconditions.json',f.value);assert.equal(f.report.data.steps[2].status,'passed');assert(f.report.data.steps.slice(3).every(r=>r.status==='not_executed'));
    assert.throws(()=>f.observe('continuation-preconditions.json',f.value),/Repeated B1 initialization/);
    const primary=Error('controlled IME case failure');await assert.rejects(f.report.step(f.report.data.steps[3].id,async()=>{throw primary;}),e=>e===primary);assert.equal(f.report.data.steps[2].status,'passed');assert.equal(f.report.data.steps[3].status,'failed');
  }finally{rmSync(f.dir,{recursive:true,force:true});}
});

test('grouped B1 initialization mismatches fail the prerequisite and leave all seven functional bodies unexecuted',()=>{
  for(const [change,expected]of [['route',/route does not match/],['cases',/case set changed/],['identity',/identity missing/],['provenance',/provenance changed/],['fixture',/fixture identity missing/]]){
    const f=groupedObserverFixture(change);try{let caught;assert.throws(()=>f.observe('continuation-preconditions.json',f.value),e=>{caught=e;return expected.test(e.message);});f.report.fail(caught);assert.equal(f.report.data.steps[2].status,'failed');assert(f.report.data.steps.slice(3).every(r=>r.status==='not_executed'));const counts=JSON.parse(readFileSync(join(f.dir,'counts.json')));assert.equal(counts.groups.DIAG.failed,1);assert.equal(counts.groups.B1.failed,0);assert.equal(counts.groups.B1.not_executed,7);}finally{rmSync(f.dir,{recursive:true,force:true});}
  }
});

test('grouped bars restores and reads mode once, retains the primary scene error and refuses cleanup-only failure',()=>{
  const primary=Error('controlled scene'),failure=Error('controlled restore'),readError=Error('controlled readback');
  for(const variant of ['success','restore','read','wrong','observe']){
    const calls=[],values=[];const adb=(...args)=>{calls.push(args);if(args.length===5&&variant==='restore')throw failure;if(args.length===4){if(variant==='read')throw readError;return 'Night mode: '+(variant==='wrong'?'yes':'auto');}return '';};const observe=(name,value)=>{values.push({name,value});if(variant==='observe')throw failure;};
    if(variant==='success'){assert.equal(restoreGroupedNightMode(adb,observe,'auto').status,'passed');}
    else {assert.doesNotThrow(()=>restoreGroupedNightMode(adb,observe,'auto',primary));assert.throws(()=>restoreGroupedNightMode(adb,observe,'auto'),e=>variant==='wrong'?/not restored/.test(e.message):e===(variant==='read'?readError:failure));}
    assert(calls.every(a=>a.slice(0,4).join(' ')==='shell cmd uimode night'));assert.equal(calls.filter(a=>a.length===4).length,variant==='success'?1:2);assert.equal(calls.filter(a=>a.length===5).length,variant==='success'?1:2);
  }
});

test('grouped workflow metadata matches Node and seal rejects wrong attempts selectors Node outputs and active writers before any write',()=>{
  const workflow=readFileSync(new URL('./workflow.py',import.meta.url),'utf8'),a=workflow.indexOf('COVERAGE_DIAGNOSTICS ='),b=workflow.indexOf('\ndef acceptance_b2(',a),functions=workflow.slice(a,b);
  const final=workflow.slice(workflow.indexOf('def acceptance_b2('));assert(final.indexOf('validate_coverage_inner(run, attempt, diagnostic, out, raw)')<final.indexOf("write(out / 'counts.json', counts)"));
  const python=`import json,sys,tempfile,os\nfrom pathlib import Path\nimport re\nx=json.load(sys.stdin)\nwith tempfile.TemporaryDirectory() as d:\n APP=Path(d)/'app';(APP/'scripts').mkdir(parents=True);(APP/'scripts/acceptance-scenarios.json').write_text(json.dumps(x['table']))\n ENV={'NODE_BIN':'/controlled/node'}\n exec(x['functions'],globals())\n run=Path(d)/'run';ev=Path(d)/'evidence';run.mkdir();ev.mkdir()\n metas={s:coverage_metadata(x['table'],s) for s in COVERAGE_DIAGNOSTICS}\n assert coverage_metadata(x['table'],None) is None and coverage_metadata(x['table'],'appearance-short') is None\n inner,outer=coverage_attempt_paths(run,ev,'device-035');inner.mkdir(parents=True);outer.mkdir()\n selector='coverage-short';names=x['table']['diagnostics'][selector]\n entry={'entry':{'command':['bash',str(APP/'scripts/android.sh'),'acceptance',run.name,'--suite','b2','--attempt','device-035','--diagnostic',selector],'writer_exited':True}}\n raw={'suite':'b2-diagnostic','diagnostic':selector,'coverage':metas[selector],'status':'failed','steps':[{'id':n,'status':'not_executed'}for n in names],'entry':{'launched':True,'writer_exited':True,'command':[ENV['NODE_BIN'],str(APP/'scripts/acceptance.mjs'),'b2',str(inner),selector]}}\n good_entry=json.dumps(entry);good_raw=json.dumps(raw);refusals=[]\n reasons={}\n expected_reasons={'attempt':'Outer attempt/selector command mismatch','selector':'Inner selector mismatch','node-output':'Node output/selector mismatch','node-selector':'Node output/selector mismatch','outer-writer':'Outer writer exit unconfirmed','node-writer':'Node writer exit unconfirmed','cases':'Coverage case set mismatch','metadata':'Coverage metadata mismatch'}\n for kind in ['attempt','selector','node-output','node-selector','outer-writer','node-writer','cases','metadata']:\n  entry=json.loads(good_entry);raw=json.loads(good_raw)\n  if kind=='attempt':entry['entry']['command'][7]='device-034'\n  if kind=='selector':raw['diagnostic']='coverage-bars'\n  if kind=='node-output':raw['entry']['command'][3]=str(inner.parent/'device-034')\n  if kind=='node-selector':raw['entry']['command'][4]='coverage-bars'\n  if kind=='outer-writer':entry['entry']['writer_exited']=False\n  if kind=='node-writer':raw['entry']['writer_exited']=False\n  if kind=='cases':raw['steps']=[]\n  if kind=='metadata':raw['coverage']['planned']=33\n  (outer/'raw.json').write_text(json.dumps(entry));(inner/'raw.json').write_text(json.dumps(raw))\n  before={str(p):p.read_bytes()for p in Path(d).rglob('*')if p.is_file()}\n  try:\n   i,o=validate_coverage_seal(run,ev,'device-035',selector);(o/'SHOULD_NOT_WRITE').write_text('bad');raise RuntimeError('accepted '+kind)\n  except AssertionError as e:\n   assert str(e)==expected_reasons[kind],(kind,str(e));refusals.append(kind);reasons[kind]=str(e)\n  assert before=={str(p):p.read_bytes()for p in Path(d).rglob('*')if p.is_file()}\n (outer/'raw.json').write_text(good_entry);(inner/'raw.json').write_text(good_raw)\n assert validate_coverage_seal(run,ev,'device-035',selector)==(inner,outer)\n raw=json.loads(good_raw);raw['entry']={'launched':False,'raw_returncode':None};(inner/'raw.json').write_text(json.dumps(raw));validate_coverage_seal(run,ev,'device-035',selector)\n symlink=ev/'device-entry-036';symlink.symlink_to(outer,target_is_directory=True)\n try:coverage_attempt_paths(run,ev,'device-036');raise RuntimeError('accepted symlink')\n except AssertionError:refusals.append('symlink')\n print(json.dumps({'metas':metas,'refusals':refusals,'writes_after_refusal':0,'reasons':reasons}))\n`;
  const result=JSON.parse(execFileSync('python3',['-c',python],{input:JSON.stringify({table:coverageTable,functions}),encoding:'utf8'}));for(const selector of ['coverage-short','coverage-bars','coverage-b1'])assert.deepEqual(result.metas[selector],JSON.parse(JSON.stringify(actualCoverageMetadata()(coverageTable,selector))));assert.equal(result.refusals.length,9);assert.equal(result.writes_after_refusal,0);console.log('grouped seal refusal results '+JSON.stringify({reasons:result.reasons,writes:result.writes_after_refusal}));
});

async function groupedParentFixture(mode) {
  const dir=mkdtempSync(join(tmpdir(),'grouped-parent-')),report=new AcceptanceRecord(dir,coverageTable.diagnostics['coverage-b1']);
  report.pass('DIAG.real-page-login','controlled login');
  writeFileSync(join(dir,'b1-fixture.json'),JSON.stringify({workspace:'w',channel:'c'}));
  const primary=Error('controlled init failure');let oldClosed=0,newClosed=0,b2Calls=0,caseBodies=0,error;
  const next={close:()=>{newClosed++;}};
  let c={close:()=>{oldClosed++;},evaluate:async()=>{}};
  try {
    await continueAfterRestart({
      suite:'b2',diagnostic:'coverage-b1',report,
      logout:async()=> 'controlled logout',
      record:()=>{throw Error('Ordinary33 record must not run');},
      runB2:async()=>{b2Calls++;throw Error('B2 file chain must not run');},
      releaseParent:()=>{c=null;},selectedB1:coverageTable.B1_affected,
      b1Context:{
        reconnect:async()=>{c=await reconnectWebView(c,(...args)=>args.includes('pidof')?'4242':'',async()=>next);return c;},
        step:(...args)=>report.step(...args),
        observe:groupedB1Observation(report,dir+'/',coverageTable),
      },
      runB1:async(context,selected)=>{
        if(mode==='before-transfer')throw primary;
        const client=await context.reconnect();
        try{
          context.observe('continuation-preconditions.json',{route:mode==='wrong-route'?'#/wrong':'#/chat/w/w/c/c',selectedCases:selected,identity:{activity:1,webViewIdentity:2},freshFixture:true,historicalPassesUsed:false});
          for(const i of selected)await context.step('B1.'+coverageTable.B1[i-1],async()=>{caseBodies++;if(mode==='case-failure')throw primary;return'controlled case';});
        }finally{client.close();}
      },
    });
    report.complete();
  }catch(e){error=e;report.fail(e);}
  finally{c?.close();}
  const raw=JSON.parse(readFileSync(join(dir,'raw.json'))),counts=JSON.parse(readFileSync(join(dir,'counts.json')));
  rmSync(dir,{recursive:true,force:true});
  return{error,primary,raw,counts,oldClosed,newClosed,b2Calls,caseBodies};
}

test('grouped B1 parent path skips all B2 handlers counts readiness separately and transfers connection ownership once',async()=>{
  const r=await groupedParentFixture('success');assert.equal(r.error,undefined);assert.equal(r.b2Calls,0);assert.equal(r.caseBodies,7);assert.equal(r.oldClosed,1);assert.equal(r.newClosed,1);assert.equal(r.counts.planned,10);assert.equal(r.counts.groups.DIAG.passed,3);assert.equal(r.counts.groups.B1.passed,7);assert.equal(r.counts.groups.original12.passed,0);
});

test('grouped B1 parent precondition and body failures keep accurate phase counts and release only their owned connection',async()=>{
  for(const mode of ['before-transfer','wrong-route','case-failure']){const r=await groupedParentFixture(mode);assert.equal(r.b2Calls,0);assert.equal(r.oldClosed,1);assert.equal(r.newClosed,mode==='before-transfer'?0:1);if(mode!=='wrong-route')assert.equal(r.error,r.primary);else assert.match(String(r.error),/route does not match/);assert.equal(r.counts.failed,1);assert.equal(r.counts.groups.B1.failed,mode==='case-failure'?1:0);assert.equal(r.counts.groups.DIAG.failed,mode==='case-failure'?0:1);assert.equal(r.caseBodies,mode==='case-failure'?1:0);assert.equal(r.counts.groups.B1.not_executed,mode==='case-failure'?6:7);}
});

test('short point capture adds finite button identity and geometry without changing the event bound',()=>{
  const f=shortCaptureFixture();f.capture('install');
  const owner={getAttribute:n=>n==='data-pane'?'thread':n==='data-panel'?'side':null};
  const button={tagName:'BUTTON',id:'bottom',getAttribute:n=>({'class':'bottom-class','aria-label':'Scroll to bottom','title':'Bottom','data-pane':'own'}[n]??null),hasAttribute:n=>n==='data-scroll-bottom',getBoundingClientRect:()=>({left:10,top:40,right:40,bottom:70,width:30,height:30}),closest:s=>s==='[data-pane]'||s==='[data-panel]'?owner:null};
  f.emit('contextmenu',{target:button,composedPath:()=>[button]});const e=f.capture().events[0];
  assert.equal(e.target.scrollBottom,true);assert.equal(e.target.label,'Scroll to bottom');assert.equal(e.target.title,'Bottom');assert.equal(e.target.nearestPane,'thread');assert.equal(e.target.nearestPanel,'side');assert.equal(e.target.pane,'own');assert.equal(e.target.pointerEvents,'auto');assert.deepEqual(e.target.rect,{left:10,top:40,right:40,bottom:70,width:30,height:30});assert.equal(e.rowContainsTarget,false);assert.equal(e.scrollerContainsTarget,false);
  f.capture('release');assert.equal(f.listenerCount(),0);
});

test('short point check rejects changed identities or original-point geometry before any right input',async()=>{
  for(const[change,reason]of [
    [f=>f.view.location.hash='#other',/point identity changed/],
    [f=>f.view.performance.timeOrigin=2,/point identity changed/],
    [f=>f.document.getElementById=()=>({...f.row}),/point identity changed/],
    [f=>f.row.querySelector=()=>({...f.body}),/point identity changed/],
    [f=>f.body.getBoundingClientRect=()=>({left:80,top:80,right:100,bottom:100,width:20,height:20}),/outside current geometry/],
    [f=>f.document.elementFromPoint=()=>null,/occluded or belongs to another row/],
  ]){
    const r=await shortContextFixture({checkChange:change});assert.match(String(r.error),reason);assert.equal(r.checkReads,1);assert.equal(r.reads,0);assert.equal(r.inputs.length,0);assert.equal(r.pauses.length,0);
    const check=r.observations.find(o=>o.name.endsWith('-point-check')).value;assert.equal(check.pointCheck.ready,false);assert.match(check.pointCheck.reason,reason);if(check.identityCurrent)assert(check.pointCheck.row.rect);assert.equal(r.f.capture('release').release,'released');assert.equal(r.f.listenerCount(),0);
  }
  const expired=await shortContextFixture({checkCost:30000});assert.match(String(expired.error),/budget exhausted after point check/);assert.equal(expired.checkReads,1);assert.equal(expired.inputs.length,0);expired.f.capture('release');
});

test('short point rejection reaches the original preview finally and releases capture with zero right input',async()=>{
  const f=shortCaptureFixture();
  const helper=runInNewContext('('+shortContextMenu.toString()+')',{assert,shortMenuCapture,messageMenuTarget,Date:{now:()=>1},delay:async()=>{},console});
  const r=await shortPreviewFixture(undefined,true,{menuDocument:f.document,stateDocument:f.document,captureDocument:f.document,shortContextMenu:helper,shortMenuTarget:async()=>{f.capture('install');f.document.elementFromPoint=()=>null;return{ready:true,point:{x:20,y:50}};}});
  assert.match(String(r.error),/occluded or belongs to another row/);assert.equal(r.events.filter(e=>e==='mousePressed'||e==='mouseReleased').length,0);assert.equal(f.listenerCount(),0);
  assert.equal(r.observations.find(o=>o.name==='short-preview-menu-failure').value.capture.release,'released');assert.equal(r.observations.find(o=>o.name==='short-preview-point-check').value.pointCheck.ready,false);
});

function barDocument(theme='studio-light',timeOrigin=1) {
  const rect=()=>({left:0,top:0,width:100,height:30});
  const card={textContent:theme,getBoundingClientRect:rect,closest:()=>null};
  const marker={closest:()=>card};
  const status={textContent:'主题正在保存…',getBoundingClientRect:rect,closest:()=>null};
  return{defaultView:{location:{origin:'https://localhost',href:'https://localhost/#/settings?settingsSection=appearance',hash:'#/settings?settingsSection=appearance'},performance:{timeOrigin},getComputedStyle:()=>({backgroundColor:'rgb(20, 20, 20)'})},documentElement:{dataset:{theme,themePersistence:'confirmed'}},body:{},querySelectorAll:s=>s.includes('Current theme')?[marker]:[status]};
}
function actualBarScreenshot(failure) {
  const source=readFileSync(new URL('./acceptance-b2.mjs',import.meta.url),'utf8'),a=source.indexOf('  const screenshot ='),b=source.indexOf('  const visible =',a),commands=[],writes=[],bytes=Buffer.from('controlled PNG bytes');
  const screenshot=runInNewContext(source.slice(a,b)+'\nscreenshot',{process:{env:{ANDROID_HOME:'/controlled/sdk'}},serial:'controlled-device',out:'/controlled',Date,Number,hash:b=>createHash('sha256').update(b).digest('hex'),execFileSync:(...args)=>{commands.push(args);if(failure)throw failure;return bytes;},writeFileSync:(...args)=>writes.push(args)});
  return{screenshot,commands,writes,sha256:createHash('sha256').update(bytes).digest('hex')};
}

test('bar observations retain fresh DOM card status background and bounded metadata',()=>{
  const document=barDocument('slack-dark');const state=JSON.parse(JSON.stringify(runInNewContext('('+barPageState.toString()+')(document)',{document,Date})));
  assert.equal(state.theme,'slack-dark');assert.equal(state.checkedCards[0].text,'slack-dark');assert.equal(state.statuses[0].text,'主题正在保存…');assert.equal(state.background,'rgb(20, 20, 20)');assert.equal(state.timeOrigin,1);assert.equal(state.checkedCount,1);
  document.querySelectorAll=s=>Array(20).fill(s.includes('Current theme')?{closest:()=>({textContent:'x'.repeat(500),getBoundingClientRect:()=>({}),closest:()=>null})}:{textContent:'x'.repeat(500),getBoundingClientRect:()=>({}),closest:()=>null});
  const bounded=barPageState(document);assert.equal(bounded.checkedCount,20);assert.equal(bounded.checkedCards.length,8);assert.equal(bounded.statuses.length,8);assert.equal(bounded.checkedCards[0].text.length,160);
});

test('bar observations use eight fresh reads and exactly four original PNG commands with timing and byte hashes',async()=>{
  const f=actualBarScreenshot();let reads=0;const observed=[];
  const c={evaluate:async expression=>{reads++;const document=barDocument(reads%2?'old-card':'new-card');return JSON.parse(JSON.stringify(runInNewContext(expression,{document,Date})));}};
  for(let i=0;i<4;i++){
    const r=await observeBarScreenshot(c,(name,value)=>observed.push({name,value}),'bars-'+i,onCommand=>f.screenshot('bars-'+i,onCommand));
    assert.equal(r.identityCurrent,true);assert.equal(r.diagnosticOnly,true);assert.equal(r.screenPresentation,'not_observed');assert.equal(r.before.value.checkedCards[0].text,'old-card');assert.equal(r.after.value.checkedCards[0].text,'new-card');assert.equal(r.sha256,f.sha256);assert.equal(r.command.rawReturncode,0);assert(r.command.startedAt);assert(r.command.finishedAt);
  }
  assert.equal(reads,8);assert.equal(f.commands.length,4);assert.equal(f.writes.length,4);assert(f.commands.every(c=>JSON.stringify(c[1])===JSON.stringify(['-s','controlled-device','exec-out','screencap','-p'])));assert.equal(observed.filter(o=>o.name.endsWith('-dom-before')).length,4);assert.equal(observed.filter(o=>o.name.endsWith('-dom-after')).length,4);
  const normal=actualBarScreenshot();assert.equal(normal.screenshot('normal'),undefined);assert.equal(normal.commands.length,1);assert.equal(normal.writes.length,1);
});

test('bar observations reject replaced documents or unavailable reads after one capture and two reads',async()=>{
  for(const mode of ['identity','route','read','undefined']){
    let reads=0,captures=0;const observations=[];const c={evaluate:async()=>{reads++;if(mode==='read'&&reads===2)throw Error('controlled post read');if(mode==='undefined'&&reads===2)return undefined;const state=barPageState(barDocument('studio-light',mode==='identity'&&reads===2?2:1));if(mode==='route'&&reads===2)state.hash='#other';return state;}};
    await assert.rejects(observeBarScreenshot(c,(name,value)=>observations.push({name,value}),'bars',()=>{captures++;return{file:'one.png',sha256:'controlled'};}),mode==='read'?/DOM observation unavailable/:/identity changed or unavailable/);
    assert.equal(reads,2);assert.equal(captures,1);assert.equal(observations.at(-1).value.identityCurrent,false);
  }
});

test('bar screencap original error survives failed post read and observer while recording command outcome',async()=>{
  const primary=Object.assign(Error('controlled screencap failure'),{status:137,signal:null}),f=actualBarScreenshot(primary);let reads=0;const observations=[];
  const c={evaluate:async()=>{if(++reads===2)throw Error('controlled post projection failure');return barPageState(barDocument());}};
  await assert.rejects(observeBarScreenshot(c,(name,value)=>{observations.push({name,value});throw Error('controlled recorder failure');},'bars',onCommand=>f.screenshot('bars',onCommand)),e=>e===primary);
  assert.equal(reads,2);assert.equal(f.commands.length,1);assert.equal(f.writes.length,0);const command=observations.find(o=>o.name.endsWith('-screencap-command')).value;assert.equal(command.rawReturncode,137);assert.equal(command.signal,null);assert(command.startedAt);assert(command.finishedAt);assert.equal(observations.at(-1).value.after.status,'unknown');
});

function previewDialogFixture(options = {}) {
  const identity = {origin:'https://localhost',href:'https://localhost/#channel',hash:'#channel',timeOrigin:1};
  const attrs = {'role':'dialog','aria-labelledby':'preview-title','data-modal-shell':'','data-image-export-preview':''};
  const box = {x:10,y:20,left:10,top:20,right:390,bottom:280,width:380,height:260};
  const element = (attributes={},text='') => ({isConnected:true,hidden:false,textContent:text,disabled:false,id:'',getAttribute:n=>attributes[n]??null,hasAttribute:n=>n in attributes,closest:()=>null,getBoundingClientRect:()=>box,querySelector:()=>null,querySelectorAll:()=>[],contains(e){return e===this;}});
  const close = element({'aria-label':'Close'},''), other = element({'aria-label':'Close'},'');
  const preview=element(options.unknown?{'role':'dialog'}:attrs,'Image Preview '+ 'x'.repeat(200));
  preview.querySelector=s=>s==='[data-image-export-scroll]'||s==='[data-image-export-actions]'?{}:null;
  preview.querySelectorAll=s=>s==='button'?[close]:s==='button[aria-label="Close"]'?(options.doubleClose?[close,other]:[close]):[];
  preview.contains=e=>e===close||e===preview;
  preview.hidden=!!options.hidden;
  const dialogs=[preview,...Array.from({length:options.extra??0},()=>element({'role':'dialog'},'Unknown'))];
  const view={location:{origin:identity.origin,href:identity.href,hash:identity.hash},performance:{timeOrigin:1},innerWidth:412,innerHeight:291,getComputedStyle:e=>({display:e.hidden?'none':'block',visibility:'visible',opacity:'1',pointerEvents:'auto'})};
  const document={defaultView:view,querySelectorAll:s=>s==='[role="dialog"]'?dialogs:s==='[role="dialog"][data-modal-shell][data-image-export-preview]'?(options.unknown?[]:dialogs.filter(e=>e.hasAttribute('data-image-export-preview'))):s.includes('button')?[close]:[],getElementById:id=>id==='preview-title'?{textContent:'Image Preview'}:null,elementFromPoint:()=>options.occluded?other:close};
  return {document,identity,preview,close,other,view};
}

test('preview dialog metadata retains hidden and unknown totals with bounded identity visibility geometry and labels',()=>{
  const f=previewDialogFixture({extra:5}),r=previewDialogState(f.document);
  assert.equal(r.dialogs,6);assert.equal(r.dialogDetails.length,4);assert.equal(r.dialogsTruncated,true);assert.equal(r.previewReady,true);
  assert.equal(r.dialogDetails[0].title,'Image Preview');assert.equal(r.dialogDetails[0].text.length,160);assert.equal(r.dialogDetails[0].textTruncated,true);
  assert.equal(r.dialogDetails[0].buttons[0].label,'Close');assert.equal(r.dialogDetails[0].viewportIntersection.height,260);
  assert.deepEqual(r.previewIdentity,f.identity);
  for(const options of [{hidden:true},{unknown:true},{doubleClose:true}]){const x=previewDialogState(previewDialogFixture(options).document);assert.equal(x.dialogs,1);assert.equal(x.previewReady,false);}
  const actual=runInNewContext(`(${previewDialogState.toString()})(document)`,{document:f.document});assert.equal(actual.dialogs,6);
});

test('preview Close requires known unique visible preview and same document plus its own real hit',()=>{
  const selector='[role=dialog][data-modal-shell][data-image-export-preview] button[aria-label="Close"]';
  const f=previewDialogFixture();assert.equal(leftControlTarget(f.document,selector,undefined,{route:'#channel',previewIdentity:f.identity}).ready,true);
  for(const [options,change,reason]of [[{unknown:true},null,'preview_identity_unavailable'],[{hidden:true},null,'preview_identity_unavailable'],[{doubleClose:true},null,'preview_close_not_unique'],[{},'timeOrigin','preview_document_changed'],[{occluded:true},null,'occluded']]){
    const x=previewDialogFixture(options);if(change)x.view.performance.timeOrigin=2;
    const r=leftControlTarget(x.document,selector,undefined,{route:'#channel',previewIdentity:x.identity});assert.equal(r.ready,false);assert.equal(r.reason,reason);
  }
});

test('preview committed identity is delivered after POST validation and before DOM errors with capture release retained',async()=>{
  const primary=Error('controlled DOM wait failure'),ids=[];
  const r=await shortPreviewFixture(undefined,true,{domFailure:primary,onCommitted:id=>ids.push(id)});
  assert.equal(r.error,primary);assert.deepEqual(ids,['fixture']);assert.equal(r.inputs.length,0);
  for(const options of [{postFailure:primary},{invalidId:true}]){const received=[];const x=await shortPreviewFixture(undefined,true,{...options,onCommitted:id=>received.push(id)});assert(x.error);assert.deepEqual(received,[]);}
  const staged=[];const good=await shortPreviewFixture(undefined,true,{onPreviewReady:id=>staged.push(id)});assert.equal(good.error,undefined);assert.equal(staged.length,1);assert.equal(staged[0].timeOrigin,1);
});

test('short cleanup never closes an unobserved or unknown preview and keeps the original error and WM restore',async()=>{
  for(const options of [{beforePreview:true},{unknownPreview:true}]){
    const primary=Error('controlled primary before recovery');const r=await shortSceneFixture(primary,options);assert.equal(r.error,primary);
    assert.equal(r.calls.filter(x=>x[0]==='click').length,0);assert.equal(r.height,839);assert.equal(r.deleted,1);
    assert(r.observed.some(x=>x.name==='short-selection-page-restore-error'&&x.value.error.includes('no observed known Image Preview')));
  }
  const primary=Error('controlled before preview without dialog');const r=await shortSceneFixture(primary,{beforePreview:true,noDialog:true,restoredUnknown:true});
  assert.equal(r.error,primary);assert.deepEqual(r.calls.filter(x=>x[0]==='click'),[['click','Cancel']]);
  assert.equal(r.observed.find(x=>x.name==='short-selection-exited').value.messageIdInRead,true);
  assert.equal(r.observed.find(x=>x.name==='short-selection-page-restored').value.dialogs,1);
  assert(r.observed.some(x=>x.name==='short-selection-window-verification-error'));assert.equal(r.height,839);
});

function selectionControlsFixture(options={}) {
  const selector='[role=toolbar][aria-label="Message selection"] button', scrolls=[];
  const box=(x,width)=>({x,y:100,width,height:24,left:x,top:100,right:x+width,bottom:124});
  const node=(label,index)=>({tagName:'BUTTON',id:'control-'+index,textContent:label,parentElement:null,disabled:options.disabled===label,
    getAttribute:n=>n==='aria-label'?label:null,hasAttribute:()=>false,closest:()=>null,getBoundingClientRect:()=>box(index*110+10,100),
    contains(e){return e===this||e===this.child;},scrollIntoView:args=>scrolls.push({label,args})});
  const buttons=['Cancel','Copy markdown','Save image'].map(node);
  for(const button of buttons)button.child={...button,tagName:'SPAN',id:'',parentElement:button,getAttribute:()=>null};
  const foreign=node('foreign',4),bar={...node('toolbar',0),getBoundingClientRect:()=>box(0,400)};
  const view={innerWidth:400,innerHeight:300,location:{hash:'#channel'},getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1',overflowX:'visible',overflowY:'visible'})};
  const document={defaultView:view,querySelectorAll:s=>s===selector?(options.ambiguous?[buttons[0],{...buttons[0]}]:buttons):s==='[role=toolbar][aria-label="Message selection"]'?[bar]:[],
    getElementById:()=>({querySelector:()=>({getAttribute:()=> 'true'})}),elementFromPoint:x=>{
      const button=buttons.find(b=>{const r=b.getBoundingClientRect();return x>=r.x&&x<r.x+r.width;});
      return options.occluded===button?.textContent?foreign:button?.child;
    }};
  return{document,view,buttons,foreign,selector,scrolls};
}

test('control batch projects three actual targets without reading or writing the click identity slot',async()=>{
  const f=selectionControlsFixture();
  Object.defineProperty(f.view,'__b2LeftClickTarget',{configurable:true,get(){assert.fail('batch read click slot');},set(){assert.fail('batch wrote click slot');}});
  const r=await shortPreviewFixture(undefined,true,{controlsDocument:f.document});
  assert.equal(r.error,undefined);assert.deepEqual(f.scrolls.map(x=>x.label),['Cancel','Copy markdown','Save image']);
  const controls=r.observations.find(o=>o.name==='short-selection-controls').value;
  assert.deepEqual(controls.map(x=>[x.text,x.candidateCount,x.ready,x.fatal]),[['Cancel',1,true,false],['Copy markdown',1,true,false],['Save image',1,true,false]]);
  assert.equal(r.inputs.filter(x=>x.type==='mouseWheel').length,1);assert.equal(r.events.filter(x=>x==='Save image').length,1);
  assert.equal(r.layoutReads,2);assert.equal(r.observations.filter(o=>o.name==='short-selection-controls').length,1);
});

test('control batch leaves an existing identity untouched while default clicks still reject another target or replacement',()=>{
  const f=selectionControlsFixture(),guard={route:'#channel',messageId:'fixture',selected:true};
  assert(leftControlTarget(f.document,f.selector,'Cancel',guard).ready);
  const pinned=f.view.__b2LeftClickTarget;
  for(const text of ['Cancel','Copy markdown','Save image'])assert(leftControlTarget(f.document,f.selector,text,guard,false).ready);
  assert.equal(f.view.__b2LeftClickTarget,pinned);
  f.view.__b2LeftClickTarget=f.foreign;
  for(const text of ['Cancel','Copy markdown','Save image'])assert(leftControlTarget(f.document,f.selector,text,guard,false).ready);
  assert.equal(f.view.__b2LeftClickTarget,f.foreign);
  f.view.__b2LeftClickTarget=pinned;
  assert(leftControlTarget(f.document,f.selector,'Cancel',guard).ready);
  assert.equal(leftControlTarget(f.document,f.selector,'Copy markdown',guard).reason,'target_replaced');
  f.buttons[0]={...f.buttons[0]};
  assert.equal(leftControlTarget(f.document,f.selector,'Cancel',guard).reason,'target_replaced');
  assert.equal(f.view.__b2LeftClickTarget,pinned);
});

test('control batch keeps ambiguity disabled and occlusion refusals before Save and original scene recovery',async()=>{
  for(const [options,reason]of [[{ambiguous:true},'target_not_unique'],[{disabled:'Copy markdown'},'disabled'],[{occluded:'Save image'},'occluded']]){
    const f=selectionControlsFixture(options),r=await shortPreviewFixture(undefined,true,{controlsDocument:f.document});
    assert.match(String(r.error),/Short selection action not reachable/);assert(r.observations.find(o=>o.name==='short-selection-controls').value.some(x=>x.reason===reason));
    assert.equal(r.events.includes('Save image'),false);assert.equal(f.view.__b2LeftClickTarget,undefined);
    const restored=await shortSceneFixture(r.error);assert.equal(restored.error,r.error);assert.equal(restored.height,839);assert.equal(restored.toolbar,0);assert.equal(restored.deleted,1);
  }
});

async function checkedControlFixture(mode) {
  const f=selectionControlsFixture(),inputs=[],observations=[],primary=Error('controlled control input'),releaseError=Error('controlled release read');
  let clock=1,reads=0,deletes=0;
  const context={assert,Date:{now:()=>clock},delay:async ms=>{clock+=ms;},console:{error:()=>{}},leftControlTarget};
  const wait=runInNewContext('('+waitLeftControl.toString()+')',context);
  const c={evaluate:async expression=>{
    if(expression==='delete window.__b2LeftClickTarget'){deletes++;if(mode==='input-and-release'&&deletes===2)throw releaseError;return delete f.view.__b2LeftClickTarget;}
    if(expression.startsWith('(function leftControlTarget')){
      reads++;
      if(mode==='replacement'&&reads===2)f.buttons[0]={...f.buttons[0]};
      if(mode==='replacement'||mode==='occluded')f.document.elementFromPoint=()=>f.foreign;
    }
    if(mode==='disabled')f.buttons[0].disabled=true;
    if(mode==='ambiguous')f.document.querySelectorAll=s=>s===f.selector?[f.buttons[0],{...f.buttons[0]}]:[];
    return runInNewContext(expression,{document:f.document,window:f.view});
  },send:async(_method,value)=>{inputs.push(value);if(mode==='input-and-release')throw primary;}};
  const src=readFileSync(new URL('./acceptance-b2.mjs',import.meta.url),'utf8');
  const actual=src.slice(src.indexOf('  async function click('),src.indexOf('  async function go('));
  const click=runInNewContext(actual+'\nclick',{...context,c,waitLeftControl:wait,observe:(name,value)=>observations.push({name,value}),visible:'e=>!e.closest("[inert]")&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0'});
  let error;try{await click(f.selector,'Cancel','control-check',mode==='replacement'||mode==='occluded'?1000:null,{route:'#channel'});}catch(e){error=e;}
  return{f,inputs,observations,error,primary,reads,deletes};
}

test('control click keeps same-target polling replacement and all refusal paths at zero input with final release',async()=>{
  const replaced=await checkedControlFixture('replacement');assert.match(String(replaced.error),/target_replaced/);assert.equal(replaced.reads,2);
  for(const mode of ['replacement','disabled','ambiguous','occluded']){
    const r=mode==='replacement'?replaced:await checkedControlFixture(mode);assert(r.error,mode);assert.equal(r.inputs.length,0);assert.equal(r.deletes,2);assert.equal(r.f.view.__b2LeftClickTarget,undefined);
  }
  const ok=await checkedControlFixture();assert.equal(ok.error,undefined);assert.deepEqual(ok.inputs.map(x=>x.type),['mousePressed','mouseReleased']);assert.equal(ok.deletes,2);
});

test('control click final release failure cannot replace the original input error',async()=>{
  const r=await checkedControlFixture('input-and-release');assert.equal(r.error,r.primary);assert.equal(r.inputs.length,1);assert.equal(r.deletes,2);
});

function linkedDialogFixture(count=1) {
  const f=previewDialogFixture();f.preview.id='known-dialog';
  const links=Array.from({length:count},(_,i)=>{
    const attrs={'id':'trigger-'+i,'aria-controls':'other known-dialog','aria-expanded':'true','aria-haspopup':'dialog','data-message-author':'','data-author-kind':'user','aria-label':'@user'};
    return{tagName:'BUTTON',isConnected:true,hidden:i===1,textContent:'User',getAttribute:n=>attrs[n]??null,closest:()=>null,getBoundingClientRect:()=>({left:20,top:30,right:60,bottom:50,width:40,height:20}),attrs};
  });
  const previous=f.document.querySelectorAll;
  f.document.querySelectorAll=s=>s==='[aria-controls]'?links:previous(s);
  const get=f.preview.getAttribute;f.preview.getAttribute=n=>n==='data-popover-frame'?'info':get(n);
  return{...f,links};
}

test('preview dialog linkage records exact aria-controls tokens and zero or multiple candidates without changing readiness',()=>{
  for(const count of [0,1,2,6]){
    const f=linkedDialogFixture(count),r=JSON.parse(JSON.stringify(runInNewContext('('+previewDialogState.toString()+')(document)',{document:f.document}))),d=r.dialogDetails[0];
    assert.equal(r.dialogs,1);assert.equal(r.previewReady,true);assert.equal(d.popoverFrame,'info');assert.equal(d.triggerCount,count);assert.equal(d.triggers.length,Math.min(count,4));assert.equal(d.triggersTruncated,count>4);
    if(count>1){assert.equal(d.triggers[1].visible,false);assert.equal(d.triggers[0].attributes['data-author-kind'],'user');}
  }
  const f=linkedDialogFixture();f.links[0].attrs['aria-controls']='known-dialog-other';assert.equal(previewDialogState(f.document).dialogDetails[0].triggerCount,0);
  f.preview.id='';assert.equal(previewDialogState(f.document).dialogDetails[0].triggerCount,0);
});

test('preview dialog linkage bounds all new identity values and retains unknown dialog totals',()=>{
  const f=linkedDialogFixture(6);Object.assign(f.links[0].attrs,{'aria-label':'x'.repeat(400),'aria-controls':'known-dialog '+'y'.repeat(400),'data-member-id':'z'.repeat(400)});f.links[0].textContent='t'.repeat(400);
  const get=f.preview.getAttribute;f.preview.getAttribute=n=>n==='data-popover-frame'?'p'.repeat(400):get(n);
  const d=previewDialogState(f.document).dialogDetails[0];assert.equal(d.triggerCount,6);assert.equal(d.triggers.length,4);assert(d.triggersTruncated);assert.equal(d.popoverFrame.length,160);assert(d.popoverFrameTruncated);
  const t=d.triggers[0];assert(t.attributesTruncated);assert.equal(t.attributes['aria-label'].length,160);assert.equal(t.attributes['data-member-id'].length,160);assert.equal(t.text.length,160);assert(t.textTruncated);
  f.preview.hasAttribute=()=>false;const unknown=previewDialogState(f.document);assert.equal(unknown.dialogs,1);assert.equal(unknown.previewReady,false);assert.equal(unknown.dialogDetails[0].triggerCount,6);
});
