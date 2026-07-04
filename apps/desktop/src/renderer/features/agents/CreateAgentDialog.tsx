import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { CreateAgentInput, RuntimeKind } from '@silverhand/shared';
import { RUNTIME_CATALOG } from '@silverhand/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { describeApiError } from '@/lib/api-error-message';
import { useHostProvenanceGate, useHostsQuery } from '@/features/hosts/hooks';
import { useCreateAgent } from './hooks';

// The runtime picker is driven entirely by the shared catalog (single
// source of truth). Non-`selectable` runtimes still render — disabled —
// so the roadmap is visible without us silently dropping options.
type RuntimeChoice = { value: RuntimeKind; label: string; disabled: boolean };

const RUNTIMES: RuntimeChoice[] = RUNTIME_CATALOG.map(entry => ({
  value: entry.kind,
  label: entry.cliLabel,
  disabled: !entry.selectable,
}));

// Shared chip styling for the Runtime + "Runs on" pickers: ink border +
// the theme's own selection fill (`--bg-row-selected`), border WIDTH /
// radius via the per-theme control tokens (forza6 2px poster, warm/slack
// 1px). Text held constant at text-primary across states. Kept identical
// across both rows so the dialog reads as one control family (#task:1214).
const CHIP_BASE =
  'rounded-[var(--control-radius)] border-[length:var(--control-border-width)] px-3 py-1.5 text-xs transition-colors ';

function chipClass(isSelected: boolean, isDisabled = false): string {
  if (isDisabled) {
    return (
      CHIP_BASE + 'cursor-not-allowed border-border-subtle text-text-muted opacity-50'
    );
  }
  return (
    CHIP_BASE +
    (isSelected
      ? 'border-text-primary bg-[var(--bg-row-selected)] text-text-primary'
      : 'border-border-subtle text-text-primary hover:border-border')
  );
}

interface CreateAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (id: string) => void;
}

