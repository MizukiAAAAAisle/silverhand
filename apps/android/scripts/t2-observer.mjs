// Finite, passive T2 observer. It never responds, delays, retries, or changes a stream.
import { readFileSync, lstatSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

const id = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(x);
export class TaskWriteObserver {
  constructor(file, events, { append = row => appendFileSync(events, JSON.stringify(row) + '\n', { mode: 0o600 }) } = {}) {
    if (!isAbsolute(file) || !isAbsolute(events) || dirname(file) !== dirname(events)) throw Error('T2 paths');
    this.file = file; this.events = events; this.append = append; this.seq = 0; this.request = 0;
    this.journalBytes = 0; this.failed = false; this.sessions = new Map(); this.pending = new Set(); this.signature = null; this.phase = -1;
    writeFileSync(events, '', { flag: 'wx', mode: 0o600 });
    this.emit('observer_start');
  }
  emit(event, fields = {}) {
    if (this.failed) return;
    try {
      if (this.seq >= 512) throw Error('event_limit');
      const row = { seq: this.seq + 1, event, ...fields };
      const bytes = Buffer.byteLength(JSON.stringify(row) + '\n');
      if (this.journalBytes + bytes > 4 * 1024 * 1024) throw Error('journal_bytes');
      this.append(row); this.seq++; this.journalBytes += bytes;
    } catch { this.failed = true; }
  }
  fail(reason) { this.emit('observation_failure', { reason }); this.failed = true; }
  spec() {
    const st = lstatSync(this.file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 16384 || (st.mode & 0o077)) throw Error('config_file');
    const s = JSON.parse(readFileSync(this.file, 'utf8'));
    if (s.version !== 1 || s.unit !== 'task-write' || typeof s.active !== 'boolean') throw Error('config');
    if (!s.active) { if (this.signature) throw Error('deactivated'); return null; }
    if (![s.userId,s.workspaceId,s.channelId].every(id) || typeof s.apiToken !== 'string' || !s.apiToken || s.apiToken.length > 4096 ||
        !Number.isSafeInteger(s.phase) || s.phase < 0 || s.phase > 32 || !/^[a-z0-9-]{1,48}$/.test(s.marker) ||
        !(s.taskId === null || id(s.taskId))) throw Error('config_fields');
    const signature = JSON.stringify([s.userId,s.workspaceId,s.channelId,s.apiToken]);
    if (this.signature && signature !== this.signature) throw Error('fixture_changed');
    this.signature = signature;
    if (s.taskId !== null && s.taskId !== this.taskId) throw Error('task_unproved');
    if (s.phase === this.phase && s.marker !== this.marker) throw Error('marker_changed');
    if (s.phase !== this.phase) {
      if (s.phase !== this.phase + 1) throw Error('phase_gap');
      this.phase = s.phase; this.marker = s.marker;
      this.emit('marker', { phase: s.phase, marker: s.marker, pending: [...this.pending] });
    }
    return s;
  }
  attach(req, res) {
    // Even inactive, retain only bounded /me identities in memory for native login.
    let u; try { u = new URL(req.url, 'https://localhost'); } catch { this.fail('url'); return null; }
    const me = req.method === 'GET' && u.pathname === '/api/me';
    let s; try { s = this.spec(); } catch { this.fail('config_read'); }
    const auth = req.headers.authorization;
    const bound = s && (auth === 'Bearer ' + s.apiToken || this.sessions.get(auth) === s.userId);
    const write = ['POST','PATCH','DELETE'].includes(req.method) && /^\/api\/tasks(?:\/|$)/.test(u.pathname);
    const detail = s && s.taskId && u.pathname === '/api/tasks/' + s.taskId && req.method === 'GET';
    const column = s && req.method === 'GET' && u.pathname === '/api/tasks/board/column' &&
      u.searchParams.get('workspace_id') === s.workspaceId && u.searchParams.get('channel_id') === s.channelId;
    if (!me && !(s && (write || detail || column))) return null;
    if (!me && !bound) { this.fail('actor_unbound'); return null; }
    if (write && !(u.pathname === '/api/tasks' && req.method === 'POST' || s.taskId &&
      ['/api/tasks/' + s.taskId + '/edit','/api/tasks/' + s.taskId + '/status'].includes(u.pathname) && req.method === 'POST')) {
      this.fail('write_outside_fixture'); return null;
    }
    const ctx = { id: ++this.request, me, method: req.method, path: u.pathname, parts: [], bytes: 0, done: false };
    // Same attach/spec result only: TLS must never advance phase by rereading spec.
    Object.defineProperty(ctx, 'tlsFixtureUserId', { value: s && !this.failed ? s.userId : null, enumerable: true });
    if (!me) {
      this.pending.add(ctx.id);
      this.emit('request', { request: ctx.id, phase: this.phase, method: req.method, path: u.pathname, params: Object.fromEntries(u.searchParams), userId: s.userId });
      if (write) {
        req.on('data', b => { ctx.bytes += b.length; if (ctx.bytes > 16384) this.fail('request_bytes'); else ctx.parts.push(b); });
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(ctx.parts).toString());
            const keys = u.pathname === '/api/tasks' ? ['title','body','conversation_id'] : u.pathname.endsWith('/edit') ? ['title','body'] : ['status'];
            if (Object.keys(body).some(k => !keys.includes(k)) || Object.values(body).some(v => typeof v !== 'string') ||
                u.pathname === '/api/tasks' && body.conversation_id !== s.channelId) throw Error('body');
            this.emit('request_body', { request: ctx.id, body });
          } catch { this.fail('request_body'); }
        });
      }
      req.on('aborted', () => this.fail('request_aborted'));
      res.once('finish', () => { ctx.downstream = true; this.finish(ctx); });
      res.once('close', () => { if (!res.writableFinished) this.fail('client_disconnect'); });
    }
    ctx.reply = reply => {
      let n = 0; const parts = [];
      reply.on('data', b => { n += b.length; if (n > 1048576) this.fail('response_bytes'); else parts.push(b); });
      reply.once('error', () => this.fail('response_error'));
      reply.once('end', () => {
        try {
          const raw = Buffer.concat(parts).toString();
          if (!me) this.emit('response_raw', { request: ctx.id, status: reply.statusCode, raw });
          const body = JSON.parse(raw);
          if (me) {
            if (reply.statusCode === 200 && id(body.id) && typeof auth === 'string' && auth.length <= 4200) {
              if (!this.sessions.has(auth) && this.sessions.size >= 8) throw Error('sessions');
              this.sessions.set(auth, body.id);
              if (s && body.id === s.userId) this.emit('native_identity', { userId: body.id });
            }
          } else {
            if (ctx.path === '/api/tasks' && reply.statusCode === 201) {
              if (!id(body.task?.id) || this.taskId && this.taskId !== body.task.id) throw Error('create_identity');
              this.taskId = body.task.id;
            }
            this.emit('response', { request: ctx.id, status: reply.statusCode, body });
            ctx.upstream = true; this.finish(ctx);
          }
        } catch { this.fail('response_body'); }
      });
    };
    return ctx;
  }
  finish(ctx) {
    if (ctx.upstream && ctx.downstream && !ctx.done) {
      ctx.done = true; this.pending.delete(ctx.id); this.emit('terminal', { request: ctx.id });
    }
  }
}

