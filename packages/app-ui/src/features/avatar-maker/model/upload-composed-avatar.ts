import { AVATAR_DESIGN_FIELD } from "@silverhand/shared";
import { apiUpload } from "@/lib/api";
import type { AvatarConfig } from "./avatar-config";
import { avatarDesignField } from "./avatar-design-wire";
import { renderAvatarPng } from "./render-avatar-png";

/** Rasterize a composed avatar and POST it, with its design, to an avatar route. */
export async function uploadComposedAvatar<T>(path: string, config: AvatarConfig): Promise<T> {
  const png = await renderAvatarPng(config);
  const form = new FormData();
  form.set(AVATAR_DESIGN_FIELD, avatarDesignField(config));
  form.set("file", png);

  return apiUpload<T>(path, form);
}
