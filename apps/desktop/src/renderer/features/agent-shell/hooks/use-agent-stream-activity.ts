import { useSyncExternalStore } from "react";
import { getCurrentUserId } from "@/lib/current-user";
import { agentStreamCache } from "../model/agent-stream-cache";

const signedOut = {
  getSnapshot: () => signedOutSnapshot,
  subscribe: () => () => {},
  loadEarlier: async () => {},
};
const signedOutSnapshot = {
  events: [],
  nextBeforeId: null,
  phase: "error" as const,
  isLoadingMore: false,
};

export function useAgentStreamActivity(agentId: string) {
  const userId = getCurrentUserId();
  const entry = userId ? agentStreamCache.get(userId, agentId) : signedOut;
  const snapshot = useSyncExternalStore(entry.subscribe, entry.getSnapshot);
  return { ...snapshot, loadEarlier: entry.loadEarlier };
}
