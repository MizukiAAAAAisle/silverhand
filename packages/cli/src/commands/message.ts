/**
 * `silverhand message` — send, history, search.
 */
import type {
  AgentSendStaleResolutionReason,
  MessageSendTarget,
  SendMessageTarget,
} from '@silverhand/shared';
import {
  HostClient,
  HostClientError,
  type AgentMessageSendParams,
  type AgentStaleResolveParams,
  type AgentStreamObservedParams,
} from '@silverhand/host';
import { CliError, mapHttpError } from '../errors.js';
import {
  flagBool,
  flagNumber,
  flagString,
  flagStringArray,
} from '../parse.js';
import type { Command } from './index.js';

const sendCommand: Command = {
  verb: 'send',
  summary: 'Send a message to the current channel/thread.',
  help: `silverhand message send [--target channel|thread:<message_id>]
                          [--attachment <id> ...]
                          [--stale-resolution unaffected|revised]
                          [--anyway]

Reads the message body from STDIN and sends it to the current
conversation (channel or thread). A message must include text or at
least one attachment. Pipe text via stdin; attachment-only sends may
omit stdin and pass \`--attachment <id>\`.

The old \`--content <text>\` flag was removed because shell quoting
of a value containing \`"\`, backticks, or \`$\` silently truncated
the body before reaching this CLI.

Two recommended call shapes:

  # short body
  printf "%s" "hello" | silverhand message send

  # multi-line / contains quotes / contains $/backticks
  silverhand message send --target parent <<'SILVERHAND_EOF'
  Any text. Quotes, backticks, $vars, multi-line markdown — all safe.
  SILVERHAND_EOF

  # attachment-only
  silverhand message send --attachment att_123

  # explicitly send to a thread (reply cluster) under message m_123
  printf "%s" "in-thread answer" | silverhand message send --target thread:m_123

The single-quoted heredoc delimiter (\`<<'SILVERHAND_EOF'\`) disables
shell expansion of \`$\`, backticks, and \`\\\`. The body is read as
raw bytes, decoded as UTF-8, and posted to the backend with **no
normalization** — no BOM stripping, no CRLF→LF, no trim.

Flags:
  --target channel|thread:<id>
                        Optional explicit destination. Omit it to send to
                        the stream that woke this turn. "channel" forces the
                        current channel's main line. "thread:<id>" sends to
                        the reply cluster containing that message; a main-line
                        message id opens/targets its thread, and a reply id
                        joins the same thread (no nesting).
  --attachment <id>     Optional, repeatable. Attachment ids returned by
                        \`silverhand file upload\`. All ids must belong
                        to the current channel.
  --stale-resolution    Optional. After a message_stale conflict, explain
                        why this retry is being sent:
                        "unaffected" means the original draft still applies;
                        "revised" means newer messages changed the draft.
                        Missing reason never blocks sending; it is logged as
                        unattributed telemetry when a pending stale event exists.
  --anyway              Bypass this send's stale-message freshness guard.
                        Use only after inspecting a message_stale conflict,
                        or when the message must be posted despite stale risk.

Pre-flight failures (exit 1):
  --content was supplied         → flag_removed (use stdin instead)
  --text / --message was supplied → flag_removed (use stdin instead;
                                    these were never accepted but are
                                    intercepted with a stdin template)
  stdin is a TTY and no attachment → stdin_is_tty (no body provided)
  stdin is empty and no attachment → empty_stdin
  stdin is not UTF-8             → invalid_utf8 (re-encode upstream)

stdout: { "message_id": "<id>", "message_seq": <seq>, "thread_root_id": <id|null> }`,
  flags: ['target', 'reply-to', 'attachment', 'stale-resolution'] as const,
  booleanFlags: ['anyway'],
  removedFlags: {
    content: {
      replacement: 'stdin',
      hint:
        "pipe the body via stdin instead — e.g. " +
        "`silverhand message send <<'SILVERHAND_EOF' ... SILVERHAND_EOF` " +
        "or `printf \"%s\" \"...\" | silverhand message send`",
    },
    // `--text` / `--message` were never accepted, but agents reach for
    // them by default (every other CLI in their training data uses one
    // of these names). Routing them through the `flag_removed` hint
    // path turns the failure into an actionable migration line that
    // shows the heredoc template — much better than a generic
    // unknown-flag typo suggestion.
    text: {
      replacement: 'stdin',
      hint:
        "silverhand message send only accepts the body on stdin. " +
        "Use a heredoc — e.g. " +
        "`silverhand message send <<'SILVERHAND_EOF' ... SILVERHAND_EOF` " +
        "or `printf \"%s\" \"...\" | silverhand message send`",
    },
    message: {
      replacement: 'stdin',
      hint:
        "silverhand message send only accepts the body on stdin. " +
        "Use a heredoc — e.g. " +
        "`silverhand message send <<'SILVERHAND_EOF' ... SILVERHAND_EOF` " +
        "or `printf \"%s\" \"...\" | silverhand message send`",
    },
  },
  async run({ env, client, args }) {
    const attachmentIds = flagStringArray(args, 'attachment');
    const hasAttachments = (attachmentIds?.length ?? 0) > 0;
    let content = '';

    // Pre-flight: a TTY on stdin means the agent forgot to pipe a body.
    // Failing fast (rather than blocking on a read that will never
    // arrive) keeps the agent's exit path predictable. Attachment-only
    // sends are the one intentional no-stdin path.
    if (process.stdin.isTTY && !hasAttachments) {
      throw new CliError({
        code: 'validation_error',
        subkind: 'stdin_is_tty',
        message:
          'silverhand message send reads the body from stdin, but stdin is a TTY. ' +
          "Pipe the body — e.g. `printf \"%s\" \"hello\" | silverhand message send` " +
          "or `silverhand message send <<'SILVERHAND_EOF' ... SILVERHAND_EOF`.",
        retriable: false,
      });
    }

    if (!process.stdin.isTTY) {
      // Read raw bytes; do NOT setEncoding so any UTF-8 surrogate pairs
      // / multi-byte sequences cross chunk boundaries cleanly.
      const buffer = await readAllStdin();

      if (buffer.byteLength === 0 && !hasAttachments) {
        throw new CliError({
          code: 'validation_error',
          subkind: 'empty_stdin',
          message:
            'silverhand message send received 0 bytes on stdin. ' +
            'Pipe a non-empty body, or attach at least one file.',
          retriable: false,
        });
      }

      // UTF-8 decode + zero normalization. `Buffer.toString('utf8')`
      // does NOT strip a BOM; does NOT translate CR/LF; does NOT trim.
      // The backend / DB stores the bytes the agent wrote, period.
      content = buffer.toString('utf8');

      // Round-trip sanity. `toString('utf8')` silently substitutes any
      // invalid byte sequence with U+FFFD (REPLACEMENT CHARACTER); if
      // we accepted that, the DB would store a string whose bytes do
      // NOT equal the agent's input — exactly the silent-corruption
      // failure mode this command's stdin-only design exists to
      // prevent. Reject explicitly so the agent re-encodes upstream.
      // `details` is bytes-free (Cindy review): `{encoding: 'utf8'}`
      // is enough context, raw bytes never enter stderr or cli-trace.
      if (!Buffer.from(content, 'utf8').equals(buffer)) {
        throw new CliError({
          code: 'validation_error',
          subkind: 'invalid_utf8',
          message:
            'message body must be valid UTF-8 ' +
            '(stdin contained byte sequences that are not a UTF-8 string). ' +
            'Re-encode your input as UTF-8 before piping.',
          retriable: false,
          details: { encoding: 'utf8' },
        });
      }
    }

    const destination = parseSendDestination(
      flagString(args, 'target'),
      flagString(args, 'reply-to'),
    );
    const anyway = flagBool(args, 'anyway') ?? false;
    const staleResolution = parseSendStaleResolution(
      flagString(args, 'stale-resolution'),
    );
    if (anyway && staleResolution !== undefined) {
      throw new CliError({
        code: 'validation_error',
        message:
          '--anyway already records stale resolution as force_send; ' +
          'do not also pass --stale-resolution',
        retriable: false,
      });
    }
    const daemonInput = {
      conversation_id: env.conversationId,
      agent_id: env.agentId,
      content,
      ...(destination.target ? { target: destination.target } : {}),
      ...(attachmentIds && attachmentIds.length > 0
        ? { attachment_ids: attachmentIds }
        : {}),
      ...(anyway ? { freshness_bypass: true } : {}),
      ...(staleResolution ? { stale_resolution_reason: staleResolution } : {}),
    };
    if (env.daemonSocketPath) {
      return await sendViaDaemon(env.daemonSocketPath, daemonInput);
    }

    // Migration fallback for non-daemon/manual CLI contexts. Do not read
    // the retired sidecar as freshness authority; missing seen_up_to_seq
    // makes the backend explicitly skip hard CAS instead of validating a
    // polluted boundary.
    return await client.sendMessage({
      content,
      ...(destination.target ? { target: destination.target } : {}),
      ...(anyway ? { freshness_bypass: true } : {}),
      ...(attachmentIds && attachmentIds.length > 0
        ? { attachment_ids: attachmentIds }
        : {}),
    });
  },
};

