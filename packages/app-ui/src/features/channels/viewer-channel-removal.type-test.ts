// Compile-time fail-loud proof for the channel-scope removal contract (#task:1689).
//
// Never executed — the fixtures exist for their `@ts-expect-error` directives:
// each asserts that a MISUSE fails to compile. If a constraint stops firing (a
// DTO's `conversation_id` becomes optional, `cleanup` becomes optional, a form
// loses its dispatch branch) the expected error vanishes, the directive becomes
// unused, and `tsc` turns RED.
//
// `.type-test.ts` (not `.test.ts`) so vitest does not treat it as a suite; the
// desktop typecheck validates it.
import type { ListActivityDto, SavedMessageDto } from "@silverhand/shared";
import {
  attributedRowFamily,
  itemScopedList,
  type ChannelProjectionForm,
  type RegisteredChannelReadModel,
} from "./viewer-channel-removal";

const noopCleanup = (): void => {};
const noopHeld = (): string[] => [];

// ── Constraint A: an attributed item-scoped cache MUST declare cleanup.
function _cleanupIsMandatory(): void {
  // Positive control: the real DTO is detected as conversation-attributed. If
  // `ActivityItemDto.conversation_id` regressed to optional this would fail.
  const ok: RegisteredChannelReadModel = itemScopedList<ListActivityDto>({
    id: "activity",
    key: ["activity", "all"],
    roots: ["activity"],
    cleanup: noopCleanup,
    heldChannelIds: noopHeld,
  });
  void ok;

  // @ts-expect-error — attributed item-scoped read model without `cleanup` must not compile.
  itemScopedList<ListActivityDto>({
    id: "activity",
    key: ["activity", "all"],
    roots: ["activity"],
    heldChannelIds: noopHeld,
  });
}

// ── Constraint A′: and it MUST declare `heldChannelIds`. That function is what
// converges a workspace the viewer is not looking at, so an entry that omits it
// would be silently invisible to the foreign-workspace trigger — a cleanup that
// only ever runs after navigation.
function _heldChannelIdsIsMandatory(): void {
  // @ts-expect-error — registered read model without `heldChannelIds` must not compile.
  itemScopedList<ListActivityDto>({
    id: "activity",
    key: ["activity", "all"],
    roots: ["activity"],
    cleanup: noopCleanup,
  });
}

// ── Constraint A″: and it MUST declare the roots its cleanup writes, so the
// classification smoke test can join them in both directions.
function _rootsAreMandatory(): void {
  // @ts-expect-error — registered read model without `roots` must not compile.
  itemScopedList<ListActivityDto>({
    id: "activity",
    key: ["activity", "all"],
    cleanup: noopCleanup,
    heldChannelIds: noopHeld,
  });
}

// ── Constraint B: a NON-attributed list cannot masquerade as item-scoped.
function _nonAttributedRejected(): void {
  // @ts-expect-error — items lack `conversation_id`, so TData ⊄ ConversationScopedListData.
  itemScopedList<{ items: { foo: string }[] }>({
    id: "bogus",
    key: ["bogus"],
    roots: ["bogus"],
    cleanup: noopCleanup,
    heldChannelIds: noopHeld,
  });

  // @ts-expect-error — an OPTIONAL conversation_id is not attributed: the guard fires
  // only on a required field, so the entry param collapses to `never`.
  itemScopedList<{ items: { conversation_id?: string }[] }>({
    id: "optional-id",
    key: ["optional-id"],
    roots: ["optional-id"],
    cleanup: noopCleanup,
    heldChannelIds: noopHeld,
  });
}

// ── Constraint B′: attribution must be DECLARED, never defaulted. Omitting the
// type param leaves `TData = unknown ⊄ ConversationScopedListData`.
function _typeParamIsMandatory(): void {
  // @ts-expect-error — no explicit <Dto>: TData defaults to unknown → entry is `never`.
  itemScopedList({
    id: "unparameterized",
    key: ["x"],
    roots: ["x"],
    cleanup: noopCleanup,
    heldChannelIds: noopHeld,
  });
}

// ── Constraint D: a row family must carry BOTH attribution axes. `heldChannelIds`
// answers "which channels OF THIS WORKSPACE does the cache still describe", which
// a row carrying only `channel_id` cannot answer for a non-selected workspace.
function _rowFamilyNeedsBothAxes(): void {
  // Positive control: the real Saved DTO folds both axes into its `place`
  // discriminated union (workspace_channel arm carries workspace_id +
  // conversation_id), so it satisfies the family constraint (#task:2055).
  const ok: RegisteredChannelReadModel = attributedRowFamily<SavedMessageDto[]>({
    id: "saved",
    key: ["saved"],
    roots: ["saved"],
    cleanup: noopCleanup,
    heldChannelIds: noopHeld,
  });
  void ok;

  // @ts-expect-error — rows carry no `workspace_id`, so the entry param is `never`.
  attributedRowFamily<{ id: string; channel_id: string }[]>({
    id: "channel-only",
    key: ["channel-only"],
    roots: ["channel-only"],
    cleanup: noopCleanup,
    heldChannelIds: noopHeld,
  });

  // @ts-expect-error — rows carry no `channel_id`; a workspace axis alone cannot
  // name the lost channel.
  attributedRowFamily<{ id: string; workspace_id: string }[]>({
    id: "workspace-only",
    key: ["workspace-only"],
    roots: ["workspace-only"],
    cleanup: noopCleanup,
    heldChannelIds: noopHeld,
  });

  // @ts-expect-error — no explicit <Dto[]>: TData defaults to unknown → `never`.
  attributedRowFamily({
    id: "unparameterized-family",
    key: ["y"],
    roots: ["y"],
    cleanup: noopCleanup,
    heldChannelIds: noopHeld,
  });
}

// ── Constraint C: form dispatch is exhaustive — a form without a branch leaves a
// non-`never` for the assertNever tail.
function _localAssertNever(x: never): never {
  throw new Error(String(x));
}
function _dispatchMustBeExhaustive(form: ChannelProjectionForm): void {
  switch (form) {
    case "conversation-keyed":
      return;
    case "item-scoped-list":
      return;
    case "attributed-row-family":
      return;
    case "opaque-reference-family":
      return;
    // 'record-keyed-map' intentionally omitted to prove the mechanism:
    default:
      // @ts-expect-error — a missing form branch leaves 'record-keyed-map', not never.
      return _localAssertNever(form);
  }
}
