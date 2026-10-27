// Host contracts only; these are not device Search or IME results.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { assertSearchAnswer, resultMatches, imeShown, searchClick, completeSearchRestoration, runB3, b3ScenarioKey } from './acceptance-b3.mjs';
import { AcceptanceRecord } from './acceptance-record.mjs';

import { createRequire } from 'node:module';
import { clickSearchOption } from './acceptance-b3.mjs';
const uiRequire = createRequire(new URL('../../../packages/app-ui/package.json', import.meta.url));
const { Window } = await import(uiRequire.resolve('happy-dom'));
import { Script } from 'node:vm';
import { searchIsolationStateExpression } from './acceptance-b3.mjs';

const target = { id: 'mA', content: 'unique A body', channel: 'cA', workspace: 'w', query: 'uniqueA', channelTitle: 'channel A', workspaceName: 'workspace' };
const absent = { content: 'unique B body' };
const answer = () => ({ results: [{ type: 'message', message: { id: target.id, content: target.content }, conversation: { channel_id: target.channel, workspace: { id: target.workspace } } }], total: 1, identities: { humans: { results: [] }, agents: { results: [] } } });
test('server fixture binds POST id, exact content and both place coordinates', () => {
  assertSearchAnswer(answer(), target);
  for (const change of [a => a.results[0].message.id = 'other', a => a.results[0].message.content = 'other', a => a.results[0].conversation.channel_id = 'other', a => a.results[0].conversation.workspace.id = 'other', a => a.results.push(a.results[0]), a => a.identities.humans.results.push({ id: 'other' })]) {
    const value = answer(); change(value);
    assert.throws(() => assertSearchAnswer(value, target));
  }
});
test('no-match proof rejects content or identity hits and nonzero total', () => {
  const empty = { ...answer(), results: [], total: 0 };
  assertSearchAnswer(empty);
  for (const value of [answer(), { ...empty, total: 1 }, { ...empty, identities: undefined }, { ...empty, identities: { humans: { results: [] }, agents: { results: [{}] } } }]) assert.throws(() => assertSearchAnswer(value));
});
test('UI query result requires unique current row and full fixture context, not a count change', () => {
  const value = { route: '#/chat/search', pageCount: 1, searchInputCount: 1, query: target.query, rowCount: 1, rows: [{ text: 'workspace channel A unique A body' }] };
  assert(resultMatches(value, target, absent));
  for (const delta of [{ route: '#/chat' }, { pageCount: 2 }, { searchInputCount: 2 }, { query: 'old' }, { rowCount: 2 }, { rowsTruncated: true }, { rows: [{ text: 'unique A body' }] }, { rows: [{ text: 'workspace channel A unique A body unique B body' }] }]) assert(!resultMatches({ ...value, ...delta }, target, absent));
});
test('IME visibility follows existing explicit true fields, not focus or keyboard text', () => {
  assert(imeShown('mInputShown=true'));
  assert(imeShown('isInputViewShown=true'));
  assert(!imeShown('mInputShown=false isInputViewShown=false focused=true'));
});

function client({ rejected, changedDocument = false, dispatchError, releaseError } = {}) {
  const calls = [], observations = [];
  let checks = 0, states = 0, releases = 0;
  const c = {
    async evaluate(expression) {
      if (expression.startsWith('delete window.')) {
        calls.push('release');
        if (++releases === 2 && releaseError) throw releaseError;
        return;
      }
      if (expression.includes('function leftControlTarget')) {
        checks++;
        return checks === 2 && rejected ? rejected : { ready: true, fatal: false, point: { x: 20 + checks, y: 30 } };
      }
      states++;
      return { route: '#/chat/search', origin: 'https://localhost', timeOrigin: changedDocument && states === 2 ? 2 : 1 };
    },
    async send(method, params) { calls.push(params); if (dispatchError) throw dispatchError; },
  };
  return { c, calls, observations, observe: (name, value) => observations.push({ name, value }) };
}
test('checked input uses last checked point and releases the existing identity slot', async () => {
  const x = client();
  await searchClick(x.c, x.observe, 'button', 'Search', 'example');
  assert.deepEqual(x.calls.filter(v => typeof v === 'object').map(v => [v.type, v.x, v.y]), [['mousePressed', 22, 30], ['mouseReleased', 22, 30]]);
  assert.equal(x.calls.at(-1), 'release');
});
for (const reason of ['target_replaced', 'occluded', 'disabled', 'target_not_unique']) test('check refusal sends zero input: ' + reason, async () => {
  const x = client({ rejected: { ready: false, fatal: true, reason } });
  await assert.rejects(searchClick(x.c, x.observe, 'button', 'Search', 'example'), new RegExp(reason));
  assert(x.calls.every(v => typeof v === 'string'));
  assert.equal(x.calls.at(-1), 'release');
});
test('document replacement between locator and dispatch sends zero input', async () => {
  const x = client({ changedDocument: true });
  await assert.rejects(searchClick(x.c, x.observe, 'button', 'Search', 'example'), /document changed/);
  assert(x.calls.every(v => typeof v === 'string'));
});
test('dispatch primary survives release failure', async () => {
  const first = Error('controlled dispatch error'), x = client({ dispatchError: first, releaseError: Error('controlled release error') });
  await assert.rejects(searchClick(x.c, x.observe, 'button', 'Search', 'example'), e => e === first);
  assert(x.observations.some(v => v.name.endsWith('-release-error')));
});
test('PRE readiness and five business cases count independently; first failure leaves later cases unexecuted', async () => {
  const out = mkdtempSync(join(tmpdir(), 'b3-record-'));
  try {
    const table = JSON.parse(readFileSync(new URL('./acceptance-scenarios.json', import.meta.url)));
    const selected = table.B3['search-normal'];
    const r = new AcceptanceRecord(out, [...selected.preconditions, ...selected.cases]);
    await r.step(selected.preconditions[0], async () => 'fixture ready');
    await r.step(selected.cases[0], async () => 'entered');
    const original = Error('controlled search mismatch');
    await assert.rejects(r.step(selected.cases[1], async () => { throw original; }));
    r.fail(original);
    const counts = JSON.parse(readFileSync(join(out, 'counts.json')));
    assert.equal(counts.groups.PRE.passed, 1);
    assert.equal(counts.groups.B3.passed, 1);
    assert.equal(counts.groups.B3.failed, 1);
    assert.equal(counts.groups.B3.not_executed, 3);
    assert.equal(r.data.first_error.message, String(original));
    assert.throws(() => r.complete(), /did not execute/);
  } finally { rmSync(out, { recursive: true }); }
});

// Pinned canonical content of ALL pre-B3 keys/subtrees, not just B2's file set.
test('scenario extension preserves every legacy subtree and adds B3 only at the top level', () => {
  const table = JSON.parse(readFileSync(new URL('./acceptance-scenarios.json', import.meta.url)));
  const { B3, ...legacy } = table;
  assert.deepEqual(Object.keys(B3), ['search-normal', 'search-isolation', 'task-read', 'task-read-faults']);
  const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  assert.equal(createHash('sha256').update(JSON.stringify(sorted(B3['search-normal']))).digest('hex'), '40f7aee8adeca2c8945ad270271b23aa977eeed462e816fc60d6bc62dd306356');
  assert.equal(createHash('sha256').update(JSON.stringify(sorted(B3['search-isolation']))).digest('hex'), 'e300bb6699daf14419c8f10b84e04b73c3bb02dd0982b89e718b4d8a8ce8979e');
  assert.equal(createHash('sha256').update(JSON.stringify(sorted(legacy))).digest('hex'), '28f4b2e846e7ec757e8747d397cd7ae4d15ee4876b75dbbbc1bfb82fe52caaed');
});

const restoredChats = { route: '#/chat', layout: 'compact', pageCount: 1, dialogs: 0, toolbars: 0 };
for (const failure of ['none', 'ime', 'identity']) test('final restoration marker gated by all existing assertions: ' + failure, async () => {
  const observations = [];
  let identityReads = 0, captures = 0;
  const run = () => completeSearchRestoration({
    chats: restoredChats, finalIME: { shown: failure === 'ime' }, expectedUserId: 'fixture-user',
    readIdentity: async () => { identityReads++; return { me: { status: 200, bodyText: JSON.stringify({ id: failure === 'identity' ? 'other-user' : 'fixture-user' }) } }; },
    capture: async () => { captures++; },
    observe: (name, value) => observations.push({ name, value }),
  });
  if (failure === 'none') {
    await run();
    assert.equal(captures, 1);
    const markers = observations.filter(v => v.name === 's1-restoration-complete');
    assert.equal(markers.length, 1);
    assert.equal(markers[0].value.native.observedUserId, 'fixture-user');
    assert.equal(markers[0].value.finalIME.shown, false);
  } else {
    await assert.rejects(run(), failure === 'ime' ? /IME remained/ : /identity changed/);
    assert.equal(captures, 0);
    assert(!observations.some(v => v.name === 's1-restoration-complete'));
  }
  assert.equal(identityReads, failure === 'ime' ? 0 : 1, 'Failed IME must preserve original short-circuit/read limit');
});

// Real business function + real void-returning recorder. Only API/DOM/input are
// controlled host dependencies; a temporary adb stub prevents any SDK/device use.
for (const preFails of [false, true]) test('runB3 consumes PRE fixture with real AcceptanceRecord.step: ' + (preFails ? 'PRE failure' : 'PRE success'), { concurrency: false }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'b3-real-step-'));
  const oldPath = process.env.PATH, oldLog = process.env.SILVERHAND_B3_HOST_CAPTURE_LOG;
  try {
    const bin = join(out, 'bin'), captureLog = join(out, 'host-capture-calls.txt');
    mkdirSync(bin);
    writeFileSync(join(bin, 'adb'), '#!/bin/sh\nif [ "$1" = "-s" ] && [ "$3" = "exec-out" ] && [ "$4" = "screencap" ] && [ "$5" = "-p" ] && [ "$#" = 5 ]; then\n  printf "%s\\n" "$*" >> "$SILVERHAND_B3_HOST_CAPTURE_LOG"\n  printf "CONTROLLED_HOST_CAPTURE"\nelse\n  exit 97\nfi\n', { mode: 0o700 });
    process.env.PATH = bin + ':' + oldPath;
    process.env.SILVERHAND_B3_HOST_CAPTURE_LOG = captureLog;
    const selected = JSON.parse(readFileSync(new URL('./acceptance-scenarios.json', import.meta.url))).B3['search-normal'];
    const record = new AcceptanceRecord(out, [...selected.preconditions, ...selected.cases]);
    const preError = Error('controlled PRE API failure'), stop = Error('controlled boundary after query-results');
    const messages = [], channels = [], inputs = [], dispatches = [];
    let workspace, route = '#/chat', query = '';
    const page = () => {
      const match = messages.find(m => m.query === query);
      return { route, layout: 'compact', pageCount: 1, origin: 'https://localhost', timeOrigin: 1,
        searchInputCount: route === '#/chat/search' ? 1 : 0, query, clearDisabled: !query,
        rowCount: match ? 1 : 0, rows: match ? [{ text: [workspace.name, match.channelTitle, match.content].join(' ') }] : [],
        rowsTruncated: false, listText: query ? match ? 'Messages' : 'No matches' : 'Type to search' };
    };
    const c = {
      async evaluate(expression) {
        if (expression.startsWith('delete window.')) return;
        if (expression.includes('function leftControlTarget')) {
          if (expression.includes('Clear search')) throw stop;
          return { ready: true, fatal: false, point: { x: 30, y: 40 } };
        }
        assert(expression.includes('function searchPageState'), 'Unexpected host expression');
        return page();
      },
      async send(method, value) {
        assert.equal(method, 'Input.dispatchMouseEvent');
        dispatches.push(value);
        if (value.type === 'mouseReleased') route = '#/chat/search';
      },
    };
    const api = async (path, method, body) => {
      if (path === '/api/workspaces') {
        if (preFails) throw preError;
        workspace = { id: 'host-workspace', name: body.name };
        return { workspace };
      }
      if (path === '/api/workspaces/host-workspace/channels') {
        const channel = { id: 'host-channel-' + (channels.length + 1), title: body.title };
        channels.push(channel); return { channel };
      }
      const channelId = path.match(/^\/api\/channels\/([^/]+)\/messages$/)?.[1];
      if (channelId && method === 'POST') {
        const message = { id: 'host-message-' + (messages.length + 1), content: body.content, channel: channelId,
          channelTitle: channels.find(row => row.id === channelId).title, query: body.content.split(' ')[0] };
        messages.push(message); return { message };
      }
      assert(path.startsWith('/api/search?'), 'Unexpected host API path');
      const q = new URL('https://fixture.test' + path).searchParams.get('q');
      const match = messages.find(m => m.query === q);
      return { results: match ? [{ type: 'message', message: { id: match.id, content: match.content }, conversation: { channel_id: match.channel, workspace: { id: workspace.id } } }] : [],
        total: match ? 1 : 0, identities: { humans: { results: [] }, agents: { results: [] } } };
    };
    let thrown;
    try {
      await runB3({ c, api, out, token: 'controlled-token', serial: 'emulator-controlled-host',
        fixture: { email: 'controlled@example.test', userId: 'host-user' },
        call: async method => { assert.equal(method, 'authState'); return { me: { status: 200, bodyText: '{"id":"host-user"}' } }; },
        input: async (selector, value) => { inputs.push({ selector, value }); query = value; },
        adb: () => { throw Error('No Android command expected before the controlled boundary'); },
        step: (...args) => record.step(...args), observe: (...args) => record.observe(...args) });
    } catch (error) { thrown = error; record.fail(error); }
    assert.equal(thrown, preFails ? preError : stop, 'Must reach the intended boundary through the real void step contract');
    assert.equal(record.data.first_error.message, String(thrown));
    if (preFails) {
      assert.equal(record.data.steps[0].status, 'failed');
      assert(record.data.steps.slice(1).every(row => row.status === 'not_executed'));
      assert.equal(dispatches.length, 0, 'Failed PRE must not click Search');
      assert.equal(inputs.length, 0);
    } else {
      const pre = record.data.steps[0], business = record.data.steps[2];
      assert.equal(pre.status, 'passed');
      assert.equal(record.data.steps[1].status, 'passed');
      assert.equal(business.status, 'passed');
      assert.deepEqual(inputs.map(row => row.value), [pre.detail.a.query, pre.detail.b.query]);
      assert.deepEqual(inputs.map(row => row.value), messages.map(row => row.query));
      assert.deepEqual(business.detail.serverIds, pre.detail.targets.map(row => row.id));
      assert.deepEqual(business.detail.serverIds, ['host-message-1', 'host-message-2']);
      assert.equal(pre.detail.a.channel, channels[0].id);
      assert.equal(pre.detail.b.channel, channels[1].id);
      assert.equal(dispatches.length, 2, 'One checked Search press/release only');
      assert.equal(record.data.steps[3].status, 'failed', 'Explicit host boundary stops at empty-clear');
      assert(record.data.steps.slice(4).every(row => row.status === 'not_executed'));
    }
    const captures = readFileSync(captureLog, 'utf8').trim().split('\n');
    assert.equal(captures.length, preFails ? 1 : 3);
    assert(captures.every(line => line === '-s emulator-controlled-host exec-out screencap -p'));
    if (process.env.SILVERHAND_B3_HOST_EVIDENCE) {
      mkdirSync(process.env.SILVERHAND_B3_HOST_EVIDENCE, { recursive: true });
      writeFileSync(join(process.env.SILVERHAND_B3_HOST_EVIDENCE, preFails ? 'real-step-pre-failure.json' : 'real-step-success.json'),
        JSON.stringify({ scope: 'controlled host only; real runB3 and AcceptanceRecord.step; no real API/SDK/device',
          raw: record.data, inputCalls: inputs, dispatches, captureCalls: captures, intentionalBoundary: String(thrown) }, null, 2),
        { flag: 'wx', mode: 0o600 });
    }
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldLog === undefined) delete process.env.SILVERHAND_B3_HOST_CAPTURE_LOG; else process.env.SILVERHAND_B3_HOST_CAPTURE_LOG = oldLog;
    rmSync(out, { recursive: true });
  }
});

