/**
 * #task:1156 — one canonical DM/workspace label so the message-search filter,
 * the archived-channel filter, and the rail can't drift apart again. Pins the
 * `dm-` prefix-stripping convergence (the two DM name shapes — UI `dm-Norman`
 * vs bare aggregate `Norman` — must collapse to the same `@Norman` handle).
 */
import { describe, expect, it } from 'vitest';
import {
  dmWorkspaceLabel,
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

describe('dmWorkspaceLabel — both name shapes converge to `@<agentName>`', () => {
  it('UI `dm-` shape', () => {
    expect(dmWorkspaceLabel('dm-Norman')).toBe('@Norman');
  });
  it('bare aggregate shape', () => {
    expect(dmWorkspaceLabel('Norman')).toBe('@Norman');
  });
});

describe('workspaceDisplayName — kind drives the form', () => {
  it('regular workspace shows its bare name unchanged', () => {
    expect(workspaceDisplayName({ name: 'Engineering', kind: 'regular' })).toBe(
      'Engineering',
    );
  });
  it('DM workspace shows `@<agentName>` (UI prefix stripped)', () => {
    expect(workspaceDisplayName({ name: 'dm-Norman', kind: 'dm' })).toBe('@Norman');
  });
});
