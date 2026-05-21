/**
 * The version label baked into every ping/status response. Bumped
 * intentionally when the wire protocol changes; clients use it to log
 * the negotiated daemon version, not (yet) to gate on minimums.
 *
 * Kept in its own module so the daemon entry and HostClient's smoke
 * paths import the same literal without one pulling in the other.
 */
export const DAEMON_VERSION = '0.1.0';
