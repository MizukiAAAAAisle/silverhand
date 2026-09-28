/**
 * The pane capabilities a deep surface is rendered inside (#task:2039).
 *
 * The surfaces that need them sit deep inside a rendered message (byline →
 * `@mention` → markdown → popover), so the pane's mode cannot travel to them as a
 * prop without threading one through every renderer in between. It travels as
 * context instead, provided ONCE at the pane boundary from that pane's own
 * projection (`paneCapabilities(projectConversationPaneMode(...))`) — the same
 * discipline `TaskRefContext` already follows for the workspace a `#task:<n>`
 * resolves in.
 *
 * The whole capability object travels, not one derived flag. @Cindy's review of
 * the first cut: presence had its own context while the popover's management
 * controls still started the roster reads and hid themselves when the response
 * came back empty — two rules for one mode, and the second one lived in the data.
 * One provider, one value, so a consumer can gate a READ (`hasRoster`) and a
 * rendering with the same fact.
 *
 * The DEFAULT is {@link DEFAULT_PANE_CAPABILITIES} — the workspace-channel
 * capabilities, i.e. what every surface did before this ticket. So a surface with
 * no pane around it (a dialog, the agent page) is unchanged, and only a pane whose
 * placement differs overrides it, from its projection rather than by choosing.
 */
import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_PANE_CAPABILITIES, type ConversationPaneCapabilities } from "./pane-mode";

const ConversationPaneCapabilitiesContext =
  createContext<ConversationPaneCapabilities>(DEFAULT_PANE_CAPABILITIES);

export function ConversationPaneCapabilitiesProvider({
  value,
  children,
}: {
  value: ConversationPaneCapabilities;
  children: ReactNode;
}): JSX.Element {
  return (
    <ConversationPaneCapabilitiesContext.Provider value={value}>
      {children}
    </ConversationPaneCapabilitiesContext.Provider>
  );
}

export function useConversationPaneCapabilities(): ConversationPaneCapabilities {
  return useContext(ConversationPaneCapabilitiesContext);
}
