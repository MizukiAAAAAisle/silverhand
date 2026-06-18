import { useState, type FormEvent } from 'react';
import type { RuntimeKind } from '@silverhand/shared';
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
import { useCreateAgent } from './hooks';

// Runtime catalog for the create dialog. `disabled` runtimes appear in
// the picker but can't be selected — they're listed so users know what
// the roadmap looks like without us silently dropping options. `qoder`
// isn't a real RuntimeKind yet (no driver / no DB enum value), so it's
// rendered from a parallel struct rather than from RuntimeKind.
type RuntimeChoice =
  | { value: RuntimeKind; label: string; disabled?: boolean }
  | { value: 'qoder'; label: string; disabled: true };

const RUNTIMES: RuntimeChoice[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex CLI' },
  { value: 'cursor', label: 'Cursor', disabled: true },
  { value: 'gemini', label: 'Gemini', disabled: true },
  { value: 'qoder', label: 'Qoder', disabled: true },
];

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
  const [error, setError] = useState<string | null>(null);
  const createAgent = useCreateAgent();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Please enter an agent name');
      return;
    }
    try {
      const res = await createAgent.mutateAsync({
        name: name.trim(),
        runtime,
      });
      onCreated?.(res.agent.id);
      setName('');
      setRuntime('claude');
      onOpenChange(false);
    } catch (err) {
      setError(String(err));
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
                      setRuntime(rt.value as RuntimeKind);
                    }}
                    className={
                      // Selected = the theme's own selection colour as the fill
                      // (`--bg-row-selected`: forza6 acid lime / warm yellow /
                      // slack blue) — NOT gray and NOT accent-pink (both
                      // rejected), the native "selected" semantic that's loud
                      // enough to read at a glance. Ink border + lime fill is
                      // forza6's poster pairing (same as inline-code). Text is
                      // held CONSTANT at text-primary across states (shiki) and
                      // stays legible on every theme's fill. Border WIDTH follows
                      // the per-theme `--control-border-width` token (forza6 2px,
                      // warm/slack 1px). Real cross-theme tokens — the old
                      // `accent-base`/`border-default`/`border-strong` classes
                      // were undefined no-ops (#task:1176).
                      'rounded-[var(--control-radius)] border-[length:var(--control-border-width)] px-3 py-1.5 text-xs transition-colors ' +
                      (isDisabled
                        ? 'cursor-not-allowed border-border-subtle text-text-muted opacity-50'
                        : isSelected
                        ? 'border-text-primary bg-[var(--bg-row-selected)] text-text-primary'
                        : 'border-border-subtle text-text-primary hover:border-border')
                    }
                  >
                    {rt.label}
                  </button>
                );
              })}
            </div>
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
            <Button type="submit" disabled={createAgent.isPending}>
              {createAgent.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
