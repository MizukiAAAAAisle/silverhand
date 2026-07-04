import {
  forwardRef,
  useEffect,
  useState,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import * as Select from '@radix-ui/react-select';
import { ChevronDown, Lock } from 'lucide-react';
import dayjs from 'dayjs';
import type {
  AgentDto,
  AgentRuntimeStateDto,
  ReasoningEffort,
  RuntimeKind,
  UpdateAgentInput,
} from '@silverhand/shared';
import {
  RUNTIME_CATALOG,
  reasoningEffortLabel,
  runtimeCatalogEntry,
  runtimeCliLabel,
  runtimeSupportsReasoningEffort,
} from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
import { Combobox } from '@/components/ui/combobox';
import { cn } from '@/lib/cn';
import {
  MetadataList,
  ProfileField,
  ProfileFieldGrid,
  ProfileSection,
} from '@/features/common/ProfileSummarySections';
import { useUpdateAgent } from './hooks';
import { useAgentAvatarObjectUrl } from './avatar-hooks';
import { canEditAgentProfile } from './permissions';
import { EditableAgentAvatar } from './EditableAgentAvatar';
import { isBackendUnreachable, useViewerUser } from '@/features/me/hooks';

// codex feature flag `fast_mode`. Tri-state so the user can pin
// either side or fall back to the catalog default (currently `true`).
// Stored as boolean | null on the agent row.
const CODEX_FAST_MODE: { value: string; label: string }[] = [
  { value: '__default__', label: 'Use codex default' },
  { value: 'true', label: 'Enabled' },
  { value: 'false', label: 'Disabled' },
];

interface AgentProfileCardProps {
  agent: AgentDto;
  runtimeState: AgentRuntimeStateDto | undefined;
}

/**
 * Agent profile card. Section structure follows the #task:396 contract
 * (identity-led + operational list):
 *
 *   Identity      → avatar + display name + handle (editable in place)
 *   Capabilities  → runtime + model + description (+ codex extras)
 *   Metadata      → host id + created/updated + agent id
 *
 * Sections are bordered cards; fields inside each section stack
 * label-on-top in a 2-column wrap grid rather than the previous
 * 120px-label form grid, so the panel reads as a profile sheet
 * rather than a settings form. The editors themselves (GhostInput /
 * GhostTextarea / Radix Select) are unchanged so codex-specific
 * options and runtime-blocked disables keep working.
 */
export function AgentProfileCard({
  agent,
  runtimeState,
}: AgentProfileCardProps): JSX.Element {
  const { data: viewer } = useViewerUser();
  // D4.a Commit 5d-fixup (Cindy P1-2): the BackendUnreachable arm
  // never reaches the registered shell — but if it ever does, the
  // permissions helper expects a `MeResponse | undefined`, so map
  // the unreachable arm to `undefined` (deny edit, mirror the loading
  // state).
  const viewerForPermissions =
    viewer && isBackendUnreachable(viewer) ? undefined : viewer;
  const canEdit = canEditAgentProfile(viewerForPermissions, agent);
  const update = useUpdateAgent(agent.id);
  const avatarObjectUrl = useAgentAvatarObjectUrl(agent.avatar_url);

  // Local drafts; commit on blur for text fields, immediately for selects.
  // Avoids fighting React Query's optimistic re-renders if the user types
  // into a field while a previous PATCH is still in flight.
  const [displayName, setDisplayName] = useState(agent.display_name);
  const [description, setDescription] = useState(agent.description ?? '');
  const [model, setModel] = useState(agent.model ?? '');

  useEffect(() => setDisplayName(agent.display_name), [agent.display_name, agent.id]);
  useEffect(() => setDescription(agent.description ?? ''), [agent.description, agent.id]);
  useEffect(() => setModel(agent.model ?? ''), [agent.model, agent.id]);

  // Runtime change is blocked by the backend (409) when any conversation_agent
  // is starting/active. Mirror that locally so the select looks disabled
  // instead of producing a confusing toast on click.
  const hasRunning = (runtimeState?.conversation_agents ?? []).some(
    s => s.status === 'starting' || s.status === 'active',
  );

  const commit = (patch: UpdateAgentInput) => {
    update.mutate(patch);
  };

  const onCommitDisplayName = () => {
    const next = displayName.trim();
    if (next && next !== agent.display_name) commit({ display_name: next });
  };
  const onCommitDescription = () => {
    if (description === (agent.description ?? '')) return;
    commit({ description: description === '' ? null : description });
  };

  const isCodex = agent.runtime === 'codex';
  const catalogEntry = runtimeCatalogEntry(agent.runtime);
  const supportsReasoning = runtimeSupportsReasoningEffort(agent.runtime);
  // Reasoning options come from the shared catalog per-runtime set (codex
  // low/medium/high/xhigh, qoder none…max) so the picker can never offer a
  // value the runtime doesn't take. `__default__` = leave the field unset
  // (null), letting the runtime use its own default.
  const reasoningOptions: { value: string; label: string }[] = [
    { value: '__default__', label: 'Use driver default' },
    ...catalogEntry.reasoningEffortOptions.map(v => ({
      value: v,
      label: reasoningEffortLabel(v),
    })),
  ];
  const modelSuggestions = catalogEntry.modelSuggestions;
  const reasoningValue = agent.reasoning_effort ?? '__default__';
  const fastModeValue =
    agent.fast_mode === null || agent.fast_mode === undefined
      ? '__default__'
      : agent.fast_mode
        ? 'true'
        : 'false';

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      {!canEdit ? <ReadOnlyNotice /> : null}

      {/* Identity — avatar + name + locked handle. Mirrors the Hero's
        * identity info but with editing affordances live here. The
        * Hero is read-only by design (it's the page chrome, not the
        * editor surface). */}
      <ProfileSection title="Identity">
        {/* `items-start` (was `items-center`) — the avatar column
            (avatar + Remove + optional error from EditableAgentAvatar)
            is taller than the name column (name input + meta line),
            so center-aligning pushed the name visibly below the
            avatar's top edge. Combined with the GhostInput fix below,
            the name text top now hits the avatar top exactly when an
            image avatar is set. shiki `k5TNBjN5IxwbTUgW` (#task:827)
            after the matching #task:824/825 human-pane fixes:
            '我看着还不是' (with screenshot of the AGENT pane). */}
        <div className="flex items-start gap-4">
          {canEdit ? (
            <EditableAgentAvatar
              agentId={agent.id}
              size={56}
              runtime={agent.runtime}
              alt={agent.display_name || agent.name}
              avatarObjectUrl={avatarObjectUrl}
              hasAvatar={agent.avatar_url != null}
            />
          ) : (
            <AgentAvatar
              runtime={agent.runtime}
              size={56}
              avatarObjectUrl={avatarObjectUrl}
              alt={agent.display_name || agent.name}
            />
          )}
          <div className="min-w-0 flex-1">
            {canEdit ? (
              <GhostInput
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                onBlur={onCommitDisplayName}
                placeholder={agent.name}
                className="font-serif text-lg font-semibold leading-tight"
              />
            ) : (
              <div className="px-2 font-serif text-lg font-semibold leading-tight text-text-primary">
                {agent.display_name || agent.name}
              </div>
            )}
            {/* Description as muted subtitle directly under the display
                name. Different placement from PersonHero (which inlines
                it after the name) — shiki #task:912 review round 6
                clarification: in the Identity card the description should
                sit on its own line below the name, then the handle line. */}
            {agent.description ? (
              <p
                className="mt-1 px-2 truncate text-sm text-text-muted"
                title={agent.description}
              >
                {agent.description}
              </p>
            ) : null}
            <div className="mt-1 flex items-center gap-1.5 px-2 text-xs text-text-muted">
              <span className="font-mono">@{agent.name}</span>
              <Lock className="size-3" />
              <span>handle is locked</span>
            </div>
          </div>
        </div>
      </ProfileSection>

      {/* Capabilities — what this agent can do. Description, runtime,
        * model, plus codex-specific tuning. Description gets the
        * full-row treatment because it's the long-form field; the
        * narrower fields share the 2-col grid. */}
      <ProfileSection title="Capabilities">
        <ProfileFieldGrid>
          <ProfileField label="Description" full>
            {canEdit ? (
              <GhostTextarea
                rows={3}
                value={description}
                onChange={e => setDescription(e.target.value)}
                onBlur={onCommitDescription}
                placeholder="Optional — what is this agent for?"
              />
            ) : (
              <ReadOnlyValue
                value={agent.description}
                placeholder="No description."
                multiline
              />
            )}
          </ProfileField>
          <ProfileField
            label="Runtime"
            hint={
              canEdit && hasRunning ? 'Stop the agent before changing.' : undefined
            }
          >
            {canEdit ? (
              <RuntimeSelect
                value={agent.runtime}
                disabled={hasRunning}
                onChange={value => commit({ runtime: value })}
              />
            ) : (
              <ReadOnlyValue value={runtimeLabel(agent.runtime)} />
            )}
          </ProfileField>
          <ProfileField label="Model" hint={canEdit ? runtimeHint(agent.runtime) : undefined}>
            {canEdit ? (
              // Editable combobox: free-text model id + the runtime's
              // suggested values (qoder tiers). `h-8` matches the sibling
              // RuntimeSelect trigger height so the 2-col grid stays even.
              <Combobox
                id={`ag-model-${agent.id}`}
                ariaLabel="Model"
                value={model}
                onChange={setModel}
                onCommit={next => {
                  const trimmed = next.trim();
                  if (trimmed !== (agent.model ?? '')) {
                    commit({ model: trimmed === '' ? null : trimmed });
                  }
                }}
                suggestions={modelSuggestions}
                placeholder="driver default"
                className="h-8"
              />
            ) : (
              <ReadOnlyValue value={agent.model} placeholder="driver default" />
            )}
          </ProfileField>
          {supportsReasoning ? (
            <ProfileField
              label="Reasoning"
              hint={canEdit ? 'Higher = slower but more thorough.' : undefined}
            >
              {canEdit ? (
                <PickerSelect
                  value={reasoningValue}
                  options={reasoningOptions}
                  onChange={value =>
                    commit({
                      reasoning_effort:
                        value === '__default__' ? null : (value as ReasoningEffort),
                    })
                  }
                />
              ) : (
                <ReadOnlyValue
                  value={agent.reasoning_effort}
                  placeholder="driver default"
                />
              )}
            </ProfileField>
          ) : null}
          {isCodex ? (
            <ProfileField
              label="Fast mode"
              hint={canEdit ? 'Default keeps the catalog setting.' : undefined}
            >
              {canEdit ? (
                <PickerSelect
                  value={fastModeValue}
                  options={CODEX_FAST_MODE}
                  onChange={value =>
                    commit({
                      fast_mode: value === '__default__' ? null : value === 'true',
                    })
                  }
                />
              ) : (
                <ReadOnlyValue
                  value={
                    agent.fast_mode === null || agent.fast_mode === undefined
                      ? null
                      : agent.fast_mode
                        ? 'Enabled'
                        : 'Disabled'
                  }
                  placeholder="codex default"
                />
              )}
            </ProfileField>
          ) : null}
        </ProfileFieldGrid>
      </ProfileSection>

      <ProfileSection title="Metadata" muted>
        <MetadataList
          items={[
            { label: 'Host', value: agent.host_id, mono: true },
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

/**
 * Single-source-of-truth message for the read-only form. Cindy PR-3
 * review #1: avoid `@<creator-display-name>` / `@<id>` substitutions —
 * the renderer has no users-by-id lookup yet, and `created_by_user_id`
 * is not a mention handle. Once a user lookup map exists we can swap
 * in the creator's display name; until then the line is intentionally
 * generic so we don't ship a broken-feeling placeholder.
 */
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

/** Read-only renderer for a profile field. Static text, no input chrome.
 *  When the value is null/empty the placeholder text shows in muted
 *  color so the row doesn't collapse. */
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
        'px-2 py-1 text-sm',
        display ? 'text-text-primary' : 'text-text-muted',
        multiline ? 'whitespace-pre-wrap leading-relaxed' : '',
      )}
    >
      {display ?? placeholder ?? '—'}
    </div>
  );
}

