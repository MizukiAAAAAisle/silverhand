/**
 * The title-address observation face (#task:2016).
 *
 * This is what replaced retired-title ownership. The settled model forgets an
 * old title the instant it is released: no tombstone row, no allocation history,
 * nothing to ask "who has this address had?". The log is therefore the ONLY
 * record of address movement, and the only evidence available later for deciding
 * whether historical ownership is worth building. "Who took the title I just
 * gave up" is answered by CORRELATING these lines on the folded key — that
 * correlation is the machine the ticket chose over a tombstone table, so the key
 * has to appear on every line that moves one.
 *
 * WARN, NOT INFO. `~/.silverhand/logs` runs at `warn` by default, so an `info`
 * line does not reach disk at all — during dogfooding these events would exist
 * only in a level nobody is running. They are also bounded: a rename, a
 * creation and a refusal are each a deliberate human action on a channel, not
 * per-message traffic. (The unbounded member of the family — `#conv:` fallback
 * on the header read surface — is deliberately NOT here: it is aggregated per
 * window, and it lands with the resolver in #task:2021.)
 *
 * NOT EVERY BIRTH IS AN EVENT. The addresses minted while a workspace or an
 * agent is being provisioned (`application/create-workspace.ts`,
 * `application/create-agent.ts`) are deliberately unlogged: they are written in
 * the same transaction that creates the workspace holding them, so their key
 * cannot be one anybody released — there is nothing to correlate them with, and a
 * line per provisioning would only dilute the ones that mean something.
 *
 * WHAT THE LINES CARRY: stable ids and the FOLDED KEY. The key is the address, * so it is the correlation handle and cannot be redacted away without deleting
 * the event's whole purpose; the display title, message bodies and every other
 * piece of user prose stay out. No actor either — the subject of every one of
 * these events is a CONVERSATION's address, attribution already lives in the
 * rename system message inside the channel and in the request log, and a field
 * that only some lines could fill would make the family harder to correlate than
 * it makes it to audit. `snake_case` to match the other audit surface an operator
 * greps (`admin_op` in admin.ts) rather than the camelCase of ordinary
 * diagnostic logging: these lines are read by people and by `jq`, not while
 * chasing a stack trace.
 */
import type { BackendLogger } from '../context.js';

export interface TitleAddressMoved {
  workspaceId: string;
  conversationId: string;
  /**
   * The key this conversation RELEASED — free for anyone the moment this
   * commits. Read from the row, not recomputed from the old title: a half-state
   * (a stored key that no longer matches its title) is detectable rather than
   * impossible, and the address that was actually occupied is the stored one.
   * `null` only if the row somehow held no key at all, which the placement arc
   * CHECK forbids for a workspace placement.
   */
  fromKey: string | null;
  toKey: string;
}

export interface TitleAddressTaken {
  workspaceId: string;
  conversationId: string;
  key: string;
}

export interface TitleAddressRefused {
  workspaceId: string;
  /** The key already held by someone else. */
  key: string;
  /**
   * The conversation that asked, when one exists: a rename knows which channel
   * was refused, a creation has no id yet because nothing was inserted.
   */
  conversationId: string | null;
}

/**
 * Event 1 — a conversation's address MOVED. Emitted post-commit: an attempt that
 * rolled back moved nothing, and a line claiming otherwise would poison the
 * correlation this face exists for.
 *
 * A re-spelling that folds to the same key (`general` → `General`) still emits,
 * with `from_key === to_key`: the display text changed, and a reader comparing
 * the two fields can tell that class apart from a real move.
 */
export function logTitleAddressMoved(
  logger: BackendLogger,
  event: TitleAddressMoved,
): void {
  logger.warn(
    {
      title_address_event: 'moved',
      workspace_id: event.workspaceId,
      conversation_id: event.conversationId,
      from_key: event.fromKey,
      to_key: event.toKey,
    },
    'title address moved',
  );
}

/**
 * Event 2's other half — an address was TAKEN by a new conversation. Post-commit
 * for the same reason as `moved`.
 *
 * On its own this is unremarkable; correlated by key against an earlier `moved`,
 * it is exactly "the title X gave up is now Y's", which is the question the
 * deleted tombstone table used to answer.
 */
export function logTitleAddressTaken(
  logger: BackendLogger,
  event: TitleAddressTaken,
): void {
  logger.warn(
    {
      title_address_event: 'taken',
      workspace_id: event.workspaceId,
      conversation_id: event.conversationId,
      key: event.key,
    },
    'title address taken',
  );
}

/**
 * Event 3 — a request for an address already in use was REFUSED
 * (`conversation_title_taken`, 409). Emitted at the throw, inside the write
 * transaction: the refusal is final there — it aborts the transaction and no
 * caller retries it — and unlike the two events above it describes something
 * that did NOT happen, so there is no commit to wait for.
 *
 * Volume here is what would tell us the single-address-space model is too tight
 * for real use, which is why a refusal is worth a durable line at all.
 */
export function logTitleAddressRefused(
  logger: BackendLogger,
  event: TitleAddressRefused,
): void {
  logger.warn(
    {
      title_address_event: 'refused',
      workspace_id: event.workspaceId,
      conversation_id: event.conversationId,
      key: event.key,
    },
    'title address refused: already taken',
  );
}
