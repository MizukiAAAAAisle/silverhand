import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemberCandidateGroup } from "../workspaces/member-search";

const h = vi.hoisted(() => ({
  role: "member",
  add: vi.fn(),
  target: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useMemo: <T>(compute: () => T) => compute(),
  useState: <T>(initial: T) => [initial, vi.fn()],
}));
vi.mock("../workspaces/hooks", () => ({
  useWorkspaceMemberLists: () => ({
    data: {
      viewerRole: h.role,
      agents: [{ id: "foreign" }],
      humans: [{ id: "human" }],
    },
  }),
}));
vi.mock("@/features/agent-shell/hooks/hooks", () => ({
  useAgents: () => ({ data: [{ id: "own" }, { id: "already" }] }),
}));
vi.mock("@/features/users/hooks", () => ({
  useUsers: () => ({ data: [{ id: "human" }, { id: "external" }] }),
}));
vi.mock("./use-conversation-members", () => ({
  useConversationMembers: () => ({
    status: "resolved",
    members: [{ kind: "agent", agent_id: "already" }],
  }),
}));
vi.mock("./use-add-conversation-member", () => ({
  useAddConversationMember: (conversationId: string, workspaceId: string) => {
    h.target(conversationId, workspaceId);
    return { mutateAsync: h.add, isPending: false };
  },
}));
import { ConversationMemberSearch } from "./add-conversation-member-popover";

beforeEach(() => {
  vi.clearAllMocks();
  h.role = "member";
  h.add.mockResolvedValue(undefined);
});
describe("inline member search uses the existing add authority", () => {
  it("keeps ordinary members limited to owned agents and excludes current members", async () => {
    const query = vi.fn();
    const view = ConversationMemberSearch({
      workspaceId: "w",
      conversationId: "c",
      mode: "floating",
      autoFocus: false,
      onQueryChange: query,
    });
    expect(view.props.mode).toBe("floating");
    expect(view.props.autoFocus).toBe(false);
    expect(view.props.onQueryChange).toBe(query);
    const groups = view.props.groups as MemberCandidateGroup[];
    expect(groups.map((g) => g.label)).toEqual(["AGENTS"]);
    expect(groups[0]!.items).toEqual([{ kind: "agent", agent: { id: "own" } }]);
    view.props.onPick(groups[0]!.items[0]);
    await vi.waitFor(() =>
      expect(h.add).toHaveBeenCalledExactlyOnceWith({ kind: "agent", agent_id: "own" }),
    );
    expect(h.target).toHaveBeenCalledExactlyOnceWith("c", "w");
  });
  it("lets workspace admins add eligible foreign agents and humans through the same mutation", async () => {
    h.role = "admin";
    const view = ConversationMemberSearch({
      workspaceId: "w",
      conversationId: "other",
      mode: "floating",
    });
    expect(view.props.autoFocus).toBe(true);
    const groups = view.props.groups as MemberCandidateGroup[];
    expect(groups.map((g) => g.label)).toEqual(["AGENTS", "HUMANS"]);
    expect(groups[0]!.items).toContainEqual({ kind: "agent", agent: { id: "foreign" } });
    view.props.onPick(groups[1]!.items[1]);
    await vi.waitFor(() =>
      expect(h.add).toHaveBeenCalledExactlyOnceWith({ kind: "human", user_id: "external" }),
    );
    expect(h.target).toHaveBeenCalledExactlyOnceWith("other", "w");
  });
});