const staleResolveCommand: Command = {
  verb: 'stale-resolve',
  summary: 'Report that a stale draft no longer needs to be sent.',
  help: `silverhand message stale-resolve --resolution obsolete [--event-id <id>]

Reports an observability-only resolution for the most recent message_stale
conflict without sending a message. This is for the "no need to send anymore"
case after reading the newer messages from the conflict response.

Flags:
  --resolution obsolete  Required. Records that the stale draft is obsolete.
  --event-id <id>        Optional. Defaults to the pending stale event recorded
                         from the latest message_stale response.

stdout: { "resolved": true } or { "resolved": false, "reason": "no_pending_stale_event" }`,
  flags: ['resolution', 'event-id'] as const,
  async run({ env, client, args }) {
    const resolution = flagString(args, 'resolution');
    if (resolution !== 'obsolete') {
      throw new CliError({
        code: 'validation_error',
        message: '--resolution must be obsolete',
        retriable: false,
      });
    }
    const explicitEventId = flagString(args, 'event-id');
    if (env.daemonSocketPath) {
      return await resolveStaleViaDaemon(env.daemonSocketPath, {
        conversation_id: env.conversationId,
        agent_id: env.agentId,
        ...(explicitEventId ? { stale_event_id: explicitEventId } : {}),
        resolution_reason: 'obsolete',
      });
    }
    const staleEventId = explicitEventId;
    if (!staleEventId) {
      return { resolved: false, reason: 'no_pending_stale_event' };
    }
    await client.resolveStaleMessage({
      stale_event_id: staleEventId,
      resolution_reason: 'obsolete',
    });
    return { resolved: true };
  },
};

