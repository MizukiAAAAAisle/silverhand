/**
 * #task:1156 — one canonical workspace label so the message-search filter, the
 * archived-channel filter, and the rail can't drift apart again. Pins the `dm-`
 * prefix-stripping convergence (the two agent-space name shapes — UI
 * `dm-Norman` vs bare aggregate `Norman` — must collapse to the same label).
 *
 * #task:2044 changed WHAT that label is: an agent space reads as the agent's
 * name, never `@<agent>`, because the handle form now belongs to the direct pair.
 */
import { describe, expect, it } from 'vitest';
import {
  agentSpaceLabel,
  stripDmPrefix,
  workspaceDisplayName,
} from './workspace-name';

describe('stripDmPrefix', () => {
  it('strips a leading `dm-` (UI WorkspaceListItem shape)', () => {
    expect(stripDmPrefix('dm-Norman')).toBe('Norman');
  });
  it('passes a bare name through (backend aggregate shape)', () => {
    expect(stripDmPrefix('Norman')).toBe('Norman');
  });
  it('only strips a leading `dm-`, not an interior/partial match', () => {
    expect(stripDmPrefix('admin-bot')).toBe('admin-bot');
  });
});

describe('agentSpaceLabel — both name shapes converge to the agent name', () => {
  it('UI `dm-` shape', () => {
    expect(agentSpaceLabel('dm-Norman')).toBe('Norman');
  });
  it('bare aggregate shape', () => {
    expect(agentSpaceLabel('Norman')).toBe('Norman');
  });
  it('carries no `@` — that form is the direct pair\'s (#task:2044)', () => {
    expect(agentSpaceLabel('dm-Norman')).not.toContain('@');
  });
});

describe('workspaceDisplayName — kind drives the form', () => {
  it('regular workspace shows its bare name unchanged', () => {
    expect(workspaceDisplayName({ name: 'Engineering', kind: 'regular' })).toBe(
      'Engineering',
    );
  });
  it('agent space shows the agent name (UI prefix stripped, no `@`)', () => {
    expect(workspaceDisplayName({ name: 'dm-Norman', kind: 'dm' })).toBe('Norman');
  });
});
