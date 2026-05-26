import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

const workspaceDeps = [
  '@silverhand/shared',
  '@silverhand/backend',
  '@silverhand/server',
];
const nativeExternalDeps = [
  '@node-rs/argon2',
  'bufferutil',
  'utf-8-validate',
];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspaceDeps })],
    build: {
      rollupOptions: {
        external: nativeExternalDeps,
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspaceDeps })],
    build: {
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
