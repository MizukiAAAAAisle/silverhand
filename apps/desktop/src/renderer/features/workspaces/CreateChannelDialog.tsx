import { useState, useEffect, useMemo, type FormEvent } from 'react';
import { Lock, Hash, X } from 'lucide-react';
import type {
  ConversationVisibility,
  CreateConversationChannelInput,
} from '@silverhand/shared';
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
import { primaryAction, primaryCancel } from '@/features/common/PrimaryAction';
import { cn } from '@/lib/cn';
import {
  isBackendUnreachable,
  isRegistrationRequired,
  isUpdateRequired,
  useViewerUser,
} from '@/features/me/hooks';
import { MemberPicker, type MemberPickerCandidate } from './AgentPicker';
import { useCreateChannel, useWorkspaceMemberLists } from './hooks';
import type { WorkspaceCapabilities } from './workspace-capabilities';

// Stable empty member object so the useEffect dependency on `members` doesn't
// create a new reference every render when the query hasn't resolved yet.
const EMPTY_MEMBERS = { agents: [], humans: [] } as const;

/**
 * Pure builder for the channel-create wire payload. Exported for unit testing
 * so the request shape is locked independently of the form UI (a control can
 * look correct while the payload silently regresses).
 *
 * The two axes it settles, both keyed on whether the container HAS a member set
 * (`hasMembers`, from `workspaceCapabilities` — never a workspace kind string):
 *  - `visibility` is sent EXPLICITLY for a channel in a member-bearing
 *    workspace (never relying on the server default-on-omission), so the wire
 *    states intent. A memberless container omits it entirely — the agent-space
 *    channel path is always private and rejects `public`.
 *  - `member_user_ids` carries the (possibly empty) explicit human selection;
 *    the creator is unioned in server-side. A memberless container omits it —
 *    there is no member selection to send.
 */
export function computeCreateChannelPayload(input: {
  hasMembers: boolean;
  title: string;
  visibility: ConversationVisibility;
  selectedAgents: string[];
  selectedHumans: string[];
}): CreateConversationChannelInput {
  const { hasMembers, title, visibility, selectedAgents, selectedHumans } = input;
  return {
    title: title.trim(),
    member_agent_ids: hasMembers ? selectedAgents : [],
    member_user_ids: hasMembers ? selectedHumans : undefined,
    ...(hasMembers ? { visibility } : {}),
  };
}

/**
 * Which humans may be OFFERED as selectable members, given the current viewer
 * identity. Pure + exported so the timing invariant is falsifiable.
 *
 * The creator is auto-added by the backend and must never be a selectable
 * candidate. Until the viewer identity resolves (`viewerUserId === null`) we
 * cannot tell which human IS the creator — so we offer NO humans at all rather
 * than risk exposing the creator (who could then be picked and linger as an
 * orphan selection once identity lands and their candidate disappears). Once
 * known, the creator is filtered out.
 */
export function computeSelectableHumans<T extends { id: string }>(
  humans: ReadonlyArray<T>,
  viewerUserId: string | null,
): T[] {
  if (viewerUserId === null) return [];
  return humans.filter(user => user.id !== viewerUserId);
}

/**
 * Prune a human selection down to the ids still offered as candidates. Pure +
 * exported: this is the defence that stops a human selected before the viewer
 * identity resolved (or any vanished candidate) from surviving in the
 * submitted payload.
 */
export function pruneSelectedHumanIds(
  selected: ReadonlyArray<string>,
  validHumanIds: ReadonlyArray<string>,
): string[] {
  const valid = new Set(validHumanIds);
  return selected.filter(id => valid.has(id));
}

interface CreateChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string | null;
  /** What the container HAS, not what it is (#task:2066): the member picker and
   *  the payload's member / visibility fields all key on `hasMembers`. Derived
   *  by `workspaceCapabilities` — this dialog never sees a workspace kind. */
  capabilities: WorkspaceCapabilities;
  onCreated?: (id: string) => void;
}

