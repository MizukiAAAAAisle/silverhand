import { Power } from "lucide-react";
import { useShutdownProgress } from "./effects";

export function ShutdownOverlay() {
  const shutdownStep = useShutdownProgress();

  if (shutdownStep === null) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-(--z-toolbar) flex items-center justify-center bg-bg-base/30 backdrop-blur-[1px]">
      <div className="w-105 max-w-[calc(100vw-48px)] rounded-md border border-border bg-bg-floating/95 px-5 py-4 shadow-modal">
        <div className="flex items-center gap-4">
          <div className="relative flex size-12 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
            <span
              aria-hidden
              className="absolute -inset-1 rounded-full border-2 border-accent/25 border-t-accent animate-spin"
            />
            <Power className="size-5" strokeWidth={1.8} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-text-primary">Quitting Silverhand</p>
            <p className="mt-1 text-xs leading-5 text-text-muted">{shutdownStep}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
