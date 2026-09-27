import { Check, Copy } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

/** Fixed footprint: clipboard success changes the glyph, never the button geometry. */
export function CopyFeedbackIcon({ copied }: { copied: boolean }): JSX.Element {
  const reducedMotion = useReducedMotion();
  return (
    <span aria-hidden className="relative inline-flex size-3 shrink-0">
      <AnimatePresence initial={false}>
        <motion.span
          key={copied ? "copied" : "copy"}
          className="absolute inset-0"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.1, ease: "easeOut" }}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