import http from 'node:http';
import { SearchControl, proxyHandler } from './acceptance-server.mjs';

const hostQuery = 'b3s2host00000000';
async function proxyControlFixture(fn, { active = true, budget = 1000, delay = 0, body = 'real upstream bytes' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'b3-proxy-host-'));
  const file = join(dir, 'control.json'), log = join(dir, 'events.jsonl');
  const spec = { version: 1, unit: 'search-isolation', attempt: 'device-003', active,
    users: ['A'], queries: [hostQuery, hostQuery + 'b'], rules: [], release: [], retry: [] };
  const save = () => { writeFileSync(file + '.tmp', JSON.stringify(spec), { mode: 0o600 }); renameSync(file + '.tmp', file); };
  save();
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === '/api/me') { res.setHeader('Content-Type', 'application/json'); res.end('{"id":"A"}'); return; }
    setTimeout(() => { if (!res.destroyed) { res.setHeader('x-fixture', 'unchanged'); res.end(body); } }, delay);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const control = active ? new SearchControl(file, log, { maxBudgetMs: budget }) : null;
  const server = http.createServer(proxyHandler({ port: upstream.address().port, control }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const request = (path, headers = { authorization: 'Bearer controlled-only-secret' }) => fetch(url + path, { headers });
  const search = (q = hostQuery, extra = '') => '/api/search?include_identities=true&limit=100&q=' + q + extra;
  const rows = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
  const wait = async predicate => {
    for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw Error('Controlled host event boundary not reached');
  };
  try { await fn({ spec, save, request, search, rows, control, seen, wait, url }); }
  finally {
    control?.close(); server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
    rmSync(dir, { recursive: true, force: true });
  }
}
function hostRule(kind = 'hold') { return { id: 'fixture-once', kind, userId: 'A', params: { q: hostQuery, include_identities: 'true', limit: '100' } }; }

test('S2 disabled proxy retains transparent HTTP bytes/headers', async () => proxyControlFixture(async f => {
  const response = await f.request(f.search());
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-fixture'), 'unchanged');
  assert.equal(await response.text(), 'real upstream bytes'); assert.equal(f.rows().length, 0);
}, { active: false }));

test('S2 requires real me session binding and exact parameters', async () => proxyControlFixture(async f => {
  f.spec.rules = [hostRule()]; f.save();
  assert.equal((await f.request(f.search())).status, 200, 'Unbound request must remain transparent');
  await f.request('/api/me');
  assert.equal((await f.request(f.search(hostQuery, '&workspace_id=other'))).status, 200);
  assert.equal((await f.request(f.search(hostQuery + 'b'))).status, 200);
  assert.equal(f.control.pending.size, 0); assert.equal(f.control.uses.size, 0);
  assert(f.rows().some(r => r.event === 'session_unbound'));
  assert(!JSON.stringify(f.rows()).includes('controlled-only-secret'), 'Raw bearer must never enter events');
}));

test('S2 holds real A bytes while independent B completes then releases once', async () => proxyControlFixture(async f => {
  await f.request('/api/me'); f.spec.rules = [hostRule()]; f.save();
  const old = f.request(f.search());
  await f.wait(() => f.rows().some(r => r.event === 'upstream_end'));
  assert.equal(await (await f.request(f.search(hostQuery + 'b'))).text(), 'real upstream bytes');
  f.spec.release = ['fixture-once']; f.save();
  const reply = await old; assert.equal(await reply.text(), 'real upstream bytes');
  await f.wait(() => f.control.pending.size === 0);
  const events = f.rows(), received = events.filter(r => r.event === 'received');
  assert.equal(received.length, 2); assert.notEqual(received[0].request_id, received[1].request_id);
  assert.equal(events.filter(r => r.event === 'release').length, 1);
  assert.equal(events.filter(r => r.event === 'downstream_finish').length, 2);
  assert.equal(f.control.pending.size, 0);
}));

test('S2 two explicit HTTP503 attempts then reviewed Retry forwards real upstream', async () => proxyControlFixture(async f => {
  await f.request('/api/me'); f.spec.rules = [hostRule('error')]; f.save();
  const first = f.request(f.search());
  await f.wait(() => f.rows().some(r => r.event === 'synthetic_fault'));
  f.spec.release = ['fixture-once']; f.save();
  assert.equal((await first).status, 503);
  const automatic = await f.request(f.search()); assert.equal(automatic.status, 503);
  assert.deepEqual(await automatic.json(), { error: 's2_fixture_http_failure' });
  f.spec.retry = ['fixture-once']; f.save();
  const retry = await f.request(f.search()); assert.equal(retry.status, 200);
  assert.equal(await retry.text(), 'real upstream bytes');
  assert.equal(f.seen.filter(url => url.startsWith('/api/search')).length, 1);
  assert.equal(f.rows().filter(r => r.event === 'received').length, 3);
  assert.equal(f.rows().filter(r => r.event === 'synthetic_fault').length, 2);
  assert.equal(f.control.pending.size, 0);
}));

test('S2 unarmed third request is control failure rather than product error', async () => proxyControlFixture(async f => {
  await f.request('/api/me'); f.spec.rules = [hostRule('error')]; f.spec.release = ['fixture-once']; f.save();
  await f.request(f.search()); await f.request(f.search());
  assert.equal((await f.request(f.search())).status, 502);
  assert(f.rows().some(r => r.event === 'control_failure' && r.reason === 'unexpected_request'));
  assert.equal(f.control.pending.size, 0);
}));

test('S2 total receive budget includes slow upstream and leaves no held response', async () => proxyControlFixture(async f => {
  await f.request('/api/me'); f.spec.rules = [hostRule()]; f.save();
  assert.equal((await f.request(f.search())).status, 502);
  const failed = f.rows().find(r => r.event === 'control_failure');
  assert.equal(failed.reason, 'total_budget_exceeded'); assert(failed.elapsedMs >= 45);
  assert.equal(f.control.pending.size, 0);
}, { budget: 50, delay: 100 }));

test('S2 client disconnect is distinct from explicit release and clears pending', async () => proxyControlFixture(async f => {
  await f.request('/api/me'); f.spec.rules = [hostRule()]; f.save();
  const request = http.get(f.url + f.search(), { headers: { authorization: 'Bearer controlled-only-secret' } });
  request.on('error', () => {});
  await f.wait(() => f.rows().some(r => r.event === 'upstream_end'));
  request.destroy();
  await f.wait(() => f.control.pending.size === 0);
  assert(f.rows().some(r => r.event === 'client_disconnect'));
  assert(!f.rows().some(r => r.event === 'release'));
}));

test('S2 shutdown after failure releases all held ownership', async () => proxyControlFixture(async f => {
  await f.request('/api/me'); f.spec.rules = [hostRule()]; f.save();
  const pending = f.request(f.search());
  await f.wait(() => f.control.pending.size === 1);
  f.control.close(); assert.equal((await pending).status, 502);
  assert.equal(f.control.pending.size, 0);
  assert(f.rows().some(r => r.event === 'control_failure' && r.reason === 'proxy_shutdown'));
}));

test('S2 body bound fails the control without leaking held response', async () => proxyControlFixture(async f => {
  await f.request('/api/me'); f.spec.rules = [hostRule()]; f.save();
  assert.equal((await f.request(f.search())).status, 502);
  assert(f.rows().some(r => r.event === 'control_failure' && r.reason === 'body_budget_exceeded'));
  assert.equal(f.control.pending.size, 0);
}, { body: 'x'.repeat(1048577) }));

// Real runB3/void step, actual serialized state and actual checked click.
// API transport is a strict fixture model of the two membership gates.
for (const mode of ['pre-success', 'signup-failure', 'missing-channel-member']) test('S2 strict PRE and real serialized state: ' + mode, { concurrency: false }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'b3-s2-strict-'));
  const oldPath = process.env.PATH;
  const window = new Window({ url: 'https://localhost/#/chat' });
  try {
    const bin = join(out, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'adb'), '#!/bin/sh\nprintf CONTROLLED_HOST_CAPTURE\n', { mode: 0o700 });
    process.env.PATH = bin + ':' + oldPath;
    const spec = { version: 1, unit: 'search-isolation', attempt: 'device-004', active: false, users: [], queries: [], rules: [], release: [], retry: [] };
    const controlFile = join(out, 's2-control.json'), eventsFile = join(out, 's2-proxy-events.jsonl');
    writeFileSync(controlFile, JSON.stringify(spec));
    const table = JSON.parse(readFileSync(new URL('./acceptance-scenarios.json', import.meta.url))).B3['search-isolation'];
    const record = new AcceptanceRecord(out, [...table.preconditions, ...table.cases]);
    const preError = Error('S2 controlled signup failure'), forbidden = Error('S2 fixture POST HTTP403: channel membership required'), stop = Error('S2 host stop at first business input');
    const inputs = [], dispatches = [], messages = [], places = [], apiCalls = [], stateReads = [];
    const { document } = window;
    document.documentElement.dataset.layout = 'compact';
    document.body.innerHTML = '<div data-page><aside data-sidebar="workspaces"><button>Search</button></aside></div>';
    const button = document.querySelector('button');
    button.getBoundingClientRect = () => ({ x: 10, y: 20, width: 100, height: 30 });
    document.elementFromPoint = () => button;
    const c = {
      async evaluate(expression) {
        new Script(expression); // Compile the exact expression sent by actual runS2.
        const answer = window.eval(expression);
        if (expression.includes('allSearchLists:')) stateReads.push({ route: answer.route, allSearchLists: answer.allSearchLists, query: answer.query });
        return answer;
      },
      async send(method, value) {
        dispatches.push(value);
        if (value.type === 'mouseReleased') {
          window.location.hash = '#/chat/search';
          document.body.innerHTML = '<div data-page><input placeholder="Search people, agents, messages, channels"><button aria-label="Clear search" disabled>Clear</button><div class="search-list">Type to search</div></div>';
        }
      },
    };
    const principal = token => { assert(['controlled-A','controlled-B'].includes(token)); return token === 'controlled-A' ? 'A' : 'B'; };
    const api = async (path, method, body, auth) => {
      if (path === '/auth/signup') { if (mode === 'signup-failure') throw preError; return { user: { id: 'B' }, user_token: 'controlled-B' }; }
      const user = principal(auth);
      apiCalls.push({ path, method, user, body });
      if (path === '/api/workspaces') {
        const w = { id: 'W' + places.length, name: body.name, owner: user, members: [user, ...body.member_user_ids] };
        places.push(w); return { workspace: w };
      }
      const place = places.find(p => path === '/api/workspaces/' + p.id + '/channels');
      if (place) {
        assert(place.members.includes(user));
        assert(Array.isArray(body.member_user_ids), 'Actual PRE must explicitly carry channel users');
        assert(body.member_user_ids.every(id => place.members.includes(id)), 'Channel members must belong to workspace');
        place.channel = 'C' + place.id; place.title = body.title;
        place.channelMembers = [user, ...body.member_user_ids.filter(id => mode !== 'missing-channel-member' || id !== 'B')];
        return { channel: { id: place.channel, title: place.title } };
      }
      const target = places.find(p => path === '/api/channels/' + p.channel + '/messages');
      if (target) {
        if (!target.members.includes(user) || !target.channelMembers.includes(user)) throw forbidden;
        const m = { id: 'M' + messages.length, content: body.content, created_at: Date.now(), owner: target.owner, from_user_id: user };
        messages.push(m); return { message: m };
      }
      assert(path.startsWith('/api/search?'));
      const q = new URL('https://localhost' + path).searchParams.get('q');
      return { results: messages.filter(m => m.content.includes(q) && (!m.content.includes('private') || m.owner === user)).map(message => ({ message })) };
    };
    let thrown;
    try {
      await runB3({ unit: 'search-isolation', c, api, out, token: 'controlled-A', serial: 'host-only', fixture: { userId: 'A' },
        call: async () => {
          const live = JSON.parse(readFileSync(controlFile));
          if (live.users.includes('A')) writeFileSync(eventsFile, JSON.stringify({ at: Date.now(), event: 'me_bound', userId: 'A', sessionDigest: 'host' }) + '\n');
          return { me: { status: 200, bodyText: '{"id":"A"}' } };
        },
        input: async (selector, value) => { inputs.push({ selector, value }); throw stop; },
        adb: () => { throw Error('No SDK call at this host boundary'); },
        step: (...args) => record.step(...args), observe: (...args) => record.observe(...args),
      });
    } catch (error) { thrown = error; record.fail(error); }
    const expected = mode === 'pre-success' ? stop : mode === 'signup-failure' ? preError : forbidden;
    assert.equal(thrown, expected); assert.equal(record.data.first_error.message, String(expected));
    if (mode !== 'pre-success') {
      assert.equal(record.data.steps[0].status, 'failed');
      assert.equal(inputs.length, 0); assert.equal(dispatches.length, 0);
      assert(record.data.steps.slice(1).every(row => row.status === 'not_executed'));
      if (mode === 'missing-channel-member') {
        assert(places[0].members.includes('B') && !places[0].channelMembers.includes('B'));
        assert.equal(apiCalls.at(-1).user, 'B'); assert.equal(messages.length, 5);
      }
    } else {
      const pre = record.data.steps[0]; assert.equal(pre.status, 'passed');
      assert.equal(inputs[0].value, pre.detail.q.error);
      assert.deepEqual(places[0].members, ['A','B']); assert.deepEqual(places[0].channelMembers, ['A','B']);
      for (const label of ['privateA','privateB']) {
        const place = places.find(p => p.name.includes(label)); const owner = label === 'privateA' ? 'A' : 'B';
        assert.deepEqual(place.members, [owner]); assert.deepEqual(place.channelMembers, [owner]);
      }
      for (const [key,user] of [['filterA','A'],['filterB','B'],['accountA','A'],['accountB','B']])
        assert.equal(messages.find(m => m.id === pre.detail[key].id).from_user_id, user);
      const manifest = JSON.parse(readFileSync(controlFile));
      assert.equal(manifest.rules[0].params.q, pre.detail.q.error); assert.equal(manifest.rules[0].userId, 'A');
      assert.equal(dispatches.length, 2); assert.equal(record.data.steps[1].status, 'failed');
      assert(record.data.steps.slice(2).every(row => row.status === 'not_executed'));
    }
    assert(stateReads.length >= (mode === 'pre-success' ? 4 : 2), 'Actual normal/catch/finally state must execute');
    const observations = record.data.observations;
    assert(observations.some(o => o.name === 's2-failure-state'));
    assert(observations.some(o => o.name === 's2-reference-release' && o.value.status === 'released'));
    assert(!observations.some(o => ['s2-failure-observation-error','s2-reference-release-error'].includes(o.name)));
    assert(!observations.some(o => o.name === 's2-restoration-complete'), 'Early host stop cannot claim final page/IME/identity restoration');
    assert.equal(JSON.parse(readFileSync(controlFile)).releaseAll, true); assert.equal(JSON.parse(readFileSync(controlFile)).active, false);
    if (process.env.SILVERHAND_S2_HOST_EVIDENCE) {
      mkdirSync(process.env.SILVERHAND_S2_HOST_EVIDENCE, { recursive: true });
      writeFileSync(join(process.env.SILVERHAND_S2_HOST_EVIDENCE, mode + '.json'), JSON.stringify({ scope: 'host actual runB3/record/serialized DOM state; strict API model; stops before actual first HTTP business input', raw: record.data, inputs, dispatches, stateReads, fixturePlaces: places, messageAuthors: messages.map(m => ({ id: m.id, from_user_id: m.from_user_id })), apiCalls }, null, 2));
    }
  } finally { process.env.PATH = oldPath; await window.happyDOM.close(); rmSync(out, { recursive: true, force: true }); }
});

