import { toast } from "sonner";
import type { BannerNotice } from "@silverhand/client";
import { parseLocator, parseReference, type MessageAuthorDto } from "@silverhand/shared";
import { BotIcon, CloseIcon, UserIcon } from "@/icons";
import { AVATAR_PX } from "@/components/avatar-scale";
import { agentAvatarImage } from "@/components/agent-avatar";
import { iconMarkup } from "@/components/layout/native-page-bar";
import { readLayoutClass } from "@/navigation/layout";
import { getPlatform } from "@/platform";
import { loadAvatarBlobUrl } from "@/features/identity/avatar-blob-cache";
import { AuthorAvatarView, AuthorName } from "@/features/messages/components/author-avatar-view";
import { presentAuthor } from "@/features/messages/model/author-presentation";
import { useAuthorAvatarObjectUrls } from "@/features/messages/hooks/author-avatar-hooks";

/** A mention, read off a notification's payload and the sender it resolves to. */
export interface MentionToastContent {
  /** Absent from servers that predate the field; the name then comes from `fallbackName`. */
  sender: MessageAuthorDto | null;
  fallbackName: string;
  conversationTitle: string | null;
  excerpt: string | null;
}

const MENTION_TOAST_DURATION_MS = 8_000;

/** Shows who mentioned the viewer, where, and what they said; the whole card
 *  opens it. The compact layout hands it to the platform's banner, whose taps
 *  come back by `id`, when there is one. */
export function showMentionToast(
  content: MentionToastContent,
  id: string,
  onOpen: () => void,
): void {
  const banner = getPlatform().banner;
  if (banner && readLayoutClass() === "compact") {
    void mentionNotice(content, id).then((notice) => banner.show(notice));
    return;
  }

  toast.custom(
    (id) => (
      <MentionToast
        content={content}
        onOpen={() => {
          toast.dismiss(id);
          onOpen();
        }}
        onDismiss={() => toast.dismiss(id)}
      />
    ),
    { duration: MENTION_TOAST_DURATION_MS },
  );
}

function MentionToast({
  content,
  onOpen,
  onDismiss,
}: {
  content: MentionToastContent;
  onOpen: () => void;
  onDismiss: () => void;
}): JSX.Element {
  const { sender, fallbackName, conversationTitle, excerpt } = content;
  const presentation = sender ? presentAuthor(sender) : null;
  const { agentAvatarUrls, humanAvatarUrls } = useAuthorAvatarObjectUrls(sender ? [sender] : []);
  const body = excerpt ? readableExcerpt(excerpt) : null;

  return (
    <div
      data-mention-toast
      className="group relative w-(--width) max-w-full rounded-(--floating-radius) border border-border bg-bg-floating text-text-primary shadow-popover"
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full gap-2.5 rounded-[inherit] py-3 pr-3.5 pl-3 text-left outline-none hover:bg-bg-hover focus-visible:bg-bg-hover"
      >
        {presentation ? (
          <AuthorAvatarView
            avatar={presentation.avatar}
            size={AVATAR_PX.md}
            label={presentation.label}
            agentAvatarUrls={agentAvatarUrls}
            humanAvatarUrls={humanAvatarUrls}
            className="mt-0.5"
          />
        ) : null}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5 text-sm leading-5">
            {presentation ? (
              <AuthorName presentation={presentation} className="font-semibold text-text-primary" />
            ) : (
              <span className="min-w-0 truncate font-semibold text-text-primary">
                {fallbackName}
              </span>
            )}
            {conversationTitle ? (
              <span className="min-w-0 shrink truncate text-text-muted">
                in #{conversationTitle}
              </span>
            ) : null}
          </span>
          {body ? (
            <span className="line-clamp-2 text-sm leading-5 wrap-break-word text-text-secondary">
              {body}
            </span>
          ) : null}
        </span>
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="absolute -top-1.5 -left-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-bg-floating text-text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-text-primary focus-visible:opacity-100"
      >
        <CloseIcon className="size-3" />
      </button>
    </div>
  );
}

async function mentionNotice(content: MentionToastContent, id: string): Promise<BannerNotice> {
  const { sender } = content;
  const presentation = sender ? presentAuthor(sender) : null;
  return {
    id,
    title: presentation?.label ?? content.fallbackName,
    subtitle: content.conversationTitle ? `in #${content.conversationTitle}` : undefined,
    body: content.excerpt ? readableExcerpt(content.excerpt) : undefined,
    icon: sender ? await senderIcon(sender) : undefined,
  };
}

async function senderIcon(sender: MessageAuthorDto): Promise<BannerNotice["icon"]> {
  const picture =
    sender.status === "active" && sender.avatar_url
      ? await loadAvatarBlobUrl(sender.avatar_url)
      : null;
  if (sender.kind === "agent") {
    const image = sender.status === "active" ? agentAvatarImage(sender.runtime, picture) : null;
    return image ? { image } : { glyph: iconMarkup(BotIcon), ground: true };
  }
  return picture ? { image: picture } : { glyph: iconMarkup(UserIcon), ground: true };
}

const AUTOLINK = /<(silverhand:\/\/[^\s<>]+)>/g;

/** The excerpt is the source body's raw bytes; references and locators read as
 *  the names a chip would show, everything else stays as written. */
export function readableExcerpt(excerpt: string): string {
  return excerpt.replace(AUTOLINK, (token, href: string) => {
    const reference = parseReference(href);
    if (reference) {
      return `@${reference.handle}`;
    }
    const locator = parseLocator(href);
    if (locator?.kind === "channel") {
      return `#${locator.channel.title}`;
    }
    if (locator?.kind === "workspace") {
      return locator.workspace.name;
    }
    return token;
  });
}
