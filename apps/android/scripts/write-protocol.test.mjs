import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const writer = 'apps/android/scripts/write-protocol.mjs';
const authority = 'apps/ios/native-protocol.ts';

async function authoritativeBytes(root) {
  const bundle = await build({ entryPoints: [join(root, authority)], bundle: true, platform: 'node', format: 'esm', write: false });
  const { nativeProtocolJson } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  return Buffer.from(nativeProtocolJson());
}

function generate(root, output) {
  const result = spawnSync(process.execPath, [join(root, writer), output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(output);
}

function keepEvidence(name, bytes) {
  const destination = process.env.SILVERHAND_ANDROID_TEST_EVIDENCE;
  if (destination) {
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, name), bytes);
  }
}

test('real Android writer preserves the authoritative JSON bytes and provenance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'android-protocol-'));
  try {
    const actual = generate(repo, join(root, 'Protocol.json'));
    const expected = await authoritativeBytes(repo);
    assert.deepEqual(actual, expected);
    assert.equal(JSON.parse(actual)._generatedBy, authority);
    keepEvidence('Protocol.json', actual);
    keepEvidence('authoritative-Protocol.json', expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an authority-only projection change reaches the real Android writer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'android-protocol-authority-'));
  try {
    for (const name of [writer, authority, 'packages/shared/src/backend-admission.json', 'packages/shared/src/api/paths.ts',
      'packages/shared/src/backend-admission.generated.ts', 'packages/shared/src/daemon-admission.generated.ts']) {
      const destination = join(root, name);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(repo, name), destination);
    }
    symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
    const before = readFileSync(join(root, authority), 'utf8');
    assert.ok(before.includes('...admission,'));
    writeFileSync(join(root, authority), before.replace('...admission,', '...admission, projectionControl: "authority-only",'));
    const actual = generate(root, join(root, 'Protocol.json'));
    assert.deepEqual(actual, await authoritativeBytes(root));
    assert.equal(JSON.parse(actual).projectionControl, 'authority-only');
    keepEvidence('authority-only-change.json', actual);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
