import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { randomAvatarConfig } from "../model/avatar-config";
import { AvatarConfigPreview } from "./avatar-config-preview";

const FACE_COUNT = 3;
const FACE_PX = 18;
const HOLD_MS = 1400;

/** The menu glyph for "Make avatar": three random faces taking turns, each rising in
 *  from below and growing into place. Reduced motion holds the first face. */
export function AvatarMakerGlyph() {
  const reducedMotion = useReducedMotion();
  const [faces] = useState(() => Array.from({ length: FACE_COUNT }, () => randomAvatarConfig()));
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (reducedMotion) {
      return;
    }

    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % FACE_COUNT),
      HOLD_MS,
    );

    return () => window.clearInterval(timer);
  }, [reducedMotion]);

  return (
    // The face overflows the 14px icon slot on purpose: a composed head is unreadable at 14px.
    <span
      aria-hidden
      className="relative block shrink-0 overflow-hidden rounded-full"
      style={{ width: FACE_PX, height: FACE_PX }}
    >
      <AnimatePresence initial={false}>
        <motion.span
          key={index}
          className="absolute inset-0"
          initial={{ y: FACE_PX * 0.6, scale: 0.5, opacity: 0 }}
          animate={{ y: 0, scale: 1, opacity: 1 }}
          exit={{ y: -FACE_PX * 0.6, scale: 0.5, opacity: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 26 }}
        >
          <AvatarConfigPreview config={faces[index] ?? faces[0]!} size={FACE_PX} />
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
