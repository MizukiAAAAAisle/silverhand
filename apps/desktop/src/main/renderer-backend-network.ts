/**
 * Keep Chromium-owned backend transports on the same network path as the
 * desktop main process.
 *
 * Backend REST requests run through Node's `fetch`, which is direct unless the
 * product explicitly supplies a dispatcher. The event WebSocket runs in the
 * renderer, so Chromium would otherwise inherit the OS proxy independently.
 * That split can leave REST healthy while the live event channel loops on
 * `1006`. Until proxy policy becomes an explicit server-profile property, the
 * only coherent behavior is direct for both transports.
 */

export interface RendererSessionProxyController {
  setProxy(config: { mode: 'direct' }): Promise<void>;
  resolveProxy(url: string): Promise<string>;
}

export interface RendererBackendNetworkResult {
  backendOrigin: string;
  resolvedProxy: string;
}

export const DESKTOP_BACKEND_NETWORK_POLICY = {
  proxyMode: 'direct',
} as const;

export type BackendFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function fetchBackendWithNetworkPolicy(
  fetchImpl: BackendFetch,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  // The switch is deliberately explicit: when proxy support becomes part of
  // the server profile, both this arm and the Chromium-session arm below must
  // grow together from the same policy rather than drifting independently.
  switch (DESKTOP_BACKEND_NETWORK_POLICY.proxyMode) {
    case 'direct':
      return fetchImpl(input, init);
  }
}

export async function configureRendererBackendNetwork(input: {
  session: RendererSessionProxyController;
  backendUrl: string;
}): Promise<RendererBackendNetworkResult> {
  const backendOrigin = new URL(input.backendUrl).origin;
  await input.session.setProxy({ mode: DESKTOP_BACKEND_NETWORK_POLICY.proxyMode });
  const resolvedProxy = (await input.session.resolveProxy(backendOrigin)).trim();
  if (resolvedProxy.toUpperCase() !== 'DIRECT') {
    throw new Error(
      `renderer backend transport did not resolve DIRECT for ${backendOrigin}: ${resolvedProxy}`,
    );
  }
  return { backendOrigin, resolvedProxy };
}
