import type { ClientPlatform } from "@silverhand/client";
import { modalScope } from "@/lib/modal-scope";

/** Bind the current navigation owner, never a kept page. A cancelled gesture
 * doesn't arrive here. Escape lets the top Radix overlay consume first. */
export function bindSystemBack(
  capability: ClientPlatform["systemBack"],
  navigation: { active(): boolean; canBack(): boolean; back(): void },
  target?: Document,
): () => void {
  if (!capability) return () => {};
  const doc = target ?? document;
  let alive = true;
  const remove = capability.subscribe(() => {
    if (!alive || !navigation.active()) return false;
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    (doc.activeElement ?? doc).dispatchEvent(escape);
    if (escape.defaultPrevented || modalScope.blocked) return true;
    if (!navigation.canBack()) return false;
    // A leave guard can hold Back; that still consumes the system request.
    navigation.back();
    return true;
  });
  return () => { alive = false; remove(); };
}
