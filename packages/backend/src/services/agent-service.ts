import type {
  AgentRow,
  AgentDto,
  SwitchAgentRuntimeInput,
  UpdateAgentInput,
} from '@silverhand/shared';
import {
  reasoningEffortValidForRuntime,
  runtimeSupportsFastMode,
  validateAvatarFile,
} from '@silverhand/shared';
import type { BlobFileStorage } from '../storage/blob-file-storage.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';
import { AgentRepo } from '../repos/agent-repo.js';

/**
 * Domain-typed errors so the route layer can map cleanly to HTTP. The
 * shape mirrors `UserServiceError` (avatar lifecycle reuses the shared
 * error codes from `validateAvatarFile`).
 */
export class AgentServiceError extends Error {
  constructor(
    public readonly code:
      | 'agent_not_found'
      | 'reasoning_effort_invalid_for_runtime'
      | 'fast_mode_invalid_for_runtime'
      | 'avatar_too_large'
      | 'avatar_unsupported_type'
      | 'avatar_missing'
      | 'avatar_storage_failed',
    message: string,
  ) {
    super(message);
    this.name = 'AgentServiceError';
  }
}

export interface AgentServiceOptions {
  agents: AgentRepo;
  blobStorage: BlobFileStorage;
  events: ScopeEventBus;
}

/**
 * Enforce the runtime/reasoning invariant on an ordinary profile update.
 * Runtime itself is handled by the dedicated transition command (which clears
 * stored CLI session/resume state), so PATCH rejects it before this service.
 * The effective (model, reasoning_effort) pair after the patch must be valid
 * for the agent's current runtime, else throw → 400. Checking both fields is
 * load-bearing: changing only `model` must not strand a previously-valid
 * model-specific effort on an incompatible model. We reject rather than
 * silently clear an explicit value — that would be a silent rebind.
 *
 * fast_mode follows the same rule: non-null is valid only on runtimes whose
 * catalog capability explicitly supports it. `null` always clears to the
 * driver default.
 */
export function normalizeRuntimeTuning(
  existing: AgentRow,
  input: UpdateAgentInput,
): UpdateAgentInput {
  if (input.reasoning_effort !== undefined || input.model !== undefined) {
    const nextModel = input.model !== undefined ? input.model : existing.model;
    const nextReasoning =
      input.reasoning_effort !== undefined
        ? input.reasoning_effort
        : existing.reasoning_effort;
    if (
      !reasoningEffortValidForRuntime(
        existing.runtime,
        nextReasoning,
        nextModel,
      )
    ) {
      throw new AgentServiceError(
        'reasoning_effort_invalid_for_runtime',
        `reasoning_effort '${nextReasoning}' is not valid for runtime '${existing.runtime}' and model '${nextModel ?? 'driver default'}'`,
      );
    }
  }
  if (
    input.fast_mode !== undefined
    && input.fast_mode !== null
    && !runtimeSupportsFastMode(existing.runtime)
  ) {
    throw new AgentServiceError(
      'fast_mode_invalid_for_runtime',
      `fast_mode is not valid for runtime '${existing.runtime}'`,
    );
  }
  return input;
}

export interface UploadAgentAvatarInput {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

/**
 * Avatar lifecycle for agents. Mirrors `UserService` 1:1 (same shared
 * `validateAvatarFile` cap + content-type whitelist; no magic-byte
 * sniff, by Cindy's PR-1 review constraint). The agent create flow
 * itself stays in `routes.ts` (`createAgentWithHome`) — this service
 * exists to keep the avatar write path isolated from the create path,
 * matching how `UserService.uploadAvatar` is separated from the auth /
 * embedded-bootstrap user creation paths.
 *
 * Storage namespace: `agents/<id>/avatars/<randomBlobId>.<ext>`. A
 * fresh random blob id per upload guarantees a previously-cached
 * `Cache-Control: immutable` response is invalidated by the
 * `?v=updated_at` query string baked into `AgentDto.avatar_url`. The
 * previous blob is deleted best-effort after the new pointer is
 * persisted.
 */
export class AgentService {
  private readonly agents: AgentRepo;
  private readonly blobStorage: BlobFileStorage;
  private readonly events: ScopeEventBus;

  constructor(opts: AgentServiceOptions) {
    this.agents = opts.agents;
    this.blobStorage = opts.blobStorage;
    this.events = opts.events;
  }

  /**
   * The single seam that broadcasts an agent-DTO change to all clients.
   * Every write path (this service's avatar methods + `updateAgent`, used
   * by both the human `PATCH /api/agents/:id` route and the agent-self
   * `profile update` route) funnels through here, so no route hand-copies
   * a publish and the model can't drift. `app` scope + minimal `{agent_id}`
   * payload — no private data globally (mirrors `user_presence`).
   */
  private publishChanged(id: string): void {
    this.events.publishToScope('app', 'agent_changed', { agent_id: id });
  }

  /**
   * Broadcast the identity-change signal for a HARD-DELETED agent (#task:1791).
   * Delete is the terminal `agent_changed`: the row is gone, so clients reseat
   * every carrier that denormalized this id — rosters/workspace-members drop it,
   * and the message/thread/saved/search/activity author carriers refetch and
   * resolve the historical author to its server-authoritative `deleted` snapshot
   * instead of a directory-miss guess.
   *
   * Reuses the SINGLE `agent_changed` seam rather than minting a parallel
   * `agent_deleted` event: the payload (id only) and every consumer's reaction
   * (invalidate + refetch; the roster no longer contains the id) are identical,
   * so a second event would only be a divergent name for the same fact.
   *
   * MUST be called only AFTER the delete authority commit (the `agents` row is
   * already gone) as a post-commit effect: a failed/rolled-back teardown never
   * reaches here, so clients are never told "deleted" for an agent that still
   * exists. Callers inside a `db.transaction` (the delete-computer cascade) defer
   * this to their post-commit phase for the same reason.
   */
  publishDeleted(id: string): void {
    this.publishChanged(id);
  }

