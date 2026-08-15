/**
 * The operator-only exit for a refused delivery target (#task:2021 P4-4).
 *
 * `application/delivery-target-resolution.ts` collapses "no such stream" and "not
 * yours" into ONE actor-facing answer, and that collapse is only real if the
 * branch that fired cannot be read off the answer. So the branch leaves HERE
 * instead — through the resolver's `observer` port, whose one production
 * implementation this module is. Nothing in this file is ever returned to a
 * caller; the whole point is that these fields exist only in the log.
 *
 * WARN, NOT INFO, for the same reason as the title/workspace address families:
 * `~/.silverhand/logs` runs at `warn` by default, so an `info` line is not on
 * disk at all and the refusal account would exist only in a level nobody runs.
 * Bounded by construction — a refusal is an address a caller got wrong, not
 * per-message traffic, and the one member of this family that IS unbounded (the
 * `#conv:` rendering fallback on the header read surface) is aggregated per
 * window by `WorkspaceAddressFallbackWindow` rather than logged per event.
 *
 * WHAT THE LINES CARRY. The branch, the intent, the principal's stable id, and
 * the address as a HASH. Never the address itself: the readable form
 * `#<workspace>/<title>` is user prose — two display names an operator has no
 * need to read out of a log — and a refused address is
 * routinely a name the caller was NOT authorized to resolve, so echoing it would
 * put an unauthorized probe's own guess in the operator's file. The hash is still
 * a correlation handle: repeated refusals of one address, and "the token this
 * agent kept retrying is the token that agent published", both survive folding.
 * The thread suffix is hashed with the rest — it is part of the token the caller
 * spelled, and splitting it out would make the correlation handle depend on
 * whether the address happened to name a cluster.
 *
 * `snake_case`, like the other two address families, because these lines are read
 * by people and by `jq`.
 */
import { createHash } from 'node:crypto';
import type { BackendLogger } from '../context.js';
import type {
  DeliveryTargetObserverPort,
  DeliveryTargetRefusalReport,
} from '../application/delivery-target-resolution.js';

export interface DeliveryTargetRefusedEvent {
  readonly delivery_target_event: 'refused';
  readonly code: DeliveryTargetRefusalReport['code'];
  readonly operator_reason: DeliveryTargetRefusalReport['operatorReason'];
  readonly intent: DeliveryTargetRefusalReport['intent'];
  readonly principal_id: string;
  readonly address_hash: string;
}

/** Correlation token for a refused address. Version-prefixed so a future
 *  hashing-policy change is explicit rather than a silent break in correlation,
 *  and folded on the RAW received bytes so two spellings of one stream stay
 *  distinguishable — the caller's exact token is what a retry loop repeats. */
export function hashDeliveryAddress(address: string): string {
  return `sha256:${createHash('sha256').update(address, 'utf8').digest('hex').slice(0, 24)}`;
}

export function logDeliveryTargetRefused(
  logger: BackendLogger,
  report: DeliveryTargetRefusalReport,
): void {
  const fields: DeliveryTargetRefusedEvent = {
    delivery_target_event: 'refused',
    code: report.code,
    operator_reason: report.operatorReason,
    intent: report.intent,
    principal_id: report.principalId,
    address_hash: hashDeliveryAddress(report.address),
  };
  logger.warn(fields, `delivery target refused: ${report.operatorReason}`);
}

/**
 * The observer port, bound to a logger.
 *
 * A factory rather than a free function so a surface WIRES the operator exit
 * (the port is required, not optional) and cannot accidentally satisfy it with a
 * no-op it wrote inline.
 */
export function deliveryTargetObserver(
  logger: BackendLogger,
): DeliveryTargetObserverPort {
  return {
    refused: report => logDeliveryTargetRefused(logger, report),
  };
}
