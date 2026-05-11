/**
 * `silverhand file` — upload, view.
 */
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
  summary: 'Resolve an attachment id to a readable location.',
  help: `silverhand file view --attachment-id <id>

Resolve an attachment id to either a local file path (zero-copy) or a
download URL, depending on backend storage. Cross-channel ids are
rejected.

stdout: AttachmentLocateDto JSON. Either:
  { storage: "local", local_path, filename, content_type }
or:
  { storage: "s3" | "oss", download_url, filename, content_type }`,
  flags: ['attachment-id'] as const,
  async run({ client, args }) {
    const attachmentId = flagString(args, 'attachment-id');
    if (!attachmentId) {
      throw new CliError({
        code: 'validation_error',
        message: '--attachment-id is required',
        retriable: false,
      });
    }
    return client.locateAttachment(attachmentId);
  },
};

export const fileCommands: readonly Command[] = [uploadCommand, viewCommand];
