import { useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { SelectionActionButton } from './SelectionToolbar';

interface LightboxProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  src: string;
  alt: string;
}

/**
 * Image preview modal. A framed modal shell (forza6 picks up the poster
 * `data-modal-shell` chrome — 2px ink frame + hard drop shadow — exactly
 * like the export preview modal) with a header ("Image Preview" title +
 * a close icon on the right), the image filling the body, and a bottom
 * action bar with the single real action: Copy. Dismiss is the header
 * close icon (plus Escape / backdrop click).
 *
 * Sizing caps at `min(920px, 88vw)` × `82vh`; the image area scrolls /
 * `object-contain`s within that so tall or wide images stay inside the
 * frame. Backdrop click + Escape also close (Radix defaults).
 *
 * Copy reuses the `export:copyPng` IPC (`copyPngExport`): we fetch the
 * blob bytes behind `src` and let main build an NSImage + write the OS
 * pasteboard — the same path the screenshot export uses, which is far
 * more reliable than renderer-side `navigator.clipboard.write` for
 * images on Electron/macOS. nativeImage decodes PNG/JPEG; an
 * undecodable format surfaces a toast rather than failing silently.
 */
export function Lightbox({ open, onOpenChange, src, alt }: LightboxProps): JSX.Element {
  const [busy, setBusy] = useState(false);

  const onCopy = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const blob = await fetch(src).then(r => r.blob());
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const result = await window.agentHub.copyPngExport({ pngBytes: bytes });
      if (result.ok) {
        toast.success('图片已复制到剪贴板');
      } else {
        toast.error('复制失败：' + result.error);
      }
    } catch (err) {
      toast.error('复制失败：' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[90] bg-overlay-backdrop data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          data-modal-shell
          className="fixed left-1/2 top-1/2 z-[91] flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--floating-radius,var(--radius-md))] border-[length:var(--control-border-width)] border-[color:var(--border-row-selected)] bg-bg-floating shadow-xl focus:outline-none"
          style={{ maxWidth: 'min(920px, 88vw)', maxHeight: '82vh' }}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-2">
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
              Image Preview
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label="Close"
              data-sticker-close
              className="flex size-7 shrink-0 items-center justify-center rounded-[var(--control-radius)] text-text-muted hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>

          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-bg-elevated p-3">
            <img
              src={src}
              alt={alt}
              className="block max-h-full max-w-full object-contain"
            />
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-subtle px-3 py-2 text-xs">
            <SelectionActionButton
              variant="primary"
              label="Copy"
              disabled={busy}
              onClick={onCopy}
            />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
