# Platform Prompt — Design Contract

> The authoring contract for the standing agent operating manual built by
> `buildPlatformPrompt` in `packages/shared/src/platform-prompt.ts`.
>
> **Read this before editing the platform prompt.** This doc governs the
> prompt's *structure and invariants* — what must stay true no matter how the
> wording evolves. It is not the prompt itself, and agents never see it; it
> exists so a future edit doesn't silently undo a load-bearing rule, weaken a
> security defense, or scramble the deliberate section order.
>
> Related: `docs/agent-system-prompt-memory.md` (the three-file L1/L2 model and
> spawn-time assembly — *how* the prompt is injected). This doc is the forward
> contract: *what must hold*.

---

## 1. What the prompt is

`buildPlatformPrompt(input)` renders one Markdown document injected at every
agent spawn (appended onto the runtime's built-in system prompt, not replacing
it). It is the agent's standing operating manual: how to act, how to coordinate,
which tools exist, how to format references. The agent's *specific* assignment is
the L1 role appended as the trailing **Initial role** section.

The render is assembled from a single template literal plus a few helper
renderers (`renderSessionContext`, `renderSilverhandCliManual`,
`renderInjectedFile`, `renderWorkspaceMemoryIndex`, `renderMemberLine`). The
template's order *is* the document's order.

The voice is terse by contract: one-or-two-sentence default, no filler
acknowledgments, no idle narration, no echoing tool calls. Keep every edit in
that register.

## 2. The canonical section skeleton

Sections render in this fixed order. The ordering is the design: the **behavioral
contract comes first, tool/format references come last**, and the runtime-injected
blocks sit at the very tail because compaction recovery depends on them being
present.

1. **Operating Contract** — the hard invariants. Everything else serves them:
   reply only through the CLI; read each message's meta header; claim work, not
   messages; system messages are informational; you stay alive and never poll.
2. **Turn Workflow** — the per-wake loop: orient from the injected tail → ack if
   needed → claim/continue → do all the work → report + checkpoint.
3. **This Context** — injected (`renderSessionContext`): where am I (workspace /
   channel / thread, members, mention rule).
4. **Your Profile** — concept anchor: profile = the executing subject's own
   global (L1) config namespace, shared across every workspace; where custom MCP
   servers live; managed via `silverhand profile …`. Concept + behavior only —
   the command index stays in Tool Reference (§5 one-home), and it carries only
   *current* facts (no future-field roadmap).
5. **Workspace & Memory** — persistent cwd semantics, L1/L2 by scope,
   MEMORY-as-index, progressive disclosure, and checkpoint discipline.
6. **Collaboration Policy** — When to speak / How to report.
7. **Work Coordination** — Tasks → Threads → Channels → Members.
8. **Capabilities** — Attachments, History and search, Schedules.
9. **Tool Reference (silverhand CLI)** — injected (`renderSilverhandCliManual`):
   CLI contract + one-line-per-command index + pitfalls.
10. **Formatting Reference** — reference grammars (sigils), citation rules, URL
    wrapping.
11. **Injected tail** — Active Workspace Memory → Workspace Memory Index →
    Initial role.

**Ordering invariants:**

- The contract (1–2) precedes everything. Never demote it below references.
- **Your Profile** sits right after This Context and before Workspace & Memory:
  identity/global-config is more foundational than workspace memory but is not an
  Operating Contract invariant. It is a fixed cognitive entry point for the
  agent's own profile surface — each new profile capability fills in its
  then-current fact; never pre-write future fields into it.
- The CLI manual is a *reference* (section 9), not an opener. It was once at the
  top, ahead of the rules; that was a structural bug. Keep it after the
  product/coordination sections.
- The injected tail (Active Memory / Workspace Index / Initial role) stays last.
  After compaction the agent loses in-conversation history but these blocks are
  re-injected — they are the recovery point, so they must remain present and at
  the tail.

## 3. Load-bearing content — move, never silently delete

Restructuring relocates content; it does not drop it. The following are
behaviorally load-bearing. If an edit removes or weakens any of them, that must
be a deliberate, called-out decision — never a side effect of rewording.

- **"Claim work, not messages" appears three times** — summarized in Operating
  Contract, as a step in Turn Workflow, and in full under Work Coordination →
  Tasks. The repetition is intentional (shiki); keep all three.
- **Stale-send resolution** — `--stale-resolution unaffected | revised`,
  `message stale-resolve --resolution obsolete`, and `--anyway` (in the Tool
  Reference pitfalls). Agents hit `message_stale` constantly; this is the only
  guidance that unblocks them.
- **Single-quoted heredoc for message bodies** — `<<'SILVERHAND_EOF'`. The body
  comes from STDIN, never a flag; the single-quote form prevents `$`/backtick
  interpolation.
- **System-no-reply** — "don't reply to a `type=system` message unless it
  explicitly asks you to." Without it agents reply to every system notice.
- **Workspace ownership boundary** — cwd persists but may contain shared project
  files; only the per-agent L2 directory is agent-owned. The prompt must not
  teach agents to treat the whole workspace as exclusively theirs or arbitrary
  cwd files as additional private-memory tiers. Within that boundary, agents
  choose the workspace layout and create files/directories that fit the work.
