import { useEffect, useRef } from "react";
import type { ComposerState } from "@silverhand/client";
import { useCompactLayout } from "@/navigation/layout";
import { usePageLive } from "@/navigation/page-stack";
import { getPlatform } from "@/platform";

/** Whether the compact composer is drawn natively (iOS). */
export function useNativeComposerPlatform(): boolean {
  return useCompactLayout() && getPlatform().composer !== undefined;
}

interface NativeComposerOptions {
  /** False while something covers the composer, or it shows on the web. */
  shown: boolean;
  state: ComposerState;
  draft: string;
  caret: number;
  onChange: (text: string, caret: number, composing: boolean) => void;
  onSend: (text: string, caret: number) => void;
  onPick: (id: string) => void;
  onActivity: (id: string) => void;
  onAdd: (id: string) => void;
  onFiles: (files: File[]) => void;
}

/**
 * Hands text editing to the native composer while this page is on screen.
 * The draft stays here: native reports each edit, and an edit made here
 * (a pick, a quote, a send clearing it) goes back as the text native shows.
 */
export function useNativeComposer({
  shown: shownProp,
  state,
  draft,
  caret,
  ...handlers
}: NativeComposerOptions): { focusText: (text: string, caret: number) => void } {
  const capability = getPlatform().composer;
  const live = usePageLive();
  const native = useNativeComposerPlatform();
  const shown = shownProp && live && native;
  const key = state.key;
  const latest = useRef(handlers);
  latest.current = handlers;
  // The text native shows, so its own edits are not sent back to it.
  const shownText = useRef<string | null>(null);
  const serialized = JSON.stringify(state);

  useEffect(() => {
    if (!shown || !capability) {
      return;
    }
    void capability.sync(JSON.parse(serialized) as ComposerState).catch(() => {});
  }, [capability, shown, serialized]);

  useEffect(() => {
    if (!shown || !capability) {
      return;
    }
    const listening = capability.subscribe((event) => {
      if (event.key !== key) {
        return;
      }
      if (event.kind === "change") {
        shownText.current = event.text;
        latest.current.onChange(event.text, event.caret, event.composing);
      } else if (event.kind === "send") {
        shownText.current = event.text;
        latest.current.onSend(event.text, event.caret);
      } else if (event.kind === "pick") {
        latest.current.onPick(event.id);
      } else if (event.kind === "activity") {
        latest.current.onActivity(event.id);
      } else if (event.kind === "add") {
        latest.current.onAdd(event.id);
      } else {
        latest.current.onFiles(event.files.map(decodeFile));
      }
    });
    return () => {
      void listening.then((remove) => remove());
      shownText.current = null;
      void capability.remove(key).catch(() => {});
    };
  }, [capability, shown, key]);

  useEffect(() => {
    if (!shown || !capability || draft === shownText.current) {
      return;
    }
    shownText.current = draft;
    void capability.setText({ key, text: draft, caret, focus: false }).catch(() => {});
  }, [capability, shown, key, draft, caret]);

  return {
    focusText: (text, nextCaret) => {
      if (!shown || !capability) {
        return;
      }
      shownText.current = text;
      void capability.setText({ key, text, caret: nextCaret, focus: true }).catch(() => {});
    },
  };
}

function decodeFile(file: { name: string; type: string; base64: string }): File {
  const binary = atob(file.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes], file.name, { type: file.type });
}