test('S2 exact serialized state reads controlled DOM fields without preset projection', async () => {
  const window = new Window({ url: 'https://localhost/#/chat/search' });
  try {
    const { document } = window; document.documentElement.dataset.layout = 'compact';
    document.body.innerHTML = '<div data-page><input placeholder="Search people, agents, messages, channels" value="current"><div class="search-list">Only current</div><div role="status" aria-label="Loading search results"></div><div role="alert">Search failed.</div><button data-filter-toggle aria-expanded="true"></button><button aria-label="Project filter">W</button></div><div data-page inert><div class="search-list">Kept old</div></div>';
    const expression = searchIsolationStateExpression(); new Script(expression); const value = window.eval(expression);
    assert.equal(value.query, 'current'); assert.equal(value.loading, true); assert.equal(value.alert, 'Search failed.');
    assert.equal(value.pageCount, 1); assert.equal(value.allSearchLists, 2); assert.equal(value.hiddenSearchLists, 1);
    assert.equal(value.listText, 'Only current'); assert.equal(value.filterExpanded, 'true');
    assert.equal(value.filterLabels[0].text, 'W'); assert.equal(value.route, '#/chat/search');
  } finally { await window.happyDOM.close(); }
});

test('S2 invalid manifest cannot mutate an armed rule or inject a fault', async () => proxyControlFixture(async f => {
  await f.request('/api/me'); f.spec.rules = [hostRule()]; f.save(); f.control.read();
  f.spec.rules[0].params.q = hostQuery + 'b'; f.save();
  assert.equal((await f.request(f.search(hostQuery + 'b'))).status, 200);
  assert(f.rows().some(r => r.event === 'manifest_refused'));
  assert.equal(f.control.pending.size, 0); assert.equal(f.control.uses.size, 0);
}));

// Actual DOM query/label resolution and original click helper execute here.
// Happy DOM has no layout engine: rectangle/hit are controlled host inputs,
// while IDs, ARIA ownership, selectors and node identity use actual DOM nodes.
for (const mode of ['valid-no-option-id', 'missing-relation', 'unresolved-label', 'multiple-labels', 'duplicate-label-id', 'ambiguous-option', 'shared-label', 'disabled', 'occluded', 'target-replaced']) {
  test('S2 actual option relation and checked click: ' + mode, async () => {
    const window = new Window({ url: 'https://fixture.test/#/chat/search' });
    try {
      const { document } = window;
      document.documentElement.dataset.layout = 'compact';
      document.body.innerHTML = '<div data-page><input placeholder="Search people, agents, messages, channels"><div class="search-list"></div></div>' +
        '<div role="listbox"><div role="option" aria-labelledby="radix-:r11:"><span id="radix-:r11:"><span class="truncate">S2 project A</span></span></div></div>';
      let option = document.querySelector('[role=option]');
      const text = document.getElementById('radix-:r11:');
      assert.equal(option.id, '', 'Real Radix shape has no option ID');
      if (mode === 'missing-relation') option.removeAttribute('aria-labelledby');
      if (mode === 'unresolved-label') option.setAttribute('aria-labelledby', 'not-present');
      if (mode === 'multiple-labels') option.setAttribute('aria-labelledby', 'radix-:r11: second-id');
      if (mode === 'duplicate-label-id') option.insertAdjacentHTML('beforeend', '<span id="radix-:r11:">S2 project A</span>');
      if (mode === 'ambiguous-option') option.parentElement.insertAdjacentHTML('beforeend', '<div role="option" aria-labelledby="second-id"><span id="second-id">S2 project A</span></div>');
      if (mode === 'shared-label') option.parentElement.insertAdjacentHTML('beforeend', '<div role="option" aria-labelledby="radix-:r11:"></div>');
      if (mode === 'disabled') option.setAttribute('data-disabled', '');
      const box = () => ({ x: 10, y: 20, width: 200, height: 30, top: 20, left: 10, bottom: 50, right: 210 });
      option.getBoundingClientRect = box; text.getBoundingClientRect = box;
      let scrollCalls = 0; option.scrollIntoView = () => { scrollCalls++; };
      document.elementFromPoint = () => mode === 'occluded' ? document.body : option.firstElementChild;
      const dispatches = [], observations = [];
      let checks = 0;
      const c = {
        async evaluate(expression) {
          if (expression.includes('function leftControlTarget') && ++checks === 2 && mode === 'target-replaced') {
            const replacement = option.cloneNode(true); replacement.getBoundingClientRect = box;
            replacement.firstElementChild.getBoundingClientRect = box;
            option.replaceWith(replacement); option = replacement;
          }
          return window.eval(expression);
        },
        async send(method, value) { dispatches.push({ method, value }); },
      };
      const observe = (name, value) => observations.push({ name, value });
      let error;
      try { await clickSearchOption(c, observe, (selector, exactText, name) => searchClick(c, observe, selector, exactText, name), 'S2 project A', 'host-option'); }
      catch (value) { error = value; }
      if (mode === 'valid-no-option-id') {
        assert.equal(error, undefined);
        assert.equal(scrollCalls, 1);
        assert.equal(checks, 2, 'Original locator and same-node recheck both execute');
        assert.deepEqual(dispatches.map(row => row.value.type), ['mousePressed', 'mouseReleased']);
        assert(observations.some(row => row.name === 'host-option-check' && row.value.ready && row.value.candidateCount === 1));
        assert(observations[0].value.selector.includes('aria-labelledby'));
      } else {
        assert(error, mode + ' must refuse');
        assert.equal(dispatches.length, 0, 'Invalid relation or original guard must send zero input');
        if (['disabled','occluded','target-replaced'].includes(mode)) assert.match(String(error), /B3 click/);
        else assert.match(String(error), /S2 option identity unavailable/);
      }
      assert.equal(window.__b2LeftClickTarget, undefined, 'Original click reference release retained');
      if (process.env.SILVERHAND_S2_OPTION_EVIDENCE) {
        mkdirSync(process.env.SILVERHAND_S2_OPTION_EVIDENCE, { recursive: true });
        writeFileSync(join(process.env.SILVERHAND_S2_OPTION_EVIDENCE, mode + '.json'), JSON.stringify({ scope: 'host actual DOM/parse/click; controlled geometry/hit; no React or device selected-state credit',
          optionOwnId: option.id, mode, observations, dispatches, checks, scrollCalls, error: error ? String(error) : null }, null, 2));
      }
    } finally { await window.happyDOM.close(); }
  });
}

// Execute the production S2 wait/catch/finally statements and CDP expression.
// Clock/transport/DOM are controlled host fixtures; no full account/device credit.
for (const mode of ['root-then-form', 'root-until-deadline', 'same-document-form', 'other-cdp-error'])
  test('S2 signed-out actual expression and original wait: ' + mode, async () => {
    const window = new Window({ url: 'https://localhost/' });
    try {
      const source = readFileSync(new URL('./acceptance-b3.mjs', import.meta.url), 'utf8');
      const s2 = source.slice(source.indexOf('export async function runS2('));
      const wait = s2.slice(s2.indexOf('  async function until('), s2.indexOf('  const inputValue ='));
      const signedOut = s2.match(/^      const signedOut = .*;$/m)?.[0];
      const handlers = s2.slice(s2.indexOf('  } catch (error) {', s2.indexOf("    await clear('s2-final-clear')")), s2.lastIndexOf('\n}'));
      assert(signedOut?.includes('waitForRoot: true') && wait.includes('i <= 100') && handlers.includes('s2-reference-release'));
      const { document } = window, root = document.documentElement;
      root.dataset.layout = 'compact';
      document.body.innerHTML = '<form data-auth-form><input id="auth-email"></form>';
      const before = { timeOrigin: window.performance.timeOrigin - (mode === 'same-document-form' ? 0 : 1) };
      if (mode !== 'same-document-form') root.remove();
      let now = 0, reads = 0, budgetChecks = 0, captures = 0;
      const observations = [], samples = [], writes = [];
      const originalError = Error('controlled unrelated CDP exception');
      const c = { async evaluate(expression) {
        new Script(expression);
        if (expression.includes("readiness:'not_ready'")) {
          reads++; now += 2;
          if (mode === 'other-cdp-error' && reads === 2) {
            document.appendChild(root); throw originalError;
          }
          if (mode === 'root-then-form' && reads === 3) document.appendChild(root);
        }
        const value = window.eval(expression);
        if (expression.includes("readiness:'not_ready'")) samples.push(JSON.parse(JSON.stringify(value)));
        return value;
      } };
      const observe = (name, value) => observations.push({ name, value });
      const clock = { now: () => now };
      const body = `(async()=>{let primary;${wait}\ntry {${signedOut}\nreturn signedOut;${handlers}\n})()`;
      const script = new Script(body);
      let result, thrown;
      try {
        result = await script.runInNewContext({
          c, before, searchIsolationStateExpression, observe, start: 0, operations: 0,
          Date: clock, setTimeout: (fn, delay) => { assert(delay >= 0 && delay <= 100); now += delay; fn(); },
          budget: () => { budgetChecks++; assert(now < 240000); },
          events: () => [], save: value => writes.push(JSON.parse(JSON.stringify(value))),
          state: () => c.evaluate(searchIsolationStateExpression()),
          capture: async () => { captures++; }, controlError: message => Error(message),
        });
      } catch (error) { thrown = error; }
      assert.equal(observations.some(o => o.name === 's2-restoration-complete'), false);
      assert.deepEqual(writes, [{ releaseAll: true, active: false }]);
      if (mode === 'root-then-form') {
        assert.equal(thrown, undefined); assert.equal(reads, 3);
        assert.equal(result.authForm, true); assert.equal(result.authEmailCount, 1);
        assert.notEqual(result.timeOrigin, before.timeOrigin);
        assert.deepEqual(samples.slice(0, 2), Array(2).fill({ readiness: 'not_ready', reason: 'document_root_missing' }));
        assert.equal(observations.find(o => o.name === 's2-signed-out-new-document-first').value.readiness, 'not_ready');
        assert.equal(observations.find(o => o.name === 's2-signed-out-new-document').value.reads, 3);
      } else {
        assert(thrown);
        assert(!observations.some(o => o.name === 's2-signed-out-new-document'));
        assert.equal(observations.find(o => o.name === 's2-failure-classification').value.error, String(thrown));
        if (mode === 'other-cdp-error') {
          assert.equal(thrown, originalError, 'Unrelated CDP exception must not become not-ready or deadline');
          assert.equal(reads, 2); assert.equal(captures, 1);
          assert(!observations.some(o => o.name === 's2-reference-release-error'));
        } else {
          assert.match(String(thrown), /S2 condition deadline: s2-signed-out-new-document/);
          assert(now >= 10000 && now < 10100, 'Original ten-second deadline is not extended');
          assert(reads <= 100); assert.equal(budgetChecks, reads + 1); // Original finally wait also checks budget.
          if (mode === 'root-until-deadline') {
            assert(samples.every(v => v.readiness === 'not_ready' && Object.keys(v).length === 2));
            assert.equal(observations.find(o => o.name === 's2-signed-out-new-document-last').value.reason, 'document_root_missing');
            assert(observations.some(o => o.name === 's2-reference-release-error'));
          } else {
            assert(samples.every(v => v.authForm && v.timeOrigin === before.timeOrigin));
          }
        }
      }
      if (process.env.SILVERHAND_S2_ROOT_EVIDENCE) {
        mkdirSync(process.env.SILVERHAND_S2_ROOT_EVIDENCE, { recursive: true });
        writeFileSync(join(process.env.SILVERHAND_S2_ROOT_EVIDENCE, mode + '.json'), JSON.stringify({
          scope: 'host extracted actual S2 wait/account call/catch/finally plus actual CDP expression; controlled DOM/time/transport; not full runB3 or device account coverage',
          mode, reads, elapsedMs: now, budgetChecks, captures, samples, observations, writes,
          result, error: thrown ? String(thrown) : null, originalOtherErrorPreserved: mode === 'other-cdp-error' ? thrown === originalError : null,
          sourceStatementsSha256: createHash('sha256').update(wait + signedOut + handlers).digest('hex'),
        }, null, 2));
      }
    } finally { await window.happyDOM.close(); }
  });

import { searchInput, searchSelector } from './acceptance-b3.mjs';

