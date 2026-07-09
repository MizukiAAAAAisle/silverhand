#!/usr/bin/env node

const port = Number(process.env.SILVERHAND_REMOTE_DEBUGGING_PORT ?? process.argv[2] ?? 9222);
const durationMs = Number(process.env.SILVERHAND_PROFILE_MS ?? process.argv[3] ?? 30_000);
const out = process.env.SILVERHAND_PROFILE_OUT ?? process.argv[4] ?? `/tmp/silverhand-renderer-${Date.now()}.cpuprofile`;

const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
const target = targets.find(
  t => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string',
) ?? targets.find(t => typeof t.webSocketDebuggerUrl === 'string');

if (!target) {
  throw new Error(`No debuggable renderer target found on port ${port}`);
}

console.log(`Profiling ${target.title || target.url} for ${durationMs}ms`);
console.log(`Output: ${out}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await onceOpen(ws);

let seq = 0;
const pending = new Map();
ws.addEventListener('message', event => {
  const msg = JSON.parse(event.data);
  if (!msg.id) return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) {
    p.reject(new Error(`${p.method} failed: ${JSON.stringify(msg.error)}`));
  } else {
    p.resolve(msg.result);
  }
});

function send(method, params = undefined) {
  const id = ++seq;
  const payload = params === undefined ? { id, method } : { id, method, params };
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    pending.set(id, { method, resolve, reject });
  });
}

await send('Profiler.enable');
await send('Profiler.start');
await sleep(durationMs);
const result = await send('Profiler.stop');
await import('node:fs/promises').then(fs =>
  fs.writeFile(out, JSON.stringify(result.profile), 'utf8'),
);
ws.close();
console.log(`Wrote ${out}`);

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function onceOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
