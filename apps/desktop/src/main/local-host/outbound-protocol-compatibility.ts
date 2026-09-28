export type OutboundProtocolCompatibility =
  | {
      status: "compatible" | "app_update_required" | "server_update_required";
      app_protocol_version: number;
      server_protocol_version: number;
    }
  | {
      status: "unknown";
      app_protocol_version: number;
      server_protocol_version: null;
    };

/**
 * Compare the outbound protocol compiled into this desktop's bundled daemon
 * with the exact version accepted by the connected server.
 *
 * Missing server metadata is deliberately `unknown`, not compatible: older
 * servers predate the capability signal, and guessing would hide skew. The
 * comparison is local; the server only advertises its own protocol version.
 */
export function classifyOutboundProtocolCompatibility(input: {
  appProtocolVersion: number;
  serverProtocolVersion: number | undefined;
}): OutboundProtocolCompatibility {
  const { appProtocolVersion, serverProtocolVersion } = input;
  if (serverProtocolVersion === undefined) {
    return {
      status: "unknown",
      app_protocol_version: appProtocolVersion,
      server_protocol_version: null,
    };
  }
  return {
    status:
      appProtocolVersion === serverProtocolVersion
        ? "compatible"
        : appProtocolVersion < serverProtocolVersion
          ? "app_update_required"
          : "server_update_required",
    app_protocol_version: appProtocolVersion,
    server_protocol_version: serverProtocolVersion,
  };
}