// Full production runB3/real record. Only external UI, bridge/backend, SDK and
// geometry are controlled. A real local SearchControl/proxy handles each request.
// This verifies driver integration, not React/native/product account isolation.
for (const mode of ['direct-login', 'signup-to-login', 'missing-form', 'ambiguous-form', 'ambiguous-title', 'ambiguous-controls'])
  test('S2 actual runB3 through account and original restoration: ' + mode, { concurrency: false }, async () => {
    const out = mkdtempSync(join(tmpdir(), 'b3-s2-account-chain-'));
    const oldPath = process.env.PATH, windows = [], apiCalls = [], uiInputs = [], dispatches = [], bridgeCalls = [], requests = [], pending = new Set(), asyncErrors = [];
    let window, currentUser = 'A', loginCredentials, authView = 'login', modeMutation = false, generation = 0, query = '', filterOpen = false;
    let filters = {}, resultRows = [], loading = false, error = false;
    const places = [], messages = [];
    const spec = { version: 1, unit: 'search-isolation', attempt: 'device-005', active: false, users: [], queries: [], rules: [], release: [], retry: [] };
    const controlFile = join(out, 's2-control.json'), eventsFile = join(out, 's2-proxy-events.jsonl');
    writeFileSync(controlFile, JSON.stringify(spec));
    const principal = auth => { assert(['host-A','host-B'].includes(auth)); return auth === 'host-A' ? 'A' : 'B'; };
    const modelApi = async (path, method, body, auth) => {
      if (path === '/auth/signup') { loginCredentials = { ...body }; return { user: { id: 'B' }, user_token: 'host-B' }; }
      const user = principal(auth); apiCalls.push({ path, method, user });
      if (path === '/api/me') return { id: user, name: user === 'A' ? 'Host A' : loginCredentials.name };
      if (path === '/api/workspaces') { const w = { id: 'W' + places.length, name: body.name, members: [user,...body.member_user_ids] }; places.push(w); return { workspace: w }; }
      const w = places.find(p => path === `/api/workspaces/${p.id}/channels`);
      if (w) { assert(w.members.includes(user)); assert(Array.isArray(body.member_user_ids)); assert(body.member_user_ids.every(id => w.members.includes(id))); w.channelMembers = [user,...body.member_user_ids]; w.channel = 'C' + w.id; w.title = body.title; return { channel: { id: w.channel, title: w.title } }; }
      const p = places.find(p => path === `/api/channels/${p.channel}/messages`);
      if (p) { assert(p.members.includes(user) && p.channelMembers.includes(user), 'Strict channel/workspace membership'); await new Promise(resolve => setTimeout(resolve, 2)); const message = { id: 'M'+messages.length, content: body.content, created_at: Date.now(), from_user_id: user, place: p }; messages.push(message); return { message }; }
      assert(path.startsWith('/api/search?'), path);
      const params = new URL('http://host'+path).searchParams;
      return { results: messages.filter(m => m.place.members.includes(user) && m.place.channelMembers.includes(user) && m.content.includes(params.get('q')) &&
        (!params.has('workspace_id') || m.place.id === params.get('workspace_id')) && (!params.has('user_id') || m.from_user_id === params.get('user_id')) &&
        (!params.has('from') || m.created_at >= Number(params.get('from'))) && (!params.has('to') || m.created_at <= Number(params.get('to')))).map(message => ({ message })) };
    };
    const upstream = http.createServer(async (req, res) => {
      try { const value = await modelApi(req.url, req.method, undefined, req.headers.authorization?.replace('Bearer ', '')); res.setHeader('content-type','application/json'); res.end(JSON.stringify(value)); }
      catch (e) { asyncErrors.push(String(e)); res.writeHead(500); res.end('{"error":"controlled_host_model"}'); }
    });
    await new Promise(resolve => upstream.listen(0,'127.0.0.1',resolve));
    const control = new SearchControl(controlFile, eventsFile); // Original <=20s budget.
    const proxy = http.createServer(proxyHandler({ port: upstream.address().port, control }));
    await new Promise(resolve => proxy.listen(0,'127.0.0.1',resolve));
    const base = 'http://127.0.0.1:' + proxy.address().port;
    const request = async (path, user) => { requests.push({ path, user }); return fetch(base+path, { headers: { authorization: 'Bearer host-'+user } }); };
    const track = promise => { pending.add(promise); promise.catch(e => asyncErrors.push(String(e))).finally(() => pending.delete(promise)); };
    const makeWindow = () => { window = new Window({ url: 'https://localhost/#/chat' }); windows.push(window); Object.defineProperty(window, 'performance', { value: { timeOrigin: Date.now() + windows.length }, configurable: true }); window.document.documentElement.dataset.layout='compact'; };
    const geometry = () => {
      const elements = [...window.document.querySelectorAll('button,input,[role=option]')];
      elements.forEach((e,i) => { e.getBoundingClientRect=()=>({ x:10,y:10+i*24,width:180,height:20 }); });
      window.document.elementFromPoint = (x,y) => elements.find(e => { const r=e.getBoundingClientRect(); return x>=r.x && x<=r.x+r.width && y>=r.y && y<=r.y+r.height; }) ?? window.document.body;
    };
    const button = (text, action, attrs='') => `<button data-host-action="${action}" ${attrs}>${text}</button>`;
    const chats = () => { generation++; query=''; filters={}; window.location.hash='#/chat'; window.document.body.innerHTML='<div data-page><aside data-sidebar="workspaces">'+button('Search','search')+'</aside></div><nav aria-label="Main navigation">'+button('Me','me')+'</nav>'; geometry(); };
    const refreshList = () => {
      const list=window.document.querySelector('.search-list'); if(!list) return;
      list.innerHTML='';
      if(loading) list.innerHTML='<div role="status" aria-label="Loading search results"></div>';
      else if(error) list.innerHTML='<div role="alert">Search failed. '+button('Retry','retry')+'</div>';
      else if(!query) list.textContent='Type to search';
      else { const section=window.document.createElement('section'), ul=window.document.createElement('ul'); section.append(ul); list.append(section);
        for(const m of resultRows) { const li=window.document.createElement('li'), b=window.document.createElement('button'); b.textContent=m.content+' '+m.place.title+' '+m.place.name; li.append(b);ul.append(li); }
      }
      const clear=window.document.querySelector('[aria-label="Clear search"]');if(clear)clear.disabled=!query;
      geometry();
    };
    const search = () => {
      generation++;query='';filters={};filterOpen=false;loading=false;error=false;resultRows=[];window.location.hash='#/chat/search';
      window.document.body.innerHTML='<div data-page>'+button('Back','back','class="mobile-back" aria-label="Back"')+'<input placeholder="Search people, agents, messages, channels">'+button('Clear','clear','aria-label="Clear search" disabled')+button('Filters','filters','data-filter-toggle aria-expanded="false"')+['Project','Sender','Time'].map(s=>button('All '+s,'filter-'+s,`aria-label="${s} filter"`)).join('')+'<div class="search-list"></div></div>';refreshList();
    };
    const runSearch = (attempt=0) => {
      const q=query, user=currentUser, turn=generation;
      if(!q){loading=false;error=false;resultRows=[];refreshList();return;}
      loading=true;error=false;refreshList();
      const params=new URLSearchParams({q,include_identities:'true',limit:'100',...filters});
      track((async()=>{ const response=await request('/api/search?'+params,user);
        if(!response.ok){if(attempt===0){runSearch(1);return;} if(turn===generation&&user===currentUser&&q===query){loading=false;error=true;refreshList();}return;}
        const value=await response.json(); if(turn===generation&&user===currentUser&&q===query){resultRows=value.results.map(r=>r.message);loading=false;error=false;refreshList();}
      })());
    };
    const auth = next => {
      authView=next;window.location.hash='';
      window.document.body.innerHTML='<header><h1>Silverhand</h1></header><form data-auth-form><h1>'+(next==='login'?'Log in':'Sign up')+'</h1><input id="auth-email"><input id="auth-password">'+button(next==='login'?'Log in':'Create account','login','type="submit" disabled')+button(next==='login'?'Sign up':'Log in','mode','type="button"')+'</form>';geometry();
    };
    const openOptions = label => {
      const old=window.document.querySelector('[role=listbox]');old?.remove();const box=window.document.createElement('div');box.setAttribute('role','listbox');
      const values=label==='Project'?[['All projects',''],...places.filter(p=>p.members.includes(currentUser)).map(p=>[p.name,p.id])]:label==='Sender'?[['All senders',''],['Host A','A'],[loginCredentials.name,'B']]:[['Today','today'],['All time','']];
      for(const [text,value] of values){const option=window.document.createElement('div');option.setAttribute('role','option');option.dataset.hostAction='option';option.dataset.hostFilter=label;option.dataset.hostValue=value;const span=window.document.createElement('span');span.id='host-option-'+label+'-'+box.children.length;span.textContent=text;option.setAttribute('aria-labelledby',span.id);option.append(span);box.append(option);}
      window.document.querySelector('[data-page]').append(box);geometry();
    };
    try {
      const bin=join(out,'bin');mkdirSync(bin);writeFileSync(join(bin,'adb'),'#!/bin/sh\nprintf HOST_CONTROLLED_CAPTURE\n',{mode:0o700});process.env.PATH=bin+':'+oldPath;
      makeWindow();chats();
      const c={async evaluate(expression){
        if(expression.includes('function searchAuthMode') && !modeMutation){
          modeMutation=true;const form=window.document.querySelector('[data-auth-form]');
          if(mode==='missing-form')form.remove();
          if(mode==='ambiguous-form')form.after(form.cloneNode(true));
          if(mode==='ambiguous-title')form.insertAdjacentHTML('afterbegin','<h1>Log in</h1>');
          if(mode==='ambiguous-controls')form.querySelector('[type=submit]').after(form.querySelector('[type=submit]').cloneNode(true));
          geometry();
        }
        new Script(expression);return window.eval(expression);
      },async send(method,value){
        assert.equal(method,'Input.dispatchMouseEvent');
        const target=window.__b2LeftClickTarget;assert(target?.isConnected);dispatches.push({type:value.type,action:target.dataset.hostAction,text:target.textContent.trim(),user:currentUser,authForm:!!target.closest('[data-auth-form]')});
        if(value.type!=='mouseReleased')return;
        const action=target.dataset.hostAction;
        if(action==='search')search();
        else if(action==='back')chats();
        else if(action==='clear'){generation++;query='';window.document.querySelector(searchInput).value='';runSearch();}
        else if(action==='retry')runSearch();
        else if(action==='filters'){filterOpen=!filterOpen;target.setAttribute('aria-expanded',String(filterOpen));}
        else if(action?.startsWith('filter-'))openOptions(action.slice(7));
        else if(action==='option'){
          const key=target.dataset.hostFilter,v=target.dataset.hostValue;
          if(key==='Project'){if(v)filters.workspace_id=v;else delete filters.workspace_id;}
          else if(key==='Sender'){if(v)filters.user_id=v;else delete filters.user_id;}
          else if(v){filters.from=String(new Date().setHours(0,0,0,0));filters.to=String(Date.now());}else{delete filters.from;delete filters.to;}
          window.document.querySelector('[role=listbox]').remove();generation++;runSearch();
        }
        else if(action==='me'){window.location.hash='#/me';window.document.body.innerHTML='<div data-page>'+button('Edit','settings','aria-label="Edit profile"')+'</div>';geometry();}
        else if(action==='settings'){window.location.hash='#/settings?settingsSection=account';window.document.body.innerHTML='<div data-page>'+button('Log out','logout')+'</div>';geometry();}
        else if(action==='logout'){currentUser=null;generation++;await new Promise(resolve=>setTimeout(resolve,2));makeWindow();auth(mode==='signup-to-login'?'signup':'login');}
        else if(action==='mode'){assert.equal(authView,'signup');auth('login');}
        else if(action==='login'){
          assert.equal(authView,'login');assert.equal(window.document.querySelector('#auth-email').value,loginCredentials.email);assert.equal(window.document.querySelector('#auth-password').value,loginCredentials.password);
          currentUser='B';chats();
        }
        else throw Error('Unknown controlled UI action '+action);
      }};
      const table=JSON.parse(readFileSync(new URL('./acceptance-scenarios.json',import.meta.url))).B3['search-isolation'];
      const record=new AcceptanceRecord(out,[...table.preconditions,...table.cases]);let thrown;
      try { await runB3({unit:'search-isolation',c,api:modelApi,out,token:'host-A',serial:'host-only',fixture:{userId:'A'},
        call:async method=>{assert.equal(method,'authState');bridgeCalls.push({method,user:currentUser});const r=await request('/api/me',currentUser);return {me:{status:r.status,bodyText:await r.text()}};},
        input:async(selector,value)=>{const nodes=window.document.querySelectorAll(selector);assert.equal(nodes.length,1);nodes[0].value=value;uiInputs.push({selector,user:currentUser,kind:selector===searchSelector?'search':selector});
          if(selector===searchSelector){query=value;generation++;runSearch();}else{const submit=window.document.querySelector('button[type=submit]');submit.disabled=!(window.document.querySelector('#auth-email').value&&window.document.querySelector('#auth-password').value);}},
        adb:(...args)=>{assert.deepEqual(args,['shell','dumpsys','input_method']);return 'mInputShown=false';},
        step:(...args)=>record.step(...args),observe:(...args)=>record.observe(...args)}); }catch(e){thrown=e;record.fail(e);}
      await Promise.allSettled([...pending]);
      if(process.env.SILVERHAND_S2_ACCOUNT_EVIDENCE){mkdirSync(process.env.SILVERHAND_S2_ACCOUNT_EVIDENCE,{recursive:true});writeFileSync(join(process.env.SILVERHAND_S2_ACCOUNT_EVIDENCE,mode+'.json'),JSON.stringify({scope:'pre-assert host diagnostic, not a passing result',mode,raw:record.data,error:thrown?String(thrown):null,asyncErrors,dispatches,uiInputs},null,2));}
      assert.deepEqual(asyncErrors,[]);assert(record.data.steps.slice(0,5).every(s=>s.status==='passed'), String(thrown));
      const account=record.data.steps[5], observations=record.data.observations;
      const modeState=observations.find(o=>o.name==='s2-auth-mode')?.value;assert(modeState, String(thrown));
      const success=['direct-login','signup-to-login'].includes(mode);
      if(success){assert.equal(thrown,undefined);assert.equal(account.status,'passed');assert.equal(modeState.mode,mode==='direct-login'?'login':'signup');
        assert.equal(dispatches.filter(d=>d.action==='mode'&&d.type==='mouseReleased').length,mode==='direct-login'?0:1);
        assert.equal(dispatches.filter(d=>d.action==='login'&&d.type==='mouseReleased').length,1);
        assert(observations.some(o=>o.name==='s2-b-native'&&o.value.userId==='B'));assert(observations.some(o=>o.name==='s2-b-native-after'&&o.value.userId==='B'));
        assert(observations.some(o=>o.name==='s2-b-after-old-release'));
        const marker=observations.find(o=>o.name==='s2-restoration-complete')?.value;assert.equal(marker?.status,'passed');assert.equal(marker.native.observedUserId,'B');assert.equal(marker.finalIME.shown,false);assert.equal(marker.chats.route,'#/chat');assert.equal(marker.chats.dialogs,0);assert.equal(marker.chats.toolbars,0);
      }else{assert.match(String(thrown),/S2 auth mode unavailable/);assert.equal(account.status,'failed');assert.equal(record.data.first_error.message,String(thrown));assert.equal(modeState.ready,false);assert.equal(uiInputs.filter(v=>v.selector.startsWith('#auth')).length,0);assert.equal(dispatches.filter(d=>d.authForm).length,0);assert(!observations.some(o=>o.name==='s2-b-native'||o.name==='s2-restoration-complete'));}
      assert(observations.some(o=>o.name==='s2-reference-release'&&o.value.status==='released'));assert.equal(control.pending.size,0);assert.deepEqual(observations.find(o=>o.name==='s2-control-summary').value.controlFailures,[]);
      if(process.env.SILVERHAND_S2_ACCOUNT_EVIDENCE){mkdirSync(process.env.SILVERHAND_S2_ACCOUNT_EVIDENCE,{recursive:true});writeFileSync(join(process.env.SILVERHAND_S2_ACCOUNT_EVIDENCE,mode+'.json'),JSON.stringify({scope:'actual whole runB3/real record/state/mode/click/waits/control and original restoration executed; external DOM/react UI, API/bridge/native, geometry, IME/capture controlled; no product/device account proof',mode,raw:record.data,apiCalls,uiInputs,dispatches,bridgeCalls,requests,proxyEvents:readFileSync(eventsFile,'utf8'),pendingAtEnd:control.pending.size,error:thrown?String(thrown):null},null,2));}
    } finally {
      process.env.PATH=oldPath;control.close();proxy.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>upstream.close(r))]);await Promise.all(windows.map(w=>w.happyDOM.close()));rmSync(out,{recursive:true,force:true});
    }
  });

