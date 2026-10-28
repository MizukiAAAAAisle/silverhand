import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
const result = await build({
  stdin: {
    contents: `export { nativeProtocolJson as default } from './apps/ios/native-protocol.ts';`,
    resolveDir: new URL('../../..', import.meta.url).pathname,
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { default: nativeProtocolJson } = await import(
  'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
);
writeFileSync(process.argv[2], nativeProtocolJson());
