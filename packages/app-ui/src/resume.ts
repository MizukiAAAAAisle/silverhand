import { getPlatform } from "./platform";
import { queryClient } from "./lib/query-client";
import { eventWsClient } from "./lib/ws-client";
import { mapAuthStateToViewer } from "./features/session/hooks";

/** Resume the existing React tree: composer drafts and send identities belong
 * to that tree and must survive a normal suspension. Native auth rejection
 * still follows the platform's session invalidation path. */
export async function resumeApp(): Promise<void> {
  const state = await getPlatform().client.getAuthState();
  // Transient connectivity must not replace the mounted conversation with a
  // bootstrap error screen. The existing reconnect loop will keep retrying.
  if (state.status !== "backend_unreachable") {
    queryClient.setQueryData(["me"], mapAuthStateToViewer(state));
  }
  if (state.status !== "authenticated" && state.status !== "backend_unreachable") return;

  eventWsClient.connect();
  await queryClient.invalidateQueries({
    predicate: (query) => query.queryKey[0] !== "me",
  });
}