const reactCommand: Command = {
  verb: 'react',
  summary: 'Add or remove your emoji reaction on a message.',
  help: `silverhand message react --message-id <id> --emoji <emoji> [--remove]

Add or remove your reaction on a message. Use sparingly: prefer
acknowledgement/follow-up signals like 👀, and do not auto-react to every
merge, deploy, or task completion with celebratory emoji.

A reaction is a lightweight signal, not a message: it allocates no seq,
never advances the conversation's freshness, and does not wake anyone.
Idempotent — re-adding a reaction you already placed, or removing one you
never placed, returns \`changed: false\`. React on any message you can
see in the current conversation (channel or thread); system messages
cannot be reacted to.

Flags:
  --message-id <id>  Required. The message to react to (from an incoming
                     header's msg_id, history, or a send result).
  --emoji <emoji>    Required. A single emoji (max 16 chars, no whitespace).
  --remove           Remove your reaction instead of adding it.

stdout: { "changed": <bool>, "emoji": "<emoji>", "count": <n> }`,
  flags: ['message-id', 'emoji'] as const,
  booleanFlags: ['remove'],
  async run({ client, args }) {
    const messageId = flagString(args, 'message-id');
    if (!messageId) {
      throw new CliError({
        code: 'validation_error',
        message: '--message-id is required',
        retriable: false,
      });
    }
    const emoji = flagString(args, 'emoji');
    if (!emoji) {
      throw new CliError({
        code: 'validation_error',
        message: '--emoji is required',
        retriable: false,
      });
    }
    const remove = flagBool(args, 'remove') ?? false;
    return await client.reactToMessage({
      message_id: messageId,
      emoji,
      ...(remove ? { remove: true } : {}),
    });
  },
};

