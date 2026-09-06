import { describe, expect, it } from 'vitest';
import { MAX_FRAME_BYTES, MAX_WORKSPACE_FILE_FRAME_BYTES, encodeFrame, splitNdjson } from '../src/protocol.js';
import { encodeOutboundFrame, type OutboundDaemonToServerCommandResponseFrame } from '../src/outbound-protocol.js';
import { HostClient } from '../src/client/index.js';
import { createFakeTransportPair } from './_helpers/fake-transport.js';

const command = { direction: 'server_to_daemon', type: 'command', id: 'read-1', kind: 'agent_workspace_file_read', params: { agent_id: 'agent', path: 'MEMORY.md' } } as const;
const result = (content: string) => ({ ok: true as const, file: { path: 'MEMORY.md', content, size: Buffer.byteLength(content), mtime: 1700000000123.456, truncated: false } });
const response = (content: string) => ({ direction: 'daemon_to_server', type: 'command_response', id: command.id, kind: command.kind, result: result(content) } as const);

describe('workspace result encoded budget', () => {
  it.each(['\u0001', '"', '\\', '界'])('carries a 512KiB preview with full envelope (%s)', char => {
    const content = char.repeat(Math.floor(512 * 1024 / Buffer.byteLength(char)));
    const frame = response(content);
    const wire = encodeOutboundFrame(frame, command);
    expect(Buffer.byteLength(wire)).toBeLessThan(MAX_WORKSPACE_FILE_FRAME_BYTES);
    expect(JSON.parse(wire).result).toEqual(result(content));
    const local = encodeFrame({ id: command.id, result: frame.result }, command.kind);
    const split = splitNdjson('', local.slice(0, 1000), MAX_WORKSPACE_FILE_FRAME_BYTES);
    const rest = splitNdjson(split.leftover, local.slice(1000), MAX_WORKSPACE_FILE_FRAME_BYTES);
    expect(rest.overflow).toBe(false);
    expect(JSON.parse(rest.frames[0]!).result).toEqual(frame.result);
  });
  it('counts the complete envelope at exact 4MiB and rejects cap+1', () => {
    const empty = response('');
    const overhead = Buffer.byteLength(JSON.stringify(empty));
    // Keep metadata fixed so the envelope remains exactly the measured size.
    const exact = { ...empty, result: { ...empty.result, file: { ...empty.result.file, content: 'x'.repeat(MAX_WORKSPACE_FILE_FRAME_BYTES - overhead) } } };
    expect(Buffer.byteLength(encodeOutboundFrame(exact, command))).toBe(MAX_WORKSPACE_FILE_FRAME_BYTES);
    exact.result.file.content += 'x';
    expect(() => encodeOutboundFrame(exact, command)).toThrow();
    expect(splitNdjson('', 'x'.repeat(MAX_WORKSPACE_FILE_FRAME_BYTES + 1), MAX_WORKSPACE_FILE_FRAME_BYTES).overflow).toBe(true);
  });
  it('a claimed kind, wrong id, other pending command, error or request cannot obtain the allowance', () => {
    const frame = response('\u0001'.repeat(512 * 1024));
    expect(() => encodeOutboundFrame(frame)).toThrow();
    expect(() => encodeOutboundFrame(frame, { ...command, id: 'other' })).toThrow();
    expect(() => encodeOutboundFrame(frame, { ...command, kind: 'host_status', params: {} })).toThrow();
    expect(() => encodeOutboundFrame({ ...frame, result: undefined, error: { code: 'internal_error', message: 'x'.repeat(MAX_FRAME_BYTES) } } as unknown as OutboundDaemonToServerCommandResponseFrame, command)).toThrow();
    expect(() => encodeFrame({ id: 'request', intent: 'echo', params: { message: 'x'.repeat(MAX_FRAME_BYTES) } }, command.kind)).toThrow();
  });
  it('ordinary complete frames still stop at 1MiB', () => {
    const overhead = Buffer.byteLength(JSON.stringify({ id: '1', result: '' }));
    expect(Buffer.byteLength(encodeFrame({ id: '1', result: 'x'.repeat(MAX_FRAME_BYTES - overhead) }).trimEnd())).toBe(MAX_FRAME_BYTES);
    expect(() => encodeFrame({ id: '1', result: 'x'.repeat(MAX_FRAME_BYTES - overhead + 1) })).toThrow();
  });
  it.each([true, false])('HostClient correlates large results with its pending intent: %s', async workspace => {
    const { transport, peer } = createFakeTransportPair();
    const client = new HostClient({ transportFactory: () => transport });
    await client.connect();
    const pending = workspace ? client.call(command.kind, command.params) : client.echo('small');
    const checked = workspace ? expect(pending).resolves.toEqual(result('\u0001'.repeat(512 * 1024))) : expect(pending).rejects.toMatchObject({ code: 'disconnected' });
    await new Promise(setImmediate);
    peer.send({ id: peer.received[0]!.id, result: result('\u0001'.repeat(512 * 1024)) });
    await checked;
    await client.close();
  });
});
