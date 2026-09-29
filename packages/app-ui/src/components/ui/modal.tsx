import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
} from "react";
import { modalScope } from "@/lib/modal-scope";

export * from "@radix-ui/react-dialog";

const ModalActiveContext = createContext(false);
export function Root({
  open,
  defaultOpen = false,
  onOpenChange,
  modal = true,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Root>) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const active = open ?? internalOpen;
  return (
    <DialogPrimitive.Root
      {...props}
      modal={modal}
      open={active}
      onOpenChange={(next) => {
        setInternalOpen(next);
        onOpenChange?.(next);
      }}
    >
      <ModalActiveContext.Provider value={modal && active}>{children}</ModalActiveContext.Provider>
    </DialogPrimitive.Root>
  );
}

/** Unstyled modal primitive: every dialog and lightbox shares native isolation. */
export const Content = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>((props, ref) => {
  const active = useContext(ModalActiveContext);
  const release = useRef<(() => void) | undefined>(undefined);
  const contentRef = useCallback(
    (node: HTMLDivElement | null) => {
      release.current?.();
      release.current = node && active ? modalScope.acquire() : undefined;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref, active],
  );
  return <DialogPrimitive.Content {...props} ref={contentRef} />;
});
Content.displayName = "ModalContent";
