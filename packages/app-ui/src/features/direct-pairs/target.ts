import type { DirectPairCounterpart } from "@silverhand/shared";

/** A draft names a participant; it does not allocate a conversation. */
export type DirectMessageTarget = Pick<DirectPairCounterpart, "kind" | "id">;
