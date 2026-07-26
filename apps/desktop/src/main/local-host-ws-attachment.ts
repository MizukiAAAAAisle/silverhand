/**
 * `#task:1630` — the ONE producer of {@link LocalHostWsAttachment}.
 *
 * Minting this discriminant is a two-line ternary, which is exactly
 * why it needs a named home: both plausible-looking shortcuts are
 * wrong, and both compile.
 *
 *   1. `observable: getEmbeddedHostWsController() !== null` — that
 *      helper returns null for TWO different reasons: the remote arm
 *      (no in-process registry) and an embedded backend whose
 *      controller accessor is missing (an upstream bug). Reporting the
 *      second as unobservable tells the renderer to stop waiting on an
 *      attach that is merely stuck.
 *   2. `observable: attachedAt !== null` — collapses the discriminant
 *      back into the timestamp it was introduced to replace.
 *
 * Observability is a property of WHERE the registry lives, i.e. of the
 * backend handle's kind, and of nothing else. Keeping the derivation
 * here (rather than inline in the `BackendInfo` producer) is what lets
 * a unit test falsify both shortcuts without booting Electron —
 * `main/index.ts` then contains no `observable:` literal at all, so a
 * future inline mint is visible as a fence failure instead of a shape
 * that merely looks right (Cindy's `#task:1630` review of
 * `e82f8a23`: "producer 行为用可执行 seam/falsifier 测").
 */
import type { LocalHostWsAttachment } from '../backend-info-contract.js';

export function describeLocalHostWsAttachment(input: {
  /**
   * `BackendHandle.kind` — the discriminant of the handle this process
   * is actually serving. Deliberately NOT nullable: "there is no
   * backend handle yet" is not an attachment state, it is a reason the
   * caller has no `BackendInfo` to return at all (`backend:info`
   * answers `null`), so callers must prove a live handle first.
   */
  backendKind: 'embedded' | 'remote';
  /**
   * The registry's attach timestamp for the local host, or null when
   * the host is unclaimed / claimed-but-not-attached. Ignored on the
   * remote arm — where the caller cannot have read a real one anyway,
   * and passing one must not promote the attachment to observable.
   */
  attachedAt: number | null;
}): LocalHostWsAttachment {
  if (input.backendKind === 'embedded') {
    return { observable: true, attached_at: input.attachedAt };
  }
  return { observable: false };
}
