import { useEffect, useRef } from "react";
import type {
  ComposerMenuItem,
  ComposerPicker,
  ComposerPickerIcon,
  ComposerState,
} from "@silverhand/client";
import { AttachFileIcon, BotIcon, HashIcon, ImageIcon, MentionIcon, UserIcon } from "@/icons";
import { iconMarkup } from "@/components/layout/native-page-bar";
import { useCompactLayout } from "@/navigation/layout";
import { usePageLive } from "@/navigation/page-stack";
import { getPlatform } from "@/platform";
import { agentAvatarImage } from "@/components/agent-avatar";
import type { PickerItem } from "../model/composer-picker";
import { avatarUrlOf, type PickerView } from "../model/composer-picker-rows";
import { useOpenAgentActivity } from "./use-open-agent-activity";
import { useNativeComposerActivity } from "./use-native-composer-activity";

/** Whether the compact composer is drawn natively (iOS). */
export function useNativeComposerPlatform(): boolean {
  return useCompactLayout() && getPlatform().composer !== undefined;
}

interface NativeComposerOptions {
  /** False while something covers the composer. */
  shown: boolean;
  draftKey: string;
  conversationId: string;
  placeholder: string;
  enabled: boolean;
  canSend: boolean;
  offersMentions: boolean;
  offersChannels: boolean;
  /** The height of the page's controls floating above the composer. */
  accessoryHeight: number;
  /** The open `@` / `#` picker; null while none is open. */
  picker: PickerView | null;
  agentAvatarUrls: Map<string, string | null>;
  humanAvatarUrls: Map<string, string | null>;
  /** Limits the activity line to these agents; null shows all. */
  activityAgentIds: readonly string[] | null | undefined;
  draft: string;
  caret: number;
  onChange: (text: string, caret: number, composing: boolean) => void;
  onSend: (text: string, caret: number) => void;
  onPick: (item: PickerItem) => void;
  onTrigger: (kind: "@" | "#") => void;
  onFiles: (files: File[]) => void;
}

function addMenu(offersMentions: boolean, offersChannels: boolean): ComposerMenuItem[] {
  return [
    { id: "photos", label: "Photos", icon: iconMarkup(ImageIcon), pick: "photos" },
    { id: "files", label: "Files", icon: iconMarkup(AttachFileIcon), pick: "files" },
    ...(offersMentions
      ? [{ id: "mention", label: "Mention a member", icon: iconMarkup(MentionIcon) }]
      : []),
    ...(offersChannels
      ? [{ id: "channel", label: "Reference a channel", icon: iconMarkup(HashIcon) }]
      : []),
  ];
}

/** The picker's rows for native to draw, faces resolved to images or glyphs. */
function nativePickerOf(
  view: PickerView,
  agentAvatarUrls: Map<string, string | null>,
  humanAvatarUrls: Map<string, string | null>,
): ComposerPicker {
  const rows = view.rows.map(({ key, item, title, handle, detail, section, dimmed }) => {
    const url = avatarUrlOf(item, agentAvatarUrls, humanAvatarUrls);
    const image = item.kind === "agent" ? agentAvatarImage(item.agent.runtime, url) : url;
    const icon: ComposerPickerIcon =
      item.kind === "channel"
        ? { glyph: iconMarkup(HashIcon) }
        : image
          ? { image }
          : { glyph: iconMarkup(item.kind === "agent" ? BotIcon : UserIcon), ground: true };
    return { id: key, title, handle, detail, section, dimmed, icon };
  });
  // One line under the native list: the source's state outranks the count.
  return { rows, footer: view.status?.label ?? view.more ?? undefined };
}

/**
 * Hands text editing to the native composer while this page is on screen.
 * The draft stays here: native reports each edit, and an edit made here
 * (a pick, a quote, a send clearing it) goes back as the text native shows.
 */
export function useNativeComposer(options: NativeComposerOptions): {
  focusText: (text: string, caret: number) => void;
} {
  const { draft, caret, picker } = options;
  const capability = getPlatform().composer;
  const live = usePageLive();
  const native = useNativeComposerPlatform();
  const shown = options.shown && live && native;
  const activity = useNativeComposerActivity(
    options.conversationId,
    options.activityAgentIds,
    native,
  );
  const openAgentActivity = useOpenAgentActivity();
  const key = options.draftKey;
  const state: ComposerState = {
    key,
    placeholder: options.placeholder,
    enabled: options.enabled,
    canSend: options.canSend,
    sendLabel: "Send",
    addLabel: "Add",
    add: addMenu(options.offersMentions, options.offersChannels),
    accessoryHeight: options.accessoryHeight,
    picker: picker
      ? nativePickerOf(picker, options.agentAvatarUrls, options.humanAvatarUrls)
      : undefined,
    activity,
  };
  const latest = useRef({ ...options, openAgentActivity });
  latest.current = { ...options, openAgentActivity };
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
        const row = latest.current.picker?.rows.find((candidate) => candidate.key === event.id);
        if (row) {
          latest.current.onPick(row.item);
        }
      } else if (event.kind === "activity") {
        latest.current.openAgentActivity(event.id);
      } else if (event.kind === "add") {
        if (event.id === "mention" || event.id === "channel") {
          latest.current.onTrigger(event.id === "mention" ? "@" : "#");
        }
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
