import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CheckCircle2,
  Loader2,
  Network,
  Palette,
  Save,
} from 'lucide-react';
import type { RuntimeKind } from '@silverhand/shared';
import { Input, Label } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { AgentAvatar } from '@/components/AgentAvatar';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useAppearance } from '@/hooks/useAppearance';
import { THEME_IDS, type ThemeId } from '@/settings/types';

const settingsKey = ['settings'] as const;

/** 4-color swatch preview and display name for each theme. */
const THEME_META: Record<
  ThemeId,
  { label: string; bg: string; surface: string; text: string; accent: string }
> = {
  'paper-ink': {
    label: 'Paper Ink',
    bg: '#FAF4E4',
    surface: '#F2EAD2',
    text: '#1A1611',
    accent: '#263A42',
  },
  'warm-coral': {
    label: 'Warm Coral',
    bg: '#F9F9F7',
    surface: '#F3F3F0',
    text: '#1A1A18',
    accent: '#B5651D',
  },
  'warm-script': {
    label: 'Warm Script',
    bg: '#F8F6F2',
    surface: '#F3EFE8',
    text: '#1F1B14',
    accent: '#FFD440',
  },
};

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
  const { appearance, setTheme } = useAppearance();
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
    <main
      className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-bg-chat"
      style={{
        borderRadius: 'var(--card-radius, 0)',
        boxShadow: 'var(--card-shadow, none)',
      }}
    >
      <header className="flex h-[var(--titlebar-height)] shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="font-serif text-sm font-semibold text-text-primary">
            Settings
          </span>
          <span className="truncate text-xs text-text-muted">
            Host-level preferences for future agent processes
          </span>
        </div>
        <span className="shrink-0 text-[11px] font-medium text-text-muted">
          Local
        </span>
      </header>

      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto w-full max-w-3xl">
            <div className="min-w-0 space-y-8">
              <SettingsSection
                id="settings-appearance"
                icon={<Palette className="size-4" />}
                title="Appearance"
                description="Choose the visual theme used across the workspace shell and chat UI."
              >
                <div className="grid gap-3 sm:grid-cols-3">
                  {THEME_IDS.map(id => {
                    const meta = THEME_META[id];
                    const active = appearance.theme === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setTheme(id)}
                        className={cn(
                          'group relative flex min-h-[92px] flex-col items-start justify-between overflow-hidden rounded-[10px] border-2 p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus',
                          active
                            ? 'border-accent'
                            : 'border-border-subtle hover:border-accent',
                        )}
                        style={{
                          background: `linear-gradient(135deg, ${meta.bg}, ${meta.surface})`,
                        }}
                      >
                        <div className="flex gap-1">
                          {[meta.bg, meta.surface, meta.text, meta.accent].map(
                            c => (
                              <span
                                key={c}
                                className="size-4 rounded-full border border-black/10"
                                style={{ background: c }}
                              />
                            ),
                          )}
                        </div>
                        <div className="mt-4 flex w-full items-center justify-between gap-2">
                          <span
                            className="min-w-0 truncate text-xs font-semibold"
                            style={{ color: meta.text }}
                          >
                            {meta.label}
                          </span>
                          {active ? (
                            <span
                              className="flex size-5 shrink-0 items-center justify-center rounded-full"
                              style={{
                                background: meta.accent,
                                color: meta.bg,
                              }}
                              aria-label="Current theme"
                            >
                              <Check className="size-3" />
                            </span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </SettingsSection>

              <SettingsSection
                id="settings-proxy"
                icon={<Network className="size-4" />}
                title="Proxy"
                description="Proxy configuration is injected only into newly spawned agent processes."
              >
                <div className="grid gap-5">
                  <div className="grid gap-2">
                    <Label htmlFor="proxy-url">Proxy URL</Label>
                    <Input
                      id="proxy-url"
                      value={proxyUrl}
                      onChange={e => setProxyUrl(e.target.value)}
                      placeholder="127.0.0.1:7897 / http://... / socks5://..."
                      disabled={settingsQuery.isLoading}
                    />
                    <p className="text-xs leading-relaxed text-text-muted">
                      Expands into <code>http_proxy</code>,{' '}
                      <code>https_proxy</code>, and <code>all_proxy</code> for
                      selected runtimes. A bare host:port or <code>http://</code>{' '}
                      value is treated as a mixed-port proxy;{' '}
                      <code>socks5://</code> only sets <code>all_proxy</code>.
                    </p>
                  </div>

                  <div className="grid gap-2">
                    <div className="flex items-center justify-between gap-3">
                      <Label>Enabled runtimes</Label>
                      <button
                        type="button"
                        disabled={!proxyEnabled}
                        className="text-xs font-medium text-text-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                        onClick={() => {
                          if (allChecked) setProxyRuntimes(new Set());
                          else {
                            setProxyRuntimes(
                              new Set(ALL_RUNTIMES.map(r => r.kind)),
                            );
                          }
                        }}
                      >
                        {allChecked ? 'Clear all' : 'Select all'}
                      </button>
                    </div>

                    <div
                      className={cn(
                        'grid gap-2 sm:grid-cols-2',
                        !proxyEnabled && 'opacity-55',
                      )}
                    >
                      {ALL_RUNTIMES.map(runtime => {
                        const checked = proxyRuntimes.has(runtime.kind);
                        return (
                          <label
                            key={runtime.kind}
                            className={cn(
                              'flex min-w-0 items-center gap-3 rounded-[6px] border px-3 py-2 transition-colors',
                              proxyEnabled
                                ? 'cursor-pointer'
                                : 'cursor-not-allowed',
                              checked
                                ? 'border-accent bg-[var(--bg-row-selected,var(--bg-selected))]'
                                : 'border-border-subtle bg-bg-floating hover:bg-[var(--bg-row-hover,var(--bg-hover))]',
                            )}
                          >
                            <input
                              type="checkbox"
                              className="sr-only"
                              checked={checked}
                              onChange={e =>
                                toggleRuntime(runtime.kind, e.target.checked)
                              }
                              disabled={!proxyEnabled}
                            />
                            <span
                              className={cn(
                                'flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
                                checked
                                  ? 'border-accent bg-accent text-text-on-accent'
                                  : 'border-border-subtle bg-bg-floating text-transparent',
                              )}
                              aria-hidden
                            >
                              <Check className="size-3" />
                            </span>
                            <AgentAvatar runtime={runtime.kind} size={22} />
                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
                              {runtime.label}
                            </span>
                            <span className="shrink-0 font-mono text-[11px] text-text-muted">
                              {runtime.kind}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    {!proxyEnabled ? (
                      <p className="text-xs text-text-muted">
                        Add a Proxy URL before selecting runtimes.
                      </p>
                    ) : null}
                  </div>
                </div>
              </SettingsSection>
            </div>
          </div>
        </div>

        <footer className="shrink-0 border-t border-border-subtle bg-bg-chat px-6 py-3">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4">
            <div className="min-w-0 text-xs">
              {error ? (
                <span className="text-error">{error}</span>
              ) : saved ? (
                <span className="inline-flex items-center gap-1.5 text-success">
                  <CheckCircle2 className="size-3.5" />
                  Saved
                </span>
              ) : (
                <span className="text-text-muted">
                  Changes are saved to host settings.
                </span>
              )}
            </div>
            <Button
              type="submit"
              disabled={save.isPending || settingsQuery.isLoading}
            >
              {save.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              {save.isPending ? 'Saving...' : 'Save settings'}
            </Button>
          </div>
        </footer>
      </form>
    </main>
  );
}

function SettingsSection({
  id,
  icon,
  title,
  description,
  children,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section
      id={id}
      className="scroll-mt-6 grid gap-4 border-b border-border-subtle pb-8 last:border-b-0 last:pb-0"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-bg-elevated text-text-secondary">
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="font-serif text-base font-semibold text-text-primary">
            {title}
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-text-muted">
            {description}
          </p>
        </div>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}
