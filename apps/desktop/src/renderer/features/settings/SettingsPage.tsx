import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CheckCircle2,
  Code2,
  LogOut,
  Loader2,
  Network,
  Palette,
  RotateCcw,
  Save,
  Server,
  Type,
  User,
} from 'lucide-react';
import type { RuntimeKind } from '@silverhand/shared';
import {
  AVATAR_MAX_SIZE_LABEL,
  validateAvatarFile,
} from '@silverhand/shared';
import { Input, Label } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { AgentAvatar } from '@/components/AgentAvatar';
import { AvatarPickerButton } from '@/components/AvatarPickerButton';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useAppearance } from '@/hooks/useAppearance';
import {
  isRegistrationRequired,
  useClearAvatar,
  useLogout,
  useUpdateProfile,
  useUploadAvatar,
  useViewerAvatarObjectUrl,
  useViewerUser,
} from '@/features/me/hooks';
import {
  DEFAULT_MARKDOWN_FONT_SIZE,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  THEME_IDS,
  type ThemeId,
} from '@/settings/types';
import {
  CODE_FONT_PRESETS,
  PROSE_FONT_PRESETS,
  type FontPreset,
} from '@/settings/font-presets';
import { HostsPane } from './HostsPane';
import { ServerUrlPane } from './ServerUrlPane';

const settingsKey = ['settings'] as const;

/** 4-color swatch preview and display name for each theme. */
const THEME_META: Record<
  ThemeId,
  {
    label: string;
    bg: string;
    surface: string;
    text: string;
    accent: string;
    /** Idle (non-active) tile border color. Per-theme so the preview
     *  carries that theme's identity instead of the *current* viewer
     *  theme's `--border-subtle`. forza6's near-black poster border
     *  was nearly invisible against the magenta side of its
     *  lime→magenta gradient because the global subtle is only ~10%
     *  alpha — looked like the border had "disappeared" along the
     *  bottom-right (@shiki feedback `h45zG6elM7NVgPzQ`). */
    border: string;
  }
> = {
  'warm-script': {
    label: 'Warm Script',
    bg: '#F8F6F2',
    surface: '#F3EFE8',
    text: '#1F1B14',
    accent: '#FFD440',
    border: 'rgba(0, 0, 0, 0.10)',
  },
  forza6: {
    label: 'Forza6',
    // Swatch refreshed for PR-2 v5.x final palette: pale lime sidebar
    // carrier + festival magenta frame + acid lime selected/inline-code
    // + near-black text. The original v1-era teal `#0F847B` no longer
    // has a live site after the v5 selected/focus role swap (deep teal
    // sidebars were dropped in favour of pale lime). shiki
    // `30FgGvhGzEJztabr` "卡片色系还有青色，更新一下".
    bg: '#F4F8E8',
    surface: '#FF2C7A',
    text: '#0A0A0A',
    accent: '#D4F523',
    border: '#FF2C7A',
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

/** Which sub-page of Settings is visible. The picker lives in the
 *  page-internal sub-nav; selection is local React state, persisted to
 *  localStorage so a refresh stays put. (No URL routing yet — settings
 *  deep-links are rare and the URL slot belongs to the chat router.) */
type SettingsSection = 'appearance' | 'profile' | 'server' | 'hosts' | 'proxy';
const SETTINGS_SECTIONS: ReadonlyArray<SettingsSection> = [
  'appearance',
  'profile',
  'server',
  'hosts',
  'proxy',
];
const SETTINGS_SECTION_KEY = 'silverhand:settings-section';

function readPersistedSection(): SettingsSection {
  if (typeof localStorage === 'undefined') return 'appearance';
  const raw = localStorage.getItem(SETTINGS_SECTION_KEY);
  return SETTINGS_SECTIONS.includes(raw as SettingsSection)
    ? (raw as SettingsSection)
    : 'appearance';
}

export function SettingsPage(): JSX.Element {
  const qc = useQueryClient();
  const {
    appearance,
    setTheme,
    setMarkdownFont,
    setMarkdownFontSize,
    resetMarkdownText,
    resetMarkdownFontSize,
  } = useAppearance();
  const settingsQuery = useQuery({
    queryKey: settingsKey,
    queryFn: () => api<SettingsResponse>('/api/settings'),
  });

  const [section, setSection] = useState<SettingsSection>(readPersistedSection);
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SETTINGS_SECTION_KEY, section);
  }, [section]);

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

      <div className="flex min-h-0 flex-1 justify-center">
        <div className="flex w-full min-w-0 max-w-[60rem]">
          <SettingsSubNav section={section} onSelect={setSection} />
          {section === 'appearance' ? (
            <AppearancePane
              appearance={appearance}
              setTheme={setTheme}
              setMarkdownFont={setMarkdownFont}
              setMarkdownFontSize={setMarkdownFontSize}
              resetMarkdownText={resetMarkdownText}
              resetMarkdownFontSize={resetMarkdownFontSize}
            />
          ) : section === 'profile' ? (
            <ProfilePane />
          ) : section === 'server' ? (
            <ServerUrlPane />
          ) : section === 'hosts' ? (
            <HostsPane />
          ) : (
            <ProxyPane
              proxyUrl={proxyUrl}
              setProxyUrl={setProxyUrl}
              proxyRuntimes={proxyRuntimes}
              toggleRuntime={toggleRuntime}
              setProxyRuntimes={setProxyRuntimes}
              proxyEnabled={proxyEnabled}
              allChecked={allChecked}
              settingsLoading={settingsQuery.isLoading}
              saving={save.isPending}
              saved={saved}
              error={error}
              onSubmit={handleSubmit}
            />
          )}
        </div>
      </div>
    </main>
  );
}

