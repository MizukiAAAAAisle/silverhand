import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

interface AnimatedPanelProps {
  open: boolean;
  width: string;
  /** The render form lets the caller defer heavy content until opening completes. */
  children: ReactNode | ((settledOpen: boolean) => ReactNode);
  overlay?: ReactNode;
}

/** Animate the clipping shell while the content keeps its destination width. */
export function AnimatedPanel({ open, width, children, overlay }: AnimatedPanelProps): JSX.Element {
  const shellRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<Animation | null>(null);
  const initializedRef = useRef(false);
  const [settledOpen, setSettledOpen] = useState<boolean | null>(open);
  const settled = settledOpen === open;

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }

    shell.inert = !open;
    const from = shell.style.width || "0px";
    shell.style.width = open ? width : "0px";
    const to = open ? width : "0px";
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");

    const complete = () => {
      if (animationRef.current) {
        animationRef.current.onfinish = null;
        animationRef.current.cancel();
      }
      animationRef.current = null;
      shell.style.width = open ? width : "0px";
      setSettledOpen(open);
    };

    if (!initializedRef.current || preference.matches || to === from) {
      initializedRef.current = true;
      complete();
    } else {
      setSettledOpen(null);
      const animation = shell.animate([{ width: from }, { width: to }], {
        duration: 220,
        easing: "cubic-bezier(0.32, 0.72, 0, 1)",
      });
      animationRef.current = animation;
      animation.onfinish = complete;
    }

    const onPreferenceChange = () => {
      if (preference.matches) {
        complete();
      }
    };
    preference.addEventListener("change", onPreferenceChange);

    // A resized window invalidates pixel keyframes; settle against the live CSS width.
    const parent = shell.parentElement;
    let parentWidth = parent?.clientWidth;
    const observer = new ResizeObserver(() => {
      if (parent?.clientWidth !== parentWidth) {
        parentWidth = parent?.clientWidth;
        complete();
      }
    });
    if (parent) {
      observer.observe(parent);
    }

    return () => {
      preference.removeEventListener("change", onPreferenceChange);
      observer.disconnect();
      const animation = animationRef.current;
      if (animation) {
        // Preserve the presented frame so a reversal starts from the current position.
        shell.style.width = `${shell.getBoundingClientRect().width}px`;
        animation.onfinish = null;
        animation.cancel();
        animationRef.current = null;
      }
    };
  }, [open, width]);

  return (
    <div
      ref={shellRef}
      aria-hidden={!open}
      className="relative h-full min-w-0 shrink-0"
      style={{ width: 0, overflow: open && settled ? "visible" : "clip" }}
    >
      <div className="flex h-full min-w-0" style={{ width }}>
        {typeof children === "function" ? children(open && settled) : open ? children : null}
      </div>
      {open && settled ? overlay : null}
    </div>
  );
}
