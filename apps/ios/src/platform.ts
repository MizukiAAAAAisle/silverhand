import type { ClientPlatform, ClientAuthState } from "@silverhand/client";
import { classifyMeFetchOutcome } from "@silverhand/client";
import {
  ServerInfoSchema,
  UpgradeRequiredBodySchema,
  classifyDesktopServerApiCompatibility,
  DESKTOP_SERVER_API_EPOCH,
  MINIMUM_SERVER_API_EPOCH,
} from "@silverhand/shared";
import type { NativeBridge } from "./bridge";
import { NativeEventSocket } from "./event-socket";
import { createIOSNavigation } from "./navigation";
import { createIOSFiles } from "./files";

function parse(text?: string): unknown {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return null;
  }
}

export function createIOSPlatform(
  bridge: NativeBridge,
  resetApplication: () => void,
): ClientPlatform {
  const epochHandlers = new Set<() => void>();
  let upgrade: ClientAuthState | undefined;
  const compatibility = (
    info: ReturnType<typeof ServerInfoSchema.parse>,
  ): ClientAuthState | undefined => {
    const serverEpoch = info.desktop_api?.current_epoch ?? 0;
    const minimumClient = info.desktop_api?.minimum_client_epoch ?? 0;
    const result = classifyDesktopServerApiCompatibility({
      clientEpoch: DESKTOP_SERVER_API_EPOCH,
      minimumClientEpoch: minimumClient,
      serverEpoch,
      minimumServerEpoch: MINIMUM_SERVER_API_EPOCH,
    });
    if (result === "client_too_old")
      return {
        status: "app_update_required",
        server_api_epoch: serverEpoch,
        minimum_client_epoch: minimumClient,
      };
    if (result === "server_too_old")
      return {
        status: "server_update_required",
        server_api_epoch: serverEpoch,
        client_api_epoch: DESKTOP_SERVER_API_EPOCH,
      };
  };

  return {
    navigation: createIOSNavigation(bridge),
    client: {
      getConnectionPolicy: async () => ({ allow_insecure_remote: false }),
      getConnectionInfo: async () => {
        const profile = await bridge.getProfile();
        return profile.server_url ? { url: profile.server_url, mode: "remote" } : null;
      },
      getServerConnectionProfile: async () => {
        const profile = await bridge.getProfile();
        return "updated_at" in profile ? profile : null;
      },
      saveServerConnectionProfile: async ({ serverUrl }) => {
        try {
          const saved = await bridge.saveProfile({ serverUrl });
          // Native validates discovery before committing; no fallible second
          // validation may turn a committed switch into a reported test failure.
          const info = saved.info;
          resetApplication();
          return {
            ok: true,
            profile: saved,
            test: { ok: true, kind: "system_ca_verified", info, originUrl: saved.server_url },
          };
        } catch (error) {
          return {
            ok: false,
            phase: "test",
            test: { ok: false, kind: "network_failed", message: String(error) },
          };
        }
      },
      clearServerConnectionProfile: async () => {
        try {
          const result = await bridge.clearProfile();
          resetApplication();
          return { ok: true, ...result };
        } catch (error) {
          return { ok: false, reason: "unlink_failed", detail: String(error) };
        }
      },
      getAuthState: async () => {
        if (upgrade) return upgrade;
        let serverUrl = "";
        try {
          const profile = await bridge.getProfile();
          serverUrl = profile.server_url ?? "";
          const state = await bridge.authState();
          serverUrl = state.serverUrl;
          if (state.info.status !== 200)
            throw new Error(`Server discovery returned HTTP ${state.info.status}`);
          const info = ServerInfoSchema.parse(parse(state.info.bodyText));
          const skew = compatibility(info);
          if (skew) return skew;
          if (!state.me) return { status: "unauthenticated", signup_enabled: info.signup_enabled };
          const result = classifyMeFetchOutcome({
            kind: "response",
            status: state.me.status,
            body: parse(state.me.bodyText),
          });
          if (result.kind === "valid")
            return {
              status: "authenticated",
              signup_enabled: info.signup_enabled,
              user: result.user,
            };
          if (result.kind === "rejected")
            return { status: "unauthenticated", signup_enabled: info.signup_enabled };
          return { status: "backend_unreachable", server_url: serverUrl, message: result.message };
        } catch (error) {
          return { status: "backend_unreachable", server_url: serverUrl, message: String(error) };
        }
      },
      login: (input) => bridge.authenticate({ action: "login", body: JSON.stringify(input) }),
      signup: (input) => bridge.authenticate({ action: "signup", body: JSON.stringify(input) }),
      logout: async () => {
        await bridge.logout();
        resetApplication();
        return { ok: true };
      },
      backendRequest: async (input) => {
        const response = await bridge.request(input);
        if (
          response.status === 426 &&
          UpgradeRequiredBodySchema.safeParse(parse(response.bodyText)).success
        ) {
          try {
            const state = await bridge.authState();
            const advertised = ServerInfoSchema.safeParse(parse(state.info.bodyText));
            if (advertised.success) {
              upgrade = compatibility(advertised.data);
              if (upgrade) for (const handler of epochHandlers) handler();
            }
          } catch {
            /* A failed discovery probe cannot establish an upgrade requirement. */
          }
        }
        if (response.bodyBase64 !== undefined) {
          return {
            ...response,
            bodyBytes: Uint8Array.from(atob(response.bodyBase64), (char) => char.charCodeAt(0)),
          };
        }
        return response;
      },
      backendUpload: async () => {
        throw new Error("Attachments are not available in this iOS preview");
      },
      recordEventWsDiagnostic: async () => {},
      onEpochUpdateRequired: (handler) => {
        epochHandlers.add(handler);
        return () => {
          epochHandlers.delete(handler);
        };
      },
      openEventSocket: (url) => new NativeEventSocket(bridge, url),
    },
    files: createIOSFiles(bridge),
  };
}
