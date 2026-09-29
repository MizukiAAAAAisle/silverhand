import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { collectDmg, validateInputs } from './desktop-dmg.mjs';

const valid = {
  version: '0.4.1',
  event: 'push',
  ref: 'refs/tags/desktop-v0.4.1',
  remoteUrl: 'https://silverhand.ai',
};

test('exact Desktop version tags and manual branch builds are accepted', () => {
  validateInputs(valid);
  validateInputs({ ...valid, event: 'workflow_dispatch', ref: 'refs/heads/main' });
});

test('mismatched tags, other releases and unsupported events fail closed', () => {
  for (const ref of [
    'refs/heads/main',
    'refs/tags/daemon-v0.4.1',
    'refs/tags/desktop-v0.4.2',
    'refs/tags/desktop-v0.4.1-build.abc',
  ]) {
    assert.throws(() => validateInputs({ ...valid, ref }), /tag must exactly match/);
  }
  assert.throws(() => validateInputs({ ...valid, event: 'pull_request' }), /Unsupported/);
});

test('missing, credential-bearing, local and non-origin URLs fail before building', () => {
  for (const remoteUrl of [
    undefined,
    '',
    'http://example.com',
    'https://localhost',
    'https://127.0.0.2',
    'https://[::1]',
    'https://user:pass@example.com',
    'https://example.com/api',
    'https://example.com/?token=x',
    'https://example.com/#x',
  ]) {
    assert.throws(() => validateInputs({ ...valid, remoteUrl }));
  }
});

test('collects only each variant DMG with a matching portable SHA256 sidecar', async (t) => {
  const base = resolve('.cache/task-2634-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const variant of ['embedded', 'remote-only']) {
    const source = resolve(root, 'apps/desktop', `release-ci-${variant}`);
    await mkdir(source, { recursive: true });
    await assert.rejects(collectDmg(root, variant, valid.version), /exactly one/);
    await writeFile(resolve(source, 'builder-name.dmg'), '');
    await assert.rejects(collectDmg(root, variant, valid.version), /Empty/);
    const bytes = Buffer.from(`DMG fixture: ${variant}`);
    await writeFile(resolve(source, 'builder-name.dmg'), bytes);
    await writeFile(resolve(source, 'do-not-upload.zip'), 'zip');
    await writeFile(resolve(source, 'extra.dmg'), bytes);
    await assert.rejects(collectDmg(root, variant, valid.version), /exactly one/);
    await rm(resolve(source, 'extra.dmg'));
    const output = await collectDmg(root, variant, valid.version);
    const name = `Silverhand-0.4.1-${variant}-arm64.dmg`;
    assert.deepEqual((await readdir(output)).sort(), [name, `${name}.sha256`]);
    assert.deepEqual(await readFile(resolve(output, name)), bytes);
    assert.equal(
      await readFile(resolve(output, `${name}.sha256`), 'utf8'),
      `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`,
    );
    await assert.rejects(collectDmg(root, variant, valid.version), /must be empty/);
  }
  await assert.rejects(collectDmg(root, '../other', valid.version), /Unknown/);
});
