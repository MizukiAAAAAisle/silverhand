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
   * Another conversation in this workspace already SHOWS this title, compared
   * case-insensitively (#task:2016). The title is the address, so two channels a
   * person cannot tell apart are refused rather than disambiguated: 409, not 400
   * — the request is well-formed and would succeed in another workspace.
   *
   * Never auto-suffixed. A requester who typed `Design` and silently got
   * `Design 2` has been handed a different address than the one they will put in
   * a doc. (The v72 backfill does not suffix either; it refuses to migrate a
   * database that already holds a collision, because it has no requester to ask.)
   *
   * Raised from INSIDE the write transaction, off a read taken under the same
   * lock that will write — not decoded from a constraint violation. The partial
   * UNIQUE index remains the backstop that aborts the transaction if this check
   * was ever wrong.
   *
   * Re-titling a channel to a different SPELLING of its own title (`general` →
   * `General`) is NOT this error: the address does not move, so it succeeds.
   */
  | 'conversation_title_taken'
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
