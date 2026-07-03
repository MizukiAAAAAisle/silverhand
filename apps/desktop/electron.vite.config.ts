import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

const remoteOnly = process.env.SILVERHAND_DESKTOP_REMOTE_ONLY === '1';
const packagedDefaultServerUrl =
  process.env.SILVERHAND_DESKTOP_DEFAULT_SERVER_URL ?? '';

function readMinifySetting(): false | 'esbuild' {
  const raw = process.env.SILVERHAND_MINIFY;
  if (raw == null || raw === '') return 'esbuild';

  switch (raw.toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return 'esbuild';
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
      __SILVERHAND_DESKTOP_DEFAULT_SERVER_URL__: JSON.stringify(
        packagedDefaultServerUrl,
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
    plugins: [externalizeDepsPlugin({ exclude: workspaceDeps })],
    build: {
      minify,
      rollupOptions: {
        external: nativeExternalDeps,
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    define: {
      __SILVERHAND_DESKTOP_REMOTE_ONLY__: JSON.stringify(remoteOnly),
      __SILVERHAND_DESKTOP_DEFAULT_SERVER_URL__: JSON.stringify(
        packagedDefaultServerUrl,
      ),
    },
    plugins: [externalizeDepsPlugin({ exclude: workspaceDeps })],
    build: {
      minify,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
      },
    },
    build: {
      minify,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          events: resolve(__dirname, 'src/renderer/events.html'),
        },
      },
    },
    plugins: [react(), tailwindcss()],
  },
});
