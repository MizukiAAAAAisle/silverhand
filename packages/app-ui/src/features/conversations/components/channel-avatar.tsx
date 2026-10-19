import { AVATAR_PX } from "@/components/avatar-scale";

/** Telegram's seven name tones. The hue is keyed on the conversation id, so a
 *  rename keeps a channel's colour. */
const CHANNEL_TONES = [
  "#e17076",
  "#faa774",
  "#a695e7",
  "#7bc862",
  "#6ec9cb",
  "#65aadd",
  "#ee7aae",
] as const;

function channelTone(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }

  return CHANNEL_TONES[Math.abs(hash) % CHANNEL_TONES.length]!;
}

/** A channel's face where conversations list beside people: its initial on its
 *  own tone. */
export function ChannelAvatar(props: { id: string; title: string; size?: number }): JSX.Element {
  const initial = Array.from(props.title.trim())[0]?.toUpperCase() ?? "#";
  const size = props.size ?? AVATAR_PX.lg;

  return (
    <span
      className="flex shrink-0 items-center justify-center font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.47),
        backgroundColor: channelTone(props.id),
      }}
    >
      {initial}
    </span>
  );
}
