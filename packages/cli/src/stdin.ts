/**
 * Shared stdin-body plumbing for commands whose Markdown body is piped
 * (never passed as an inline argument): `message send`, `task create`,
 * `task edit`. Centralizing the raw read + the strict UTF-8 contract keeps
 * every stdin-body command byte-faithful in exactly the same way — the DB
 * stores the bytes the agent piped, or the command fails; it never stores a
 * silently-substituted string.
 */
import { CliError } from './errors.js';

/** Read every byte off `process.stdin` into a single Buffer. Does NOT set
 *  an encoding — chunks stay raw `Buffer`s, so multi-byte UTF-8 sequences
 *  crossing chunk boundaries are preserved bit-for-bit. Returns an empty
 *  Buffer on EOF without bytes (each caller decides what empty means).
 *
 *  `maxBytes` bounds memory: once the running total EXCEEDS it, the read
 *  aborts and throws `content_too_long` instead of accumulating to EOF. A
 *  piped body has no `ARG_MAX` ceiling (unlike the removed inline argument),
 *  so a caller with a domain size cap MUST pass a byte bound derived from it
 *  — otherwise `cat huge_file |` drives the CLI to OOM before any
 *  downstream length check can reject it. Callers with no size cap (e.g.
 *  `message send`) omit `maxBytes` and read unbounded, unchanged. */
export async function readAllStdin(maxBytes = Infinity): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new CliError({
        code: 'validation_error',
        subkind: 'content_too_long',
        message:
          'piped input exceeds the maximum size and was rejected without ' +
          'reading it all into memory. Shorten the body and pipe it again.',
        retriable: false,
        details: { max_bytes: maxBytes },
      });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Decode piped bytes as strict UTF-8. `Buffer.toString('utf8')` silently
 * substitutes any invalid byte sequence with U+FFFD (REPLACEMENT
 * CHARACTER); accepting that would let the DB store a string whose bytes do
 * NOT equal the agent's input — the silent-corruption failure mode the
 * stdin-only design exists to prevent. We round-trip and reject instead so
 * the agent re-encodes upstream. `subject` names the body in the message
 * (e.g. `'message body'`, `'task body'`). `details` is bytes-free — raw
 * bytes never enter stderr or the cli-trace sink.
 */
export function decodeStdinUtf8(buffer: Buffer, subject: string): string {
  const content = buffer.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(buffer)) {
    throw new CliError({
      code: 'validation_error',
      subkind: 'invalid_utf8',
      message:
        `${subject} must be valid UTF-8 ` +
        '(stdin contained byte sequences that are not a UTF-8 string). ' +
        'Re-encode your input as UTF-8 before piping.',
      retriable: false,
      details: { encoding: 'utf8' },
    });
  }
  return content;
}
