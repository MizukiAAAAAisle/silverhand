import type { Database as Db } from 'better-sqlite3';
import type {
  ConversationActivityEvent,
  ConversationActivityPayload,
  ConversationEventKind,
  ParsedEvent,
  ParsedEventKind,
  SessionEventRow,
} from '@silverhand/shared';
import { sanitizeParsedEventForBroadcast } from '../runtime/event-sanitize.js';

const DEFAULT_MAX_EVENTS_PER_CONVERSATION_AGENT = 2_000;
const DEFAULT_RETENTION_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ConversationActivityRetentionOptions {
  maxEventsPerConversationAgent?: number;
  retentionDays?: number;
}

export interface ConversationActivityPage {
  events: ConversationActivityEvent[];
  next_before_id: number | null;
}

export class ConversationEventRepo {
  private readonly maxEventsPerConversationAgent: number;
  private readonly retentionMs: number;

  constructor(
    private readonly db: Db,
    opts: ConversationActivityRetentionOptions = {},
  ) {
    this.maxEventsPerConversationAgent =
      opts.maxEventsPerConversationAgent ??
      DEFAULT_MAX_EVENTS_PER_CONVERSATION_AGENT;
    const days = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.retentionMs = days * MS_PER_DAY;
  }

  recordParsedEvent(params: {
    conversationId: string;
    agentId: string;
    event: ParsedEvent;
    createdAt: number;
  }): ConversationActivityEvent | null {
    const sanitized = sanitizeParsedEventForBroadcast(params.event);
    if (sanitized.kind === 'unknown') return null;
    const kind = sanitized.kind as ConversationEventKind;
    const payload = payloadForParsedEvent(sanitized);
    return this.insert({
      conversationId: params.conversationId,
      agentId: params.agentId,
      kind,
      payload,
      createdAt: params.createdAt,
    });
  }

  recordParsedEventDropped(params: {
    conversationId: string;
    agentId: string;
    parsedKind: ParsedEventKind;
    encodedBytes: number;
    reason: string;
    createdAt: number;
  }): ConversationActivityEvent {
    return this.insert({
      conversationId: params.conversationId,
      agentId: params.agentId,
      kind: 'parsed_event_dropped',
      payload: {
        parsed_kind: params.parsedKind,
        encoded_bytes: params.encodedBytes,
        reason: params.reason,
      },
      createdAt: params.createdAt,
    });
  }

  listForConversationAgent(params: {
    conversationId: string;
    agentId: string;
    limit: number;
    beforeId?: number | null;
  }): ConversationActivityPage {
    const limit = Math.max(1, params.limit);
    const rows = this.db
      .prepare<
        [string, string, number | null, number | null, number],
        SessionEventRow
      >(
        `SELECT *
           FROM conversation_events
          WHERE conversation_id = ?
            AND agent_id = ?
            AND (? IS NULL OR id < ?)
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(
        params.conversationId,
        params.agentId,
        params.beforeId ?? null,
        params.beforeId ?? null,
        limit + 1,
      );
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit).reverse();
    return {
      events: pageRows.map(rowToDto),
      next_before_id: hasMore ? pageRows[0]?.id ?? null : null,
    };
  }

  private insert(params: {
    conversationId: string;
    agentId: string;
    kind: ConversationEventKind;
    payload: ConversationActivityPayload;
    createdAt: number;
  }): ConversationActivityEvent {
    const payloadText = params.payload === null ? null : JSON.stringify(params.payload);
    const result = this.db
      .prepare(
        `INSERT INTO conversation_events
           (conversation_id, agent_id, kind, payload, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        params.conversationId,
        params.agentId,
        params.kind,
        payloadText,
        params.createdAt,
      );
    this.pruneForConversationAgent(
      params.conversationId,
      params.agentId,
      params.createdAt,
    );
    const row = this.db
      .prepare<[number], SessionEventRow>(
        `SELECT * FROM conversation_events WHERE id = ?`,
      )
      .get(Number(result.lastInsertRowid));
    if (!row) throw new Error('conversation_events insert failed');
    return rowToDto(row);
  }

  private pruneForConversationAgent(
    conversationId: string,
    agentId: string,
    now: number,
  ): void {
    if (this.retentionMs > 0) {
      const cutoff = now - this.retentionMs;
      this.db
        .prepare(
          `DELETE FROM conversation_events
            WHERE conversation_id = ?
              AND agent_id = ?
              AND created_at < ?`,
        )
        .run(conversationId, agentId, cutoff);
    }
    if (this.maxEventsPerConversationAgent > 0) {
      const threshold = this.db
        .prepare<[string, string, number], { id: number }>(
          `SELECT id
             FROM conversation_events
            WHERE conversation_id = ?
              AND agent_id = ?
            ORDER BY id DESC
            LIMIT 1 OFFSET ?`,
        )
        .get(
          conversationId,
          agentId,
          this.maxEventsPerConversationAgent,
        );
      if (threshold) {
        this.db
          .prepare(
            `DELETE FROM conversation_events
              WHERE conversation_id = ?
                AND agent_id = ?
                AND id <= ?`,
          )
          .run(
            conversationId,
            agentId,
            threshold.id,
          );
      }
    }
  }
}

function rowToDto(row: SessionEventRow): ConversationActivityEvent {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    agent_id: row.agent_id,
    kind: row.kind,
    payload: parsePayload(row.payload),
    created_at: row.created_at,
  };
}

function parsePayload(payload: string | null): ConversationActivityPayload {
  if (payload === null) return null;
  const parsed = JSON.parse(payload) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function payloadForParsedEvent(event: ParsedEvent): ConversationActivityPayload {
  switch (event.kind) {
    case 'session_init':
      return { session_id: event.sessionId };
    case 'thinking':
    case 'text':
      return { text: event.text };
    case 'tool_call':
      return {
        name: event.name,
        input: event.input,
        ...(event.toolCallId ? { tool_call_id: event.toolCallId } : {}),
      };
    case 'tool_output':
      return {
        ...(event.name ? { name: event.name } : {}),
        ...(event.toolCallId ? { tool_call_id: event.toolCallId } : {}),
      };
    case 'turn_end':
      return event.sessionId ? { session_id: event.sessionId } : null;
    case 'compaction_started':
    case 'compaction_finished':
      return null;
    case 'error':
      return {
        message: event.message,
        ...(event.code ? { code: event.code } : {}),
        ...(event.fatal !== undefined ? { fatal: event.fatal } : {}),
      };
    case 'unknown':
      // `recordParsedEvent` skips unknown events before this switch. Keep this
      // branch for exhaustiveness if callers ever normalize historical rows.
      return null;
  }
}
