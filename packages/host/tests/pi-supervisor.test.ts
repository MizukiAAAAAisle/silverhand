import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Supervisor } from '../src/daemon/supervisor/index.js';
import { PiDriver } from '../src/drivers/pi.js';
import { createDaemonLogControl } from '../src/daemon/logger.js';
import { testStartOptions, testRuntimeStartResolveDeps } from './_helpers/runtime-start-options.js';
import type { EventFrame } from '../src/protocol.js';

// Opt-in installed-binary test: never falls back to a user's live configuration.
const binary = process.env.PI_RPC_TEST_BINARY;
describe.skipIf(!binary)('Pi installed RPC through production supervisor', () => {
  for (const scope of ['conversation', 'agent'] as const) it(`${scope}: write-success while model blocked, duplicate steer, tools and restart`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-supervisor-'));
    const config = join(dir, 'config'); mkdirSync(config);
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1000 }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } } }));
    const requests: any[] = [];
    const children: ChildProcess[] = [];
    let compactRelease: (() => void) | undefined;
    let compactHold: Promise<void> | undefined;
    let release!: () => void;
    const hold = new Promise<void>(r => { release = r; });
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      if (requests.length === 1) {
        await hold;
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate limit fixture' } }));
        return;
      }
      if (compactHold) await compactHold;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (delta: unknown, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'probe', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (requests.length === 2) {
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-tool', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'printf private-tool-output' }) } }] }, null); emit({}, 'tool_calls');
      } else { emit({ role: 'assistant', content: 'fixture response' }, null); emit({}, 'stop'); }
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    writeFileSync(join(config, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'fixture-only', models: [{ id: 'probe', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1000 }] } } }));
    const events: EventFrame[] = [];
    const noop = () => {};
    const supervisor = new Supervisor({
      emit: e => { events.push(e); },
      logger: { filePath: '/dev/null', logControl: createDaemonLogControl('error'), debug: noop, info: noop, warn: noop, error: noop, close: async () => {} },
      driverFor: () => new PiDriver(),
      resolveRuntime: async () => ({ binary: binary!, version: '0.85.1' }),
      spawnFn: (bin, args, options) => { const child = spawn(bin, [...args, '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files'], { ...options, env: { PATH: process.env.PATH, PI_CODING_AGENT_DIR: config, PI_OFFLINE: '1', PI_TELEMETRY: '0', TMPDIR: dir } }); children.push(child); return child; },
      runtimeStartResolveDeps: testRuntimeStartResolveDeps({ agentHomeRootDir: join(dir, 'agents') }),
      controlPlaneServerUrl: () => 'http://127.0.0.1:1', emitRawRuntimeOutput: false,
      runtimePidRootDir: join(dir, 'pids'), sigtermToSigkillMs: 100, sigkillTimeoutMs: 1000,
    });
    const options = scope === 'agent' ? testStartOptions({ runtime: 'pi', model: 'fixture/probe', sessionScope: 'agent' }) : testStartOptions({ runtime: 'pi', model: 'fixture/probe' });
    const runtimeScope = options.runtime_scope;
    let generation = 1;
    const deliver = (id: number, text: string) => supervisor.deliver({ conversation_id: 'c1', agent_id: 'a1', runtime_generation: generation, target: { conversation_id: 'c1', workspace: null }, spawn_options: options, delivery_ids: [id], kind: 'message', text, deliveries: [{ delivery_id: id, seq: id, presentation: { body: text, instruction: 'other' } }] }, { owner: 'fixture' });
    const consumed = (id: number) => events.some(e => e.event === 'runtime_delivery_consumed' && e.delivery_ids.includes(id));
    try {
      await deliver(1, 'kickoff');
      await vi.waitFor(() => { expect(consumed(1)).toBe(true); expect(requests.length).toBe(1); }, { timeout: 10_000 });
      await deliver(2, 'identical steer'); await vi.waitFor(() => expect(consumed(2)).toBe(true));
      await deliver(3, 'identical steer'); await vi.waitFor(() => expect(consumed(3)).toBe(true));
      // Delivery settles even though no provider response has been released.
      expect(requests.length).toBe(1);
      release();
      await vi.waitFor(() => expect(events.some(e => e.event === 'runtime_parsed_event' && e.parsed.kind === 'turn_end')).toBe(true), { timeout: 10_000 });
      expect(requests.length).toBeGreaterThanOrEqual(3);
      expect(events.some(e => e.event === 'runtime_parsed_event' && e.parsed.kind === 'api_response' && e.parsed.status === 'waiting')).toBe(true);
      expect(events.filter(e => e.event === 'runtime_delivery_consumed')).toHaveLength(3);
      expect(events.some(e => e.event === 'runtime_parsed_event' && e.parsed.kind === 'input_lifecycle')).toBe(false);
      const init = events.find(e => e.event === 'runtime_parsed_event' && e.parsed.kind === 'session_init');
      expect(init).toBeDefined();
      const parsed = events.filter(e => e.event === 'runtime_parsed_event').map(e => e.parsed);
      expect(parsed.some(e => e.kind === 'tool_call')).toBe(true);
      expect(parsed.some(e => e.kind === 'tool_output' && e.outcome === 'success')).toBe(true);
      expect(JSON.stringify(parsed)).not.toContain('"content":"private-tool-output"');
      const beforeCompaction = requests.length;
      compactHold = new Promise<void>(r => { compactRelease = r; });
      children[0]!.stdin!.write(JSON.stringify({ id: 'fixture-compact', type: 'compact' }) + '\n');
      await vi.waitFor(() => expect(events.some(e => e.event === 'runtime_parsed_event' && e.parsed.kind === 'compaction_started')).toBe(true));
      await vi.waitFor(() => expect(requests.length).toBeGreaterThan(beforeCompaction));
      await deliver(4, 'after compaction');
      expect(consumed(4)).toBe(false);
      compactHold = undefined; compactRelease!();
      await vi.waitFor(() => expect(consumed(4)).toBe(true), { timeout: 10_000 });
      await vi.waitFor(() => expect(events.filter(e => e.event === 'runtime_parsed_event' && e.parsed.kind === 'turn_end')).toHaveLength(2), { timeout: 10_000 });
      expect(events.filter(e => e.event === 'runtime_parsed_event' && e.parsed.kind === 'error')).toEqual([expect.objectContaining({ parsed: expect.objectContaining({ message: expect.stringContaining('rate limit fixture') }) })]);
      expect(JSON.stringify(requests.at(-1).messages)).toContain('after compaction');
      await supervisor.stop({ runtime_scope: runtimeScope, runtime_generation: 1, mode: 'hard' });
      if (init?.event !== 'runtime_parsed_event' || init.parsed.kind !== 'session_init') throw Error('missing session');
      options.driver.cli_session_id = init.parsed.sessionId;
      generation = 2;
      await deliver(5, 'resumed input');
      await vi.waitFor(() => expect(consumed(5)).toBe(true), { timeout: 10_000 });
      await vi.waitFor(() => expect(JSON.stringify(requests.at(-1).messages)).toContain('resumed input'), { timeout: 10_000 });
      expect(JSON.stringify(requests.at(-1).messages)).toContain('after compaction');
      const sessions = events.filter(e => e.event === 'runtime_parsed_event' && e.parsed.kind === 'session_init');
      expect(sessions).toHaveLength(2);
      await vi.waitFor(() => expect(events.filter(e => e.event === 'runtime_parsed_event' && e.parsed.kind === 'turn_end')).toHaveLength(3));
      compactHold = new Promise<void>(r => { compactRelease = r; });
      await deliver(6, 'active cancellation');
      await vi.waitFor(() => expect(JSON.stringify(requests.at(-1).messages)).toContain('active cancellation'));
      await deliver(7, 'queued cancellation');
      await vi.waitFor(() => expect(consumed(7)).toBe(true));
      const requestCount = requests.length;
      await supervisor.stop({ runtime_scope: runtimeScope, runtime_generation: generation, mode: 'hard' });
      expect(children[1]!.exitCode !== null || children[1]!.signalCode !== null).toBe(true);
      compactHold = undefined; compactRelease!();
      expect(requests.length).toBe(requestCount);
      expect(events.filter(e => e.event === 'runtime_delivery_consumed' && e.delivery_ids.includes(7))).toHaveLength(1);

    } finally {
      release(); compactRelease?.(); await supervisor.stop({ runtime_scope: runtimeScope, runtime_generation: generation, mode: 'hard' }).catch(() => {});
      server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