const historyCommand: Command = {
  verb: 'history',
  summary: 'Read an anchored window of message history.',
  help: `silverhand message history (--before-seq N | --after-seq N | --around <id>)
                             [--target self|parent|conversation:<id>|thread:<id>]
                             [--include-content] [--no-include-system]
                             [--limit N]

Read a window of messages anchored at a position. Exactly one of --before-seq,
--after-seq, or --around must be provided.

Flags:
  --before-seq N        Read messages with seq < N.
  --after-seq N         Read messages with seq > N.
  --around <message_id> Read a window centered on this message id.
  --target              Where to read.
                          self                    (default; current conv)
                          parent                  (only inside a Thread)
                          thread:<root_msg_id>    (a reply cluster, by its
                                                  root message id)
                          conversation:<conv_id>  (any conv you can reach)
  --include-content     Return full content. Default is snippets only.
  --no-include-system   Skip system messages. Default keeps them.
  --limit N             Max messages. Default 50, max 100.

Reading a reply cluster (\`--target thread:<root_msg_id>\`) is a pull:
gated by parent-channel visibility, it does NOT make you a follower, but
it advances your observed boundary for that thread so a later
\`message send --target thread:<message_id>\` is judged fresh against what you just read.

stdout: full AgentReadHistoryDto JSON.`,
  flags: ['before-seq', 'after-seq', 'around', 'target', 'limit'] as const,
  booleanFlags: ['include-content', 'include-system'],
  async run({ env, client, args }) {
    const before = flagNumber(args, 'before-seq');
    const after = flagNumber(args, 'after-seq');
    const around = flagString(args, 'around');
    const anchorCount = [before, after, around].filter(v => v !== undefined).length;
    if (anchorCount !== 1) {
      throw new CliError({
        code: 'validation_error',
        message:
          'message history requires exactly one of --before-seq, --after-seq, or --around',
        retriable: false,
      });
    }
    const includeContent = flagBool(args, 'include-content') ?? false;
    const includeSystem = flagBool(args, 'include-system') ?? true;
    const limit = flagNumber(args, 'limit') ?? 50;
    const target = parseHistoryTarget(flagString(args, 'target'));
    const dto = await client.readHistory({
      ...(before !== undefined ? { before_seq: before } : {}),
      ...(after !== undefined ? { after_seq: after } : {}),
      ...(around !== undefined ? { around_message_id: around } : {}),
      ...(target ? { target } : {}),
      include_content: includeContent,
      include_system: includeSystem,
      limit,
    });

    // Pull-observed (B-light, docs/thread-reply-cluster-v1.md §6.4/§7):
    // a successful reply-cluster read enters the model's context, so it
    // is a real observe. The read itself reaches the backend over plain
    // HTTP (the daemon never sees it), so when a daemon socket is present
    // we fire a daemon-local `agent_stream_observed` intent to advance
    // the `thread:<root>` observed boundary and map the surfaced ids —
    // otherwise a read-then-`--target thread:<message_id>` would be judged
    // stale against a boundary the daemon never learned about. Gated on
    // `target.thread_root_id` (set only for the cluster read form).
    // Direct/non-daemon fallback degrades to "A": no intent, no boundary
    // (no daemon owns observed state to advance). Best-effort: the read
    // already succeeded and was returned, so an intent failure must not
    // fail the command.
    const root = dto.target.thread_root_id;
    if (root && env.daemonSocketPath) {
      const replySeqs = dto.messages
        .filter(m => m.message_ref.id !== root)
        .map(m => m.message_ref.seq);
      const observedSeq = replySeqs.length > 0 ? Math.max(...replySeqs) : 0;
      // root id is ALWAYS first so the array is non-empty (schema .min(1))
      // and reply-to-root resolves a known stream even with zero replies.
      const replyTargetMessages = [
        root,
        ...dto.messages
          .map(m => m.message_ref.id)
          .filter(id => id !== root),
      ];
      await observeStreamViaDaemon(env.daemonSocketPath, {
        conversation_id: env.conversationId,
        agent_id: env.agentId,
        thread_root_id: root,
        observed_seq: observedSeq,
        reply_target_messages: replyTargetMessages,
      });
    }

    return dto;
  },
};

