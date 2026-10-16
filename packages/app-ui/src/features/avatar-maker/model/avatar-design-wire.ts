import type { AvatarDesign } from "@silverhand/shared";
import { AVATAR_LIBRARY } from "./avatar-library";
import { normalizeAvatarConfig, randomAvatarConfig, type AvatarConfig } from "./avatar-config";

// Sent as the multipart `AVATAR_DESIGN_FIELD`, set before `file`: older backends
// stop reading at `file`, and every upload bridge keeps string fields first.
export function avatarDesignField(config: AvatarConfig): string {
  const wire: AvatarDesign = { parts_version: AVATAR_LIBRARY.version, config: { ...config } };

  return JSON.stringify(wire);
}

export function editorStartConfig(design: AvatarDesign | null | undefined): AvatarConfig {
  return design ? normalizeAvatarConfig(design.config) : randomAvatarConfig();
}