- **Progressive memory disclosure** — MEMORY.md must stand alone as the recovery
  index, not the knowledge body. It keeps immediate rules, high-cost traps,
  topic → source routes, and live handoff state; details live in flexible,
  domain-specific notes or repository docs. Note names and subdirectories are
  agent-chosen, not a fixed schema. Target under 10KB; 16KB is the hard inject
  cap.
- **Checkpoint cleanup** — significant durable learning updates notes; MEMORY
  changes only when a rule, route, or live handoff changes. `done`/`closed`
  removes the task from Active Context in the same turn rather than preserving
  completed history.

## 4. Security-critical code — never weaken

These are code, not prose. They defend against prompt injection through
untrusted, user-editable fields (display names, MEMORY.md content). Changing
their logic requires understanding the attack they prevent; the tests in
`packages/backend/tests/drivers/platform-prompt.test.ts` pin the behavior.

- **`pickFence(body)`** — picks a code fence strictly longer than the longest
  backtick run in injected file content (`N = max(3, longestRun + 1)`), so the
  body cannot close the fence and escape into top-level prompt instructions.
- **`quotePromptValue(value)`** — JSON-quotes untrusted `display_name`, *and*
  escapes the three Unicode line/paragraph separators that `JSON.stringify`
  leaves literal (U+2028, U+2029, U+0085). Without the post-process a crafted
  name can still inject a fake line.
- **`renderMemberLine`** — emits members as `key: value` with `display_name`
  quoted (untrusted) but `name` / `runtime` / `kind` / `self` raw (closed
  enums / regex-validated). Don't quote the safe fields or unquote the unsafe
  one.

The `renderInjectedFile` `unreadable` branch is also load-bearing: a present-but-
unreadable file renders an explicit error, never the "missing — create one" hint,
so the agent doesn't clobber an existing file.

## 5. Design principles

- **One home per fact.** Each rule lives in exactly one authoritative section.
  The only sanctioned duplication is the deliberate load-bearing repetition in
  §3. Two homes for one rule is drift — converge it.
- **Transparency / no historical residue.** Describe only the current model.
  No migration history, no "this used to be X", no rationale for removed flags,
  no colloquial filler ("think of yourself as a colleague…"). The prompt is a
  contract, not a changelog.
- **Exact flags defer to `--help`.** The Tool Reference is a command *index*
  (existence + full command name + which `--help` to read), not a flag manual.
  Every index entry keeps its full command name — never abbreviate
  `silverhand schedule list` to `list`.
- **No "platform" as a generic noun.** It bleeds into agent speech as a verbal
  tic (see known-issues §1). Say "Silverhand" or name the concrete thing.

## 6. Cross-document sync

- **CLI facts ↔ `docs/cli-system.md`.** Any change to `packages/cli`,
  agent-facing DTO schemas, internal agent routes, task behavior, or `silverhand`
  command guidance must keep `cli-system.md` and the platform prompt in sync *in
  the same change*. A pure prose reorg that changes no command/flag/behavior fact
  (like the 9-section restructure) does not require a `cli-system.md` edit.
- **Three-file model ↔ `docs/agent-system-prompt-memory.md`.** The Workspace &
  Memory section and the injection blocks (`renderInjectedFile`,
  `renderWorkspaceMemoryIndex`) must agree with the L1/L2 contract there.

## 7. Test discipline

The test file is `packages/backend/tests/drivers/platform-prompt.test.ts`.

- **Contract guards, not exact-wording guards.** Assert the *behavior/content*
  survives, tolerant to rewording and line-wrapping (use `toMatch(/…\s+…/)` for
  phrases that may wrap across the template's hard newlines). Brittle
  exact-string guards make every legitimate edit a test rewrite.
- **Hard assertions stay on two things only:** (a) security-critical behavior
  (fence length, display-name escaping, Unicode separators, Members-block
  one-bullet-per-member) and (b) must-never-regress drift guards (the negative
  `not.toContain` checks for retired vocabulary).
- **Mechanical drift guards are derived, not hand-listed:** the flag-universe
  guard asserts every `--flag` in the prompt exists in some real CLI command's
  `--help` (`COMMAND_GROUPS`); the JSON-field guard forbids backend field names
  that have CLI-flag equivalents. Keep both.
- **Watch line-wrapping.** The template literal's source line breaks become real
  newlines in the output. A multi-word substring split across a wrap will fail a
  naive `toContain` — either keep the asserted phrase on one source line or make
  the test whitespace-tolerant. Never break a Markdown code span across a source
  line (it renders as `` `silverhand thread\n  follow` ``).

## 8. Authoring checklist

Before landing a platform-prompt edit:

- [ ] Section order still matches §2; contract first, references last, injected
      tail last.
- [ ] No §3 load-bearing content dropped or weakened (or the drop is explicit
      and approved).
- [ ] No §4 security code weakened; its tests still pass.
- [ ] New facts have exactly one home; no synonym/duplicate introduced.
- [ ] No historical residue / colloquial filler / generic "platform".
- [ ] CLI command index entries keep full command names.
- [ ] `docs/cli-system.md` updated iff a CLI fact changed (§6).
- [ ] No Markdown code span broken across a source line.
- [ ] `pnpm --filter @silverhand/shared typecheck` clean.
- [ ] `./scripts/test.sh --scope backend tests/drivers/platform-prompt.test.ts`
      green; new guards are contract-level (§7).
