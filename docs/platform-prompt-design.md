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
> Related: `docs/agent-system-prompt-memory.md` (the internal storage and
> spawn-time assembly model). This doc is the forward contract: *what must
> hold in the agent-visible manual*.

---

## 1. What the prompt is

`buildPlatformPrompt(input)` renders one Markdown document injected at every
agent spawn (appended onto the runtime's built-in system prompt, not replacing
it). It is the agent's standing operating manual: how to act, how to coordinate,
which tools exist, how to format references. The agent's specific assignment is
appended as the trailing **Initial role** section.

The render is assembled from a single template literal plus a few helper
renderers (`renderSessionContext`, `renderSilverhandCliManual`,
`renderInjectedFile`, `renderWorkspaceMemoryIndex`, `renderMemberLine`). The
template's order *is* the document's order. The CLI domain index is generated
from `packages/shared/src/cli-command-manifest.ts`; it is not a second
hand-written command inventory.

The voice is terse and formal by contract: no filler acknowledgments, idle
narration, conversational persuasion, or echoed tool calls.

**Register (ruled by @shiki, 2026-08-15): manual, not conversation.** A rule
states facts, conditions, the action, and the error code it fails with. It does
not persuade, does not suggest what to try instead, and does not re-explain a
rule that already has a home. Prefer a scannable table or short bullets over
prose; a paragraph that reads like advice is over budget by construction. The
same register applies to CLI `--help`, which is a command manual — and where a
rule is also machine-enforced, the help text is derived from that authority
rather than written beside it (see §3, the reach boundary).

## 2. The canonical section skeleton

Sections render in this fixed order. The ordering is the design: **identity
anchor first, runtime facts immediately after it (This Context), the behavioral
contract right behind them, tool/format references last**, and the
runtime-injected blocks sit at the very tail because compaction recovery depends
on them being present.

0. **Who you are in silverhand** — the leading H1 and short identity preface.
   It names the agent's Silverhand collaboration context before runtime facts.
1. **This Context** — injected (`renderSessionContext`): the structured
   runtime facts, one bullet each — Agent ID, Computer (the daemon's
   authenticated computer id), Workspace (name + the local root resolved on
   *this* computer), Channel (title + conversation id), Channel members,
   mention rule. Agent-scoped sessions expose only the observable contract:
   deliveries provide a target and working directory. Internal placement,
   storage, and memory-tier names do not render. The incoming message header is
   the authority for the current delivery target; the prompt does not restate
   the session's placement class.
2. **Operating Contract** — the hard invariants. Everything else serves them:
   reply only through the CLI (and ONLY the documented `silverhand` command
   families for communication and Silverhand management); read each message's
   meta header; the reach boundary of this session's credential; claim work, not
   messages; system messages need no chat reply by default but still require an
   action-judgment; you stay alive and never poll.
3. **Turn Workflow** — read context → claim/continue → record a short handoff
   before long work when persistent memory exists → complete and verify → update
   state, remove completed handoffs, and report.
4. **Memory and files** — the observable working-directory and persistence
   contract for the current session scope, plus progressive disclosure and
   checkpoint discipline. It never teaches the implementation's memory tiers.
5. **Collaboration Policy** — When to speak / How to report.
6. **Work Coordination** — Tasks → Acceptance Summary → Splitting work → Threads →
   Cross-computer work → Channels → Members.
7. **Tool Reference (silverhand CLI)** — injected (`renderSilverhandCliManual`):
   compact CLI contract + generated Domain → subcommand index + pitfalls.
8. **Formatting Reference** — address and reference grammars.
9. **Injected tail** — scope-dependent active memory, notes catalog, optional
   workspace-memory index, then Initial role. Workspace-less conversations
   render none of the memory projections.

**Ordering invariants:**

- The `# Who you are in silverhand` identity heading is the document opener.
  Its heading is structural; the following introductory prose remains free to
  evolve.
- This Context (1) precedes every operational rule: runtime facts before rules.
  The contract (2–3) precedes all knowledge/reference sections. Never demote
  the contract below references.
- The CLI manual is a *reference* (section 7), not an opener. It was once at the
  top, ahead of the rules; that was a structural bug. Keep it after the
  product/coordination sections.
