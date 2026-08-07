import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { CdpClient } from './cdp-client.mjs';

test('CDP client sends commands, receives results, and dispatches events', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));

  server.on('connection', socket => {
    socket.on('message', raw => {
      const command = JSON.parse(String(raw));
      socket.send(JSON.stringify({ id: command.id, result: { echoed: command.method } }));
      socket.send(JSON.stringify({ method: 'Fixture.event', params: { ready: true } }));
    });
  });

  const address = server.address();
  assert.notEqual(typeof address, 'string');
  const client = await CdpClient.connect(`ws://127.0.0.1:${address.port}`);
  t.after(async () => {
    client.close();
    await new Promise(resolve => server.close(resolve));
  });

  const event = new Promise(resolve => client.on('Fixture.event', resolve));
  assert.deepEqual(await client.send('Runtime.enable'), { echoed: 'Runtime.enable' });
  assert.deepEqual(await event, { ready: true });
});

test('CDP errors retain the method that failed', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  server.on('connection', socket => {
    socket.once('message', raw => {
      const command = JSON.parse(String(raw));
      socket.send(
        JSON.stringify({ id: command.id, error: { code: -32_601, message: 'unknown method' } }),
      );
    });
  });

  const address = server.address();
  assert.notEqual(typeof address, 'string');
  const client = await CdpClient.connect(`ws://127.0.0.1:${address.port}`);
  t.after(async () => {
    client.close();
    await new Promise(resolve => server.close(resolve));
  });

  await assert.rejects(client.send('Missing.method'), /Missing\.method failed/);
});
