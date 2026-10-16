import {
  AVATAR_LIBRARY,
  type AvatarLibrary,
  type AvatarNode,
  type AvatarPart,
} from "./avatar-library";

// Stored server-side as opaque JSON next to `parts_version`. Indices only, so a
// saved config never carries markup; -1 means the optional category is empty.
export interface AvatarConfig {
  parts: Record<string, number>;
  bg: number;
}

export function defaultAvatarConfig(library: AvatarLibrary = AVATAR_LIBRARY): AvatarConfig {
  return {
    parts: Object.fromEntries(
      library.categories.map((category) => [category.id, category.default]),
    ),
    bg: 0,
  };
}

export function randomAvatarConfig(
  library: AvatarLibrary = AVATAR_LIBRARY,
  random: () => number = Math.random,
): AvatarConfig {
  const pick = (count: number) => Math.floor(random() * count);

  return {
    parts: Object.fromEntries(
      library.categories.map((category) => {
        const skip = category.optional && random() < (category.randomSkip ?? 0);

        return [category.id, skip ? -1 : pick(category.parts.length)];
      }),
    ),
    bg: pick(library.backgrounds.length),
  };
}

// A config saved against an older library may name removed parts or miss new
// categories: out-of-range or missing entries fall back to the category default.
export function normalizeAvatarConfig(
  value: unknown,
  library: AvatarLibrary = AVATAR_LIBRARY,
): AvatarConfig {
  const fallback = defaultAvatarConfig(library);

  if (!isRecord(value)) {
    return fallback;
  }

  const parts = isRecord(value.parts) ? value.parts : {};
  const normalized: Record<string, number> = {};

  for (const category of library.categories) {
    const index = parts[category.id];
    const valid =
      Number.isInteger(index) &&
      (index as number) < category.parts.length &&
      ((index as number) >= 0 || (index === -1 && category.optional));

    normalized[category.id] = valid ? (index as number) : category.default;
  }

  const bg = value.bg;
  const validBg =
    Number.isInteger(bg) && (bg as number) >= 0 && (bg as number) < library.backgrounds.length;

  return { parts: normalized, bg: validBg ? (bg as number) : fallback.bg };
}

export function composeAvatarSvg(
  config: AvatarConfig,
  library: AvatarLibrary = AVATAR_LIBRARY,
): string {
  const selected = new Map<string, AvatarPart>();

  for (const category of library.categories) {
    const part = category.parts[config.parts[category.id] ?? -1];

    if (part) {
      selected.set(category.id, part);
    }
  }

  const hidden = new Set([...selected.values()].flatMap((part) => part.hides ?? []));
  const layers = library.order.map((slot) => {
    if (slot === "background") {
      // Full-bleed square: every surface clips avatars to its own theme shape.
      return `<rect width="${library.size}" height="${library.size}" fill="${library.backgrounds[config.bg] ?? library.backgrounds[0]}"/>`;
    }

    if (slot === "face") {
      return renderNodes(library.face);
    }

    const [id = slot, side = "front"] = slot.split(".");
    const part = hidden.has(id) ? undefined : selected.get(id);

    return part ? renderNodes(side === "back" ? (part.back ?? []) : part.front) : "";
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${library.size} ${library.size}">${layers.join("")}</svg>`;
}

// One part alone, cropped to its category's region, for the picker grid.
export function composePartThumbnailSvg(
  categoryId: string,
  index: number,
  library: AvatarLibrary = AVATAR_LIBRARY,
) {
  const category = library.categories.find((candidate) => candidate.id === categoryId);
  const part = category?.parts[index];

  if (!category || !part) {
    return "";
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${category.view.join(" ")}">${renderNodes(part.back ?? [])}${renderNodes(part.front)}</svg>`;
}

const ATTRIBUTE_NAMES: Record<string, string> = {
  fill: "fill",
  fillRule: "fill-rule",
  stroke: "stroke",
  strokeWidth: "stroke-width",
  strokeLinecap: "stroke-linecap",
  strokeLinejoin: "stroke-linejoin",
  transform: "transform",
  d: "d",
  cx: "cx",
  cy: "cy",
  r: "r",
  rx: "rx",
  ry: "ry",
  x: "x",
  y: "y",
  width: "width",
  height: "height",
};

function renderNodes(nodes: AvatarNode[]): string {
  return nodes.map(renderNode).join("");
}

function renderNode(node: AvatarNode): string {
  const attributes = Object.entries(node)
    .filter(([key]) => key in ATTRIBUTE_NAMES)
    .map(([key, value]) => ` ${ATTRIBUTE_NAMES[key]}="${value}"`)
    .join("");

  if (node.t === "g") {
    return `<g${attributes}>${renderNodes(node.c)}</g>`;
  }

  return `<${node.t}${attributes}/>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