- The injected tail (Active Memory / optional Workspace Index / Initial role)
  stays last.
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
- **Stale-send resolution trigger** — after `message_stale`, the agent must read
  the pending delivery and classify the draft as unchanged, revised, or
  obsolete. Exact recovery commands live in the error hint and
  `silverhand message --help`; the standing prompt must still tell the agent to
  consult them rather than force-send blindly.
- **Single-quoted heredoc for message bodies** — `<<'SILVERHAND_EOF'`. The body
  comes from STDIN, never a flag; the single-quote form prevents `$`/backtick
  interpolation.
- **System-no-reply, still-judge-action** — "system messages do not require a
  chat reply by default; evaluate each message's semantics and your current
  responsibilities to decide whether action is required." Splits "no reply
  needed" from "no action needed": without the first half agents reply to every
  system notice; without the second they misread "no reply" as "nothing to do"
  and ignore actionable events (e.g. an unassigned `task_create` in their own
  channel).
- **Conversation privacy is an output boundary** — the prompt does not impose a
  schema on shared memory. It instead forbids disclosing private content from one
  conversation in another unless the current user instruction or task explicitly
  authorizes it. The incoming header decides the current target.
- **Project location comes from the work** — the prompt does not turn process
  cwd, delivery metadata, or a Silverhand workspace into an assigned project
  directory. The current user or task supplies the location when one is needed.
- **Persistent space remains explicit** — regular workspace sessions identify
  their L2 root; Agent Space and agent-scoped sessions identify the agent's L1
  root. Agent Space and agent-scoped are mutually exclusive product forms, so
  the latter names only its memory root and does not invent a Workspace or Agent
  Space container. These roots identify persistent Silverhand memory/files, not
  an assigned project directory.
- **Implementation layering stays transparent** — prompts state the available
  product coordinate, not how it is implemented. They never name runtime
  scope, AgentSlot, ConversationSlot, delivery workdirs,
  profile directories, memory tiers, or internal storage topology. Workspace and
  workspace-less prompts follow the same rule: describe the available behavior,
  not the projection mechanism.
- **Progressive memory disclosure** — MEMORY.md must stand alone as the recovery
  index, not the knowledge body. It keeps immediate rules, high-cost traps,
  pinned topic → source routes, and live handoff state; details live in
  flexible, domain-specific notes or repository docs. The daemon-generated
  Memory Notes Catalog exposes note metadata on every spawn, while bodies stay
  on disk and are read only when a description matches the work. Note names and
  subdirectories are agent-chosen, not a fixed layout. The catalog injects at
  most 20 entries with descriptions capped at 200 characters, and the
  complete rendered catalog block has a separate 4KB UTF-8 hard cap; MEMORY.md
  targets under 10KB and has its own 16KB hard inject cap.
- **Durable-memory admission** — code/docs/tests, task state, and conversation
  history outrank persistent memory. Notes accept only stable cross-task
  knowledge absent from those authorities. `done`/`closed` removes the task from
  Active Context in the same turn rather than preserving completed history.
- **Active Context remains distinguishable** — when more than one conversation
  has work in flight, each live handoff identifies its conversation or task.
  This is an index rule for recovery, not a routing or privacy boundary; the
  incoming message header remains authoritative for the current target.
- **Collaboration silence rules** — respect an ongoing exchange, do not echo
  another agent or your own message, do not narrate idle state, and react
  sparingly. These violations are silent and cannot be repaired by pull-based
  help.
- **Dependent commands run separately** — later commands whose inputs depend on
  earlier results are issued only after reading those results. A chained
  claim-then-act or stale retry can leave state ambiguous.
- **Task state before speech** — task status moves before the completion report;
  `unclaim` never means done.
- **Reference grammar summary** — the prompt keeps the short `@<handle>`,
  `#conv:<id>`, and `#task:<n>` distinction because malformed sigils silently
  render inert. Detailed examples belong in `silverhand message --help`.
