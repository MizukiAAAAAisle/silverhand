import {
  HOST_PROTOCOL_VERSION,
  KNOWN_CAPABILITIES_V1,
  type HelloResult,
} from '../protocol.js';
import { DEFAULT_DAEMON_IDENTITY, type DaemonIdentity } from './identity.js';

/**
 * The version label baked into daemon liveness and handshake responses.
 * Protocol compatibility is gated by HOST_PROTOCOL_VERSION; this string
 * is diagnostic release/build identity.
 *
 * Kept in its own module so daemon entry, dispatcher, and spawn paths
 * import the same literal without one pulling in another daemon module.
 */
export const DAEMON_VERSION = '0.1.0';

export function createDaemonHelloResult(
  instanceId = 'test-instance',
  identity: DaemonIdentity = DEFAULT_DAEMON_IDENTITY,
): HelloResult {
  return {
    protocol_version: HOST_PROTOCOL_VERSION,
    daemon_version: DAEMON_VERSION,
    daemon_id: identity.daemon_id,
    instance_id: instanceId,
    host_descriptor: identity.host_descriptor,
    capabilities: [...KNOWN_CAPABILITIES_V1],
  };
}
