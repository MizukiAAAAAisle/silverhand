import { useQuery } from "@tanstack/react-query";
import { apiPaths, type AvatarDesignResponse } from "@silverhand/shared";
import { api } from "@/lib/api";

export type AvatarDesignSubject = "me" | string;

export const avatarDesignKey = (subject: AvatarDesignSubject) =>
  ["avatar-design", subject] as const;

function designPath(subject: AvatarDesignSubject): string {
  return subject === "me" ? apiPaths.meAvatarDesign : apiPaths.agentAvatarDesign(subject);
}

/** The saved maker design behind the current avatar, or null when it was uploaded or is absent.
 *  Read only when the editor opens; a backend without the route reads as null. */
export function useAvatarDesign(subject: AvatarDesignSubject, enabled: boolean) {
  return useQuery({
    queryKey: avatarDesignKey(subject),
    enabled,
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      try {
        const res = await api<AvatarDesignResponse>(designPath(subject));

        return res.design;
      } catch {
        return null;
      }
    },
  });
}
