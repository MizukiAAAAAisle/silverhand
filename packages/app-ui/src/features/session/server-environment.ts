import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import type { ConnectionInfo } from "@silverhand/client";
import { serverFeatures, type ServerFeatures } from "@silverhand/shared";
import { getPlatform } from "@/platform";

export type ServerFeatureKey = keyof ServerFeatures;

export interface ServerEnvironment extends ConnectionInfo {
  /** Null while the selected server has not answered discovery. */
  features: Required<ServerFeatures> | null;
}

export const serverEnvironmentKey = ["server-environment"] as const;

const UNANSWERED_RETRY_MS = 5_000;

async function readServerEnvironment(): Promise<ServerEnvironment> {
  const client = getPlatform().client;
  const connection = await client.getConnectionInfo();
  if (!connection) {
    throw new Error("backend not ready");
  }

  // The address stays readable when the server is down: the auth gate offers
  // switching servers exactly then.
  const features = await client.getServerInfo().then(serverFeatures, () => null);
  return { ...connection, features };
}

export const serverEnvironmentQuery = queryOptions({
  queryKey: serverEnvironmentKey,
  queryFn: readServerEnvironment,
  staleTime: Infinity,
  refetchInterval: (query) =>
    query.state.data && query.state.data.features === null ? UNANSWERED_RETRY_MS : false,
  meta: { backendReachability: "neutral" },
});

/** Connection mode, address and server features of the selected server. */
export function useServerEnvironment() {
  return useQuery(serverEnvironmentQuery);
}

/** Off until the server advertises it. */
export function useServerFeature(key: ServerFeatureKey): boolean {
  return useServerEnvironment().data?.features?.[key] ?? false;
}

export function refreshServerEnvironment(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: serverEnvironmentKey });
}
