import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.silverhand.ios',
  appName: 'Silverhand',
  webDir: 'dist',
  loggingBehavior: 'none',
  ios: { contentInset: 'never', preferredContentMode: 'mobile' },
};
export default config;