import { TaskReadControl } from './acceptance-server.mjs';
import { taskAlignCard, clickTaskCard, taskOptionTarget, taskStateExpression, taskInitialCountsReady, taskEventStateExpression } from './acceptance-b3.mjs';

const t1Spec = (active=false) => ({version:1,unit:'task-read',attempt:'device-007',active,users:[],taskIds:[],channelIds:[],workspaceId:null,routes:[],faultTargets:{columnChannelId:null,detailTaskId:null},rules:[],release:[],disarmed:[],releaseAll:false});
// Real runB3, real recorder, real serialized DOM readers/checked clicks and real
// TaskReadControl/HTTP. React UI, backend, bridge, geometry, IME/capture are models.
for(const variant of ['counts-delayed','counts-one-unknown','faults-counts-delayed','counts-unknown','counts-error','counts-wrong-corrected','counts-wrong-other-unknown','counts-illegal','counts-missing','counts-em-dash','counts-body-loading','counts-record-error','success','member-missing','card-missing','card-ambiguous','card-occluded','card-replaced','option-missing','option-ambiguous','final-ime','final-identity','control-failure','align-release-error','click-release-error','release-only-error','title-wrong','title-missing','title-ambiguous','status-wrong','status-missing','status-ambiguous','channel-wrong','channel-missing','channel-ambiguous','fresh-status','fresh-closed','fresh-archived','filter-missing','filter-ambiguous','filter-bar-ambiguous','filter-page-ambiguous','filter-replaced','filter-strip-replaced','filter-route-changed','filter-occluded','filter-disabled','filter-still-outside','filter-align-release-error','filter-click-release-error','filter-release-only-error','faults-success','faults-previsited-column','faults-previsited-detail','faults-unbound-column','faults-unbound-detail','faults-final-ime','faults-final-identity','faults-control-failure'])
 test('T1 actual runB3 PRE/selected cases/restoration controlled chain: '+variant,{concurrency:false},async()=>{
  const faultsOnly=variant.startsWith('faults-'),mode=faultsOnly?variant.slice(7):variant;let reachableReleases=0,coldInjection=false;
  const out=mkdtempSync(join(tmpdir(),'b3-t1-chain-')),oldPath=process.env.PATH;
  const controlFile=join(out,'t1-control.json'),eventsFile=join(out,'t1-proxy-events.jsonl');writeFileSync(controlFile,JSON.stringify(t1Spec()));
  const window=new Window({url:'https://localhost/#/chat'}),document=window.document;document.documentElement.dataset.layout='compact';
  Object.defineProperty(window,'innerWidth',{value:412,configurable:true});Object.defineProperty(window,'innerHeight',{value:839,configurable:true});
  let workspace,route='chats',selectedTask=null,filter={},detailRead={},columnReads={},counts={},panel=null,geometryMutation=false,nativeCalls=0,releaseFaultArmed=false;
  let eligibleCountReads=0;const countStateSamples=[];
  const channels=[],tasks=[],cache=new Map(),pending=new Set(),asyncErrors=[],apiCalls=[],dispatches=[],scrollCalls=[],requests=[],hitSamples=[],geometryCalls=[],failedInputAttempts=[];
  const filterAlignmentCalls=[],filterModelMetrics=[],filterCounts={};let filterMutation=false,filterFailureStart=null,currentFilterAlignmentName=null;
  const statuses=['todo','in_progress','in_review','done','closed'],labels={todo:'Todo',in_progress:'In progress',in_review:'In review',done:'Done',closed:'Closed'};
  const apiModel=async(path,method,body,auth)=>{
    assert.equal(auth,'host-A');apiCalls.push({path,method});const url=new URL(path,'http://model');
    if(path==='/api/me')return{id:'A'};
    if(path==='/api/workspaces'){assert(body.member_user_ids.includes('A'));workspace={id:'W',name:body.name};return{workspace};}
    if(path==='/api/workspaces/W/members')return{human_members:[{user_id:'A'}]};
    if(path==='/api/workspaces/W/channels'){assert.equal(body.visibility,'private');assert(body.member_user_ids.includes('A'));const ch={id:'C'+channels.length,title:body.title,status:mode==='fresh-status'?'active':'idle',closed_at:mode==='fresh-closed'?1:null,archived_at:mode==='fresh-archived'?1:null,members:['A']};channels.push(ch);return{channel:ch};}
    const ch=channels.find(c=>path===`/api/conversations/${c.id}/members`);if(ch)return{members:mode==='member-missing'?[]:ch.members.map(user_id=>({kind:'human',user_id}))};
    const fact=channels.find(c=>path===`/api/channels/${c.id}`);if(fact)return{channel:fact};
    if(path==='/api/tasks'){const ch=channels.find(c=>c.id===body.conversation_id);assert(ch&&ch.members.includes('A'),'host strict task channel gate');const id='T'+tasks.length,t={id,task_number:tasks.length+1,title:body.title,content:body.body,status:'todo',source_message_id:null,place:{kind:'workspace',workspace_id:'W',conversation_id:ch.id,channel_name:ch.title},nav:{kind:'created_event',ref:{conversation_id:ch.id,thread_root_id:null,message_id:'E'+id}}};tasks.push(t);return{success:true,task:{id,task_number:t.task_number,title:t.title}};}
    const statusTask=tasks.find(t=>path===`/api/tasks/${t.id}/status`);if(statusTask){assert(channels.find(c=>c.id===statusTask.place.conversation_id).members.includes('A'));statusTask.status=body.status;return{success:true};}
    const task=tasks.find(t=>path===`/api/tasks/${t.id}`);if(task){assert(channels.find(c=>c.id===task.place.conversation_id).members.includes('A'));return{task};}
    if(url.pathname==='/api/tasks/board/facets')return{assignees:[],creators:[{type:'user',id:'A',name:'Host A'}],has_unassigned:true};
    if(url.pathname.startsWith('/api/tasks/board/')){const set=tasks.filter(t=>!url.searchParams.get('channel_id')||t.place.conversation_id===url.searchParams.get('channel_id'));if(url.pathname.endsWith('/counts'))return{counts:Object.fromEntries(statuses.map(s=>[s,set.filter(t=>t.status===s).length]))};const status=url.searchParams.get('status');return{status,items:set.filter(t=>t.status===status),next_cursor:null};}
    throw Error('Unknown T1 model API '+path);
  };
  const upstream=http.createServer(async(req,res)=>{try{res.setHeader('content-type','application/json');res.end(JSON.stringify(await apiModel(req.url,req.method,undefined,req.headers.authorization?.replace('Bearer ',''))))}catch(e){asyncErrors.push(String(e));res.writeHead(500);res.end('{}')}});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const control=new TaskReadControl(controlFile,eventsFile),proxy=http.createServer(proxyHandler({port:upstream.address().port,control}));await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+proxy.address().port;
  const request=async path=>{requests.push(path);return fetch(base+path,{headers:{authorization:'Bearer host-A'}})};
  const track=p=>{pending.add(p);p.catch(e=>asyncErrors.push(String(e))).finally(()=>pending.delete(p))};
  const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  const button=(text,action,attrs='')=>`<button data-host-action="${action}" ${attrs}>${escape(text)}</button>`;
  // Numeric widths are a bounded geometry model, not CSS rendering or an
  // uncollected device scrollWidth: viewport/clientWidth 412 from device008;
  // long selected chips 320/274, gap6, and auxiliary chips100/reset32 model
  // nowrap + shrink0/overflow-x:auto from mobile.css. Card columns are vertical.
  function geometry(){
    geometryCalls.push({call:geometryCalls.length+1,occlusionMutation:geometryMutation});
    const rect=(x,y,width,height)=>({x,y,width,height,left:x,top:y,right:x+width,bottom:y+height});
    const board=document.querySelector('[data-tasks-board]');if(board){board.style.overflowY='auto';board.getBoundingClientRect=()=>rect(0,150,412,500);}
    const bar=document.querySelector('[data-task-filter-bar]'),filterButtons=bar?[...bar.querySelectorAll('button')]:[];
    if(bar){
      bar.style.cssText='display:flex;flex-wrap:nowrap;overflow-x:auto;overflow-y:auto;min-width:0';bar.getBoundingClientRect=()=>rect(0,60,412,34);
      const widths=filterButtons.map(e=>e.getAttribute('aria-label')==='Board scope'?(filter.workspace_id?320:130):e.getAttribute('aria-label')==='Channel'?(filter.channel_id?274:140):e.getAttribute('aria-label')==='Reset filters'?32:100);
      const total=widths.reduce((sum,w)=>sum+w,0)+Math.max(0,widths.length-1)*6;
      for(const [key,value] of Object.entries({clientWidth:412,clientHeight:34,scrollWidth:total}))Object.defineProperty(bar,key,{value,configurable:true});
      let offset=0;
      filterButtons.forEach((e,i)=>{const left=offset,width=widths[i];offset+=width+6;e.style.flexShrink='0';e.getBoundingClientRect=()=>rect(left-bar.scrollLeft,60,width,34);e.scrollIntoView=args=>{scrollCalls.push({label:e.getAttribute('aria-label'),args,before:bar.scrollLeft,scrollWidth:total,clientWidth:412});const r=e.getBoundingClientRect(),delta=r.left<0?r.left:r.right>412?r.right-412:0;if(!(mode==='filter-still-outside'&&filter.channel_id&&e.getAttribute('aria-label')==='Channel'))bar.scrollLeft=Math.max(0,Math.min(total-412,bar.scrollLeft+delta));filterModelMetrics.push({label:e.getAttribute('aria-label'),before:scrollCalls.at(-1).before,after:bar.scrollLeft,rect:e.getBoundingClientRect(),scrollWidth:total,clientWidth:412});};});
    }
    for(const e of document.querySelectorAll('button')){
      if(e.closest('[data-task-filter-bar]'))continue;
      const card=e.closest('[data-task-id]'),inPanel=e.closest('[data-task-filter-panel]');
      const pos=card?rect(12,170+statuses.indexOf(card.closest('[data-tasks-column]').dataset.status)*240+Number(card.dataset.taskNumber)*40,388,35):e.hasAttribute('data-tasks-column-header')?rect(12,114+statuses.indexOf(e.closest('[data-tasks-column]').dataset.status)*240,388,24):inPanel?rect(10,110+[...inPanel.querySelectorAll('button')].indexOf(e)*32,180,24):e.closest('nav')?rect(e.dataset.hostAction==='tasks'?112:10,790,90,32):rect(10,10+[...document.querySelectorAll('button')].filter(b=>!b.closest('[data-task-id]')&&!b.closest('[data-task-filter-bar]')).indexOf(e)*28,180,24);
      e.getBoundingClientRect=()=>pos;
      if(card){card.getBoundingClientRect=e.getBoundingClientRect;card.scrollIntoView=args=>{scrollCalls.push({id:card.dataset.taskId,args});board.scrollLeft=0;geometry()};}
      e.scrollIntoView=()=>{};
    }
    for(const e of document.querySelectorAll('[data-system-message-id]'))e.getBoundingClientRect=()=>rect(12,200,388,30);
    const cover=document.querySelector('[data-host-occluder]');if(cover)cover.getBoundingClientRect=()=>rect(0,0,412,839);
    document.elementFromPoint=(x,y)=>{if(!(x>=0&&x<412&&y>=0&&y<839))return null;const elements=[...document.querySelectorAll('button, [data-host-occluder]')];const layer=e=>{let z=0;for(let n=e;n;n=n.parentElement){const value=Number(window.getComputedStyle(n).zIndex);if(Number.isFinite(value))z=Math.max(z,value)}return z};const hit=elements.map((e,index)=>({e,index,z:layer(e)})).sort((a,b)=>b.z-a.z||b.index-a.index).find(({e})=>{const r=e.getBoundingClientRect();if(e.closest('[data-task-filter-bar]')&&!(x>=0&&x<412&&y>=60&&y<94))return false;return x>=r.left&&x<r.right&&y>=r.top&&y<r.bottom})?.e??document.body;const cardButton=document.querySelector('[data-task-id] button');hitSamples.push({x,y,geometryCall:geometryCalls.length,mutation:geometryMutation,hit:{tag:hit.tagName,action:hit.dataset.hostAction??null,task:hit.closest('[data-task-id]')?.dataset.taskId??null},firstCardContains:!!cardButton&&(cardButton===hit||cardButton.contains(hit))});return hit;};
  }
  const ps=extra=>new URLSearchParams({...filter,...extra}).toString();
  function countText(status){
    const normal=counts[status]===undefined?'–':String(counts[status]);
    if(!mode.startsWith('counts-')||!eligibleCountReads||!['todo','in_progress'].includes(status))return normal;
    if(['counts-unknown','counts-error'].includes(mode))return '–';
    if(mode==='counts-delayed'&&eligibleCountReads===1)return '–';
    if(mode==='counts-one-unknown'&&eligibleCountReads===1)return status==='todo'?'3':'–';
    if(['counts-wrong-corrected','counts-record-error'].includes(mode)&&eligibleCountReads===1)return status==='todo'?'4':'1';
    if(mode==='counts-wrong-other-unknown')return status==='todo'?'–':'2';
    if(mode==='counts-illegal'&&status==='todo')return '3oops';
    if(mode==='counts-em-dash'&&status==='todo')return '—';
    return normal;
  }
  function updateColumns(){if(route!=='board')return;for(const s of statuses){const col=document.querySelector(`[data-status="${s}"]`),read=mode==='counts-body-loading'&&s==='todo'?{loading:true}:columnReads[s]??{};col.querySelector('[data-tasks-column-header]').lastElementChild.textContent=countText(s);const body=col.querySelector('[data-tasks-column-body]');let html=read.loading?'<div role="status" aria-label="Loading tasks"></div>':read.error?'Couldn’t load tasks':!read.items?.length?`No ${labels[s].toLowerCase()} tasks`:'<ul>'+read.items.map(t=>`<li><div data-task-id="${t.id}" data-task-number="${t.task_number}">${button('','open-'+t.id,'aria-label="Open task detail"')}<div class="pointer-events-none"><div><span data-tasks-num>#${t.task_number}</span><span data-task-status="${t.status}">${t.status.replaceAll('_',' ')}</span></div>${mode==='title-missing'&&t.id===tasks[0].id?'':'<span class="block min-w-0 text-xs text-text-primary wrap-anywhere">'+escape(mode==='title-wrong'&&t.id===tasks[0].id?'Incorrect displayed title':t.title)+'</span>'}${mode==='title-ambiguous'&&t.id===tasks[0].id?'<span>'+escape(t.title)+'</span>':''}<div><span title="${escape(t.place.channel_name)}">${escape(t.place.channel_name)}</span></div></div></div></li>`).join('')+'</ul>';if(body.innerHTML!==html)body.innerHTML=html;}geometry();}
  function runBoard(){
    columnReads={};counts={};
    const filterAt=JSON.stringify(filter),load=async(path,attempt=0)=>{const r=await request(path);if(!r.ok){if(!attempt)return load(path,1);throw Error('modeled default retry1 ended')}const data=await r.json();cache.set(path,{data,at:Date.now()});return data};
    for(const s of statuses){if(s==='closed')continue;const path='/api/tasks/board/column?'+ps({status:s,limit:'20'}),hit=cache.get(path);if(hit&&Date.now()-hit.at<5000)columnReads[s]={items:hit.data.items};else{columnReads[s]={loading:true};track(load(path).then(data=>{if(route==='board'&&JSON.stringify(filter)===filterAt){columnReads[s]={items:data.items};updateColumns()}}).catch(()=>{if(route==='board'&&JSON.stringify(filter)===filterAt){columnReads[s]={error:true};updateColumns()}}));}}
    const countPath='/api/tasks/board/counts'+(ps({})?'?'+ps({}):'');const hit=cache.get(countPath);if(hit&&Date.now()-hit.at<5000)counts=hit.data.counts;else track(load(countPath).then(data=>{if(route==='board'&&JSON.stringify(filter)===filterAt){counts=data.counts;updateColumns()}}));
    const facetPath='/api/tasks/board/facets'+(filter.container?'?container='+filter.container:'');if(!cache.has(facetPath))track(load(facetPath));updateColumns();
  }
  function nav(){return'<nav aria-label="Main navigation">'+button('Chats','chats')+button('Tasks','tasks')+'</nav>'}
  function chats(){route='chats';window.location.hash='#/chat';document.body.innerHTML='<div data-page></div>'+nav();geometry()}
  function board(){route='board';selectedTask=null;window.location.hash='#/tasks';const selected=channels.find(ch=>ch.id===filter.channel_id);document.body.innerHTML='<div data-page><div data-task-board-toolbar><div data-task-filter-bar>'+button('Project:'+(filter.workspace_id?workspace.name:'All'),'scope','aria-label="Board scope" aria-expanded="false"')+button('Channel:'+(selected?.title??'All'),'channel','aria-label="Channel" aria-expanded="false"')+button('Assignee:All','unused-assignee','aria-label="Assignee"')+button('From:All','unused-from','aria-label="From"')+(Object.keys(filter).length?button('','reset','aria-label="Reset filters"'):'')+'</div></div><div data-tasks-board>'+statuses.map(s=>`<section data-tasks-column data-status="${s}"><button data-tasks-column-header aria-expanded="${s==='closed'?'false':'true'}"><span>${labels[s]}</span><span></span></button><div data-tasks-column-body></div></section>`).join('')+'</div></div>'+nav();runBoard()}
  function renderDetail(){if(route!=='detail')return;const t=selectedTask;document.body.innerHTML='<div data-page>'+button('Back','detail-back','class="mobile-back" aria-label="Back"')+'<div aria-label="Task detail">'+(detailRead.loading?'<div role="status" aria-label="Loading task"></div>':detailRead.error?'Couldn’t load this task '+button('Retry','retry'):button('Jump','jump','aria-label="View in conversation"')+`<span>#${t.task_number}</span><h1>${escape(t.title)}</h1><div class="task-pane-meta"><span class="chrome-label">Status</span><div>${mode==='status-missing'?'':'<span data-task-status="'+(mode==='status-wrong'?'done':t.status)+'">'+(mode==='status-wrong'?'done':t.status.replaceAll('_',' '))+'</span>'}${mode==='status-ambiguous'?'<span data-task-status="'+t.status+'">'+t.status.replaceAll('_',' ')+'</span>':''}</div><span class="chrome-label">Channel</span><div>${mode==='channel-missing'?'':'<span><span class="truncate" title="'+escape(mode==='channel-wrong'?'Incorrect displayed channel':t.place.channel_name)+'">'+escape(mode==='channel-wrong'?'Incorrect displayed channel':t.place.channel_name)+'</span></span>'}${mode==='channel-ambiguous'?'<span title="'+escape(t.place.channel_name)+'">'+escape(t.place.channel_name)+'</span>':''}</div></div><p>${escape(t.content)}</p>` )+'</div></div>';geometry()}
  function openTask(t,{retry=false}={}){route='detail';selectedTask=t;window.location.hash='#/tasks?task='+t.id;const path='/api/tasks/'+t.id,hit=cache.get(path);if(!retry&&hit&&Date.now()-hit.at<5000){detailRead={data:hit.data};renderDetail();return}detailRead={loading:true};renderDetail();const load=async(attempt=0)=>{const r=await request(path);if(!r.ok){if(!attempt)return load(1);throw Error('modeled default retry1 ended')}return r.json()};track(load().then(data=>{cache.set(path,{data,at:Date.now()});detailRead={data};renderDetail()}).catch(()=>{detailRead={error:true};renderDetail()}))}
  function options(label){const trigger=document.querySelector(`[aria-label="${label}"]`);trigger.setAttribute('aria-expanded','true');const p=document.createElement('div');p.id='host-panel';p.dataset.taskFilterPanel='';p.dataset.state='open';p.style.position='absolute';p.style.zIndex='70';p.setAttribute('role','listbox');const entries=label==='Board scope'?[{id:'W',label:workspace.name}]:channels.map(c=>({id:c.id,label:c.title}));p.innerHTML=entries.map(e=>button(e.label,'option-'+e.id,`id="opt-${e.id}" role="option" data-option-row`)).join('');for(const b of p.querySelectorAll('button')){const t=b.textContent;b.textContent='';const s=document.createElement('span');s.textContent=t;b.append(s)}document.body.append(p);panel={label,node:p};geometry()}
  const original=new Error('host controlled independent CDP failure'),alignmentSentinel=new Error('alignment-sentinel'),clickSentinel=new Error('click-sentinel'),releaseSentinel=new Error('release-sentinel');
  const c={async evaluate(expression){new Script(expression);let missingCountHeader;
    if(route==='board'&&expression===taskStateExpression()&&mode.startsWith('counts-')){
      if(columnReads.todo?.items&&columnReads.in_progress?.items)eligibleCountReads++;
      updateColumns();
      if(mode==='counts-missing'){missingCountHeader=document.querySelector('[data-status="todo"] [data-tasks-column-header]');missingCountHeader?.removeAttribute('data-tasks-column-header');}
      countStateSamples.push({ordinal:countStateSamples.length+1,eligibleRead:eligibleCountReads,
        requestedModelAuthority:mode==='counts-error'?{known:false,failed:true}:mode==='counts-unknown'?{known:false,failed:false}:'synthetic visible count sequence',
        rendered:[...document.querySelectorAll('[data-tasks-column]')].map(c=>({status:c.dataset.status,count:c.querySelector('[data-tasks-column-header]')?.lastElementChild?.textContent??null,bodyLoading:!!c.querySelector('[role="status"]')}))});
    }

    if(faultsOnly&&!coldInjection){
      const stage=JSON.parse(readFileSync(controlFile)).stage;
      const atColumn=expression==='delete window.__b3TaskCardTarget'&&++reachableReleases===2;
      const atDetail=expression==='delete window.__b3TaskFilterTarget'&&stage==='column-exit';
      if((atColumn&&['previsited-column','unbound-column'].includes(mode))||(atDetail&&['previsited-detail','unbound-detail'].includes(mode))){
        coldInjection=true;if(mode.startsWith('unbound-'))control.sessions.clear();
        const path=mode.endsWith('column')?'/api/tasks/board/column?'+new URLSearchParams({container:'workspace',workspace_id:'W',channel_id:channels[2].id,status:'todo',limit:'20'}):'/api/tasks/'+tasks[2].id;
        const response=await request(path);assert.equal(response.status,200);await response.text();
      }
    }

    const alignLabel=expression.includes('function taskAlignFilterControl')?JSON.parse(expression.match(/\)\(document,("[^"]+")\)$/)[1]):null;
    if(alignLabel){filterCounts[alignLabel]=(filterCounts[alignLabel]??0)+1;filterAlignmentCalls.push({label:alignLabel,ordinal:filterCounts[alignLabel]});
      if(alignLabel==='Channel'&&filterCounts[alignLabel]===2&&mode.startsWith('filter-')){filterMutation=true;filterFailureStart=dispatches.length;const button=document.querySelector('[data-task-filter-bar] button[aria-label="Channel"]'),bar=button.closest('[data-task-filter-bar]');
        if(mode==='filter-missing')button.remove();
        if(mode==='filter-ambiguous')bar.append(button.cloneNode(true));
        if(mode==='filter-bar-ambiguous')bar.parentElement.append(bar.cloneNode(true));
        if(mode==='filter-page-ambiguous')document.body.append(document.querySelector('[data-page]').cloneNode(true));
        if(mode==='filter-disabled')button.disabled=true;
        if(mode==='filter-occluded'){const cover=document.createElement('div');cover.dataset.hostOccluder='';cover.style.position='fixed';cover.style.zIndex='999';document.body.append(cover);}
        if(mode==='filter-align-release-error'){releaseFaultArmed=true;throw alignmentSentinel;}
        if(mode==='filter-release-only-error')releaseFaultArmed=true;
        geometry();
      }
    }
    if(expression==='delete window.__b3TaskFilterTarget'&&releaseFaultArmed&&mode.startsWith('filter-'))throw releaseSentinel;
    if(expression.includes('function leftControlTarget')&&window.__b3TaskFilterTarget&&filterMutation&&!geometryMutation&&['filter-replaced','filter-strip-replaced','filter-route-changed'].includes(mode)){geometryMutation=true;const t=window.__b3TaskFilterTarget;if(mode==='filter-replaced')t.button.replaceWith(t.button.cloneNode(true));if(mode==='filter-strip-replaced')t.bar.replaceWith(t.bar.cloneNode(true));if(mode==='filter-route-changed')window.location.hash='#/chat';geometry();}

    if(expression.includes('function taskAlignCard')&&mode==='align-release-error'){releaseFaultArmed=true;throw alignmentSentinel;}
    if(expression.includes('function taskAlignCard')&&mode==='release-only-error')releaseFaultArmed=true;
    if(expression==='delete window.__b3TaskCardTarget'&&releaseFaultArmed)throw releaseSentinel;
    if(expression.includes('function taskAlignCard')&&!geometryMutation&&['card-missing','card-ambiguous','card-occluded'].includes(mode)){geometryMutation=true;const card=document.querySelector('[data-task-id]');if(mode==='card-missing')card.remove();if(mode==='card-ambiguous')card.parentElement.append(card.cloneNode(true));if(mode==='card-occluded'){const cover=document.createElement('div');cover.dataset.hostOccluder='';cover.style.position='fixed';cover.style.zIndex='999';document.body.append(cover);geometry();}}
    if(expression.includes('function taskOptionTarget')&&['option-missing','option-ambiguous'].includes(mode)){const option=document.querySelector('[data-option-row]');if(mode==='option-missing')option.remove();else option.parentElement.append(option.cloneNode(true));}
    if(mode==='card-replaced'&&expression.includes('function leftControlTarget')&&window.__b3TaskCardTarget&&!geometryMutation){geometryMutation=true;const b=window.__b3TaskCardTarget.button;b.replaceWith(b.cloneNode(true));geometry();}
    const result=window.eval(expression);missingCountHeader?.setAttribute('data-tasks-column-header','');return result;
   },async send(method,value){assert.equal(method,'Input.dispatchMouseEvent');const b=window.__b2LeftClickTarget;assert(b?.isConnected);if(mode==='click-release-error'&&b.dataset.hostAction?.startsWith('open-')){releaseFaultArmed=true;failedInputAttempts.push({type:value.type,action:b.dataset.hostAction,error:String(clickSentinel)});throw clickSentinel;}if(mode==='filter-click-release-error'&&filterMutation&&b.getAttribute('aria-label')==='Channel'){releaseFaultArmed=true;failedInputAttempts.push({type:value.type,action:b.dataset.hostAction,error:String(clickSentinel)});throw clickSentinel;}dispatches.push({type:value.type,action:b.dataset.hostAction,filterAlignmentName:b.closest('[data-task-filter-bar]')?currentFilterAlignmentName:null});if(value.type!=='mouseReleased')return;const action=b.dataset.hostAction;if(action==='tasks')board();else if(action==='chats')chats();else if(action==='scope')options('Board scope');else if(action==='channel')options('Channel');else if(action?.startsWith('option-')){const id=action.slice(7);if(panel.label==='Board scope')filter={container:'workspace',workspace_id:id};else filter={...filter,channel_id:id};panel.node.remove();panel=null;board();}else if(action==='reset'){filter={};board()}else if(action?.startsWith('open-'))openTask(tasks.find(t=>t.id===action.slice(5)));else if(action==='detail-back')board();else if(action==='jump'){route='event';window.location.hash='#/chat/w/W/c/'+selectedTask.place.conversation_id;document.body.innerHTML='<div data-page>'+button('Back','event-back','class="mobile-back" aria-label="Back"')+'<div data-message-list><div data-system-event-row="1" data-system-message-id class="msg-jump-flash"></div></div></div>';const list=document.querySelector('[data-message-list]'),event=list.firstElementChild;Object.assign(list.dataset,{systemJumpState:'located',systemJumpMessageId:selectedTask.nav.ref.message_id,systemJumpOwner:JSON.stringify([selectedTask.place.conversation_id,selectedTask.nav.ref.message_id,1])});Object.assign(event.dataset,{systemMessageId:selectedTask.nav.ref.message_id,messageConversationId:selectedTask.place.conversation_id});event.textContent='created #'+selectedTask.task_number;geometry()}else if(action==='event-back')openTask(selectedTask);else if(action==='retry')openTask(selectedTask,{retry:true});else throw original;
   }};
  try{
    // Host-only placeholder capture; no adb/device is invoked.
    const {chmodSync}=await import('node:fs');writeFileSync(join(out,'adb'),'#!/bin/sh\nprintf host-capture-placeholder\n');chmodSync(join(out,'adb'),0o700);process.env.PATH=out+':'+oldPath;
    chats();const table=JSON.parse(readFileSync(new URL('./acceptance-scenarios.json',import.meta.url))).B3[b3ScenarioKey('task-read',faultsOnly?'faults':undefined)],record=new AcceptanceRecord(out,[...table.preconditions,...table.cases]);let thrown;
    try{await runB3({unit:'task-read',selection:faultsOnly?'faults':undefined,c,api:apiModel,out,token:'host-A',serial:'host-only',fixture:{userId:'A'},step:(...args)=>record.step(...args),observe:(...args)=>{if(mode==='counts-record-error'&&args[0]==='t1-board-count-rejected')throw Error('controlled count observation failure');record.observe(...args);if(args[0].endsWith('-alignment')&&args[1].label)currentFilterAlignmentName=args[0];if(mode==='control-failure'&&args[0]==='t1-restored-capture')control.emit('control_failure',{reason:'host-final-gate-negative',request_id:-1});},call:async method=>{assert.equal(method,'authState');nativeCalls++;const r=await request('/api/me'),value=await r.json();return{me:{status:r.status,bodyText:JSON.stringify(mode==='final-identity'&&nativeCalls===3?{id:'B'}:value)}}},adb:()=>mode==='final-ime'&&route==='chats'?'mInputShown=true':'mInputShown=false'});record.complete()}catch(e){thrown=e;record.fail(e)}
    await Promise.allSettled([...pending]);
    if(process.env.SILVERHAND_T1_HOST_EVIDENCE){mkdirSync(process.env.SILVERHAND_T1_HOST_EVIDENCE,{recursive:true});writeFileSync(join(process.env.SILVERHAND_T1_HOST_EVIDENCE,variant+'.json'),JSON.stringify({selection:faultsOnly?'faults':'full',scope:'host actual runB3/real record/serialized expressions/align/options/checked clicks/TaskReadControl and HTTP; React/API/backend/native/geometry/IME/time/cache and placeholder capture are models, no device proof',raw:record.data,dispatches,scrollCalls,hitSamples,geometryCalls,failedInputAttempts,filterAlignmentCalls,filterModelMetrics,filterFailureStart,countStateSamples,eligibleCountReads,fixtureTruth:tasks.map(t=>({id:t.id,title:t.title,status:t.status,place:t.place})),channelTruth:channels.map(ch=>({id:ch.id,status:ch.status,closed_at:ch.closed_at,archived_at:ch.archived_at,members:ch.members})),apiCalls,requests,asyncErrors,pending:control.pending.size,error:thrown?String(thrown):null},null,2))}
    assert.deepEqual(asyncErrors,[],String(thrown));assert.equal(control.pending.size,0);
    if(mode.startsWith('counts-')){
      const positive=['counts-delayed','counts-one-unknown'].includes(mode),mobile=record.data.steps.find(s=>s.id==='B3.T1.mobile-board');
      const first=record.data.observations.find(o=>o.name==='t1-board-first'),ready=record.data.observations.find(o=>o.name==='t1-board'),rejected=record.data.observations.find(o=>o.name==='t1-board-count-rejected');
      assert.equal(mobile.status,positive?'passed':'failed');
      if(positive){assert(ready.value.reads>1);assert.equal(ready.value.value.columns.find(c=>c.status==='todo').count,'3');assert.equal(ready.value.value.columns.find(c=>c.status==='in_progress').count,'1');}
      else{
        assert(record.data.steps[0].status==='passed'&&record.data.steps.slice(2).every(s=>s.status==='not_executed'));
        assert(!dispatches.some(d=>d.action?.startsWith('open-')||d.action==='scope'));assert(!ready);
        assert(!record.data.observations.some(o=>o.name==='t1-restoration-complete'));
        if(['counts-unknown','counts-error','counts-body-loading'].includes(mode)){
          assert.match(String(thrown),/T1 condition deadline: t1-board/);assert(record.data.observations.some(o=>o.name==='t1-board-last'));assert(!rejected);
        }else{
          assert(!record.data.observations.some(o=>o.name==='t1-board-last'));
          if(mode==='counts-record-error'){
            const classification=record.data.observations.find(o=>o.name==='t1-failure-classification').value;
            assert(!rejected);assert.match(classification.countRecordError,/controlled count observation failure/);assert.equal(classification.countRejectedSnapshot.value,'4');assert.match(String(thrown),/'4' !== '3'/);
          }else{assert(rejected);assert.equal(rejected.value.snapshot.route,'#/tasks');}
          if(mode==='counts-wrong-corrected'){
            assert.equal(rejected.value.value,'4');assert.match(String(thrown),/'4' !== '3'/);
            const later=record.data.observations.find(o=>o.name==='t1-failure-state').value;assert.equal(later.columns.find(c=>c.status==='todo').count,'3');
          }
          if(mode==='counts-wrong-other-unknown'){assert.equal(rejected.value.status,'in_progress');assert.equal(rejected.value.snapshot.columns.find(c=>c.status==='todo').count,'–');assert.match(String(thrown),/'2' !== '1'/);}
          if(['counts-illegal','counts-missing','counts-em-dash'].includes(mode))assert.match(String(thrown),/Invalid T1 board count/);
        }
      }
    }
    if(['success','counts-delayed','counts-one-unknown'].includes(mode)){const aligns=record.data.observations.filter(o=>o.name.endsWith('-alignment')&&o.value.label);assert.deepEqual([...new Set(aligns.map(o=>o.value.label))].sort(),['Board scope','Channel','Reset filters'].sort());for(const o of aligns){assert.equal(o.value.ready,true);assert.deepEqual(JSON.parse(JSON.stringify(o.value.scrollOperation)),{block:'nearest',inline:'nearest',behavior:'instant'});assert.equal(record.data.observations.filter(x=>x.name===o.name.replace(/-alignment$/,'-target')).length,1);assert.equal(record.data.observations.filter(x=>x.name===o.name.replace(/-alignment$/,'-check')).length,1);}if(!faultsOnly){const empty=aligns.find(o=>o.name==='t1-channel-empty-trigger-alignment').value;assert(empty.before.point.x>412);assert(empty.after.point.x<412);assert(empty.after.strip.scrollLeft>empty.before.strip.scrollLeft);}assert(aligns.filter(o=>o.value.label==='Reset filters').every(o=>o.value.before.point.x>412&&o.value.after.point.x<412));assert.equal(window.__b3TaskFilterTarget,undefined);assert(!record.data.observations.some(o=>o.name.endsWith('-release-error')));assert.equal(window.__b3TaskCardTarget,undefined);assert.equal(thrown,undefined);assert(record.data.steps.every(s=>s.status==='passed'));assert.equal(record.data.steps.length,faultsOnly?4:7);if(faultsOnly){assert.deepEqual(record.data.steps.map(r=>r.id),['PRE.T1.fixture-login','B3.T1.mobile-board','B3.T1.board-column-error','B3.T1.detail-error-retry']);assert(!dispatches.some(d=>['jump','event-back','open-T0'].includes(d.action)));const guards=record.data.observations.filter(o=>o.name.endsWith('-cold-observation'));assert.equal(guards.length,2);assert(guards.every(o=>o.value.active&&o.value.bindings.length&&o.value.previous.length===0&&o.value.unbound.length===0&&o.value.matchingRoutes.length===1));}const marker=record.data.observations.find(o=>o.name==='t1-restoration-complete')?.value;assert.equal(marker?.native.observedUserId,'A');assert.equal(marker.chats.route,'#/chat');assert.equal(marker.finalIME.shown,false);assert.deepEqual(JSON.parse(JSON.stringify(scrollCalls[0].args)),{block:'center',inline:'nearest',behavior:'instant'});assert(dispatches.some(d=>d.action==='retry'&&d.type==='mouseReleased'));assert.equal(record.data.observations.some(o=>o.name==='t1-reentry-network'),!faultsOnly);}
    else{if(faultsOnly){
      assert(record.data.steps[0].status==='passed'&&record.data.steps[1].status==='passed');
      if(mode.startsWith('previsited-')||mode.startsWith('unbound-')){
        assert(coldInjection);const id=mode.endsWith('column')?'column-error':'detail-error',ob=record.data.observations.find(o=>o.name==='t1-'+id+'-cold-observation').value;
        assert.equal(ob.active,true);assert.equal(ob.matchingRoutes.length,1);assert(ob.bindings.length);
        if(mode.startsWith('previsited-')){assert.equal(ob.previous.length,1);assert.match(String(thrown),/already received/);}else{assert.equal(ob.previous.length,0);assert(ob.unbound.length);assert.match(String(thrown),/session unbound/);}
        assert(!JSON.parse(readFileSync(eventsFile,'utf8').trim().split('\n').find(line=>JSON.parse(line).event==='received')??'{}').rule);
        assert(!readFileSync(eventsFile,'utf8').trim().split('\n').map(JSON.parse).some(e=>e.event==='received'&&e.rule===id));
        assert.equal(record.data.steps.find(r=>r.id==='B3.T1.'+(id==='column-error'?'board-column-error':'detail-error-retry')).status,'failed');
        if(id==='column-error')assert(!dispatches.some(d=>d.action==='option-'+channels[2].id));else assert(!dispatches.some(d=>d.action==='open-'+tasks[2].id));
      }
      if(mode==='control-failure')assert.equal(record.data.steps.filter(r=>r.id.startsWith('B3.')&&r.status==='passed').length,3);
    }assert(thrown,mode);assert.equal(record.data.first_error.message,String(thrown));assert(!record.data.observations.some(o=>o.name==='t1-restoration-complete'));if(mode==='member-missing')assert.equal(dispatches.length,0);if(mode.startsWith('card-'))assert(!dispatches.some(d=>d.action?.startsWith('open-')));if(mode==='card-occluded'){assert(hitSamples.some(h=>h.mutation&&h.hit.tag==='DIV'&&h.hit.action===null&&!h.firstCardContains));const alignment=record.data.observations.find(o=>o.name==='t1-todo-reachable-alignment').value;assert.equal(alignment.hit,false);assert.equal(alignment.ready,false);}if(mode.startsWith('option-'))assert(!dispatches.some(d=>d.action?.startsWith('option-')));if(mode==='control-failure')assert.equal(thrown.source,'acceptance-control');
      if(['align-release-error','click-release-error','release-only-error'].includes(mode)){assert.equal(thrown,mode==='align-release-error'?alignmentSentinel:mode==='click-release-error'?clickSentinel:releaseSentinel);const releases=record.data.observations.filter(o=>o.name.endsWith('-release-error'));assert.equal(releases.length,1);assert.equal(releases[0].value,String(releaseSentinel));assert(!dispatches.some(d=>d.action?.startsWith('open-')));assert.equal(failedInputAttempts.length,mode==='click-release-error'?1:0);}
      if(mode.startsWith('filter-')){assert.equal(record.data.steps[0].status,'passed');assert.equal(record.data.steps[1].status,'passed');assert.equal(record.data.steps[2].status,'failed');assert(record.data.steps.slice(3).every(row=>row.status==='not_executed'));assert.equal(filterCounts.Channel,2);const releaseOnly=mode==='filter-release-only-error';assert.equal(dispatches.length-filterFailureStart,releaseOnly?2:0);assert.equal(dispatches.filter(d=>d.filterAlignmentName==='t1-channel-empty-trigger-alignment').length,releaseOnly?2:0);
        if(mode==='filter-still-outside'){const a=record.data.observations.find(o=>o.name==='t1-channel-empty-trigger-alignment').value;assert.equal(a.reason,'task_filter_outside_clip');assert(a.after.point.x>412);assert.equal(filterModelMetrics.filter(x=>x.label==='Channel').length,2);}
        if(mode==='filter-occluded'){const a=record.data.observations.find(o=>o.name==='t1-channel-empty-trigger-alignment').value;assert.equal(a.reason,'task_filter_occluded');assert.equal(a.after.hit.tag,'DIV');assert.equal(a.after.hit.insideTarget,false);}
        if(mode==='filter-disabled')assert.match(String(thrown),/task_filter_disabled/);
        if(['filter-missing','filter-ambiguous','filter-bar-ambiguous','filter-page-ambiguous'].includes(mode))assert.match(String(thrown),/task_filter_control_not_unique/);
        if(['filter-replaced','filter-strip-replaced','filter-route-changed'].includes(mode))assert.match(String(thrown),/T1 aligned filter control replaced/);
        if(mode.endsWith('release-error')){assert.equal(thrown,mode==='filter-align-release-error'?alignmentSentinel:mode==='filter-click-release-error'?clickSentinel:releaseSentinel);const errors=record.data.observations.filter(o=>o.name==='t1-channel-empty-trigger-release-error');assert.equal(errors.length,1);assert.equal(errors[0].value,String(releaseSentinel));}
      }
      if(mode.startsWith('fresh-')){assert.equal(record.data.steps[0].status,'failed');assert(record.data.steps.slice(1).every(row=>row.status==='not_executed'));assert.equal(tasks.length,0);assert(!apiCalls.some(row=>row.path==='/api/tasks'));assert.equal(dispatches.length,0);assert.match(String(thrown),/Expected values to be strictly equal/);assert.equal(channels[0].status,mode==='fresh-status'?'active':'idle');assert.equal(channels[0].closed_at,mode==='fresh-closed'?1:null);assert.equal(channels[0].archived_at,mode==='fresh-archived'?1:null);}
      if(/^(title|status|channel)-/.test(mode)){assert.equal(record.data.steps[0].status,'passed');const t=record.data.steps[0].detail.tasks.todo;assert.equal(t.title,tasks[0].title);assert.equal(t.status,tasks[0].status);assert.equal(t.channelName,tasks[0].place.channel_name);assert(t.title.startsWith('T1 todo '));assert.equal(t.status,'todo');assert.equal(t.channelName,channels[0].title);const caseId=mode.startsWith('title-')?'B3.T1.mobile-board':'B3.T1.detail-back';assert.equal(record.data.steps.find(r=>r.id===caseId).status,'failed');assert.match(String(thrown),/T1 condition deadline/);}
    }
  }finally{process.env.PATH=oldPath;control.close();proxy.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>upstream.close(r))]);await window.happyDOM.close();rmSync(out,{recursive:true,force:true})}
 });

