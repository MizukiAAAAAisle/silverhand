import { describe, expect, it } from 'vitest';
import {
  buildHostDiagnosticsText,
  type HostDiagnosticsInput,
  type HostDiagnosticsStatusInput,
} from '../src/host-diagnostics.js';

function baseInput(): HostDiagnosticsInput {
  return {
    generated_at: Date.parse('2026-07-10T02:00:00.000Z'),
    computer: {
      id: 'host-1',
      name: 'studio-mini',
      display_label: 'Studio Mini',
      kind: 'remote',
      provisioning_source: 'user_invite',
      status: 'active',
      placeable: true,
      created_at: Date.parse('2026-07-10T01:00:00.000Z'),
      last_seen_at: Date.parse('2026-07-10T01:59:00.000Z'),
      activated_at: Date.parse('2026-07-10T01:00:01.000Z'),
      finalized_at: Date.parse('2026-07-10T01:00:02.000Z'),
      revoked_at: null,
      connected_host_name: 'studio-mini.local',
    },
    status: {
      availability: 'available',
      last_seen_at: Date.parse('2026-07-10T01:59:00.000Z'),
      snapshot: {
        os: 'macOS 15.5',
        os_arch: 'arm64',
        daemon_version: '0.0.0',
        daemon_pid: 12345,
        started_at: Date.parse('2026-07-10T01:40:00.000Z'),
        uptime_ms: 1_200_000,
      },
      agents: [
        {
          handle: '@Cindy',
          runtime: 'codex',
          online: 'online',
        },
      ],
    },
    app: {
      server_url: 'https://silverhand.ai',
      mode: 'remote',
    },
    fetch: {
      computer: 'success',
      status: 'success',
    },
  };
}

describe('buildHostDiagnosticsText', () => {
  it('serializes the v1 diagnostics text from allowlisted fields', () => {
    const text = buildHostDiagnosticsText(baseInput());

    expect(text).toContain('Silverhand computer diagnostics\n');
    expect(text).toContain('Generated: 2026-07-10T02:00:00.000Z\n');
    expect(text).toContain('Computer\n- Label: Studio Mini\n- ID: host-1\n');
    expect(text).toContain('- Availability: available\n');
    expect(text).toContain('- OS: macOS 15.5\n');
    expect(text).toContain('Agents\n- Count: 1\n- @Cindy · codex · online\n');
    expect(text).toContain('- Server URL: https://silverhand.ai\n');
    expect(text).toContain('- Mode: remote\n');
  });

  it('does not leak extra secret-shaped runtime properties', () => {
    const input = baseInput() as HostDiagnosticsInput & {
      auth_token: string;
      error_message: string;
    };
    input.auth_token = 'top-level-token-value';
    input.error_message = 'GET https://example.invalid?connect_token=token-value failed';
    (input.app as typeof input.app & {
      auth_token: string;
      refresh_token: string;
    }).auth_token = 'backend-auth-value';
    (input.app as typeof input.app & {
      auth_token: string;
      refresh_token: string;
    }).refresh_token = 'backend-refresh-value';
    (input.computer as typeof input.computer & {
      host_token: string;
      connect_token: string;
    }).host_token = 'host-token-value';
    (input.computer as typeof input.computer & {
      host_token: string;
      connect_token: string;
    }).connect_token = 'connect-token-value';
    (input.status!.agents[0] as HostDiagnosticsStatusInput['agents'][number] & {
      agent_id: string;
      display_name: string;
      bearer: string;
    }).agent_id = 'agent-id-value';
    (input.status!.agents[0] as HostDiagnosticsStatusInput['agents'][number] & {
      agent_id: string;
      display_name: string;
      bearer: string;
    }).display_name = 'Agent Display Name';
    (input.status!.agents[0] as HostDiagnosticsStatusInput['agents'][number] & {
      agent_id: string;
      display_name: string;
      bearer: string;
    }).bearer = 'agent-bearer-value';

    const text = buildHostDiagnosticsText(input);

    expect(text).not.toContain('token-value');
    expect(text).not.toContain('auth-value');
    expect(text).not.toContain('refresh-value');
    expect(text).not.toContain('host-token-value');
    expect(text).not.toContain('connect-token-value');
    expect(text).not.toContain('agent-id-value');
    expect(text).not.toContain('Agent Display Name');
    expect(text).not.toContain('agent-bearer-value');
    expect(text).not.toContain('example.invalid');
    expect(text).not.toContain('connect_token');
  });

  it('carries only normalized fetch error classification', () => {
    const input = {
      ...baseInput(),
      status: null,
      fetch: {
        computer: 'success',
        status: 'error',
        error_kind: 'network',
      },
    } satisfies HostDiagnosticsInput;

    const text = buildHostDiagnosticsText(input);

    expect(text).toContain('- Status fetch: error\n');
    expect(text).toContain('- Fetch error: network\n');
    expect(text).not.toContain('Error:');
  });

  it('degrades unavailable fields to placeholders', () => {
    const text = buildHostDiagnosticsText({
      ...baseInput(),
      status: {
        availability: 'unreachable',
        reason: 'timeout',
        last_seen_at: null,
        agents: [],
      },
      app: null,
      fetch: {
        computer: 'success',
        status: 'success',
      },
    });

    expect(text).toContain('- Reason: timeout\n');
    expect(text).toContain('- OS: (unavailable)\n');
    expect(text).toContain('- Count: 0\n');
    expect(text).toContain('- Server URL: (unavailable)\n');
    expect(text).toContain('- Fetch error: (unavailable)\n');
  });
});
