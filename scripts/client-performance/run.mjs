#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { arch, cpus, freemem, hostname, platform, release, totalmem } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { CdpClient } from './cdp-client.mjs';
import {
  REPORT_SCHEMA_VERSION,
  interpolate,
  loadScenario,
  summarizePhase,
} from './lib.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const DEFAULT_CDP = 'http://127.0.0.1:9222';
const DEFAULT_OUT_ROOT = '/tmp/silverhand-client-performance';
const PROFILE_MARKER = '.silverhand-client-performance-profile-v2.json';
const FIXTURE_VERSION = 2;
const FIXTURE_SCALES = Object.freeze({
  smoke: { chatMessageCount: 240, threadReplyCount: 50, taskCount: 120 },
  standard: { chatMessageCount: 2_000, threadReplyCount: 450, taskCount: 500 },
  stress: { chatMessageCount: 10_000, threadReplyCount: 1_200, taskCount: 2_000 },
});

const [command = 'help', ...argv] = process.argv.slice(2);
const args = parseArgs(argv);

try {
  switch (command) {
    case 'targets':
      await printTargets(args);
      break;
    case 'run':
      await runAttached(args);
      break;
    case 'profile':
      await runOwnedProfile(args);
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      fail(`unknown command ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function printTargets(options) {
  const endpoint = cdpEndpoint(options);
  const targets = await fetchTargets(endpoint);
  for (const target of targets) {
    console.log(`${target.id}\t${target.type}\t${target.title}\t${target.url}`);
  }
}

async function runAttached(options) {
  const mode = requiredMode(options);
  if (options.unminified === true) {
    fail('--unminified is only available for an owned release-profile build');
  }
  if (mode === 'release-profile' || mode === 'release') {
    console.warn(
      'Attached mode cannot prove which SILVERHAND_DIR the target owns; fixture seeding is disabled. ' +
        'Use `profile` for an isolated, deterministic baseline.',
    );
  }
  const scenarioPath = scenarioFile(options.scenario);
  const scenario = await loadScenario(scenarioPath);
  assertInteractiveCompatibility(scenario, options);
  const endpoint = cdpEndpoint(options);
  const target = await pickTarget(endpoint);
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    const fixture = await attachedFixture(client, options);
    await runScenario({
      client,
      target,
      endpoint,
      scenario,
      scenarioPath,
      mode,
      fixture,
      options,
    });
  } finally {
    client.close();
  }
}

async function attachedFixture(client, options) {
  const explicitWorkspace = options['workspace-id'];
  const explicitChannel = options['channel-id'];
  if (explicitWorkspace !== undefined || explicitChannel !== undefined) {
    if (typeof explicitWorkspace !== 'string' || typeof explicitChannel !== 'string') {
      fail('--workspace-id and --channel-id must be supplied together');
    }
    return { workspaceId: explicitWorkspace, chatChannelId: explicitChannel };
  }
  const hash = await evaluate(client, 'location.hash');
  const match = /^#\/chat\/w\/([^/]+)\/c\/([^/?]+)/.exec(hash);
  return match
    ? {
        workspaceId: decodeURIComponent(match[1]),
        chatChannelId: decodeURIComponent(match[2]),
      }
    : {};
}

async function runOwnedProfile(options) {
  const mode = requiredMode(options);
  if (mode === 'dev') {
    fail('`profile` owns an isolated production process; use `run --mode dev` for HMR diagnosis');
  }
  if (options.unminified === true && mode !== 'release-profile') {
    fail('--unminified is only available for release-profile');
  }
  const scale = fixtureScale(options.scale);
  const profileDir = await prepareProfileDir(required(options, 'profile-dir'), scale);
  const port = parsePort(options.port ?? '9233');
  const endpoint = `http://127.0.0.1:${port}`;
  const scenarioPath = scenarioFile(options.scenario);
  const scenario = await loadScenario(scenarioPath);
  assertInteractiveCompatibility(scenario, options);
  if (mode === 'release-profile') {
    await prepareHostBundle();
    await prepareElectronBinding();
  }
  const child = launchProfileProcess({
    mode,
    profileDir,
    port,
    executable: options.executable,
    unminified: options.unminified === true,
  });
  const shutdown = () => {
    if (!child.killed) child.kill('SIGTERM');
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    const target = await waitForTarget(endpoint, 45_000);
    const client = await CdpClient.connect(target.webSocketDebuggerUrl);
    try {
      await waitForAuthenticatedRenderer(client, 30_000);
      const fixture = await seedFixture(client, scale);
      await waitForRendererIdle(client);
      await runScenario({
        client,
        target,
        endpoint,
        scenario,
        scenarioPath,
        mode,
        fixture,
        options,
        profileDir,
      });
    } finally {
      client.close();
    }
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    shutdown();
  }
}

async function prepareElectronBinding() {
  await runPreparation(
    'Preparing better-sqlite3 for Electron ABI…',
    'Electron ABI preparation',
    'bash',
    [join(import.meta.dirname, 'prepare-electron-binding.sh')],
  );
}

async function prepareHostBundle() {
  await runPreparation(
    'Building the host daemon bundle used by release-profile…',
    'Host daemon build',
    'pnpm',
    ['--filter', '@silverhand/host', 'build'],
  );
}

async function runPreparation(message, label, program, args) {
  console.log(message);
  const child = spawn(program, args, {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  const exitCode = await new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('exit', resolvePromise);
  });
  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${String(exitCode)}`);
  }
}

function assertInteractiveCompatibility(scenario, options) {
  if (options.yes === true && scenario.phases.some(phase => phase.action.kind === 'manual')) {
    fail('--yes cannot run a scenario with manual phases; their input window would measure idle time');
  }
}

async function runScenario(context) {
  const { client, scenario, mode, fixture, target, endpoint, options } = context;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = resolve(
    String(options.output ?? join(DEFAULT_OUT_ROOT, `${timestamp}-${scenario.id}-${mode}`)),
  );
  await mkdir(outputDir, { recursive: true });

  await client.send('Runtime.enable');
  await client.send('Performance.enable');
  const retainedHeap = options['retained-heap'] === true;
  const cpuProfileEnabled = options['cpu-profile'] === true;
  const jsCoverageEnabled = options['js-coverage'] === true;
  if (retainedHeap) await client.send('HeapProfiler.enable');
  if (cpuProfileEnabled || jsCoverageEnabled) await client.send('Profiler.enable');
  await evaluate(client, installProbeSource());
  const browser = await client.send('Browser.getVersion');
  const renderer = await evaluate(client, rendererMetadataSource());

  const traceEnabled = options.trace !== false;
  let trace = null;
  if (traceEnabled) {
    trace = await beginTrace(client, join(outputDir, 'trace.json'));
  }

  const interactive = options.yes !== true;
  const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;
  if (interactive) {
    console.log('\nInteractive phase control stays in this terminal; the App window does not show prompts.');
  }
  const phases = [];
  try {
    for (const phase of scenario.phases) {
      console.log(`\n[${phase.id}] ${phase.label}`);
      if (phase.action.kind === 'manual') console.log(phase.action.instruction);
      if (rl) await rl.question('Press Enter when ready to start this phase… ');
      const prepared = interpolateAction(phase.action, fixture);
      if (retainedHeap) await client.send('HeapProfiler.collectGarbage');
      const heapBeforeBytes = await readHeapUsage(client);
      if (cpuProfileEnabled) await client.send('Profiler.start');
      if (jsCoverageEnabled) {
        await client.send('Profiler.startPreciseCoverage', {
          callCount: true,
          detailed: true,
          allowTriggeredUpdates: false,
        });
      }
      let raw;
      let cpuProfile = null;
      let jsCoverage = null;
      try {
        raw = await evaluate(
          client,
          phaseSource(phase.id, prepared, phase.settle_ms, phase.observe_ms),
        );
      } finally {
        if (jsCoverageEnabled) {
          const coverage = await client.send('Profiler.takePreciseCoverage');
          jsCoverage = coverage.result;
          await client.send('Profiler.stopPreciseCoverage');
        }
        if (cpuProfileEnabled) {
          const stopped = await client.send('Profiler.stop');
          cpuProfile = stopped.profile;
        }
      }
      if (retainedHeap) await client.send('HeapProfiler.collectGarbage');
      const heapAfterBytes = await readHeapUsage(client);
      const summary = summarizePhase({ ...raw, heapBeforeBytes, heapAfterBytes });
      phases.push({ id: phase.id, label: phase.label, action: prepared, metrics: summary });
      if (cpuProfile) {
        await writeFile(
          join(outputDir, `cpu-profile-${phase.id}.cpuprofile`),
          `${JSON.stringify(cpuProfile)}\n`,
          'utf8',
        );
      }
      if (jsCoverage) {
        await writeFile(
          join(outputDir, `js-coverage-${phase.id}.json`),
          `${JSON.stringify(jsCoverage)}\n`,
          'utf8',
        );
      }
      console.log(formatPhaseSummary(summary));
    }
  } finally {
    rl?.close();
    await evaluate(client, `globalThis.__silverhandClientPerfV1?.stop()`);
    if (trace) await endTrace(client, trace.completion);
  }

  const report = {
    schema_version: REPORT_SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    mode,
    baseline_eligible:
      mode !== 'dev' &&
      context.profileDir !== undefined &&
      !retainedHeap &&
      !cpuProfileEnabled &&
      !jsCoverageEnabled &&
      options.unminified !== true,
    heap_measurement: retainedHeap ? 'post_gc' : 'ambient',
    instrumentation: {
      cpu_profile: cpuProfileEnabled,
      js_coverage: jsCoverageEnabled,
      unminified_build: options.unminified === true,
    },
    scenario: { id: scenario.id, title: scenario.title, source: context.scenarioPath },
    fixture: Object.keys(fixture).length === 0 ? null : fixture,
    profile_dir: context.profileDir ?? null,
    cdp: { endpoint, target_id: target.id, title: target.title, url: target.url },
    environment: {
      host: hostname(),
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu_model: cpus()[0]?.model ?? null,
      cpu_count: cpus().length,
      total_memory_bytes: totalmem(),
      free_memory_bytes_at_start: freemem(),
      browser,
      renderer,
    },
    phases,
  };
  await writeFile(join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nReport: ${join(outputDir, 'report.json')}`);
  if (traceEnabled) console.log(`Trace:  ${join(outputDir, 'trace.json')}`);
}

function launchProfileProcess({ mode, profileDir, port, executable, unminified }) {
  const env = {
    ...process.env,
    SILVERHAND_DIR: profileDir,
    SILVERHAND_REMOTE_DEBUG_PORT: String(port),
  };
  // Electron's own CLI uses this variable internally, but inheriting it into
  // the profiled app makes the Electron binary behave like plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  if (unminified) env.SILVERHAND_MINIFY = 'false';
  let program;
  let childArgs;
  if (mode === 'release-profile') {
    program = 'pnpm';
    childArgs = ['--filter', '@silverhand/desktop', 'start'];
  } else {
    const path = required({ executable }, 'executable');
    program = resolve(path);
    childArgs = [];
  }
  console.log(`Launching ${mode} with isolated profile ${profileDir}`);
  return spawn(program, childArgs, { cwd: ROOT, env, stdio: 'inherit' });
}

async function prepareProfileDir(raw, scale) {
  const dir = resolve(raw);
  if (!isAbsolute(raw)) fail('--profile-dir must be an absolute path');
  if (!basename(dir).includes('silverhand-perf')) {
    fail('--profile-dir basename must contain "silverhand-perf" (destructive-profile guard)');
  }
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir);
  if (entries.length > 0 && !entries.includes(PROFILE_MARKER)) {
    fail(`${dir} is non-empty and was not created by this harness`);
  }
  const marker = join(dir, PROFILE_MARKER);
  if (!entries.includes(PROFILE_MARKER)) {
    await writeFile(
      marker,
      `${JSON.stringify(
        { schema_version: 2, fixture_scale: scale, created_at: new Date().toISOString() },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  } else {
    const parsed = JSON.parse(await readFile(marker, 'utf8'));
    if (parsed.schema_version !== 2) fail(`${marker} has an unsupported schema_version`);
    if (parsed.fixture_scale !== scale) {
      fail(
        `${dir} belongs to fixture scale ${String(parsed.fixture_scale)}; ` +
          `use a different profile directory for ${scale}`,
      );
    }
  }
  return dir;
}

async function seedFixture(client, scale) {
  const counts = FIXTURE_SCALES[scale];
  console.log(
    `Preparing ${scale} fixture (${counts.chatMessageCount} mainline messages / ` +
      `${counts.threadReplyCount} thread replies / ${counts.taskCount} tasks)…`,
  );
  return evaluate(client, fixtureSeedSource(scale, counts));
}

async function waitForRendererIdle(client) {
  await evaluate(
    client,
    `(async () => {
      await new Promise(resolve => {
        if ('requestIdleCallback' in globalThis) {
          requestIdleCallback(resolve, { timeout: 5000 });
        } else {
          setTimeout(resolve, 1000);
        }
      });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return true;
    })()`,
  );
}

async function waitForAuthenticatedRenderer(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(
        client,
        `(async () => globalThis.silverhand?.getAuthState ? await globalThis.silverhand.getAuthState() : null)()`,
      );
      if (last?.status === 'authenticated') return;
    } catch {
      // Renderer/preload may still be loading.
    }
    await sleep(250);
  }
  throw new Error(`renderer did not authenticate within ${timeoutMs}ms (last=${JSON.stringify(last)})`);
}

function fixtureSeedSource(scale, counts) {
  const config = JSON.stringify({
    version: FIXTURE_VERSION,
    scale,
    workspaceName: `client-perf-v${FIXTURE_VERSION}-${scale}`,
    ...counts,
  });
  return `(${async function seed(config) {
    const storageKey = `silverhand.client-performance.fixture.v${config.version}`;
    const request = async (path, init = {}) => {
      const response = await globalThis.silverhand.backendRequest({
        path,
        method: init.method,
        headers: init.bodyText ? { 'Content-Type': 'application/json' } : {},
        bodyText: init.bodyText,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}: ${response.bodyText ?? ''}`);
      }
      return response.status === 204 || !response.bodyText
        ? null
        : JSON.parse(response.bodyText);
    };
    const savedRaw = localStorage.getItem(storageKey);
    let state = savedRaw ? JSON.parse(savedRaw) : null;
    if (!state) {
      const list = await request('/api/workspaces');
      const collision = list.workspaces.find(workspace => workspace.name === config.workspaceName);
      if (collision) {
        throw new Error(
          `workspace ${config.workspaceName} exists without fixture state; use a fresh isolated profile`,
        );
      }
      const created = await request('/api/workspaces', {
        method: 'POST',
        bodyText: JSON.stringify({
          name: config.workspaceName,
          description: 'Deterministic client-performance fixture. Safe to delete.',
          member_agent_ids: [],
          member_user_ids: [],
        }),
      });
      state = {
        version: config.version,
        scale: config.scale,
        workspaceId: created.workspace.id,
        chatChannelId: created.channel.id,
        threadRootId: null,
        threadRepliesSeeded: 0,
        chatMessagesSeeded: 0,
        tasksSeeded: 0,
        complete: false,
      };
      localStorage.setItem(storageKey, JSON.stringify(state));
    }
    if (state.version !== config.version || state.scale !== config.scale) {
      throw new Error('fixture state version/scale mismatch');
    }
    const save = () => localStorage.setItem(storageKey, JSON.stringify(state));
    if (!state.threadRootId) {
      const root = await request(`/api/channels/${state.chatChannelId}/messages`, {
        method: 'POST',
        bodyText: JSON.stringify({
          content: 'Fixture thread root — long-thread renderer baseline.',
          attachment_ids: [],
        }),
      });
      if (typeof root?.message?.id !== 'string') {
        throw new Error('thread root create returned no message id');
      }
      state.threadRootId = root.message.id;
      state.threadRepliesSeeded = 0;
      save();
    }
    for (
      let batchStart = state.threadRepliesSeeded;
      batchStart < config.threadReplyCount;
      batchStart += 16
    ) {
      const batchEnd = Math.min(batchStart + 16, config.threadReplyCount);
      await Promise.all(
        Array.from({ length: batchEnd - batchStart }, async (_unused, offset) => {
          const index = batchStart + offset;
          await request(`/api/channels/${state.chatChannelId}/messages`, {
            method: 'POST',
            bodyText: JSON.stringify({
              content: `Fixture thread reply ${String(index + 1).padStart(4, '0')} — long-thread payload.`,
              attachment_ids: [],
              reply_to_message_id: state.threadRootId,
            }),
          });
        }),
      );
      state.threadRepliesSeeded = batchEnd;
      save();
    }
    for (
      let batchStart = state.chatMessagesSeeded;
      batchStart < config.chatMessageCount;
      batchStart += 16
    ) {
      const batchEnd = Math.min(batchStart + 16, config.chatMessageCount);
      await Promise.all(
        Array.from({ length: batchEnd - batchStart }, async (_unused, offset) => {
          const index = batchStart + offset;
          const paragraph =
            index % 7 === 0
              ? "\n\n- deterministic list item\n- second list item\n\n`const frame = performance.now()`"
              : '';
          await request(`/api/channels/${state.chatChannelId}/messages`, {
            method: 'POST',
            bodyText: JSON.stringify({
              content: `Fixture message ${String(index + 1).padStart(5, '0')} — renderer baseline payload.${paragraph}`,
              attachment_ids: [],
            }),
          });
        }),
      );
      state.chatMessagesSeeded = batchEnd;
      save();
    }
    for (let batchStart = state.tasksSeeded; batchStart < config.taskCount; batchStart += 8) {
      const batchEnd = Math.min(batchStart + 8, config.taskCount);
      await Promise.all(
        Array.from({ length: batchEnd - batchStart }, async (_unused, offset) => {
          const index = batchStart + offset;
          await request('/api/tasks', {
            method: 'POST',
            bodyText: JSON.stringify({
              title: `Fixture task ${String(index + 1).padStart(4, '0')}`,
              body: `Deterministic task body ${index + 1}.`,
              conversation_id: state.chatChannelId,
            }),
          });
        }),
      );
      state.tasksSeeded = batchEnd;
      save();
    }
    state.complete = true;
    save();
    return {
      fixtureVersion: state.version,
      fixtureScale: state.scale,
      workspaceId: state.workspaceId,
      chatChannelId: state.chatChannelId,
      threadRootId: state.threadRootId,
      chatMessageCount: state.chatMessagesSeeded,
      threadReplyCount: state.threadRepliesSeeded,
      taskCount: state.tasksSeeded,
    };
  }})(${config})`;
}

function installProbeSource() {
  return `(${function install() {
    globalThis.__silverhandClientPerfV1?.stop?.();
    const state = {
      active: false,
      startedAt: 0,
      phaseId: null,
      frameGapsMs: [],
      longTasksMs: [],
      eventDurationsMs: [],
      layoutShiftScore: 0,
      domNodesBefore: null,
      raf: 0,
      lastFrameAt: null,
      observers: [],
    };
    const observe = (type, callback, options = {}) => {
      try {
        const observer = new PerformanceObserver(list => callback(list.getEntries()));
        observer.observe({ type, buffered: false, ...options });
        state.observers.push(observer);
      } catch {
        // Chromium can omit optional entry types; absence stays explicit in the report.
      }
    };
    observe('longtask', entries => {
      if (state.active) state.longTasksMs.push(...entries.map(entry => entry.duration));
    });
    observe('layout-shift', entries => {
      if (!state.active) return;
      for (const entry of entries) {
        if (!entry.hadRecentInput) state.layoutShiftScore += entry.value;
      }
    });
    observe(
      'event',
      entries => {
        if (state.active) state.eventDurationsMs.push(...entries.map(entry => entry.duration));
      },
      { durationThreshold: 16 },
    );
    const frame = now => {
      if (state.active && state.lastFrameAt !== null) state.frameGapsMs.push(now - state.lastFrameAt);
      state.lastFrameAt = now;
      state.raf = requestAnimationFrame(frame);
    };
    state.raf = requestAnimationFrame(frame);
    const nodes = () => document.getElementsByTagName('*').length;
    globalThis.__silverhandClientPerfV1 = {
      reset(phaseId) {
        state.active = true;
        state.startedAt = performance.now();
        state.phaseId = phaseId;
        performance.mark(`silverhand-perf:${phaseId}:start`);
        state.frameGapsMs = [];
        state.longTasksMs = [];
        state.eventDurationsMs = [];
        state.layoutShiftScore = 0;
        state.domNodesBefore = nodes();
        state.lastFrameAt = null;
      },
      snapshot(actionToPaintMs) {
        const endedAt = performance.now();
        state.active = false;
        performance.mark(`silverhand-perf:${state.phaseId}:end`);
        return {
          actionToPaintMs,
          measuredMs: endedAt - state.startedAt,
          rendererStartedAtMs: state.startedAt,
          rendererEndedAtMs: endedAt,
          frameGapsMs: [...state.frameGapsMs],
          longTasksMs: [...state.longTasksMs],
          eventDurationsMs: [...state.eventDurationsMs],
          layoutShiftScore: state.layoutShiftScore,
          domNodesBefore: state.domNodesBefore,
          domNodesAfter: nodes(),
        };
      },
      stop() {
        state.active = false;
        cancelAnimationFrame(state.raf);
        for (const observer of state.observers) observer.disconnect();
        delete globalThis.__silverhandClientPerfV1;
      },
    };
    return { ok: true };
  }})()`;
}

function phaseSource(phaseId, action, settleMs, observeMs) {
  return `(${async function execute(phaseId, action, settleMs, observeMs) {
    const probe = globalThis.__silverhandClientPerfV1;
    if (!probe) throw new Error('performance probe is not installed');
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const sidebarButton = sidebar => {
      const prefix = sidebar === 'workspace' ? 'Workspace sidebar' : 'Channel sidebar';
      return [...document.querySelectorAll('button[title]')].find(
        element => element instanceof HTMLButtonElement && element.title.startsWith(prefix),
      );
    };
    // Make a directional sidebar phase reproducible even though visibility is
    // persisted across runs. Preconditioning is deliberately outside the probe.
    if (action.kind === 'sidebar') {
      const button = sidebarButton(action.sidebar);
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error(`sidebar toggle did not resolve: ${action.sidebar}`);
      }
      const currentlyVisible = button.getAttribute('aria-pressed') === 'true';
      if (currentlyVisible === action.visible) {
        button.click();
        await wait(300);
      }
    }
    probe.reset(phaseId);
    let actionToPaintMs = null;
    const startedAt = performance.now();
    if (action.kind === 'navigate') {
      location.hash = `#${action.path}`;
    } else if (action.kind === 'click') {
      const element = document.querySelector(action.selector);
      if (!(element instanceof HTMLElement)) throw new Error(`selector did not resolve to an element: ${action.selector}`);
      element.click();
    } else if (action.kind === 'type') {
      const element = document.querySelector(action.selector);
      if (!(element instanceof HTMLTextAreaElement) && !(element instanceof HTMLInputElement)) {
        throw new Error(`selector did not resolve to an input: ${action.selector}`);
      }
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
      if (!setter) throw new Error('input value setter is unavailable');
      setter.call(element, action.text);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (action.kind === 'scroll') {
      const element = document.querySelector(action.selector);
      if (!(element instanceof HTMLElement)) throw new Error(`selector did not resolve to an element: ${action.selector}`);
      element.scrollBy({ top: action.delta_y, behavior: 'instant' });
    } else if (action.kind === 'sidebar') {
      const button = sidebarButton(action.sidebar);
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error(`sidebar toggle did not resolve: ${action.sidebar}`);
      }
      button.click();
    } else if (action.kind !== 'manual') {
      throw new Error(`unsupported action ${action.kind}`);
    }
    if (action.kind !== 'manual') {
      await paint();
      actionToPaintMs = performance.now() - startedAt;
    }
    await wait(settleMs);
    await wait(observeMs);
    return probe.snapshot(actionToPaintMs);
  }})(${JSON.stringify(phaseId)}, ${JSON.stringify(action)}, ${settleMs}, ${observeMs})`;
}

function rendererMetadataSource() {
  return `(() => ({
    device_pixel_ratio: devicePixelRatio,
    viewport: { width: innerWidth, height: innerHeight },
    screen: { width: screen.width, height: screen.height, color_depth: screen.colorDepth },
    hardware_concurrency: navigator.hardwareConcurrency ?? null,
    prefers_reduced_motion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    user_agent: navigator.userAgent,
    language: navigator.language,
  }))()`;
}

async function beginTrace(client, outputPath) {
  let resolveComplete;
  let rejectComplete;
  const complete = new Promise((resolvePromise, rejectPromise) => {
    resolveComplete = resolvePromise;
    rejectComplete = rejectPromise;
  });
  const remove = client.on('Tracing.tracingComplete', async params => {
    try {
      const chunks = [];
      while (true) {
        const part = await client.send('IO.read', { handle: params.stream });
        chunks.push(part.base64Encoded ? Buffer.from(part.data, 'base64') : Buffer.from(part.data));
        if (part.eof) break;
      }
      await client.send('IO.close', { handle: params.stream });
      await writeFile(outputPath, Buffer.concat(chunks));
      resolveComplete(outputPath);
    } catch (error) {
      rejectComplete(error);
    } finally {
      remove();
    }
  });
  await client.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    categories: [
      'blink',
      'blink.user_timing',
      'cc',
      'devtools.timeline',
      'toplevel',
      'v8',
      'disabled-by-default-devtools.timeline',
      'disabled-by-default-devtools.timeline.frame',
      'disabled-by-default-devtools.screenshot',
    ].join(','),
  });
  return { completion: complete };
}

async function endTrace(client, completion) {
  await client.send('Tracing.end');
  await Promise.race([
    completion,
    sleep(30_000).then(() => {
      throw new Error('trace stream did not complete within 30s');
    }),
  ]);
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`renderer evaluation failed: ${description}`);
  }
  return result.result.value;
}

async function readHeapUsage(client) {
  const usage = await client.send('Runtime.getHeapUsage');
  return Number.isFinite(usage.usedSize) ? usage.usedSize : null;
}

async function fetchTargets(endpoint) {
  const response = await fetch(`${endpoint}/json/list`);
  if (!response.ok) throw new Error(`${endpoint}/json/list -> ${response.status}`);
  return response.json();
}

async function pickTarget(endpoint) {
  const targets = await fetchTargets(endpoint);
  const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
  if (!page) throw new Error(`no debuggable page target found at ${endpoint}`);
  return page;
}

async function waitForTarget(endpoint, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await pickTarget(endpoint);
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw new Error(`no renderer target at ${endpoint} within ${timeoutMs}ms: ${String(lastError)}`);
}

function interpolateAction(action, fixture) {
  return Object.fromEntries(
    Object.entries(action).map(([key, value]) => [key, interpolate(value, fixture)]),
  );
}

function formatPhaseSummary(summary) {
  const action = summary.action_to_paint_ms === null ? 'n/a' : `${summary.action_to_paint_ms}ms`;
  const p95 = summary.frame_gap_ms.p95 === null ? 'n/a' : `${summary.frame_gap_ms.p95}ms`;
  return `action→2 paints ${action}; frame-gap p95 ${p95}; long tasks ${summary.long_tasks.count}; heap Δ ${summary.heap_delta_bytes ?? 'n/a'} bytes`;
}

function scenarioFile(value) {
  const raw = required({ scenario: value }, 'scenario');
  const path = raw.endsWith('.json') ? resolve(raw) : join(import.meta.dirname, 'scenarios', `${raw}.json`);
  return path;
}

function requiredMode(options) {
  const mode = required(options, 'mode');
  if (!['dev', 'release-profile', 'release'].includes(mode)) {
    fail('--mode must be dev, release-profile, or release');
  }
  return mode;
}

function fixtureScale(value) {
  const scale = value ?? 'standard';
  if (typeof scale !== 'string' || !Object.hasOwn(FIXTURE_SCALES, scale)) {
    fail('--scale must be smoke, standard, or stress');
  }
  return scale;
}

function cdpEndpoint(options) {
  if (options.cdp) return String(options.cdp).replace(/\/$/, '');
  if (options.port) return `http://127.0.0.1:${parsePort(options.port)}`;
  return DEFAULT_CDP;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) fail(`invalid port ${value}`);
  return port;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith('--')) fail(`unexpected positional argument ${token}`);
    const name = token.slice(2);
    if (name.startsWith('no-')) {
      result[name.slice(3)] = false;
      continue;
    }
    if (
      ['yes', 'trace', 'retained-heap', 'cpu-profile', 'js-coverage', 'unminified'].includes(name)
    ) {
      result[name] = true;
      continue;
    }
    const value = values[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`--${name} requires a value`);
    result[name] = value;
    index += 1;
  }
  return result;
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || value.trim() === '') fail(`--${name} is required`);
  return value;
}