  /**
   * Broadcast an identity refresh for an agent whose DTO changed because of a
   * fact OUTSIDE the `agents` row — today, a host rename (`PATCH
   * /api/hosts/:id` → `display_label`), which `AgentDto.host_label`
   * denormalizes. The host repo mutation does not touch `agents.updated_at`, so
   * the IDENTITY_CARRIERS ripple would never fire on its own; the host-rename
   * route calls this for every agent on the renamed host so the denormalized
   * label is not the forever-stale second read face `AgentDtoSchema` forbids.
   *
   * Reuses the SINGLE `agent_changed` seam (id-only payload; consumers refetch)
   * rather than minting a host-specific event — the reaction is identical.
   * MUST be called post-commit (the rename is durable) so a rolled-back rename
   * never announces a label clients would then fail to read back.
   */
  publishRefreshed(id: string): void {
    this.publishChanged(id);
  }

  /**
   * Update an agent's stored fields (profile metadata + model/tuning)
   * and broadcast `agent_changed` on success. Returns null when the agent
   * does not exist (no event). This is the text/metadata counterpart of
   * the avatar methods; both the public human PATCH and the internal
   * agent-self profile route call it so the refresh event is emitted once,
   * in one place, regardless of who wrote.
   */
  updateAgent(id: string, input: UpdateAgentInput): AgentDto | null {
    const existing = this.agents.getRow(id);
    if (!existing) return null;
    const normalized = normalizeRuntimeTuning(existing, input);
    const updated = this.agents.update(id, normalized);
    if (updated) this.publishChanged(id);
    return updated;
  }

  /** Commit a previously locked runtime transition and publish one refresh. */
  completeRuntimeTransition(
    id: string,
    input: SwitchAgentRuntimeInput,
  ): AgentDto | null {
    const updated = this.agents.completeRuntimeTransition(id, input);
    if (updated) this.publishChanged(id);
    return updated;
  }

  async uploadAvatar(
    id: string,
    input: UploadAgentAvatarInput,
  ): Promise<AgentDto> {
    const existing = this.agents.getRow(id);
    if (!existing) {
      throw new AgentServiceError(
        'agent_not_found',
        `agent ${id} does not exist`,
      );
    }
    const contentType = input.contentType.toLowerCase();
    const validation = validateAvatarFile({
      size: input.buffer.byteLength,
      type: contentType,
    });
    if (validation) {
      throw new AgentServiceError(validation.code, validation.message);
    }

    let stored;
    try {
      stored = await this.blobStorage.put({
        namespace: `agents/${id}/avatars`,
        id: randomBlobId(),
        filename: input.filename || 'avatar',
        contentType,
        buffer: input.buffer,
      });
    } catch (err) {
      throw new AgentServiceError(
        'avatar_storage_failed',
        `avatar storage failed: ${(err as Error).message}`,
      );
    }

    const previousKey = existing.avatar_storage_key;
    const previousStorage = stored.storage; // single backend kind today

    const updated = this.agents.setAvatar(id, {
      storageKey: stored.storageKey,
      contentType,
    });
    if (!updated) {
      // Row vanished mid-flight; clean up the orphan and 404.
      void this.blobStorage.delete(stored).catch(() => {});
      throw new AgentServiceError(
        'agent_not_found',
        `agent ${id} does not exist`,
      );
    }

    if (previousKey) {
      void this.blobStorage
        .delete({ storage: previousStorage, storageKey: previousKey })
        .catch(() => {
          // Best-effort: an orphaned previous avatar is not fatal —
          // the DB pointer is already updated, so the renderer never
          // sees it.
        });
    }

    this.publishChanged(id);
    return updated;
  }

  /** Idempotent — calling on an agent with no avatar is a no-op. */
  async clearAvatar(id: string): Promise<AgentDto> {
    const existing = this.agents.getRow(id);
    if (!existing) {
      throw new AgentServiceError(
        'agent_not_found',
        `agent ${id} does not exist`,
      );
    }
    if (!existing.avatar_storage_key) {
      // Already cleared; return the current DTO without bumping
      // updated_at.
      return this.agents.get(id) ?? (() => {
        throw new AgentServiceError(
          'agent_not_found',
          `agent ${id} does not exist`,
        );
      })();
    }
    const previousKey = existing.avatar_storage_key;
    const updated = this.agents.clearAvatar(id);
    if (!updated) {
      throw new AgentServiceError(
        'agent_not_found',
        `agent ${id} does not exist`,
      );
    }
    void this.blobStorage
      .delete({ storage: this.blobStorage.kind, storageKey: previousKey })
      .catch(() => {});
    this.publishChanged(id);
    return updated;
  }

  /** Resolve the storage ref for an avatar download. Returns null
   *  when the agent does not exist or has no avatar set. */
  getAvatarStorageRef(
    id: string,
  ): { storageKey: string; contentType: string; filename: string } | null {
    const row = this.agents.getRow(id);
    if (!row || !row.avatar_storage_key || !row.avatar_content_type) {
      return null;
    }
    return {
      storageKey: row.avatar_storage_key,
      contentType: row.avatar_content_type,
      filename: avatarFilename(row),
    };
  }
}

function avatarFilename(row: AgentRow): string {
  const ext = (row.avatar_content_type ?? 'image/png').split('/')[1] ?? 'png';
  return `avatar.${ext}`;
}

function randomBlobId(): string {
  // 12 random bytes — same shape as UserService's random blob id.
  const bytes = new Uint8Array(12);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
