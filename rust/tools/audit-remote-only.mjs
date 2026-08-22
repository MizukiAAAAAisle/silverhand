import { spawnSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const [outputArgument] = process.argv.slice(2);
if (!outputArgument) {
  throw new Error('usage: node audit-remote-only.mjs <output-dir>');
}

const cargo = spawnSync('cargo', ['--version'], { stdio: 'ignore' });
if (!cargo.error || cargo.error.code !== 'ENOENT') {
  throw new Error('remote-only gate requires an execution PATH without Cargo');
}

const outputDir = path.resolve(outputArgument);
const files = await listFiles(outputDir);
const expected = [
  'composition.json',
  'contract.json',
  'wire.ts',
  'wire.zod.ts',
];
if (JSON.stringify(files) !== JSON.stringify(expected)) {
  throw new Error(`remote-only artifact drift: ${JSON.stringify(files)}`);
}

const composition = JSON.parse(
  await readFile(path.join(outputDir, 'composition.json'), 'utf8'),
);
if (composition.profile !== 'remote-only' || composition.backend !== null) {
  throw new Error('remote-only composition must contain no backend lifecycle');
}

for (const relative of files) {
  const lower = relative.toLowerCase();
  if (
    /(^|\/)(backend|migrations?)(\/|$)/.test(lower)
    || /(^|\/)(cargo\.(toml|lock)|.*\.rs|.*\.rlib|.*\.rmeta)$/.test(lower)
    || /(sqlite|sqlx|rusqlite|\.db(?:-|$)|\.node$)/.test(lower)
  ) {
    throw new Error(`forbidden backend/SQLite/Rust artifact: ${relative}`);
  }
  const info = await stat(path.join(outputDir, relative));
  if (info.size > 256 * 1024) {
    throw new Error(`unexpected large remote-only artifact: ${relative}`);
  }
}

process.stdout.write(`remote-only contract artifact passed: ${files.join(', ')}\n`);

async function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path.join(directory, entry.name), relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`non-regular remote-only entry: ${relative}`);
    }
  }
  return files.sort();
}
