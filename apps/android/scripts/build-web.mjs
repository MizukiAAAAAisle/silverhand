import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const app = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = process.env.SILVERHAND_ANDROID_RUN_ROOT ? resolve(process.env.SILVERHAND_ANDROID_RUN_ROOT, 'web') : resolve(app, 'dist');
for (const variant of ['normal', 'acceptance']) {
  const result = spawnSync(process.env.PNPM_BIN ?? 'pnpm', ['--dir', app, 'exec', 'vite', 'build',
    '--outDir', resolve(root, variant), '--emptyOutDir'], {
    stdio: 'inherit', env: { ...process.env, SILVERHAND_ANDROID_WEB_VARIANT: variant },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
