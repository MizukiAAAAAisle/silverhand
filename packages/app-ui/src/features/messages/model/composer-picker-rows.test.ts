import { describe, expect, it } from "vitest";
import type { PickerItem } from "./composer-picker";
import { pickerViewOf } from "./composer-picker-rows";
import { t } from "@/lib/i18n";

const agent = (id: string, inConversation: boolean, display_name: string | null = null) =>
  ({
    kind: "agent",
    agent: { id, name: id, display_name, avatar_url: null, runtime: "claude" },
    inConversation,
  }) as PickerItem;
const human = (id: string, inConversation: boolean) =>
  ({
    kind: "human",
    human: { id, name: id, display_name: ` ${id.toUpperCase()} `, avatar_url: null },
    inConversation,
  }) as PickerItem;
const channel = (id: string, workspaceName: string | null) =>
  ({ kind: "channel", channel: { id, title: id }, workspaceName }) as PickerItem;

const view = (items: PickerItem[], more: Partial<Parameters<typeof pickerViewOf>[0]> = {}) =>
  pickerViewOf({
    items,
    hiddenCount: 0,
    channelStatus: "complete",
    peopleSections: true,
    showChannelWorkspace: false,
    ...more,
  });

describe("pickerViewOf", () => {
  it("splits people at the first candidate outside the conversation", () => {
    const rows = view([
      agent("a", true),
      human("b", true),
      agent("c", false),
      human("d", false),
    ]).rows;
    expect(rows.map((row) => row.section)).toEqual([
      "In this channel",
      undefined,
      "Other channels",
      undefined,
    ]);
    expect(rows.map((row) => row.dimmed)).toEqual([false, false, true, true]);
  });

  it("stays flat without anyone in the conversation, or without sections", () => {
    expect(view([agent("a", false), agent("b", false)]).rows.some((row) => row.section)).toBe(
      false,
    );
    expect(
      view([agent("a", true), agent("b", false)], { peopleSections: false }).rows.some(
        (row) => row.section,
      ),
    ).toBe(false);
  });

  it("names people by display name, falling back to the handle", () => {
    const [named, plain, person] = view([
      agent("a", true, "Alice"),
      agent("b", true, "  "),
      human("c", true),
    ]).rows;
    expect([named!.title, named!.handle, named!.detail]).toEqual(["Alice", "@a", "claude"]);
    expect(plain!.title).toBe("b");
    expect([person!.title, person!.detail]).toEqual(["C", "human"]);
  });

  it("names a channel's workspace only when asked", () => {
    expect(view([channel("x", "Acme")]).rows[0]!.detail).toBeUndefined();
    expect(view([channel("x", "Acme")], { showChannelWorkspace: true }).rows[0]!.detail).toBe(
      "Acme",
    );
  });

  it("reports the cap and the channel source apart", () => {
    const loading = view([], { hiddenCount: 3, channelStatus: "loading" });
    expect(loading.more).toBe("+3 more");
    expect(loading.status).toEqual({ loading: true, label: t("messages.loadingChannels") });
    expect(view([], { channelStatus: "partial_error" }).status?.loading).toBe(false);
    expect(view([]).status).toBeNull();
  });
});
