import { createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { AgentRunState } from '@silverhand/shared';

export interface ActivityLogWriterLogger {
  warn(meta: object, msg: string): void;
}

export interface ActivityLogWriter {
  write(state: AgentRunState): void;
  close(): Promise<void>;
}

export class JsonlActivityLogWriter implements ActivityLogWriter {
  private readonly stream: WriteStream | null;
  private closed = false;
  readonly logPath: string | null;

  constructor(params: {
    logDir: string | null | undefined;
    logger: ActivityLogWriterLogger;
  }) {
    if (params.logDir) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      this.logPath = join(params.logDir, `agent-activity-${ts}.log`);
      this.stream = createWriteStream(this.logPath, { flags: 'a' });
      this.stream.on('error', err => {
        params.logger.warn(
          { err, logPath: this.logPath },
          'agent-activity log write error',
        );
      });
    } else {
      this.logPath = null;
      this.stream = null;
    }
  }

  write(state: AgentRunState): void {
    if (!this.stream || this.closed) return;
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      conversationId: state.conversationId,
      agentId: state.agentId,
      runId: state.runId,
      status: state.status,
      lastActivityAt: state.lastActivityAt,
      ...(state.toolCallCounts && Object.keys(state.toolCallCounts).length
        ? { toolCallCounts: state.toolCallCounts }
        : {}),
      ...(state.activitySnippet ? { activitySnippet: state.activitySnippet } : {}),
      ...(state.activitySnippetKind
        ? { activitySnippetKind: state.activitySnippetKind }
        : {}),
      ...(state.compacting ? { compacting: state.compacting } : {}),
      ...(state.compactingSince ? { compactingSince: state.compactingSince } : {}),
      ...(state.compactionStale ? { compactionStale: state.compactionStale } : {}),
      ...(state.terminalReason ? { terminalReason: state.terminalReason } : {}),
    });
    this.stream.write(entry + '\n');
  }

  async close(): Promise<void> {
    if (!this.stream || this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve, reject) => {
      this.stream!.end((err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
