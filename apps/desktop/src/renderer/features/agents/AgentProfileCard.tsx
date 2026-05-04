import { useEffect, useState } from 'react';
import * as Select from '@radix-ui/react-select';
import { ChevronDown, Lock, Pencil } from 'lucide-react';
import dayjs from 'dayjs';
import type {
  AgentDto,
  AgentRuntimeStateDto,
  RuntimeKind,
  UpdateAgentInput,
} from '@silverhand/shared';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useUpdateAgent } from './hooks';

const RUNTIMES: { value: RuntimeKind; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex CLI' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'gemini', label: 'Gemini' },
];

// codex maps `reasoning_effort` to its `model_reasoning_effort` config
// key. Other runtimes ignore the field — UI hides it for them.
const CODEX_REASONING: { value: string; label: string }[] = [
  { value: '__default__', label: 'Use codex default' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
];

interface AgentProfileCardProps {
  agent: AgentDto;
  runtimeState: AgentRuntimeStateDto | undefined;
}

export function AgentProfileCard({
  agent,
  runtimeState,
}: AgentProfileCardProps): JSX.Element {
  const update = useUpdateAgent(agent.id);

  // Local draft; commits on blur for text fields, immediately for selects.
  // Keeps the input responsive and avoids fighting React Query's optimistic
  // re-renders if you type into a field while a previous PATCH is in flight.
  const [displayName, setDisplayName] = useState(agent.display_name);
  const [description, setDescription] = useState(agent.description ?? '');
  const [model, setModel] = useState(agent.model ?? '');

  useEffect(() => setDisplayName(agent.display_name), [agent.display_name, agent.id]);
  useEffect(() => setDescription(agent.description ?? ''), [agent.description, agent.id]);
  useEffect(() => setModel(agent.model ?? ''), [agent.model, agent.id]);

  // Runtime change is blocked by the backend (409) when any session_agent
  // is starting/active. Mirror that locally so the select looks disabled
  // instead of producing a confusing toast on click.
  const hasRunning = (runtimeState?.session_agents ?? []).some(
    s => s.status === 'starting' || s.status === 'active',
  );

  const commit = (patch: UpdateAgentInput) => {
    update.mutate(patch);
  };

  const onBlurDisplayName = () => {
    const next = displayName.trim();
    if (next && next !== agent.display_name) commit({ display_name: next });
  };
  const onBlurDescription = () => {
    const next = description;
    if (next === (agent.description ?? '')) return;
    commit({ description: next === '' ? null : next });
  };
  const onBlurModel = () => {
    const next = model.trim();
    if (next === (agent.model ?? '')) return;
    commit({ model: next === '' ? null : next });
  };

  const isCodex = agent.runtime === 'codex';
  const reasoningValue = agent.reasoning_effort ?? '__default__';

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-bg-floating p-4">
      <h2 className="font-serif text-sm font-semibold text-text-primary">
        Profile
      </h2>

      <Field
        label={
          <>
            Display name
            <Pencil className="ml-1 inline size-3 text-text-muted" />
          </>
        }
      >
        <Input
          value={displayName}
          onChange={e => setDisplayName(e.target.value)}
          onBlur={onBlurDisplayName}
          placeholder={agent.name}
        />
      </Field>

      <Field
        label={
          <>
            Handle
            <Lock className="ml-1 inline size-3 text-text-muted" />
          </>
        }
        hint="Used in @mentions, dm-<name> channel, and L2 file paths. Can't be changed in v1."
      >
        <Input
          value={`@${agent.name}`}
          readOnly
          className="cursor-not-allowed bg-bg-base font-mono text-text-secondary"
        />
      </Field>

      <Field label="Description">
        <Textarea
          rows={3}
          value={description}
          onChange={e => setDescription(e.target.value)}
          onBlur={onBlurDescription}
          placeholder="optional — what is this agent for?"
        />
      </Field>

      <hr className="border-border-subtle" />

      <Field
        label="Runtime"
        hint={
          hasRunning
            ? 'Stop the agent before changing runtime.'
            : 'CLI used to spawn this agent.'
        }
      >
        <RuntimeSelect
          value={agent.runtime}
          disabled={hasRunning}
          onChange={value => commit({ runtime: value })}
        />
      </Field>

      <Field label="Model" hint="Optional. Leave blank to use the driver default.">
        <Input
          value={model}
          onChange={e => setModel(e.target.value)}
          onBlur={onBlurModel}
          placeholder={runtimePlaceholder(agent.runtime)}
        />
      </Field>

      {isCodex ? (
        <Field
          label="Reasoning effort"
          hint="codex only. Higher = slower but more thorough."
        >
          <ReasoningSelect
            value={reasoningValue}
            onChange={value =>
              commit({ reasoning_effort: value === '__default__' ? null : value })
            }
          />
        </Field>
      ) : null}

      <hr className="border-border-subtle" />

      <div className="grid grid-cols-2 gap-3 text-xs text-text-muted">
        <Meta label="Host">{agent.host_id}</Meta>
        <Meta label="Created" title={dayjs(agent.created_at).format('YYYY-MM-DD HH:mm:ss')}>
          {dayjs(agent.created_at).format('YYYY-MM-DD')}
        </Meta>
        <Meta label="Updated" title={dayjs(agent.updated_at).format('YYYY-MM-DD HH:mm:ss')}>
          {dayjs(agent.updated_at).format('YYYY-MM-DD HH:mm')}
        </Meta>
        <Meta label="Agent ID">
          <span className="font-mono">{agent.id}</span>
        </Meta>
      </div>

      {update.isError ? (
        <div className="text-xs text-error">{String(update.error)}</div>
      ) : null}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <span className="text-[11px] text-text-muted">{hint}</span> : null}
    </div>
  );
}

function Meta({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5" title={title}>
      <span className="text-[11px] uppercase tracking-wide text-text-muted">{label}</span>
      <span className="text-text-primary">{children}</span>
    </div>
  );
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
        className={
          'flex h-9 w-full items-center justify-between rounded-md border border-border bg-bg-floating px-3 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:cursor-not-allowed disabled:opacity-50'
        }
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
          className="z-50 min-w-[var(--radix-select-trigger-width)] rounded-md border border-border bg-bg-floating p-1 text-sm shadow-lg"
        >
          <Select.Viewport>
            {RUNTIMES.map(rt => (
              <Select.Item
                key={rt.value}
                value={rt.value}
                className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-text-primary outline-none data-[highlighted]:bg-bg-hover"
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

function ReasoningSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger className="flex h-9 w-full items-center justify-between rounded-md border border-border bg-bg-floating px-3 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus">
        <Select.Value />
        <Select.Icon>
          <ChevronDown className="size-3.5 text-text-muted" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          className="z-50 min-w-[var(--radix-select-trigger-width)] rounded-md border border-border bg-bg-floating p-1 text-sm shadow-lg"
        >
          <Select.Viewport>
            {CODEX_REASONING.map(opt => (
              <Select.Item
                key={opt.value}
                value={opt.value}
                className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-text-primary outline-none data-[highlighted]:bg-bg-hover"
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

function runtimePlaceholder(runtime: RuntimeKind): string {
  switch (runtime) {
    case 'claude':
      return 'sonnet / opus / claude-opus-4-7';
    case 'codex':
      return 'o1 / o1-mini / gpt-5 / ...';
    case 'cursor':
      return '(cursor uses its own selection)';
    case 'gemini':
      return 'gemini-2.5-pro';
  }
}