/** Page-internal vertical nav. The settings sub-nav is *secondary*
 *  navigation (the user already chose Settings from the rail), so the
 *  selected state stays soft — a subtle background tint + medium-weight
 *  text rather than the strong border-accent + filled selected bg used
 *  by the channel sidebar. */
function SettingsSubNav({
  section,
  onSelect,
}: {
  section: SettingsSection;
  onSelect: (next: SettingsSection) => void;
}): JSX.Element {
  const items: ReadonlyArray<{
    id: SettingsSection;
    label: string;
    icon: ReactNode;
  }> = [
    { id: 'appearance', label: 'Appearance', icon: <Palette className="size-3.5" /> },
    { id: 'profile', label: 'Profile', icon: <User className="size-3.5" /> },
    { id: 'server', label: 'Server', icon: <Server className="size-3.5" /> },
    { id: 'hosts', label: 'Local host', icon: <Server className="size-3.5" /> },
    { id: 'proxy', label: 'Proxy', icon: <Network className="size-3.5" /> },
  ];

  return (
    <aside
      aria-label="Settings sections"
      className="flex h-full w-44 shrink-0 flex-col py-4 pr-2"
    >
      <nav className="flex flex-col gap-0.5">
        {items.map(item => {
          const selected = item.id === section;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={selected ? 'page' : undefined}
              onClick={() => onSelect(item.id)}
              className={cn(
                'flex w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-sm transition-colors',
                selected
                  ? 'bg-[var(--bg-row-hover,var(--bg-hover))] font-medium text-text-primary'
                  : 'text-text-secondary hover:bg-[var(--bg-row-hover,var(--bg-hover))] hover:text-text-primary',
              )}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

/** Appearance pane — theme picker + Markdown Text controls. Settings
 *  here auto-persist to localStorage via {@link useAppearance}; no Save
 *  button needed, so this pane has no footer. */
function AppearancePane({
  appearance,
  setTheme,
  setMarkdownFont,
  setMarkdownFontSize,
  resetMarkdownText,
  resetMarkdownFontSize,
}: {
  appearance: ReturnType<typeof useAppearance>['appearance'];
  setTheme: ReturnType<typeof useAppearance>['setTheme'];
  setMarkdownFont: ReturnType<typeof useAppearance>['setMarkdownFont'];
  setMarkdownFontSize: ReturnType<typeof useAppearance>['setMarkdownFontSize'];
  resetMarkdownText: ReturnType<typeof useAppearance>['resetMarkdownText'];
  resetMarkdownFontSize: ReturnType<typeof useAppearance>['resetMarkdownFontSize'];
}): JSX.Element {
  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
      <div className="mx-auto w-full max-w-3xl">
        <div className="min-w-0 space-y-8">
          <SettingsSection
            id="settings-appearance"
            icon={<Palette className="size-4" />}
            title="Appearance"
            description="Choose the visual theme used across the workspace shell and chat UI."
          >
            <div className="grid gap-3 sm:grid-cols-2">
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
                      // Idle tiles override the global `border-border-subtle`
                      // with a per-theme border so the preview carries the
                      // previewed theme's identity (forza6 = poster near-black,
                      // warm = soft black @ 10%). Active tiles fall through
                      // to the `border-accent` class so the current theme's
                      // accent still marks "you are here".
                      ...(active ? null : { borderColor: meta.border }),
                    }}
                  >
                    <div className="flex gap-1">
                      {[meta.bg, meta.surface, meta.text, meta.accent].map(c => (
                        <span
                          key={c}
                          className="size-4 rounded-full border border-black/10"
                          style={{ background: c }}
                        />
                      ))}
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
            id="settings-markdown-text"
            icon={<Type className="size-4" />}
            title="Markdown Text"
            description="Customize message body typography without changing the rest of the app chrome."
          >
            <div className="grid gap-4">
              <SharedFontSizeControl
                value={appearance.fontSize}
                onChange={value => setMarkdownFontSize(value)}
                onReset={() => resetMarkdownFontSize()}
              />
              <MarkdownFontControl
                title="Prose"
                icon={<Type className="size-4" />}
                fontFamily={appearance.prose?.fontFamily}
                fontSize={appearance.fontSize}
                presets={PROSE_FONT_PRESETS}
                sample="正文预览 / Markdown body text"
                onFontChange={value =>
                  setMarkdownFont('prose', value || undefined)
                }
                onReset={() => resetMarkdownText('prose')}
              />
              <MarkdownFontControl
                title="Code"
                icon={<Code2 className="size-4" />}
                fontFamily={appearance.code?.fontFamily}
                fontSize={appearance.fontSize}
                presets={CODE_FONT_PRESETS}
                sample="const size = 12"
                onFontChange={value =>
                  setMarkdownFont('code', value || undefined)
                }
                onReset={() => resetMarkdownText('code')}
                code
              />
            </div>
          </SettingsSection>
        </div>
      </div>
    </section>
  );
}

/** Profile pane — viewer's mention name (read-only), display name, and
 *  avatar. Backed by `/api/me` (GET/PATCH/POST/DELETE) for reads and
 *  display_name / avatar edits.
 *
 *  `name` is set once at registration (full-screen gate before the app
 *  shell mounts) and is intentionally not editable here: the backend
 *  service / route layer does not expose a rename surface, and PATCH
 *  /api/me does not accept a `name` field. The display copy makes this
 *  permanent contract visible to the user. */
function ProfilePane(): JSX.Element {
  const viewer = useViewerUser();
  const updateProfile = useUpdateProfile();
  const uploadAvatar = useUploadAvatar();
  const clearAvatar = useClearAvatar();
  const logout = useLogout();

  // ProfilePane only mounts after registration (App.tsx gates the
  // shell behind <RegistrationGate />), so any `registration_required`
  // shape here is a transient race during refetch. Narrow once and
  // treat it as `undefined` for the rest of the pane.
  const dto =
    viewer.data && !isRegistrationRequired(viewer.data) ? viewer.data : undefined;

  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const avatarObjectUrl = useViewerAvatarObjectUrl();

  // Seed local form state from server. Re-runs whenever the cached
  // viewer dto changes (e.g. after a successful PATCH).
  useEffect(() => {
    if (dto) {
      setDisplayName(dto.display_name);
      setError(null);
    }
  }, [dto]);

  // Avatar blob → object URL is now lifted into the shared
  // `useViewerAvatarObjectUrl()` hook above; chat MessageItem also
  // consumes it so the same fetch result drives every render that
  // needs the viewer's photo.

  const dirty =
    !!dto && displayName !== dto.display_name;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!dto) return;
    setError(null);
    try {
      await updateProfile.mutateAsync({
        display_name:
          displayName !== dto.display_name ? displayName : undefined,
      });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      const apiErr = err as { body?: string; message?: string };
      let parsed: { error?: string; code?: string } = {};
      try {
        parsed = JSON.parse(apiErr.body ?? '{}');
      } catch {
        // not JSON — fall through to .message.
      }
      setError(parsed.error ?? apiErr.message ?? 'Failed to save');
    }
  };

  const onPickAvatar = async (file: File) => {
    setError(null);
    const validation = validateAvatarFile(file);
    if (validation) {
      setError(validation.message);
      return;
    }
    try {
      await uploadAvatar.mutateAsync({ file });
    } catch (err) {
      const apiErr = err as { body?: string; message?: string };
      let parsed: { error?: string; code?: string } = {};
      try {
        parsed = JSON.parse(apiErr.body ?? '{}');
      } catch {
        // not JSON — fall through to .message.
      }
      setError(parsed.error ?? apiErr.message ?? 'Failed to upload avatar');
    }
  };

  const onClearAvatar = async () => {
    setError(null);
    try {
      await clearAvatar.mutateAsync();
    } catch (err) {
      setError(String(err));
    }
  };

  const onLogout = async () => {
    setError(null);
    try {
      await logout.mutateAsync();
    } catch (err) {
      setError(String(err));
    }
  };

  if (viewer.isLoading) {
    return (
      <section className="flex min-w-0 flex-1 items-center justify-center py-10 text-xs text-text-muted">
        Loading profile…
      </section>
    );
  }
  if (!dto) {
    return (
      <section className="flex min-w-0 flex-1 items-center justify-center py-10 text-xs text-text-muted">
        Could not load your profile. Please retry from the main app.
      </section>
    );
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-5 px-5 py-5">
      <header className="flex flex-col gap-1">
        <h2 className="font-serif text-base font-semibold text-text-primary">
          Profile
        </h2>
        <p className="text-xs text-text-muted">
          How you appear to agents in this workspace. Your name was set at
          registration and cannot be changed; display name and avatar can.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label>Name</Label>
          <div className="flex max-w-sm items-center gap-2 rounded-md border border-border-subtle bg-bg-row-hover px-3 py-1.5 text-sm text-text-primary">
            <span className="font-mono text-text-muted">@</span>
            <span className="select-text">{dto.name}</span>
          </div>
          <p className="text-[11px] text-text-muted">
            Permanent — used for <code>@mention</code>s across messages,
            prompts, and search.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="profile-display-name">Display name</Label>
          <Input
            id="profile-display-name"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder="Your Name"
            className="max-w-sm"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label>Avatar</Label>
          <div className="flex items-center gap-3">
            <AvatarPickerButton
              size={56}
              label={dto.avatar_url ? 'Edit' : 'Add'}
              onPick={file => void onPickAvatar(file)}
              disabled={uploadAvatar.isPending}
              ariaLabel={dto.avatar_url ? 'Change avatar' : 'Add avatar'}
              className="border border-border-subtle"
            >
              <span className="grid size-full place-items-center bg-bg-row-hover">
                {avatarObjectUrl ? (
                  // eslint-disable-next-line jsx-a11y/img-redundant-alt
                  <img
                    src={avatarObjectUrl}
                    alt="Your avatar"
                    className="size-full object-cover"
                  />
                ) : (
                  <User className="size-7 text-text-muted" />
                )}
              </span>
            </AvatarPickerButton>
            <div className="flex flex-col gap-1">
              {uploadAvatar.isPending ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-text-muted">
                  <Loader2 className="size-3 animate-spin" />
                  Uploading…
                </span>
              ) : null}
              {dto.avatar_url ? (
                <button
                  type="button"
                  onClick={onClearAvatar}
                  disabled={clearAvatar.isPending}
                  className="self-start text-[11px] text-text-muted underline-offset-2 hover:underline disabled:opacity-50"
                >
                  Remove avatar
                </button>
              ) : null}
              <p className="text-[11px] text-text-muted">
                PNG / JPEG / GIF / WEBP, up to {AVATAR_MAX_SIZE_LABEL}.
              </p>
            </div>
          </div>
        </div>

        <footer className="flex items-center gap-3 pt-2">
          <Button type="submit" disabled={!dirty || updateProfile.isPending}>
            {updateProfile.isPending ? (
              <>
                <Loader2 className="size-3.5 animate-spin" /> Saving…
              </>
            ) : (
              <>
                <Save className="size-3.5" /> Save changes
              </>
            )}
          </Button>
          {saved ? (
            <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
              <CheckCircle2 className="size-3.5 text-status-success" />
              Saved
            </span>
          ) : null}
          {error ? (
            <span className="text-xs text-status-error">{error}</span>
          ) : null}
        </footer>
      </form>

      <div className="flex max-w-sm items-center justify-between gap-3 border-t border-border-subtle pt-5">
        <div className="min-w-0">
          <p className="text-xs font-medium text-text-secondary">Session</p>
          <p className="text-[11px] text-text-muted">
            Sign out of this desktop client.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => void onLogout()}
          disabled={logout.isPending}
        >
          {logout.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <LogOut className="size-3.5" />
          )}
          Log out
        </Button>
      </div>
    </section>
  );
}

