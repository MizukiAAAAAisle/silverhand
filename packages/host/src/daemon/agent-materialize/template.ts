/**
 * D4.d D2: daemon-owned agent-home template content for the
 * `agent_materialize` intent.
 *
 * Design boundary (Cindy D2 pre-gate #1): the daemon — not the
 * backend — owns L1 templates. `packages/backend` MUST NOT import
 * from this file or anywhere under `packages/host/src/daemon/agent-
 * materialize/` (the tripwire test under
 * `packages/backend/tests/dependency-guard-agent-materialize.test.ts`
 * enforces this — it lives in `packages/backend` because that's the
 * package the rule restricts). The daemon is now the SOLE owner of L1
 * templates: the pre-D4.e backend `ensureAgentL1Dir` semantic clone
 * (`packages/backend/src/workspace-files.ts`) was removed in D4.e-5
 * (invariant I6 — backend src holds no agent-host fs/template code). The
 * embedded test fake keeps a test-only clone under
 * `packages/backend/tests/utils/embedded-seed-fixtures.ts`; this module
 * remains the source of truth and its bytes are pinned by the host
 * package's own tests (acceptance A5).
 *
 * What is materialized (design §8.1): system_prompt.md + MEMORY.md
 * + notes/ skeleton + `.materialized` sentinel.
 *
 * Template choice (design §3.1): `'default'` ships at D2;
 * `'onboarding'` and `'minimal'` are placeholders that the handler
 * rejects with `unsupported_template` until they have a concrete
 * template entry here.
 */

/**
 * Bumped only when the on-disk layout changes in a way that
 * pre-existing materialized dirs cannot be re-validated against
 * the new template definition. The sentinel records this number
 * so a re-call against an old layout fails closed with
 * `agent_dir_collision` instead of silently being treated as up
 * to date.
 */
export const AGENT_HOME_TEMPLATE_VERSION = 1;

/** Sentinel filename. Hidden so `ls` of an agent home does not
 *  surface it to humans browsing the dir. */
export const AGENT_HOME_SENTINEL_FILENAME = '.materialized';

const INITIAL_SYSTEM_PROMPT_MD =
  '# Global role\n\n_To be shaped via DM._\n';

const ONBOARDING_GUIDE_MD = `# Silverhand Onboarding Guide

## What Silverhand Is
Silverhand is a desktop app where humans and AI agents collaborate in shared
chat-style workspaces. Agents are persistent teammates: they keep memory, claim
tasks, and hand off work.

Key model:
- **Workspace** — a group of humans and agents sharing context.
- **Channel** — a running conversation inside a workspace; agents run per channel.
- **Thread** — a focused sub-discussion spawned from a channel message.
- **Task** — a claimable work unit tracked on the channel task board.

## Memory Model

- **Identity is global.** \`~/.silverhand/agents/<id>/system_prompt.md\` is
  the only source of who you are, and it applies in every workspace. The
  runtime auto-loads it as the **Initial role** section of your system
  prompt.
- **Workspace memory is local.**
  \`<workspace>/.silverhand/agents/<id>/MEMORY.md\` (auto-loaded as
  **Active Workspace Memory**) plus \`notes/\` describe what is true in
  one workspace.
- **Write by scope.** Global identity / role / working-style guidance from
  the user → update L1 \`system_prompt.md\`. Guidance about this workspace's
  collaboration, tasks, project facts, or work logs → update L2 (MEMORY.md
  / notes/).
- **Current vs reference.** The current workspace's MEMORY.md is auto-loaded;
  other workspaces are paths only — open them only when the task needs
  cross-workspace context.

Do not mention internal file paths to the user unless they ask.

## How to Help a New User Get Started

### Step 1: Establish your role
Start warm and brief. If your role contract is empty (first spawn), name
yourself, say the role is not defined yet, and ask what the user wants you
to mainly do.

Useful prompts:
- "What should I mainly help with — architecture, implementation, review,
  testing, research, or something else?"
- "One sentence is enough; I can refine the role as we work."

Do not give a product tour in the first message. The user needs a clear way to
shape you, not a menu of features.

### Step 2: Save guidance by scope
Decide whether the user's guidance is global identity or workspace-scoped:

- **Global** (who you are, your default style, your responsibilities
  everywhere) → update L1 \`system_prompt.md\`. The next spawn in any
  workspace picks it up.
- **Workspace-scoped** (review pairings, hand-off rules, project facts,
  conventions, work log) → update this workspace's L2 MEMORY.md / notes/.

If the user starts with a real task instead of role guidance, do the task. Let
the role emerge later from explicit instructions or repeated preferences.

### Step 3: End every turn with one next step
Each reply should close with one clear, immediately executable action.
Do not leave the user with a list of options to decide between.

## Collaboration Patterns
- **Claim tasks before substantive work** — prevents duplicate work.
- **Update relevant notes** after meaningful interactions: user preferences
  learned, decisions made, work completed. Update MEMORY.md only when the
  Key Knowledge index or current active handoff changes — not after every
  task.
- **Keep global identity in L1**, workspace collaboration in L2.

## Onboarding Behavioral Rules
- Do not optimize for reply count. Optimize for first useful action.
- Be concise; expand only when the user asks.
- If the user's request is outside current capabilities, pivot immediately to
  the nearest useful alternative — do not dwell on limitations.
- Channel silence is not failure. If the user is active elsewhere, follow
  the work there.
`;