function fail(message) {
  throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function printHelp() {
  console.log(`Silverhand renderer performance harness

Usage:
  pnpm perf:client targets [--cdp http://127.0.0.1:9222]
  pnpm perf:client run --mode dev --scenario chat-core [--cdp URL] [--workspace-id ID --channel-id ID]
  pnpm perf:client profile --mode release-profile --scale standard --profile-dir /tmp/silverhand-perf-standard --scenario chat-core
  pnpm perf:client profile --mode release --scale stress --executable /path/to/Silverhand --profile-dir /tmp/silverhand-perf-stress --scenario task-core

Modes:
  dev              HMR/CDP diagnosis only; reports are never baseline eligible.
  release-profile  Built production renderer via electron-vite preview.
  release          Packaged application executable; final acceptance lane.

Flags:
  --port N          CDP port for owned profiles (default 9233).
  --scale NAME      Isolated fixture size: smoke, standard (default), or stress.
  --output DIR      Report directory (default /tmp/silverhand-client-performance/...).
  --yes             Run phases without the readiness prompt.
  --retained-heap   Force V8 GC outside each measured phase before heap samples.
  --cpu-profile     Save one V8 CPU profile per measured phase.
  --js-coverage     Save exact JavaScript function call counts per measured phase.
  --unminified      Build the owned release-profile without minification.
  --no-trace        Skip the Chrome trace stream.
`);
}
