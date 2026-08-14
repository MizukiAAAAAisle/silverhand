import { useState, type JSX } from 'react';
import { Lock } from 'lucide-react';
import dayjs from 'dayjs';
import type { AgentDto } from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
import { AVATAR_PX } from '@/components/avatar-scale';
import { cn } from '@/lib/cn';
import {
  MetadataList,
  ProfileSection,
} from '@/features/common/ProfileSummarySections';
import { useUpdateAgent } from './hooks';
import { useAgentAvatarObjectUrl } from './avatar-hooks';
import { canEditAgentProfile } from './permissions';
import { EditableAgentAvatar } from './EditableAgentAvatar';
import { EditPencilButton } from '@/features/common/EditPencilButton';
import { InlineText } from '@/features/common/InlineText';
import { rejectDisplayName } from '@/features/common/display-name';
import { InlineTextarea } from './InlineTextarea';
import { RuntimeConfigEditor } from './RuntimeConfigEditor';
import { isBackendUnreachable, isUpdateRequired, useViewerUser } from '@/features/me/hooks';
import { useHostsQuery } from '@/features/hosts/hooks';
import { resolveComputerName } from '@/features/hosts/host-display';

interface AgentProfileCardProps {
  agent: AgentDto;
}

/**
 * Agent profile card. Every editable section shares one enter-edit
 * pattern: a `titleAdornment` pencil (via `EditPencilButton`) sitting
 * inline right after the section title, always visible with muted →
 * regular color on hover (no background pill, no hover-to-reveal). The
 * pencil disappears while the section is in edit mode; Save/Cancel
 * buttons live in the section body.
 *
 *   Identity              → avatar + display_name (Identity-header pencil)
 *                           + locked handle
 *   Description           → free-form text (Description-header pencil)
 *   Runtime configuration → runtime + model + reasoning + fast mode as
 *                           one coupled tuple (Runtime-header pencil)
 *   Metadata              → computer + created/updated + agent id
 *
 * Every edit requires an explicit commit action; focus loss never
 * persists (#task:1472, differs from `features/hosts/InlineRename`
 * which commits on blur). Runtime configuration is one coupled unit
 * rather than per-field edits because the four fields are semantically
 * tied to a single driver choice (shiki 2026-07-12: "整个 runtime
 * config 给一个 edit icon").
 */
