import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useCompactLayout } from "@/navigation/layout";
import type { AppSection } from "./nav-rail";

type Registration = { section: AppSection; node: HTMLSpanElement };
const MobileHeaderContext = createContext<{
  target: HTMLSpanElement | null;

  register: (owner: symbol, entry: Registration | null) => void;
} | null>(null);
const MobileHeaderSection = createContext<AppSection | null>(null);
const MobileHeaderActionContext = createContext<{
  section: AppSection;
  target: HTMLSpanElement | null;
  setTarget: (node: HTMLSpanElement | null) => void;
} | null>(null);

/** Presentation slots are owned by a page instance and scoped to its section.
 * Deferred/hidden sections may stay mounted, but cannot publish the active header. */
export function MobileHeaderProvider({
  section,
  children,
}: {
  section: AppSection;
  children: ReactNode;
}) {
  const [slots, setSlots] = useState(new Map<symbol, Registration>());
  const register = useCallback((owner: symbol, entry: Registration | null) => {
    setSlots((previous) => {
      if (!entry && !previous.has(owner)) return previous;
      const next = new Map(previous);
      if (entry) next.set(owner, entry);
      else next.delete(owner);
      return next;
    });
  }, []);
  const active = [...slots.values()].filter((entry) => entry.section === section).at(-1);
  const target = active?.node ?? null;
  return (
    <MobileHeaderContext.Provider value={{ target, register }}>
      <MobileHeaderActionHost section={section}>{children}</MobileHeaderActionHost>
    </MobileHeaderContext.Provider>
  );
}

function MobileHeaderActionHost({
  section,
  children,
}: {
  section: AppSection;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<HTMLSpanElement | null>(null);
  const value = useMemo(() => ({ section, target, setTarget }), [section, target]);

  return (
    <MobileHeaderActionContext.Provider value={value}>{children}</MobileHeaderActionContext.Provider>
  );
}

/** Ref for the shell header's trailing slot. */
export function useMobileHeaderActionRef() {
  return useContext(MobileHeaderActionContext)?.setTarget ?? null;
}

/** Places a page action in the shell header's trailing slot. Renders nothing on
 * desktop, while the page publishes its own header, or from a hidden section. */
export function MobileHeaderAction({ children }: { children: ReactNode }) {
  const context = useContext(MobileHeaderActionContext);
  const section = useContext(MobileHeaderSection);

  if (!context?.target || section !== context.section) {
    return null;
  }

  return createPortal(children, context.target);
}

export function MobileHeaderScope({
  section,
  children,
}: {
  section: AppSection;
  children: ReactNode;
}) {
  return <MobileHeaderSection.Provider value={section}>{children}</MobileHeaderSection.Provider>;
}

export function useMobileHeaderTarget() {
  return useContext(MobileHeaderContext)?.target ?? null;
}

export function MobileNavigationSlot() {
  const context = useContext(MobileHeaderContext);
  const section = useContext(MobileHeaderSection);
  const compact = useCompactLayout();
  const owner = useRef(Symbol("mobile-header-slot"));
  const register = context?.register;
  const ref = useCallback(
    (node: HTMLSpanElement | null) => {
      register?.(owner.current, node && section ? { section, node } : null);
    },
    [register, section],
  );
  if (!compact || !context || !section) return null;
  return <span ref={ref} data-mobile-navigation-slot className="shrink-0 empty:hidden" />;
}