export function readT2Events(text) {
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw Error('T2 journal bytes');
  const rows = text.trim().split('\n').filter(Boolean).map(x => JSON.parse(x));
  if (!rows.length || rows[0].event !== 'observer_start' || rows.length > 512 || rows.some((x,i) => x.seq !== i + 1 || x.event === 'observation_failure')) throw Error('T2 journal incomplete');
  return rows;
}
export function assertT2ZeroWrites(rows, start, end, taskId) {
  const a = rows.filter(x => x.event === 'marker' && x.marker === start), b = rows.filter(x => x.event === 'marker' && x.marker === end);
  if (a.length !== 1 || b.length !== 1 || a[0].seq >= b[0].seq || a[0].pending.length || b[0].pending.length) throw Error('T2 window boundaries');
  const inWindow = rows.filter(x => x.seq > a[0].seq && x.seq < b[0].seq && x.event === 'request');
  if (inWindow.some(x => ['POST','PATCH','DELETE'].includes(x.method) && (x.path === '/api/tasks' || x.path === '/api/tasks/' + taskId || x.path.startsWith('/api/tasks/' + taskId + '/')))) throw Error('T2 unexpected write');
  for (const x of rows.filter(x => x.event === 'request' && x.seq < b[0].seq)) if (!rows.some(t => t.event === 'terminal' && t.request === x.request && t.seq < b[0].seq)) throw Error('T2 unterminated window');
  return { from: a[0].seq, to: b[0].seq, observedWrites: 0 };
}
