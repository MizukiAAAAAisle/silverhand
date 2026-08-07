# Client performance testing

This runbook defines the repeatable renderer baseline for Silverhand Desktop.
It separates diagnosis from acceptance: `pnpm dev` is the convenient CDP/HMR
lane, while production-bundle and packaged runs are the only baseline-eligible
lanes.

## Three lanes

| Lane | Purpose | CDP | Baseline eligible |
| --- | --- | --- | --- |
| `dev` | Find React/layout/JS causes quickly | defaults to `127.0.0.1:9222` | No — HMR, source maps and Strict Mode distort the result |
| `release-profile` | Fast repeatable production-renderer comparison | opt in with `SILVERHAND_REMOTE_DEBUG_PORT` | Yes, for engineering regression checks |
| `release` | Final user-like acceptance on the packaged `.app` | opt in with the same env var | Yes; this is the release verdict |

CDP is local-only. `apps/desktop/src/main/index.ts` binds the debugging endpoint
to `127.0.0.1`; packaged builds expose nothing unless the environment variable
is explicitly set.

## Reference environment

Keep these fixed across runs:

- AC power, Low Power Mode off, no thermal throttling;
- same Mac, display refresh rate, window size and theme;
- source tree frozen for the entire trace (no HMR during a measured phase);
- close unrelated CPU/GPU-heavy apps;
- one warm-up run, then at least five recorded runs for exploration and ten for
  a baseline decision;
- compare the same scenario, fixture version, app commit and lane.

Do not compare a dev number to release-profile or packaged release. The JSON
report records the lane. Dev reports and attached production processes are
marked `baseline_eligible: false`; only the harness-owned isolated `profile`
command can emit an eligible baseline.

## Build and run

List renderer targets on an already-running dev app:

```bash
pnpm perf:client targets
```

Run a diagnostic scenario against dev. This is read-only: attached mode never
seeds data because it cannot prove which `SILVERHAND_DIR` owns the target. Open
the chat channel you want to profile first; the harness derives its workspace
and channel ids from the current hash route. If the app is on another section,
pass both ids explicitly with `--workspace-id` and `--channel-id`.

```bash
pnpm perf:client run --mode dev --scenario chat-core
```

For a repeatable production-renderer profile, build once and let the harness
own an isolated app process and data root:

```bash
pnpm --filter @silverhand/desktop build
pnpm perf:client profile \
  --mode release-profile \
  --profile-dir /tmp/silverhand-perf-v1 \
  --scenario chat-core
```

The profile command has three write guards:

1. `--profile-dir` must be absolute;
2. its basename must contain `silverhand-perf`;
3. a non-empty directory must carry the harness marker file.

Only the harness-owned process is seeded. It gets a versioned workspace with
240 deterministic messages and 120 deterministic tasks; acknowledged progress
is saved in that isolated renderer profile so an interrupted seed can resume.
For a formal baseline after an interrupted seed, discard the isolated profile
and create a fresh one rather than assuming an in-flight write did not commit.
Never point this command at a normal dogfood data root.

Run the packaged executable for the final acceptance lane (the executable is
inside the `.app`, not the bundle directory):

```bash
pnpm perf:client profile \
  --mode release \
  --executable "apps/desktop/release/mac-arm64/Silverhand.app/Contents/MacOS/Silverhand" \
  --profile-dir /tmp/silverhand-perf-release-v1 \
  --scenario task-core
```

Available scenarios are `chat-core`, `task-core`, and `shell-smoke`. Reports and
Chrome traces default to `/tmp/silverhand-client-performance/`; use `--output`
to choose another directory. Traces open in Chrome DevTools Performance or
<https://ui.perfetto.dev/>.

## Metrics and reading order

Each phase records:

- action to two animation frames for automated navigation/click/type actions;
- frame-gap p50/p95/p99/max and counts above 16.7/33.3/50 ms;
- Long Task count, total and distribution;
- Event Timing duration where Chromium exposes it;
- cumulative layout shift without recent input;
- JS heap and DOM-node before/after deltas;
- a raw Chrome trace for attribution to scripting, style, layout, paint or GPU.

For manual scroll/drag phases, `action_to_paint_ms` is deliberately `null`: the
harness cannot know the exact physical input timestamp, and inventing one would
look precise while being false. Frame gaps, long tasks and the raw trace remain
valid for those windows.

Judge a regression in this order: user-visible frame stalls and action latency,
then long-task attribution, then retained heap/DOM growth. A single run is a
lead, not a verdict. Reproduce it across the recorded run set and use the trace
to identify the responsible component before changing code.

## Current scope

The first harness covers channel load/re-entry, composer rendering, history
scroll, task-board load, detail open, drag, repeated Chat↔Task navigation and a
lightweight Members/Computers/idle smoke. Live token streaming and very large
attachment/image decode need a controlled runtime producer, so they remain a
separate follow-up rather than being simulated with a different rendering path.
