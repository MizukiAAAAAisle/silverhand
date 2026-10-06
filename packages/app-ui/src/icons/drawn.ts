import type { IconNode } from "./icon";

// Glyphs Hugeicons does not draw the way the product needs. Same 24px grid,
// 1.5 round stroke.

const ARCHIVE_BOX: IconNode = [
  ["rect", { x: "2.25", y: "3", width: "19.5", height: "4.5", rx: "1.5" }],
  [
    "path",
    {
      d: "M4 7.5V15c0 2.83 0 4.24.88 5.12S7.17 21 10 21h4c2.83 0 4.24 0 5.12-.88S20 17.83 20 15V7.5",
    },
  ],
];

/** A lidded box with a handle slot. */
export const ARCHIVE: IconNode = [
  ...ARCHIVE_BOX,
  ["rect", { x: "9", y: "10.5", width: "6", height: "3", rx: "1.5" }],
];

/** The archive box with an arrow out of it. */
export const UNARCHIVE: IconNode = [
  ...ARCHIVE_BOX,
  ["path", { d: "M12 17.5v-6.75m-2.5 2.5 2.5-2.5 2.5 2.5" }],
];

/** A three-quarter arc; spun by the consumer (`animate-spin`). */
export const SPINNER: IconNode = [["path", { d: "M21 12a9 9 0 1 1-6.22-8.56" }]];

/** Task in progress: a ring with a three-quarter pie, between the empty ring and the check. */
export const PROGRESS: IconNode = [
  ["circle", { cx: "12", cy: "12", r: "10" }],
  ["path", { d: "M12 12V6a6 6 0 1 1-6 6Z", fill: "currentColor", stroke: "none" }],
];
