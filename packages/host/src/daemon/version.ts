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

/**
 * Construct a `HelloResult` payload bound to a specific daemon
 * process generation.
 *
 * `instanceId` is **required** with no default: it is the per-boot
 * ephemeral id (`${started_at_ms}-${pid}` produced by
 * `buildDaemonInstanceId`) and any "sensible" default would be a
 * production footgun — accidentally booting a daemon that advertises a
 * literal placeholder over the wire is worse than a TypeScript error.
 * Tests that need a stand-in pass an obvious sentinel
 * (e.g. `'__test_instance__'`) so a grep instantly distinguishes
 * fixture data from prod traffic.
 */
export function createDaemonHelloResult(
  instanceId: string,
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
