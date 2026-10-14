import { useEffect, useState } from 'react';
import {
  HOOK_EVENTS,
  type EventHooksCapability,
  type HookRule,
  type HookSettingsSnapshot,
  type HookRun,
} from '@silverhand/client';
import { Button } from '@/components/ui/button';
import { SettingToggle } from '@/components/ui/setting-toggle';

const KINDS: Record<string, string> = {
  mention_self: 'Mentions of you',
  mention_external: 'Other mentions',
  create: 'Task created',
  claim: 'Task claimed',
  unclaim: 'Task unclaimed',
  status: 'Task status changed',
  edit: 'Task edited',
};
function group(rule: HookRule) {
  const kind = rule.match?.kind;
  return kind
    ? (KINDS[kind] ?? kind)
    : rule.event === 'notification'
      ? 'All notifications'
      : 'All task changes';
}
export function HookSettingsPane({ api }: { api: EventHooksCapability }) {
  const [snapshot, setSnapshot] = useState<HookSettingsSnapshot>();
  const [runs, setRuns] = useState<HookRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reload = async () => {
    const [next, history] = await Promise.all([api.loadHooks(), api.runs()]);
    setSnapshot(next);
    setRuns(history);
  };
  useEffect(() => {
    let active = true;
    void Promise.all([api.loadHooks(), api.runs()])
      .then(([next, history]) => {
        if (active) {
          setSnapshot(next);
          setRuns(history);
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [api]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const groups = new Map<string, HookSettingsSnapshot['entries']>();
  for (const entry of snapshot?.entries ?? [])
    if (entry.rule) {
      const key = group(entry.rule);
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
  const problems = [
    ...(snapshot?.sources
      .filter((s) => s.error)
      .map((s) => ({ source: s.path, message: s.error! })) ?? []),
    ...(snapshot?.entries
      .filter((e) => e.error)
      .map((e) => ({ source: e.source, message: `Hook ${e.index + 1}: ${e.error}` })) ?? []),
  ];
  return (
    <section className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8 sm:py-8">
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-serif text-base font-semibold">On this computer</h2>
            <p className="mt-2 text-sm text-text-secondary">
              View and enable your local automations. Edit their source files to make changes.
            </p>
          </div>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(reload)}>
            Reload
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!snapshot || busy}
            onClick={() => void run(() => api.openSource(snapshot!.path))}
          >
            Open hooks.json
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void run(() => api.openDirectory())}
          >
            Open configuration folder
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-error break-words">
            {error}
          </p>
        )}
        {problems.length > 0 && (
          <details className="rounded-xl border border-error p-4 text-sm">
            <summary className="cursor-pointer text-error">
              {problems.length} hook loading problem{problems.length === 1 ? '' : 's'}
            </summary>
            {problems.map((problem, i) => (
              <div key={i} className="mt-3 space-y-1">
                <p className="break-words">{problem.message}</p>
                <p className="break-all text-xs text-text-muted">{problem.source}</p>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void run(() => api.openSource(problem.source))}
                >
                  Open source
                </Button>
              </div>
            ))}
          </details>
        )}
        {!snapshot && <p className="text-sm text-text-muted">Loading hooks…</p>}
        {snapshot && !groups.size && (
          <div className="rounded-xl border border-border p-6 text-sm">
            <p className="font-medium">No active definitions</p>
            <p className="mt-2 text-text-secondary">
              Add your hooks to hooks.json or a JSON file in hooks.d, then reload.
            </p>
          </div>
        )}
        {[...groups].map(([label, entries]) => (
          <div key={label} className="overflow-hidden rounded-xl border border-border">
            <div className="border-b border-border p-4">
              <h3 className="text-sm font-semibold">{label}</h3>
              <p className="mt-1 text-xs text-text-muted">
                {HOOK_EVENTS[entries[0]!.rule!.event].label}
              </p>
            </div>
            <div className="divide-y divide-border">
              {entries.map((entry) => {
                const rule = entry.rule!;
                return (
                  <div
                    key={`${entry.source}:${entry.index}`}
                    className="flex items-start gap-3 p-4"
                  >
                    <details className="min-w-0 flex-1">
                      <summary className="cursor-pointer break-words text-sm font-medium">
                        {rule.name}
                      </summary>
                      <div className="mt-3 space-y-3 text-xs">
                        <p className="break-all text-text-muted">{entry.source}</p>
                        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-bg-elevated p-3 font-mono">
                          {JSON.stringify(rule, null, 2)}
                        </pre>
                        <p className="text-text-muted">
                          Runs asynchronously · timeout {rule.action.timeoutMs ?? 15000} ms ·
                          working directory: {rule.action.cwd ?? 'home directory'}
                        </p>
                      </div>
                    </details>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Open source for ${rule.name}`}
                      title="Open source file"
                      disabled={busy}
                      onClick={() => void run(() => api.openSource(entry.source))}
                    >
                      ↗
                    </Button>
                    <SettingToggle
                      label={`Enable ${rule.name}`}
                      checked={rule.enabled}
                      disabled={busy}
                      onChange={() =>
                        void run(async () =>
                          setSnapshot(
                            await api.setHookEnabled({
                              source: entry.source,
                              revision: entry.revision,
                              index: entry.index,
                              enabled: !rule.enabled,
                            }),
                          ),
                        )
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {!!runs.length && (
          <details className="text-sm">
            <summary className="cursor-pointer text-text-secondary">Recent runs</summary>
            <p className="mt-2 text-xs text-text-muted">
              Updated when you reload. History clears with the session.
            </p>
            {runs.map((item) => (
              <details key={item.id} className="mt-3 rounded-lg border border-border p-3">
                <summary className="cursor-pointer">
                  {item.name} · {item.status}
                </summary>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
                  {[item.reason, item.stdout, item.stderr].filter(Boolean).join('\n') ||
                    'No output'}
                </pre>
              </details>
            ))}
          </details>
        )}
      </div>
    </section>
  );
}
