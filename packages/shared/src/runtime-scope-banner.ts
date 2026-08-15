/**
 * The AgentSlot RUNTIME-SCOPE BANNER — the per-delivery prefix the daemon puts in
 * front of a delivery to an agent-scoped session (`daemon/supervisor`), one
 * layer below the stdin message header:
 *
 *     [runtime_scope=agent workdir="<path>"]
 *
 *     [msg_id=… sender=… target=<absolute address> time=…]
 *
 * This module exists so that the banner grammar has ONE authority. It was an inline
 * template literal in the supervisor, while `platform-prompt.ts` spelled the
 * same shape in prose for the agent to read — two artifacts that can disagree
 * without either erroring, the delivery simply landing wherever the agent
 * guessed. Now the prompt is BUILT from the formatter, so a change to the
 * banner cannot leave the teaching behind. The banner carries no destination;
 * the message header's absolute `target=` is the only stream address.
 */

/**
 * Renders the banner. Also used with a PLACEHOLDER argument to render what the platform prompt
 * teaches, which is what makes the teaching and the wire one artifact.
 */
export function formatAgentRuntimeScopeBanner(
  workdir: string,
): string {
  return `[runtime_scope=agent workdir=${JSON.stringify(workdir)}]`;
}

/** The workdir placeholder in {@link TAUGHT_AGENT_RUNTIME_SCOPE_BANNER}. */
export const RUNTIME_SCOPE_BANNER_WORKDIR_PLACEHOLDER = '<path>';

/**
 * The banner as the platform prompt spells it for an AgentSlot: the real
 * formatter over placeholders, so substituting real values back in reproduces a
 * real delivery's prefix byte for byte. `platform-prompt.ts` interpolates this
 * rather than re-typing the shape.
 */
export const TAUGHT_AGENT_RUNTIME_SCOPE_BANNER = formatAgentRuntimeScopeBanner(
  RUNTIME_SCOPE_BANNER_WORKDIR_PLACEHOLDER,
);
