import { useMemo } from "react";
import { composeAvatarSvg, type AvatarConfig } from "../model/avatar-config";

/** A composed avatar as a square of `size`, or filling its parent when no size is given. */
export function AvatarConfigPreview({ config, size }: { config: AvatarConfig; size?: number }) {
  const svg = useMemo(() => composeAvatarSvg(config), [config]);

  return (
    <span
      className="block size-full shrink-0 overflow-hidden [&>svg]:size-full"
      style={size ? { width: size, height: size } : undefined}
      // The composer emits a fixed, attribute-only SVG from the bundled library.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