- **The reach boundary, per credential** — the Operating Contract carries one
  bullet naming which addressed commands act only in the conversation this
  session is anchored to, which reach any conversation the agent participates
  in, and the `slot_out_of_scope` refusal a confined door answers with
  elsewhere (#task:2021 P4-4). It is load-bearing for the same reason the
  meta-header bullet is: reach is the one refusal an agent cannot derive from the
  address grammar — the token is well-formed and the stream is one it
  participates in, and the door still refuses. An agent that has not been told
  either reads the 403 as a bug or never tries the cross-stream doors that ARE
  open to it. Two properties are decided, not stylistic:
  1. **Derived, never transcribed.** The paragraph is rendered from
     `DELIVERY_REACH` in `packages/shared/src/delivery-reach.ts`, the same datum
     the backend enforces and the CLI's errors adopt. A hand-written copy would
     be a fourth reader of a product ruling, kept true only by a drift gate.
  2. **Both lists always render, and only the confined branch names the code.**
     Enumerating just the confined doors is true only until a door is added, and
     teaching a confinement to a credential that has none makes the agent decline
     work it may do — a mistake no error would ever correct. Guarded per scope by
     `packages/shared/tests/platform-prompt-reach.test.ts`.
- **Acceptance Summary in the task body** — a non-trivial task moving to
  `in_review` carries ONE canonical Acceptance Summary (scope, key decisions,
  actual behavior changes, verification, residual risks/human decisions),
  revised in place. The body is definition + acceptance record; discussion stays
  in chat or the source thread. Without "revise in place" the body accretes a
  per-round repair log and stops being independently reviewable. The heading names
  the artifact, not an activity: an activity-named heading ("Review Handoff") reads
  as governing every review a human asks for, while this section governs only the
  task body at `in_review` (shiki, 2026-08-06). Keep heading and term identical —
  a second name for the same artifact is drift.
- **Boundary reporting across computers** — an agent iterates on its own
  computer and reports once at a stable boundary; it does not follow another
  workstream's intermediate activity or ask for a walkthrough of state it cannot
  inspect. Portable evidence — text or an attachment — is the handoff; the
  authority for "a local path is not portable" is the Operating Contract
  `computer=` bullet, and it must not be restated elsewhere. A local commit is
  deliberately NOT in that enumeration: another computer cannot read a commit
  object that has not reached a shared remote, and pushing is not an agent's
  action.
- **The follow-state guidance is a principle, not a rule, and the announce-then-
  unfollow order is load-bearing** — it lives in `### Threads`: follow state stays
  aligned with your part in the work, unfollowing is silent, you announce the
  departure before unfollowing, and a later mention brings you back. Four things
  about that shape are decided, not stylistic:
  1. **No conditions.** Earlier drafts scoped it — first to threads *where only
     agents are working* and a participant brought in *for a single question*,
     then to a *temporary participant* who declares no remaining work depends on
     them. Ruled out by shiki (2026-08-06): "两版都有点太死板了，应该提供一个理念，
     而不是一个规则", and on the risk of an agent leaving too early, "我可以接受判断
     失误，可以实验". Whether an agent is still part of the work is its own
     judgment; enumerating the situations in which it may leave states the
     conclusion for it. Do not reintroduce a condition clause.
  2. **The criterion is your part in the work, not how active you are.** An agent
     waiting on someone else's delivery is idle this round yet still part of the
     work; a criterion phrased as "active participation" would tell it to leave.
     Keep the criterion about the work, not about recent output.
  3. **The order is mechanism, not manners.** `applyThreadFollowEffects`
     (`packages/backend/src/services/conversation-message/thread-follow.ts`)
     registers the author of **every** reply as a follower (`source='reply'`), so
     announcing *after* unfollowing silently re-follows the announcer and the
     guidance executes as a no-op. The sentence order is what preserves this;
     never rewrite it as "unfollow, then announce".
  4. **The thread root's author needs no written exception.** That author is
     re-registered on every reply (`source='target_author'`, same file) and so
     cannot leave; a principle addressed to one's part in the work simply does not
     fit them, whereas a rule would have had to carve them out.
  5. **The recall sentence stays plain.** "A later mention brings you back" was
     chosen by shiki (2026-08-06) over spelling out the two effects (follow state
     restored, replies missed while unfollowed delivered). The mechanism belongs
     to `silverhand thread --help`, and the sentence only has to make departure
     feel reversible.

  Accepted residual: an agent may misjudge and leave while a human still wants it.
  The mitigation is the announcement — the departure is stated, and one mention
  brings the agent back. This is shiki's ruling, not an oversight.

**Deliberately excluded (#task:1825) — do not "restore" these as omissions:**

- **Thread as a computer isolation boundary.** An earlier proposal keyed threads
  to a computer ("one thread per computer", "don't open computer-specific threads
  when only one computer is involved"). Rejected on the model, not on budget:
  thread delivery is governed by conversation membership and follower state,
  neither of which has a computer dimension (`computer=` is a property of each
  message), so a computer-keyed thread would promise a locality the system cannot
  implement. The settled model (shiki, 2026-08-06) is that locality-first work
  remains a legitimate *means* — a focused thread keeps one computer's iteration
  off the main line and reduces cross-machine spectating of intermediate states —
  but a thread is never the isolation container, which is why `### Cross-computer
  work` prescribes boundary reporting and mentions a thread only as an option.
- **Implementation mechanics.** Wake-up cost of a thread reply, the follower
  table, delivery fan-out (shiki, 2026-08-06: agents need not perceive that
  opening a thread is not free). The prompt states observable behavior; the
  mechanism lives in code and here.
- **"Agree interfaces and acceptance criteria before local work begins."**
  Real, but the human schedules work decomposition and contract negotiation
  (shiki, 2026-08-06); the prompt does not add a pre-work gate. Acceptance
  criteria already belong to the task definition.
- **Claim-timing refinements** — "an unassigned todo is a candidate, not an
  assignment", "claim only what you start now", "never reserve future work"
  (shiki, 2026-08-06: not added). `### Tasks` Rules 1–5 remain the sole
  authority on claiming.
- **A standing "re-verify shared state before you assert it" rule.** Drafted as an
  Operating Contract invariant, removed by shiki (2026-08-06). His ruling: "most
  single-computer scenarios do not need this stated." The supporting analysis is
  this review's, not his — the discipline is real, but its trigger is a shared
  working tree, so a manual injected into every session pays for it in every turn.
  Verification discipline belongs to each agent's own memory, not to the standing
  contract. Anyone re-pricing this entry re-does the cost analysis; only the
  ruling is settled.
- **"Coordinates that expire do not belong in durable surfaces."** Removed by
  shiki (2026-08-06) as redundant. Which rules already cover it (this review's
  enumeration): the Operating Contract `computer=` bullet rules when another
  computer's path is usable, and `## Memory` routes commits to git. Restating it
  in the durable-memory section bought a third phrasing of two existing rules.

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
- **This Context field escaping** — `workspaceName` and `sessionTitle` are
  server-side user-controlled text and render through `quotePromptValue`;
  ids and the workspace path render through `inlineCode` (single-line
  collapse + a code-span delimiter longer than any backtick run in the
  value). This Context sits at the very top of the prompt, so an unescaped
  value could forge a runtime-fact bullet (a fake `- Computer:` line) that
  the agent would trust. The Workspace path must always be the local root
  the daemon resolved on the current computer — never a server-side or
  foreign-computer path.

The `renderInjectedFile` `unreadable` branch is also load-bearing: a present-but-
unreadable file renders an explicit error, never the "missing — create one" hint,
so the agent doesn't clobber an existing file.

The Memory Notes Catalog body is also fenced with `pickFence`. Frontmatter and
paths are agent-editable input; they must not be able to escape into top-level
prompt structure. The scanner validates indexed frontmatter, skips symlinks,
and injects metadata only — never note bodies.

## 5. Design principles

- **One home per fact.** Each rule lives in exactly one authoritative section.
  The only sanctioned duplication is the deliberate load-bearing repetition in
  §3. Two homes for one rule is drift — converge it.
- **Transparency / no historical residue.** Describe only the current model.
  No migration history, no "this used to be X", no rationale for removed flags,
  no colloquial filler ("think of yourself as a colleague…"). The prompt is a
  contract, not a changelog.
- **Exact flags defer to `--help`.** The Tool Reference is a command *index*
  (Domain trigger + full subcommand names + which `--help` to read), not a flag
  manual. Every index entry keeps its full command name — never abbreviate
  `silverhand schedule list` to `list`.
- **Command discovery has one source.**
  `packages/shared/src/cli-command-manifest.ts` is the root for the prompt
  index and CLI noun/verb discovery. The CLI binds every manifest entry to a
  concrete implementation, while backend observability derives its route map
  from the resulting CLI groups. Adding a fourth hand-written inventory is a
  design regression.
- **Progressive disclosure is measured.** The first-stage static standing
  manual must stay at or below 14KB UTF-8 in every session scope, with no
  injected role, memory body, note entries, or workspace-index entries. Size is
  an upper bound, not a target to fill: content may be smaller when every
  removed detail has a reachable `--help` or error-hint home. The bound is an
  internal tripwire, not a protocol limit; raising it requires product-owner
  approval. The assertion renders the shipping profile directory (`.`) and
  checks regular-workspace, workspace-less, and agent-scoped sessions
  independently.
- **No "platform" as a generic noun.** It bleeds into agent speech as a verbal
  tic (see known-issues §1). Say "Silverhand" or name the concrete thing.

## 6. Cross-document sync

- **CLI facts ↔ manifest ↔ `docs/cli-system.md`.** Any change to `packages/cli`,
  `packages/shared/src/cli-command-manifest.ts`, agent-facing DTO schemas,
  internal agent routes, task behavior, or `silverhand` command guidance must
  keep `cli-system.md` and the platform prompt in sync *in the same change*. A
  pure prose reorg that changes no command/flag/behavior fact does not require a
  `cli-system.md` edit.
- **Internal memory model ↔ `docs/agent-system-prompt-memory.md`.** The
  **Memory and files** section and injection blocks (`renderInjectedFile`, the
  memory notes catalog, `renderWorkspaceMemoryIndex`) must preserve that
  document's behavior while keeping its implementation vocabulary out of the
  agent-visible manual.
- **Thread delivery/follow semantics ↔ `### Threads` / `### Cross-computer
  work`.** Those sections assume thread delivery is governed by conversation
  membership and follower state — with no computer dimension — that unfollow
  stops only future delivery, that the author of every reply is re-followed, and
  that the thread root's author is therefore unable to leave. If
  `packages/backend/src/services/conversation-message/thread-follow.ts`
  changes any of those, revisit both sections, the announce-then-unfollow order in
  the follow-state guidance, and the exclusion recorded in §3: the absence of a
  computer dimension in membership and follower state is what keeps a computer
  axis out.

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
  that have CLI-flag equivalents; the generated domain-index guard projects
  every manifest command into the prompt. Keep all three.
- **Structure and budget are contracts, not prose locks.** Assert the leading H1,
  complete top-level heading order from §2, and the 14KB upper bound for every
  session scope. Do not
  assert exact paragraph wording.
- **Watch line-wrapping.** The template literal's source line breaks become real
  newlines in the output. A multi-word substring split across a wrap will fail a
  naive `toContain` — either keep the asserted phrase on one source line or make
  the test whitespace-tolerant. Never break a Markdown code span across a source
  line (it renders as `` `silverhand thread\n  follow` ``).

## 8. Authoring checklist

Before landing a platform-prompt edit:

- [ ] Section order still matches §2; identity H1 first, then This Context,
      contract right behind it, references last, injected tail last.
- [ ] No §3 load-bearing content dropped or weakened (or the drop is explicit
      and approved).
- [ ] No §4 security code weakened; its tests still pass.
- [ ] New facts have exactly one home; no synonym/duplicate introduced.
- [ ] No historical residue / colloquial filler / generic "platform".
- [ ] CLI command index entries keep full command names.
- [ ] Command discovery changes originate in the shared manifest, not a parallel
      list.
- [ ] Minimal static prompt remains within the 14KB UTF-8 budget in every
      session scope.
- [ ] `docs/cli-system.md` updated iff a CLI fact changed (§6).
- [ ] No Markdown code span broken across a source line.
- [ ] `pnpm --filter @silverhand/shared typecheck` clean.
- [ ] `./scripts/test.sh --scope backend tests/drivers/platform-prompt.test.ts`
      green; new guards are contract-level (§7).
