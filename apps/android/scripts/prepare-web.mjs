import { cpSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const app = resolve(fileURLToPath(new URL('..', import.meta.url)));
const run = process.env.SILVERHAND_ANDROID_RUN_ROOT;
const assets = run ? resolve(run, 'app-build/web-assets') : resolve(app, 'app/build/web-assets');
rmSync(assets, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });
cpSync(run ? resolve(run, 'web') : resolve(app, 'dist'), resolve(assets, 'public'), { recursive: true });
writeFileSync(
  resolve(assets, 'capacitor.config.json'),
  JSON.stringify({
    appId: 'com.silverhand.android.stage1',
    appName: 'Silverhand',
    webDir: 'dist',
    loggingBehavior: 'none',
    plugins: { SystemBars: { style: 'DARK' } },
    server: { hostname: 'localhost', androidScheme: 'https' },
  }),
);
writeFileSync(resolve(assets, 'capacitor.plugins.json'), '[]');
