import { createElement, forwardRef, useId, type ReactNode, type SVGProps } from "react";
import { withNativeCircles } from "./native-circles";

/** One SVG element of an icon: tag name plus attributes, as Hugeicons ships them. */
export type IconNode = readonly (readonly [string, Readonly<Record<string, string | number>>])[];

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "ref"> {
  /** Width and height in px; CSS `size-*` classes override it. */
  size?: number | string;
}

export type IconComponent = ReturnType<typeof createDrawnIcon>;

/**
 * Every glyph shares one 24px grid, a 2 round stroke and `currentColor`.
 * `Glyph` draws the SVG children; `id` is unique to the rendered instance so a
 * glyph can reference its own `<clipPath>`.
 */
export function createDrawnIcon(name: string, Glyph: (props: { id: string }) => ReactNode) {
  const Icon = forwardRef<SVGSVGElement, IconProps>(
    ({ size = 24, strokeWidth = 2, className, ...rest }, ref) => {
      // `useId` returns `:r1:`-style ids; colons are invalid inside `url(#…)`.
      const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
      const labelled = Object.keys(rest).some(
        (prop) => prop.startsWith("aria-") || prop === "role" || prop === "title",
      );

      return createElement(
        "svg",
        {
          ref,
          xmlns: "http://www.w3.org/2000/svg",
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          className: className ? `icon icon-${name} ${className}` : `icon icon-${name}`,
          ...(labelled ? null : { "aria-hidden": true }),
          ...rest,
        },
        createElement(Glyph, { id }),
      );
    },
  );
  Icon.displayName = name;

  return Icon;
}

/**
 * A Hugeicons data node on the shared grid. Per-element stroke widths from the
 * source are dropped so the root `strokeWidth` governs the whole glyph.
 */
export function createIcon(name: string, node: IconNode) {
  const children = withNativeCircles(node).map(([tag, attrs], index) => {
    const { strokeWidth: _strokeWidth, key: _key, ...rest } = attrs;
    // A filled shape must not inherit the root stroke, or it reads heavier.
    const paint = rest["fill"] && !rest["stroke"] ? { stroke: "none" } : null;
    return createElement(tag, { ...rest, ...paint, key: index });
  });

  return createDrawnIcon(name, () => children);
}
