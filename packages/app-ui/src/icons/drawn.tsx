import { createDrawnIcon } from "./icon";

// Glyphs Hugeicons does not draw the way the product needs, as plain SVG on the
// shared 24px grid and 2 round stroke. Curves use `<circle>` / `<rect rx>`
// where possible: curved `<path>` strokes antialias coarsely under Chrome's
// GPU rasteriser.

export const ArchiveIcon = createDrawnIcon("archive", () => (
  <>
    <rect x="2.25" y="3" width="19.5" height="4.5" rx="1.5" />
    <path d="M4 7.5V15c0 2.83 0 4.24.88 5.12S7.17 21 10 21h4c2.83 0 4.24 0 5.12-.88S20 17.83 20 15V7.5" />
    <rect x="9" y="10.5" width="6" height="3" rx="1.5" />
  </>
));

export const UnarchiveIcon = createDrawnIcon("unarchive", () => (
  <>
    <rect x="2.25" y="3" width="19.5" height="4.5" rx="1.5" />
    <path d="M4 7.5V15c0 2.83 0 4.24.88 5.12S7.17 21 10 21h4c2.83 0 4.24 0 5.12-.88S20 17.83 20 15V7.5" />
    <path d="M12 17.5v-6.75m-2.5 2.5 2.5-2.5 2.5 2.5" />
  </>
));

/** A three-quarter arc; spun by the consumer (`animate-spin`). */
export const SpinnerIcon = createDrawnIcon("spinner", () => (
  <path d="M21 12a9 9 0 1 1-6.22-8.56" />
));

/** Task in progress: a ring with a three-quarter pie, between the empty ring and the check. */
export const ProgressIcon = createDrawnIcon("progress", () => (
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 12V6a6 6 0 1 1-6 6Z" fill="currentColor" stroke="none" />
  </>
));

/** The Task entity, on every surface that names Tasks: a rounded square with two checked rows. */
export const TaskIcon = createDrawnIcon("task", () => (
  <>
    <path d="M3 12C3 7.75736 3 5.63604 4.31802 4.31802C5.63604 3 7.75736 3 12 3C16.2426 3 18.364 3 19.682 4.31802C21 5.63604 21 7.75736 21 12C21 16.2426 21 18.364 19.682 19.682C18.364 21 16.2426 21 12 21C7.75736 21 5.63604 21 4.31802 19.682C3 18.364 3 16.2426 3 12Z" />
    <path d="M7 9.25L8.25 10.5L10.75 8M13.5 9.25H17" />
    <path d="M7 14.75L8.25 16L10.75 13.5M13.5 14.75H17" />
  </>
));

/** A chat: a circle bubble opened at a straight tail, with three dots. */
export const ChatsIcon = createDrawnIcon("chats", ({ id }) => (
  <>
    <clipPath id={`${id}bubble`}>
      <path d="M-1 -1H25V25H-1ZM12 12L6.82 31.32L-3.32 24.86Z" clipRule="evenodd" />
    </clipPath>
    <circle cx="12" cy="12" r="9" clipPath={`url(#${id}bubble)`} />
    <path d="M5.11 17.79L3.5 20.5L9.67 20.69" />
    <circle cx="8" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="16" cy="12" r="1.1" fill="currentColor" stroke="none" />
  </>
));
