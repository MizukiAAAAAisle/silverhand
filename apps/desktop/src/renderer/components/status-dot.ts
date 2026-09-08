import type { ConversationAgentStatus } from "@silverhand/shared";

/**
 * ONE DOT GROUND for HUMAN presence, keyed by the run-state word a human's
 * presence maps onto (`presenceDotStatus`: online → `active`, away/offline →
 * `idle`).
 *
 * Agents left this table in #task:2128: their presence is now the shared
 * `projectPresence` → `PRESENCE_TONE_DOT` path (one projection, one tone→colour
 * map, both scopes), so the two member surfaces that dot both kinds — the header
 * member strip and the members modal — paint an agent from the tone map and a
 * human from this one. The keys stay `ConversationAgentStatus` because
 * `presenceDotStatus` still speaks that vocabulary; only agents moved off it.
 *
 * It lives in its own leaf module so a surface can import a class table without
 * depending on any one placement's folder.
 */
export const STATUS_DOT: Record<ConversationAgentStatus, string> = {
  active: "bg-success",
  starting: "bg-warning",
  crashed: "bg-error",
  idle: "bg-text-muted/50",
};
