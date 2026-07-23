/**
 * `silverhand file` — upload, view.
 */
import { constants } from 'node:fs';
import { access, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  type AttachmentLocateDto,
} from '@silverhand/shared';
import {
  homeAppRoot,
  resolveDesktopAppPaths,
} from '@silverhand/shared/app-data-layout';
import { CliError } from '../errors.js';
import { flagString } from '../parse.js';
import type { Command } from './index.js';

const uploadCommand: Command = {
  verb: 'upload',
  summary: 'Upload a local file as a chat attachment.',
  help: `silverhand file upload --path <abs_path> [--filename <name>]
                        [--content-type <mime>]

Reads the file at --path (must be absolute) and uploads it as an
attachment scoped to the current channel. Returns an attachment id you
pass to \`silverhand message send --attachment <id>\`.

Flags:
  --path           Required. Absolute path on local disk.
  --filename       Optional display filename. Defaults to basename(path).
                   The backend sanitizes path separators and control chars.
  --content-type   Optional MIME hint. Backend sniffs magic bytes and
                   falls back to file extension when omitted.

stdout: AttachmentDto JSON.`,
  flags: ['path', 'filename', 'content-type'] as const,
  async run({ client, args }) {
    const path = flagString(args, 'path');
    if (!path) {
      throw new CliError({
        code: 'validation_error',
        message: '--path is required',
        retriable: false,
      });
    }
    const filename = flagString(args, 'filename');
    const contentType = flagString(args, 'content-type');
    return client.uploadAttachment({
      path,
      ...(filename ? { filename } : {}),
      ...(contentType ? { contentType } : {}),
    });
  },
};

const viewCommand: Command = {
  verb: 'view',
  summary: 'Resolve an attachment id to a readable local path.',
  help: `silverhand file view --attachment-id <id>

Resolve an attachment id to a local file path readable by this agent.
Cross-channel ids are rejected.

stdout: AttachmentLocateDto JSON:
  { storage: "local", local_path, filename, content_type }`,
  flags: ['attachment-id'] as const,
  async run({ env, client, args }) {
    const attachmentId = flagString(args, 'attachment-id');
    if (!attachmentId) {
      throw new CliError({
        code: 'validation_error',
        message: '--attachment-id is required',
        retriable: false,
      });
    }
    const located = await client.locateAttachment(attachmentId);
    if (located.storage === 'local' && shouldTrustLocalPath(env.serverUrl)) {
      const readable = await canReadFile(located.local_path);
      if (readable) return located;
    }
    const downloaded = await client.downloadAttachment(attachmentId);
    const localPath = await writeAttachmentCache({
      conversationId: env.conversationId,
      attachmentId,
      filename: located.filename,
      buffer: downloaded.buffer,
    });
    return {
      storage: 'local',
      local_path: localPath,
      filename: located.filename,
      content_type: located.content_type || downloaded.contentType,
    } satisfies AttachmentLocateDto;
  },
};

export const fileCommands: readonly Command[] = [uploadCommand, viewCommand];

async function canReadFile(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    if (!s.isFile()) return false;
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function shouldTrustLocalPath(serverUrl: string): boolean {
  try {
    const { hostname } = new URL(serverUrl);
    const normalized = hostname.toLowerCase();
    return normalized === 'localhost'
      || normalized === '::1'
      || normalized === '[::1]'
      || normalized === '0:0:0:0:0:0:0:1'
      || normalized.startsWith('127.');
  } catch {
    return false;
  }
}

async function writeAttachmentCache(input: {
  conversationId: string;
  attachmentId: string;
  filename: string;
  buffer: Buffer;
}): Promise<string> {
  const dir = join(
    attachmentCacheRoot(),
    safeSegment(input.conversationId),
    safeSegment(input.attachmentId),
  );
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, safeFilename(input.filename));
  const tmpPath = join(
    dir,
    `.${safeSegment(input.attachmentId)}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(tmpPath, input.buffer, { mode: 0o600 });
  await rename(tmpPath, filePath);
  return filePath;
}

export function attachmentCacheRoot(env: Record<string, string | undefined> = process.env): string {
  // #task:1598 — path shape from the shared authority. Root selection
  // keeps the CLI's HISTORICAL semantics (trimmed SILVERHAND_DIR, else
  // ~/.silverhand) — it diverges from desktop's untrimmed `||` semantics;
  // unifying that is an explicit v2 decision, not a floor change.
  const fromEnv = env.SILVERHAND_DIR?.trim();
  const appRoot = fromEnv && fromEnv.length > 0 ? fromEnv : homeAppRoot();
  return resolveDesktopAppPaths(appRoot, 'legacy-v1').attachmentsCache;
}

function safeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'unknown';
}

function safeFilename(value: string): string {
  const base = basename(value.trim() || 'attachment.bin')
    .replace(/[\x00-\x1F\x7F]/g, '_')
    .replace(/[\\/]/g, '_');
  return base || 'attachment.bin';
}
