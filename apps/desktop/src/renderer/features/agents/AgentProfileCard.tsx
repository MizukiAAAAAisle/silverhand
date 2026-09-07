import { ProfileMessageActivity } from '@/features/profile/ProfileMessageActivity';
import { useLayoutEffect, useRef, useState, type JSX } from 'react';
import './agent-profile-hero.css';
import dayjs from 'dayjs';
import type { AgentDto } from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
import { AVATAR_PX } from '@/components/avatar-scale';
import { cn } from '@/lib/cn';
import { MetadataList, ProfileSection } from '@/features/common/ProfileSummarySections';
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
import { UNKNOWN_COMPUTER_LABEL } from '@/features/hosts/host-display';

interface AgentProfileCardProps {
  agent: AgentDto;
}

export function AgentProfileCard({ agent }: AgentProfileCardProps): JSX.Element {
  const { data: viewer } = useViewerUser();
  // D4.a Commit 5d-fixup (Cindy P1-2): the BackendUnreachable arm never
  // reaches the registered shell — but if it ever does, map to `undefined`
  // (deny edit, mirror loading).
  const viewerForPermissions =
    viewer && (isBackendUnreachable(viewer) || isUpdateRequired(viewer)) ? undefined : viewer;
  const canEdit = canEditAgentProfile(viewerForPermissions, agent);
  const update = useUpdateAgent(agent.id);
  const avatarObjectUrl = useAgentAvatarObjectUrl(agent.avatar_url);
  // Server-resolved label, not a local owned-hosts lookup: `GET /api/hosts` is
  // owner-scoped, so a non-owner viewer's lookup would miss and collapse to
  // "Unknown computer". `host_label` is null only when the host is truly gone.
  const computerName = agent.host_label ?? UNKNOWN_COMPUTER_LABEL;
  const profileRef = useRef<HTMLDivElement>(null);
  const [compactHero, setCompactHero] = useState(true);
  const avatarSize = compactHero ? AVATAR_PX.profileCompact : AVATAR_PX.profile;

  useLayoutEffect(() => {
    const element = profileRef.current;

    if (!element) {
      return;
    }

    const updateWidth = () => setCompactHero(element.getBoundingClientRect().width <= 520);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  const [nameEditing, setNameEditing] = useState(false);
  const [descriptionEditing, setDescriptionEditing] = useState(false);
  const [runtimeEditing, setRuntimeEditing] = useState(false);

  return (
    <div ref={profileRef} data-profile-layout className="mx-auto flex flex-col gap-6">
      {!canEdit ? <ReadOnlyNotice /> : null}

      <section aria-label="Agent profile" data-compact={compactHero} className="agent-profile-hero">
        {canEdit ? (
          <EditableAgentAvatar
            agentId={agent.id}
            size={avatarSize}
            runtime={agent.runtime}
            alt={agent.display_name || agent.name}
            avatarObjectUrl={avatarObjectUrl}
            hasAvatar={agent.avatar_url != null}
          />
        ) : (
          <AgentAvatar
            runtime={agent.runtime}
            size={avatarSize}
            avatarObjectUrl={avatarObjectUrl}
            alt={agent.display_name || agent.name}
          />
        )}
        <div className="agent-profile-hero-fields min-w-0 flex-1">
          <div>
            <div className="flex items-start gap-1">
              <div className={cn('min-w-0', nameEditing && 'flex-1')}>
                {canEdit ? (
                  <InlineText
                    value={agent.display_name}
                    ariaLabel="Display name"
                    editing={nameEditing}
                    onExitEdit={() => setNameEditing(false)}
                    validate={rejectDisplayName}
                    className="agent-profile-hero-name font-serif font-semibold"
                    onCommit={async (next) => {
                      await update.mutateAsync({ display_name: next });
                    }}
                  />
                ) : (
                  <div className="break-words agent-profile-hero-name font-serif font-semibold text-text-primary">
                    {agent.display_name || agent.name}
                  </div>
                )}
              </div>
              {canEdit ? (
                <EditPencilButton
                  onClick={() => setNameEditing(true)}
                  ariaLabel="Edit display name"
                  hidden={nameEditing}
                />
              ) : null}
            </div>
            <div
              className="mt-1 truncate font-mono text-xs text-text-muted"
              title={`@${agent.name}`}
            >
              @{agent.name}
            </div>
          </div>
          <div className={cn('flex gap-1', descriptionEditing ? 'items-start' : 'items-center')}>
            <div
              className={cn(
                'agent-profile-hero-description min-w-0 break-words',
                descriptionEditing && 'flex-1',
              )}
            >
              {canEdit ? (
                <InlineTextarea
                  value={agent.description}
                  placeholder="Add description"
                  ariaLabel="Description"
                  editing={descriptionEditing}
                  onExitEdit={() => setDescriptionEditing(false)}
                  onCommit={async (next) => {
                    await update.mutateAsync({ description: next });
                  }}
                />
              ) : (
                <ReadOnlyValue value={agent.description} placeholder="No description." multiline />
              )}
            </div>
            {canEdit ? (
              <EditPencilButton
                onClick={() => setDescriptionEditing(true)}
                ariaLabel="Edit description"
                hidden={descriptionEditing}
              />
            ) : null}
          </div>
        </div>
      </section>

      <ProfileMessageActivity subject={{ kind: 'agent', id: agent.id }} />

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
              label: 'Session model',
              value: agent.session_scope === 'agent' ? 'Across conversations' : 'Per conversation',
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
    <p role="note" className="text-xs text-text-muted" data-testid="agent-profile-readonly-notice">
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
