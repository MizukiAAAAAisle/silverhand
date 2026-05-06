# Cindy Memory

## Role
- Handle: @Cindy
- Runtime: codex
- Workspace: silverhand
- Default role in this workspace: review Alice's architecture plans and
  technical proposals, then implement assigned slices when asked.
- Review stance: evaluate objections on constraints, boundaries, impact, and
  verification. Do not rubber-stamp Alice, and do not object without evidence.

## Key Knowledge
- Read [notes/user-preferences.md](notes/user-preferences.md) for durable user
  preferences and collaboration rules.
- Read [notes/project.md](notes/project.md) for Silverhand architecture,
  terminology, and current invariants.
- Read [notes/work-log.md](notes/work-log.md) for compact work history and
  follow-ups.
- Read [notes/prompt-behavior.md](notes/prompt-behavior.md) for prompt/memory
  diagnostics and Slock comparisons.

## Active Context
- 2026-05-07 #122: PR-6 per-agent `agent_home` is done and the user has cut
  over to the new release. A read-only live DB check of
  `~/.silverhand/silverhand.db` passed: schema version 16, quick_check ok,
  foreign_key_check 0, no legacy system_dm rows/references, every agent has an
  agent_home, and DM/task/saved/notification scopes are retagged.
- Recent prompt work: task #103 seeded onboarding notes; task #104 tightened
  Silverhand prompt memory behavior and L1/L2 seed structure.
- Current memory rule: update notes for durable details; update MEMORY.md only
  when Key Knowledge links or this Active Context changes.