const ONBOARDING_FAQ_MD = `# Silverhand Onboarding FAQ

Reference answers to common user questions.
Understand the core idea and guardrail for each item, then answer in your own
words based on the user's context. Do not copy these answers verbatim.

## FAQ 1: What is Silverhand? What can agents do here?
### Answer idea
- Silverhand is a desktop workspace where you work with persistent AI agents
  in shared channels — like a team chat, but agents are real collaborators.
- Agents keep memory, claim tasks, and hand off work to each other.
### Next step
- Ask what the user is working on and propose a starter setup.
### Guardrail
- One differentiator, then move to the user's actual work immediately.

## FAQ 2: How do channels, threads, and tasks work?
### Answer idea
- Channels are workstreams. Threads are focused discussions tied to a message.
  Tasks are claimable work units with status tracking.
- Common pattern: post work in channel → convert to task → agent claims it →
  progress in task's thread → mark in_review → user approves.
### Next step
- Help the user create their first channel and send their first task message.
### Guardrail
- These are tools, not rules. Match to the user's actual workflow.

## FAQ 3: How do I add agents to a workspace or channel?
### Answer idea
- Agents are created from the Agents section (People tab → + button).
- Once created, add them to channels during channel creation or via Channel
  Settings → Members.
### Next step
- Give the user a copyable agent name and role description, then guide them to
  the + button.
### Guardrail
- Do not imply you created an agent unless it actually happened.

## FAQ 4: How does agent memory work?
### Answer idea
- Each agent keeps MEMORY.md and a notes/ folder that persist across restarts.
- Agents update their notes proactively after meaningful interactions.
- Users can explicitly ask an agent to remember something important.
### Next step
- If the user wants to check what an agent knows, suggest asking the agent
  directly or asking it to show its memory/notes.
### Guardrail
- Do not promise perfect recall; important items should be explicit in notes.

## FAQ 5: Agent not responding or seems stuck
### Answer idea
- Could be a long-running task, a spawn/connection issue, or context pressure.
- Try @mentioning the agent to prompt a response.
### Next step
- Ask the user to @mention the agent and describe what they were doing last.
### Guardrail
- Acknowledge the friction directly; do not blame the user.

## FAQ 6: Why use multiple agents?
### Answer idea
- Agents handle one major task at a time; multiple agents parallelize work.
- Different agents can have different specializations — these emerge naturally.
- A common starter: 2–3 general agents; let roles emerge through real work.
### Next step
- Ask for 2–3 recurring work types and map each to an agent.
### Guardrail
- Start simple. Unspecialized start is valid; avoid over-scaling early.
`;

const USER_PREFERENCES_MD = `# User Preferences

Record durable preferences that should shape future work.

Examples:
- Communication style and language preferences.
- Coding, testing, and review conventions the user repeats or corrects.
- Product and design preferences that apply across tasks.

Keep this file concise. Prefer editing existing bullets over appending duplicates.
`;

const PROJECT_MD = `# Project Notes

Record durable project context and architecture facts.

Examples:
- Tech stack, important modules, and ownership boundaries.
- Stable terminology and data-model decisions.
- Invariants or guardrails that future work must preserve.

Keep transient task status in work-log.md instead.
`;

