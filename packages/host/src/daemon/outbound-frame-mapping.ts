import {
  OUTBOUND_PROTOCOL_VERSION,
  OutboundDaemonToServerCommandResponseFrameSchema,
  type OutboundCommandError,
  type OutboundDaemonToServerCommandResponseFrame,
  type OutboundDaemonToServerEventFrame,
  type OutboundServerToDaemonCommandFrame,
} from '../outbound-protocol.js';
import type { EventFrame } from '../protocol.js';

/**
 * D5.a — shared server↔daemon outbound frame mapping.
 *
 * Extracted from `outbound-client.ts` so BOTH daemon transports — the
 * standalone outbound WSS client and the embedded `LocalOutboundFrameServer`
 * — encode command responses and daemon events the same way. Having one
 * copy is the structural guarantee behind D5.a: the wire envelope cannot
 * drift between transports because there is only one mapper.
 */

/**
 * Dispatcher response shape. Identical to the host-IPC `ResponseFrame`
 * shape (id + result|error) but with a wider error code surface: callers
 * may return {@link OutboundCommandError} codes (the per-command typed
 * error union — currently the `agent_materialize` typed codes in addition
 * to the five transport-level codes). Generic IPC `ResponseFrame` values
 * remain assignable because the IPC error union is a subset.
 *
 * {@link toOutboundCommandResponse} re-validates the built frame against
 * the per-command response schema before it is sent, so a dispatcher that
 * returns a typed code on the wrong command is caught at the wire boundary
 * instead of leaking the wider surface to other command kinds (Cindy D1
 * round-1 P1).
 */
export type OutboundDispatcherResponse =
  | { id: string; result?: unknown }
  | { id: string; error: OutboundCommandError };

export type OutboundCommandDispatcher = (
  command: OutboundServerToDaemonCommandFrame,
) => Promise<OutboundDispatcherResponse>;

/**
 * Build a typed `command_response` frame from a dispatcher response,
 * re-validating against the per-command response schema. On drift (e.g. a
 * typed code returned for a command that does not declare it, or a result
 * shape mismatch) the frame collapses to a generic `internal_error` and
 * the `drift` field is populated for structured logging — the foreign /
 * malformed payload never reaches the wire.
 */
export function toOutboundCommandResponse(
  command: OutboundServerToDaemonCommandFrame,
  response: OutboundDispatcherResponse,
): {
  frame: OutboundDaemonToServerCommandResponseFrame;
  drift?: { summary: Record<string, unknown>; issues: string[] };
} {
  const candidate =
    'error' in response
      ? {
          direction: 'daemon_to_server',
          type: 'command_response',
          id: command.id,
          kind: command.kind,
          error: response.error,
        }
      : {
          direction: 'daemon_to_server',
          type: 'command_response',
          id: command.id,
          kind: command.kind,
          result: response.result,
        };
  const parsed =
    OutboundDaemonToServerCommandResponseFrameSchema.safeParse(candidate);
  if (parsed.success) return { frame: parsed.data };
  return {
    frame: {
      direction: 'daemon_to_server',
      type: 'command_response',
      id: command.id,
      kind: command.kind,
      error: {
        code: 'internal_error',
        message: `daemon outbound command response drift for ${command.kind}`,
      },
    } as OutboundDaemonToServerCommandResponseFrame,
    drift: {
      summary: summarizeResponseFrame(response),
      issues: parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`),
    },
  };
}

export function summarizeResponseFrame(
  response: OutboundDispatcherResponse,
): Record<string, unknown> {
  if ('error' in response) {
    return {
      arm: 'error',
      id: response.id,
      error_code: response.error.code,
    };
  }
  const result = response.result;
  return {
    arm: 'result',
    id: response.id,
    result_type: Array.isArray(result) ? 'array' : typeof result,
    result_keys:
      result && typeof result === 'object' && !Array.isArray(result)
        ? Object.keys(result).slice(0, 10)
        : undefined,
  };
}

/**
 * Map a local daemon {@link EventFrame} to its outbound wire envelope.
 * Strips daemon-local-only fields (`socket_path`, the local
 * `protocol_version`) and stamps the outbound `direction`/`type`/`kind`
 * plus the negotiated `OUTBOUND_PROTOCOL_VERSION` on `ready`.
 */
export function toOutboundEventFrame(
  event: EventFrame,
): OutboundDaemonToServerEventFrame {
  switch (event.event) {
    case 'ready': {
      const {
        event: _event,
        socket_path: _socketPath,
        protocol_version: _protocolVersion,
        ...rest
      } = event;
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind: 'ready',
        protocol_version: OUTBOUND_PROTOCOL_VERSION,
        ...rest,
      };
    }
    case 'shutting_down': {
      const { event: _event, ...rest } = event;
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind: event.event,
        ...rest,
      };
    }
    default: {
      const { event: _event, ...rest } = event;
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind: event.event,
        ...rest,
      } as OutboundDaemonToServerEventFrame;
    }
  }
}
