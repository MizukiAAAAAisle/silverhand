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
export type ChannelErrorCode = 'not_found';

export class ChannelError extends Error {
  constructor(
    public readonly code: ChannelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelError';
  }
}
