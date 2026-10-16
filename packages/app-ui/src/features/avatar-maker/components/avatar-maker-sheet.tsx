import { useAvatarDesign, type AvatarDesignSubject } from "../hooks/use-avatar-design";
import { editorStartConfig } from "../model/avatar-design-wire";
import { AvatarMakerDialog, type AvatarMakerResult } from "./avatar-maker-dialog";

export interface AvatarMakerSheetProps {
  subject: AvatarDesignSubject;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (result: AvatarMakerResult) => Promise<void>;
}

/** The maker for a saved principal: opens on the stored design when the current avatar
 *  came from the maker, otherwise on a random face. */
export function AvatarMakerSheet({ subject, open, onOpenChange, onSave }: AvatarMakerSheetProps) {
  const design = useAvatarDesign(subject, open);

  return (
    <AvatarMakerDialog
      open={open && !design.isPending}
      onOpenChange={onOpenChange}
      initialConfig={editorStartConfig(design.data)}
      onSave={onSave}
    />
  );
}