/** Proxy pane — wraps its own form because it's the only pane with
 *  unsaved state. Save / status / error footer lives here, not at the
 *  page level, so switching panes doesn't smear concerns across them. */
function ProxyPane({
  proxyUrl,
  setProxyUrl,
  proxyRuntimes,
  toggleRuntime,
  setProxyRuntimes,
  proxyEnabled,
  allChecked,
  settingsLoading,
  saving,
  saved,
  error,
  onSubmit,
}: {
  proxyUrl: string;
  setProxyUrl: (v: string) => void;
  proxyRuntimes: Set<RuntimeKind>;
  toggleRuntime: (kind: RuntimeKind, checked: boolean) => void;
  setProxyRuntimes: (v: Set<RuntimeKind>) => void;
  proxyEnabled: boolean;
  allChecked: boolean;
  settingsLoading: boolean;
  saving: boolean;
  saved: boolean;
  error: string | null;
  onSubmit: (e: FormEvent) => void;
}): JSX.Element {
  return (
    <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-3xl">
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
                  disabled={settingsLoading}
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

              {/* Save row sits inline with the form content rather than
                  pinned to a sticky footer — the original bottom anchor
                  was off-screen on shorter viewports and easy to miss. */}
              <div className="flex items-center justify-between gap-4 pt-1">
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
                      Proxy changes save to host settings.
                    </span>
                  )}
                </div>
                <Button type="submit" disabled={saving || settingsLoading}>
                  {saving ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Save className="size-3.5" />
                  )}
                  {saving ? 'Saving...' : 'Save settings'}
                </Button>
              </div>
            </div>
          </SettingsSection>
        </div>
      </div>
    </form>
  );
}

