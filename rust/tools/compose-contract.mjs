import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const rustDir = path.dirname(toolsDir);
const repoDir = path.dirname(rustDir);
const generatedDir = path.join(
  repoDir,
  'packages',
  'shared',
  'src',
  'generated',
  'rust-backend',
);
const outputRoot = path.join(rustDir, 'target', 'contract-compositions');
const [profile, outputArgument] = process.argv.slice(2);

if (!['embedded', 'remote-only'].includes(profile) || !outputArgument) {
  throw new Error(
    'usage: node compose-contract.mjs <embedded|remote-only> <output-dir>',
  );
}

const outputDir = path.resolve(outputArgument);
const relativeOutput = path.relative(outputRoot, outputDir);
if (
  relativeOutput === ''
  || relativeOutput.startsWith('..')
  || path.isAbsolute(relativeOutput)
) {
  throw new Error(`output must be a child of ${outputRoot}`);
}

const artifactNames = ['contract.json', 'wire.ts', 'wire.zod.ts'];
const hash = createHash('sha256');
const descriptor = JSON.parse(
  await readFile(path.join(generatedDir, 'contract.json'), 'utf8'),
);
const transports = [];
if (Object.keys(descriptor.http ?? {}).length > 0) {
  transports.push('http');
}
if (Object.keys(descriptor.webSocket ?? {}).length > 0) {
  transports.push('websocket');
}
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
for (const name of artifactNames) {
  const source = path.join(generatedDir, name);
  const content = await readFile(source);
  hash.update(name);
  hash.update('\0');
  hash.update(content);
  hash.update('\0');
  await copyFile(source, path.join(outputDir, name));
}

await writeFile(
  path.join(outputDir, 'composition.json'),
  `${JSON.stringify(
    {
      profile,
      transport: transports,
      generatedContractSha256: hash.digest('hex'),
      backend: profile === 'embedded' ? { lifecycle: 'optional-sidecar' } : null,
    },
    null,
    2,
  )}\n`,
);
