/**
 * Brand-typed seq (S2) — the single definition site for the seq nominal types.
 *
 * Source of truth: `docs/brand-typed-seq-v1.md`. When code conflicts with a
 * name/semantic there, the code is the bug.
 *
 * Why this module exists (the two-axis thesis, doc §1):
 *   - Axis A (space mixing): several distinct quantities are all called `seq`
 *     and typed `number`, so a value from one ordinal space can be
 *     compared/assigned to another. The hard wall is MessageSeq ↔ TransportSeq
 *     (a persisted message ordinal vs. an ephemeral per-WS-scope event counter):
 *     they never legitimately convert. Branding makes that a compile error.
 *   - Axis B (optionality collapse): `map.get(k) ?? 0` conflates "absent" with
 *     "value 0". Branding does NOT fix Axis B — that is handled by explicit
 *     absence (`Seq | undefined`) plus a per-role decision on what "absent"
 *     means (doc §5). This module only carries the brands + the two legal
 *     `number → brand` routes (mint at origin, decode at a boundary).
 *
 * Two base ordinal spaces (genuinely distinct, doc §2):
 *   - MessageSeq   — ordinal of a message within a CONVERSATION (conversation-
 *                    global, NOT per-stream; allocated by `reserveNextSeq`).
 *                    Persisted; survives restart.
 *   - TransportSeq — per-WS-scope fanout event ordinal, for replay/resume.
 *                    Ephemeral; resets on backend restart; unrelated to any
 *                    message.
 * Plus TransportEpoch — the restart generation (a UUID string, NOT a number;
 *   bundling it with TransportSeq recreates the one-number-two-meanings trap).
 *
 * The cursor family (StreamHeadSeq / DeliverySeq / ReadSeq) are all MessageSeq
 * VALUES in a role — positions into the message ordinal, not new spaces (doc
 * §2). We brand a cursor ONLY where it has a mint boundary whose bypass is a
 * bug:
 *   - ReadSeq     — minted via `observe` (streamSourceAtSeq).
 * StreamHeadSeq and DeliverySeq are NOT branded — they are `MessageSeq`
 * (a distinguished max/high-water); their only defect is Axis B.
 *
 * (There is no observed/freshness cursor brand: freshness is no longer a
 * per-stream daemon cursor — it is a whole-runtime backend property — so the
 * former `ObservedSeq` brand and its mint/decode have been retired.)
 */

import { z } from 'zod';

// ── Brands ────────────────────────────────────────────────────────────────────
//
// Nominal typing via a phantom string-literal property key (`__seqBrand`), NOT a
// `unique symbol`. Symbol brands cannot be *named* in the inferred types of
// downstream exported values (zod schemas that embed a branded field), which
// trips `TS4023 "cannot be named"`. A string-literal key is equally nominal —
// two brands with different literal values are mutually non-assignable, and a
// raw `number` lacks the phantom key so it cannot assign to either — while
// staying fully nameable across module boundaries. The key never exists at
// runtime (brands are erased).

// ── Base ordinal spaces ───────────────────────────────────────────────────────

/**
 * Ordinal of a message within a CONVERSATION. Conversation-global (a mainline
 * message and a reply-cluster message in the same conversation draw from ONE
 * sequence), persisted, survives restart. Stream identity
 * `(conversation_id, thread_root_id)` is a SEPARATE coordinate — a MessageSeq
 * only means "a head / cursor for a given stream" when paired with that
 * coordinate, and the brand cannot prevent a stream-key mismatch (that is held
 * by stream-qualified accessors + tests, doc §2/§7).
 */
export type MessageSeq = number & { readonly __seqBrand: 'MessageSeq' };

/**
 * Per-WS-scope fanout event ordinal, for replay/resume. Ephemeral; resets on
 * backend restart; unrelated to any message. A `TransportSeq → MessageSeq` flow
 * is ALWAYS a bug — the brand wall is the contract (doc §2).
 */
export type TransportSeq = number & { readonly __seqBrand: 'TransportSeq' };

/**
 * Restart generation for the WS transport — a UUID string (`crypto.randomUUID()`),
 * NOT a number. Paired with TransportSeq as an opaque `{ epoch, seq }` for resume
 * gap detection. Branding it as a number would encode the very axis error S2 kills.
 */
export type TransportEpoch = string & { readonly __seqBrand: 'TransportEpoch' };

// ── Cursors with mint boundaries (branded) ────────────────────────────────────

/**
 * "Highest MessageSeq the viewer has read in this stream"
 * (`conversation_reads.last_read_seq`). A MessageSeq in the read-cursor role.
 * Minted ONLY through the observe write boundary (`streamSourceAtSeq`) via
 * {@link asReadSeq}; bypassing that boundary skips the read side-effect and is a
 * bug. Absent (never read) ≡ all-unread ≡ cursor before msg 1 — collapsing to 0
 * is CORRECT for this role (doc §5).
 */
export type ReadSeq = number & { readonly __seqBrand: 'ReadSeq' };

// ── Mint helpers — the ONLY places a MessageSeq changes role (doc §4) ──────────

/**
 * Mint a read cursor from a present MessageSeq (the observe write boundary).
 * Takes a PRESENT MessageSeq by construction — there is no `asReadSeq(undefined)`;
 * absence is decided before the mint (doc §5).
 */
