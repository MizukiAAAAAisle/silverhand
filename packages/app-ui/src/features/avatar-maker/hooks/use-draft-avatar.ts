import { useEffect, useState } from "react";
import { validateAvatarFile } from "@silverhand/shared";
import { randomAvatarConfig, type AvatarConfig } from "../model/avatar-config";
import { avatarDesignField } from "../model/avatar-design-wire";
import { renderAvatarPng } from "../model/render-avatar-png";

export interface DraftAvatarUpload {
  file: File;
  /** Set when the file was composed in the maker rather than picked. */
  design: string | null;
}

/** An avatar chosen before the account exists: a composed face by default, or a picked photo. */
export function useDraftAvatar() {
  const [composed, setComposed] = useState(() => randomAvatarConfig());
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!photo) {
      setPhotoUrl(null);
      return;
    }

    const url = URL.createObjectURL(photo);
    setPhotoUrl(url);

    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const compose = (config: AvatarConfig) => {
    setPhoto(null);
    setError(null);
    setComposed(config);
  };

  const pick = (file: File) => {
    const validation = validateAvatarFile(file);
    setError(validation?.message ?? null);

    if (!validation) {
      setPhoto(file);
    }
  };

  // A composed default that fails to rasterize is not worth blocking signup over.
  const resolve = async (): Promise<DraftAvatarUpload | null> => {
    if (photo) {
      return { file: photo, design: null };
    }

    const png = await renderAvatarPng(composed).catch(() => null);

    return png ? { file: png, design: avatarDesignField(composed) } : null;
  };

  return {
    composed,
    photoUrl,
    error,
    shuffle: () => compose(randomAvatarConfig()),
    compose,
    pick,
    resolve,
  };
}

export type DraftAvatar = ReturnType<typeof useDraftAvatar>;
