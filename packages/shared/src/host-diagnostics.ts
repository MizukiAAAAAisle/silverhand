import type { HostAvailability, HostLifecycleStatus, HostUnreachableReason } from './api/host.js';
import type { HostKind, HostProvisioningSource } from './db/schema.js';

export type HostDiagnosticsFetchStatus = 'loading' | 'success' | 'error';

export type HostDiagnosticsFetchErrorKind = 'network' | 'forbidden' | 'not_found' | 'unknown';

export interface HostDiagnosticsComputerInput {
  id: string;
  name: string;
  display_label: string | null;
  kind: HostKind;
  provisioning_source: HostProvisioningSource;
  status: HostLifecycleStatus;
  placeable: boolean;
  created_at: number;
  last_seen_at: number | null;
  activated_at: number | null;
  finalized_at: number | null;
  revoked_at: number | null;
  connected_host_name: string | null;
}

export interface HostDiagnosticsStatusInput {
  availability: HostAvailability;
  reason?: HostUnreachableReason;
  last_seen_at?: number | null;
  snapshot?: {
    os: string;
    os_arch?: string | null;
    daemon_version: string;
    daemon_pid: number;
    started_at: number;
    uptime_ms: number;
  };
  agents: Array<{
    handle: string;
    runtime: string;
    online: 'online' | 'offline';
  }>;
}

export interface HostDiagnosticsAppInput {
  server_url: string;
  mode: 'embedded' | 'remote';
}

export interface HostDiagnosticsFetchInput {
  computer: HostDiagnosticsFetchStatus;
  status: HostDiagnosticsFetchStatus;
  error_kind?: HostDiagnosticsFetchErrorKind;
}

export interface HostDiagnosticsInput {
  generated_at: number;
  computer: HostDiagnosticsComputerInput;
  status?: HostDiagnosticsStatusInput | null;
  app?: HostDiagnosticsAppInput | null;
  fetch: HostDiagnosticsFetchInput;
}

const UNAVAILABLE = '(unavailable)';

/**
 * Build the copyable computer diagnostics text.
 *
 * The input type is the allowlist: raw DTOs, profile objects, proxy config,
 * logs, host config, tokens, and raw error messages do not belong here. The
 * serializer still copies fields explicitly so accidental extra runtime
 * properties cannot leak into the text.
 */
export function buildHostDiagnosticsText(input: HostDiagnosticsInput): string {
  const status = input.status ?? null;
  const app = input.app ?? null;
  const computerLabel = input.computer.display_label?.trim() || input.computer.name;
  const lines: string[] = [
    'Silverhand computer diagnostics',
    `Generated: ${formatTimestamp(input.generated_at)}`,
    '',
    'Computer',
    `- Label: ${formatValue(computerLabel)}`,
    `- ID: ${formatValue(input.computer.id)}`,
    `- Kind: ${formatValue(input.computer.kind)}`,
    `- Provisioning: ${formatValue(input.computer.provisioning_source)}`,
    `- Lifecycle: ${formatValue(input.computer.status)}`,
    `- Placeable: ${formatBoolean(input.computer.placeable)}`,
    `- Created: ${formatTimestamp(input.computer.created_at)}`,
    `- Last seen: ${formatOptionalTimestamp(input.computer.last_seen_at)}`,
    `- Activated: ${formatOptionalTimestamp(input.computer.activated_at)}`,
    `- Finalized: ${formatOptionalTimestamp(input.computer.finalized_at)}`,
    `- Revoked: ${formatOptionalTimestamp(input.computer.revoked_at)}`,
    '',
    'Connection',
    `- Availability: ${formatValue(status?.availability)}`,
    `- Reason: ${formatValue(status?.reason)}`,
    `- Last seen: ${formatOptionalTimestamp(status?.last_seen_at ?? null)}`,
    `- Attached name: ${formatValue(input.computer.connected_host_name)}`,
    '',
    'Environment',
  ];

  if (status?.snapshot) {
    lines.push(
      `- OS: ${formatValue(status.snapshot.os)}`,
      `- Architecture: ${formatValue(status.snapshot.os_arch)}`,
      `- Daemon version: ${formatValue(status.snapshot.daemon_version)}`,
      `- Uptime: ${formatDurationMs(status.snapshot.uptime_ms)}`,
      `- Daemon PID: ${formatValue(status.snapshot.daemon_pid)}`,
      `- Started: ${formatTimestamp(status.snapshot.started_at)}`,
    );
  } else {
    lines.push(
      `- OS: ${UNAVAILABLE}`,
      `- Architecture: ${UNAVAILABLE}`,
      `- Daemon version: ${UNAVAILABLE}`,
      `- Uptime: ${UNAVAILABLE}`,
      `- Daemon PID: ${UNAVAILABLE}`,
      `- Started: ${UNAVAILABLE}`,
    );
  }

  lines.push('', 'Agents', `- Count: ${status?.agents.length ?? 0}`);
  if (status?.agents.length) {
    for (const agent of status.agents) {
      lines.push(
        `- ${formatValue(agent.handle)} · ${formatValue(agent.runtime)} · ${formatValue(agent.online)}`,
      );
    }
  }

  lines.push(
    '',
    'App',
    `- Server URL: ${formatValue(app?.server_url)}`,
    `- Mode: ${formatValue(app?.mode)}`,
    `- Computer fetch: ${formatValue(input.fetch.computer)}`,
    `- Status fetch: ${formatValue(input.fetch.status)}`,
    `- Fetch error: ${formatValue(input.fetch.error_kind)}`,
  );

  return `${lines.join('\n')}\n`;
}

function formatValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === '') return UNAVAILABLE;
  return String(value);
}

function formatBoolean(value: boolean): string {
  return value ? 'true' : 'false';
}

function formatTimestamp(value: number): string {
  if (!Number.isFinite(value)) return UNAVAILABLE;
  return new Date(value).toISOString();
}

function formatOptionalTimestamp(value: number | null | undefined): string {
  return value === null || value === undefined ? UNAVAILABLE : formatTimestamp(value);
}

function formatDurationMs(value: number): string {
  if (!Number.isFinite(value)) return UNAVAILABLE;
  const totalSeconds = Math.floor(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}