export function CreateChannelDialog({
  open,
  onOpenChange,
  workspaceId,
  capabilities,
  onCreated,
}: CreateChannelDialogProps): JSX.Element {
  const [title, setTitle] = useState('');
  const [visibility, setVisibility] = useState<ConversationVisibility>('private');
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [selectedHumans, setSelectedHumans] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { data: members = EMPTY_MEMBERS } = useWorkspaceMemberLists(workspaceId);
  const createChannel = useCreateChannel(workspaceId);
  const viewer = useViewerUser();
  const viewerUserId =
    viewer.data
    && !isRegistrationRequired(viewer.data)
    && !isBackendUnreachable(viewer.data)
    && !isUpdateRequired(viewer.data)
      ? viewer.data.id
      : null;

  const { hasMembers } = capabilities;

  // Reset the whole form on close so a reopened dialog starts clean —
  // default visibility is Private (the safe, non-discoverable default) and no
  // members pre-selected: the user chooses who's in (agents and humans alike;
  // the creator is unioned in server-side).
  useEffect(() => {
    if (open) return;
    setTitle('');
    setVisibility('private');
    setSelectedAgents([]);
    setSelectedHumans([]);
    setError(null);
  }, [open]);

  const candidates = useMemo<MemberPickerCandidate[]>(
    () => [
      ...members.agents.map(agent => ({ kind: 'agent' as const, agent })),
      // The creator is auto-added server-side and must never be a selectable
      // human candidate; while the viewer identity is unknown we offer no
      // humans at all. See `computeSelectableHumans` for the timing rationale.
      ...computeSelectableHumans(members.humans, viewerUserId).map(user => ({
        kind: 'human' as const,
        user,
      })),
    ],
    [members, viewerUserId],
  );

  // Defence in depth for the same invariant: prune any selected human that is
  // no longer a valid candidate (e.g. selected before the viewer identity
  // resolved). Functional update preserves the array reference when nothing
  // changed, so this cannot loop.
  useEffect(() => {
    const validHumanIds = candidates
      .filter(c => c.kind === 'human')
      .map(c => c.user.id);
    setSelectedHumans(prev => {
      const next = pruneSelectedHumanIds(prev, validHumanIds);
      return next.length === prev.length ? prev : next;
    });
  }, [candidates]);
  const selectedMembers = useMemo(
    () => [
      ...selectedAgents.map(id => `agent:${id}`),
      ...selectedHumans.map(id => `human:${id}`),
    ],
    [selectedAgents, selectedHumans],
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim()) {
      setError('Please enter a channel title');
      return;
    }
    // A channel in a memberless container (Agent Space) carries no member
    // selection, and visibility is N/A there (that path is always private and
    // rejects `public`). The exact wire shape is settled by
    // `computeCreateChannelPayload`.
    try {
      const channel = await createChannel.mutateAsync(
        computeCreateChannelPayload({
          hasMembers,
          title,
          visibility,
          selectedAgents,
          selectedHumans,
        }),
      );
      onCreated?.(channel.id);
      onOpenChange(false);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Channel</DialogTitle>
          <DialogDescription>A focused space with its own conversation context.</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="se-title">Title</Label>
            <Input
              id="se-title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="fix the login bug"
              autoFocus
            />
          </div>

          {hasMembers ? (
            <VisibilitySelect value={visibility} onChange={setVisibility} />
          ) : null}

          {hasMembers ? (
            <RegularMemberPicker
              candidates={candidates}
              selected={selectedMembers}
              onChange={values => {
                const agents: string[] = [];
                const humans: string[] = [];
                for (const value of values) {
                  const [kind, id] = value.split(':', 2);
                  if (!id) continue;
                  if (kind === 'agent') agents.push(id);
                  if (kind === 'human') humans.push(id);
                }
                setSelectedAgents(agents);
                setSelectedHumans(humans);
              }}
            />
          ) : null}

          {error ? <div className="text-xs text-error">{error}</div> : null}

          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              {...primaryCancel()}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createChannel.isPending}
              {...primaryAction()}
            >
              {createChannel.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The two channel-visibility options. Icons mirror the sidebar identity glyph
 *  language (private = Lock, public = `#`), so a user picks the same symbol
 *  they'll later recognise in the channel list. Rendered as two independent
 *  buttons — no segmented frame, no explanatory copy: the label + familiar
 *  glyph carry the meaning. */
const VISIBILITY_OPTIONS: ReadonlyArray<{
  value: ConversationVisibility;
  label: string;
  icon: typeof Lock;
}> = [
  { value: 'private', label: 'Private', icon: Lock },
  { value: 'public', label: 'Public', icon: Hash },
];

function VisibilitySelect({
  value,
  onChange,
}: {
  value: ConversationVisibility;
  onChange: (v: ConversationVisibility) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>Visibility</Label>
      {/* Single-select, so a11y-grouped as a radiogroup — but visually two
          independent buttons, each carrying its own border (no segmented
          container frame). Selected reuses the canonical neutral selected-row
          recipe (ink fill + border, never a brand hue). */}
      <div
        role="radiogroup"
        aria-label="Channel visibility"
        className="flex gap-2 self-start"
      >
        {VISIBILITY_OPTIONS.map(opt => {
          const selected = opt.value === value;
          const Icon = opt.icon;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(opt.value)}
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-[var(--control-radius)] border-[length:var(--control-border-width)] px-3 py-1.5 text-xs font-medium transition-colors',
                selected
                  ? 'border-[color:var(--border-row-selected)] bg-[var(--bg-row-selected)] text-text-on-selected'
                  // Resting matches the member chips below (bg-base + subtle
                  // border). Hover is the canonical control-hover recipe: an
                  // ink border (`--border-control-hover` — dark ink in warm,
                  // near-black in forza6, neutral in slack) plus the shared
                  // selectable-option fill (`--bg-option-hover` — forza6 pale
                  // lime, warm/slack neutral). NOT `--bg-row-hover`, which is a
                  // magenta brand tint in forza6.
                  : 'border-border-subtle bg-bg-base text-text-secondary hover:border-[color:var(--border-control-hover)] hover:bg-[var(--bg-option-hover)] hover:text-text-primary',
              )}
            >
              <Icon className="size-3.5" />
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RegularMemberPicker({
  candidates,
  selected,
  onChange,
}: {
  candidates: MemberPickerCandidate[];
  selected: string[];
  onChange: (values: string[]) => void;
}): JSX.Element {
  if (candidates.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <Label>Members</Label>
        <span className="text-xs text-text-muted">
          This workspace has no members yet. Add them from the Members panel
          first.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <Label htmlFor="se-add-member">
          Members
          <span className="ml-1 text-text-muted">
            ({selected.length} / {candidates.length})
          </span>
        </Label>
        {/* Clear the whole selection — a quiet inline glyph that only darkens
            on hover (no fill, not the destructive-red chip-remove): clearing a
            pick is mild and reversible, so it stays calm. Shown only when
            there's something to clear. */}
        {selected.length > 0 ? (
          <button
            type="button"
            onClick={() => onChange([])}
            aria-label="Clear selected members"
            className="shrink-0 rounded-[var(--control-radius)] text-text-muted transition-colors hover:text-text-primary focus-outline"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>

      <MemberPicker
        selectId="se-add-member"
        candidates={candidates}
        value={selected}
        onChange={onChange}
        placeholder={
          selected.length === 0 ? 'Select members to add…' : 'Add more members…'
        }
        allSelectedText="All members added"
      />
    </div>
  );
}