function runtimeLabel(runtime: RuntimeKind): string {
  return runtimeCliLabel(runtime);
}

// ── Ghost inputs (transparent until hover/focus) ─────────────────────────

const GhostInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      data-panel-control="ghost-input"
      // No `border border-transparent` and no `py-*` in idle state —
      // the previous defaults pushed the visible text 5px below the
      // input box top (1px transparent border + 4px py-1), creating a
      // visible y-shift between the avatar (image fills its 56×56
      // box from corner to corner, visible top = column top) and the
      // name input. shiki `k5TNBjN5IxwbTUgW` (#task:827) — same
      // diagnosis as the matching #task:825 human-pane fix. Hover
      // affordance survives via `hover:bg-bg-base/40`, focus via
      // `bg-bg-floating + ring-2 ring-border-focus`. The Capabilities/
      // Model GhostInput consumer also picks up the change — bg-only
      // hover is consistent with the Identity name input there too.
      className={cn(
        'w-full bg-transparent px-2 text-sm text-text-primary placeholder:text-text-muted',
        'transition-colors hover:bg-bg-base/40',
        'focus:bg-bg-floating focus:outline-none focus:ring-2 focus:ring-border-focus',
        className,
      )}
      {...props}
    />
  ),
);
GhostInput.displayName = 'GhostInput';

const GhostTextarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    data-panel-control="ghost-textarea"
    className={cn(
      'w-full resize-none border border-transparent bg-transparent px-2 py-1.5 text-sm leading-relaxed text-text-primary placeholder:text-text-muted',
      'transition-colors hover:border-border-subtle hover:bg-bg-base/40',
      'focus:border-border focus:bg-bg-floating focus:outline-none focus:ring-2 focus:ring-border-focus',
      className,
    )}
    {...props}
  />
));
GhostTextarea.displayName = 'GhostTextarea';

// ── Selects (Radix Select with the same low-chrome trigger) ─────────────

function selectTriggerClass(disabled: boolean): string {
  return cn(
    'flex h-8 w-full items-center justify-between border border-transparent bg-transparent px-2 text-sm text-text-primary',
    'transition-colors hover:border-border-subtle hover:bg-bg-base/40',
    'data-[state=open]:border-border data-[state=open]:bg-bg-floating',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus',
    disabled ? 'cursor-not-allowed opacity-50 hover:border-transparent hover:bg-transparent' : '',
  );
}

function selectContentClass(): string {
  return 'z-50 min-w-[var(--radix-select-trigger-width)] border border-border bg-bg-floating p-1 text-sm shadow-popover';
}

function selectItemClass(): string {
  return 'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-text-primary outline-none data-[highlighted]:bg-bg-hover';
}

