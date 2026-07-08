// Compile-time fail-loud proof for the viewer-local removal contract (#task:1412).
//
// These fixtures are NEVER executed — they live in `_`-prefixed functions that
// nothing calls. Their whole job is the `@ts-expect-error` directives: each
// asserts that a MISUSE fails to compile. If a constraint ever stops firing
// (e.g. someone makes `cleanup` optional, or a DTO's `workspace_id` optional),
// the expected error vanishes, the directive becomes "unused", and `tsc` turns
// RED — that is the fail-loud Cindy's gate requires (not a comment).
//
// Filename is `.type-test.ts` (not `.test.ts`) so vitest does not treat it as a
// suite; the desktop `tsc` typecheck is what validates it.
import type { ListActivityDto, ListFavoritesDto } from '@silverhand/shared';
import {
  itemScopedList,
  type ProjectionForm,
  type RegisteredReadModel,
} from './viewer-removal-contract';

const noopCleanup = (): void => {};

// ── Layer 2, constraint A: an item-scoped ATTRIBUTED cache MUST declare cleanup.
function _cleanupIsMandatory(): void {
  // Positive control: the real DTOs are detected as attributed AND compile with
  // a cleanup. If ActivityItemDto.workspace_id regressed to optional, this call
  // would fail (list no longer `extends ItemScopedListData`) — Alice ①.
  const ok: RegisteredReadModel = itemScopedList<ListActivityDto>({
    id: 'activity',
    key: ['activity', 'all'],
    cleanup: noopCleanup,
  });
  void ok;

  // @ts-expect-error — attributed item-scoped read model without `cleanup` must not compile.
  itemScopedList<ListFavoritesDto>({ id: 'favorites', key: ['favorites', 'all'] });
}

// ── Layer 2, constraint B: a NON-attributed list cannot masquerade as item-scoped.
function _nonAttributedRejected(): void {
  // @ts-expect-error — items lack `workspace_id`, so TData ⊄ ItemScopedListData and
  // the entry param collapses to `never`.
  itemScopedList<{ items: { foo: string }[] }>({
    id: 'bogus',
    key: ['bogus'],
    cleanup: noopCleanup,
  });

  // @ts-expect-error — OPTIONAL workspace_id is NOT attributed (Alice ①): the guard
  // only fires on a required field, so an optional-id list collapses to `never`.
  itemScopedList<{ items: { workspace_id?: string }[] }>({
    id: 'optional-id',
    key: ['optional-id'],
    cleanup: noopCleanup,
  });
}

// ── Layer 2, constraint B′: attribution must be DECLARED, never defaulted (Alice
// ②). Omitting the `<Dto>` type param leaves `TData = unknown ⊄ ItemScopedListData`,
// so the entry param is `never` — the phantom-generic escape (a `<TData extends …>`
// that silently skips when the arg is omitted) is closed by construction.
function _typeParamIsMandatory(): void {
  // @ts-expect-error — no explicit <Dto>: TData defaults to unknown → entry is `never`.
  itemScopedList({ id: 'unparameterized', key: ['x'], cleanup: noopCleanup });
}

// ── Layer 2, constraint C: form dispatch is exhaustive (Alice ②) — a form left
// without a branch leaves a non-`never` for the assertNever tail.
function _localAssertNever(x: never): never {
  throw new Error(String(x));
}
function _dispatchMustBeExhaustive(form: ProjectionForm): void {
  switch (form) {
    case 'workspace-keyed':
      return;
    case 'item-scoped-list':
      return;
    // 'record-keyed-summary' intentionally omitted to prove the mechanism:
    default:
      // @ts-expect-error — a missing form branch leaves 'record-keyed-summary', not never.
      return _localAssertNever(form);
  }
}
