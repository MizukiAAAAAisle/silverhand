import { AGENT_CAPABILITIES, type AgentCapability } from '@silverhand/shared';

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
const GROUP_DEFS: { id: string; label: string; keys: AgentCapability[] }[] = [
  {
    id: 'message',
    label: 'Message',
    keys: ['read_messages', 'send_messages'],
  },
  {
    id: 'task',
    label: 'Task',
    keys: ['read_tasks', 'create_tasks', 'write_tasks'],
  },
  {
    id: 'channel',
    label: 'Channel',
    keys: ['create_channels'],
  },
  {
    id: 'thread',
    label: 'Thread',
    keys: ['create_threads'],
  },
  {
    id: 'members',
    label: 'Members',
    keys: ['manage_conversation_members'],
  },
  {
    id: 'attachments',
    label: 'Attachments',
    keys: ['read_attachments', 'upload_attachments'],
  },
  {
    id: 'schedules',
    label: 'Schedules',
    keys: ['manage_schedules'],
  },
];

/** Per-key labels + one-line explanations. */
const CAPABILITY_LABELS: Record<AgentCapability, { label: string; hint: string }> = {
  read_messages: {
    label: 'Read messages',
    hint: 'View conversation history and search messages.',
  },
  send_messages: {
    label: 'Send messages',
    hint: 'Send messages and mention members in conversations.',
  },
  read_tasks: { label: 'Read tasks', hint: 'View tasks across conversations.' },
  create_tasks: { label: 'Create tasks', hint: 'Create new tasks.' },
  write_tasks: {
    label: 'Update tasks',
    hint: 'Update task assignment and status.',
  },
  read_attachments: {
    label: 'Read attachments',
    hint: 'View and download attachments.',
  },
  upload_attachments: {
    label: 'Upload attachments',
    hint: 'Upload attachments to conversations.',
  },
  create_threads: {
    label: 'Manage threads',
    hint: 'Create and close threads.',
  },
  create_channels: { label: 'Create channels', hint: 'Create channels.' },
  manage_conversation_members: {
    label: 'Manage members',
    hint: 'Add workspace members to channels and threads.',
  },
  manage_schedules: {
    label: 'Manage schedules',
    hint: 'Create and cancel scheduled runs.',
  },
};

function metaFor(key: AgentCapability): CapabilityMeta {
  const m = CAPABILITY_LABELS[key];
  return { key, label: m.label, hint: m.hint };
}

/**
 * Build the grouped capability list, guaranteeing full coverage of
 * `AGENT_CAPABILITIES`: any registry key not present in `GROUP_DEFS` is
 * appended under a fallback "其他" group so the editor never drops a bucket.
 */
export function buildCapabilityGroups(): CapabilityGroup[] {
  const seen = new Set<AgentCapability>();
  const groups: CapabilityGroup[] = GROUP_DEFS.map(def => {
    const items = def.keys.map(k => {
      seen.add(k);
      return metaFor(k);
    });
    return { id: def.id, label: def.label, items };
  });

  const uncovered = AGENT_CAPABILITIES.filter(k => !seen.has(k));
  if (uncovered.length > 0) {
    groups.push({
      id: 'other',
      label: 'Other',
      items: uncovered.map(k => ({
        key: k,
        label: CAPABILITY_LABELS[k]?.label ?? k,
        hint: CAPABILITY_LABELS[k]?.hint ?? k,
      })),
    });
  }
  return groups;
}

/** Total number of capability buckets (for "X/N granted" summaries). */
export const CAPABILITY_COUNT = AGENT_CAPABILITIES.length;