/** Shared markdown font size — drives both `--md-prose-size` and
 *  `--md-code-size`. Thumb glides under the cursor (step="any") while
 *  the *applied* value still snaps to integer steps via Math.round in
 *  the change handler, so the visible 12 / 13 / 14 px ladder is
 *  preserved without the segmented hand-feel of a snapping thumb. */
function SharedFontSizeControl({
  value,
  onChange,
  onReset,
}: {
  value: number | undefined;
  onChange: (value: number) => void;
  onReset: () => void;
}): JSX.Element {
  const sizeValue = value ?? DEFAULT_MARKDOWN_FONT_SIZE;
  const isOverride = typeof value === 'number';
  const [dragRaw, setDragRaw] = useState<number | null>(null);
  const thumbValue = dragRaw ?? sizeValue;
  const settleDrag = (): void => setDragRaw(null);
  const stepBy = (delta: number): void => {
    const next = Math.min(
      FONT_SIZE_MAX,
      Math.max(FONT_SIZE_MIN, sizeValue + delta),
    );
    if (next !== sizeValue) onChange(next);
    setDragRaw(null);
  };

  return (
    <div className="grid gap-2 rounded-[8px] border border-border-subtle bg-bg-floating p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-primary">Font size</h3>
          <p className="truncate text-xs text-text-muted">
            Shared by prose and code
            {isOverride ? '' : ' · theme default'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {/* Live numeric readout — sized up and accent-colored when an
              override is active so the current value reads at a glance
              from anywhere on the row, not buried in the subtitle. */}
          <span
            aria-live="polite"
            className={cn(
              'font-mono text-lg font-semibold leading-none tabular-nums',
              isOverride ? 'text-accent' : 'text-text-secondary',
            )}
          >
            {sizeValue}
            <span className="ml-0.5 text-xs font-medium text-text-muted">
              px
            </span>
          </span>
          <button
            type="button"
            onClick={onReset}
            disabled={!isOverride}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-[6px] border border-border-subtle bg-bg-primary px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:border-accent hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border-subtle disabled:hover:text-text-secondary"
          >
            <RotateCcw className="size-3.5" />
            Reset
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 pt-1">
        <span className="font-mono text-[11px] text-text-muted">
          {FONT_SIZE_MIN}px
        </span>
        <input
          id="markdown-font-size"
          type="range"
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step="any"
          value={thumbValue}
          aria-label="Markdown font size"
          onChange={e => {
            const raw = Number(e.target.value);
            setDragRaw(raw);
            const rounded = Math.round(raw);
            if (rounded !== sizeValue) onChange(rounded);
          }}
          onPointerUp={settleDrag}
          onPointerCancel={settleDrag}
          onBlur={settleDrag}
          onKeyDown={e => {
            switch (e.key) {
              case 'ArrowLeft':
              case 'ArrowDown':
                e.preventDefault();
                stepBy(-1);
                break;
              case 'ArrowRight':
              case 'ArrowUp':
                e.preventDefault();
                stepBy(1);
                break;
              case 'PageDown':
                e.preventDefault();
                stepBy(-2);
                break;
              case 'PageUp':
                e.preventDefault();
                stepBy(2);
                break;
              case 'Home':
                e.preventDefault();
                if (sizeValue !== FONT_SIZE_MIN) onChange(FONT_SIZE_MIN);
                setDragRaw(null);
                break;
              case 'End':
                e.preventDefault();
                if (sizeValue !== FONT_SIZE_MAX) onChange(FONT_SIZE_MAX);
                setDragRaw(null);
                break;
              default:
                break;
            }
          }}
          className="settings-font-size-slider"
        />
        <span className="font-mono text-[11px] text-text-muted">
          {FONT_SIZE_MAX}px
        </span>
      </div>
    </div>
  );
}

/** Per-slot markdown font *family* control. Font size is shared and
 *  rendered separately by {@link SharedFontSizeControl}; this component
 *  only edits family + previews using the inherited shared size. */
function MarkdownFontControl({
  title,
  icon,
  fontFamily,
  fontSize,
  presets,
  sample,
  onFontChange,
  onReset,
  code = false,
}: {
  title: string;
  icon: ReactNode;
  fontFamily: string | undefined;
  fontSize: number | undefined;
  presets: ReadonlyArray<FontPreset>;
  sample: string;
  onFontChange: (value: string) => void;
  onReset: () => void;
  code?: boolean;
}): JSX.Element {
  const fontValue = fontFamily ?? '';
  const previewSize = fontSize ?? DEFAULT_MARKDOWN_FONT_SIZE;
  const sampleStyle: CSSProperties = {
    fontFamily:
      fontValue ||
      (code
        ? 'var(--md-code-font, var(--font-mono))'
        : 'var(--md-prose-font, var(--font-sans))'),
    fontSize: `${previewSize}px`,
  };

  return (
    <div className="grid gap-3 rounded-[8px] border border-border-subtle bg-bg-floating p-3">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-bg-elevated text-text-secondary">
            {icon}
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
            <p className="truncate text-xs text-text-muted">
              {fontValue || 'Theme default font'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onReset}
          disabled={!fontValue}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[6px] border border-border-subtle bg-bg-primary px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:border-accent hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border-subtle disabled:hover:text-text-secondary"
        >
          <RotateCcw className="size-3.5" />
          Reset
        </button>
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`markdown-${title.toLowerCase()}-font`}>
          Font family
        </Label>
        <Input
          id={`markdown-${title.toLowerCase()}-font`}
          value={fontValue}
          onChange={e => onFontChange(e.target.value)}
          placeholder="Theme default"
          spellCheck={false}
        />
        <div className="flex flex-wrap gap-1.5">
          {presets.map(preset => (
            <button
              key={`${title}-${preset.label}`}
              type="button"
              onClick={() => onFontChange(preset.value)}
              className={cn(
                'rounded-[999px] border px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus',
                fontValue === preset.value
                  ? 'border-accent bg-accent text-text-on-accent'
                  : 'border-border-subtle bg-bg-primary text-text-secondary hover:border-accent hover:text-text-primary',
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div
        className={cn(
          'rounded-[6px] border border-border-subtle bg-bg-primary px-3 py-2 text-text-primary',
          code ? 'font-mono' : '',
        )}
        style={sampleStyle}
      >
        {sample}
      </div>
    </div>
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