async function t1ProxyFixture(fn,{active=true,budget=1000}={}){
 const out=mkdtempSync(join(tmpdir(),'b3-t1-proxy-')),file=join(out,'t1-control.json'),eventsFile=join(out,'t1-events.jsonl');
 const column={path:'/api/tasks/board/column',params:{container:'workspace',workspace_id:'W',channel_id:'Cerror',status:'todo',limit:'20'}},detail={path:'/api/tasks/Td',params:{}},count={path:'/api/tasks/board/counts',params:{container:'workspace',workspace_id:'W',channel_id:'Cerror'}},facet={path:'/api/tasks/board/facets',params:{container:'workspace'}};
 let spec={...t1Spec(active),users:['A'],workspaceId:'W',taskIds:['Td','Tother'],channelIds:['Cerror','Cmain'],routes:[column,detail,count,facet],faultTargets:{columnChannelId:'Cerror',detailTaskId:'Td'},rules:[{id:'column-error',kind:'error',userId:'A',...column},{id:'detail-error',kind:'error',userId:'A',...detail}]};writeFileSync(file,JSON.stringify(spec));
 const upstream=http.createServer((req,res)=>{res.setHeader('x-real-upstream','yes');if(req.url==='/api/me')res.end(JSON.stringify({id:req.headers.authorization==='Bearer host-A'?'A':'B'}));else res.end('original upstream bytes')});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const control=new TaskReadControl(file,eventsFile,{maxBudgetMs:budget}),proxy=http.createServer(proxyHandler({port:upstream.address().port,control}));await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+proxy.address().port,events=()=>existsSync(eventsFile)?readFileSync(eventsFile,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
 const request=(route,{token='host-A',signal}={})=>fetch(base+route.path+(Object.keys(route.params).length?'?'+new URLSearchParams(route.params):''),{headers:{authorization:'Bearer '+token},signal});
 const update=v=>{spec={...spec,...v};writeFileSync(file+'.tmp',JSON.stringify(spec));renameSync(file+'.tmp',file)};
 const until=async predicate=>{for(let i=0;i<100;i++){const value=predicate();if(value)return value;await new Promise(r=>setTimeout(r,5))}throw Error('T1 host proxy condition not met')};
 try{await fn({control,column,detail,count,facet,request,update,events,until,spec,file,out});}finally{control.close();proxy.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>upstream.close(r))]);rmSync(out,{recursive:true,force:true})}
}
test('T1 disabled transparent path preserves bytes/headers without requests or pending',()=>t1ProxyFixture(async f=>{const r=await f.request(f.detail);assert.equal(r.status,200);assert.equal(await r.text(),'original upstream bytes');assert.equal(r.headers.get('x-real-upstream'),'yes');assert(!f.events().some(e=>e.event==='received'));assert.equal(f.control.pending.size,0)},{active:false}));
test('T1 control requires real me session and exact full params; counts/facets stay transparent',()=>t1ProxyFixture(async f=>{
 await f.request({path:'/api/me',params:{}});for(const route of [f.count,f.facet,{...f.column,params:{...f.column.params,extra:'not-matched'}},{...f.column,params:{...f.column.params,status:'in_progress'}},f.detail]){
  if(route===f.detail)continue;const r=await f.request(route);assert.equal(r.status,200);assert.equal(await r.text(),'original upstream bytes');}
 assert(f.events().filter(e=>e.event==='received').every(e=>e.rule===null));
 const unbound=await f.request(f.column,{token:'host-B'});assert.equal(unbound.status,200);assert(f.events().some(e=>e.event==='session_unbound'));assert(!readFileSync(f.file.replace('control.json','events.jsonl'),'utf8').includes('host-A'));
}));
test('T1 exact two503 then explicitly disarmed third forwards original200 and clears pending',()=>t1ProxyFixture(async f=>{
 await f.request({path:'/api/me',params:{}});const first=f.request(f.detail);await f.until(()=>f.control.pending.size===1);f.update({release:['detail-error']});assert.equal((await first).status,503);assert.equal((await f.request(f.detail)).status,503);f.update({disarmed:['detail-error']});const third=await f.request(f.detail);assert.equal(third.status,200);assert.equal(await third.text(),'original upstream bytes');await f.until(()=>f.control.pending.size===0);assert.deepEqual(f.events().filter(e=>e.event==='received').map(e=>e.use),[1,2,3]);
}));
test('T1 unarmed third is control failure, never count-based UI Retry success',()=>t1ProxyFixture(async f=>{
 await f.request({path:'/api/me',params:{}});const first=f.request(f.detail);await f.until(()=>f.control.pending.size===1);f.update({release:['detail-error']});await first;await f.request(f.detail);assert.equal((await f.request(f.detail)).status,502);assert(f.events().some(e=>e.event==='control_failure'&&e.reason==='unexpected_request'));assert.equal(f.control.pending.size,0);
}));
test('T1 receive budget expiration and explicit release have distinct terminal evidence',()=>t1ProxyFixture(async f=>{await f.request({path:'/api/me',params:{}});const r=await f.request(f.detail);assert.equal(r.status,502);assert(f.events().some(e=>e.event==='control_failure'&&e.reason==='total_budget_exceeded'));assert(!f.events().some(e=>e.event==='release'));assert.equal(f.control.pending.size,0)},{budget:80}));
test('T1 client disconnect removes held ownership without fabricating release',()=>t1ProxyFixture(async f=>{await f.request({path:'/api/me',params:{}});const abort=new AbortController(),pending=f.request(f.detail,{signal:abort.signal}).catch(e=>e);await f.until(()=>f.control.pending.size===1);abort.abort();await pending;await f.until(()=>f.events().some(e=>e.event==='client_disconnect'));assert.equal(f.control.pending.size,0);assert(!f.events().some(e=>e.event==='release'))}));
test('T1 finally releaseAll terminal ends held fault and leaves no pending',()=>t1ProxyFixture(async f=>{await f.request({path:'/api/me',params:{}});const pending=f.request(f.detail);await f.until(()=>f.control.pending.size===1);f.update({active:false,releaseAll:true,rules:[]});assert.equal((await pending).status,503);await f.until(()=>f.control.pending.size===0);assert(f.events().some(e=>e.event==='release'&&e.reason==='finally_release'))}));
test('T1 manifest rejects fault target drift/unknown route/changed immutable fixture',()=>t1ProxyFixture(async f=>{for(const value of [{rules:[{...f.spec.rules[1],path:'/api/tasks/Tother'}]},{routes:[{path:'/api/not-tasks',params:{}}]},{users:['A','B']},{faultTargets:{columnChannelId:'Cmain',detailTaskId:'Td'}}]){f.update(value);assert.throws(()=>f.control.read(),/T1/);f.update(f.spec)}}));

