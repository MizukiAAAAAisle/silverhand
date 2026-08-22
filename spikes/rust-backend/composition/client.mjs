import { readFile } from 'node:fs/promises';

const [serverOrigin, body = 'composition proof'] = process.argv.slice(2);
if (!serverOrigin) {
  throw new Error('usage: node client.mjs <server-origin> [message-body]');
}

const contract = JSON.parse(
  await readFile(new URL('./contract.json', import.meta.url), 'utf8'),
);
const httpUrl = new URL(contract.http.createMessage, serverOrigin);
const wsUrl = new URL(contract.webSocket.events, serverOrigin);
wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';

const socket = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener(
    'error',
    () => reject(new Error(`WebSocket connection failed: ${wsUrl}`)),
    { once: true },
  );
});

try {
  const nextEvent = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for WebSocket event')),
      2_000,
    );
    socket.addEventListener(
      'message',
      (message) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(String(message.data)));
        } catch (error) {
          reject(error);
        }
      },
      { once: true },
    );
  });

  const response = await fetch(httpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const created = await response.json();
  const event = await nextEvent;
  if (
    event.type !== 'message_created'
    || event.message?.id !== created.message?.id
  ) {
    throw new Error('HTTP response and WebSocket event do not describe the same message');
  }

  process.stdout.write(`${JSON.stringify({ contractVersion: contract.version, created, event })}\n`);
} finally {
  socket.close();
}
