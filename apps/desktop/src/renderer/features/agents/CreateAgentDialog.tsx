import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import { RefreshCw } from 'lucide-react';
import type {
  CreateAgentInput,
  RuntimeAvailabilityState,
  RuntimeKind,
} from '@silverhand/shared';
import {
  RUNTIME_CATALOG,
  runtimeCatalogEntry,
  runtimeDefaultModel,
} from '@silverhand/shared';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Combobox } from '@/components/ui/combobox';
import { Input, Label } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { describeApiError } from '@/lib/api-error-message';
import {
  NameAvailabilityHint,
  useNameAvailability,
} from '@/features/naming/useNameAvailability';
import {
  useHostAvailabilityMap,
  useHostRuntimeCatalog,
  useHostsQuery,
} from '@/features/hosts/hooks';
import { isComputerAvailable } from '@/features/hosts/host-display';
import { ComputerPicker } from '@/features/hosts/ComputerPicker';
import { useCreateAgent } from './hooks';
import {
  deriveRuntimePickerMode,
  runtimeChipDisabled,
  runtimeSectionHint,
} from './runtime-detection-ui';

// The picker lists only offerable runtimes (`selectable`) — shiki: 没支持的
// 直接不展示 (no roadmap/"coming soon" rows in a focused create task). Which
// of these is actually installed on the chosen computer is detected per host
// at runtime (see the runtime-catalog probe below), never baked in here.
const SELECTABLE_RUNTIMES = RUNTIME_CATALOG.filter(entry => entry.selectable);

// Shared chip styling for the Runtime + "Computer" pickers: ink border +
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

/** The only two runtime-detection facts the parent form needs from the
 *  self-contained <RuntimePicker/>: whether to disable Create (nothing
 *  installed) and the submit backstop (the picked runtime is absent). The
 *  probe, its states, and the Recheck churn all stay inside the child. */
interface RuntimeGate {
  allAbsent: boolean;
  selectedAbsent: boolean;
}

const EMPTY_RUNTIME_GATE: RuntimeGate = {
  allAbsent: false,
  selectedAbsent: false,
};