const WORK_LOG_MD = `# Work Log

Record significant completed work, decisions, and follow-ups.

Use this for detail that would make MEMORY.md too large:
- What changed and why.
- Verification commands or evidence.
- Follow-up risks that are not active blockers.

Keep entries compact and merge related updates when a task iterates.
`;

const INITIAL_MEMORY_MD = [
  '# Memory',
  '',
  'Role source: system_prompt.md (already loaded by runtime; do not duplicate the role contract here).',
  '',
  '## Key Knowledge',
  '- Read [notes/onboarding-guide.md](notes/onboarding-guide.md) for Silverhand workspace patterns and onboarding guidance',
  '- Read [notes/onboarding-faq.md](notes/onboarding-faq.md) for common user questions and reference answers',
  '- Read [notes/user-preferences.md](notes/user-preferences.md) for durable user preferences',
  '- Read [notes/project.md](notes/project.md) for durable project context and invariants',
  '- Read [notes/work-log.md](notes/work-log.md) for significant work history and follow-ups',
  '',
  '## Active Context',
  '_Keep only the current handoff here. Detailed history belongs in notes/work-log.md._',
  '',
].join('\n');

/**
 * One template entry. `relPath` is relative to `agent_dir` and
 * uses POSIX separators; the handler joins via `node:path`.
 */
export interface AgentHomeTemplateFile {
  relPath: string;
  content: string;
}

export interface AgentHomeTemplate {
  /** Stable identifier matching `template_choice` on the wire. */
  name: string;
  /** Directories that must exist (created with `mkdir -p`). */
  dirs: string[];
  /** Files to write atomically. Existing files at these paths are
   *  treated as foreign content unless the sentinel matches; the
   *  handler decides. */
  files: AgentHomeTemplateFile[];
}

const DEFAULT_TEMPLATE: AgentHomeTemplate = {
  name: 'default',
  dirs: ['notes'],
  files: [
    { relPath: 'system_prompt.md', content: INITIAL_SYSTEM_PROMPT_MD },
    { relPath: 'MEMORY.md', content: INITIAL_MEMORY_MD },
    { relPath: 'notes/onboarding-guide.md', content: ONBOARDING_GUIDE_MD },
    { relPath: 'notes/onboarding-faq.md', content: ONBOARDING_FAQ_MD },
    { relPath: 'notes/user-preferences.md', content: USER_PREFERENCES_MD },
    { relPath: 'notes/project.md', content: PROJECT_MD },
    { relPath: 'notes/work-log.md', content: WORK_LOG_MD },
  ],
};

/**
 * Resolve `template_choice` → template definition, or `null` if
 * the choice is structurally valid (passed wire schema) but does
 * not yet have a host-side template entry. The handler maps
 * `null` to the typed wire error `unsupported_template`.
 *
 * D2 ships `'default'` only. `'onboarding'` / `'minimal'` are
 * reserved in the wire enum for future cuts; returning `null`
 * lets the wire schema stay forward-compatible without the
 * daemon silently substituting `'default'` for them.
 */
export function getAgentHomeTemplate(
  choice: string,
): AgentHomeTemplate | null {
  switch (choice) {
    case 'default':
      return DEFAULT_TEMPLATE;
    case 'onboarding':
    case 'minimal':
      return null;
    default:
      return null;
  }
}

/**
 * D4.e-3 — the L2 (per-workspace) seed template: the SAME content as the
 * agent-home (L1) template MINUS `system_prompt.md`. `system_prompt.md`
 * is L1-ONLY — it is the agent's global identity, read from
 * `~/.silverhand/agents/<id>/system_prompt.md` at every spawn. Copying it
 * into an L2 dir would create stale per-workspace forks that drift from the
 * canonical L1 identity (the historical bug the L1/L2 split fixes). So
 * L2 carries only `MEMORY.md` + `notes/`.
 *
 * Derived from the L1 template (not a second copy of the strings) so the
 * onboarding content stays single-sourced; the ONLY structural difference
 * is the dropped `system_prompt.md` entry. Returns `null` for the same
 * unsupported choices as {@link getAgentHomeTemplate} (the handler maps
 * `null` → `unsupported_template`).
 */
export function getAgentL2Template(choice: string): AgentHomeTemplate | null {
  const l1 = getAgentHomeTemplate(choice);
  if (l1 == null) return null;
  return {
    ...l1,
    files: l1.files.filter(f => f.relPath !== 'system_prompt.md'),
  };
}
