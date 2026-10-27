import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
export default defineConfig({
  resolve: { alias: { '@': resolve(import.meta.dirname, '../../packages/app-ui/src') } },
  define: { __SILVERHAND_SIDEBAR_PERF_VARIANT__: JSON.stringify('baseline') },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'android-native-boundary',
      generateBundle() {
        const forbidden = [...this.getModuleIds()].filter((id) =>
          /apps\/desktop\/|packages\/(?:host|silverhand-daemon)\/|__vite-browser-external/.test(id),
        );
        if (forbidden.length)
          throw new Error(`Desktop dependencies reached Android: ${forbidden.join(', ')}`);
      },
    },
  ],
});
