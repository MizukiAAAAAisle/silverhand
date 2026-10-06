import {
  AttachmentIcon,
  BellIcon,
  FailedIcon,
  SuccessIcon,
  WarningIcon,
  type IconComponent,
} from "@/icons";
import type { ReactNode } from "react";

// Single authority for toast semantic → icon. sonner reaches it through two
// different interfaces: typed levels (success/error/warning) get a slot in the
// <Toaster icons> map, while a bare `toast()` has no map slot and must be handed
// an `icon` per call. Both read THIS table, so glyph / size / tone / aria-hidden
// never drift across the call sites. Icons are decorative — the toast copy is the
// sole semantic authority — so every one is aria-hidden and never announced.
export type ToastSemantic = "success" | "error" | "warning" | "notification" | "attachment";

// Outcome levels wear their status token; neutral kinds (notification /
// attachment) stay on ink so a saturated hue only ever means an outcome. The
// attachment kind reuses the app's Paperclip so its toast reads as
// "attachment-related" rather than any particular action. Tone is an inline
// style, not a `text-[var(--x)]` class, because Tailwind can't see a token
// picked at runtime.
const TOAST_ICON: Record<ToastSemantic, { Glyph: IconComponent; tone: string }> = {
  success: { Glyph: SuccessIcon, tone: "var(--success)" },
  error: { Glyph: FailedIcon, tone: "var(--error)" },
  warning: { Glyph: WarningIcon, tone: "var(--warning)" },
  notification: { Glyph: BellIcon, tone: "var(--text-secondary)" },
  attachment: { Glyph: AttachmentIcon, tone: "var(--text-secondary)" },
};

export function toastIcon(kind: ToastSemantic): ReactNode {
  const { Glyph, tone } = TOAST_ICON[kind];
  return <Glyph className="size-4" style={{ color: tone }} aria-hidden />;
}

// The subset sonner exposes as typed map slots.
export const toasterTypedIcons = {
  success: toastIcon("success"),
  error: toastIcon("error"),
  warning: toastIcon("warning"),
};
