import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const compositionDir = path.dirname(fileURLToPath(import.meta.url));
const crateDir = path.dirname(compositionDir);
const allowedOutputRoot = path.join(crateDir, 'target', 'compositions');
const [profile, outputArgument, backendArgument] = process.argv.slice(2);

if (!['embedded', 'remote-only'].includes(profile) || !outputArgument) {
  throw new Error(
    'usage: node compose.mjs <embedded|remote-only> <output-dir> [backend-binary]',
  );
}

const outputDir = path.resolve(outputArgument);
const relativeOutput = path.relative(allowedOutputRoot, outputDir);
if (
  relativeOutput.startsWith('..')
  || path.isAbsolute(relativeOutput)
  || relativeOutput === ''
) {
  throw new Error(`output must be a child of ${allowedOutputRoot}`);
}
if (profile === 'embedded' && !backendArgument) {
  throw new Error('embedded composition requires a prebuilt backend binary');
}
if (profile === 'remote-only' && backendArgument) {
  throw new Error('remote-only composition refuses a backend binary argument');
}

const bindingsDir = path.join(crateDir, 'bindings');
const bindingNames = (await readdir(bindingsDir))
  .filter((name) => name.endsWith('.ts') || name === 'contract.json')
  .sort();
const contractHash = createHash('sha256');
for (const name of bindingNames) {
  contractHash.update(name);
  contractHash.update('\0');
  contractHash.update(await readFile(path.join(bindingsDir, name)));
  contractHash.update('\0');
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(path.join(outputDir, 'client'), { recursive: true });
await copyFile(
  path.join(compositionDir, 'client.mjs'),
  path.join(outputDir, 'client', 'client.mjs'),
);
await copyFile(
  path.join(bindingsDir, 'contract.json'),
  path.join(outputDir, 'client', 'contract.json'),
);

let backend = null;
if (profile === 'embedded') {
  const backendName = 'silverhand-rust-backend-spike';
  const backendDir = path.join(outputDir, 'backend');
  await mkdir(backendDir, { recursive: true });
  await copyFile(path.resolve(backendArgument), path.join(backendDir, backendName));
  await chmod(path.join(backendDir, backendName), 0o755);
  backend = {
    kind: 'sidecar',
    executable: `backend/${backendName}`,
  };
}

const manifest = {
  profile,
  contract: {
    sha256: contractHash.digest('hex'),
    descriptor: 'client/contract.json',
  },
  client: {
    entrypoint: 'client/client.mjs',
    transports: ['http', 'websocket'],
  },
  backend,
};
await writeFile(
  path.join(outputDir, 'composition.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
