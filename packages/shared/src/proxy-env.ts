/**
 * Expand a single user-entered proxy URL into the env variables most
 * subprocess HTTP clients actually look at. Pure shared helper so both
 * backend policy construction and daemon-side env materialization use
 * identical parsing.
 */
export function expandProxyEnv(input: string): Record<string, string> | null {
  const raw = input.trim();
  if (!raw) return null;

  const m = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.+)$/);
  const scheme = m ? m[1]!.toLowerCase() : null;
  const rest = m ? m[2]! : raw;

  let httpProxy: string | null = null;
  let socksProxy: string | null = null;

  switch (scheme) {
    case 'http':
      httpProxy = `http://${rest}`;
      socksProxy = `socks5://${rest}`;
      break;
    case 'https':
      httpProxy = `http://${rest}`;
      socksProxy = `socks5://${rest}`;
      break;
    case 'socks5':
    case 'socks5h':
    case 'socks4':
    case 'socks':
      socksProxy = raw;
      break;
    case null:
      httpProxy = `http://${rest}`;
      socksProxy = `socks5://${rest}`;
      break;
    default:
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
