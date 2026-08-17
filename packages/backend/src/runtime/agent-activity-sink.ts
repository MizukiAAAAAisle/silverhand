import type { AgentActivitySink } from './event-handler.js';
import { PRESENCE_AWAY_TTL_MS } from '../routes/agents.js';

/**
 * Persistence port the sink needs — the monotonic-max stamp of the durable
 * presence clock, returning the PREVIOUS value so the sink (not the repo) owns
 * the Away→Online policy judgment. `AgentRepo.stampLastActivity` satisfies it.
 */
export interface AgentActivityStampPort {
  stampLastActivity(agentId: string, atMs: number): { previous: number | null };
}

export interface AgentActivitySinkDeps {
  agents: AgentActivityStampPort;
  now: () => number;
  onAwayToOnline: (agentId: string) => void;
}

/**
 * v82 (#task:2049) — durable per-agent presence-clock sink. Stamps
 * `last_activity_at` at admitted runtime-activity edges (parsed event / delivery
 * consumed) with the BACKEND clock and fires the per-viewer
 * `agent_presence_changed` invalidation ONLY on an Away→Online transition.
 *
 * Paul's anti-simplification requirements (VERBATIM intent):
 *
 * (i) Why the trigger is the write-edge Away→Online transition and NOT "first
 *     runtime up": runtime-up fires BEFORE the stamp, so a viewer refetching
 *     then reads the still-past `away_at` and stays Away; it also misses the
 *     "kept running, silent past TTL, then produced" case (there is no
 *     runtime-up edge there at all). The transition is judged at the SAME edge
 *     that writes `last_activity_at`, against the SAME `PRESENCE_AWAY_TTL_MS`
 *     the read face uses, so the fire and the deadline cannot drift. The
 *     negative (no-fire) case is the prev-FRESH cell — continuous activity
 *     within the window fires nothing, so there is no fanout amplification.
 *
 * (ii) The fire condition is the NEGATION of the projection's Online cell,
 *     evaluated on the PRE-stamp state with the backend-now being stamped
 *     (`atMs`) as now. It and the projection MUST stay in sync or a
 *     first-activity Away→Online is silently not pushed. `prev === null` FIRES,
 *     because a never-active agent's `away_at` is null which the projection
 *     renders Away, so its first-ever activity is a real Away→Online crossing —
 *     and with v82's no-backfill (no fabricated deadline) this prev-null case is
 *     the DOMINANT post-deploy transition, not an edge case. Do not "optimize"
 *     it away.
 *
 * (iii) prev read/write atomicity is deliberately NOT locked: the earliest
 *     writer after the Away window necessarily reads the Away `prev` and fires;
 *     the concurrent worst case is a DUPLICATE fire, which is harmless because
 *     the frame is id-only and the consumer only refetches `/presence`
 *     (idempotent). No serialization / row lock.
 */
export class AgentActivitySinkImpl implements AgentActivitySink {
  constructor(private readonly deps: AgentActivitySinkDeps) {}

  stampActivity(agentId: string): void {
    const atMs = this.deps.now();
    const { previous } = this.deps.agents.stampLastActivity(agentId, atMs);
    // Fire = negation of the projection's Online cell on the PRE-stamp state:
    //   prev === null           → Away (never-active, no deadline)  → FIRE
    //   atMs >= prev + TTL       → Away (deadline passed, incl. ==)  → FIRE
    //   atMs <  prev + TTL       → Online (within window)           → no fire
    const wasOnline =
      previous !== null && atMs < previous + PRESENCE_AWAY_TTL_MS;
    if (!wasOnline) {
      this.deps.onAwayToOnline(agentId);
    }
  }
}
