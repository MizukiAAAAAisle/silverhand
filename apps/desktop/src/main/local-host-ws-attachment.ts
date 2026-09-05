/**
 * `#task:1630` / `#task:2343` — the ONE producer of {@link LocalHostWsAttachment}.
 *
 * Minting this discriminant is a two-line ternary, which is exactly why it needs a
 * named home: the plausible-looking shortcuts are wrong, and they compile.
 *
 *   1. `observable: attachmentObserver !== null` at the call site — an observer accessor
 *      can be null for TWO different reasons (no observer by design vs a bug), and only
 *      the caller that knows WHY should decide; this producer takes the settled boolean.
 *   2. `observable: attachedAt !== null` — collapses the discriminant back into the
 *      timestamp it was introduced to replace.
 *
 * `#task:2343`: observability is NOT derived from `backend.kind`. With the out-of-process
 * Rust embedded backend (and remote), Desktop main holds NO authoritative backend
 * registry observer, so `backend.kind` (a DEPLOYMENT-mode discriminant) must never be
 * used to claim the registry is in this process. Observability is exactly "does this
 * process hold a local registry observer?" — a CAPABILITY. Post-2343 no arm does, so
 * this is always `{observable:false}`; the parameter stays so a future in-process
 * observer (if one is ever reintroduced) flips it without touching kind.
 *
 * `observable:false` means "Desktop main cannot directly read the backend's attachment
 * registry" — NOT "not attached". The renderer's connection status comes from the daemon/
 * backend status surfaces, and attach/reload/detach still run the real daemon
 * generation-bound `/ws/host` flow; this discriminant only tells the renderer whether a
 * local `attached_at` can be surfaced.
 */
import type { LocalHostWsAttachment } from '../backend-info-contract.js';

export function describeLocalHostWsAttachment(input: {
  /**
   * Whether Desktop main holds an authoritative in-process backend registry observer
   * (the CAPABILITY, #task:2343). True ONLY when the attachment registry lives in this
   * process. With an out-of-process backend (Rust embedded OR remote) this is false.
   * Deliberately NOT derived from `backend.kind`.
   */
  hasLocalRegistryObserver: boolean;
  /**
   * The registry's attach timestamp for the local host, or null when the host is
   * unclaimed / claimed-but-not-attached. Meaningful only when
   * `hasLocalRegistryObserver` is true; ignored (and must not promote observability)
   * otherwise.
   */
  attachedAt: number | null;
}): LocalHostWsAttachment {
  if (input.hasLocalRegistryObserver) {
    return { observable: true, attached_at: input.attachedAt };
  }
  return { observable: false };
}
