/**
 * `#task:1462` — pure mapper for the outbound-protocol skew banner.
 *
 * Sibling to `host-status-presentation.ts`: a small, React-free function
 * that turns one projected field into user-facing copy, so the copy and
 * the "which states show a banner" matrix can be pinned by a unit test
 * without rendering React.
 *
 * Source field: `BackendInfoSnapshot.outbound_protocol_compatibility`,
 * computed in desktop main by comparing the app's compiled-in
 * `OUTBOUND_PROTOCOL_VERSION` against the value the connected server
 * advertises on `/api/server/info`. Only two of the four states are
 * actionable; the other two (and `null`) render nothing:
 *
 *   - `app_update_required`    → this app speaks an older protocol than
 *     the server; agents can't run until the user updates Silverhand.
 *     There is no in-app updater for the remote-only build, so the CTA
 *     is "update", not a retry button.
 *   - `server_update_required` → the server is behind this app. The user
 *     can only wait (the poll clears it) or contact an admin — the copy
 *     MUST NOT tell them to update the app.
 *   - `compatible`            → no skew, no banner.
 *   - `unknown` / `null`      → silent by design. An older server predates
 *     the advertised-version signal, so we can't tell skew from "just old
 *     server"; guessing would raise a false "please update" alarm.
 *
 * Copy is deliberately English to match the sibling connection-chrome
 * (`AppStatusBanner` "Can't reach server", `host-status-
 * presentation`) — the two banners share one shell + screen position, so
 * mixing languages would read as broken. Protocol versions are integers
 * (7, 8), not user-facing app versions, so they are intentionally NOT
 * surfaced: they'd be diagnostic noise next to the actionable line.
 */
import type { BackendInfoSnapshot } from '@/features/hosts/hooks';

type OutboundProtocolCompatibility =
  BackendInfoSnapshot['outbound_protocol_compatibility'];

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
    case 'app_update_required':
      return {
        title: 'Silverhand is out of date',
        detail: 'Update Silverhand to reconnect this Computer.',
      };
    case 'server_update_required':
      return {
        title: 'Server is out of date',
        detail: 'Agents will resume once it updates.',
      };
    case 'compatible':
    case 'unknown':
      return null;
    default: {
      const _exhaustive: never = compat;
      return _exhaustive;
    }
  }
}
