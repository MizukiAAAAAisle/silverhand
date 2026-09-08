/**
 * Cross-process type contract for `BackendInfo` facts whose meaning is
 * easy to get wrong in exactly one process. Imported (type-only) by
 * desktop main, preload, and — through `preload/api.d.ts` — the
 * renderer, the same way `build-flags.ts` is shared across the three
 * bundles.
 *
 * Why this file exists at all: `BackendInfo` is declared three times
 * (`main/index.ts`, `preload/index.ts`, `preload/api.d.ts`) with only
 * a comment asking the next author to keep the copies "in lock-step".
 * For most fields a drift is caught the first time the renderer reads
 * one. For {@link LocalHostWsAttachment} it would not be: the whole
 * point of the discriminant is that one arm forbids a read, so a copy
 * that quietly drops the discriminant compiles AND runs — it just
 * re-opens the bug class below. One declaration, three importers
 * (Cindy's `#task:1630` review of `e82f8a23`).
 */

/**
 * The registry that owns this fact (`HostWsServerController`) lives in
 * the backend process. In an embedded deployment that IS the desktop
 * main process, so the attachment is observable here; in a remote
 * deployment it lives on the server and this process cannot see it at
 * all. Expressing the second case as `attached_at: null` made "cannot
 * observe" and "claimed, nothing attached yet" the same value, and
 * every consumer had to remember to re-derive the difference from
 * `mode`. Three consumers forgot, in three different ways
 * (`#task:1010` pill stuck on Connecting…, `#task:1132` a connected
 * local computer rendered offline, `#task:1628` a 1.5s poll with no
 * exit condition).
 *
 * So the transport states it instead: `{ observable: false }` means
 * "ask a different authority" (renderer event WS for Desktop→Server,
 * host-status `availability` for a Computer). Inside the observable
 * arm `attached_at: null` keeps its original meaning — claimed, the
 * outbound WS has not landed yet — and a consumer physically cannot
 * read the timestamp without first handling the unobservable arm.
 *
 * NOT part of the contract: "no snapshot yet". This type is total over
 * *snapshots that exist*. A missing / not-yet-fetched `BackendInfo` is
 * a query state, not a third arm — `{ observable: false }` there would
 * tell the renderer to stop waiting on an attach that is merely slow,
 * which is `#task:1010` from the other side. `backend:info` returns
 * `null` for that case and the renderer keeps it as unknown.
 */
export type LocalHostWsAttachment =
  | { observable: true; attached_at: number | null }
  | { observable: false };
