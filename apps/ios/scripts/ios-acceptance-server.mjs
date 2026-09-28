// Isolated HTTPS/WSS fixture around the real Rust backend. No user credentials,
// real instance, global trust store, TLS bypass or production port is used.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import tls from 'node:tls';
import net from 'node:net';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const root = path.join(repo, '.cache/ios-acceptance-server');
const simulator = process.argv[2];
if (!simulator) throw new Error('Pass the UUID of a dedicated, booted acceptance simulator');
for (const name of ['tls', 'blobs', 'logs'])
  mkdirSync(path.join(root, name), { recursive: true, mode: 0o700 });
const ssl = (...args) =>
  execFileSync('openssl', args, { cwd: path.join(root, 'tls'), stdio: 'ignore' });
ssl(
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  'ca.key',
  '-out',
  'ca.pem',
  '-days',
  '2',
  '-subj',
  '/CN=Silverhand isolated simulator CA',
  '-addext',
  'basicConstraints=critical,CA:TRUE',
);
ssl(
  'req',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  'server.key',
  '-out',
  'server.csr',
  '-subj',
  '/CN=localhost',
);
writeFileSync(
  path.join(root, 'tls/extensions.cnf'),
  'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n',
);
ssl(
  'x509',
  '-req',
  '-in',
  'server.csr',
  '-CA',
  'ca.pem',
  '-CAkey',
  'ca.key',
  '-CAcreateserial',
  '-out',
  'server.pem',
  '-days',
  '2',
  '-extfile',
  'extensions.cnf',
);
execFileSync(
  'xcrun',
  ['simctl', 'keychain', simulator, 'add-root-cert', path.join(root, 'tls/ca.pem')],
  { stdio: 'inherit' },
);
const child = spawn(path.join(repo, 'rust/target/debug/silverhand-backend'), [], {
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SILVERHAND_DIR: root,
    SILVERHAND_DEPLOYMENT_PROFILE: 'remote-only',
    SILVERHAND_DATABASE_PATH: path.join(root, 'im.db'),
    SILVERHAND_BLOBS_ROOT: path.join(root, 'blobs'),
    SILVERHAND_LOG_DIR: path.join(root, 'logs'),
    SILVERHAND_LISTEN_ADDR: '127.0.0.1:19080',
    SILVERHAND_ALLOWED_ORIGINS: 'https://localhost:19443',
    SILVERHAND_DISABLE_SIGNUP: '0',
    SILVERHAND_MIGRATE: '1',
  },
  stdio: 'inherit',
});
const options = {
  key: readFileSync(path.join(root, 'tls/server.key')),
  cert: readFileSync(path.join(root, 'tls/server.pem')),
};
const servers = ['127.0.0.1', '::1'].map((host) =>
  tls
    .createServer(options, (socket) => {
      const upstream = net.connect(19080, '127.0.0.1');
      socket.pipe(upstream).pipe(socket);
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      socket.on('close', () => upstream.destroy());
    })
    .listen(19443, host),
);
function stop() {
  for (const server of servers) server.close();
  child.kill('SIGTERM');
}
for (const server of servers)
  server.on('error', (error) => {
    console.error(error.message);
    stop();
    process.exitCode = 1;
  });
child.on('error', (error) => {
  console.error(error.message);
  stop();
  process.exitCode = 1;
});
child.on('exit', () => {
  for (const server of servers) server.close();
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log(`HTTPS/WSS fixture: https://localhost:19443; data: ${root}`);
