import type { BackendInfoSnapshot } from "@/features/computer-shell/hooks/hooks";

type OutboundProtocolCompatibility = BackendInfoSnapshot["outbound_protocol_compatibility"];

export interface ProtocolSkewView {
  /** Primary, action-forward line rendered in the banner. */
  title: string;
  /** Optional second line — used only where it stops the user from
   *  mis-reading the pause as "my app broke". `null` when the title
   *  already carries the whole message. */
  detail: string | null;
}

/**
 * Map the projected compatibility state to banner copy, or `null` when
 * no banner should show. Exhaustive over the discriminated union — a new
 * status arm fails the typecheck here rather than silently rendering
 * nothing.
 */
export function describeProtocolSkew(
  compat: OutboundProtocolCompatibility,
): ProtocolSkewView | null {
  if (!compat) return null;
  switch (compat.status) {
    case "app_update_required":
      return {
        title: "Silverhand update required",
        detail:
          "This version is incompatible with the server. Update Silverhand to restore agent connectivity.",
      };
    case "server_update_required":
      return {
        title: "Server update required",
        detail:
          "The server uses an incompatible protocol version. Agent operations are unavailable until the server is updated.",
      };
    case "compatible":
    case "unknown":
      return null;
    default: {
      const _exhaustive: never = compat;
      return _exhaustive;
    }
  }
}