const searchCommand: Command = {
  verb: 'search',
  summary: 'Search visible message text.',
  help: `silverhand message search (--q <text> | --query <text>)
                            [--scope current|workspace|channel]
                            [--workspace-id <id>] [--channel-id <id>]
                            [--no-include-system] [--limit N]

Full-text search over messages this agent can see.

Flags:
  --q <text>           Required (mutually exclusive with --query).
                       Search query. 1..200 chars.
  --query <text>       Alias for --q. Same length limit. Passing both
                       --q and --query at once fails with
                       mutually_exclusive — pick one form per call.
  --scope              Default "current". One of:
                         current   — only the current channel/thread
                         workspace — every conv in this workspace (or one
                                     given via --workspace-id) where you
                                     are a current member
                         channel   — a specific channel; requires --channel-id
  --workspace-id <id>  Only valid with --scope workspace.
  --channel-id <id>    Required with --scope channel; from "channel list".
  --no-include-system  Skip system messages.
  --limit N            Max hits. Default 50, max 100.

stdout: AgentSearchMessagesDto JSON.`,
  flags: ['q', 'query', 'scope', 'workspace-id', 'channel-id', 'limit'] as const,
  booleanFlags: ['include-system'],
  async run({ client, args }) {
    const qShort = flagString(args, 'q');
    const qLong = flagString(args, 'query');
    if (qShort !== undefined && qLong !== undefined) {
      throw new CliError({
        code: 'validation_error',
        subkind: 'mutually_exclusive',
        message:
          '--q and --query are mutually exclusive (they are aliases). ' +
          'Pass exactly one.',
        retriable: false,
        details: { flags: ['q', 'query'] },
      });
    }
    const q = qShort ?? qLong;
    if (!q) {
      throw new CliError({
        code: 'validation_error',
        message: '--q (or --query) is required',
        retriable: false,
      });
    }
    const scope = (flagString(args, 'scope') ?? 'current') as
      | 'current'
      | 'workspace'
      | 'channel';
    if (!['current', 'workspace', 'channel'].includes(scope)) {
      throw new CliError({
        code: 'validation_error',
        subkind: 'enum_invalid',
        message: `--scope must be current|workspace|channel; got "${scope}"`,
        retriable: false,
        details: {
          flag: 'scope',
          value: scope,
          allowed: ['current', 'workspace', 'channel'],
        },
      });
    }
    const workspaceId = flagString(args, 'workspace-id');
    const channelId = flagString(args, 'channel-id');
    if ((scope === 'channel') !== !!channelId) {
      throw new CliError({
        code: 'validation_error',
        message: '--channel-id is required only when --scope is channel',
        retriable: false,
      });
    }
    if (workspaceId && scope !== 'workspace') {
      throw new CliError({
        code: 'validation_error',
        message: '--workspace-id is only valid with --scope workspace',
        retriable: false,
      });
    }
    const includeSystem = flagBool(args, 'include-system') ?? true;
    const limit = flagNumber(args, 'limit') ?? 50;
    return client.searchMessages({
      q,
      scope,
      include_system: includeSystem,
      limit,
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
      ...(channelId ? { channel_id: channelId } : {}),
    });
  },
};

