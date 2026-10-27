import { HOST_PROTOCOL_VERSION, KNOWN_CAPABILITIES_V1, type HelloResult } from '../protocol.js';
import { DEFAULT_DAEMON_IDENTITY, type DaemonIdentity } from './identity.js';

declare const __SILVERHAND_DAEMON_VERSION__: string | undefined;

/**
 * The version label baked into daemon liveness and handshake responses.
 * Protocol compatibility is gated by HOST_PROTOCOL_VERSION; this string
 * is diagnostic release/build identity.
 *
 * Published daemon bundles inject this from the `@silverhand-ai/daemon`
 * package version at build time. Dev/test runs fall back to an explicit
 * dev label rather than a stale hand-written release number.
 */
export const DAEMON_VERSION =
  typeof __SILVERHAND_DAEMON_VERSION__ === 'string' ? __SILVERHAND_DAEMON_VERSION__ : '0.0.0-dev';

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
