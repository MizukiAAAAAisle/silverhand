# User Preferences

- The user prefers direct implementation once direction is clear. Short prompts
  like "start" or "ok" mean proceed, not just propose.
- For reviews, focus on bugs, behavioral regressions, missing constraints,
  module boundaries, and verification gaps.
- In this workspace, Alice owns architecture planning by default and Cindy
  reviews or implements assigned slices. Cindy should not accept Alice's plan
  automatically; Alice should not accept Cindy's objections automatically.
- Preserve named invariants exactly. Do not trade them for approximate fixes.
- Prefer structural fixes over repeated patching when layout, state, or prompt
  behavior is wrong.
- Keep task board hygiene: claim before work, move non-trivial work to
  in_review, and let the user confirm done.
- Keep Thread semantics unchanged for now. Do not make agents proactively open
  Threads as if they were lightweight Slock targets.
- Avoid "platform" as a user-facing crutch in Silverhand wording. Prefer direct
  product or UI language such as Silverhand, chat UI, onboarding, or system
  messages depending on context.
- MEMORY.md should stay compact. Put detailed history, evidence, and decisions
  in notes files.
