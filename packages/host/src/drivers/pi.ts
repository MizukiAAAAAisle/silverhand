import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Driver, DriverIO, DriverSpawnContext, ParsedEvent } from './index.js';
import { versionAtLeast } from './version-gate.js';

const LIMIT = 16_384;
type Frame = Record<string, any>;

/** Pi owns steering execution; Silverhand settles only its successful write. */
export class PiDriver implements Driver {
  readonly kind = 'pi' as const;
  readonly binary = 'pi';
  readonly kickoffMode = 'self_inits' as const;
  readonly releaseProfile = 'tool-boundary-steer' as const;
  readonly admissionPolicy = 'write-success' as const;
  readonly oneShot = false;
  readonly supportsNativeStandingPrompt = true;
  readonly initLivenessSilenceMs = 30_000;
  readonly initPreProtocolCapMs = 60_000;
  readonly initPostProtocolMs = 60_000;
  private io?: DriverIO;
  private sessionId = '';
  private ready = false;
  private compacting = false;
  private running = false;
  private stopping = false;
  private serial = 0;
  private pending = new Map<string, string>();
  private calls = new Map<string, string>();
  private errors: ParsedEvent[] = [];

  bindRuntimeVersion(version: string | null): void {
    if (!versionAtLeast(version, '0.85.1')) throw new Error('Pi 0.85.1 or newer is required.');
  }
  buildArgs(ctx: DriverSpawnContext): string[] {
    this.sessionId = ctx.cliSessionId ?? randomUUID();
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(this.sessionId)) {
      throw new Error('Invalid Pi session identity.');
    }
    const sessions = join(ctx.workspacePath, '.silverhand', 'pi-sessions', ctx.agentId);
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    return ['--mode', 'rpc', '--session-dir', sessions, '--session-id', this.sessionId,
      '--append-system-prompt', ctx.systemPromptPath,
      ...(ctx.model ? ['--model', ctx.model] : []),
      ...(ctx.reasoningEffort ? ['--thinking', ctx.reasoningEffort] : [])];
  }
  applyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv { return { ...env, NO_COLOR: '1' }; }
  bindIO(io: DriverIO): void { this.io = io; this.send('get_state', {}, 'init'); }
  private frame(type: string, fields: Frame = {}, purpose = type): string {
    // Bound diagnostic correlation; eviction never triggers retries or settlement.
    if (this.pending.size >= 256) this.pending.delete(this.pending.keys().next().value!);
    const id = `silverhand-${++this.serial}`;
    this.pending.set(id, purpose);
    return JSON.stringify({ id, type, ...fields });
  }
  private send(type: string, fields: Frame = {}, purpose = type): void {
    void this.io!.writeLine(this.frame(type, fields, purpose)).catch(() => {
      this.ready = false;
      this.errors.push({ kind: 'error', code: 'pi_rpc_write_failed', message: 'Pi RPC control write failed.', fatal: true });
    });
  }
  readyToEncode(): boolean { return this.ready && !this.compacting && !this.stopping; }
  encodeStdinMessage(content: string, _session: string | null, opts?: { payloadUuid?: string }): string | null {
    if (!this.readyToEncode()) return null;
    return this.frame('prompt', { message: content, streamingBehavior: 'steer' });
  }
  encodeInterruptControl(): string {
    this.stopping = true;
    return this.frame('clear_queue') + '\n' + this.frame('abort');
  }
  classifyInitProgress(line: string): 'protocol_ready' | 'session_ready' | null {
    try {
      const f = JSON.parse(line);
      return f.type === 'response' ? 'protocol_ready' : null;
    } catch { return null; }
  }
  parseLine(line: string): ParsedEvent[] {
    const events = this.errors.splice(0);
    let f: Frame;
    try { f = JSON.parse(line); } catch { return [...events, { kind: 'error', code: 'pi_rpc_invalid_json', message: 'Invalid Pi RPC JSON.' }]; }
    if (!f || typeof f !== 'object') return events;
    if (f.type === 'response') {
      const purpose = this.pending.get(f.id);
      if (!purpose) {
        // Correlation is bounded, but an asynchronous rejection must stay visible
        // even after its diagnostic request entry has been evicted.
        if (f.success === false) events.push({ kind: 'error', code: 'pi_rpc_rejected', message: `Pi RPC rejected: ${String(f.error ?? 'unknown error').slice(0, 1024)}` });
        return events;
      }
      this.pending.delete(f.id);
      if (f.success !== true) {
        const fatal = ['init', 'levels', 'thinking', 'verified'].includes(purpose);
        if (fatal) this.ready = false;
        events.push({ kind: 'error', code: 'pi_rpc_rejected', message: `Pi ${purpose} rejected: ${String(f.error ?? 'unknown error').slice(0, 1024)}`, fatal });
        if (purpose === 'prompt' && !this.running) events.push({ kind: 'turn_end', sessionId: this.sessionId });
        return events;
      }
      if (purpose === 'init' || purpose === 'verified') {
        if (f.data?.sessionId !== this.sessionId) return [...events, { kind: 'error', message: 'Pi session identity mismatch.', fatal: true }];
        const effort = this.io?.spawnCtx.reasoningEffort;
        if (purpose === 'init' && effort) { this.send('get_available_thinking_levels', {}, 'levels'); return events; }
        if (effort && f.data?.thinkingLevel !== effort) return [...events, { kind: 'error', message: 'Pi did not apply the requested thinking level.', fatal: true }];
        this.ready = true;
        events.push({ kind: 'session_init', sessionId: this.sessionId });
      } else if (purpose === 'levels') {
        const effort = this.io!.spawnCtx.reasoningEffort;
        if (!Array.isArray(f.data?.levels) || !f.data.levels.includes(effort)) {
          events.push({ kind: 'error', message: 'Pi model does not support the requested thinking level.', fatal: true });
        } else this.send('set_thinking_level', { level: effort }, 'thinking');
      } else if (purpose === 'thinking') this.send('get_state', {}, 'verified');
      else if (purpose === 'abort') this.stopping = false;
      return events;
    }
    switch (f.type) {
      case 'agent_start': this.running = true; break;
      case 'compaction_start': this.compacting = true; events.push({ kind: 'compaction_started' }); break;
      case 'compaction_end':
        this.compacting = false; events.push({ kind: 'compaction_finished' });
        if (f.errorMessage) events.push({ kind: 'error', message: String(f.errorMessage).slice(0, 1024) });
        break;
      case 'agent_settled': this.running = false; this.calls.clear(); events.push({ kind: 'turn_end', sessionId: this.sessionId }); break;
      case 'auto_retry_start': events.push({ kind: 'api_response', status: 'waiting', message: 'Pi is retrying the model request.' }); break;
      case 'auto_retry_end': events.push({ kind: 'api_response', status: 'ready', message: 'Pi model retry finished.' }); break;
      case 'extension_error': events.push({ kind: 'error', message: String(f.error ?? 'Pi extension failed.').slice(0, 1024) }); break;
      case 'extension_ui_request':
        if (['select', 'confirm', 'input', 'editor'].includes(f.method) && typeof f.id === 'string') {
          void this.io?.writeLine(JSON.stringify({ type: 'extension_ui_response', id: f.id, cancelled: true })).catch(() => { this.errors.push({ kind: 'error', code: 'pi_rpc_write_failed', message: 'Pi extension cancellation write failed.' }); });
          events.push({ kind: 'error', code: 'pi_extension_interaction_cancelled', message: 'Pi extension interaction cancelled: headless interaction is not supported.' });
        }
        break;
      case 'message_update': {
        const d = f.assistantMessageEvent;
        if (d?.type === 'text_delta' || d?.type === 'thinking_delta') {
          if (typeof d.delta === 'string') events.push({ kind: d.type === 'text_delta' ? 'text' : 'thinking', text: d.delta.slice(0, LIMIT) });
        } else if (d?.type === 'toolcall_end') this.toolCall(events, d.toolCall?.id, d.toolCall?.name, d.toolCall?.arguments);
        break;
      }
      case 'tool_execution_start': this.toolCall(events, f.toolCallId, f.toolName, f.args); break;
      case 'tool_execution_end':
        if (typeof f.toolCallId === 'string') {
          events.push({ kind: 'tool_output', toolCallId: f.toolCallId, ...(typeof f.toolName === 'string' ? { name: f.toolName } : {}), outcome: f.isError === false ? 'success' : f.isError === true ? 'failed' : 'completed' });
        }
        break;
      case 'message_end':
        if (f.message?.role === 'assistant' && f.message.stopReason === 'error') events.push({ kind: 'error', message: String(f.message.errorMessage ?? 'Pi model request failed.').slice(0, 1024) });
        break;
    }
    return events;
  }
  private toolCall(events: ParsedEvent[], id: unknown, name: unknown, input: unknown): void {
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name || this.calls.has(id)) return;
    if (this.calls.size >= 1024) return;
    this.calls.set(id, name);
    const text = JSON.stringify(input ?? null);
    events.push({ kind: 'tool_call', toolCallId: id, name, input: text.length > LIMIT ? text.slice(0, LIMIT) : input ?? null });
  }
}
