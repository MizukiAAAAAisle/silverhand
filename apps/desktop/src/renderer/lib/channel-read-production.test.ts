import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { decodeMessageSeq } from '@silverhand/shared';
import { streamSourceAtSeq, mainlineStreamSourceHead } from '../features/attention/observe';

it('the actual channel mutation pins a seen tail instead of swallowing a later server head', async () => {
  const source = readFileSync(new URL('../features/channels/hooks.ts', import.meta.url), 'utf8');
  const from = source.indexOf('export function useMarkMessageChannelRead()');
  const end = source.indexOf('/**', from + 1);
  expect(from).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(from);
  const calls: unknown[] = [];
  const settle = vi.fn();
  const code = ts.transpileModule(source.slice(from, end).replace('export function', 'function'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mutation = vm.runInNewContext(`${code}; useMarkMessageChannelRead()`, {
    useQueryClient: () => ({}), useMutation: (options: unknown) => options,
    postObserve: async (sources: unknown) => { calls.push(sources); return {}; },
    streamSourceAtSeq, mainlineStreamSourceHead,
    reconcileUnreadAfterObserveIfRealtimeUnavailable: () => {},
    settleStreamUnreadAfterObserve: settle,
  });
  const params = { id: 'channel', snapshotSeq: decodeMessageSeq(22) };
  const result = await mutation.mutationFn(params);
  mutation.onSuccess(result, params);
  // Even if the server has reached 23 by the retry, the HTTP request still says 22.
  expect(calls).toEqual([[streamSourceAtSeq('channel', null, decodeMessageSeq(22))]]);
  expect(settle.mock.calls[0]?.[1]).toEqual(calls[0]);
  await mutation.mutationFn('channel');
  expect(calls[1]).toEqual([mainlineStreamSourceHead('channel')]);
});

it('the actual ChannelView effect gates membership and binds recovery to effect cleanup', () => {
  const source = readFileSync(new URL('../components/layout/ChannelView.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('const lastMarkedRef =');
  const effect = source.slice(start, source.indexOf('const { data: agents', start));
  expect(effect).toContain('if (!gate.allowMemberEffects) return');
  expect(effect).toContain('return observeVisibleTail(next,');
  expect(effect).toContain('snapshotSeq: mark.seq');
  expect(effect).not.toContain('lastMarkedRef.current = next');
});
