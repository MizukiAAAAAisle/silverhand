import admission from "../../packages/shared/src/backend-admission.json";
import { apiPaths, authPaths } from "../../packages/shared/src/api/paths";

// Single source for native/Sources/SilverhandNative/Resources/Protocol.json: the build writes it
// and the test compares the committed file against it, so the JSON is never edited by hand.
export function nativeProtocol() {
  return {
    _generatedBy: "apps/ios/native-protocol.ts",
    ...admission,
    serverInfo: apiPaths.serverInfo,
    me: apiPaths.me,
    mePassword: apiPaths.mePassword,
    login: authPaths.login,
    signup: authPaths.signup,
    logout: authPaths.logout,
    passwordRecoveryRequest: authPaths.passwordRecoveryRequest,
    passwordRecoveryReset: authPaths.passwordRecoveryReset,
  };
}

export function nativeProtocolJson() {
  return JSON.stringify(nativeProtocol(), null, 2) + "\n";
}