export function AgentProfileCard({
  agent,
}: AgentProfileCardProps): JSX.Element {
  const { data: viewer } = useViewerUser();
  // D4.a Commit 5d-fixup (Cindy P1-2): the BackendUnreachable arm never
  // reaches the registered shell — but if it ever does, map to `undefined`
  // (deny edit, mirror loading).
  const viewerForPermissions =
    viewer && (isBackendUnreachable(viewer) || isUpdateRequired(viewer)) ? undefined : viewer;
  const canEdit = canEditAgentProfile(viewerForPermissions, agent);
  const update = useUpdateAgent(agent.id);
  const avatarObjectUrl = useAgentAvatarObjectUrl(agent.avatar_url);
  const hostsQuery = useHostsQuery();
  const computerName = resolveComputerName(
    (hostsQuery.data?.hosts ?? []).find(h => h.id === agent.host_id),
  );
  const [nameEditing, setNameEditing] = useState(false);
  const [descriptionEditing, setDescriptionEditing] = useState(false);
  const [runtimeEditing, setRuntimeEditing] = useState(false);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      {!canEdit ? <ReadOnlyNotice /> : null}

      <ProfileSection
        title="Identity"
        titleAdornment={
          canEdit ? (
            <EditPencilButton
              onClick={() => setNameEditing(true)}
              ariaLabel="Edit display name"
              hidden={nameEditing}
            />
          ) : null
        }
      >
        <div className="flex items-start gap-4">
          {canEdit ? (
            <EditableAgentAvatar
              agentId={agent.id}
              size={AVATAR_PX['3xl']}
              runtime={agent.runtime}
              alt={agent.display_name || agent.name}
              avatarObjectUrl={avatarObjectUrl}
              hasAvatar={agent.avatar_url != null}
            />
          ) : (
            <AgentAvatar
              runtime={agent.runtime}
              size={AVATAR_PX['3xl']}
              avatarObjectUrl={avatarObjectUrl}
              alt={agent.display_name || agent.name}
            />
          )}
          <div className="min-w-0 flex-1">
            {canEdit ? (
              <InlineText
                value={agent.display_name}
                ariaLabel="Display name"
                editing={nameEditing}
                onExitEdit={() => setNameEditing(false)}
                validate={rejectDisplayName}
                className="font-serif text-lg font-semibold leading-tight"
                onCommit={async next => {
                  await update.mutateAsync({ display_name: next });
                }}
              />
            ) : (
              <div className="font-serif text-lg font-semibold leading-tight text-text-primary">
                {agent.display_name || agent.name}
              </div>
            )}
            <div className="mt-1 flex items-center gap-1.5 text-xs text-text-muted">
              <span className="font-mono">@{agent.name}</span>
              <Lock className="size-3" />
              <span>handle is locked</span>
            </div>
          </div>
        </div>
      </ProfileSection>

      <ProfileSection
        title="Description"
        titleAdornment={
          canEdit ? (
            <EditPencilButton
              onClick={() => setDescriptionEditing(true)}
              ariaLabel="Edit description"
              hidden={descriptionEditing}
            />
          ) : null
        }
      >
        {canEdit ? (
          <InlineTextarea
            value={agent.description}
            placeholder="Add a description — what is this agent for?"
            ariaLabel="Description"
            editing={descriptionEditing}
            onExitEdit={() => setDescriptionEditing(false)}
            onCommit={async next => {
              await update.mutateAsync({ description: next });
            }}
          />
        ) : (
          <ReadOnlyValue
            value={agent.description}
            placeholder="No description."
            multiline
          />
        )}
      </ProfileSection>

      <ProfileSection
        title="Runtime configuration"
        titleAdornment={
          canEdit ? (
            <EditPencilButton
              onClick={() => setRuntimeEditing(true)}
              ariaLabel="Edit runtime configuration"
              hidden={runtimeEditing}
            />
          ) : null
        }
      >
        <RuntimeConfigEditor
          agent={agent}
          editing={runtimeEditing}
          onExitEdit={() => setRuntimeEditing(false)}
        />
      </ProfileSection>

      <ProfileSection title="Metadata" muted>
        <MetadataList
          items={[
            { label: 'Computer', value: computerName },
            {
              label: 'Session scope',
              value: agent.session_scope === 'agent' ? 'Agent' : 'Conversation',
            },
            {
              label: 'Created',
              value: dayjs(agent.created_at).format('YYYY-MM-DD'),
              title: dayjs(agent.created_at).format('YYYY-MM-DD HH:mm:ss'),
            },
            {
              label: 'Updated',
              value: dayjs(agent.updated_at).format('YYYY-MM-DD HH:mm'),
              title: dayjs(agent.updated_at).format('YYYY-MM-DD HH:mm:ss'),
            },
            { label: 'Agent ID', value: agent.id, mono: true },
          ]}
        />
      </ProfileSection>

      {update.isError && canEdit ? (
        <div className="text-xs text-error">{String(update.error)}</div>
      ) : null}
    </div>
  );
}

function ReadOnlyNotice(): JSX.Element {
  return (
    <p
      role="note"
      className="text-xs text-text-muted"
      data-testid="agent-profile-readonly-notice"
    >
      Only the creator can edit this agent's profile.
    </p>
  );
}

function ReadOnlyValue({
  value,
  placeholder,
  multiline = false,
}: {
  value: string | null | undefined;
  placeholder?: string;
  multiline?: boolean;
}): JSX.Element {
  const display = value && value.length > 0 ? value : null;
  return (
    <div
      className={cn(
        'text-sm',
        display ? 'text-text-primary' : 'text-text-muted',
        multiline ? 'whitespace-pre-wrap leading-relaxed' : '',
      )}
    >
      {display ?? placeholder ?? '—'}
    </div>
  );
}
