// Explicit production launcher acceptance: pnpm smoke:embedded-backend [Resources | --sidecar-stage <dir>].
// Never invoked by ordinary build/package; all runtime data below is isolated.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type { EmbeddedRustBackendHandle, EmbeddedRustBackendConfig } from '../apps/desktop/src/main/embedded/embedded-rust-backend.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const root = join(repo, '.cache/embedded-smoke', randomUUID());
for (const name of ['home', 'tmp', 'app-data', 'silverhand-dir']) mkdirSync(join(root, name), { recursive: true });
// Set isolation before importing modules that can resolve app data at initialization.
process.env.SILVERHAND_DIR = join(root, 'silverhand-dir');
process.env.SILVERHAND_MIGRATE = '1';
process.env.HOME = join(root, 'home');
process.env.USERPROFILE = process.env.HOME;
process.env.XDG_DATA_HOME = join(root, 'app-data');
process.env.APPDATA = join(root, 'app-data');
process.env.TMPDIR = join(root, 'tmp');

const { resolveDesktopAppPaths } = await import('../packages/shared/src/app-data-layout.js');
const { DESKTOP_SERVER_API_EPOCH, MINIMUM_SERVER_API_EPOCH,
  DESKTOP_API_EPOCH_HEADER, EVENT_WS_SESSION_COOKIE } = await import('../packages/shared/src/index.js');
const { startDesktopEmbeddedBackend } =
  await import('../apps/desktop/src/main/embedded/embedded-launcher.js');
const paths = resolveDesktopAppPaths(process.env.SILVERHAND_DIR);
mkdirSync(paths.embeddedServer.root, { recursive: true });
let resources = process.argv[2];
if (resources === '--sidecar-stage') {
  const stage = process.argv[3];
  assert.ok(stage, '--sidecar-stage requires the independently built stage directory');
  symlinkSync(stage, join(root, 'silverhand-backend'), 'dir');
  resources = root;
}
let handle: EmbeddedRustBackendHandle | undefined;
let socket: WebSocket | undefined;
const location = {
    isPackaged: Boolean(resources), resourcesPath: resources ?? '', appPath: join(repo, 'apps/desktop'),
};
const config: EmbeddedRustBackendConfig = {
    databasePath: paths.embeddedServer.database, blobsRoot: paths.embeddedServer.blobs,
    logDir: paths.logs, bootstrapTokenPath: paths.embeddedServer.bootstrap,
    listen: { hostname: '127.0.0.1', port: 0 }, allowedOrigins: ['http://localhost:5173'],
    disableSignup: false,
    apiEpoch: { clientEpoch: DESKTOP_SERVER_API_EPOCH, minimumServerEpoch: MINIMUM_SERVER_API_EPOCH },
};
try {
  handle = await startDesktopEmbeddedBackend(location, config, undefined);
  assert.ok(handle.port > 0);
  const origin = handle.url;
  const token = readFileSync(paths.embeddedServer.bootstrap, 'utf8').trim();
  assert.ok(token);
  const headers = { 'content-type': 'application/json', [DESKTOP_API_EPOCH_HEADER]: String(DESKTOP_SERVER_API_EPOCH) };
  const auth = await fetch(new URL('/auth/embedded-bootstrap', origin), {
    method: 'POST', headers, body: JSON.stringify({ token }), signal: AbortSignal.timeout(5000),
  });
  assert.equal(auth.status, 200, `bootstrap status ${auth.status}`);
  const session = await auth.json() as { user_token: string };
  assert.ok(session.user_token);
  const response = await fetch(new URL('/api/workspaces', origin), {
    headers: { ...headers, authorization: `Bearer ${session.user_token}` }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, `migrated human route status ${response.status}`);
  const listing = await response.json() as { workspaces: unknown[] };
  assert.ok(Array.isArray(listing.workspaces), 'human route must return its workspace list');
  const wsUrl = new URL('/api/ws/events', origin);
  wsUrl.protocol = 'ws:';
  socket = new WebSocket(wsUrl, { headers: {
    Origin: origin, Cookie: `${EVENT_WS_SESSION_COOKIE}=${session.user_token}`,
    [DESKTOP_API_EPOCH_HEADER]: String(DESKTOP_SERVER_API_EPOCH),
  } });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('authenticated event WS open timed out')), 5000);
    socket!.once('open', () => { clearTimeout(timer); resolve(); });
    socket!.once('error', error => { clearTimeout(timer); reject(error); });
    socket!.once('close', () => { clearTimeout(timer); reject(new Error('event WS closed before open')); });
  });
  socket.terminate();
  await handle.close();
  console.error('[smoke] expected bad-config rejection follows: empty allowedOrigins; the missing SILVERHAND_ALLOWED_ORIGINS diagnostic is intentional');
  await assert.rejects(startDesktopEmbeddedBackend(location, { ...config, allowedOrigins: [] }, undefined),
    (error: unknown) => typeof error === 'object' && error !== null && 'kind' in error &&
      ['child-exited-early', 'eof-before-frame'].includes(String(error.kind)),
    'bad config must fail through the typed production startup surface');
  assert.equal(existsSync(paths.embeddedServer.bootstrap), false);
  assert.equal(existsSync(`${paths.embeddedServer.bootstrap}.tmp`), false);
  console.error('[smoke] PASS: production verify → Rust-owned migration/close → bound/ready/epoch → bootstrap → human route 200 → authenticated WS open → close; bad-config typed failure reclaimed');
} finally {
  socket?.terminate();
  await handle?.close();
}
