import { useEffect, useRef } from "react";
import type { SelectionBarState } from "@silverhand/client";
import { useCompactLayout } from "@/navigation/layout";
import { usePageLive } from "@/navigation/page-stack";
import { getPlatform } from "@/platform";
import { t } from "@/lib/i18n";

interface NativeSelectionBarOptions {
  /** Names the pane; a channel and an open thread each select apart. */
  key: string;
  active: boolean;
  count: number;
  /** The image is rendering. */
  busy: boolean;
  onCancel: () => void;
  onCopy: () => void;
  onSave: () => void;
}

/**
 * Hands the selection actions to native in the compact layout (iOS), where the
 * list runs under the native bars and a toolbar over it could not be reached.
 * Native draws them in the composer's place. Returns whether it does, so the
 * page leaves out its own toolbar.
 */
export function useNativeSelectionBar(options: NativeSelectionBarOptions): boolean {
  const capability = getPlatform().selectionBar;
  const compact = useCompactLayout();
  const live = usePageLive();
  const native = compact && capability !== undefined;
  const shown = native && live && options.active;
  const { key, count } = options;
  const latest = useRef(options);
  latest.current = options;

  const state: SelectionBarState = {
    key,
    count: count === 0 ? t("messages.noneSelected") : t("messages.selectedCount", { count }),
    cancelLabel: t("common.cancel"),
    copyLabel: t("messages.copyMarkdown"),
    saveLabel: t("messages.saveImage"),
    enabled: count > 0,
    busy: options.busy,
  };
  const serialized = JSON.stringify(state);

  useEffect(() => {
    if (!shown || !capability) {
      return;
    }
    void capability.sync(JSON.parse(serialized) as SelectionBarState).catch(() => {});
  }, [capability, shown, serialized]);

  useEffect(() => {
    if (!shown || !capability) {
      return;
    }
    const listening = capability.subscribe((event) => {
      if (event.key !== key) {
        return;
      }
      if (event.kind === "cancel") {
        latest.current.onCancel();
      } else if (event.kind === "copy") {
        latest.current.onCopy();
      } else {
        latest.current.onSave();
      }
    });
    return () => {
      void listening.then((remove) => remove());
      void capability.remove(key).catch(() => {});
    };
  }, [capability, shown, key]);

  return native;
}
