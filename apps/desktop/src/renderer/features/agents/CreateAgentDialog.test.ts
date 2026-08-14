import { describe, expect, it, vi } from 'vitest';
import type { CreateAgentInput } from '@silverhand/shared';
import { createAgentInputFromDraft } from './CreateAgentDialog';

async function submit(
  sessionScope: 'conversation' | 'agent',
): Promise<CreateAgentInput> {
  const mutateAsync = vi.fn(async (input: CreateAgentInput) => input);
  const input = createAgentInputFromDraft({
    name: ' alice ',
    runtime: 'claude',
    model: '',
    hostId: 'host-1',
    sessionScope,
  });
  await mutateAsync(input);
  expect(mutateAsync).toHaveBeenCalledOnce();
  return mutateAsync.mock.calls[0]![0];
}

describe('CreateAgentDialog submit contract', () => {
  it('keeps the default Conversation scope on the compatibility default', async () => {
    await expect(submit('conversation')).resolves.toEqual({
      name: 'alice',
      runtime: 'claude',
      host_id: 'host-1',
    });
  });

  it('sends the explicit Agent scope through the real form payload builder', async () => {
    await expect(submit('agent')).resolves.toEqual({
      name: 'alice',
      runtime: 'claude',
      host_id: 'host-1',
      session_scope: 'agent',
    });
  });
});
