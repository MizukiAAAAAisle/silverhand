import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { conversationMessageServiceErrorResponse } from '../../src/routes/responses.js';
import { TargetError } from '../../src/services/conversation-message-service.js';

/** Drive the mapper through a real Hono context and return the HTTP status
 *  it produces (500 when the mapper declines to map the error). */
async function statusFor(err: unknown): Promise<number> {
  const app = new Hono();
  app.get('/', c =>
    conversationMessageServiceErrorResponse(c, err) ?? c.text('unmapped', 500),
  );
  const res = await app.request('/');
  return res.status;
}

describe('conversationMessageServiceErrorResponse — TargetError mapping', () => {
  it('maps reply_target_not_found to 404 (not a 400 bad request)', async () => {
    expect(
      await statusFor(
        new TargetError('reply_target_not_found', 'reply target not found'),
      ),
    ).toBe(404);
  });

  it('keeps closed/archived targets at 409', async () => {
    expect(
      await statusFor(new TargetError('target_closed', 'closed')),
    ).toBe(409);
    expect(
      await statusFor(new TargetError('target_archived', 'archived')),
    ).toBe(409);
  });

  it('defaults other target errors to 400', async () => {
    expect(await statusFor(new TargetError('target_conflict', 'conflict'))).toBe(400);
  });
});
