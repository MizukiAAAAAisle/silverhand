import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWeb } from './prepare-web.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'silverhand-web-control-')); const source = join(root, 'web'); const assets = join(root, 'web-assets');
  for (const variant of ['normal', 'acceptance']) {
    mkdirSync(join(source, variant), { recursive: true });
    writeFileSync(join(source, variant, 'index.html'), variant);
    writeFileSync(join(source, variant, 'android-web-build.json'), JSON.stringify({ kind: 'silverhand-android-web-v1', variant,
      modules: ['apps/android/src/main.ts'] }));
  }
  return { root, source, assets };
}
test('prepares separate public roots and removes old shared assets instead of merging them', () => {
  const f = fixture(); try {
    mkdirSync(join(f.assets, 'public'), { recursive: true }); writeFileSync(join(f.assets, 'public', 'legacy.js'), 'old shared bytes');
    prepareWeb(f.source, f.assets);
    assert.equal(readFileSync(join(f.assets, 'normal/public/index.html'), 'utf8'), 'normal');
    assert.equal(readFileSync(join(f.assets, 'acceptance/public/index.html'), 'utf8'), 'acceptance');
    assert.equal(existsSync(join(f.assets, 'public')), false);
  } finally { rmSync(f.root, { recursive: true }); }
});
test('rejects a normal root bound to acceptance output and a missing variant before copying', () => {
  for (const fault of ['wrong-variant', 'missing']) {
    const f = fixture(); try {
      if (fault === 'missing') rmSync(join(f.source, 'acceptance'), { recursive: true });
      else cpSync(join(f.source, 'acceptance'), join(f.source, 'normal'), { recursive: true });
      assert.throws(() => prepareWeb(f.source, f.assets));
      assert.equal(existsSync(f.assets), false);
    } finally { rmSync(f.root, { recursive: true }); }
  }
});

test('rejects retired diagnostics in either variant without replacing current assets', () => {
  for (const variant of ['normal', 'acceptance']) for (const id of ['apps/android/src/notification-test.ts', 'packages/app-ui/src/pages/settings/components/notification-diagnostics-pane.tsx']) {
    const f = fixture(); try {
      mkdirSync(f.assets, { recursive: true }); writeFileSync(join(f.assets, 'sentinel'), 'keep');
      const path = join(f.source, variant, 'android-web-build.json');
      const metadata = JSON.parse(readFileSync(path, 'utf8')); metadata.modules.push(id);
      writeFileSync(path, JSON.stringify(metadata));
      assert.throws(() => prepareWeb(f.source, f.assets), /Invalid Android/);
      assert.equal(readFileSync(join(f.assets, 'sentinel'), 'utf8'), 'keep');
    } finally { rmSync(f.root, { recursive: true }); }
  }
});
