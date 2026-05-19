import { promises as fs } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Onboarding seed note content
// ---------------------------------------------------------------------------

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

## Memory Model (four-file)

- **Identity is global.** \`~/.silverhand/agents/<id>/system_prompt.md\` is
  the only source of who you are, and it applies in every workspace. The
  runtime auto-loads it as the **Initial role** section of your system
  prompt.
- **Workspace memory is local.**
  \`<workspace>/.silverhand/agents/<id>/MEMORY.md\` (auto-loaded as
  **Active Workspace Memory**) plus \`notes/\` describe what is true in
  one workspace; \`<workspace>/.silverhand/CONSENSUS.md\` is the rules
  every member of that workspace must respect.
- **Write by scope.** Global identity / role / working-style guidance from
  the user → update L1 \`system_prompt.md\`. Guidance about this workspace's
  collaboration, tasks, project facts, or work logs → update L2 (MEMORY.md
  / notes/ / CONSENSUS.md).
- **Current vs reference.** The current workspace's MEMORY.md and CONSENSUS
  are auto-loaded; other workspaces are paths only — open them only when
  the task needs cross-workspace context.

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
  conventions, work log) → update this workspace's L2 MEMORY.md / notes/
  or, for rules every member must respect, propose an update to
  CONSENSUS.md.

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

const SEED_NOTES = [
  ['onboarding-guide.md', ONBOARDING_GUIDE_MD],
  ['onboarding-faq.md', ONBOARDING_FAQ_MD],
  ['user-preferences.md', USER_PREFERENCES_MD],
  ['project.md', PROJECT_MD],
  ['work-log.md', WORK_LOG_MD],
] as const;

async function seedNotesIfMissing(notesDir: string): Promise<void> {
  await fs.mkdir(notesDir, { recursive: true });
  // Seed onboarding and memory notes if not already present. These give agents
  // a concrete knowledge skeleton from day 1 while preserving agent edits.
  for (const [noteName, content] of SEED_NOTES) {
    const dst = join(notesDir, noteName);
    try {
      await fs.access(dst);
    } catch {
      await fs.writeFile(dst, content);
    }
  }
}

/**
 * Initialize a workspace directory's `.silverhand/` skeleton:
 *   <workspace>/.silverhand/CONSENSUS.md
 *   <workspace>/.silverhand/agents/
 *
 * Idempotent: safe to call on existing directories.
 */
export async function initWorkspaceDir(workspacePath: string): Promise<void> {
  await fs.mkdir(workspacePath, { recursive: true });
  const dotDir = join(workspacePath, '.silverhand');
  await fs.mkdir(join(dotDir, 'agents'), { recursive: true });
  const consensusPath = join(dotDir, 'CONSENSUS.md');
  try {
    await fs.access(consensusPath);
  } catch {
    await fs.writeFile(
      consensusPath,
      '# Workspace Consensus\n\n_Add only agreements that ALL members must respect. Keep under 2KB._\n',
    );
  }
}

/**
 * Seed L2 (per-workspace per-agent) directory for `<workspace>/.silverhand/
 * agents/<agent-id>/`. The directory carries this workspace's MEMORY.md,
 * notes/, and (eventually) work logs — i.e. the **workspace-scoped**
 * memory.
 *
 * **Important**: `system_prompt.md` is L1-only and is NOT seeded here.
 * The role contract is read from `~/.silverhand/agents/<id>/system_prompt.md`
 * by the system-prompt assembler at every spawn. Copying it here would
 * create stale L2 forks that drift from the canonical L1 identity (the
 * historical bug this design fixes).
 */
export async function seedAgentL2(params: {
  workspacePath: string;
  agentId: string;
}): Promise<void> {
  const l2Dir = join(params.workspacePath, '.silverhand', 'agents', params.agentId);
  const notesDir = join(l2Dir, 'notes');
  await seedNotesIfMissing(notesDir);

  const memoryPath = join(l2Dir, 'MEMORY.md');
  try {
    await fs.access(memoryPath);
  } catch {
    await fs.writeFile(memoryPath, INITIAL_MEMORY_MD);
  }
}

/** Ensure agent L1 directory exists (`~/.silverhand/agents/<id>/`). */
export async function ensureAgentL1Dir(agentL1Dir: string): Promise<void> {
  await fs.mkdir(agentL1Dir, { recursive: true });
  await seedNotesIfMissing(join(agentL1Dir, 'notes'));
  for (const [filename, body] of [
    ['system_prompt.md', '# Global role\n\n_To be shaped via DM._\n'],
    ['MEMORY.md', INITIAL_MEMORY_MD],
  ] as const) {
    const path = join(agentL1Dir, filename);
    try {
      await fs.access(path);
    } catch {
      await fs.writeFile(path, body);
    }
  }
}
