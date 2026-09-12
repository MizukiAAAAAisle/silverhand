// Build-time projection only. Runtime Rust embeds this data and never invokes Node.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));
const { build } = require('esbuild');
const result = await build({
  stdin: {
    contents: `export {migrations} from './packages/shared/src/db/migrations.ts'; export * from './packages/shared/src/db/schema-epochs.ts';`,
    resolveDir: root,
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  metafile: true,
});
const source = result.outputFiles[0].text;
const plan = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
plan.assertSchemaEpochManifest();
plan.assertSupportPolicyFloors();
const output = {
  minimumSupportedStep: plan.MIN_SUPPORTED_MIGRATION_STEP,
  oneToOneCeiling: plan.ONE_TO_ONE_EPOCH_CEILING_STEP,
  epochs: plan.SCHEMA_EPOCH_MANIFEST,
  inputs: Object.fromEntries(
    Object.keys(result.metafile.inputs)
      .filter((p) => p !== '<stdin>')
      .sort()
      .map((p) => {
        const path = resolve(root, p);
        return [
          relative(root, path),
          createHash('sha256').update(readFileSync(path)).digest('hex'),
        ];
      }),
  ),
  steps: plan.migrations.map((m) => ({
    version: m.version,
    name: m.name,
    up: m.up,
    foreignKeyEscape: !!m.foreignKeyEscape,
    precondition: !!m.precondition,
  })),
};
const target = resolve(root, 'packages/shared/src/db/rust-migrations.generated.json');
const text = JSON.stringify(output, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== text)
    throw Error('Rust migration projection stale; run node scripts/generate-rust-migrations.mjs');
} else writeFileSync(target, text);
