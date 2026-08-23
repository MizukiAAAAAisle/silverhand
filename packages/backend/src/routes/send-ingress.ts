import type { ZodIssue } from 'zod';
import {
  AgentSendMessageInputSchema,
  MAX_MESSAGE_CONTENT_BYTES,
  MAX_MESSAGE_CONTENT_LABEL,
  SendMessageInputSchema,
  messageContentByteLength,
  messageContentExceedsLimit,
} from '@silverhand/shared';
import type { AgentSendMessageInput, SendMessageInput } from '@silverhand/shared';

/**
 * THE SEND INGRESS: what a create-message body must be, and the exact answer each door gives
 * when it is not. One authority for both send routes.
 *
 * It exists because these decisions are a published contract that a SECOND implementation (the
 * Rust send path) must match, and a parity fixture can only be authoritative if the reference
 * side answers through the same code the routes answer through. While the wrapper lived inline
 * in each route, a cross-language oracle had to restate it, and a change to either route's
 * wording would have left that oracle green (@Cindy, #task:2180 review).
 *
 * What is deliberately NOT here: reading the body off the wire. A route must rethrow the
 * body-limit error rather than fold it into a `400`, and that is an HTTP-layer concern. What the
 * ingress owns is the DECISION that follows — including which value an unreadable body is judged
 * as ({@link UNREADABLE_SEND_BODY}).
 */

/** A body the route could not read is judged as an empty object, so the schema reports the
 *  members a send is missing rather than the parser's own failure. */
export const UNREADABLE_SEND_BODY: unknown = {};

export type SendIngressRefusal =
  | { status: 400; body: { error: string; issues: ZodIssue[] } }
  | {
      status: 413;
      body: {
        error: string;
        code: 'content_too_large';
        max_bytes: number;
        actual_bytes: number;
      };
    };

export type SendIngressOutcome<T> =
  | { admitted: T; refusal?: undefined }
  | { admitted?: undefined; refusal: SendIngressRefusal };

function invalidInput(issues: ZodIssue[]): SendIngressRefusal {
  return { status: 400, body: { error: 'invalid input', issues } };
}

/** The two doors word the content cap differently, and that difference is a contract: a runtime
 *  is told what to do instead, because it can act on the instruction; a person is not, because
 *  their client already converts an oversized paste. */
function contentTooLarge(content: string, instruction: string): SendIngressRefusal {
  return {
    status: 413,
    body: {
      error: `message content exceeds ${MAX_MESSAGE_CONTENT_LABEL} limit${instruction}`,
      code: 'content_too_large',
      max_bytes: MAX_MESSAGE_CONTENT_BYTES,
      actual_bytes: messageContentByteLength(content),
    },
  };
}

/** Shape first, then the size of what it holds: the cap sits outside the schema, so a body that
 *  is both malformed and oversized is answered as malformed. */
export function admitHumanSend(body: unknown): SendIngressOutcome<SendMessageInput> {
  const parsed = SendMessageInputSchema.safeParse(body);
  if (!parsed.success) return { refusal: invalidInput(parsed.error.issues) };
  if (messageContentExceedsLimit(parsed.data.content)) {
    return { refusal: contentTooLarge(parsed.data.content, '') };
  }
  return { admitted: parsed.data };
}

export function admitAgentSend(body: unknown): SendIngressOutcome<AgentSendMessageInput> {
  const parsed = AgentSendMessageInputSchema.safeParse(body);
  if (!parsed.success) return { refusal: invalidInput(parsed.error.issues) };
  if (messageContentExceedsLimit(parsed.data.content)) {
    return {
      refusal: contentTooLarge(parsed.data.content, '; send it as an attachment instead'),
    };
  }
  return { admitted: parsed.data };
}
