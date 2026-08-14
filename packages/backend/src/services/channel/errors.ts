/**
 * Channel-domain application errors that are NOT tied to persistence.
 *
 * `ChannelService` used to raise the repo layer's structural `RepoError`, which
 * forced an application file to type a module that imports the driver. These
 * failures are the service's own judgement — every one of them comes from a
 * repo write returning `null` (row absent / wrong `kind`), never from a driver
 * error — so they belong here, driver-free (#task:1981).
 *
 * The HTTP mapping is unchanged: `routes/responses.ts` maps `not_found` → 404
 * through the same status map as before.
 */
export type ChannelErrorCode =
  | 'not_found'
  /**
   * The requested NAME has already been allocated in this workspace's namespace
   * — currently held, or held once and retired (#task:2016). A refusal, never a
   * silent adjustment: creation and re-addressing never auto-suffix, because a
   * requester who asked for `#design` and got `#design-2` has been handed a
   * different address than the one they typed into a doc. 409, not 400: the
   * request is well-formed and would succeed in another namespace.
   *
   * Raised from INSIDE the write transaction, off an `isAllocated` read taken
   * under the same lock that will write — not decoded from a constraint
   * violation. The primary key remains the backstop that aborts the transaction
   * if the check was ever wrong.
   */
  | 'conversation_name_taken'
  /**
   * The target conversation has no workspace namespace to hold an address, so
   * "change its name" is not a question about it (#task:2016).
   *
   * REACHABLE, not defensive: `conversations.kind` is GENERATED from
   * `roster_policy`, so an agent inbox reports `kind='dm_channel'` and reaches
   * every channel-like door by id — including this one. Without this arm the
   * request would fall through to the namespace's birth trigger and surface as a
   * 500 instead of a stated refusal.
   */
  | 'not_addressable';

export class ChannelError extends Error {
  constructor(
    public readonly code: ChannelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelError';
  }
}
