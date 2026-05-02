import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RuntimeKind } from '@silverhand/shared';
import { Input, Label } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { AgentAvatar } from '@/components/AgentAvatar';
import { api } from '@/lib/api';

const settingsKey = ['settings'] as const;

interface SettingsResponse {
  settings: Record<string, string>;
}

/** Static list of supported runtimes. Mirrors `RuntimeKindSchema` in
 *  shared/db/schema.ts — keep in sync if a new runtime kind ships. */
const ALL_RUNTIMES: ReadonlyArray<{ kind: RuntimeKind; label: string }> = [
  { kind: 'claude', label: 'Claude' },
  { kind: 'codex', label: 'Codex' },
  { kind: 'cursor', label: 'Cursor' },
  { kind: 'gemini', label: 'Gemini' },
];

/** Comma-separated runtime kinds → trimmed array, drops empties + unknowns. */
function parseRuntimes(raw: string | undefined | null): RuntimeKind[] {
  if (!raw) return [];
  const known = new Set<string>(ALL_RUNTIMES.map(r => r.kind));
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(s => known.has(s)) as RuntimeKind[];
}

export function SettingsPage(): JSX.Element {
  const qc = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: settingsKey,
    queryFn: () => api<SettingsResponse>('/api/settings'),
  });

  const [proxyUrl, setProxyUrl] = useState('');
  const [proxyRuntimes, setProxyRuntimes] = useState<Set<RuntimeKind>>(
    new Set(),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed local form state from server. Re-runs whenever the cached
  // settings refetch — keeps the page coherent if another tab/window
  // (or settings PUT elsewhere) updates them.
  useEffect(() => {
    if (settingsQuery.data) {
      setProxyUrl(settingsQuery.data.settings.proxy_url ?? '');
      setProxyRuntimes(
        new Set(parseRuntimes(settingsQuery.data.settings.proxy_runtimes)),
      );
      setError(null);
    }
  }, [settingsQuery.data]);

  const save = useMutation({
    mutationFn: async (body: Record<string, string>) =>
      api<SettingsResponse>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKey });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    },
  });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await save.mutateAsync({
        proxy_url: proxyUrl.trim(),
        // Stable canonical order so the persisted string doesn't churn
        // just because the user clicked checkboxes in a different
        // sequence.
        proxy_runtimes: ALL_RUNTIMES.filter(r => proxyRuntimes.has(r.kind))
          .map(r => r.kind)
          .join(','),
      });
    } catch (err) {
      setError(String(err));
    }
  };

  const toggleRuntime = (kind: RuntimeKind, checked: boolean) => {
    setProxyRuntimes(prev => {
      const next = new Set(prev);
      if (checked) next.add(kind);
      else next.delete(kind);
      return next;
    });
  };

  const proxyEnabled = proxyUrl.trim().length > 0;
  const allChecked = useMemo(
    () => ALL_RUNTIMES.every(r => proxyRuntimes.has(r.kind)),
    [proxyRuntimes],
  );

  return (
    <main className="flex h-full flex-1 flex-col bg-bg-base">
      <header className="flex h-[var(--titlebar-height)] shrink-0 items-center gap-2 border-b border-border-subtle px-4">
        <span className="font-serif text-sm font-semibold text-text-primary">
          Settings
        </span>
        <span className="text-xs text-text-muted">
          主机级设置；只对未来 spawn 的 agent 进程生效
        </span>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <form
          onSubmit={handleSubmit}
          className="mx-auto flex w-full max-w-2xl flex-col gap-6"
        >
          <section className="flex flex-col gap-3">
            <h2 className="font-serif text-base font-semibold text-text-primary">
              代理 (Proxy)
            </h2>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="proxy-url">Proxy URL</Label>
              <Input
                id="proxy-url"
                value={proxyUrl}
                onChange={e => setProxyUrl(e.target.value)}
                placeholder="http://127.0.0.1:7897"
                disabled={settingsQuery.isLoading}
              />
              <p className="text-xs text-text-muted">
                非空时注入 <code>HTTP_PROXY</code> / <code>HTTPS_PROXY</code> /{' '}
                <code>ALL_PROXY</code>（含小写）到下方勾选 runtime 的 agent 子进程。
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label>对哪些 runtime 生效</Label>
                <button
                  type="button"
                  className="text-xs text-text-muted hover:text-text-primary"
                  onClick={() => {
                    if (allChecked) setProxyRuntimes(new Set());
                    else
                      setProxyRuntimes(new Set(ALL_RUNTIMES.map(r => r.kind)));
                  }}
                >
                  {allChecked ? '全不选' : '全选'}
                </button>
              </div>
              <div
                className={`flex flex-col gap-1 rounded-md border border-border-subtle p-2 ${
                  proxyEnabled ? '' : 'opacity-50'
                }`}
              >
                {ALL_RUNTIMES.map(runtime => (
                  <label
                    key={runtime.kind}
                    className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-bg-hover"
                  >
                    <input
                      type="checkbox"
                      checked={proxyRuntimes.has(runtime.kind)}
                      onChange={e =>
                        toggleRuntime(runtime.kind, e.target.checked)
                      }
                      disabled={!proxyEnabled}
                    />
                    <AgentAvatar runtime={runtime.kind} size={20} />
                    <span className="text-sm">{runtime.label}</span>
                    <span className="text-xs text-text-muted">
                      ({runtime.kind})
                    </span>
                  </label>
                ))}
              </div>
              {!proxyEnabled ? (
                <p className="text-xs text-text-muted">
                  填了 Proxy URL 后才能勾选。
                </p>
              ) : null}
            </div>
          </section>

          <div className="flex items-center gap-3 border-t border-border-subtle pt-4">
            <Button
              type="submit"
              disabled={save.isPending || settingsQuery.isLoading}
            >
              {save.isPending ? '保存中…' : '保存'}
            </Button>
            {saved ? (
              <span className="text-xs text-success">已保存</span>
            ) : null}
            {error ? <span className="text-xs text-error">{error}</span> : null}
          </div>
        </form>
      </div>
    </main>
  );
}
