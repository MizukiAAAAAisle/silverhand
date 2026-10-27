import type { CSSProperties, ReactNode } from "react";
import type { UserDto } from "@silverhand/shared";
import { paneChrome } from "@/components/layout/pane-chrome";
import { PaneHeader } from "@/components/layout/pane-shell";
import { iconMarkup } from "@/components/layout/native-page-bar";
import { UserAvatar } from "@/components/user-avatar";
import { AVATAR_PX } from "@/components/avatar-scale";
import {
  ChevronRightIcon,
  ComputerIcon,
  MembersIcon,
  ProfileEditIcon,
  SettingsIcon,
  UserIcon,
} from "@/icons";
import { useNav } from "@/router";
import { useAgents } from "@/features/agents/hooks/hooks";
import { useHostsQuery } from "@/features/computers/hooks/hooks";
import { ProfileMessageActivity } from "@/features/profile/profile-message-activity";
import {
  isBackendUnreachable,
  isRegistrationRequired,
  isUpdateRequired,
  useViewerAvatarObjectUrl,
  useViewerUser,
} from "@/features/session/hooks";
import { useUsers } from "@/features/users/hooks";
import { t } from "@/lib/i18n";
import "./me-shell.css";

/** The compact Me tab: who you are, how active you have been, then the
 * utility sections, as glass over a wash of your own avatar. */
export function MeShell(): JSX.Element {
  const nav = useNav();
  const { data: viewer } = useViewerUser();
  const { data: users } = useUsers();
  const { data: agents } = useAgents();
  const { data: hosts } = useHostsQuery();

  const user =
    viewer &&
    !isRegistrationRequired(viewer) &&
    !isBackendUnreachable(viewer) &&
    !isUpdateRequired(viewer)
      ? viewer
      : null;
  const avatarObjectUrl = useViewerAvatarObjectUrl();
  const editProfile = () => nav.go("/settings?settingsSection=account");
  const memberCount = users && agents ? users.length + agents.length : null;
  const computerCount = hosts
    ? hosts.hosts.filter((host) => host.status === "active").length
    : null;

  return (
    // Not `Sidebar`: its inner padding would inset the backdrop from the edges.
    <aside
      data-panel="sidebar"
      data-sidebar="me"
      className="flex h-full min-w-0 flex-1 flex-col"
      style={{ ...paneChrome, overflow: "hidden" }}
    >
      <div className="me-shell">
        {avatarObjectUrl ? (
          <div
            aria-hidden
            className="me-backdrop"
            style={{ "--me-backdrop": `url("${avatarObjectUrl}")` } as CSSProperties}
          />
        ) : null}

        <PaneHeader
          icon={<UserIcon className="size-3.5" />}
          title={t("me.me")}
          backdrop={Boolean(avatarObjectUrl)}
          trailing={
            <button
              type="button"
              className="glass-surface glass-round focus-outline"
              onClick={editProfile}
              aria-label={t("me.editProfile")}
            >
              <ProfileEditIcon size={20} />
            </button>
          }
          nativeActions={[
            {
              id: "edit",
              label: t("me.editProfile"),
              icon: iconMarkup(ProfileEditIcon),
              run: editProfile,
            },
          ]}
        />

        <div data-scroll-root className="me-page scrollbar-hide">
          {user ? (
            <>
              <MeHero user={user} avatarObjectUrl={avatarObjectUrl} />
              <div className="glass-surface me-activity">
                <ProfileMessageActivity subject={{ kind: "user", id: user.id }} mode="compact" />
              </div>
            </>
          ) : null}

          <div className="me-tiles">
            <MeTile
              icon={<MembersIcon size={18} />}
              title={t("me.members")}
              count={memberCount}
              onClick={() => nav.toMembers()}
            />
            <MeTile
              icon={<ComputerIcon size={18} />}
              title={t("me.computers")}
              count={computerCount}
              onClick={() => nav.toComputers()}
            />
            <MeTile
              icon={<SettingsIcon size={18} />}
              title={t("me.settings")}
              onClick={() => nav.toSettings()}
            />
          </div>
        </div>
      </div>
    </aside>
  );
}

function MeHero({
  user,
  avatarObjectUrl,
}: {
  user: UserDto;
  avatarObjectUrl: string | null;
}): JSX.Element {
  const name = user.display_name || user.name;

  return (
    <section aria-label={t("me.profile")} className="me-hero">
      <UserAvatar
        size={AVATAR_PX.profileCompact}
        avatarObjectUrl={avatarObjectUrl}
        alt={name}
        className="me-avatar"
      />
      <div className="min-w-0">
        <div className="me-name">{name}</div>
        <div className="me-handle">@{user.name}</div>
      </div>
    </section>
  );
}

/** A count reads as the tile's headline; while it loads the tile keeps its
 * height with an empty headline instead of shifting. A tile without a count
 * (`count` omitted) becomes a full-width row on a narrow page. */
function MeTile({
  icon,
  title,
  count,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  count?: number | null;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="glass-surface me-tile focus-outline"
      data-plain={count === undefined || undefined}
      onClick={onClick}
    >
      <span className="me-tile-icon">{icon}</span>
      <ChevronRightIcon size={16} className="me-chevron me-tile-chevron" />
      {count === undefined ? null : <span className="me-tile-count">{count ?? " "}</span>}
      <span className="me-tile-title">{title}</span>
    </button>
  );
}
