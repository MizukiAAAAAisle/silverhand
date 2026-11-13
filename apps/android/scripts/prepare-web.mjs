import { cpSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const app = resolve(fileURLToPath(new URL('..', import.meta.url)));
const run = process.env.SILVERHAND_ANDROID_RUN_ROOT;
export function prepareWeb(source, assets) {
  // Validate both before replacing anything; a missing/misbound variant is fatal.
  for (const variant of ['normal', 'acceptance']) {
    const metadata = JSON.parse(readFileSync(resolve(source, variant, 'android-web-build.json'), 'utf8'));
    if (metadata.kind !== 'silverhand-android-web-v1' || metadata.variant !== variant ||
      !Array.isArray(metadata.modules) ||
      ['packages/app-ui/src/pages/settings/components/notification-diagnostics-pane.tsx', 'apps/android/src/notification-test.ts'].some((id) => metadata.modules.includes(id)))
      throw new Error(`Invalid Android ${variant} web inputs`);
    readFileSync(resolve(source, variant, 'index.html'));
  }
  rmSync(assets, { recursive: true, force: true });
  for (const variant of ['normal', 'acceptance']) {
    const target = resolve(assets, variant);
    mkdirSync(target, { recursive: true });
    cpSync(resolve(source, variant), resolve(target, 'public'), { recursive: true });
    writeFileSync(resolve(target, 'capacitor.config.json'), JSON.stringify({
    appId: 'com.silverhand.android.stage1',
    appName: 'Silverhand',
    webDir: 'dist',
    loggingBehavior: 'none',
    plugins: { SystemBars: { style: 'DARK' } },
    server: { hostname: 'localhost', androidScheme: 'https' },
    }));
    writeFileSync(resolve(target, 'capacitor.plugins.json'), '[]');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareWeb(run ? resolve(run, 'web') : resolve(app, 'dist'),
    run ? resolve(run, 'app-build/web-assets') : resolve(app, 'app/build/web-assets'));
}
