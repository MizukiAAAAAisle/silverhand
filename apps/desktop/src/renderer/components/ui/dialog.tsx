import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { cn } from '@/lib/cn';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

/** The corner-button skin (surface / ghost ink / hover / focus / box), shared
 *  by the modal close ✕ AND any sibling top-right action (e.g. the task
 *  detail's "View in conversation" jump) so the two are visual TWINS and can't
 *  drift. It is POSITION-AGNOSTIC: the `DialogContent` corner cluster owns the
 *  `absolute` slot and the inter-button gap. In forza6 the shared
 *  `data-sticker-close` / peer markers turn this into the poster-sticker skin
 *  via the per-theme component CSS. A consumer's twin carries its OWN marker so
 *  the theme rule reaches it too.
 *
 *  Rest / hover is a COLOUR step (`--text-muted` → `--text-primary`), not an
 *  opacity step: `opacity-70` on top of an already-muted ink dilutes the same
 *  glyph twice, and a 16px multi-stroke glyph at 70% reads as smudged rather
 *  than as quiet (shiki 2026-07-28 on the members modal's stop/restart:
 *  "看着糊"). forza6 had to cancel it with `opacity: 1` to keep its sticker
 *  stamp legible, which is the same finding from the other side. `opacity` is
 *  left to `disabled:` alone, where fading the WHOLE control is the point. */
export const dialogCornerButtonClass =
  'cursor-pointer rounded-[var(--control-radius)] p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus:outline-none';

/**
 * A corner-cluster action — the close ✕'s twin. Use this instead of hand-rolling
 * `dialogCornerButtonClass`: the button carries the `data-dialog-corner-action`
 * theme marker itself, so a peer can no longer ship as a flat ghost next to a
 * bold poster sticker (shiki 2026-07-28 on the members modal's stop/restart
 * pair — the marker was the one thing a consumer had to remember, and didn't).
 * The consumer still owns behaviour and glyph; identity comes from the theme.
 */
export const DialogCornerButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<'button'>
>(({ className, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    data-dialog-corner-action
    className={cn(dialogCornerButtonClass, className)}
    {...props}
  />
));
DialogCornerButton.displayName = 'DialogCornerButton';

export const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-overlay-backdrop data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = 'DialogOverlay';

export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** Optional action(s) placed in the top-right corner cluster, LEFT of the
     *  close ✕, sharing its slot + skin. Render them with
     *  `dialogCornerButtonClass` (+ their own theme marker) so they read as
     *  peers of the close; the cluster owns position and the inter-button gap,
     *  so a consumer never guesses `right-*` or per-theme box sizes. */
    cornerActions?: React.ReactNode;
    /** Vertical band the corner cluster sits on.
     *  - `title` (default): centred on the FIRST LINE of a default-padded
     *    (`p-6`) `DialogHeader`, so the cluster reads as part of the title row
     *    instead of floating 12px above it (shiki 2026-07-28: 标题和右边的按钮
     *    不居中). The band is a fixed 24px with `items-center`, so per-theme box
     *    growth (forza6's bordered stickers) stays centred on that same line.
     *  - `top`: hugs the content's top-right corner — for a dialog that owns its
     *    own padding (`p-0`) and whose first band is not a `p-6` title line. */
    cornerBand?: 'title' | 'top';
  }
>(({ className, children, cornerActions, cornerBand = 'title', ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      data-modal-shell
      data-popover-frame="info"
      className={cn(
        'fixed left-1/2 top-1/2 z-50 grid w-full max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 bg-bg-floating p-6 shadow-modal focus:outline-none',
        className,
      )}
      {...props}
    >
      {children}
      {/* Top-right corner action cluster: optional peer actions, then the close
          ✕. A fixed 24px band + `items-center` co-aligns glyphs regardless of
          per-theme box size (forza6 borders the stickers → taller boxes, which
          now overflow the band symmetrically instead of pushing their centres
          down), and `gap-1.5` spaces them — so twins never need pixel/right-*
          math per theme. */}
      <div
        className={cn(
          'absolute right-3 flex h-6 items-center gap-1.5',
          cornerBand === 'title' ? 'top-6' : 'top-3',
        )}
      >
        {cornerActions}
        <DialogPrimitive.Close data-sticker-close className={dialogCornerButtonClass}>
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </div>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = 'DialogContent';

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

export const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-base font-semibold text-text-primary', className)}
    {...props}
  />
));
DialogTitle.displayName = 'DialogTitle';

export const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-text-muted', className)}
    {...props}
  />
));
DialogDescription.displayName = 'DialogDescription';
