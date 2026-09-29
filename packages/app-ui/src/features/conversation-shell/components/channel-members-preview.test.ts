import { expect, it, vi } from "vitest";
import type { MemberDto } from "@silverhand/shared";
import { ChannelMembersPreview } from "./channel-members-preview";
import { UserAvatar } from "@/components/user-avatar";
import { AgentAvatar } from "@/components/agent-avatar";

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useState: () => [80, vi.fn()],
  useMemo: (compute: () => unknown) => compute(),
}));
vi.mock("@/features/users/hooks", () => ({ useUsersById: () => new Map() }));
vi.mock("@/features/users/avatar-hooks", () => ({
  useUserAvatarObjectUrls: () => new Map([["h1", "blob:human"]]),
}));

const human = (id: string) => ({ kind: "human", user_id: id, name: id }) as MemberDto;
const agent = { kind: "agent", agent_id: "a1", name: "agent", runtime: "codex" } as MemberDto;

it("previews human-only rosters and keeps the add slot within the two-row budget", () => {
  const open = vi.fn();
  const view = ChannelMembersPreview({
    members: [human("h1"), human("h2"), human("h3"), human("h4")],
    avatarUrls: new Map(),
    canAdd: true,
    onOpen: open,
    onAdd: vi.fn(),
  });
  const buttons = view.props.children.props.children[0];
  expect(buttons).toHaveLength(3);
  expect(buttons[0].props.children.type).toBe(UserAvatar);
  expect(buttons[0].props.children.props.avatarObjectUrl).toBe("blob:human");
  buttons[0].props.onClick();
  expect(open).toHaveBeenCalledOnce();
});

it("preserves mixed roster order and distinguishes identities", () => {
  const view = ChannelMembersPreview({
    members: [human("h1"), agent],
    avatarUrls: new Map([["a1", "blob:agent"]]),
    canAdd: false,
    onOpen: vi.fn(),
    onAdd: vi.fn(),
  });
  const buttons = view.props.children.props.children[0];
  expect(buttons.map((button: any) => button.props.children.type)).toEqual([
    UserAvatar,
    AgentAvatar,
  ]);
  expect(buttons[1].props.children.props.avatarObjectUrl).toBe("blob:agent");
  expect(view.props.children.props.children[1]).toBeNull();
});