export function CreateAgentDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateAgentDialogProps): JSX.Element {
  const [name, setName] = useState('');
  const [runtime, setRuntime] = useState<RuntimeKind>('claude');
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const createAgent = useCreateAgent();

  const { currentLocalHost } = useHostProvenanceGate();
  const hostsQuery = useHostsQuery();

  // Active local hosts are the only valid New-Agent runtime targets: an agent
  // runs on a local daemon, and the backend's default placement only resolves
  // among `kind === 'local' && revoked_at === null` (host-placement.ts).
  const activeLocalHosts = useMemo(
    () =>
      (hostsQuery.data?.hosts ?? []).filter(
        host => host.kind === 'local' && host.revoked_at === null,
      ),
    [hostsQuery.data],
  );

  // The picker only earns its place when the backend genuinely cannot resolve a
  // single host on its own (≥2 active local hosts → `local_host_ambiguous`).
  // With 0/1 host there is no UI — but we still send the current host's id below
  // so the backend never has to guess.
  const showPicker = activeLocalHosts.length >= 2;

  // The current client's bound local host, when it is an active local one. This
  // is the zero-friction default AND the id we send even when the picker is
  // hidden — so a desktop submit always carries an explicit `host_id` and
  // `local_host_ambiguous` becomes structurally impossible (Alice's race: a 2nd
  // daemon attaching while the dialog is open must not flip a hidden-picker
  // submit back to ambiguous). We test active-local placement directly rather
  // than borrowing `canUseCurrentLocalHostPath` — that gate carries local-path
  // affordance semantics (Reveal/Finder) that could tighten and silently shift
  // placement (Cindy #task:1214). `null` only for a pure-remote client with no
  // bound local host → fall back to the backend's own resolution.
  const defaultHostId =
    currentLocalHost &&
    currentLocalHost.kind === 'local' &&
    currentLocalHost.revoked_at === null
      ? currentLocalHost.id
      : null;

  // Preselect the current host when the picker opens; clear on close. `prev ??`
  // preserves an explicit user choice and still fills the default once the hosts
  // list resolves after the dialog is already open.
  useEffect(() => {
    if (!open) {
      setSelectedHostId(null);
      return;
    }
    setSelectedHostId(prev => prev ?? defaultHostId);
  }, [open, defaultHostId]);

  // Decoupled from picker visibility: send the chosen host when the picker is
  // shown, else the current host's id (when known). Omitted only when neither
  // is available (pure-remote client) → backend fallback resolves the lone host.
  const effectiveHostId = showPicker ? selectedHostId : defaultHostId;

  // A muted one-liner that only appears once the user points the agent at a host
  // other than the one they're on (or any host, when they have no current one).
  // The current-host default stays caption-free — picking your own machine needs
  // no explanation (shiki). Copy locked with Cindy (#task:1214).
  const showHostNote =
    showPicker && selectedHostId !== null && selectedHostId !== defaultHostId;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Please enter an agent name');
      return;
    }
    if (showPicker && !selectedHostId) {
      setError('Please choose which computer runs this agent');
      return;
    }
    try {
      const input: CreateAgentInput = { name: name.trim(), runtime };
      if (effectiveHostId) input.host_id = effectiveHostId;
      const res = await createAgent.mutateAsync(input);
      onCreated?.(res.agent.id);
      setName('');
      setRuntime('claude');
      setSelectedHostId(null);
      onOpenChange(false);
    } catch (err) {
      setError(friendlyCreateError(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Agent</DialogTitle>
          <DialogDescription>
            A reusable identity that works across all your channels.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ag-name">Name</Label>
            <Input
              id="ag-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="alice"
              autoFocus
            />
            <span className="text-xs text-text-muted">
              Letters / digits / hyphens / underscores (used for @mention,
              cannot be changed after creation)
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Runtime</Label>
            <div className="flex flex-wrap gap-2">
              {RUNTIMES.map(rt => {
                const isDisabled = rt.disabled === true;
                const isSelected = !isDisabled && runtime === rt.value;
                return (
                  <button
                    key={rt.value}
                    type="button"
                    disabled={isDisabled}
                    title={isDisabled ? 'coming soon' : undefined}
                    onClick={() => {
                      if (isDisabled) return;
                      setRuntime(rt.value);
                    }}
                    className={chipClass(isSelected, isDisabled)}
                  >
                    {rt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {showPicker ? (
            <div className="flex flex-col gap-1.5">
              <Label>Runs on</Label>
              <div className="flex flex-wrap gap-2">
                {activeLocalHosts.map(host => {
                  const isSelected = selectedHostId === host.id;
                  return (
                    <button
                      key={host.id}
                      type="button"
                      onClick={() => setSelectedHostId(host.id)}
                      className={chipClass(isSelected)}
                    >
                      {host.display_label ?? host.name}
                    </button>
                  );
                })}
              </div>
              {showHostNote ? (
                <span className="text-xs text-text-muted">
                  Agent runs on the selected computer.
                </span>
              ) : null}
            </div>
          ) : null}

          {error ? <div className="text-xs text-error">{error}</div> : null}

          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createAgent.isPending || hostsQuery.isLoading}
            >
              {createAgent.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const AGENT_CREATE_ERROR_MESSAGES: Record<string, string> = {
  local_host_ambiguous: 'Choose which computer should run this agent.',
  local_host_unbound:
    'No connected computer can run this agent. Connect one and try again.',
  host_revoked:
    "That computer isn't available anymore. Pick another and try again.",
  host_not_owned:
    "That computer isn't available anymore. Pick another and try again.",
  host_missing:
    "That computer isn't available anymore. Pick another and try again.",
};

/** Map a create-agent failure to a calm, user-facing line. Known
 *  host-placement codes keep their tailored copy; new backend errors still
 *  surface their structured reason instead of disappearing behind a generic
 *  retry message. */
function friendlyCreateError(err: unknown): string {
  return describeApiError(err, {
    actionLabel: "Couldn't create the agent",
    backendUnreachableMessage:
      "Can't reach the backend. Check your connection and try again.",
    fallbackMessage: "Couldn't create the agent. Please try again.",
    knownCodeMessages: AGENT_CREATE_ERROR_MESSAGES,
  });
}
