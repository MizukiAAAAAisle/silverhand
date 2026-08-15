/**
 * The AgentSlot RUNTIME-SCOPE BANNER — the transport prefix the daemon puts in
 * front of a delivery to an agent-scoped session (`daemon/supervisor`), one
 * layer below the stdin message header:
 *
 *     [runtime_scope=agent target=#conv:<id> workdir="<path>"]
 *
 *     [msg_id=… sender=… target=<absolute address> time=…]
 *
 * Two carriers, two jobs, and conflating them is the expensive mistake. The
 * header's `target=` is the ABSOLUTE address of the stream — a destination, in
 * the grammar every write surface accepts, and possibly a readable name or a
 * per-viewer `dm:@handle`. The banner's `target=` is a TRANSPORT ROUTE: the
 * conversation id an AgentSlot has to hand back as `--route-conversation-id`
 * because it has no ambient conversation of its own. An agent that mines the
 * route id out of the header is right only by luck (only the `#conv:` spelling
 * survives it), and an agent that replies to the banner's id has thrown away the
 * reply cluster.
 *
 * This module exists so that grammar has ONE authority. It was an inline
 * template literal in the supervisor, while `platform-prompt.ts` spelled the
 * same shape in prose for the agent to read — two artifacts that can disagree
 * without either erroring, the delivery simply landing wherever the agent
 * guessed. Now the prompt is BUILT from the formatter, so a change to the
 * banner cannot leave the teaching behind.
 *
 * `target` here reusing the header's word is transitional debt: #task:2030
 * deletes `--route-conversation-id` along with the whole route anchor, and this
 * module goes with it.
 */
import { formatUntrustedConversationAddress } from './delivery-target.js';

/**
 * Renders the banner. `conversationId` arrives over the wire, where the frame
 * schema does not constrain id shape, so the UNTRUSTED codec is deliberate:
 * a compose-time throw would turn a peer's bad coordinate into a dead AgentSlot
 * rather than a routed delivery whose framing quotes exactly what was sent.
 *
 * Also used with PLACEHOLDER arguments to render what the platform prompt
 * teaches, which is what makes the teaching and the wire one artifact.
 */
export function formatAgentRuntimeScopeBanner(
  conversationId: string,
  workdir: string,
): string {
  return (
    `[runtime_scope=agent `
    + `target=${formatUntrustedConversationAddress(conversationId)} `
    + `workdir=${JSON.stringify(workdir)}]`
  );
}

/** The route-id placeholder in {@link TAUGHT_AGENT_RUNTIME_SCOPE_BANNER}. */
export const RUNTIME_SCOPE_BANNER_ROUTE_PLACEHOLDER = '<id>';

/** The workdir placeholder in {@link TAUGHT_AGENT_RUNTIME_SCOPE_BANNER}. */
export const RUNTIME_SCOPE_BANNER_WORKDIR_PLACEHOLDER = '<path>';

/**
 * The banner as the platform prompt spells it for an AgentSlot: the real
 * formatter over placeholders, so substituting real values back in reproduces a
 * real delivery's prefix byte for byte. `platform-prompt.ts` interpolates this
 * rather than re-typing the shape.
 */
export const TAUGHT_AGENT_RUNTIME_SCOPE_BANNER = formatAgentRuntimeScopeBanner(
  RUNTIME_SCOPE_BANNER_ROUTE_PLACEHOLDER,
  RUNTIME_SCOPE_BANNER_WORKDIR_PLACEHOLDER,
);
