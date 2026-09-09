// Run the actual inline Console script in fresh page contexts sharing one origin's
// storage. Browser DOM rendering is exercised separately; this checks credentials,
// request races and lifecycle events without a browser automation dependency.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(
  new URL('../rust/crates/backend-app/src/foundation/operator-console.html', import.meta.url),
  'utf8',
);
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const key = 'silverhand-console-token';
const sharedStorage = new Map([[key, 'legacy-canary']]);
const token = 'memory-only-test-token';

function page() {
  const nodes = new Map();
  const events = new Map();
  const requests = [];
  const element = (id) => {
    if (!nodes.has(id))
      nodes.set(id, {
        value: '',
        hidden: false,
        dataset: {},
        events: {},
        classList: { toggle() {} },
        setAttribute() {},
        removeAttribute() {},
        getAttribute() {
          return '';
        },
        close() {},
        showModal() {},
        focus() {},
        addEventListener(name, fn) {
          this.events[name] = fn;
        },
      });
    return nodes.get(id);
  };
  const context = vm.createContext({
    Intl,
    URLSearchParams,
    AbortController,
    encodeURIComponent,
    location: { hash: '#/overview' },
    history: { replaceState() {} },
    window: {
      addEventListener(name, fn) {
        events.set(name, fn);
      },
      scrollTo() {},
    },
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
    sessionStorage: {
      removeItem(name) {
        sharedStorage.delete(name);
      },
      getItem() {
        assert.fail('must not recover a stored token');
      },
      setItem() {
        assert.fail('must not persist a token');
      },
    },
    localStorage: new Proxy(
      {},
      {
        get() {
          assert.fail('must not use localStorage');
        },
      },
    ),
    document: {
      getElementById: element,
      querySelector: () => element('skip'),
      querySelectorAll: () => [],
    },
    fetch(path, options) {
      return new Promise((resolve) => requests.push({ path, options, resolve }));
    },
  });
  const run = (code) => vm.runInContext(code, context);
  run(source);
  // Rendering details do not affect the credential lifecycle under test.
  run('render = data => { snapshot = data; };');
  return { element, events, requests, run };
}

async function connect(view) {
  const pending = view.run(`load('${token}')`);
  const request = view.requests.at(-1);
  assert.equal(request.options.headers.Authorization, `Bearer ${token}`);
  request.resolve({ ok: true, json: async () => ({}) });
  await pending;
  assert.equal(view.run('currentToken'), token);
  assert.equal(sharedStorage.has(key), false);
}

const first = page();
assert.equal(sharedStorage.has(key), false, 'remove legacy origin storage');
assert.equal(first.requests.length, 0, 'no automatic connection from legacy token');
await connect(first);
first.element('disconnect').events.click();
assert.equal(first.run('currentToken'), '');
assert.equal(first.element('token').value, '');
assert.equal(first.element('content').hidden, true);
assert.equal(first.element('refresh').disabled, true);
assert.equal(sharedStorage.has(key), false);

await connect(first);
first.events.get('pagehide')();
assert.equal(first.run('currentToken'), '', 'clear before back/forward cache');
first.events.get('pageshow')();
assert.equal(first.element('refresh').disabled, true);
const reloaded = page();
assert.equal(reloaded.run('currentToken'), '');
assert.equal(reloaded.requests.length, 0, 'reload must require explicit entry');
assert.equal(sharedStorage.has(key), false, 'same-origin peer sees no credential');

// A response arriving after page exit must not restore credentials, even if the
// transport resolves despite cancellation.
const stale = reloaded.run(`load('${token}')`);
const oldRequest = reloaded.requests.at(-1);
reloaded.events.get('pagehide')();
assert.equal(oldRequest.options.signal.aborted, true);
oldRequest.resolve({ ok: true, json: async () => ({}) });
await stale;
assert.equal(reloaded.run('currentToken'), '');
await connect(reloaded);
reloaded.element('disconnect').events.click();
assert.equal(reloaded.run('currentToken'), '');

// A stale rejection from the previous page must not disconnect a new session.
const staleDenied = reloaded.run(`load('${token}')`);
const deniedRequest = reloaded.requests.at(-1);
reloaded.events.get('pagehide')();
await connect(reloaded);
deniedRequest.resolve({ ok: false, status: 401 });
await staleDenied;
assert.equal(reloaded.run('currentToken'), token);
reloaded.element('disconnect').events.click();

const failed = page();
failed.element('token').value = token;
failed.element('auth').events.submit({ preventDefault() {} });
assert.equal(failed.element('token').value, '', 'clear input before awaiting API');
failed.requests[0].resolve({ ok: false, status: 401 });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(failed.run('currentToken'), '');
assert.equal(sharedStorage.has(key), false);
console.log(
  'PASS: memory-only token, legacy cleanup, explicit reconnect after reload, disconnect/pagehide clearing, late-response cancellation and rejected-input clearing.',
);
