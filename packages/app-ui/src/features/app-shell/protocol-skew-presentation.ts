import type { BackendInfoSnapshot } from "@/features/computers/hooks/hooks";
import { t } from "@/lib/i18n";

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
  compat: OutboundProtocolCompatibility | null,
): ProtocolSkewView | null {
  if (!compat) return null;
  switch (compat.status) {
    case "app_update_required":
      return {
        title: t("appShell.skew.appTitle"),
        detail: t("appShell.skew.appDetail"),
      };
    case "server_update_required":
      return {
        title: t("appShell.serverUpdateRequired"),
        detail: t("appShell.skew.serverDetail"),
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
