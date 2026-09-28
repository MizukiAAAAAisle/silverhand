import type { JSX, RefObject } from "react";
import type { RuntimeKind } from "@silverhand/shared";
import { runtimeCliLabel } from "@silverhand/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * Confirmation required because switching resets session continuity for
 * every conversation on this agent and stops live runtime processes.
 * Tuning-only Save bypasses this dialog.
 *
 * Failure surface: when the switch mutation fails, the dialog stays open
 * and renders the error inline — an error below the dialog in the parent
 * editor would sit under the modal overlay and be invisible.
 *
 * Focus restoration: the dialog is opened programmatically (no
 * `DialogTrigger`), so Radix has no anchor to return focus to on close
 * and would drop it on `<body>`. `returnFocusRef` explicitly hands focus
 * back to the editor's Runtime Select trigger, keeping the subsequent-
 * Escape path routed through the editor's capture handler.
 */
export function SwitchRuntimeConfirmDialog({
  open,
  onOpenChange,
  targetRuntime,
  pending,
  errorMessage,
  returnFocusRef,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  targetRuntime: RuntimeKind;
  pending: boolean;
  errorMessage: string | null;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onConfirm: () => void;
}): JSX.Element {
  const label = runtimeCliLabel(targetRuntime);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        onCloseAutoFocus={(e) => {
          const el = returnFocusRef?.current;
          if (el) {
            e.preventDefault();
            el.focus({ preventScroll: true });
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{`Switch to ${label}?`}</DialogTitle>
        </DialogHeader>
        <div className="rounded-(--control-radius) bg-(--warning-surface) px-3 py-2.5">
          <DialogDescription asChild className="text-sm leading-relaxed text-text-primary">
            <ul className="list-disc list-inside space-y-1">
              <li>Runtime sessions for all conversations are reset.</li>
              <li>Responses in progress stop.</li>
              <li>{`Running conversations restart with ${label}.`}</li>
              <li>Messages and memory are preserved.</li>
            </ul>
          </DialogDescription>
        </div>
        {errorMessage ? (
          <p className="text-xs text-error" role="alert">
            {errorMessage}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="cancel" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={pending}>
            {pending ? "Switching…" : "Switch runtime"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