// The real entry's argument admission runs before attempt/fixture writes. These
// subprocesses use only a dummy CA file and invalid input; no API/device starts.
import { spawnSync } from 'node:child_process';
for(const [unit,selection] of [['task-read','unknown'],['task-read',''],['search-normal','faults'],['search-isolation','faults']])
test('B3 fixed selection rejects before fixture/attempt: '+unit+'/'+JSON.stringify(selection),async()=>{
 const root=mkdtempSync(join(tmpdir(),'b3-selector-refused-'));try{
  mkdirSync(join(root,'acceptance/certs'),{recursive:true});writeFileSync(join(root,'acceptance/certs/ca.pem'),'host dummy, never used for TLS');
  const out=join(root,'must-not-exist'),result=spawnSync(process.execPath,[new URL('./acceptance.mjs',import.meta.url).pathname,'b3',out,unit,selection],{env:{...process.env,SILVERHAND_ANDROID_RUN_ROOT:root,ANDROID_SERIAL:'emulator-host'},encoding:'utf8',timeout:5000});
  assert.equal(result.error,undefined);assert.notEqual(result.status,0);assert.match(result.stderr,/Unknown B3 fixed selection/);assert(!existsSync(out));
  let calls=0;await assert.rejects(runB3({unit,selection,api:async()=>{calls++}}),/Unknown B3 fixed selection/);assert.equal(calls,0);
 }finally{rmSync(root,{recursive:true,force:true})}
});


