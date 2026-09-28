import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectPairListItem, UserDto } from "@silverhand/shared";
import { HumanHeader } from "./human-header";
import { HumanView } from "./human-view";

const state = vi.hoisted(() => ({
  toDirect: vi.fn(),
  toDraft: vi.fn(),
  pairs: [] as DirectPairListItem[],
  header: null as ComponentProps<typeof HumanHeader> | null,
}));
const user = (id: string): UserDto => ({
  id,
  name: id,
  display_name: id,
  avatar_url: null,
  created_at: 0,
  updated_at: 0,
});
vi.mock("@/router", () => ({
  useNav: () => ({ toDirect: state.toDirect, toDirectDraft: state.toDraft }),
}));
vi.mock("@/features/direct-pairs/hooks", () => ({ useDirectPairs: () => state.pairs }));
vi.mock("@/features/users/hooks", () => ({
  useUsers: () => ({ data: [user("other")], isLoading: false }),
}));
vi.mock("../session/hooks", () => ({
  useViewerUser: () => ({ data: user("self"), isLoading: false }),
  isRegistrationRequired: () => false,
  isBackendUnreachable: () => false,
  isUpdateRequired: () => false,
}));
vi.mock("./human-profile-card", () => ({ HumanProfileCard: () => null }));
vi.mock("./human-header", () => ({
  HumanHeader: (props: ComponentProps<typeof HumanHeader>) => {
    state.header = props;
    return null;
  },
}));

beforeEach(() => {
  state.pairs = [];
  state.header = null;
  vi.clearAllMocks();
});
describe("human profile Message entry", () => {
  for (const variant of ["full", "side"] as const) {
    it(`opens a human draft from the ${variant} profile without minting a pair`, () => {
      renderToStaticMarkup(createElement(HumanView, { userId: "other", variant }));
      expect(state.header?.onMessage).toBeTypeOf("function");
      state.header?.onMessage?.();
      expect(state.toDraft).toHaveBeenCalledWith({ kind: "human", id: "other" });
      expect(state.toDirect).not.toHaveBeenCalled();
    });
  }
  it("does not offer a self DM", () => {
    renderToStaticMarkup(createElement(HumanView, { userId: "self" }));
    expect(state.header?.onMessage).toBeUndefined();
  });
  it("opens an existing human pair instead of a new draft", () => {
    state.pairs = [
      {
        conversation_id: "pair",
        counterpart: { ...user("other"), status: "active", kind: "human", runtime: null },
        created_at: 0,
        unread_count: 0,
        read_only: false,
      },
    ];
    renderToStaticMarkup(createElement(HumanView, { userId: "other" }));
    state.header?.onMessage?.();
    expect(state.toDirect).toHaveBeenCalledWith("pair");
    expect(state.toDraft).not.toHaveBeenCalled();
  });
});
