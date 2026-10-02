import { describeApiError } from "@/lib/api-error-message";

const DELETE_AGENT_ERROR_MESSAGES: Record<string, string> = {
  host_attach_pending: "Connect the computer first.",
};

export function friendlyDeleteAgentError(err: unknown): string {
  return describeApiError(err, {
    actionLabel: "Couldn't delete the agent",
    backendUnreachableMessage: "Can't reach the backend. Check your connection and try again.",
    fallbackMessage: "Couldn't delete the agent. Please try again.",
    knownCodeMessages: DELETE_AGENT_ERROR_MESSAGES,
  });
}
