// TLS reverse proxy to an isolated Rust backend; default is transparent.
// Only explicit reviewed S2 fixtures enable the bounded HTTP fault/hold control.
import https from 'node:https';
import { TaskWriteObserver } from './t2-observer.mjs';
import { T1TlsEvidence, tracedHeaders } from './t1-tls-evidence.mjs';
import http from 'node:http';
import net from 'node:net';
import { readFileSync, appendFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { dirname, isAbsolute } from 'node:path';
// Only enabled by the separately reviewed S2 fixture manifest. No product hooks.
export class SearchControl {
  constructor(file, events, { now = Date.now, maxBudgetMs = 20000 } = {}) {
    if (!isAbsolute(file) || !isAbsolute(events) || dirname(file) !== dirname(events)) throw Error('S2 control/output identity mismatch');
    try { if (lstatSync(events).isSymbolicLink()) throw Error('S2 event symlink refused'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.file = file; this.events = events; this.now = now;
    this.maxBudgetMs = Math.min(20000, maxBudgetMs);
    this.sessions = new Map(); this.uses = new Map(); this.definitions = new Map(); this.pending = new Map();
    this.sequence = 0; this.eventCount = 0;
    this.read();
  }
  read() {
    const info = lstatSync(this.file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw Error('Invalid S2 control file');
    const spec = JSON.parse(readFileSync(this.file, 'utf8'));
    if (spec.version !== 1 || spec.unit !== 'search-isolation' || !/^device-[0-9]{3,}$/.test(spec.attempt) ||
        !Array.isArray(spec.users) || spec.users.length > 2 || !spec.users.every(v => typeof v === 'string' && v.length <= 100) ||
        !Array.isArray(spec.queries) || spec.queries.length > 32 || !spec.queries.every(v => /^b3s2[a-z0-9]{8,100}$/.test(v)) ||
        typeof spec.active !== 'boolean' || (spec.releaseAll !== undefined && typeof spec.releaseAll !== 'boolean') ||
        !Array.isArray(spec.rules) || spec.rules.length > 12 ||
        !Array.isArray(spec.release) || !Array.isArray(spec.retry) || spec.release.length > 12 || spec.retry.length > 12) throw Error('Invalid S2 control manifest');
    const ids = new Set();
    for (const rule of spec.rules) {
      if (!['hold', 'error'].includes(rule.kind) || !/^[a-z0-9-]{1,40}$/.test(rule.id) || ids.has(rule.id) ||
          !spec.users.includes(rule.userId) || !spec.queries.includes(rule.params?.q) ||
          Object.keys(rule.params).some(k => !['q','include_identities','limit','workspace_id','user_id','agent_id','from','to'].includes(k)) ||
          !Object.values(rule.params).every(v => typeof v === 'string' && v.length <= 160)) throw Error('Invalid S2 rule');
      const signature = JSON.stringify(rule);
      if (this.definitions.has(rule.id) && this.definitions.get(rule.id) !== signature) throw Error('S2 rule changed after declaration');
      this.definitions.set(rule.id, signature); ids.add(rule.id);
    }
    return spec;
  }
  emit(event, value = {}) {
    if (++this.eventCount > 2000) throw Error('S2 event budget exceeded');
    appendFileSync(this.events, JSON.stringify({ at: this.now(), event, ...value }) + '\n', { mode: 0o600 });
  }
  fingerprint(req) {
    const value = req.headers.authorization;
    return typeof value === 'string' && value.startsWith('Bearer ') ? createHash('sha256').update(value).digest('hex') : null;
  }
  bind(req, status, bytes) {
    if (status !== 200 || bytes.length > 65536) return;
    let body; try { body = JSON.parse(bytes); } catch { return; }
    const spec = this.read(), digest = this.fingerprint(req);
    if (!digest || !spec.users.includes(body.id)) return;
    if (!this.sessions.has(digest) && this.sessions.size >= 4) { this.emit('session_binding_budget'); return; }
    this.sessions.set(digest, body.id);
    this.emit('me_bound', { userId: body.id, sessionDigest: digest });
  }
  begin(req, res) {
    const receivedAt = this.now();
    const url = new URL(req.url, 'https://localhost'), spec = this.read();
    if (!spec.active || req.method !== 'GET' || url.pathname !== '/api/search' || !spec.queries.includes(url.searchParams.get('q'))) return null;
    const digest = this.fingerprint(req), userId = this.sessions.get(digest);
    if (!userId || !spec.users.includes(userId)) { this.emit('session_unbound', { q: url.searchParams.get('q') }); return null; }
    const entries = [...url.searchParams.entries()];
    if (new Set(entries.map(([k]) => k)).size !== entries.length) { this.emit('duplicate_parameters', { q: url.searchParams.get('q') }); return null; }
    const params = Object.fromEntries(entries);
    if (Object.keys(params).some(k => !['q','include_identities','limit','workspace_id','user_id','agent_id','from','to'].includes(k)) || Object.values(params).some(v => v.length > 160)) return null;
    const same = (left, right) => Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([k,v]) => right[k] === v);
    const rules = spec.rules.filter(r => r.userId === userId && same(r.params, params));
    if (rules.length > 1) throw Error('Ambiguous S2 rules');
    const rule = spec.active ? rules[0] : undefined;
    const ctx = { id: ++this.sequence, stage: String(spec.stage ?? '').slice(0, 80), receivedAt, params, userId, digest, rule, response: res, ended: false };
    if (rule) {
      const n = (this.uses.get(rule.id) || 0) + 1; this.uses.set(rule.id, n); ctx.use = n;
      if (rule.kind === 'hold' && n !== 1 || rule.kind === 'error' && (n > 3 || n === 3 && !spec.retry.includes(rule.id))) ctx.failure = 'unexpected_request';
    }
    this.emit('received', { request_id: ctx.id, stage: ctx.stage, method: req.method, pathname: url.pathname, params, userId, sessionDigest: digest, rule: rule?.id ?? null, use: ctx.use ?? null });
    res.once('finish', () => { this.emit('downstream_finish', { request_id: ctx.id, status: res.statusCode }); this.finish(ctx); });
    res.once('close', () => {
      if (!res.writableFinished) {
        this.emit('client_disconnect', { request_id: ctx.id, afterRelease: !!ctx.released });
        this.finish(ctx); ctx.upstream?.destroy();
      }
    });
    if (rule && (rule.kind === 'hold' || ctx.use === 1)) {
      this.pending.set(ctx.id, ctx);
      ctx.timer = setTimeout(() => this.fail(ctx, 'total_budget_exceeded'), Math.max(1, this.maxBudgetMs - (this.now() - ctx.receivedAt)));
      ctx.poll = setInterval(() => {
        try {
          const value = this.read();
          if (value.releaseAll || value.release.includes(rule.id)) this.release(ctx, value.releaseAll ? 'finally_release' : 'explicit_release');
        } catch { this.fail(ctx, 'control_read_failed'); }
      }, 25);
    }
    return ctx;
  }
  finish(ctx) {
    if (ctx.ended) return;
    ctx.ended = true; clearTimeout(ctx.timer); clearInterval(ctx.poll); this.pending.delete(ctx.id);
  }
  fail(ctx, reason) {
    if (ctx.ended) return;
    this.emit('control_failure', { request_id: ctx.id, reason, elapsedMs: this.now() - ctx.receivedAt });
    ctx.upstream?.destroy(); this.finish(ctx);
    if (!ctx.response.headersSent) ctx.response.writeHead(502, { 'content-type': 'application/json' });
    ctx.response.end('{"error":"s2_control_failure"}');
  }
  release(ctx, reason) {
    if (ctx.ended || ctx.released) return;
    ctx.released = true;
    this.emit('release', { request_id: ctx.id, reason, elapsedMs: this.now() - ctx.receivedAt });
    // Releasing before upstream completion does not reset or extend the budget.
    if (ctx.deliver) ctx.deliver();
  }
  deliver(ctx, status, headers, bytes) {
    ctx.deliver = () => {
      if (ctx.ended || ctx.response.destroyed) return;
      ctx.response.writeHead(status, headers); ctx.response.end(bytes);
    };
    if (ctx.released) ctx.deliver();
  }
  error(ctx) {
    this.emit('synthetic_fault', { request_id: ctx.id, status: 503, use: ctx.use });
    const bytes = Buffer.from('{"error":"s2_fixture_http_failure"}');
    if (ctx.use === 1) this.deliver(ctx, 503, { 'content-type': 'application/json' }, bytes);
    else { ctx.response.writeHead(503, { 'content-type': 'application/json' }); ctx.response.end(bytes); }
  }
  close() {
    for (const ctx of [...this.pending.values()]) this.fail(ctx, 'proxy_shutdown');
  }
}

// T1 owns only a finite task-read fixture. S2's transport mechanics remain unchanged.
export class TaskReadControl extends SearchControl {
  read() {
    const info = lstatSync(this.file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw Error('Invalid T1 control file');
    const spec = JSON.parse(readFileSync(this.file, 'utf8'));
    const ids = xs => Array.isArray(xs) && xs.length <= 4 && new Set(xs).size === xs.length && xs.every(x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(x));
    if (spec.version !== 1 || spec.unit !== 'task-read' || !/^device-[0-9]{3,}$/.test(spec.attempt) ||
        !ids(spec.users) || spec.users.length > 1 || !ids(spec.taskIds) || !ids(spec.channelIds) || spec.channelIds.length > 3 ||
        !(spec.workspaceId === null || typeof spec.workspaceId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(spec.workspaceId)) ||
        typeof spec.active !== 'boolean' || typeof spec.releaseAll !== 'boolean' ||
        !spec.faultTargets || !(spec.faultTargets.columnChannelId === null || spec.channelIds.includes(spec.faultTargets.columnChannelId)) || !(spec.faultTargets.detailTaskId === null || spec.taskIds.includes(spec.faultTargets.detailTaskId)) ||
        !Array.isArray(spec.routes) || spec.routes.length > 40 || !Array.isArray(spec.rules) || spec.rules.length > 2 ||
        !Array.isArray(spec.release) || !Array.isArray(spec.disarmed) || spec.release.length > 2 || spec.disarmed.length > 2) throw Error('Invalid T1 control manifest');
    const same = (a,b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
    const valid = route => {
      if (!route || typeof route.path !== 'string' || !route.params || Array.isArray(route.params)) return false;
      const keys = Object.keys(route.params);
      if (spec.taskIds.some(id => route.path === '/api/tasks/' + id)) return keys.length === 0;
      if (!['column','counts','facets'].some(face => route.path === '/api/tasks/board/' + face)) return false;
      if (route.path.endsWith('/facets')) return keys.length === 0 || same(route.params, { container: 'workspace' });
      if (keys.some(k => !['container','workspace_id','channel_id','status','limit'].includes(k))) return false;
      const { container, workspace_id, channel_id, status, limit } = route.params;
      if (container !== undefined && container !== 'workspace' || workspace_id !== undefined && workspace_id !== spec.workspaceId || channel_id !== undefined && !spec.channelIds.includes(channel_id)) return false;
      if (channel_id !== undefined && (workspace_id !== spec.workspaceId || container !== 'workspace')) return false;
      return route.path.endsWith('/column') ? ['todo','in_progress','in_review','done','closed'].includes(status) && limit === '20' : status === undefined && limit === undefined;
    };
    if (!spec.routes.every(valid) || new Set(spec.routes.map(r => r.path + JSON.stringify(Object.entries(r.params).sort()))).size !== spec.routes.length) throw Error('T1 observed route outside fixture');
    const signature = JSON.stringify({users:spec.users,workspaceId:spec.workspaceId,taskIds:spec.taskIds,channelIds:spec.channelIds,routes:spec.routes,faultTargets:spec.faultTargets});
    if(spec.users.length){if(this.fixtureSignature && this.fixtureSignature!==signature)throw Error('T1 fixture changed');this.fixtureSignature=signature;}
    const ruleIds = new Set();
    for (const rule of spec.rules) {
      if (!rule || !['column-error','detail-error'].includes(rule.id) || ruleIds.has(rule.id) || rule.kind !== 'error' || !spec.users.includes(rule.userId) ||
          !valid(rule) || !spec.routes.some(r => r.path === rule.path && same(r.params, rule.params)) ||
          (rule.id === 'column-error' ? rule.path !== '/api/tasks/board/column' || rule.params.status !== 'todo' || rule.params.channel_id !== spec.faultTargets.columnChannelId : rule.path !== '/api/tasks/' + spec.faultTargets.detailTaskId)) throw Error('Invalid T1 fault rule');
      ruleIds.add(rule.id);
      const signature = JSON.stringify(rule);
      if (this.definitions.has(rule.id) && this.definitions.get(rule.id) !== signature) throw Error('T1 rule changed after declaration');
      this.definitions.set(rule.id, signature);
    }
    if (![...spec.release,...spec.disarmed].every(id => ['column-error','detail-error'].includes(id))) throw Error('Invalid T1 phase');
    return spec;
  }
  begin(req, res) {
    const receivedAt = this.now(), url = new URL(req.url, 'https://localhost'), spec = this.read();
    if (!spec.active || req.method !== 'GET') return null;
    const entries = [...url.searchParams.entries()];
    if (new Set(entries.map(([k]) => k)).size !== entries.length) return null;
    const params = Object.fromEntries(entries), same = (a,b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
    if (!spec.routes.some(r => r.path === url.pathname && same(r.params, params))) return null;
    const digest = this.fingerprint(req), userId = this.sessions.get(digest);
    if (!spec.users.includes(userId)) { this.emit('session_unbound', { pathname: url.pathname }); return null; }
    const matches = spec.rules.filter(r => r.path === url.pathname && same(r.params, params) && r.userId === userId);
    if (matches.length > 1) throw Error('Ambiguous T1 rules');
    const rule = matches[0], ctx = { id: ++this.sequence, stage: String(spec.stage ?? '').slice(0,80), receivedAt, params, userId, digest, rule, response: res, ended: false };
    if (rule) {
      ctx.use = (this.uses.get(rule.id) || 0) + 1; this.uses.set(rule.id, ctx.use);
      if (ctx.use > 3 || ctx.use === 3 && !spec.disarmed.includes(rule.id)) ctx.failure = 'unexpected_request';
    }
    this.emit('received', { request_id: ctx.id, stage: ctx.stage, method: req.method, pathname: url.pathname, params, userId, sessionDigest: digest, rule: rule?.id ?? null, use: ctx.use ?? null });
    res.once('finish', () => { this.emit('downstream_finish', { request_id: ctx.id, status: res.statusCode }); this.finish(ctx); });
    res.once('close', () => { if (!res.writableFinished) { this.emit('client_disconnect', { request_id: ctx.id, afterRelease: !!ctx.released }); this.finish(ctx); ctx.upstream?.destroy(); } });
    if (rule && ctx.use === 1) {
      this.pending.set(ctx.id, ctx);
      ctx.timer = setTimeout(() => this.fail(ctx, 'total_budget_exceeded'), Math.max(1, this.maxBudgetMs - (this.now() - receivedAt)));
      ctx.poll = setInterval(() => { try { const value = this.read(); if (value.releaseAll || value.release.includes(rule.id)) this.release(ctx, value.releaseAll ? 'finally_release' : 'explicit_release'); } catch { this.fail(ctx, 'control_read_failed'); } }, 25);
    }
    return ctx;
  }
  error(ctx) {
    this.emit('synthetic_fault', { request_id: ctx.id, status: 503, use: ctx.use });
    const bytes = Buffer.from('{"error":"t1_fixture_http_failure"}');
    if (ctx.use === 1) this.deliver(ctx, 503, { 'content-type':'application/json' }, bytes);
    else { ctx.response.writeHead(503, { 'content-type':'application/json' }); ctx.response.end(bytes); }
  }
  fail(ctx, reason) {
    if (ctx.ended) return;
    this.emit('control_failure', { request_id:ctx.id, reason, elapsedMs:this.now()-ctx.receivedAt });
    ctx.upstream?.destroy(); this.finish(ctx);
    if (!ctx.response.headersSent) ctx.response.writeHead(502, {'content-type':'application/json'});
    ctx.response.end('{"error":"t1_control_failure"}');
  }
}

export function proxyHandler({ port = 18480, control = null, tlsEvidence = null, writeObserver = null } = {}) {
  return (req, res) => {
    let ctx, tls, writeCtx;
    try { writeCtx = writeObserver?.attach(req, res); } catch { writeObserver?.fail('attach'); }
    // A primitive captured by this request's attach; never reread stateful spec.
    const tlsFixtureUserId = writeCtx?.tlsFixtureUserId ?? null;
    const tlsFailure = reason => { if (writeObserver) writeObserver.fail(reason); else control?.emit('control_failure', { reason }); };
    try { if (!writeObserver || tlsFixtureUserId && !writeObserver.failed) tls = tlsEvidence?.begin(req); }
    catch { tlsFailure('tls_begin'); }
    if (tls && writeObserver) { req.once('aborted', () => tlsFailure('tls_request_aborted')); res.once('close', () => { if (!res.writableFinished) tlsFailure('tls_downstream_incomplete'); }); }
    try { ctx = control?.begin(req, res); }
    catch { control?.emit('manifest_refused'); } // Refused control stays transparent.
    if (ctx?.failure) { control.fail(ctx, ctx.failure); return; }
    if (ctx?.rule?.kind === 'error' && ctx.use <= 2) { control.error(ctx); return; }
    const upstream = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, reply => {
      try { writeCtx?.reply(reply); } catch { writeObserver?.fail('reply_attach'); }
      const me = (control || writeObserver && tls) && req.method === 'GET' && new URL(req.url, 'https://localhost').pathname === '/api/me';
      const hold = ctx?.rule?.kind === 'hold';
      const parts = []; let size = 0, meTruncated = false, responseEnded = false;
      const hash = createHash('sha256');
      if (ctx) control.emit('upstream_headers', { request_id: ctx.id, status: reply.statusCode });
      if (!hold) { res.writeHead(reply.statusCode, tracedHeaders(reply.headers, tls)); reply.pipe(res); }
      reply.on('data', chunk => {
        size += chunk.length; hash.update(chunk);
        if (hold || me && !meTruncated) {
          if (size > (hold ? 1048576 : 65536)) {
            if (hold) { control.fail(ctx, 'body_budget_exceeded'); reply.destroy(); }
            else { parts.length = 0; meTruncated = true; if (tls && writeObserver) tlsFailure('tls_body_bound'); }
          } else parts.push(chunk);
        }
      });
      reply.on('end', () => {
        responseEnded = true;
        if (ctx) control.emit('upstream_end', { request_id: ctx.id, status: reply.statusCode, bytes: size, sha256: hash.digest('hex') });
        if (me && !meTruncated && control) control.bind(req, reply.statusCode, Buffer.concat(parts));
        if (tls && !meTruncated) {
          try {
            if (writeObserver) {
              if (writeObserver.failed) throw Error('Observer already failed');
              if (reply.statusCode !== 200 || JSON.parse(Buffer.concat(parts)).id !== tlsFixtureUserId) throw Error('TLS fixture response differs');
            }
            tlsEvidence.publish(tls, reply.statusCode, Buffer.concat(parts), writeObserver ? [tlsFixtureUserId] : control.read().users);
          } catch { tlsFailure('tls_publish'); }
        }
        if (hold && !ctx.ended) control.deliver(ctx, reply.statusCode, reply.headers, Buffer.concat(parts));
      });
      reply.on('error', () => { if (ctx) control.fail(ctx, 'upstream_response_error'); if (tls && writeObserver) tlsFailure('tls_response_error'); });
      reply.once('aborted', () => { if (tls && writeObserver) tlsFailure('tls_response_aborted'); });
      reply.once('close', () => { if (!responseEnded && tls && writeObserver) tlsFailure('tls_response_incomplete'); });
    });
    if (ctx) ctx.upstream = upstream;
    upstream.on('error', () => {
      if (writeCtx) writeObserver?.fail('upstream_error');
      if (ctx && !ctx.ended) control.fail(ctx, 'upstream_error');
      else if (!res.destroyed && !res.writableEnded) { if (!res.headersSent) res.writeHead(502); res.end(); }
    });
    req.pipe(upstream); res.on('close', () => upstream.destroy());
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const certs = process.argv[2];
if (process.env.SILVERHAND_T2_OBSERVER && (process.env.SILVERHAND_T1_CONTROL || process.env.SILVERHAND_S2_CONTROL)) throw Error('Only one finite unit observer/control');
const writeObserver = process.env.SILVERHAND_T2_OBSERVER ? new TaskWriteObserver(process.env.SILVERHAND_T2_OBSERVER, process.env.SILVERHAND_T2_EVENTS) : null;
if (process.env.SILVERHAND_S2_CONTROL && process.env.SILVERHAND_T1_CONTROL) throw Error('Only one explicit unit control may run');
const control = process.env.SILVERHAND_T1_CONTROL ? new TaskReadControl(process.env.SILVERHAND_T1_CONTROL, process.env.SILVERHAND_T1_EVENTS) : process.env.SILVERHAND_S2_CONTROL ? new SearchControl(process.env.SILVERHAND_S2_CONTROL, process.env.SILVERHAND_S2_EVENTS) : null;
if (process.env.SILVERHAND_T1_TLS_EVENTS && (!process.env.SILVERHAND_T1_CONTROL || process.env.SILVERHAND_T2_TLS_EVENTS)) throw Error('TLS evidence requires explicit unique T1 control');
if (process.env.SILVERHAND_T2_TLS_EVENTS && (!process.env.SILVERHAND_T2_OBSERVER || process.env.SILVERHAND_T1_CONTROL || process.env.SILVERHAND_S2_CONTROL)) throw Error('TLS evidence requires explicit unique T2 observer');
const tlsFile = process.env.SILVERHAND_T2_TLS_EVENTS || process.env.SILVERHAND_T1_TLS_EVENTS;
const tlsEvidence = tlsFile ? new T1TlsEvidence(tlsFile, { attempt: writeObserver ? dirname(tlsFile) : undefined }) : null;
const server = https.createServer({ key: readFileSync(`${certs}/server.key`), cert: readFileSync(`${certs}/server.pem`) }, proxyHandler({ control, tlsEvidence, writeObserver }));
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(18480, '127.0.0.1', () => {
    upstream.write(
      `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
        Object.entries(req.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n') +
        '\r\n\r\n',
    );
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});
server.listen(29443, '127.0.0.1', () => console.log('Real-backend HTTPS/WSS proxy on 29443'));

if (control) process.once('SIGTERM', () => { control.close(); server.closeAllConnections(); server.close(() => process.exit(0)); });
}
