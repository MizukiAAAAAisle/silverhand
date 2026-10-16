import libraryJson from "./avatar-library.json";

// The part library is shared with the iOS native editor, which bundles the same
// JSON. Nodes are limited to these primitives so both renderers stay small;
// adding a tag or attribute here needs the Swift renderer to learn it too.
export type AvatarNode =
  | ({ t: "path"; d: string } & AvatarPaint)
  | ({ t: "circle"; cx: number; cy: number; r: number } & AvatarPaint)
  | ({ t: "ellipse"; cx: number; cy: number; rx: number; ry: number } & AvatarPaint)
  | ({ t: "rect"; x: number; y: number; width: number; height: number; rx?: number } & AvatarPaint)
  | ({ t: "g"; c: AvatarNode[] } & AvatarPaint);

export interface AvatarPaint {
  fill?: string;
  fillRule?: "evenodd" | "nonzero";
  stroke?: string;
  strokeWidth?: number;
  strokeLinecap?: "round" | "butt" | "square";
  strokeLinejoin?: "round" | "miter" | "bevel";
  transform?: string;
}

export interface AvatarPart {
  front: AvatarNode[];
  back?: AvatarNode[];
  hides?: string[];
}

export interface AvatarCategory {
  id: string;
  view: [number, number, number, number];
  optional: boolean;
  default: number;
  randomSkip?: number;
  parts: AvatarPart[];
}

export interface AvatarLibrary {
  version: number;
  size: number;
  order: string[];
  face: AvatarNode[];
  backgrounds: string[];
  categories: AvatarCategory[];
}

export const AVATAR_LIBRARY = libraryJson as unknown as AvatarLibrary;
