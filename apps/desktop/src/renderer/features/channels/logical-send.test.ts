import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/react-query';
import { MAX_MESSAGE_CONTENT_BYTES, decodeMessageSeq, decodeTransportEpoch, decodeTransportSeq, type MessageDto, type MessageSendAck } from '@silverhand/shared';
import { api, apiUpload } from '@/lib/api';
import { setCurrentUserId, clearCurrentUser } from '@/lib/current-user';
import { eventWsClient } from '@/lib/ws-client';
import { ingestConversationFrame } from '@/features/realtime/conversation-ingestor';
import { createLogicalSend, prepareLogicalSend, type LogicalSend } from './logical-send';
import { useSendMessage } from './hooks';
import { useInitiateDirectMessage } from '@/features/direct-pairs/hooks';
import { messagesKey, clusterMessagesKey, type MessagesCache } from './message-cache-core';
import { clearComposerSendAttempt, readComposerDraft, writeComposerDraft, patchComposerDraftText, clearComposerDraft } from '@/lib/composer-draft-cache';
const mock = vi.hoisted(() => ({ qc: null as unknown as QueryClient }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: vi.fn(), apiUpload: vi.fn() }));
vi.mock('@tanstack/react-query', async original => {
  const actual = await original<typeof import('@tanstack/react-query')>();
  return { ...actual, useQueryClient: () => mock.qc,
    useMutation: (options: ConstructorParameters<typeof MutationObserver>[1]) => {
      const observer = new actual.MutationObserver(mock.qc, options);
      return { mutateAsync: observer.mutate.bind(observer) };
    } };
});
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.clearAllMocks(); setCurrentUserId('u1');
  mock.qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  mock.qc.setQueryData(['me'], { id: 'u1', name: 'User', display_name: 'User', avatar_url: null });
  vi.spyOn(eventWsClient, 'markSatisfied').mockImplementation(() => {});
});
afterEach(() => { cleanups.splice(0).forEach(f => f()); mock.qc.clear(); clearCurrentUser(); vi.restoreAllMocks(); });
const key = (root: string | null = null) => root ? clusterMessagesKey('c1', root) : messagesKey('c1');
function mount(root: string | null) {
  const observer = new QueryObserver(mock.qc, { queryKey: key(root), queryFn: () => new Promise<never>(() => {}), enabled: false });
  cleanups.push(observer.subscribe(() => {}));
}
function rows(root: string | null = null) { return mock.qc.getQueryData<MessagesCache>(key(root))?.pages.flatMap(p => p.messages) ?? []; }
function committed(send: LogicalSend, id = 'm1', seq = 1): MessageDto {
  return { id, seq: decodeMessageSeq(seq), conversation_id: send.conversationId, from_kind: 'user', from_user_id: send.userId, from_agent_id: null,
    author: { status: 'active', kind: 'user', id: send.userId, name: 'User', display_name: 'User', avatar_url: null, runtime: null },
    content: 'same', metadata: null, attachments: null, created_at: 1, thread_root_id: send.threadRootId, linked_task: null, reactions: null, client_message_id: send.id };
}
function ws(message: MessageDto) {
  ingestConversationFrame(mock.qc, { type: 'event', kind: 'message', scope: `conversation:${message.conversation_id}`, seq: decodeTransportSeq(message.seq), epoch: decodeTransportEpoch('e'), payload: { message } });
}
describe('logical send through production mutation and WS ingestion', () => {
  it.each([null, 'root'])('WS before ACK replaces pending immediately in %s', async root => {
    mount(root); const send = createLogicalSend('c1', root), msg = committed(send); const http = deferred<MessageSendAck>();
    vi.mocked(api).mockReturnValue(http.promise);
    const sending = useSendMessage('c1', root).mutateAsync({ content: 'same', logicalSend: send });
    await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    expect(rows(root).map(m => m.id)).toEqual([`pending-${send.id}`]);
    ws(msg);
    expect(rows(root).map(m => m.id)).toEqual(['m1']);
    ws(msg);
    http.resolve({ message: msg }); await sending;
    expect(rows(root).map(m => m.id)).toEqual(['m1']);
  });
  it('ACK first and two deliberately identical sends retain separate identities and seq order', async () => {
    mount(null); const a = createLogicalSend('c1', null), b = createLogicalSend('c1', null); const ah = deferred<MessageSendAck>(), bh = deferred<MessageSendAck>();
    vi.mocked(api).mockImplementation((_path, options) => JSON.parse(String(options?.body)).client_message_id === a.id ? ah.promise : bh.promise);
    const first = useSendMessage('c1').mutateAsync({ content: 'same', logicalSend: a });
    const second = useSendMessage('c1').mutateAsync({ content: 'same', logicalSend: b });
    await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    bh.resolve({ message: committed(b, 'b', 2) }); await second;
    ah.resolve({ message: committed(a, 'a', 1) }); await first;
    ws(committed(a, 'a', 1)); ws(committed(b, 'b', 2));
    expect(rows().map(m => m.id)).toEqual(['a', 'b']);
  });
  it('WS confirmation makes later HTTP failure a successful send even after the window is evicted', async () => {
    mount(null); const send = createLogicalSend('c1', null), msg = committed(send), http = deferred<MessageSendAck>();
    vi.mocked(api).mockReturnValue(http.promise);
    const restoreDraft = vi.fn();
    const sending = useSendMessage('c1').mutateAsync({ content: 'same', logicalSend: send }).catch(restoreDraft);
    await vi.waitFor(() => expect(api).toHaveBeenCalled());
    ws(msg); mock.qc.removeQueries({ queryKey: key(), exact: true });
    http.reject(new Error('timeout')); await sending;
    expect(restoreDraft).not.toHaveBeenCalled();
  });
  it('unknown failure rejects and retry reuses the exact prepared request without re-normalizing', async () => {
    mount(null); const send = createLogicalSend('c1', null);
    vi.mocked(api).mockRejectedValueOnce(new Error('timeout'));
    await expect(useSendMessage('c1').mutateAsync({ content: 'first canonical', logicalSend: send })).rejects.toThrow('timeout');
    expect(rows()).toEqual([]);
    const firstBody = vi.mocked(api).mock.calls[0]![1]!.body;
    vi.mocked(api).mockResolvedValueOnce({ message: committed(send) });
    await useSendMessage('c1').mutateAsync({ content: 'resolver changed', logicalSend: send });
    expect(vi.mocked(api).mock.calls[1]![1]!.body).toBe(firstBody);
    expect(JSON.parse(String(firstBody)).client_message_id).toBe(send.id);
  });
  it('keeps the uploaded long-body attachment identity on explicit retry', async () => {
    mount(null); const send = createLogicalSend('c1', null);
    vi.mocked(apiUpload).mockResolvedValue({ id: 'text-attachment', filename: 'body.txt', size: 200000, content_type: 'text/plain' });
    vi.mocked(api).mockRejectedValueOnce(new Error('timeout'));
    await expect(useSendMessage('c1').mutateAsync({ content: 'a'.repeat(MAX_MESSAGE_CONTENT_BYTES + 1), logicalSend: send })).rejects.toThrow();
    const body = vi.mocked(api).mock.calls[0]![1]!.body;
    vi.mocked(api).mockResolvedValueOnce({ message: committed(send) });
    await useSendMessage('c1').mutateAsync({ content: 'a'.repeat(MAX_MESSAGE_CONTENT_BYTES + 1), logicalSend: send });
    expect(apiUpload).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api).mock.calls[1]![1]!.body).toBe(body);
    expect(JSON.parse(String(body)).attachment_ids).toEqual(['text-attachment']);
  });
  it('does not append another pending when a late WS already committed the retry', async () => {
    mount(null); const send = createLogicalSend('c1', null);
    vi.mocked(api).mockRejectedValueOnce(new Error('timeout'));
    await expect(useSendMessage('c1').mutateAsync({ content: 'same', logicalSend: send })).rejects.toThrow();
    ws(committed(send));
    vi.mocked(api).mockRejectedValueOnce(new Error('timeout'));
    await expect(useSendMessage('c1').mutateAsync({ content: 'same', logicalSend: send })).resolves.toMatchObject({ message: { id: 'm1' } });
    expect(rows().map(row => row.id)).toEqual(['m1']);
  });
  it.each(['user', 'conversation', 'thread', 'device', 'legacy'])('%s mismatch cannot remove pending or turn HTTP error into success', async variant => {
    mount(null); const send = createLogicalSend('c1', null), http = deferred<MessageSendAck>();
    vi.mocked(api).mockReturnValue(http.promise);
    const sending = useSendMessage('c1').mutateAsync({ content: 'same', logicalSend: send });
    const failed = expect(sending).rejects.toThrow('timeout');
    await vi.waitFor(() => expect(api).toHaveBeenCalled());
    const msg = committed(send);
    if (variant === 'user') msg.from_user_id = 'u2';
    if (variant === 'conversation') msg.conversation_id = 'other';
    if (variant === 'thread') msg.thread_root_id = 'other-root';
    if (variant === 'device') msg.client_message_id = crypto.randomUUID();
    if (variant === 'legacy') delete msg.client_message_id;
    ws(msg);
    expect(rows().some(m => m.id === `pending-${send.id}`)).toBe(true);
    http.reject(new Error('timeout')); await failed;
  });
  it('a cold window response confirms the send but a pending cache write does not', async () => {
    mount(null); const send = createLogicalSend('c1', null), http = deferred<MessageSendAck>(); vi.mocked(api).mockReturnValue(http.promise);
    const sending = useSendMessage('c1').mutateAsync({ content: 'same', logicalSend: send });
    await vi.waitFor(() => expect(api).toHaveBeenCalled());
    expect(send.confirmed).toBeUndefined();
    const current = mock.qc.getQueryData<MessagesCache>(key())!;
    mock.qc.setQueryData(key(), { ...current, pages: [{ ...current.pages[0], messages: [committed(send)] }] });
    http.reject(new Error('timeout')); await expect(sending).resolves.toMatchObject({ message: { id: 'm1' } });
  });
});
describe('first DM send identity', () => {
  it('passes the same token and content on an explicit retry through the first-send door', async () => {
    const send = createLogicalSend('c1', null);
    const input = { content: 'same', client_message_id: send.id };
    vi.mocked(api).mockRejectedValueOnce(new Error('timeout'));
    await expect(useInitiateDirectMessage('agent1').mutateAsync(input)).rejects.toThrow('timeout');
    vi.mocked(api).mockResolvedValueOnce({ message: committed(send) });
    await useInitiateDirectMessage('agent1').mutateAsync(input);
    const calls = vi.mocked(api).mock.calls;
    expect(calls[0]).toEqual(calls[1]);
    expect(JSON.parse(String(calls[0]![1]!.body))).toEqual(input);
  });
});
describe('existing draft owns retry identity', () => {
  it('shares in-flight preparation and never regenerates attachment identities on retry', async () => {
    const attempt = createLogicalSend('c1', null), prepared = deferred<{ content: string; attachment_ids: string[] }>();
    const prepare = vi.fn(() => prepared.promise);
    const a = prepareLogicalSend(attempt, prepare), b = prepareLogicalSend(attempt, prepare);
    prepared.resolve({ content: 'canonical', attachment_ids: ['a1'] });
    expect(await a).toBe(await b);
    expect(await prepareLogicalSend(attempt, prepare)).toBe(attempt.prepared);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it('rejects a reused identity after changing sender or target before optimistic writes', async () => {
    const attempt = createLogicalSend('c1', null);
    await expect(useSendMessage('c2').mutateAsync({ content: 'same', logicalSend: attempt })).rejects.toThrow('Send identity changed');
    setCurrentUserId('u2');
    await expect(useSendMessage('c1').mutateAsync({ content: 'same', logicalSend: attempt })).rejects.toThrow('Send identity changed');
    expect(api).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });
  it('retains an unedited retry across remount, drops it on edit, and allocates a new ID', () => {
    const attempt = createLogicalSend('c1', null);
    writeComposerDraft({ conversationId: 'c1', text: 'same', caret: 4, pending: [], updatedAt: 1, sendAttempt: attempt });
    expect(readComposerDraft('c1')?.sendAttempt).toBe(attempt);
    patchComposerDraftText('c1', 'edited', 6);
    expect(readComposerDraft('c1')?.sendAttempt).toBeUndefined();
    clearComposerSendAttempt('c1');
    expect(createLogicalSend('c1', null).id).not.toBe(attempt.id);
    clearComposerDraft('c1');
  });
});
