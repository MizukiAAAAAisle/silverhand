import { beforeEach, describe, expect, it, vi } from "vitest";
import { Children, type ReactElement } from "react";
import * as Select from "@radix-ui/react-select";
import type { ChannelAttentionMode } from "@silverhand/shared";
import { ChannelNotificationSettings } from "./channel-notification-settings";

const state = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock("@/features/attention/hooks", () => ({
  useWorkspaceAttentionModes: state.query,
  useSetChannelAttentionPreference: state.mutation,
}));

function control(channelId = "b", workspaceId = "workspace") {
  const tree = ChannelNotificationSettings({ channelId, workspaceId });
  const children = Children.toArray(tree.props.children) as ReactElement[];
  return children.find((child) => child.type === Select.Root) as ReactElement<{
    value: string;
    disabled: boolean;
    onValueChange: (mode: string) => void;
  }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.query.mockReturnValue({
    data: {
      muted: true,
      channels: [
        { conversation_id: "a", mode: "all", effective_mode: "mute" },
        { conversation_id: "b", mode: "mentions", effective_mode: "mute" },
      ],
    },
    isError: false,
    isPending: false,
  });
  state.mutation.mockReturnValue({ mutate: state.mutate, isPending: false });
});

describe("channel notification settings", () => {
  it("reads the selected channel's own preference, even when workspace-muted, and writes only that target", () => {
    const select = control();
    expect(state.query).toHaveBeenCalledWith("workspace");
    expect(state.mutation).toHaveBeenCalledWith("b");
    expect(select.props.value).toBe("mentions");
    expect(select.props.disabled).toBe(false);
    select.props.onValueChange("mentions");
    expect(state.mutate).not.toHaveBeenCalled();
    select.props.onValueChange("all");
    expect(state.mutate).toHaveBeenCalledExactlyOnceWith("all");
  });

  it("consumes fresh batch values and the new channel target without retaining a local preference", () => {
    control();
    const select = control("a", "other-workspace");
    expect(select.props.value).toBe("all");
    expect(state.mutation).toHaveBeenLastCalledWith("a");
    expect(state.query).toHaveBeenLastCalledWith("other-workspace");
  });

  it.each(["pending", "error", "missing"])("does not fabricate a mode while %s", (status) => {
    state.query.mockReturnValue({
      data: status === "missing" ? { channels: [], muted: false } : undefined,
      isPending: status === "pending",
      isError: status === "error",
    });
    const select = control();
    expect(select.props.value).toBe("");
    expect(select.props.disabled).toBe(true);
    select.props.onValueChange("all");
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("does not submit arbitrary values or overlap a pending save", () => {
    control().props.onValueChange("not-a-mode");
    state.mutation.mockReturnValue({ mutate: state.mutate, isPending: true });
    control().props.onValueChange("all" satisfies ChannelAttentionMode);
    expect(state.mutate).not.toHaveBeenCalled();
  });
});
