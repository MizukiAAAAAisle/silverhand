import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { friendlyDeleteAgentError } from './delete-agent-error';

describe('friendlyDeleteAgentError', () => {
  it('maps host_attach_pending to an action-oriented computer connection message', () => {
    const err = new ApiError(
      503,
      'Service Unavailable',
      JSON.stringify({
        error: 'host runtime is not currently attached',
        code: 'host_attach_pending',
      }),
    );

    expect(friendlyDeleteAgentError(err)).toBe('Connect the computer first.');
  });

  it('keeps unknown backend codes visible', () => {
    const err = new ApiError(
      409,
      'Conflict',
      JSON.stringify({
        error: 'delete conflict',
        code: 'agent_delete_conflict',
      }),
    );

    expect(friendlyDeleteAgentError(err)).toBe(
      "Couldn't delete the agent: delete conflict (agent_delete_conflict).",
    );
  });
});
