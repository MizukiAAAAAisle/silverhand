import { AGENT_CAPABILITIES, type AgentCapability } from "@silverhand/shared";
import { t } from "@/lib/i18n";

/**
 * UI-only presentation metadata for the agent capability editor.
 *
 * SINGLE SOURCE OF TRUTH: the set of capability keys is `AGENT_CAPABILITIES`
 * (`@silverhand/shared`). This file ONLY attaches a functional grouping +
 * human labels on top of those keys — it never invents a key or a second
 * ordering. The values submitted to the backend are always the raw registry
 * keys (replace-set of `AgentCapability`).
 *
 * Grouping is by *functional domain the operator understands* (Message /
 * Task / Channel / …), deliberately NOT the backend contract order. If a new
 * bucket is added to `AGENT_CAPABILITIES` without being mapped here,
 * {@link buildCapabilityGroups} surfaces it under a fallback "其他" group so a
 * capability is never silently hidden from the editor.
 */
export interface CapabilityMeta {
  key: AgentCapability;
  label: string;
  hint: string;
}

export interface CapabilityGroup {
  /** Stable group id (UI only). */
  id: string;
  label: string;
  items: CapabilityMeta[];
}

/** Functional-domain grouping. Keys MUST be members of `AGENT_CAPABILITIES`. */
const groupDefs = (): { id: string; label: string; keys: AgentCapability[] }[] => [
  {
    id: "message",
    label: t("workspaces.message"),
    keys: ["read_messages", "send_messages"],
  },
  {
    id: "task",
    label: t("workspaces.task"),
    keys: ["read_tasks", "create_tasks", "write_tasks"],
  },
  {
    id: "channel",
    label: t("workspaces.channel"),
    keys: ["create_channels"],
  },
  {
    id: "thread",
    label: t("workspaces.thread"),
    keys: ["create_threads"],
  },
  {
    id: "members",
    label: t("workspaces.members"),
    keys: ["manage_conversation_members"],
  },
  {
    id: "attachments",
    label: t("workspaces.attachments"),
    keys: ["read_attachments", "upload_attachments"],
  },
  {
    id: "schedules",
    label: t("workspaces.schedules"),
    keys: ["manage_schedules"],
  },
];

/** Per-key labels + one-line explanations. */
const capabilityLabels = (): Record<AgentCapability, { label: string; hint: string }> => ({
  read_messages: {
    label: t("workspaces.readMessages"),
    hint: t("workspaces.viewConversationHistoryAnd"),
  },
  send_messages: {
    label: t("workspaces.sendMessages"),
    hint: t("workspaces.sendMessagesAndMention"),
  },
  read_tasks: {
    label: t("workspaces.readTasks"),
    hint: t("workspaces.viewTasksAcrossConversations"),
  },
  create_tasks: { label: t("workspaces.createTasks"), hint: t("workspaces.createNewTasks") },
  write_tasks: {
    label: t("workspaces.updateTasks"),
    hint: t("workspaces.updateTaskAssignmentAnd"),
  },
  read_attachments: {
    label: t("workspaces.readAttachments"),
    hint: t("workspaces.viewAndDownloadAttachments"),
  },
  upload_attachments: {
    label: t("workspaces.uploadAttachments"),
    hint: t("workspaces.uploadAttachmentsToConversations"),
  },
  create_threads: {
    label: t("workspaces.manageThreads"),
    hint: t("workspaces.createAndCloseThreads"),
  },
  create_channels: { label: t("workspaces.createChannels"), hint: t("workspaces.createChannels2") },
  manage_conversation_members: {
    label: t("workspaces.manageMembers"),
    hint: t("workspaces.addProjectMembersTo"),
  },
  manage_schedules: {
    label: t("workspaces.manageSchedules"),
    hint: t("workspaces.createAndCancelScheduled"),
  },
});

function metaFor(key: AgentCapability): CapabilityMeta {
  const m = capabilityLabels()[key];
  return { key, label: m.label, hint: m.hint };
}

/**
 * Build the grouped capability list, guaranteeing full coverage of
 * `AGENT_CAPABILITIES`: any registry key not present in `GROUP_DEFS` is
 * appended under a fallback "其他" group so the editor never drops a bucket.
 */
export function buildCapabilityGroups(): CapabilityGroup[] {
  const seen = new Set<AgentCapability>();
  const groups: CapabilityGroup[] = groupDefs().map((def) => {
    const items = def.keys.map((k) => {
      seen.add(k);
      return metaFor(k);
    });
    return { id: def.id, label: def.label, items };
  });

  const uncovered = AGENT_CAPABILITIES.filter((k) => !seen.has(k));
  if (uncovered.length > 0) {
    groups.push({
      id: "other",
      label: t("workspaces.otherGroup"),
      items: uncovered.map((k) => ({
        key: k,
        label: capabilityLabels()[k]?.label ?? k,
        hint: capabilityLabels()[k]?.hint ?? k,
      })),
    });
  }
  return groups;
}

/** Total number of capability buckets (for "X/N granted" summaries). */
export const CAPABILITY_COUNT = AGENT_CAPABILITIES.length;
