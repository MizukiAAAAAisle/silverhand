import { useRef, type ReactNode } from "react";
import { CameraIcon, EditIcon, UploadIcon } from "@/icons";
import { AppDropdownMenu, AppDropdownMenuItem } from "@/components/menus/app-context-menu";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export interface AvatarPickerButtonProps {
  /**
   * The avatar visual itself (e.g. `<AgentAvatar>` or a custom `<img>` /
   * placeholder). The picker treats it as a square silhouette of
   * `size` × `size` pixels and overlays the hover affordance on top.
   * The visual must already be rendered at `size`; the picker doesn't
   * resize children.
   */
  children: ReactNode;
  /**
   * Pixel size of the avatar square. Used to constrain the click target
   * and to scale the hover veil's icon.
   */
  size: number;
  /**
   * Called with the picked `File`. Caller handles validation (we keep
   * the picker presentational so the same component fits both
   * mutation-driven flows and the registration gate's "stage locally,
   * upload on submit" flow).
   */
  onPick: (file: File) => void;
  /** Opens the avatar maker as a menu item beside Upload photo. Without it the
   *  avatar opens the file picker directly, for surfaces that show the maker elsewhere. */
  onMake?: () => void;
  /** Leading glyph of the Make avatar item, supplied by the avatar-maker feature. */
  makeIcon?: ReactNode;
  /**
   * Disables click and dims the surface — typically wired to an
   * upload mutation's `isPending`.
   */
  disabled?: boolean;
  /** Accessible name of the avatar button, e.g. `'Change avatar'` / `'Add avatar for @alice'`. */
  ariaLabel: string;
  /** Extra classes applied to the avatar button frame. */
  className?: string;
}

/**
 * Click-the-avatar avatar editor.
 *
 * The whole square is the one entry: clicking it opens a menu anchored on the
 * avatar with the two equal ways to change it, Make avatar and Upload photo, or
 * the file picker directly when no `onMake` is given.
 * On hover or keyboard focus a veil covers the avatar with the action's icon:
 * edit when it opens the menu, upload when it opens the file picker.
 *
 * Removal is intentionally *not* part of this widget: callers render a
 * small "Remove" link beside the picker when an avatar is set, keeping the
 * destructive action outside the click target.
 *
 * Presentational by design — `onPick` is just the picked `File` and `onMake`
 * just a request to open the maker. The caller owns validation and mutations.
 */
export function AvatarPickerButton({
  children,
  size,
  onPick,
  onMake,
  makeIcon,
  disabled = false,
  ariaLabel,
  className,
}: AvatarPickerButtonProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const VeilIcon = onMake ? EditIcon : UploadIcon;
  const veilIconPx = Math.max(14, Math.min(22, Math.round(size * 0.28)));

  const trigger = (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        "group relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-(--avatar-radius) focus-outline",
        disabled ? "pointer-events-none opacity-50" : "cursor-pointer",
        className,
      )}
      style={{ width: size, height: size }}
      onClick={onMake ? undefined : () => inputRef.current?.click()}
    >
      {children}
      <span
        className={cn(
          "pointer-events-none absolute inset-0 grid place-items-center bg-black/45 text-white",
          "opacity-0 transition-opacity duration-100 ease-out",
          "group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:opacity-100",
        )}
        aria-hidden
      >
        <VeilIcon style={{ width: veilIconPx, height: veilIconPx }} />
      </span>
    </button>
  );

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null;
          // Reset so picking the same file again still fires `change`.
          e.target.value = "";
          if (file) onPick(file);
        }}
      />
      {onMake ? (
        <AppDropdownMenu align="start" contentClassName="min-w-[160px]" trigger={trigger}>
          <AppDropdownMenuItem icon={makeIcon} onSelect={onMake}>
            {t("ui.makeAvatar")}
          </AppDropdownMenuItem>
          <AppDropdownMenuItem
            icon={<CameraIcon className="size-3.5" />}
            onSelect={() => inputRef.current?.click()}
          >
            {t("ui.uploadPhoto")}
          </AppDropdownMenuItem>
        </AppDropdownMenu>
      ) : (
        trigger
      )}
    </>
  );
}