export const messageCommands: readonly Command[] = [
  sendCommand,
  staleResolveCommand,
  reactCommand,
  historyCommand,
  searchCommand,
];

function parseSendDestination(
  rawTarget: string | undefined,
  rawReplyTo: string | undefined,
): { target?: SendMessageTarget } {
  const target = parseSendTarget(rawTarget);
  if (rawReplyTo !== undefined && target !== undefined) {
    throw new CliError({
      code: 'validation_error',
      subkind: 'mutually_exclusive',
      message:
        '--reply-to and --target are mutually exclusive: use ' +
        '`--target thread:<message_id>` for thread sends.',
      retriable: false,
      details: { flags: ['reply-to', 'target'] },
    });
  }
  if (rawReplyTo !== undefined) {
    return { target: { kind: 'thread', message_id: rawReplyTo } };
  }
  return target ? { target } : {};
}

function parseSendTarget(raw: string | undefined): SendMessageTarget | undefined {
  if (raw === undefined) return undefined;
  if (raw.length === 0) {
    throw new CliError({
      code: 'validation_error',
      subkind: 'enum_invalid',
      message: '--target must be channel or thread:<message_id>',
      retriable: false,
      details: { flag: 'target', value: raw },
    });
  }
  if (raw === 'channel') return { kind: 'channel' };
  if (raw === 'self') return { kind: 'channel' };
  if (raw === 'parent') return 'parent';
  if (raw.startsWith('thread:')) {
    const messageId = raw.slice('thread:'.length);
    if (!messageId) {
      throw new CliError({
        code: 'validation_error',
        subkind: 'enum_invalid',
        message: '--target thread:<message_id> requires a message id after thread:',
        retriable: false,
        details: { flag: 'target', value: raw },
      });
    }
    const target: MessageSendTarget = { kind: 'thread', message_id: messageId };
    return target;
  }
  // Isolated-thread conversations were retired (#task:1303); the only
  // targets are `channel` and `thread:<message_id>` (reply cluster).
  throw new CliError({
    code: 'validation_error',
    subkind: 'enum_invalid',
    message: '--target must be channel or thread:<message_id>',
    retriable: false,
    details: { flag: 'target', value: raw },
  });
}

function parseSendStaleResolution(
  raw: string | undefined,
): AgentSendStaleResolutionReason | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'unaffected' || raw === 'revised') return raw;
  throw new CliError({
    code: 'validation_error',
    message: '--stale-resolution must be unaffected or revised',
    retriable: false,
  });
}

async function sendViaDaemon(
  socketPath: string,
  input: AgentMessageSendParams,
): Promise<{ message_id: string; message_seq?: number; thread_root_id?: string | null }> {
  const host = new HostClient({ socketPath });
  try {
    await host.connect();
    requireFreshnessAuthority(host);
    const result = await host.agentMessageSend(input);
    if (!result.ok) {
      throw mapHttpError(result.status, result.body_text);
    }
    return {
      message_id: result.message_id,
      ...(result.message_seq !== undefined ? { message_seq: result.message_seq } : {}),
      ...(result.thread_root_id !== undefined
        ? { thread_root_id: result.thread_root_id }
        : {}),
    };
  } catch (err) {
    if (err instanceof HostClientError) {
      throw new CliError({
        code: err.code === 'disconnected' || err.code === 'timeout'
          ? 'upstream_unavailable'
          : 'internal',
        message: `silverhand daemon send failed: ${err.message}`,
        retriable: err.code === 'disconnected' || err.code === 'timeout',
      });
    }
    throw err;
  } finally {
    await host.close().catch(() => undefined);
  }
}

