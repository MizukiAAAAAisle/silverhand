import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { copyFileSync, writeFileSync } from "node:fs";
import admission from "../../packages/shared/src/backend-admission.json";
import { apiPaths, authPaths } from "../../packages/shared/src/api/paths";

export default defineConfig({
  resolve: { alias: { "@": resolve(import.meta.dirname, "../../packages/app-ui/src") } },
  define: { __SILVERHAND_SIDEBAR_PERF_VARIANT__: JSON.stringify("baseline") },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "ios-native-boundary",
      buildStart() {
        // The native avatar editor draws from the same part library as the web one.
        copyFileSync(
          resolve(
            import.meta.dirname,
            "../../packages/app-ui/src/features/avatar-maker/model/avatar-library.json",
          ),
          resolve(
            import.meta.dirname,
            "native/Sources/SilverhandNative/Resources/AvatarLibrary.json",
          ),
        );
        writeFileSync(
          resolve(import.meta.dirname, "native/Sources/SilverhandNative/Resources/Protocol.json"),
          JSON.stringify(
            {
              ...admission,
              serverInfo: apiPaths.serverInfo,
              me: apiPaths.me,
              mePassword: apiPaths.mePassword,
              login: authPaths.login,
              signup: authPaths.signup,
              logout: authPaths.logout,
              passwordRecoveryRequest: authPaths.passwordRecoveryRequest,
              passwordRecoveryReset: authPaths.passwordRecoveryReset,
            },
            null,
            2,
          ) + "\n",
        );
      },
      generateBundle() {
        const forbidden = [...this.getModuleIds()].filter((id) =>
          /apps\/desktop\/|packages\/(?:host|silverhand-daemon)\/|__vite-browser-external/.test(id),
        );
        if (forbidden.length)
          throw new Error(
            `iOS browser reached native Desktop dependencies: ${forbidden.join(", ")}`,
          );
      },
    },
  ],
});
