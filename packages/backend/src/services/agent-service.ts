import type { AgentRow, AgentDto } from '@silverhand/shared';
import { validateAvatarFile } from '@silverhand/shared';
import type { BlobFileStorage } from '../storage/blob-file-storage.js';
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
 * matching how `UserService.uploadAvatar` is separated from
 * `UserService.register`.
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

  constructor(opts: AgentServiceOptions) {
    this.agents = opts.agents;
    this.blobStorage = opts.blobStorage;
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