async function resolveStaleViaDaemon(
  socketPath: string,
  input: AgentStaleResolveParams,
): Promise<{ resolved: boolean; reason?: 'no_pending_stale_event' }> {
  const host = new HostClient({ socketPath });
  try {
    await host.connect();
    requireFreshnessAuthority(host);
    const result = await host.agentStaleResolve(input);
    if (!result.ok) {
      throw mapHttpError(result.status, result.body_text);
    }
    return result.resolved
      ? { resolved: true }
      : { resolved: false, reason: result.reason };
  } catch (err) {
    if (err instanceof HostClientError) {
      throw new CliError({
        code: err.code === 'disconnected' || err.code === 'timeout'
          ? 'upstream_unavailable'
          : 'internal',
        message: `silverhand daemon stale-resolve failed: ${err.message}`,
        retriable: err.code === 'disconnected' || err.code === 'timeout',
      });
    }
    throw err;
  } finally {
    await host.close().catch(() => undefined);
  }
}

function requireFreshnessAuthority(host: HostClient): void {
  if (host.capabilities.has('agent.freshness_authority')) return;
  throw new CliError({
    code: 'internal',
    message:
      'silverhand daemon does not advertise agent.freshness_authority; restart the app/daemon from the same build as this CLI',
    retriable: false,
  });
}

/** Read every byte off `process.stdin` into a single Buffer. Does NOT
 *  set an encoding — chunks are raw `Buffer`s, so multi-byte UTF-8
 *  sequences crossing chunk boundaries are preserved bit-for-bit.
 *  Returns an empty Buffer on EOF without bytes (the empty-stdin
 *  preflight in `send` decides how to react). */
async function readAllStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parseHistoryTarget(
  raw: string | undefined,
):
  | 'self'
  | 'parent'
  | { thread_root_id: string }
  | { conversation_id: string }
  | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'self' || raw === 'parent') return raw;
  // `thread:<id>` now means a reply cluster identified by its ROOT
  // message id (docs/thread-reply-cluster-v1.md §8) — threads are no
  // longer separate conversations. The old "child thread conversation
  // id" reading moves to `conversation:<id>`; legacy dual-resolution
  // lives in the freeze cut.
  if (raw.startsWith('thread:')) {
    return { thread_root_id: raw.slice('thread:'.length) };
  }
  if (raw.startsWith('conversation:')) {
    return { conversation_id: raw.slice('conversation:'.length) };
  }
  throw new CliError({
    code: 'validation_error',
    message:
      '--target must be self | parent | thread:<root_msg_id> | conversation:<id>',
    retriable: false,
  });
}

/**
 * Fire the daemon-local `agent_stream_observed` intent after a
 * reply-cluster pull (B-light, §6.4/§7). Best-effort by contract: the
 * history read it follows has already succeeded and been returned to the
 * caller, so any transport/daemon failure here is swallowed rather than
 * surfaced — losing the observed-boundary advance degrades to the
 * "A" semantics (the next reply is judged against an unknown stream),
 * which is strictly better than failing a read that worked.
 */
async function observeStreamViaDaemon(
  socketPath: string,
  params: AgentStreamObservedParams,
): Promise<void> {
  const host = new HostClient({ socketPath });
  try {
    await host.connect();
    await host.agentStreamObserved(params);
  } catch {
    // swallow — see doc comment.
  } finally {
    await host.close().catch(() => undefined);
  }
}
