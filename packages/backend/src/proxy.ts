/**
 * Expand a single user-entered proxy URL into the three env variables
 * subprocess HTTP clients actually look at:
 *
 *   http_proxy   — for plain-HTTP requests
 *   https_proxy  — for TLS requests (target=https://...)
 *   all_proxy    — SOCKS catch-all that some libs prefer
 *
 * The user enters one thing in Settings, but those three slots want
 * different schemes:
 *   - `http_proxy` / `https_proxy` should point at an HTTP CONNECT
 *     proxy (scheme `http://`, NOT `https://` — `https://` would mean
 *     "TLS-handshake with the proxy first" and basically no local
 *     proxy speaks that)
 *   - `all_proxy` should be a SOCKS endpoint (`socks5://`)
 *
 * Local proxies like Clash / mihomo / v2ray-rules-dat run a "mixed
 * port" that simultaneously serves HTTP CONNECT and SOCKS5 on the
 * same port, so we can derive both from one host:port.
 *
 * Returns lowercase + uppercase pairs for each key. Different runtimes
 * pick different cases (Rust/reqwest prefers uppercase; many shell
 * tools use lowercase) — set both, harmless.
 *
 * Returns `null` if input is empty / unparseable.
 */
export function expandProxyEnv(input: string): Record<string, string> | null {
  const raw = input.trim();
  if (!raw) return null;

  // Try to peel off a scheme. Schemes we care about: http, https,
  // socks5, socks5h, socks4, socks. Anything else: treat as bare
  // host:port.
  const m = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.+)$/);
  const scheme = m ? m[1]!.toLowerCase() : null;
  const rest = m ? m[2]! : raw;

  // host[:port] — keep what the user gave verbatim. We don't validate
  // here; if it's malformed, the spawned process surfaces a useful
  // error in its own logs.
  const hostPort = rest;

  let httpProxy: string | null = null;
  let socksProxy: string | null = null;

  switch (scheme) {
    case 'http':
      httpProxy = `http://${hostPort}`;
      socksProxy = `socks5://${hostPort}`;
      break;
    case 'https':
      // Almost always a typo — local proxies don't speak TLS on
      // their CONNECT port. Silently rewrite to http://, and still
      // assume the same port has a SOCKS listener (Clash mixed-port).
      httpProxy = `http://${hostPort}`;
      socksProxy = `socks5://${hostPort}`;
      break;
    case 'socks5':
    case 'socks5h':
    case 'socks4':
    case 'socks':
      // SOCKS-only: don't synthesize HTTP_PROXY because we have no
      // way to know if there's an HTTP listener too. all_proxy is
      // enough — most clients honor it.
      socksProxy = raw;
      break;
    case null:
      // Bare `host:port` → assume Clash/mihomo mixed-port (HTTP +
      // SOCKS on the same port). Cover both.
      httpProxy = `http://${hostPort}`;
      socksProxy = `socks5://${hostPort}`;
      break;
    default:
      // Unknown scheme. Pass through to all_proxy and hope the
      // runtime knows what to do.
      socksProxy = raw;
      break;
  }

  const out: Record<string, string> = {};
  if (httpProxy) {
    out.HTTP_PROXY = httpProxy;
    out.http_proxy = httpProxy;
    out.HTTPS_PROXY = httpProxy;
    out.https_proxy = httpProxy;
  }
  if (socksProxy) {
    out.ALL_PROXY = socksProxy;
    out.all_proxy = socksProxy;
  }
  return Object.keys(out).length > 0 ? out : null;
}
