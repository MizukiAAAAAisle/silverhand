import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

interface LightboxProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  src: string;
  alt: string;
}

/**
 * Centered image preview modal — sized to the image with a sensible
 * cap (`min(920px, 88vw)` × `82vh`) instead of edge-to-edge fullscreen.
 * Backdrop click + Escape close (Radix defaults).
 */
export function Lightbox({ open, onOpenChange, src, alt }: LightboxProps): JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay-backdrop data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 focus:outline-none"
          style={{ maxWidth: 'min(920px, 88vw)', maxHeight: '82vh' }}
          aria-label={alt}
        >
          <img
            src={src}
            alt={alt}
            className="block rounded-md object-contain shadow-modal"
            style={{ maxWidth: 'min(920px, 88vw)', maxHeight: '82vh' }}
          />
          <DialogPrimitive.Close className="absolute -right-3 -top-3 inline-flex size-8 items-center justify-center rounded-full bg-bg-floating text-text-primary shadow-modal hover:bg-bg-hover focus:outline-none">
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
