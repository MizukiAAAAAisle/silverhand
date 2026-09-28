import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// Owner: desktop build. The electron-vite 6 beta supplies the supported Vite 8
// integration; replace the pinned beta when electron-vite 6 stable is released.
const remoteOnly = process.env.SILVERHAND_DESKTOP_REMOTE_ONLY === "1";
const allowInsecureRemote = process.env.SILVERHAND_DESKTOP_ALLOW_INSECURE_REMOTE === "1";
const packagedDefaultServerUrl = process.env.SILVERHAND_DESKTOP_DEFAULT_SERVER_URL ?? "";
const sidebarPerfVariant = process.env.SILVERHAND_SIDEBAR_PERF_VARIANT ?? "baseline";

if (!["baseline", "keep-mounted", "compositor-isolation"].includes(sidebarPerfVariant)) {
  throw new Error(
    `SILVERHAND_SIDEBAR_PERF_VARIANT must be baseline, keep-mounted, or compositor-isolation (got: ${sidebarPerfVariant})`,
  );
}

function readMinifySetting(): false | "oxc" {
  const raw = process.env.SILVERHAND_MINIFY;
  if (raw == null || raw === "") return "oxc";

  switch (raw.toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return "oxc";
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new Error(`SILVERHAND_MINIFY must be true or false (got: ${raw})`);
  }
}

const minify = readMinifySetting();

const workspaceDeps = ["@silverhand/shared", "@silverhand/client"];
// Workspace packages are bundled here and must stay out of packaged app
// production dependencies; electron-builder follows pnpm workspace symlinks
// outside apps/desktop and fails packaging.
const nativeExternalDeps = ["bufferutil", "utf-8-validate"];

export default defineConfig({
  main: {
    plugins: [
      {
        name: "desktop-backend-construction-boundary",
        generateBundle() {
          const modules = [...this.getModuleIds()];
          const forbidden = modules.filter(
            (id) =>
              /(?:packages\/(?:backend|server)\/|@silverhand\/(?:backend|server)|better-sqlite3|@node-rs\/argon2)/.test(
                id,
              ) ||
              (remoteOnly &&
                /\/(?:embedded-launcher|embedded-rust-backend|rust-backend-sidecar|embedded-startup-preparation)\.ts$/.test(
                  id,
                )),
          );
          if (forbidden.length)
            throw new Error(
              `desktop graph reached forbidden backend modules: ${forbidden.join(", ")}`,
            );
          console.info(
            `[desktop graph] ${remoteOnly ? "remote-only" : "embedded"}: ${modules.length} modules; TS backend/server and native database absent${remoteOnly ? "; embedded launcher and sidecar absent" : ""}`,
          );
        },
      },
    ],
    define: {
      __SILVERHAND_DESKTOP_REMOTE_ONLY__: JSON.stringify(remoteOnly),
      __SILVERHAND_DESKTOP_ALLOW_INSECURE_REMOTE__: JSON.stringify(allowInsecureRemote),
      __SILVERHAND_DESKTOP_DEFAULT_SERVER_URL__: JSON.stringify(packagedDefaultServerUrl),
      // #task:1530 — desktop release telemetry build metadata. Injected from env
      // set by scripts/package.sh before build. MAIN ONLY — not preload/renderer.
      __SILVERHAND_BUILD_COMMIT__: JSON.stringify(process.env.SILVERHAND_BUILD_COMMIT ?? ""),
      __SILVERHAND_BUILD_DIRTY__: JSON.stringify(process.env.SILVERHAND_BUILD_DIRTY === "1"),
    },
    resolve: {
      alias: remoteOnly
        ? {
            // #task:2343 P0-10 — swap the embedded seam for a throwing stub so the
            // remote-only main graph never imports `@silverhand/backend` (→ no
            // `better-sqlite3`), the Rust launcher, or the sidecar verifier. The `.js`
            // specifier matches the import in `index.ts`.
            "./embedded/embedded-launcher.js": resolve(
              __dirname,
              "src/main/embedded/embedded-launcher.remote-only.ts",
            ),
          }
        : {},
    },
    build: {
      externalizeDeps: { exclude: workspaceDeps },
      minify,
      rolldownOptions: {
        external: nativeExternalDeps,
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    define: {
      __SILVERHAND_DESKTOP_REMOTE_ONLY__: JSON.stringify(remoteOnly),
      __SILVERHAND_DESKTOP_ALLOW_INSECURE_REMOTE__: JSON.stringify(allowInsecureRemote),
      __SILVERHAND_DESKTOP_DEFAULT_SERVER_URL__: JSON.stringify(packagedDefaultServerUrl),
    },
    build: {
      externalizeDeps: { exclude: workspaceDeps },
      minify,
      rolldownOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    define: {
      __SILVERHAND_DESKTOP_REMOTE_ONLY__: JSON.stringify(remoteOnly),
      __SILVERHAND_DESKTOP_ALLOW_INSECURE_REMOTE__: JSON.stringify(allowInsecureRemote),
      __SILVERHAND_DESKTOP_DEFAULT_SERVER_URL__: JSON.stringify(packagedDefaultServerUrl),
      // Performance-harness-only A/B. Production builds omit the env var and
      // therefore compile the existing baseline behavior.
      __SILVERHAND_SIDEBAR_PERF_VARIANT__: JSON.stringify(sidebarPerfVariant),
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "../../packages/app-ui/src"),
      },
    },
    build: {
      minify,
      rolldownOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
        },
      },
    },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "shared-ui-browser-boundary",
        generateBundle() {
          const forbidden = [...this.getModuleIds()].filter((id) =>
            /apps\/desktop\/src\/(?:main|preload)\/|packages\/(?:host|silverhand-daemon)\/|__vite-browser-external/.test(
              id,
            ),
          );
          if (forbidden.length)
            throw new Error(`Browser graph reached native modules: ${forbidden.join(", ")}`);
          console.info("[shared UI graph] native host, preload and Node adapters absent");
        },
      },
    ],
  },
});
