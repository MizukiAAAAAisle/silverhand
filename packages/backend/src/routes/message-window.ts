// Message-window cursor parser — neutral leaf.
//
// Pure `Context → selector | Response` helper shared by the user-facing message
// window endpoints (conversation channel messages in routes/conversations.ts,
// thread messages). It is a message window query parser, not conversation-
// context private semantics, so it lives in its own neutral leaf.
import type { Context } from 'hono';

/**
 * Parse the cursor query for the user-facing messages window
 * endpoints (channel + thread). Returns either a parsed selector
 * (≤ 1 anchor) or a Hono `Response` carrying a 400 with a stable
 * `code` + `message`. Anchors are mutually exclusive on the wire:
 * if a client sends 2+ at once we refuse before touching the DB so
 * the resulting window is unambiguous and React Query never has to
 * second-guess which cursor a page came from.
 */
export function parseMessagesWindowQuery(c: Context):
  | {
      ok: true;
      limit: number;
      beforeSeq: number | null;
      afterSeq: number | null;
      aroundMessageId: string | null;
    }
  | { ok: false; response: Response } {
  const parsedLimit = Number(c.req.query('limit') ?? 200);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), 500)
    : 200;
  const before = c.req.query('before_seq');
  const after = c.req.query('after_seq');
  const around = c.req.query('around_message_id');

  // Reject any anchor that came in but failed numeric parsing
  // before we count anchors — otherwise a junk `before_seq=foo`
  // would silently degrade to "latest" and surprise the caller.
  // `seq` is monotonically positive in the DB (1-indexed). `0` is
  // intentionally allowed: `after_seq=0` means "page forward from
  // before-the-first row", which is a legitimate way to ask for
  // the earliest window. Negative cursors are rejected.
  let beforeSeq: number | null = null;
  if (before !== undefined) {
    const n = Number(before);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      return {
        ok: false,
        response: c.json(
          {
            error: 'before_seq must be a non-negative integer',
            code: 'invalid_cursor',
          },
          400,
        ),
      };
    }
    beforeSeq = n;
  }
  let afterSeq: number | null = null;
  if (after !== undefined) {
    const n = Number(after);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      return {
        ok: false,
        response: c.json(
          {
            error: 'after_seq must be a non-negative integer',
            code: 'invalid_cursor',
          },
          400,
        ),
      };
    }
    afterSeq = n;
  }
  // Empty `around_message_id=` is a client bug, not "give me
  // latest" — refusing it forces callers to either pass a real
  // anchor or omit the param entirely, so the resulting window
  // is unambiguous.
  if (around !== undefined && around.length === 0) {
    return {
      ok: false,
      response: c.json(
        {
          error: 'around_message_id must be a non-empty message id',
          code: 'invalid_cursor',
        },
        400,
      ),
    };
  }
  const aroundMessageId =
    around !== undefined && around.length > 0 ? around : null;

  const anchorCount =
    (beforeSeq !== null ? 1 : 0) +
    (afterSeq !== null ? 1 : 0) +
    (aroundMessageId !== null ? 1 : 0);
  if (anchorCount > 1) {
    return {
      ok: false,
      response: c.json(
        {
          error:
            'before_seq, after_seq and around_message_id are mutually exclusive',
          code: 'mutually_exclusive_cursors',
        },
        400,
      ),
    };
  }

  return { ok: true, limit, beforeSeq, afterSeq, aroundMessageId };
}
