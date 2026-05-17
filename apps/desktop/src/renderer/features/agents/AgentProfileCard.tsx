import {
  forwardRef,
  useEffect,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
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
import { AgentAvatar } from '@/components/AgentAvatar';
import { cn } from '@/lib/cn';
import { useUpdateAgent } from './hooks';
import { useAgentAvatarObjectUrl } from './avatar-hooks';
import { canEditAgentProfile } from './permissions';
import { EditableAgentAvatar } from './EditableAgentAvatar';
import { useViewerUser } from '@/features/me/hooks';

const RUNTIMES: { value: RuntimeKind; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex CLI' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'gemini', label: 'Gemini' },
];

// codex maps `reasoning_effort` to its `model_reasoning_effort` config
// key. Other runtimes ignore the field — UI hides the row for them.
const CODEX_REASONING: { value: string; label: string }[] = [
  { value: '__default__', label: 'Use codex default' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
];

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
 * Settings-style agent profile view. Replaces the previous form-heavy
 * card (stacked labels above bordered inputs) with a two-column row
 * layout: label on the left, ghost-input value on the right that only
 * paints its chrome on hover/focus. Reads as a profile sheet first and
 * an editor second — which matches how the user actually interacts with
 * it (mostly viewing, occasionally tweaking).
 */
export function AgentProfileCard({
  agent,
  runtimeState,
}: AgentProfileCardProps): JSX.Element {
  const { data: viewer } = useViewerUser();
  const canEdit = canEditAgentProfile(viewer, agent);
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
  const onCommitModel = () => {
    const next = model.trim();
    if (next === (agent.model ?? '')) return;
    commit({ model: next === '' ? null : next });
  };

  const isCodex = agent.runtime === 'codex';
  const reasoningValue = agent.reasoning_effort ?? '__default__';
  const fastModeValue =
    agent.fast_mode === null || agent.fast_mode === undefined
      ? '__default__'
      : agent.fast_mode
        ? 'true'
        : 'false';

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      {/* Identity strip — large avatar paired with display name + handle.
        * Reads as a profile masthead rather than a labeled form row.
        * Editable form is gated on `canEditAgentProfile`; non-creators
        * see a plain `<AgentAvatar>` and a static name + a one-liner
        * explaining who can edit. The read-only form does NOT use a
        * disabled `<input>` — that would still render the input
        * chrome on hover/focus and lie about the affordance. */}
      <section className="flex items-center gap-4">
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
          <div className="mt-1 flex items-center gap-1.5 px-2 text-xs text-text-muted">
            <span className="font-mono">@{agent.name}</span>
            <Lock className="size-3" />
            <span>handle is locked in v1</span>
          </div>
        </div>
      </section>

      {!canEdit ? <ReadOnlyNotice /> : null}

      <Group title="About">
        <Row label="Description" align="top">
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
        </Row>
      </Group>

      <Group title="Runtime">
        <Row
          label="CLI"
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
        </Row>
        <Row label="Model" hint={canEdit ? runtimeHint(agent.runtime) : undefined}>
          {canEdit ? (
            <GhostInput
              value={model}
              onChange={e => setModel(e.target.value)}
              onBlur={onCommitModel}
              placeholder="driver default"
            />
          ) : (
            <ReadOnlyValue value={agent.model} placeholder="driver default" />
          )}
        </Row>
        {isCodex ? (
          <Row label="Reasoning" hint={canEdit ? 'Higher = slower but more thorough.' : undefined}>
            {canEdit ? (
              <PickerSelect
                value={reasoningValue}
                options={CODEX_REASONING}
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
                placeholder="codex default"
              />
            )}
          </Row>
        ) : null}
        {isCodex ? (
          <Row label="Fast mode" hint={canEdit ? 'Default keeps the catalog setting.' : undefined}>
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
          </Row>
        ) : null}
      </Group>

      <Group title="Metadata" muted>
        <MetaList
          items={[
            { label: 'Host', value: agent.host_id },
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
      </Group>

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
      className="-mt-4 text-xs text-text-muted"
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
  return RUNTIMES.find(rt => rt.value === runtime)?.label ?? runtime;
}

// ── Layout primitives ────────────────────────────────────────────────────

function Group({
  title,
  children,
  muted = false,
}: {
  title: string;
  children: ReactNode;
  muted?: boolean;
}): JSX.Element {
  return (
    <section className="flex flex-col">
      <h3
        className={cn(
          'mb-2 font-serif text-[13px] font-semibold uppercase tracking-wider',
          muted ? 'text-text-muted' : 'text-text-secondary',
        )}
      >
        {title}
      </h3>
      <div className="divide-y divide-border-subtle/60 rounded-md border border-border-subtle/60 bg-bg-floating/50">
        {children}
      </div>
    </section>
  );
}

function Row({
  label,
  hint,
  align = 'center',
  children,
}: {
  label: string;
  hint?: string;
  align?: 'center' | 'top';
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={cn(
        'grid grid-cols-[120px_1fr] gap-3 px-3 py-2.5',
        align === 'top' ? 'items-start' : 'items-center',
      )}
    >
      <div className={cn('min-w-0', align === 'top' ? 'pt-1.5' : '')}>
        <div className="text-xs font-medium text-text-secondary">{label}</div>
        {hint ? (
          <div className="mt-0.5 text-[11px] leading-snug text-text-muted">
            {hint}
          </div>
        ) : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

interface MetaItem {
  label: string;
  value: string;
  title?: string;
  mono?: boolean;
}

function MetaList({ items }: { items: MetaItem[] }): JSX.Element {
  return (
    <dl className="divide-y divide-border-subtle/60">
      {items.map(item => (
        <div
          key={item.label}
          className="flex items-baseline justify-between gap-3 px-3 py-1.5"
          title={item.title}
        >
          <dt className="text-[11px] uppercase tracking-wider text-text-muted">
            {item.label}
          </dt>
          <dd
            className={cn(
              'min-w-0 truncate text-xs text-text-primary',
              item.mono ? 'font-mono' : '',
            )}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ── Ghost inputs (transparent until hover/focus) ─────────────────────────

const GhostInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-sm text-text-primary placeholder:text-text-muted',
        'transition-colors hover:border-border-subtle hover:bg-bg-base/40',
        'focus:border-border focus:bg-bg-floating focus:outline-none focus:ring-2 focus:ring-border-focus',
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
    className={cn(
      'w-full resize-none rounded-md border border-transparent bg-transparent px-2 py-1.5 text-sm leading-relaxed text-text-primary placeholder:text-text-muted',
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
    'flex h-8 w-full items-center justify-between rounded-md border border-transparent bg-transparent px-2 text-sm text-text-primary',
    'transition-colors hover:border-border-subtle hover:bg-bg-base/40',
    'data-[state=open]:border-border data-[state=open]:bg-bg-floating',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus',
    disabled ? 'cursor-not-allowed opacity-50 hover:border-transparent hover:bg-transparent' : '',
  );
}

function selectContentClass(): string {
  return 'z-50 min-w-[var(--radix-select-trigger-width)] rounded-md border border-border bg-bg-floating p-1 text-sm shadow-popover';
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
      <Select.Trigger className={selectTriggerClass(disabled)}>
        <Select.Value />
        <Select.Icon>
          <ChevronDown className="size-3.5 text-text-muted" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          className={selectContentClass()}
        >
          <Select.Viewport>
            {RUNTIMES.map(rt => (
              <Select.Item
                key={rt.value}
                value={rt.value}
                className={selectItemClass()}
              >
                <Select.ItemText>{rt.label}</Select.ItemText>
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
      <Select.Trigger className={selectTriggerClass(false)}>
        <Select.Value />
        <Select.Icon>
          <ChevronDown className="size-3.5 text-text-muted" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
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
  }
}
