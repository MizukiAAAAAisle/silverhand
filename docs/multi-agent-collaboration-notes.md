# Multi-Agent Collaboration Notes

Descriptive notes from discussion of multi-agent collaboration mechanics in shared
workspaces. This document records observations, definitions, and trade-off
observations identified during the conversation. It does **not** propose
silverhand-specific designs or default policies; those are deferred to subsequent
rounds.

Sources referenced:

- `docs/inbox-msg-draft.md` — original AX framing article.
- `@slock-ai/daemon@0.54.1` — reference implementation studied by reading the
  published npm package.

## 1. Problem framing

### 1.1 Asymmetry between humans and agents

As stated in `inbox-msg-draft.md`: humans have continuous ambient presence in
shared rooms; agents are turn-based snapshot consumers. Many failure modes
observed in multi-agent rooms — duplicate replies, stale replies, missed
plan-changes — trace back to this asymmetry.

### 1.2 The four AX questions (from `inbox-msg-draft.md`)

- What does the agent see at the moment of action?
- What state does it carry between calls?
- What can it recover from?
- What is it allowed to decide?

### 1.3 Failure modes documented in the source article

- **Attention overload** — busy rooms flood agent working context.
- **Stale replies** — room moves while agent reasons.
- **Lost agency under @-mention-only filtering** — agents become passive tools
  rather than peers.
- **Concurrent send** — multiple agents commit overlapping replies.

## 2. Human vs agent collaboration — differences relevant to design

1. **Continuous presence vs turn-based snapshot.** Humans maintain ambient
   awareness without dedicated attention; agents perceive only at wake / tool
   boundaries.
2. **Cost of attention.** Human glance is sub-second and effectively free;
   agent glance is a tool round-trip plus LLM inference plus context
   displacement.
3. **Ambient memory.** Humans retain background of chat they were not actively
   reading; agents only remember messages loaded into working context. "I told
   you yesterday" is not enforceable against an agent unless the message is in
   its current context.
4. **Implicit relevance.** Humans pick up "this affects me" without explicit
   cues; agents read literal text and need structural or explicit anchors.
5. **Cost of interruption.** Humans context-switch cheaply; agents may displace
   working state and pay tokens to recover.
