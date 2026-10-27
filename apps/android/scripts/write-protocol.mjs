import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
const result = await build({
  stdin: {
    contents: `import admission from './packages/shared/src/backend-admission.json'; import {apiPaths,authPaths} from './packages/shared/src/api/paths'; export default {...admission,serverInfo:apiPaths.serverInfo,me:apiPaths.me,mePassword:apiPaths.mePassword,login:authPaths.login,signup:authPaths.signup,logout:authPaths.logout,passwordRecoveryRequest:authPaths.passwordRecoveryRequest,passwordRecoveryReset:authPaths.passwordRecoveryReset};`,
    resolveDir: new URL('../../..', import.meta.url).pathname,
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { default: contract } = await import(
  'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
);
writeFileSync(process.argv[2], JSON.stringify(contract, null, 2) + '\n');
