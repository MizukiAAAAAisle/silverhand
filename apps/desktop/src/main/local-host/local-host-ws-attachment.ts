import type { LocalHostWsAttachment } from "@silverhand/client";

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
