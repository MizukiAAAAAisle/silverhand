import { useEffect, useState } from "react";
import { Camera } from "lucide-react";
import { validateAvatarFile, type RuntimeKind } from "@silverhand/shared";
import { ApiError } from "@/lib/api";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AvatarPickerButton } from "@/components/AvatarPickerButton";
import { useUploadAgentAvatar } from "../hooks/hooks";

interface EditableAgentAvatarProps {
  agentId: string;
  /** Pixel size of the avatar square (must match the existing static
   *  AgentAvatar size on the same surface so the page doesn't reflow
   *  when toggling between editable/read-only). */
  size: number;
  runtime: RuntimeKind;
  alt: string;
  /** Resolved object URL for the current avatar — fed by the parent's
   *  `useAgentAvatarObjectUrl` (single hook). `null` means no avatar
   *  yet, render the runtime tint. */
  avatarObjectUrl: string | null;
  /** Selects the Add/Edit label. */
  hasAvatar: boolean;
}

/**
 * Editable variant of `<AgentAvatar>` for the agent profile card.
 *
 * UX (per #task:314): the entire avatar square is the click target.
 * Hovering reveals a bottom strip with the visible verb (`Edit` /
 * `Add`); clicking anywhere on the avatar opens the file picker. The
 * previous separate `Choose…/Change…` button has been removed so this
 * widget matches the human avatar editor in `RegistrationGate` and
 * `SettingsPage > Profile`. Verbose screen-reader text lives on the
 * picker's `ariaLabel` because the visible label is forced short to
 * fit inside the 56px frame's clip.
 *
 * Error surfacing follows Cindy's PR-3 review tightening: we cover the
 * PR-2 service codes (`avatar_too_large` / `avatar_unsupported_type` /
 * `avatar_missing` / `avatar_storage_failed`) AND the cross-cutting HTTP
 * states (403 forbidden when the cached `created_by_user_id` is stale,
 * 404 agent_not_found, generic failure). The user must always see
 * *something* — we never silently swallow a mutation error.
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
  const [error, setError] = useState<string | null>(null);

  // Clear the local error when the agent id changes — switching agents
  // shouldn't carry stale "Avatar must be PNG…" text from the previous
  // profile.
  useEffect(() => {
    setError(null);
  }, [agentId]);

  const onPick = async (file: File): Promise<void> => {
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

  const pending = upload.isPending;
  // Visible label MUST be short — the strip sits inside the avatar's
  // 56px frame clip. ariaLabel carries the verbose screen-reader
  // text. Cindy review #task:314: "Change photo" overflowed and was
  // cut horizontally even at 56px once uppercase tracking was applied.
  const pickerLabel = hasAvatar ? "Edit" : "Add";
  const pickerAriaLabel = hasAvatar ? `Change avatar for @${alt}` : `Add avatar for @${alt}`;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative">
        <AvatarPickerButton
          size={size}
          label={pickerLabel}
          onPick={(file) => void onPick(file)}
          disabled={pending}
          ariaLabel={pickerAriaLabel}
        >
          <AgentAvatar runtime={runtime} size={size} avatarObjectUrl={avatarObjectUrl} alt={alt} />
        </AvatarPickerButton>
        {pending ? (
          <span
            className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-none bg-bg-base/40"
            aria-hidden
          >
            <Camera className="size-4 text-text-muted" />
          </span>
        ) : null}
      </div>
      {error ? (
        <p
          role="alert"
          className="text-(length:--text-meta) leading-snug text-error"
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
      case "avatar_too_large":
        return "Avatar must be 5 MB or smaller.";
      case "avatar_unsupported_type":
        return "Avatar must be a PNG, JPEG, GIF, or WEBP image.";
      case "avatar_missing":
        return "Avatar file is empty.";
      case "avatar_storage_failed":
        return "Storage backend failed to write the avatar. Try again.";
      default:
        // Fall through to status-based messages.
        break;
    }
    switch (err.status) {
      case 401:
        return "Sign-in expired. Reload the app and try again.";
      case 403:
        return "You no longer have permission to edit this agent's avatar.";
      case 404:
        return "This agent no longer exists.";
      default:
        return `Failed to update avatar (HTTP ${err.status}).`;
    }
  }
  return "Failed to update avatar.";
}

function parseErrorCode(body: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed.code === "string" ? parsed.code : null;
  } catch {
    return null;
  }
}
