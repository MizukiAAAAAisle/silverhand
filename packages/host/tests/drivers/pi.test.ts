import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiDriver } from '../../src/drivers/pi.js';
import type { DriverSpawnContext } from '../../src/drivers/index.js';
import { ParsedEventSchema } from '@silverhand/shared';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture(effort: string | null = null) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-driver-')); dirs.push(dir);
  const ctx: DriverSpawnContext = { agentId: 'agent', agentName: 'Pi', workspacePath: dir, cliSessionId: null, model: null, reasoningEffort: effort, fastMode: null, systemPromptPath: join(dir, 'prompt.md'), initialPrompt: '' };
  writeFileSync(ctx.systemPromptPath, 'standing prompt');
  const d = new PiDriver(); d.bindRuntimeVersion('0.85.1');
  const args = d.buildArgs(ctx); const id = args[args.indexOf('--session-id') + 1];
  const lines: any[] = [];
  d.bindIO({ spawnCtx: ctx, writeLine: async line => { lines.push(JSON.parse(line)); } });
  const reply = (data: unknown, success = true) => d.parseLine(JSON.stringify({ type: 'response', id: lines.at(-1).id, success, data, error: 'fixture failure' }));
  return { d, ctx, args, id, lines, reply };
}
describe('Pi RPC driver', () => {
  it('isolates exact session coordinates, preserves configuration, and gates versions', () => {
    const { d, ctx, args, id } = fixture();
    expect(args).toContain('--append-system-prompt'); expect(args).not.toContain('--approve');
    expect(d.buildArgs({ ...ctx, cliSessionId: id! })).toEqual(args);
    expect(d.applyEnv({ PI_CODING_AGENT_DIR: '/configured' }).PI_CODING_AGENT_DIR).toBe('/configured');
    expect(() => new PiDriver().bindRuntimeVersion('0.84.0')).toThrow('0.85.1');
    expect(() => new PiDriver().bindRuntimeVersion(null)).toThrow();
  });
  it('steers repeated input without correlated consumption, pauses compaction and diagnoses rejection', () => {
    const { d, reply, id } = fixture();
    expect(d.encodeStdinMessage('early', null)).toBeNull();
    expect(reply({ sessionId: id })).toEqual([{ kind: 'session_init', sessionId: id }]);
    expect(d.admissionPolicy).toBe('write-success');
    const first = JSON.parse(d.encodeStdinMessage('same', null)!);
    const second = JSON.parse(d.encodeStdinMessage('same', null)!);
    expect(first.id).not.toBe(second.id); expect(first.streamingBehavior).toBe('steer');
    expect(d.parseLine(JSON.stringify({ type: 'response', id: first.id, success: true }))).toEqual([]);
    expect(d.parseLine(JSON.stringify({ type: 'response', id: second.id, success: false, error: 'rejected' }))[0]).toMatchObject({ kind: 'error', code: 'pi_rpc_rejected', fatal: false });
    expect(d.parseLine('{"type":"compaction_start"}')).toEqual([{ kind: 'compaction_started' }]);
    expect(d.encodeStdinMessage('blocked', null)).toBeNull();
    d.parseLine('{"type":"compaction_end"}'); expect(d.readyToEncode()).toBe(true);
    expect(d.parseLine('{"type":"agent_end"}')).toEqual([]);
    expect(d.parseLine('{"type":"auto_retry_start"}')[0]).toMatchObject({ kind: 'api_response', status: 'waiting' });
    expect(d.parseLine('{"type":"auto_retry_end"}')[0]).toMatchObject({ kind: 'api_response', status: 'ready' });
    for (let i = 0; i < 300; i++) d.encodeStdinMessage('bounded diagnostics', null);
    expect(d.parseLine(JSON.stringify({ type: 'response', id: first.id, success: false, error: 'late rejection' }))[0]).toMatchObject({ kind: 'error', code: 'pi_rpc_rejected' });
    expect(d.parseLine('{"type":"agent_settled"}')[0]?.kind).toBe('turn_end');
  });
  it('validates actual thinking capability and applied value before initialization', () => {
    const { d, reply, id, lines } = fixture('high');
    expect(reply({ sessionId: id })).toEqual([]); expect(lines.at(-1).type).toBe('get_available_thinking_levels');
    expect(reply({ levels: ['off'] })[0]).toMatchObject({ kind: 'error', fatal: true });
    expect(d.readyToEncode()).toBe(false);
    const good = fixture('high'); good.reply({ sessionId: good.id }); good.reply({ levels: ['off', 'high'] });
    expect(good.lines.at(-1)).toMatchObject({ type: 'set_thinking_level', level: 'high' });
    good.reply({}); expect(good.reply({ sessionId: good.id, thinkingLevel: 'off' })[0]).toMatchObject({ fatal: true });
  });
  it('deduplicates tool starts, bounds input, and never forwards output bodies', () => {
    const { d } = fixture();
    const tool = { type: 'tool_execution_start', toolCallId: 'call', toolName: 'bash', args: { command: 'x'.repeat(50_000) } };
    const event = d.parseLine(JSON.stringify(tool))[0]!;
    expect(event.kind).toBe('tool_call'); expect(JSON.stringify(event).length).toBeLessThan(17_000);
    expect(d.parseLine(JSON.stringify(tool))).toEqual([]);
    const end = d.parseLine(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'call', toolName: 'bash', isError: false, result: { content: 'private result' } }));
    expect(end).toEqual([{ kind: 'tool_output', toolCallId: 'call', name: 'bash', outcome: 'success' }]);
    for (const e of [event, ...end]) expect(ParsedEventSchema.safeParse(e).success).toBe(true);
  });
  it('cancels extension dialogs explicitly and clears queues before abort', () => {
    const { d, lines, reply, id } = fixture(); reply({ sessionId: id });
    const event = d.parseLine('{"type":"extension_ui_request","id":"dialog","method":"confirm"}');
    expect(lines.at(-1)).toEqual({ type: 'extension_ui_response', id: 'dialog', cancelled: true });
    expect(event[0]).toMatchObject({ code: 'pi_extension_interaction_cancelled' });
    const controls = d.encodeInterruptControl().split('\n').map(x => JSON.parse(x));
    expect(controls.map(x => x.type)).toEqual(['clear_queue', 'abort']);
    expect(d.readyToEncode()).toBe(false);
    d.parseLine(JSON.stringify({ type: 'response', id: controls[1].id, success: true })); expect(d.readyToEncode()).toBe(true);
  });
});