test('T1 initial count readiness controlled states and original-error retention', () => {
  const samples = [
    ['known', '3', '1', true], ['other-columns-unknown', '3', '1', true],
    ['unknown-both', '–', '–', false], ['correct-plus-unknown', '3', '–', false],
    ['unknown-plus-correct', '–', '1', false], ['wrong-plus-unknown', '4', '–', 'count_differs'],
    ['unknown-plus-wrong', '–', '2', 'count_differs'], ['zero-wrong', '0', '1', 'count_differs'],
    ['negative', '-1', '1', 'invalid_count'], ['decimal', '3.0', '1', 'invalid_count'],
    ['leading-zero', '03', '1', 'invalid_count'], ['nan', 'NaN', '1', 'invalid_count'],
    ['infinity', 'Infinity', '1', 'invalid_count'], ['mixed-text', '3oops', '1', 'invalid_count'],
    ['em-dash', '—', '1', 'invalid_count'], ['null', null, '1', 'invalid_count'],
    ['missing-value', undefined, '1', 'invalid_count'], ['boolean', true, '1', 'invalid_count'],
    ['missing-column', '3', '1', 'column_identity'], ['duplicate-column', '3', '1', 'column_identity'],
  ], results = [];
  for (const [name, todo, progress, expected] of samples) {
    const board = { route: '#/tasks', columns: [{ status: 'todo', count: todo }, { status: 'in_progress', count: progress },
      { status: 'in_review', count: '–' }, { status: 'done', count: '–' }, { status: 'closed', count: '–' }] };
    if (name === 'missing-column') board.columns.shift();
    if (name === 'duplicate-column') board.columns.push({ status: 'todo', count: '3' });
    const observations = []; let result, error;
    try { result = taskInitialCountsReady(board, { todo: 3, in_progress: 1 }, (...args) => observations.push(args)); }
    catch (e) { error = e; }
    if (typeof expected === 'boolean') { assert.equal(result, expected); assert.equal(error, undefined); assert.deepEqual(observations, []); }
    else { assert(error); assert.equal(observations.length, 1); assert.equal(observations[0][1].reason, expected); assert.equal(observations[0][1].snapshot, board); }
    results.push({ name, inputType: typeof todo, todo: todo === undefined ? null : todo, progress, expected,
      returned: result ?? null, error: error ? { type: error.constructor.name, message: String(error), actual: error.actual, expected: error.expected } : null,
      observations });
  }
  const board = { columns: [{ status: 'todo', count: '4' }, { status: 'in_progress', count: '–' }] };
  let original;
  try { taskInitialCountsReady(board, { todo: 3, in_progress: 1 }, () => { throw Error('controlled count observation failure'); }); }
  catch (error) { original = error; }
  assert.equal(original.code, 'ERR_ASSERTION'); assert.equal(original.actual, '4'); assert.equal(original.expected, '3');
  assert.match(original.t1CountRecordError, /controlled count observation failure/); assert.equal(original.t1CountRejectedSnapshot.snapshot, board);
  results.push({ name: 'observer-failure-keeps-comparison', error: String(original), secondary: original.t1CountRecordError, rejected: original.t1CountRejectedSnapshot });
  if (process.env.SILVERHAND_T1_HOST_EVIDENCE) {
    mkdirSync(process.env.SILVERHAND_T1_HOST_EVIDENCE, { recursive: true });
    writeFileSync(join(process.env.SILVERHAND_T1_HOST_EVIDENCE, 'count-helper.json'), JSON.stringify({ cases: results.length, results,
      scope: 'Actual helper, controlled plain snapshots/observer;no DOM,React,network,device or deadline execution' }, null, 2));
  }
});

// Reader controls use real serialized DOM; owner/geometry/flash are explicit models.
test('T1 exact system event reader rejects text aliases and mismatched locate state',async()=>{
 const w=new Window({url:'https://localhost/#/chat/w/W/c/C'}),d=w.document;
 const sample=()=>w.eval(taskEventStateExpression('E','C'));
 const setup=()=>{d.body.innerHTML='<div data-page><div data-message-list data-system-jump-state="located" data-system-jump-message-id="E"><div data-system-message-id="E" data-message-conversation-id="C" class="msg-jump-flash">created #1</div></div></div>';d.querySelector('[data-message-list]').dataset.systemJumpOwner=JSON.stringify(['C','E',1]);d.querySelector('[data-system-message-id]').getBoundingClientRect=()=>({left:0,top:100,right:100,bottom:130,width:100,height:30});};
 const accepted=v=>v.messageCount===1&&v.eventVisible&&v.eventFlashed&&v.eventLocated;
 const controls=[['valid',()=>{},true],['ordinary-alias',()=>{d.querySelector('[data-system-message-id]').outerHTML='<div id="msg-E">created #1</div>'},false],['wrong-event',()=>d.querySelector('[data-system-message-id]').dataset.systemMessageId='other',false],['wrong-conversation',()=>d.querySelector('[data-system-message-id]').dataset.messageConversationId='other',false],['duplicate',()=>d.querySelector('[data-message-list]').append(d.querySelector('[data-system-message-id]').cloneNode(true)),false],['unlocated',()=>d.querySelector('[data-message-list]').dataset.systemJumpState='locating',false],['failed',()=>d.querySelector('[data-message-list]').dataset.systemJumpState='failed',false],['no-flash',()=>d.querySelector('[data-system-message-id]').classList.remove('msg-jump-flash'),false],['old-owner',()=>d.querySelector('[data-message-list]').dataset.systemJumpOwner=JSON.stringify(['C','other',1]),false],['invalid-generation',()=>d.querySelector('[data-message-list]').dataset.systemJumpOwner=JSON.stringify(['C','E',0]),false],['outside',()=>d.querySelector('[data-system-message-id]').getBoundingClientRect=()=>({left:0,top:99999,right:100,bottom:100029,width:100,height:30}),false]];
 const results=[];try{for(const[name,mutate,expected]of controls){setup();mutate();const value=sample();assert.equal(Boolean(accepted(value)),expected,name);results.push({name,expected,value})}if(process.env.SILVERHAND_T1_HOST_EVIDENCE){mkdirSync(process.env.SILVERHAND_T1_HOST_EVIDENCE,{recursive:true});writeFileSync(join(process.env.SILVERHAND_T1_HOST_EVIDENCE,'event-reader.json'),JSON.stringify({scope:'real serialized reader;state/geometry/flash modeled',results},null,2));}}finally{await w.happyDOM.close()}
});
