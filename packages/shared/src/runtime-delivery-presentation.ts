/**
 * Presentation-only metadata for a single runtime inbox delivery.
 *
 * Custody is tracked by delivery id, but the agent-visible payload is released
 * as an atomic batch.  Keeping the small, already-formatted body fragment and
 * its instruction signal lets the daemon rebuild a canonical payload for the
 * novel remainder of a response-loss retry without turning every normal batch
 * into singleton runtime turns.
 */
export const RUNTIME_DELIVERY_INSTRUCTION_SIGNALS = [
  'user_for_recipient',
  'user_for_other',
  'non_system_mention',
  'system',
  'other',
] as const;

export type RuntimeDeliveryInstructionSignal =
  (typeof RUNTIME_DELIVERY_INSTRUCTION_SIGNALS)[number];

export interface RuntimeDeliveryPresentation {
  /** Canonical message body fragment: meta header + content + attachments. */
  body: string;
  /** Minimal input needed to derive the batch-level reply instruction. */
  instruction: RuntimeDeliveryInstructionSignal;
}

/** Compose one canonical inbox envelope from a selected delivery group. */
export function composeRuntimeDeliveryPresentation(
  entries: readonly RuntimeDeliveryPresentation[],
  sendMessageTool: string,
): string {
  if (entries.length === 0) {
    throw new Error('runtime delivery presentation requires a non-empty batch');
  }
  const header =
    entries.length === 1
      ? 'You have one message waiting since you were last active:'
      : `You have ${entries.length} messages waiting since you were last active (oldest first):`;
  const body = entries.map(entry => entry.body).join('\n\n---\n\n');
  return `${header}\n\n${body}\n\n${composeRuntimeDeliveryInstruction(entries, sendMessageTool)}`;
}

/** Derive the one batch-level instruction from per-message signals. */
export function composeRuntimeDeliveryInstruction(
  entries: readonly RuntimeDeliveryPresentation[],
  sendMessageTool: string,
): string {
  const signals = new Set(entries.map(entry => entry.instruction));
  if (signals.has('user_for_recipient')) {
    return (
      `Respond as appropriate — call \`${sendMessageTool}\` with a brief reply, ` +
      `progress update, blocker question, or final summary before stopping. ` +
      `Complete ALL your work before stopping.`
    );
  }
  if (signals.has('user_for_other')) {
    return (
      `The user message appears addressed to another agent. Do not call ` +
      `\`${sendMessageTool}\` unless you own or were assigned the relevant ` +
      `task, or must flag a concrete blocker. Complete ALL work you choose ` +
      `to take before stopping.`
    );
  }
  if (signals.has('non_system_mention')) {
    return (
      `Respond as appropriate — call \`${sendMessageTool}\` before stopping. ` +
      `Complete ALL your work before stopping.`
    );
  }
  if (entries.every(entry => entry.instruction === 'system')) {
    return (
      `Respond as appropriate. System messages do not require a reply ` +
      `unless they explicitly ask for one.`
    );
  }
  return 'Respond as appropriate.';
}
