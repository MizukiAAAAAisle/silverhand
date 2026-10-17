import { useLayoutEffect, useRef } from "react";

/**
 * The room at the end of a message scroller that the native composer floats
 * over (`--native-composer-reserve`). When it grows while the reader sits at
 * the end, the end stays in view: the composer lifts the latest message as the
 * keyboard rises or its text adds a line. A reader further up keeps their
 * place, and the composer covers what is under it.
 */
export function NativeComposerRoom(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    const scroller = node ? scrollParent(node) : null;
    if (!node || !scroller) {
      return;
    }
    let height = node.offsetHeight;
    const observer = new ResizeObserver(() => {
      const next = node.offsetHeight;
      const grown = next - height;
      height = next;
      if (grown <= 0) {
        return;
      }
      const before = scroller.scrollHeight - grown - scroller.scrollTop - scroller.clientHeight;
      if (before <= 24) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return <div ref={ref} aria-hidden data-native-composer-room="" />;
}

function scrollParent(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === "auto" || overflow === "scroll") {
      return parent;
    }
  }
  return null;
}
