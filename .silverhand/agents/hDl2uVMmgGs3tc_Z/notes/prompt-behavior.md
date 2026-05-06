# Prompt Behavior Diagnostics

## 2026-05-06: Notes and Thread Proactivity

User asked why Silverhand agents rarely update `notes/` or create Threads unless explicitly asked, and whether this is a prompt issue compared with slock-ai.

Findings:
- Silverhand has the capabilities and prompt text, but they are mostly permissive. `platform-prompt.ts` says to update notes proactively and says agents may open a Thread, but the live delivery instruction in `conversation-manager.ts` only reinforces visible reply/completion and does not add a stop-time memory/thread checkpoint.
- Silverhand seeds `.silverhand/agents/<id>/notes/` as an empty directory and copies only `system_prompt.md` and `MEMORY.md`; there is no initial note file or memory index scaffold beyond suggested layout text.
- Silverhand `create_thread` is a separate MCP tool with required title/context summary and a subjective "large enough to obscure" threshold, so agents treat it as high friction.
- Slock makes Threads part of normal message addressing: `send_message(target="#channel:msgShortId")` auto-creates a thread. Its task workflow explicitly tells agents to post updates in the task's thread.
- Slock also seeds onboarding note files for its first-Cindy onboarding mode and gives a concrete `MEMORY.md` template with `notes/...` pointers, reducing the "create from nothing" barrier.

Recommended prompt/product fixes:
- Add a stop-time memory checkpoint: before stopping after non-trivial work, update `MEMORY.md` and relevant notes if durable user preference, project context, work history, or agent-collaboration knowledge was learned; explicitly say skip only when there is no durable learning.
- Seed at least a minimal `notes/work-log.md` or `notes/project.md` and point to it from initial `MEMORY.md`, so updates extend an existing structure instead of requiring a new file decision.
- Add a task/thread checkpoint: for non-trivial claimed work or multi-round side discussion, create or reuse a Thread for progress/review/debug details; keep parent messages brief.
- Lower Thread wording from "large enough to obscure" to concrete triggers such as 3+ expected rounds, subset of members, parallel subtask, review/debug tangent, or detail-heavy evidence.
- Long term, reduce mechanics by supporting message/task-attached Threads or tool-result hints after claim/create task, similar to Slock's thread target hints.

Implementation nuance:
- In Slock, opening or replying in `#channel:msgShortId` does not itself create a new runtime agent session. It creates/uses a chat Thread target attached to a message. The daemon still manages runtime state per agent, not per Thread: incoming messages are delivered to the current agent process via stdin when possible, or restart/resume the cached agent runtime session if idle. A cold new runtime session happens only when there is no reusable session or the stored runtime session is unavailable, not because a Thread was opened.

## 2026-05-06: MEMORY.md Bloat

Observed in the Silverhand workspace:
- Existing agent `MEMORY.md` files have grown into detailed work logs: @Cindy's file is about 60KB with very long single-line bullets, and @Alice's is about 24KB with 370 lines.
- The main issue is not only update frequency; it is that `MEMORY.md` is being used as the detailed work-log store instead of a small index plus current handoff.

Prompt comparison:
- Silverhand says `MEMORY.md` is an entry point/index, but also says to keep it complete enough to preserve workspace/channel context, in-progress tasks, user asks, and other agents. That encourages agents to append detailed per-task summaries directly into `MEMORY.md`.
- Slock says more explicitly that `MEMORY.md` should stay easy to scan, that it is always the index, and that detailed knowledge belongs in `notes/`. It still says to update after work, but it distinguishes updating notes from updating the MEMORY index.

Recommended fixes:
- Make `MEMORY.md` bounded: role, key note links, current active context only, with a rough budget such as 80-120 lines or under 10KB.
- Move detailed work history to `notes/work-log.md`, project invariants to `notes/project.md`, and user/workflow preferences to `notes/user-preferences.md`.
- Change the stop-time checkpoint from "update MEMORY.md after significant work" to "update notes when durable knowledge changed; update MEMORY.md only if a note link, durable index item, or active handoff changed."
- Require merge/replace behavior: edit existing bullets and prune stale active context instead of appending a new long bullet every task.

Implemented in task #104:
- `platform-prompt.ts` now defines `MEMORY.md` as a compact index / active handoff, gives a target budget under 10KB / 80-120 lines, and sends detailed history/evidence to `notes/work-log.md`.
- The stop-time checkpoint now updates relevant notes first and updates `MEMORY.md` only when the Key Knowledge index or Active Context changes.
- L1 and L2 seeding both create the same compact `MEMORY.md` skeleton plus `onboarding-guide.md`, `onboarding-faq.md`, `user-preferences.md`, `project.md`, and `work-log.md` without overwriting existing edits.
