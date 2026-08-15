/**
 * The CLI half of `--target`: the POLICY axis of #task:2021 P4-4.
 *
 * Grammar lives in `@silverhand/shared` and resolution lives in the backend. What
 * belongs here is the third axis and nothing else — whether a door needs an
 * address at all, and what a missing one says. It is one module rather than a
 * helper per command because the ANSWER must not vary: every single-stream door
 * refuses with the same `target_required` subkind and the same one correction, so
 * a daily report buckets them together and an agent that learned the rule on
 * `message send` already knows it on `task create`.
 */
import {
  NAMED_STREAM_ADDRESS_PREFIX,
  formatUntrustedConversationAddress,
  parseDeliveryTargetInput,
} from '@silverhand/shared';
import { CliError } from './errors.js';
import type { CliEnv } from './env.js';

/** What a door calls itself, and why it cannot guess (the sentence the agent
 *  reads). `command` is the full invocation, e.g. `silverhand task create`.
 *
 *  `flag` names the one that carries the address, and defaults to `target` —
 *  every door whose OPERATION is the address uses that name. A door whose
 *  address is a business VALUE instead keeps its own name (`schedule create
 *  --target-conversation`: the value is which conversation gets woken, not where
 *  the create acts), and the refusal is otherwise identical, subkind included,
 *  because the policy being taught is the same one. */
export interface TargetDoor {
  command: string;
  because: string;
  flag?: string;
}

/**
 * `--target` is required, on every door that acts on ONE stream (#task:2021 P4-4).
 *
 * This half of the gate is local knowledge and nothing else: there is no ambient
 * destination, so a missing flag is decidable without asking anyone. What the
 * address DENOTES is never decided here — that is the resolver's, and the raw
 * token travels verbatim so the resolver sees exactly what the actor spelled.
 *
 * `correct_target` is the correction, not decoration: an agent that omitted the
 * flag is almost always acting on the stream it was woken in, and the id form of
 * its own conversation is the one address that is always spellable. It goes
 * through {@link formatUntrustedConversationAddress} because the id arrives from
 * the environment — an unspellable one comes back verbatim after the prefix rather
 * than throwing here, where the actor's actual problem is the missing flag.
 *
 * There is exactly ONE kind of correction, and only a ConversationSlot has it: a
 * singleton stream the caller inhabits. An AgentSlot is woken in no stream — its
 * route came from `--route-conversation-id`, a transport anchor that may well be
 * an agent inbox no one can post to — so the refusal carries no `correct_target`
 * at all rather than inventing a destination out of the credential's path. The
 * flag is equally required either way; only the correction is conditional.
 */
export function requireTargetFlag(
  raw: string | undefined,
  env: Pick<CliEnv, 'conversationId' | 'slot'>,
  door: TargetDoor,
): string {
  if (raw !== undefined && raw.length > 0) return raw;
  const flag = door.flag ?? 'target';
  const ownStream =
    env.slot === 'conversation'
      ? formatUntrustedConversationAddress(env.conversationId)
      : null;
  throw new CliError({
    code: 'validation_error',
    subkind: 'target_required',
    message:
      `${door.command} requires --${flag}: ${door.because} Copy the ` +
      '`target=` token from the message you are answering' +
      (ownStream === null
        ? ', or pass the id form of the stream you mean — e.g. ' +
          `--${flag} '#conv:<conversation_id>'`
        : `, or pass the id form of a stream — e.g. --${flag} '${ownStream}'`),
    retriable: false,
    details: {
      flag,
      ...(ownStream === null ? {} : { correct_target: ownStream }),
    },
  });
}

/**
 * The flag, plus a grammar check — for a door whose next step cannot be taken
 * back.
 *
 * The extra check is bought by SIDE EFFECTS, not by authority. `message send`
 * blocks on `readAllStdin()` (an inherited never-closing pipe would hang forever)
 * and may upload an oversized body as an attachment before any send is attempted;
 * `task create` reads its body from the same pipe. So a target that could never
 * land must fail before stdin is touched. `message history` has no such step,
 * which is why it uses {@link requireTargetFlag} alone and lets the resolver
 * answer once, rather than paying for a second local opinion that buys nothing.
 *
 * Even here it is not a second grammar opinion: the check IS the shared parser
 * (`delivery-target.ts`), so it cannot disagree with the resolver's, and it is
 * deliberately the ONLY thing checked — whether the addressed stream exists, is
 * writable, or is one this agent may act in is the resolver's verdict.
 */
export function requireAddressBeforeSideEffects(
  raw: string | undefined,
  env: Pick<CliEnv, 'conversationId' | 'slot'>,
  door: TargetDoor,
): string {
  const target = requireTargetFlag(raw, env, door);
  if (parseDeliveryTargetInput(target) === null) {
    const flag = door.flag ?? 'target';
    throw new CliError({
      code: 'validation_error',
      subkind: 'target_malformed',
      message:
        `--${flag} is not an address. Use \`#conv:<conversation_id>\`, ` +
        `\`${NAMED_STREAM_ADDRESS_PREFIX}<workspace>/<title>\`, or ` +
        '`dm:@<handle>`, optionally followed by ' +
        '`/thread:<root_message_id>`. The retired `channel` and ' +
        '`thread:<message_id>` spellings named a stream only relative to the ' +
        'sending conversation and are no longer accepted.',
      retriable: false,
      details: { flag, value: target },
    });
  }
  return target;
}
