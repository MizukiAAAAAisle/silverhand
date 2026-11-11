import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
const variant = process.env.SILVERHAND_ANDROID_WEB_VARIANT ?? 'normal';
if (variant !== 'normal' && variant !== 'acceptance') throw new Error('Invalid Android web variant');
export default defineConfig({
  resolve: { alias: { '@': resolve(import.meta.dirname, '../../packages/app-ui/src') } },
  define: {
    __SILVERHAND_SIDEBAR_PERF_VARIANT__: JSON.stringify('baseline'),
    __SILVERHAND_ANDROID_ACCEPTANCE__: JSON.stringify(variant === 'acceptance'),
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'android-native-boundary',
      generateBundle(_options, bundle) {
        const forbidden = [...this.getModuleIds()].filter((id) =>
          /apps\/desktop\/|packages\/(?:host|silverhand-daemon)\/|__vite-browser-external/.test(id),
        );
        if (forbidden.length)
          throw new Error(`Desktop dependencies reached Android: ${forbidden.join(', ')}`);
        const repository = resolve(import.meta.dirname, '../..') + '/';
        const modules = [...new Set(Object.values(bundle).flatMap((item) => item.type === 'chunk'
          ? Object.entries(item.modules).filter(([, value]) => value.renderedLength > 0).map(([id]) => id.replace(repository, '')) : []))].sort();
        const hasTest = modules.includes('apps/android/src/notification-test.ts');
        if (hasTest !== (variant === 'acceptance')) throw new Error('Notification test module variant mismatch');
        // Module exclusion alone is insufficient: the ordinary adapter must not
        // retain an active test sender, marker branch or test state host either.
        const javascript = Object.values(bundle).filter((item) => item.type === 'chunk').map((item) => item.code).join('\n');
        const testEntries = ['diagnosticHost', 'sendDiagnosticTest', 'diagnosticTest', 'acceptanceNotificationTest'];
        if (testEntries.some((entry) => javascript.includes(entry) !== (variant === 'acceptance')))
          throw new Error('Notification test implementation variant mismatch');
        if (!modules.includes('packages/app-ui/src/pages/settings/components/notification-diagnostics-pane.tsx'))
          throw new Error('Notification diagnostics view missing from web bundle');
        this.emitFile({ type: 'asset', fileName: 'android-web-build.json',
          source: JSON.stringify({ kind: 'silverhand-android-web-v1', variant, modules, files: Object.keys(bundle).sort() }) });
      },
    },
  ],
});
