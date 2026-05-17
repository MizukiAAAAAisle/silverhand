import { useEffect, useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { validateAvatarFile, type RuntimeKind } from '@silverhand/shared';
import { ApiError } from '@/lib/api';
import { AgentAvatar } from '@/components/AgentAvatar';
import { cn } from '@/lib/cn';
import { useUploadAgentAvatar, useClearAgentAvatar } from './hooks';

interface EditableAgentAvatarProps {
  agentId: string;
  /** Pixel size of the avatar circle (must match the existing static
   *  AgentAvatar size on the same surface so the page doesn't reflow
   *  when toggling between editable/read-only). */
  size: number;
  runtime: RuntimeKind;
  alt: string;
  /** Resolved object URL for the current avatar — fed by the parent's
   *  `useAgentAvatarObjectUrl` (single hook). `null` means no avatar
   *  yet, render the runtime tint. */
  avatarObjectUrl: string | null;
  /** Whether the agent has a server-side avatar today; drives the
   *  visibility of the "Remove" button. The parent passes
   *  `agent.avatar_url != null` — separate from `avatarObjectUrl`
   *  because the latter goes through a fetch and may be `null` even
   *  while the agent has an avatar (race during refresh). */
  hasAvatar: boolean;
}

/**
 * Editable variant of `<AgentAvatar>` for the agent profile card.
 *
 * Mirrors the human avatar UX (`features/me/RegistrationGate.tsx` /
 * SettingsPage profile section): same shared `validateAvatarFile`
 * client-side preflight (5MB cap, JPEG/PNG/GIF/WEBP), same hidden
 * `<input type="file">` triggered by a label, same "Change…/Choose…"
 * +  "Remove" pair.
 *
 * The widget is rendered ONLY when `canEditAgentProfile(viewer, agent)`
 * is true — non-creators see the static `<AgentAvatar>` plus a
 * read-only summary line in the card body. PR-2's avatar self-edit
 * lives on the internal token route only and is not reached from here.
 *
 * Error surfacing follows Cindy's PR-3 review tightening: we cover
 * the PR-2 service codes (`avatar_too_large` / `avatar_unsupported_type`
 * / `avatar_missing` / `avatar_storage_failed`) AND the cross-cutting
 * HTTP states (403 forbidden when the cached `created_by_user_id` is
 * stale, 404 agent_not_found, generic failure). The user must always
 * see *something* — we never silently swallow a mutation error.
 */
export function EditableAgentAvatar({
  agentId,
  size,
  runtime,
  alt,
  avatarObjectUrl,
  hasAvatar,
}: EditableAgentAvatarProps): JSX.Element {
  const upload = useUploadAgentAvatar(agentId);
  const clear = useClearAgentAvatar(agentId);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  // Clear the local error when the agent id changes — switching agents
  // shouldn't carry stale "Avatar must be PNG…" text from the previous
  // profile.
  useEffect(() => {
    setError(null);
  }, [agentId]);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0] ?? null;
    e.target.value = ''; // allow re-picking the same file later
    if (!file) return;
    setError(null);
    const validation = validateAvatarFile(file);
    if (validation) {
      setError(validation.message);
      return;
    }
    try {
      await upload.mutateAsync(file);
    } catch (err) {
      setError(formatAvatarMutationError(err));
    }
  };

  const onRemove = async (): Promise<void> => {
    setError(null);
    try {
      await clear.mutateAsync();
    } catch (err) {
      setError(formatAvatarMutationError(err));
    }
  };

  const pending = upload.isPending || clear.isPending;
  const labelText = hasAvatar ? 'Change…' : 'Choose…';

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <div className="relative">
          <AgentAvatar
            runtime={runtime}
            size={size}
            avatarObjectUrl={avatarObjectUrl}
            alt={alt}
          />
          {pending ? (
            <span
              className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full bg-bg-base/40"
              aria-hidden
            >
              <Camera className="size-4 text-text-muted" />
            </span>
          ) : null}
        </div>
        <label
          className={cn(
            'inline-flex cursor-pointer items-center gap-1 rounded-md border border-border-subtle px-2.5 py-1 text-xs text-text-primary transition-colors hover:bg-bg-hover',
            pending && 'pointer-events-none opacity-50',
          )}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            onChange={onPick}
            className="sr-only"
            disabled={pending}
          />
          {labelText}
        </label>
        {hasAvatar ? (
          <button
            type="button"
            onClick={() => void onRemove()}
            disabled={pending}
            className="text-[11px] text-text-muted underline-offset-2 hover:underline disabled:opacity-50"
          >
            Remove
          </button>
        ) : null}
      </div>
      {error ? (
        <p
          role="alert"
          className="text-[11px] leading-snug text-error"
          data-testid="agent-avatar-error"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Map a failed avatar mutation to a one-line, user-facing message.
 *
 * Three sources are folded in (Cindy PR-3 review #2 — "stale/permission
 * race" handling):
 *
 * 1. Client-side `validateAvatarFile` is handled separately by the
 *    caller and never reaches here; the user already sees its
 *    `.message`.
 * 2. PR-2 service codes carried in the response JSON's `code` field
 *    on 4xx (`avatar_too_large` 413 / `avatar_unsupported_type` 415 /
 *    `avatar_missing` 400 / `avatar_storage_failed` 400). We re-render
 *    the localized message here rather than echoing the raw code so
 *    non-EN users get a real sentence.
 * 3. Cross-cutting HTTP states the route layer raises before service
 *    code runs: 403 forbidden (cached creator id is stale, or the
 *    agent was just transferred), 404 agent_not_found (deleted
 *    underfoot), 401 (token expired). Each gets its own message; we
 *    never collapse them into the avatar codes above.
 *
 * The fallback (`Failed to update avatar.`) covers everything else —
 * network errors, 5xx, malformed responses. Cindy: "UI 至少要有明确
 * fallback ... 不要只依赖 avatar code".
 */
export function formatAvatarMutationError(err: unknown): string {
  if (err instanceof ApiError) {
    // Try to surface the structured code first.
    const code = parseErrorCode(err.body);
    switch (code) {
      case 'avatar_too_large':
        return 'Avatar must be 5 MB or smaller.';
      case 'avatar_unsupported_type':
        return 'Avatar must be a PNG, JPEG, GIF, or WEBP image.';
      case 'avatar_missing':
        return 'Avatar file is empty.';
      case 'avatar_storage_failed':
        return 'Storage backend failed to write the avatar. Try again.';
      default:
        // Fall through to status-based messages.
        break;
    }
    switch (err.status) {
      case 401:
        return 'Sign-in expired. Reload the app and try again.';
      case 403:
        return "You no longer have permission to edit this agent's avatar.";
      case 404:
        return 'This agent no longer exists.';
      default:
        return `Failed to update avatar (HTTP ${err.status}).`;
    }
  }
  return 'Failed to update avatar.';
}

function parseErrorCode(body: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}
