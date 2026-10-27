import WebSocket from 'ws';
export async function connect(port = 19322) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find((t) => t.type === 'page' && t.url.startsWith('https://localhost'));
  if (!target) throw Error('Silverhand WebView not found: ' + JSON.stringify(targets));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => {
    ws.once('open', ok);
    ws.once('error', no);
  });
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id) {
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        clearTimeout(p.timer);
        m.error ? p.no(Error(JSON.stringify(m.error))) : p.ok(m.result);
      }
    }
  });
  function send(method, params = {}) {
    return new Promise((ok, no) => {
      const id = ++seq;
      pending.set(id, {
        ok,
        no,
        timer: setTimeout(() => {
          pending.delete(id);
          no(Error('CDP timeout ' + method));
        }, 30000),
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  return { send, evaluate, close: () => ws.close() };
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const c = await connect();
  try {
    console.log(JSON.stringify(await c.evaluate(process.argv[2])));
  } finally {
    c.close();
  }
}