6. **Social norms.** Humans share accountability conventions ("you should have
   seen that"); agents only know what's in their loaded context.
7. **Addressing surface.** Humans use names, pronouns, eye contact, physical
   proximity; agents have only explicit textual channels.
8. **Enforceability of rules.** Agent-side rules can be enforced 100% via
   policy / runtime; human-side rules drift over time and across users.

## 3. slock implementation as studied (`@slock-ai/daemon@0.54.1`)

### 3.1 Delivery model

- **Wake / idle**: incoming messages are pushed to agent stdin in full body via
  `formatIncomingMessage()` (format:
  `[target=… msg=… time=… type=…] @sender: content`).
- **Busy**: messages accumulate in `ap.inbox`. After a 3-second aggregation
  window, the agent receives a single notification of the form
  `You have N pending inbox messages. Call check_messages...`. Bodies are not
  injected during busy state.
- **Pull**: `slock message check` (CLI) calls `/receive`, retrieves pending
  bodies, and formats them for the agent on demand.

### 3.2 Held-draft mechanism

- The daemon's agent-API proxy at `/internal/agent-api/send` performs a
  freshness check before committing the send.
- On freshness mismatch, the response returns `state: held` along with a
  bounded `heldMessages` array containing newer messages since the agent's
  draft point.
- The CLI receives the `held` response and persists the original send content
  as a local draft.
- The agent has four documented paths after a hold:
  - **revise** — write new content for the current room state.
  - **send-as-is** — resubmit unchanged via `send-draft`; may be held again.
  - **stay silent** — let the draft expire.
  - **`--anyway`** — explicit bypass of the freshness check.

### 3.3 Engineering observations from the slock code path

- The freshness check semantically functions as optimistic concurrency control
  — a compare-and-swap (CAS) on conversation seq.
- The check must execute inside the server insert transaction. If performed
  outside the transaction (e.g., as a daemon-side pending-context check),
  concurrent drafts from multiple agents can all pass the check before any of
  them commits, defeating the guarantee.
- "Room changed" in slock's implementation is defined as: any new message
  exists in the target conversation since the `seenUpToSeq` carried by the
  send.

## 4. Mechanism concepts identified during discussion

### 4.1 @-mention as primary addressing rule

**Concept.** Any message containing strict `@<handle>` syntax targeting a
participant counts as "directly addressed". Addressed participants — human or
agent — are expected to perceive and process the message. Symmetric across
humans and agents.

**Recorded limitations of pure @-only:**

- Plan changes affecting a busy agent often occur in conversation that does
  not explicitly @ the agent. The sender frequently does not realise the agent
  lacks ambient awareness.
- Group decisions ("@team, deprecate X") affect non-mentioned individuals
  working on X.
- System events (task status changes, schedule fires, etc.) have no human
  sender and no @ form.
- Naming normalization is unspecified: strict `@<handle>` only, or also
  display-name occurrences, case variants, natural-language references
  ("Cindy 你看一下")?

### 4.2 Structural relevance flags

**Concept.** Non-semantic, server-computable markers attached to incoming
messages, denoting structural relationship to the agent's current work context.
The intent is to surface relevance without requiring the agent (or platform)
to perform semantic reasoning.

**Flag candidates identified:**

- `mentions_me` — strict `@<handle>` for the recipient agent.
- `references_current_task` — message references a task currently claimed by
  the recipient agent.
- `is_system_event` — message is a structured system event (task status,
  schedule fire, etc.).
- `sender_is_active_collaborator` — sender has interacted with the recipient
  agent in the same conversation within a recent time window.
- natural-language name presence — recipient's name appears in body without
  strict `@` syntax.

**silverhand-specific note.** Because each `(conversation, agent)` is an
independent runtime that only sees its own conversation's messages,
"in_current_conversation" is implicit and is not a flag. Cross-conversation
relevance requires explicit anchoring (mention, task reference, explicit
handoff via `--target parent` etc.).

### 4.3 Three-tier read primitive

**Concept.** Agents perceive incoming messages at three depths, ordered by
cost:

1. **Pressure signal / count envelope** — system-pushed, near-zero token cost.
   Conveys aggregate counts and high-level relevance breakdown (e.g.,
   "5 pending, 2 high-relevance") without message bodies.
2. **Glance card** — agent-pulled, mid cost. Per-message structured triage
   view (see §4.4).
3. **Full body** — agent-pulled, full cost. Retrieved on demand via existing
   history / receive primitives.

### 4.4 Glance card

**Concept.** A bounded, structured representation of a single pending message,
sized for triage decisions without paying full-body context cost.

**Components identified:**

- `msg_id`, `time`, `sender`, `target`.
- First sentence or N-character snippet of content.
- Structural relevance flags from §4.2.

**Distinct from:**

- **Full-body push** — too expensive in busy rooms.
- **Pure count notification** — insufficient for triage; reports "something
  happened" but not "what".
- **Meta-header-only push** — semantically equivalent to forcing the agent to
  pull the body before any decision can be made; no actual savings, since the
  body is required for relevance judgement.

### 4.5 Safe-checkpoint poll

**Concept.** Agent reads inbox glance at natural reasoning boundaries rather
than at every turn or wake.

**Boundaries identified during discussion:**

- After completion of a long tool sequence.
- Before commit / before producing a visible side effect.
- After N elapsed minutes since last poll.
- At explicit task transition points.

**Hybrid composition.** System pushes a cheap pressure signal continuously;
the agent decides cadence and depth of expansion. Pure agent-poll without a
pressure signal risks the agent forgetting to glance during long tool
sequences; pure system-push of full bodies risks the original attention-overload
problem.

### 4.6 Held-draft / freshness CAS

**Concept.** Optimistic concurrency control on conversation seq. Each send
carries `seenUpToSeq` — the latest seq the agent saw when drafting. Server
compares against current seq inside the insert transaction; on mismatch, the
send is rejected, the draft is held, and bounded newer-context is returned to
the agent.

**Engineering constraint.** The check must execute inside the server insert
transaction. Agent-side or daemon-side checks have race windows where multiple
concurrent drafts pass the check before any commits.

**Four agent-facing paths after a hold (from slock):**

- `revise` — write new content for current state.
- `send-as-is` — resubmit unchanged; may be held again.
- `stay silent` — let draft expire.
- `--anyway` — explicit bypass.

### 4.7 Hard-hold vs soft-stale-notice

**Concept.** Two orthogonal primitives for handling potentially-stale sends:

- **`hard_hold`** — server rejects the insert when seq mismatches; draft is
  saved/returned with bounded newer context; agent must re-evaluate before any
  send commits.
- **`soft_stale_notice`** — server commits the insert; the response carries a
  "N new messages since your `seenUpToSeq`" notification; agent decides
  whether to follow up.

The two primitives can be selected per send (e.g., by message kind, declared
intent, conversation policy).

## 5. Cost / trade-off observations

### 5.1 Counting-game analysis

The source article claims that, in a slock-equipped room, 5 agents can count
upward to 20 without orchestration, attributing the result to inbox + held-draft.

**Observed mechanism (analysis):**

- All N agents may simultaneously draft "1". Held-draft does not prevent
  concurrent drafting.
- The first send to reach the server commits. The other N-1 sends are held
  with "A said 1" as bounded newer context.
- Each held agent revises to "2"; one wins; N-2 are held; and so on.
- Convergence requires N rounds, with on the order of O(N²) total
  drafted-then-held cycles.

**Observation.** Convergence depends on the property that the "next correct
action" is fully determined by room state (counting → look at largest, add 1).
For task shapes where the correct action for losers is "stay silent" — e.g.,
"the agent who knows X should answer; others stand down" — held-draft does not
bias toward silence. `revise` and `stay silent` are co-equal paths in slock's
protocol; the choice is left to the agent.

### 5.2 Token cost in busy rooms

Held-draft cost is proportional to room contention.

- **Low-contention** conversations (DM, focused threads): holds are rare.
- **High-contention** multi-agent channels: any visible send may be held by
  intervening unrelated chatter, causing repeated re-draft cycles.

### 5.3 Freshness-scope spectrum

The "what counts as a room change" axis controls aggressiveness:

- **Widest** — any new message in the target conversation. Simple, no
  relevance judgement, high false-positive rate in busy rooms.
- **Narrower** — only messages with structural relevance (mentions, task refs,
  source-message references). Lower false-positive, requires structural
  relevance computation.
- **Narrowest** — only changes to specific anchored content declared by the
  send. Minimal hold rate, requires per-send reference declaration.

### 5.4 Failure modes of held-draft

- **O(N²) wasted cycles** when many agents draft concurrent overlapping
  content.
- **Tie-break by first-arrival.** Determined by network and scheduling, not by
  semantic correctness or appropriateness.
- **`--anyway` bypass.** Any agent that uses `--anyway` during contention
  breaks the optimistic-lock guarantee for that round.
- **Starvation of slow agents.** Persistent freshness-race losers
  (high-latency models, late-arriving busy agents) can be starved.
- **No silence bias.** Held-draft protocol does not, by itself, bias toward
  "stay silent" when silence is the correct action.

## 6. Open questions

Recorded during discussion, not resolved:

- What naming-normalization rules define "explicit @"? (Strict `@<handle>`
  only, or also display-name occurrences, natural-language references?)
- For multi-recipient or system-event messages, what subscription model
  handles relevance without explicit `@`?
- For long-running tasks, when is a "safe checkpoint" — agent-self-determined
  or system-imposed?
- How are "active collaborator" and "current work scope" computed, scoped, and
  updated?
- Where does `--anyway` make sense in production, vs being disabled by policy?
- What metrics best characterize whether a held-draft / glance / poll
  mechanism is improving or degrading collaboration in practice?
- How does idempotency (e.g., TTL fingerprint, idempotency key) interact with
  freshness CAS? They address different failure modes (replay vs staleness)
  and need to be reasoned about independently.

---

**Document scope.** Descriptive only. Definitions and observations recorded
above may be referred to as shared vocabulary in subsequent design rounds.
This document does not propose silverhand implementations or default policies.
