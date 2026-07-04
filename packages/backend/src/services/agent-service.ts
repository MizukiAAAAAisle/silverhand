import type { AgentRow, AgentDto, UpdateAgentInput } from '@silverhand/shared';
import { reasoningEffortValidForRuntime, validateAvatarFile } from '@silverhand/shared';
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
 * Enforce the runtime/reasoning invariant on an update, resolving against the
 * EFFECTIVE runtime (`patch.runtime ?? existing.runtime`). Two paths:
 *
 *  - **Explicit reasoning_effort in the patch** (incl. an API caller passing
 *    a bad value): must be valid for the effective runtime, else throw →
 *    400. We reject rather than silently drop an explicit value — dropping
 *    what the caller asked for would be a silent rebind.
 *  - **Runtime switch that leaves reasoning_effort untouched** (the UI's
 *    `RuntimeSelect` sends only `{ runtime }`): a stale value the NEW runtime
 *    doesn't support is cleared to null. It belonged to the old runtime and
 *    would otherwise be forwarded to the new driver — this is exactly the
 *    qoder(`max`)→codex leak. Silent here is correct: the value isn't part of
 *    this request's intent and is meaningless under the new runtime.
 *
 * fast_mode needs no equivalent: its values (true/false/null) are all valid
 * for its only consumer (codex); a stale fast_mode on another runtime is
 * ignored by that driver, so there's no out-of-range value to leak.
 */
export function normalizeRuntimeTuning(
  existing: AgentRow,
  input: UpdateAgentInput,
): UpdateAgentInput {
  const effectiveRuntime = input.runtime ?? existing.runtime;
  if (input.reasoning_effort !== undefined) {
    if (!reasoningEffortValidForRuntime(effectiveRuntime, input.reasoning_effort)) {
      throw new AgentServiceError(
        'reasoning_effort_invalid_for_runtime',
        `reasoning_effort '${input.reasoning_effort}' is not valid for runtime '${effectiveRuntime}'`,
      );
    }
    return input;
  }
  if (
    input.runtime !== undefined &&
    input.runtime !== existing.runtime &&
    !reasoningEffortValidForRuntime(effectiveRuntime, existing.reasoning_effort)
  ) {
    return { ...input, reasoning_effort: null };
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
   * Update an agent's stored fields (profile metadata + runtime/model)
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
