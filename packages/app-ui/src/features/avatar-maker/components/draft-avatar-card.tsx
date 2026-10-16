import { useState, type ReactNode } from "react";
import { EditIcon } from "@/icons";
import { AvatarPickerButton } from "@/components/avatar-picker-button";
import { AVATAR_PX } from "@/components/avatar-scale";
import type { DraftAvatar } from "../hooks/use-draft-avatar";
import { AvatarConfigPreview } from "./avatar-config-preview";
import { AvatarMakerDialog } from "./avatar-maker-dialog";
import { AvatarMakerGlyph } from "./avatar-maker-glyph";

/** The avatar block at the top of signup and profile setup. A composed face is
 *  already there, with Random and Customize beside it, so the maker is discovered
 *  before the account exists. */
export function DraftAvatarCard({ draft, disabled }: { draft: DraftAvatar; disabled?: boolean }) {
  const [makerOpen, setMakerOpen] = useState(false);
  const size = AVATAR_PX.profile;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <AvatarPickerButton
          size={size}
          ariaLabel="Upload photo"
          disabled={disabled}
          className="border border-border-subtle"
          onPick={draft.pick}
        >
          {draft.photoUrl ? (
            <img src={draft.photoUrl} alt="Avatar preview" className="size-full object-cover" />
          ) : (
            <AvatarConfigPreview config={draft.composed} size={size} />
          )}
        </AvatarPickerButton>
        <div className="flex flex-col items-start gap-2.5">
          <CardAction icon={<AvatarMakerGlyph />} disabled={disabled} onClick={draft.shuffle}>
            Random
          </CardAction>
          <CardAction
            icon={<EditIcon className="size-3.5" />}
            disabled={disabled}
            onClick={() => setMakerOpen(true)}
          >
            Customize
          </CardAction>
        </div>
      </div>
      {draft.error ? (
        <p role="alert" className="text-xs text-error">
          {draft.error}
        </p>
      ) : null}
      <AvatarMakerDialog
        open={makerOpen}
        onOpenChange={setMakerOpen}
        initialConfig={draft.composed}
        onSave={async ({ config }) => draft.compose(config)}
      />
    </div>
  );
}

/** A quiet text action: icons share one 18px slot so labels align; hover draws an underline under the label from left to right. */
function CardAction({
  icon,
  disabled,
  onClick,
  children,
}: {
  icon: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="group inline-flex items-center gap-2 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary focus-outline disabled:pointer-events-none disabled:opacity-50"
    >
      <span className="grid size-[18px] shrink-0 place-items-center">{icon}</span>
      <span className="relative">
        {children}
        <span
          aria-hidden
          className="absolute inset-x-0 -bottom-0.5 h-px origin-left scale-x-0 bg-border-control transition-transform duration-200 ease-out group-hover:scale-x-100 group-focus-visible:scale-x-100 motion-reduce:transition-none"
        />
      </span>
    </button>
  );
}
