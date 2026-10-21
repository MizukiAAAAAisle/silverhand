import { describeApiError } from "@/lib/api-error-message";
import { t } from "@/lib/i18n";

const deleteAgentErrorMessages = (): Record<string, string> => ({
  host_attach_pending: t("agents.connectTheComputerFirst"),
});

export function friendlyDeleteAgentError(err: unknown): string {
  return describeApiError(err, {
    actionLabel: t("agents.couldntDeleteTheAgent"),
    backendUnreachableMessage: t("agents.cantReachTheBackend"),
    fallbackMessage: t("agents.couldntDeleteTheAgent2"),
    knownCodeMessages: deleteAgentErrorMessages(),
  });
}
