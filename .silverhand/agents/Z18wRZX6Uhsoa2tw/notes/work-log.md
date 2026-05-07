# Work Log

## 2026-05-04
- Completed early UI/UX improvement planning and implementation batches:
  message ordering, new-channel activation, Composer auto-height, shared
  AgentPicker, notifications, and Events window active-session handling.
- Worked with Cindy on agent lifecycle and activity issues, including shutdown,
  run-state, activity bubbles, tool summaries, and stale-turn diagnosis.
- Implemented or refined UI polish around task cards, task drawer, app shutdown
  overlay, scroll behavior, and event lists.

## 2026-05-05
- Helped complete workspace/channel/thread rename across frontend and docs while
  Cindy handled backend/shared and MCP prompt slices.
- Implemented frontend rename and docs updates for the public terminology.
- Worked on search UI, theme iterations, and prompt wording cleanup.

## 2026-05-06
- Owned WebSocket shared frame/event-bus/replay-buffer slice and later
  notification/unread/task WS invalidation slice.
- Helped diagnose duplicate network requests after WS migration.
- Implemented task #103 onboarding seed notes and removed "platform" wording
  from that seed content.
- Agreed with Cindy's memory prompt direction: MEMORY.md should stay compact;
  detailed history goes to notes.

## 2026-05-07
- Drove holistic permission system design discussion in
  "Attachment 鉴权讨论" channel with @Cindy. Reached design consensus on
  4-layer pipeline (Authentication → Principal → ACL → Handler) and the
  three Principal kinds (user / agent / system).
- After post-isomorphism refactor (commit `0ca99ce`) re-mapped auth surface;
  found business-logic isomorphism done but identity/transport/ACL still
  v1 placeholder. Adjusted plan: Slice A' (Principal unification) leverages
  existing per-service `*Actor` unions.
- Locked Slice A' edges with @Cindy: Principal lives in backend not shared,
  internal router REJECTS `X-Silverhand-Principal` header (single identity
  source = URL), strict scope guards (no Bearer rollout in A'), two
  regression tests (`test_public_no_bearer_unchanged`,
  `test_internal_rejects_principal_header`), failure interpretation =
  scope creep (revert, don't fix).
- Authored `docs/permissions.md` (per user request) — covers 4-layer
  pipeline, current v1 model with gaps, target model post-A', ACL family
  + agent_home rules, mutation authority matrix, Phase 1 slice plan,
  Phase 2 multi-user/remote artifacts, open invariants.
- Task board: #110 (attachment ACL) released by @Cindy as downstream
  cleanup; #125 "Implement Principal auth infra Slice A'" claimed by
  @Cindy. @Alice reviews PR.