export const asReadSeq = (seq: MessageSeq): ReadSeq => seq as unknown as ReadSeq;

// NOTE: there is deliberately NO generic cross-brand ordering helper
// (`isUnread`/`isBeyond`) here. MessageSeq is conversation-global, so a bare
// `cursor < msg` is only meaningful WITHIN one stream; a generic comparator
// would let a mainline cursor be compared to a cluster message with types
// passing, re-opening the stream-key-mismatch bug the brand cannot see (doc §4).
// Comparisons stay inside already-stream-qualified repo/query code. If a shared
// comparator is ever needed it must carry a stream key and assert same-stream.
//
// MessageSeq ↔ TransportSeq: NO conversion exists. Any need to write one is a
// design error (doc §4).

// ── Decode boundaries — the only other `number → brand` (doc §4.1) ────────────

/**
 * Smallest legal MessageSeq origin is 1 (the first reserved message); 0 is the
 * empty-conversation allocator base, never a real message position. Decoders
 * accept the persisted/wire range (>= 0) since role-defined zeros (stream head,
 * allocator) legitimately carry 0; they reject only non-finite / negative /
 * non-integer garbage, which signals a corrupt boundary.
 */
function assertDecodableSeq(n: number, brand: string): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(
      `${brand}: cannot decode ${n} — expected a non-negative integer seq`,
    );
  }
}

/**
 * Decode a raw `number` (crossing back from an untyped medium — DB read, API
 * wire, localStorage hydrate) into a MessageSeq. The validated decoder, NOT a
 * bare `as`, is the legal boundary; a cast outside a mint or a decoder is the
 * escape hatch the fence test forbids (doc §4.1).
 */
export function decodeMessageSeq(n: number): MessageSeq {
  assertDecodableSeq(n, 'MessageSeq');
  return n as MessageSeq;
}

/** Decode a raw `number` (WS frame / persisted counter) into a TransportSeq. */
export function decodeTransportSeq(n: number): TransportSeq {
  assertDecodableSeq(n, 'TransportSeq');
  return n as TransportSeq;
}

/**
 * Advance a TransportSeq by one — the ONLY legal way to move a transport cursor
 * forward. TransportSeq arithmetic (`seq + 1`) degrades to a bare `number`; this
 * re-brands through the validated decoder so the `+1` never escapes un-branded or
 * as a scattered `as TransportSeq`. A single NAMED advance boundary that the
 * backend per-scope allocator and the renderer resume-floor both route through
 * (doc §4).
 *
 * Scope: this proves ONLY that the successor of a transport ordinal is a
 * transport ordinal. It does NOT prove scope/epoch identity — the caller must
 * already hold the same (scope, epoch) context (e.g. epoch checked before
 * advancing a resume floor). It is +1 only: no `by` parameter, and deliberately
 * no predecessor / subtract / range / comparator sibling — a transport cursor
 * only ever moves forward one step, and cross-scope ordering does not exist.
 */
export function advanceTransportSeq(seq: TransportSeq): TransportSeq {
  return decodeTransportSeq(seq + 1);
}

/** Decode a raw `number` (DB read / wire) into a ReadSeq. */
export function decodeReadSeq(n: number): ReadSeq {
  assertDecodableSeq(n, 'ReadSeq');
  return n as ReadSeq;
}

/**
 * Decode a raw `string` (WS frame `epoch`) into a TransportEpoch. Non-empty
 * check only — the value is an opaque `crypto.randomUUID()` produced by the
 * server; the client never parses its structure.
 */
export function decodeTransportEpoch(s: string): TransportEpoch {
  if (typeof s !== 'string' || s.length === 0) {
    throw new RangeError(
      `TransportEpoch: cannot decode ${JSON.stringify(s)} — expected a non-empty string`,
    );
  }
  return s as TransportEpoch;
}

// ── Wire decoders — zod schemas that decode a raw number/string into a brand ──
//
// These ride GENUINE zod-ingress paths only — internal-agent routes, the CLI,
// and any server-side `.parse()` of untrusted input: the schema validates the
// raw value THEN re-brands it, so `z.infer` yields the branded type. They are
// NOT the renderer read path: `renderer/lib/api.ts` is `JSON.parse(body) as T`
// (a typed TRUST boundary, no zod), so renderer-facing brands are minted
// server-side at DTO construction, never re-parsed per hook (doc §4.1). zod's
// `.int().nonnegative()` runs first, so the `decode*` transform never throws —
// malformed input surfaces as a normal `ZodError`, not a `RangeError`.

const nonNegativeIntSchema = z.number().int().nonnegative();

/** Wire schema whose parsed output is a {@link MessageSeq}. */
export const MessageSeqSchema = nonNegativeIntSchema.transform(decodeMessageSeq);
/** Wire schema whose parsed output is a {@link TransportSeq}. */
export const TransportSeqSchema = nonNegativeIntSchema.transform(decodeTransportSeq);
/** Wire schema whose parsed output is a {@link ReadSeq}. */
export const ReadSeqSchema = nonNegativeIntSchema.transform(decodeReadSeq);
/** Wire schema whose parsed output is a {@link TransportEpoch}. */
export const TransportEpochSchema = z
  .string()
  .min(1)
  .transform(decodeTransportEpoch);
