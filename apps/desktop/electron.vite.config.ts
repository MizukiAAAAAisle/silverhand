import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

// Owner: desktop build. The electron-vite 6 beta supplies the supported Vite 8
// integration; replace the pinned beta when electron-vite 6 stable is released.
const remoteOnly = process.env.SILVERHAND_DESKTOP_REMOTE_ONLY === '1';
const allowInsecureRemote =
  process.env.SILVERHAND_DESKTOP_ALLOW_INSECURE_REMOTE === '1';
const packagedDefaultServerUrl =
  process.env.SILVERHAND_DESKTOP_DEFAULT_SERVER_URL ?? '';

function readMinifySetting(): false | 'oxc' {
  const raw = process.env.SILVERHAND_MINIFY;
  if (raw == null || raw === '') return 'oxc';

  switch (raw.toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return 'oxc';
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      throw new Error(`SILVERHAND_MINIFY must be true or false (got: ${raw})`);
  }
}

const minify = readMinifySetting();

const workspaceDeps = [
  '@silverhand/shared',
  '@silverhand/backend',
  '@silverhand/server',
];
// Workspace packages are bundled here and must stay out of packaged app
// production dependencies; electron-builder follows pnpm workspace symlinks
// outside apps/desktop and fails packaging.
const nativeExternalDeps = [
  '@node-rs/argon2',
  'bufferutil',
  'utf-8-validate',
];

export default defineConfig({
  main: {
    define: {
      __SILVERHAND_DESKTOP_REMOTE_ONLY__: JSON.stringify(remoteOnly),
      __SILVERHAND_DESKTOP_ALLOW_INSECURE_REMOTE__: JSON.stringify(
        allowInsecureRemote,
      ),
      __SILVERHAND_DESKTOP_DEFAULT_SERVER_URL__: JSON.stringify(
        packagedDefaultServerUrl,
      ),
      // #task:1530 — desktop release telemetry build metadata. Injected from env
      // set by scripts/package.sh before build. MAIN ONLY — not preload/renderer.
      __SILVERHAND_BUILD_COMMIT__: JSON.stringify(
        process.env.SILVERHAND_BUILD_COMMIT ?? '',
      ),
      __SILVERHAND_BUILD_DIRTY__: JSON.stringify(
        process.env.SILVERHAND_BUILD_DIRTY === '1',
      ),
    },
    resolve: {
      alias: remoteOnly
        ? {
            '@silverhand/server': resolve(
              __dirname,
              'src/main/remote-only-server-stub.ts',
            ),
          }
        : {},
    },
    build: {
      externalizeDeps: { exclude: workspaceDeps },
      minify,
      rolldownOptions: {
        external: nativeExternalDeps,
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    define: {
      __SILVERHAND_DESKTOP_REMOTE_ONLY__: JSON.stringify(remoteOnly),
      __SILVERHAND_DESKTOP_ALLOW_INSECURE_REMOTE__: JSON.stringify(
        allowInsecureRemote,
      ),
      __SILVERHAND_DESKTOP_DEFAULT_SERVER_URL__: JSON.stringify(
        packagedDefaultServerUrl,
      ),
    },
    build: {
      externalizeDeps: { exclude: workspaceDeps },
      minify,
      rolldownOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    define: {
      __SILVERHAND_DESKTOP_REMOTE_ONLY__: JSON.stringify(remoteOnly),
      __SILVERHAND_DESKTOP_ALLOW_INSECURE_REMOTE__: JSON.stringify(
        allowInsecureRemote,
      ),
      __SILVERHAND_DESKTOP_DEFAULT_SERVER_URL__: JSON.stringify(
        packagedDefaultServerUrl,
      ),
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
      },
    },
    build: {
      minify,
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
    plugins: [react(), tailwindcss()],
  },
});
