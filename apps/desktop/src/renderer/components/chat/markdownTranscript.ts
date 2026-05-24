import type { AgentDto, MessageDto, UserDto } from '@silverhand/shared';

/**
 * Build a markdown transcript from a list of selected messages.
 *
 * Format (per @shiki + Cindy spec):
 *
 *   ## <displayName> · <isoTime>
 *
 *   <content>
 *
 *
 *   ## <displayName> · <isoTime>
 *
 *   <content>
 *
 * Two blank lines between consecutive messages. A header carries the
 * sender's display label and the ISO timestamp so the resulting file is
 * a real "transcript with context" rather than a bare content dump.
 *
 * Single-message exports go through the same path so there is no hidden
 * branch — selecting one message still produces a header. Use the
 * single-message context-menu Copy markdown action when you actually
 * want raw content with no header.
 *
 * Display label rules match the in-channel render:
 *   - agent: `@<display_name|name>`
 *   - user (viewer): `<display_name|name>` (no leading `@`)
 *   - user (other / unresolved): falls back to the from_user_id
 *   - unresolved agent: falls back to `@<id>`
 *
 * Sort order: ASCENDING by `MessageDto.seq`. Callers MUST pass already
 * sorted messages — the function does not re-sort because in production
 * we run on `selectionSorted()` output which is already canonical.
 */
export function buildMarkdownTranscript(
  messages: readonly MessageDto[],
  ctx: {
    agentsById: ReadonlyMap<string, AgentDto>;
    viewer?: UserDto;
    /** Optional override for the time formatter; defaults to ISO 8601
     *  (e.g. `2026-05-25T00:30:00.000Z`). The default keeps tests
     *  deterministic without relying on local timezone. */
    formatTime?: (epochMs: number) => string;
  },
): string {
  const formatTime = ctx.formatTime ?? defaultFormatTime;

  const blocks = messages.map(m => {
    const sender = formatSenderLabel(m, ctx);
    const time = formatTime(m.created_at);
    const header = `## ${sender} · ${time}`;
    return `${header}\n\n${m.content}`;
  });

  // Two blank lines between blocks → join with "\n\n\n" (each block
  // ends without trailing newline; "\n\n\n" inserts one trailing newline
  // from the previous block + one blank line + the next block's content).
  // The result is `## A\n\n<a>\n\n\n## B\n\n<b>` which renders as the
  // intended visual gap when round-tripped through any markdown viewer.
  return blocks.join('\n\n\n') + '\n';
}

export function formatSenderLabel(
  m: MessageDto,
  ctx: {
    agentsById: ReadonlyMap<string, AgentDto>;
    viewer?: UserDto;
  },
): string {
  if (m.from_kind === 'agent') {
    if (!m.from_agent_id) return '@agent';
    const agent = ctx.agentsById.get(m.from_agent_id);
    const name = (agent?.display_name?.trim() ?? '') || agent?.name?.trim();
    return `@${name ?? m.from_agent_id}`;
  }
  if (m.from_kind === 'user') {
    if (ctx.viewer && m.from_user_id === ctx.viewer.id) {
      const v = ctx.viewer;
      const name = (v.display_name?.trim() ?? '') || v.name.trim();
      return name || v.id;
    }
    return m.from_user_id ?? 'user';
  }
  return 'system';
}

function defaultFormatTime(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * Same suggestion shape for PNG image exports. Markdown transcripts
 * no longer need a filename helper — multi-select Copy markdown writes
 * to the clipboard directly (shiki `vBRFDuOuOqhsYzow`), so there is no
 * save dialog to seed.
 */
export function suggestImageFilename(
  messages: readonly MessageDto[],
  channelTitle: string | null,
): string {
  const safeTitle = (channelTitle ?? 'transcript')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .trim()
    .slice(0, 80);
  const firstSeq = messages.length > 0 ? messages[0]!.seq : 0;
  return `${safeTitle || 'transcript'}-${firstSeq}.png`;
}
