import { describe, expect, it } from 'vitest';
import type { HostDto } from '@silverhand/shared';
import { sortHostsForSidebar } from '@/features/computer_shell/computer_sidebar_shell';

/**
 * #task:808 slice 4 — pure `sortHostsForSidebar` test. Pin the
 * local-first invariant + the label-ordered fallback so a future
 * sort tweak fails the test rather than silently shuffling the
 * Computers sidebar.
 */

function host(input: {
  id: string;
  name?: string;
  display_label?: string | null;
  kind?: 'local' | 'remote';
}): HostDto {
  return {
    id: input.id,
    name: input.name ?? input.id,
    kind: input.kind ?? 'remote',
    display_label: input.display_label ?? null,
    creator_user_id: 'viewer',
    created_at: 1,
    last_seen_at: null,
    activated_at: 1,
    finalized_at: 1,
    connected_host_name: null,
    provisioning_source: input.kind === 'local' ? 'app_install' : 'system',
    status: 'active',
    placeable: true,
    revoked_at: null,
  };
}

describe('sortHostsForSidebar', () => {
  it('returns an empty array unchanged', () => {
    expect(sortHostsForSidebar([], null)).toEqual([]);
  });

  it('places the local host first, regardless of label order', () => {
    const hosts = [
      host({ id: 'aaa', name: 'aaa', display_label: 'Aero' }),
      host({ id: 'zzz', name: 'zzz', display_label: 'Zen' }),
      host({ id: 'local-1', name: 'local', display_label: 'Studio' }),
    ];
    const sorted = sortHostsForSidebar(hosts, 'local-1');
    expect(sorted.map((h) => h.id)).toEqual(['local-1', 'aaa', 'zzz']);
  });

  it('case-insensitive label-ordered fallback when local id missing', () => {
    const hosts = [
      host({ id: '1', display_label: 'beta' }),
      host({ id: '2', display_label: 'Alpha' }),
      host({ id: '3', display_label: 'gamma' }),
    ];
    const sorted = sortHostsForSidebar(hosts, null);
    expect(sorted.map((h) => h.display_label)).toEqual(['Alpha', 'beta', 'gamma']);
  });

  it('falls back to `name` when `display_label` is null', () => {
    const hosts = [
      host({ id: '1', name: 'zebra' }),
      host({ id: '2', name: 'apple', display_label: null }),
      host({ id: '3', name: 'mango' }),
    ];
    const sorted = sortHostsForSidebar(hosts, null);
    expect(sorted.map((h) => h.name)).toEqual(['apple', 'mango', 'zebra']);
  });

  it('local-host anchor still wins even when the local label sorts last', () => {
    const hosts = [
      host({ id: 'a', display_label: 'aaa' }),
      host({ id: 'l', display_label: 'zzz' }), // local; would sort last by label
    ];
    const sorted = sortHostsForSidebar(hosts, 'l');
    expect(sorted.map((h) => h.id)).toEqual(['l', 'a']);
  });
});