export function CreateAgentDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateAgentDialogProps): JSX.Element {
  const [name, setName] = useState('');
  const [runtime, setRuntime] = useState<RuntimeKind>('claude');
  // Model tracks the selected runtime's catalog default (qoder → `Ultimate`,
  // others → blank = the runtime's own CLI default). Switching runtime resets
  // it to that runtime's default so the field always reflects what will be
  // stored (the backend applies the same default, but showing it here keeps
  // create WYSIWYG). Any suggested tier or custom model-id is accepted.
  const [model, setModel] = useState(runtimeDefaultModel('claude') ?? '');
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const createAgent = useCreateAgent();
  // onBlur name validation — format (shared EntityNameSchema) + uniqueness
  // (agents ∪ users, server probe). See features/naming/useNameAvailability.
  const nameCheck = useNameAvailability('agent', name);

  const modelSuggestions = runtimeCatalogEntry(runtime).modelSuggestions;

  // Switching runtime resets the model to the new runtime's default. A model-id
  // is runtime-specific (qoder tiers vs a codex/claude id), so carrying a stale
  // value across a runtime switch would be meaningless — mirror the backend's
  // per-runtime normalization at the form. `useCallback` keeps a stable
  // identity so passing it to <RuntimePicker/> doesn't churn that child's
  // effects.
  const selectRuntime = useCallback((next: RuntimeKind): void => {
    setRuntime(next);
    setModel(runtimeDefaultModel(next) ?? '');
  }, []);

  const hostsQuery = useHostsQuery();

  // Placement candidates come straight from the backend's `placeable`
  // predicate — a single, kind-independent eligibility source (doc §5.4). An
  // online, finalized user-managed (daemon) computer is just as valid a target
  // as the local one, so we never re-derive eligibility from `kind` here.
  const placeableHosts = useMemo(
    () => (hostsQuery.data?.hosts ?? []).filter(host => host.placeable),
    [hostsQuery.data],
  );
  const placeableHostIds = useMemo(
    () => placeableHosts.map(host => host.id),
    [placeableHosts],
  );

  // Second placement axis: a `placeable` computer can only actually run an
  // agent if its daemon is online right now. We probe live availability per
  // candidate; offline/unreachable ones stay visible but disabled in the
  // picker, and only `available` computers count toward the default and the
  // submit check (shiki #task:1359).
  const { availabilityById, allSettled } = useHostAvailabilityMap(placeableHostIds);
  const availableHosts = useMemo(
    () =>
      placeableHosts.filter(host =>
        isComputerAvailable(availabilityById.get(host.id)),
      ),
    [placeableHosts, availabilityById],
  );

  // The computer picker is always present (0 available → nothing to pick,
  // 1 → preselected, several → no default so the user must choose).
  // `defaultHostId` seeds the selection; `selectedHostId` is the single source
  // of the chosen host. Gate the default on `allSettled` (Cindy P1): while
  // probes resolve one by one, a transient single `available` must NOT
  // auto-select, or two online computers could still end up with a default.
  const defaultHostId =
    allSettled && availableHosts.length === 1
      ? (availableHosts[0]?.id ?? null)
      : null;

  // Preselect the sole available host when the picker opens; clear on close.
  // If a previously-chosen host drops offline while the dialog is open, fall
  // back to the default rather than keeping a now-unpickable selection. `prev`
  // otherwise preserves an explicit user choice.
  useEffect(() => {
    if (!open) {
      setSelectedHostId(null);
      setRuntimeGate(EMPTY_RUNTIME_GATE);
      return;
    }
    const availableIds = new Set(availableHosts.map(host => host.id));
    setSelectedHostId(prev =>
      prev && availableIds.has(prev) ? prev : defaultHostId,
    );
  }, [open, defaultHostId, availableHosts]);

  // The picker is the single source of the chosen host; when no placeable
  // computer exists `selectedHostId` stays null and the backend resolves.
  const effectiveHostId = selectedHostId;

  // Runtime detection is host-local and lives entirely inside <RuntimePicker/>
  // below: it probes the selected computer and reports back only the two gating
  // facts the rest of the form needs (`allAbsent` for the Create button,
  // `selectedAbsent` for the submit backstop). Keeping the probe — and its
  // Recheck / isReprobing churn — inside that child means a Recheck re-renders
  // just the runtime chips, never the whole dialog (shiki: 只刷新 runtime 那些
  //值的状态).
  const selectedHostAvailable = selectedHostId
    ? isComputerAvailable(availabilityById.get(selectedHostId))
    : false;
  const [runtimeGate, setRuntimeGate] = useState<RuntimeGate>(EMPTY_RUNTIME_GATE);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Please enter an agent name');
      return;
    }
    // Final format pass — arms the inline hint even on a field never blurred.
    // Uniqueness is left to create (the authoritative backstop).
    if (!nameCheck.formatValid) {
      nameCheck.markTouched();
      return;
    }
    if (placeableHosts.length > 0) {
      if (!allSettled) {
        // Probes still landing — the Create button is disabled meanwhile, but
        // guard here too so a stale click can't fall through to a misleading
        // "no computer online".
        setError('Checking which computers are online…');
        return;
      }
      if (availableHosts.length === 0) {
        setError('No computer is online right now. Connect one and try again.');
        return;
      }
      if (!selectedHostId || !availableHosts.some(h => h.id === selectedHostId)) {
        setError('Please choose an online computer to run this agent');
        return;
      }
    }
    // Fail-fast on a genuinely-absent runtime (fresh probe of an available
    // host only — never on a probe gap). <RuntimePicker/>'s auto-fallback
    // normally moves selection off an absent runtime; this guards the
    // all-absent case and any race before that effect runs.
    if (runtimeGate.selectedAbsent) {
      setError('That runtime is not installed on the selected computer.');
      return;
    }
    try {
      const input: CreateAgentInput = { name: name.trim(), runtime };
      const trimmedModel = model.trim();
      if (trimmedModel) input.model = trimmedModel;
      if (effectiveHostId) input.host_id = effectiveHostId;
      const res = await createAgent.mutateAsync(input);
      onCreated?.(res.agent.id);
      setName('');
      setRuntime('claude');
      setModel(runtimeDefaultModel('claude') ?? '');
      setSelectedHostId(null);
      setRuntimeGate(EMPTY_RUNTIME_GATE);
      onOpenChange(false);
    } catch (err) {
      setError(friendlyCreateError(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>New Agent</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ag-host" required className="font-semibold">
              Computer
            </Label>
            <ComputerPicker
              id="ag-host"
              hosts={placeableHosts}
              availabilityById={availabilityById}
              value={selectedHostId}
              onChange={setSelectedHostId}
              ariaLabel="Computer"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ag-name" required className="font-semibold">
              Name
            </Label>
            <Input
              id="ag-name"
              value={name}
              onChange={e => setName(e.target.value)}
              onBlur={nameCheck.markTouched}
              aria-invalid={nameCheck.blocking || undefined}
              placeholder="alice"
              autoFocus
            />
            <NameAvailabilityHint check={nameCheck} />
          </div>

          <RuntimePicker
            hostId={selectedHostId}
            hostAvailable={selectedHostAvailable}
            value={runtime}
            onSelect={selectRuntime}
            onGateChange={setRuntimeGate}
          />

          <div className="flex flex-col gap-1.5">
            {/* No `htmlFor` → the caption is a plain visual label, not a
                click target. A `<label htmlFor="ag-model">` forwards its click
                to the Combobox input (id `ag-model`), whose `onClick` opens the
                suggestions dropdown — so clicking the "Model" text popped the
                list open (shiki 2026-07-21). The input carries its own
                `aria-label="Model"`, so a11y naming is unaffected. Matches the
                edit form's bare `<Label>Model</Label>` (RuntimeConfigEditor). */}
            <Label className="font-semibold">Model</Label>
            <Combobox
              id="ag-model"
              ariaLabel="Model"
              value={model}
              onChange={setModel}
              onCommit={setModel}
              suggestions={modelSuggestions}
              placeholder="driver default"
              className="h-8"
            />
          </div>

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
              disabled={
                createAgent.isPending
                || hostsQuery.isLoading
                || (placeableHosts.length > 0 && !allSettled)
                || runtimeGate.allAbsent
                || nameCheck.blocking
              }
            >
              {createAgent.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface RuntimePickerProps {
  hostId: string | null;
  hostAvailable: boolean;
  value: RuntimeKind;
  onSelect: (kind: RuntimeKind) => void;
  onGateChange: (gate: RuntimeGate) => void;
}

/**
 * Self-contained runtime section for the create dialog (#task:1376). It owns
 * the per-host detection probe (`useHostRuntimeCatalog`) and its Recheck /
 * isReprobing state, so a Recheck re-renders ONLY these chips — not the host /
 * name / model fields (shiki: 只刷新 runtime 那些值的状态). The parent gets back
 * just the two gating booleans via `onGateChange`, and only when they actually
 * flip, so an unchanged Recheck never re-renders the whole form.
 *
 * Disable rules live in the pure core (`runtime-detection-ui.ts`): a chip is
 * disabled ONLY on a fresh probe of an available host reporting deterministic
 * `absent`; every probe gap (offline / probing / probe-failed) leaves the chip
 * pickable — spawn is the ground truth, so a probe hiccup must not trap an
 * installed runtime.
 */
function RuntimePicker({
  hostId,
  hostAvailable,
  value,
  onSelect,
  onGateChange,
}: RuntimePickerProps): JSX.Element {
  const runtimeCatalog = useHostRuntimeCatalog(hostId, {
    enabled: hostAvailable,
  });
  const runtimeStateByKind = useMemo(() => {
    const map = new Map<RuntimeKind, RuntimeAvailabilityState>();
    for (const info of runtimeCatalog.data?.runtimes ?? []) {
      map.set(info.kind, info.state);
    }
    return map;
  }, [runtimeCatalog.data]);

  const mode = deriveRuntimePickerMode({
    hasHost: Boolean(hostId),
    // RuntimePicker mounts only after the host availability map has resolved
    // (see the `allSettled` gate in the parent), so this axis is always
    // settled at this point — pass false explicitly to keep the pure core's
    // signature honest instead of hiding the invariant.
    isHostAvailabilityLoading: false,
    hostAvailable,
    isLoading: runtimeCatalog.isLoading,
    isError: runtimeCatalog.isError,
  });
  const detectionActive = mode === 'detected';
  const sectionHint = runtimeSectionHint(mode);

  const allAbsent =
    detectionActive
    && SELECTABLE_RUNTIMES.every(
      entry => runtimeStateByKind.get(entry.kind) === 'absent',
    );
  const selectedAbsent =
    detectionActive && runtimeStateByKind.get(value) === 'absent';

  // Report the gating facts up. Deps are the two primitives, so this fires only
  // when they actually flip — the isReprobing spinner toggling or a Recheck
  // that finds no change never re-renders the parent form.
  useEffect(() => {
    onGateChange({ allAbsent, selectedAbsent });
  }, [allAbsent, selectedAbsent, onGateChange]);

  // If the picked runtime is absent on this computer, move to the first
  // installed one so the form stays creatable (mirrors the host-picker's
  // offline fallback). If none are installed, leave it — Create is gated and
  // the section shows the empty state.
  useEffect(() => {
    if (!detectionActive) return;
    if (runtimeStateByKind.get(value) !== 'absent') return;
    const firstInstalled = SELECTABLE_RUNTIMES.find(
      entry => runtimeStateByKind.get(entry.kind) !== 'absent',
    );
    if (firstInstalled) onSelect(firstInstalled.kind);
  }, [detectionActive, runtimeStateByKind, value, onSelect]);

  const checking = runtimeCatalog.isLoading || runtimeCatalog.isReprobing;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Label required className="font-semibold">
            Runtime
          </Label>
          {/* Light in-progress tip while a probe / Recheck runs. It lives in
              the label row so showing it never changes the section height — the
              dialog is vertically centered, so any height delta would re-center
              the whole modal and read as a jump (shiki). */}
          {checking ? (
            <span className="text-xs font-normal text-text-muted">
              Detecting…
            </span>
          ) : null}
        </div>
        {hostAvailable ? (
          <button
            type="button"
            onClick={() => void runtimeCatalog.reprobe()}
            disabled={checking}
            aria-label="Recheck installed runtimes"
            title="Recheck"
            className="border border-transparent p-1 text-text-muted transition-colors hover:text-text-primary disabled:cursor-default disabled:opacity-60"
          >
            <RefreshCw className={cn('size-3.5', checking && 'animate-spin')} />
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {SELECTABLE_RUNTIMES.map(entry => {
          const absent = runtimeChipDisabled(
            mode,
            runtimeStateByKind.get(entry.kind),
          );
          const isSelected = !absent && value === entry.kind;
          const state = detectionActive
            ? runtimeStateByKind.get(entry.kind)
            : undefined;
          const title =
            state === 'absent'
              ? 'Not detected on this computer'
              : state === 'present_unverified'
                ? 'Installed · version unverified'
                : state === 'unknown'
                  ? "Couldn't verify — you can still create"
                  : undefined;
          return (
            <button
              key={entry.kind}
              type="button"
              disabled={absent}
              title={title}
              onClick={() => {
                if (!absent) onSelect(entry.kind);
              }}
              className={chipClass(isSelected, absent)}
            >
              {entry.cliLabel}
              {absent ? (
                <span className="ml-1.5 text-text-muted">· not installed</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {/* Always-reserved single-line status slot. Rendering it unconditionally
          (even when empty) keeps the section — and thus the vertically-centered
          dialog — height-stable across probing / detected / hint / empty-state,
          so it can't jitter (shiki: runtime list 有->无->有 高度变化导致抖动). */}
      <div className="min-h-4 text-xs text-text-muted">
        {sectionHint
          ?? (allAbsent
            ? 'No supported runtime detected on this computer.'
            : null)}
      </div>
    </div>
  );
}

const AGENT_CREATE_ERROR_MESSAGES: Record<string, string> = {
  local_host_ambiguous: 'Choose which computer should run this agent.',
  local_host_unbound:
    'No connected computer can run this agent. Connect one and try again.',
  host_attach_pending:
    'That computer is not connected yet. Try again in a moment.',
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
