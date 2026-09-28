import {
  useViewerAvatarObjectUrl,
  useViewerUser,
  isRegistrationRequired,
  isBackendUnreachable,
  isUpdateRequired,
} from "../session/hooks";
import { useUserAvatarObjectUrl } from "@/features/users/avatar-hooks";

export function useHumanAvatar(userId: string) {
  const { data: viewer } = useViewerUser();
  const isSelf =
    viewer &&
    !isRegistrationRequired(viewer) &&
    !isBackendUnreachable(viewer) &&
    !isUpdateRequired(viewer) &&
    viewer.id === userId;
  const ownAvatar = useViewerAvatarObjectUrl();
  const otherAvatar = useUserAvatarObjectUrl({ userId: isSelf ? null : userId });

  return isSelf ? ownAvatar : otherAvatar;
}
