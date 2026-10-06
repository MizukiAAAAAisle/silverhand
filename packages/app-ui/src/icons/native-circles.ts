import type { IconNode } from "./icon";

// Hugeicons draws circles as four cubic arcs. Chrome's GPU rasteriser
// flattens those arcs unevenly, so the ring looks jagged next to a native
// `<circle>` with the same geometry. Exact circles are rewritten as
// `<circle>`; every other path is left untouched.

type Point = readonly [number, number];

const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/gi;

// Control-point distance from the centre of a quarter-circle cubic, as a
// multiple of the radius: sqrt(1 + k^2) with k = 0.5523.
const CONTROL_RADIUS = Math.hypot(1, 0.5522847498);

function distance([ax, ay]: Point, [bx, by]: Point): number {
  return Math.hypot(ax - bx, ay - by);
}

/** Centre and radius when `subpath` is `M` plus four absolute `C` arcs closing a circle. */
function circleOf(subpath: string): { cx: number; cy: number; r: number } | null {
  const commands = subpath.replace(NUMBER, "").replace(/[\s,]/g, "");

  if (commands !== "MCCCCZ" && commands !== "MCCCC") {
    return null;
  }

  const numbers = (subpath.match(NUMBER) ?? []).map(Number);

  if (numbers.length !== 26) {
    return null;
  }

  const points: Point[] = [];

  for (let index = 0; index < numbers.length; index += 2) {
    points.push([numbers[index]!, numbers[index + 1]!]);
  }

  const ends = [0, 3, 6, 9, 12].map((index) => points[index]!);

  if (distance(ends[0]!, ends[4]!) > 1e-3) {
    return null;
  }

  const xs = ends.map(([x]) => x);
  const ys = ends.map(([, y]) => y);
  const centre: Point = [
    (Math.min(...xs) + Math.max(...xs)) / 2,
    (Math.min(...ys) + Math.max(...ys)) / 2,
  ];
  const r = distance(ends[0]!, centre);

  if (r < 1e-3 || ends.some((point) => Math.abs(distance(point, centre) - r) > 0.01)) {
    return null;
  }

  const controls = [1, 2, 4, 5, 7, 8, 10, 11].map((index) => points[index]!);

  if (controls.some((point) => Math.abs(distance(point, centre) - r * CONTROL_RADIUS) > 0.02)) {
    return null;
  }

  return { cx: round(centre[0]), cy: round(centre[1]), r: round(r) };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Splits each path into its exact-circle subpaths, as `<circle>`, and the rest. */
export function withNativeCircles(node: IconNode): IconNode {
  return node.flatMap(([tag, attrs]) => {
    const d = attrs["d"];

    if (tag !== "path" || typeof d !== "string") {
      return [[tag, attrs] as const];
    }

    const subpaths = d.split(/(?=M)/).filter((subpath) => subpath.trim() !== "");
    const circles: (readonly [string, Record<string, string | number>])[] = [];
    const rest: string[] = [];

    for (const subpath of subpaths) {
      const circle = circleOf(subpath);

      if (circle) {
        const { d: _d, ...paint } = attrs;
        circles.push(["circle", { ...paint, ...circle }]);
      } else {
        rest.push(subpath);
      }
    }

    if (circles.length === 0) {
      return [[tag, attrs] as const];
    }

    return rest.length === 0
      ? circles
      : [["path", { ...attrs, d: rest.join("") }] as const, ...circles];
  });
}
