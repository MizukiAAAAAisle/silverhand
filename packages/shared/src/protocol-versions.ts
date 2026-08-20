/**
 * The single WRITE-POINT for every current wire-protocol version number. The
 * five public constants that gate the wire read their value from here and add
 * nothing of their own:
 *
 *   - `host`             → `HOST_PROTOCOL_VERSION`     (`packages/host/src/protocol.ts`)
 *   - `outbound`         → `OUTBOUND_PROTOCOL_VERSION` (`packages/host/src/outbound-protocol.ts`)
 *   - `desktopApi`       → `DESKTOP_SERVER_API_EPOCH`  \
 *   - `desktopMinClient` → `MINIMUM_CLIENT_API_EPOCH`   } `packages/shared/src/desktop-server-api-epoch.ts`
 *   - `desktopMinServer` → `MINIMUM_SERVER_API_EPOCH`  /
 *
 * This record unifies only the NUMBERS. Each axis keeps its own admission
 * semantics, bump rationale, and the manual +1-per-release-tag discipline in
 * its own module and doc — `docs/daemon-outbound-protocol.md` for the two daemon
 * wires, `docs/desktop-server-api-epoch.md` for the desktop epoch triple. These
 * axes are INDEPENDENT: none is tied to another by offset, and none bumps just
 * because it happens to ship in the same artifact.
 *
 * The DB schema epoch is a separate axis with its own authority, not here.
 *
 * `as const` is load-bearing: derived constants must keep their literal types
 * (e.g. `z.literal(OUTBOUND_PROTOCOL_VERSION)`).
 */
export const PROTOCOL_VERSIONS = {
  /** CLI/backend ↔ local daemon (strict-equality hello gate). */
  host: 11,
  /** Remote daemon ↔ standalone server (strict-equality hello gate). */
  outbound: 10,
  /** Desktop ↔ server current epoch (min-window range gate). */
  desktopApi: 3,
  /** Lowest client epoch this server build admits. */
  desktopMinClient: 3,
  /** Lowest server epoch this desktop build accepts. */
  desktopMinServer: 3,
} as const;
