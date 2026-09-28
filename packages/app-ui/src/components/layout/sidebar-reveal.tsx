import type { ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";

/** Mounted only for a collapsed branch. Existing rows do not replay on collapse. */
export function SidebarReveal({
  children,
  initial = false,
}: {
  children: ReactNode;
  initial?: boolean;
}): JSX.Element {
  return (
    <AnimatePresence initial={initial} propagate>
      {children}
    </AnimatePresence>
  );
}

export function SidebarRevealRow({ children }: { children: ReactNode }): JSX.Element {
  const present = useIsPresent();
  const reducedMotion = useReducedMotion();

  return (
    <motion.li
      ref={(node) => node?.toggleAttribute("inert", !present)}
      aria-hidden={!present || undefined}
      style={{ pointerEvents: present ? undefined : "none" }}
      initial={{ height: 0, opacity: 0, overflow: "hidden" }}
      animate={{
        height: "auto",
        opacity: 1,
        overflow: "hidden",
        transitionEnd: { overflow: "visible" },
      }}
      exit={{ height: 0, opacity: 0, overflow: "hidden" }}
      transition={{ duration: reducedMotion ? 0 : 0.16, ease: "easeOut" }}
    >
      {children}
    </motion.li>
  );
}
