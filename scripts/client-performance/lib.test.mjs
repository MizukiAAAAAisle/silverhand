import assert from 'node:assert/strict';
import test from 'node:test';
import {
  interpolate,
  nearestRank,
  summarizePhase,
  validateScenario,
} from './lib.mjs';

test('nearestRank reports the observed percentile without interpolation', () => {
  assert.equal(nearestRank([8, 1, 4, 2, 16], 0.5), 4);
  assert.equal(nearestRank([8, 1, 4, 2, 16], 0.95), 16);
  assert.equal(nearestRank([], 0.95), null);
});

test('summarizePhase keeps raw-performance axes separate', () => {
  assert.deepEqual(
    summarizePhase({
      actionToPaintMs: 24.222,
      measuredMs: 1000,
      frameGapsMs: [8, 17, 34, 51],
      longTasksMs: [60, 90],
      eventDurationsMs: [8, 24],
      layoutShiftScore: 0.01234,
      heapBeforeBytes: 100,
      heapAfterBytes: 140,
      domNodesBefore: 10,
      domNodesAfter: 12,
    }),
    {
      action_to_paint_ms: 24.22,
      measured_ms: 1000,
      frames: 4,
      frame_gap_ms: { count: 4, p50: 17, p95: 51, p99: 51, max: 51 },
      frames_over_16_7_ms: 3,
      frames_over_33_3_ms: 2,
      frames_over_50_ms: 1,
      long_tasks: {
        count: 2,
        total_ms: 150,
        duration_ms: { count: 2, p50: 60, p95: 90, p99: 90, max: 90 },
      },
      event_duration_ms: { count: 2, p50: 8, p95: 24, p99: 24, max: 24 },
      layout_shift_score: 0.01234,
      heap_before_bytes: 100,
      heap_after_bytes: 140,
      heap_delta_bytes: 40,
      dom_nodes_before: 10,
      dom_nodes_after: 12,
    },
  );
});

test('scenario validation rejects duplicate phase ids and unknown actions', () => {
  const base = {
    schema_version: 1,
    id: 'chat',
    title: 'Chat',
    phases: [
      {
        id: 'open',
        label: 'Open',
        settle_ms: 100,
        observe_ms: 200,
        action: { kind: 'navigate', path: '/chat' },
      },
    ],
  };
  assert.equal(validateScenario(base).id, 'chat');
  assert.throws(
    () => validateScenario({ ...base, phases: [...base.phases, base.phases[0]] }),
    /duplicate phase id/,
  );
  assert.throws(
    () => validateScenario({ ...base, phases: [{ ...base.phases[0], action: { kind: 'magic' } }] }),
    /unsupported action/,
  );
  assert.equal(
    validateScenario({
      ...base,
      phases: [
        {
          ...base.phases[0],
          action: { kind: 'sidebar', sidebar: 'workspace', visible: false },
        },
      ],
    }).phases[0].action.kind,
    'sidebar',
  );
  assert.throws(
    () =>
      validateScenario({
        ...base,
        phases: [
          {
            ...base.phases[0],
            action: { kind: 'sidebar', sidebar: 'wrong', visible: false },
          },
        ],
      }),
    /action.sidebar must be/,
  );
});

test('fixture interpolation fails closed on unknown keys', () => {
  assert.equal(
    interpolate('/chat/w/{{workspaceId}}/c/{{channelId}}', {
      workspaceId: 'w1',
      channelId: 'c1',
    }),
    '/chat/w/w1/c/c1',
  );
  assert.throws(() => interpolate('{{missing}}', {}), /does not define missing/);
});