function RuntimeSelect({
  value,
  disabled,
  onChange,
}: {
  value: RuntimeKind;
  disabled: boolean;
  onChange: (value: RuntimeKind) => void;
}): JSX.Element {
  return (
    <Select.Root
      value={value}
      disabled={disabled}
      onValueChange={v => onChange(v as RuntimeKind)}
    >
      <Select.Trigger
        data-panel-control="select-trigger"
        className={selectTriggerClass(disabled)}
      >
        <Select.Value />
        <Select.Icon>
          <ChevronDown className="size-3.5 text-text-muted" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          data-panel-control="select-content"
          className={selectContentClass()}
        >
          <Select.Viewport>
            {RUNTIME_CATALOG.filter(
              // Offer only spawnable runtimes, but always keep the agent's
              // current runtime visible so its label renders even if that
              // runtime is no longer selectable.
              rt => rt.selectable || rt.kind === value,
            ).map(rt => (
              <Select.Item
                key={rt.kind}
                value={rt.kind}
                className={selectItemClass()}
              >
                <Select.ItemText>{rt.cliLabel}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function PickerSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger
        data-panel-control="select-trigger"
        className={selectTriggerClass(false)}
      >
        <Select.Value />
        <Select.Icon>
          <ChevronDown className="size-3.5 text-text-muted" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          data-panel-control="select-content"
          className={selectContentClass()}
        >
          <Select.Viewport>
            {options.map(opt => (
              <Select.Item
                key={opt.value}
                value={opt.value}
                className={selectItemClass()}
              >
                <Select.ItemText>{opt.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function runtimeHint(runtime: RuntimeKind): string {
  switch (runtime) {
    case 'claude':
      return 'e.g. sonnet · opus · claude-opus-4-7';
    case 'codex':
      return 'e.g. o1 · o1-mini · gpt-5';
    case 'cursor':
      return 'cursor uses its own selection';
    case 'gemini':
      return 'e.g. gemini-2.5-pro';
    case 'qoder':
      return 'e.g. Auto · Qwen3.7-Max · GLM-5.2 (or leave blank)';
  }
}
