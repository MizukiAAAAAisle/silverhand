import type { RuntimeKind } from '@silverhand/shared';
import { ClaudeIcon, CodexIcon, CursorIcon, GeminiIcon } from '@/icons/agents';
import { cn } from '@/lib/cn';

interface AgentAvatarProps {
  runtime: RuntimeKind;
  /** Pixel size of the square. Default 28. */
  size?: number;
  /** Override the default rounded-full silhouette. */
  rounded?: 'full' | 'md';
  className?: string;
  title?: string;
}

const ICONS: Record<
  RuntimeKind,
  (p: { style?: React.CSSProperties }) => JSX.Element
> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  cursor: CursorIcon,
  gemini: GeminiIcon,
};

// Tints picked to match each brand's primary color when one exists.
// `bg` is the badge fill, `fg` is the icon `currentColor`. Claude's
// path carries its own `#d97757` fill so `fg` is a no-op there.
const TINTS: Record<RuntimeKind, { bg: string; fg: string }> = {
  claude: { bg: 'bg-[#fdf3ec]', fg: 'text-[#d97757]' },
  codex: { bg: 'bg-[#1f1f1f]', fg: 'text-white' },
  cursor: { bg: 'bg-[#0f0f0f]', fg: 'text-white' },
  gemini: { bg: 'bg-[#e8f0fe]', fg: 'text-[#1a73e8]' },
};

export function AgentAvatar({
  runtime,
  size = 28,
  rounded = 'full',
  className,
  title,
}: AgentAvatarProps): JSX.Element {
  const Icon = ICONS[runtime];
  const tint = TINTS[runtime];
  const inner = Math.round(size * 0.6);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden',
        rounded === 'full' ? 'rounded-full' : 'rounded-md',
        tint.bg,
        tint.fg,
        className,
      )}
      style={{ width: size, height: size }}
      title={title}
      aria-hidden
    >
      <Icon style={{ width: inner, height: inner }} />
    </span>
  );
}
