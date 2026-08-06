import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  AlignLeft,
  AlignRight,
  Check,
  Code2,
  KeyRound,
  LogOut,
  Loader2,
  Palette,
  RotateCcw,
  Server,
  Type,
} from 'lucide-react';
import { Input, Label } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { CONTROL_HOVER_LIFT } from '@/features/common/ControlInkBorder';
import {
  destructiveAction,
  DESTRUCTIVE_TRIGGER,
} from '@/features/common/DestructiveAction';
import { cn } from '@/lib/cn';
import { useAppearance } from '@/hooks/useAppearance';
import {
  MESSAGE_LAYOUT_MODES,
  setMessageLayoutMode,
  useMessageLayoutMode,
  type MessageLayoutMode,
} from '@/components/chat/useMessageLayoutMode';
import {
  isBackendUnreachable,
  isRegistrationRequired,
  useLogout,
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
import { ConnectionPane } from './ConnectionPane';

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
     *  bottom-right (@shiki feedback `h45zG6elM7NVgPzQ`).
     *
     *  v6.9.5 note: an earlier `radius` field tried the same per-
     *  theme treatment for the card's own corner radius, but stacking
     *  three different radii in a 3-tile grid read as "inconsistent
     *  design" (@shiki "圆角都不一致了, 固定一个圆角数值就好"). Card
     *  radius is now a single fixed value across all three cards (see
     *  the `rounded-[10px]` Tailwind class on the button below) —
     *  the colour/gradient swatch is what previews the theme, the
     *  card chrome stays uniform so the grid reads as one set. */
    border: string;
  }
> = {
  'studio-light': {
    label: 'Studio Light',
    // Cool-neutral chrome + pure-white work surface + a deep blue
    // accent (#task:1656). The 4 dots preview the theme's whole
    // argument: the app tray (#DEE3EB, the deepest light layer) → the
    // sidebar carrier (#F2F5F9) → ink text → the accent. Idle tile
    // border is the tray colour so the card reads as one cool set
    // instead of borrowing the viewer's current-theme hairline.
    bg: '#F2F5F9',
    surface: '#DEE3EB',
    text: '#111725',
    accent: '#2F5AD0',
    border: 'rgba(17, 23, 37, 0.12)',
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
  'slack-dark': {
    label: 'Slack Dark',
    // Cool blue-black chrome (sidebar #19171D) + aubergine app frame
    // (#350D36, the warm Slack-记忆点) + light gray primary text +
    // brand blue accent. The 4 swatch dots show the dark surface
    // ladder (sidebar/chat bg + frame) and the two primary signals
    // (text + accent). idle tile border is the aubergine — the only
    // warm beat in the palette, lets the swatch read as "Slack" at
    // a glance.
    bg: '#19171D',
    surface: '#350D36',
    text: '#D1D2D3',
    accent: '#1D9BD1',
    border: '#350D36',
  },
};

/** Which sub-page of Settings is visible. The picker lives in the
 *  page-internal sub-nav; selection is local React state, persisted to
 *  localStorage so a refresh stays put. (No URL routing yet — settings
 *  deep-links are rare and the URL slot belongs to the chat router.) */
type SettingsSection = 'appearance' | 'account' | 'connection';
const SETTINGS_SECTIONS: ReadonlyArray<SettingsSection> = [
  'appearance',
  'account',
  'connection',
];
const SETTINGS_SECTION_KEY = 'silverhand:settings-section';

function readPersistedSection(): SettingsSection {
  if (typeof localStorage === 'undefined') return 'appearance';
  const raw = localStorage.getItem(SETTINGS_SECTION_KEY);
  // Migrate retired sections so returning users land somewhere valid.
  // `server` / `hosts` folded into Connection; `proxy` moved to the
  // Computers/Host detail surface because proxy affects runtime hosts,
  // not app-level settings. `profile` was renamed to `account` after
  // identity editing moved to Members > Human Profile — a returning
  // user who left the app on `profile` lands on Account rather than
  // on an empty section.
  if (raw === 'server' || raw === 'hosts' || raw === 'proxy') return 'connection';
  if (raw === 'profile') return 'account';
  return SETTINGS_SECTIONS.includes(raw as SettingsSection)
    ? (raw as SettingsSection)
    : 'appearance';
}

export function SettingsPage(): JSX.Element {
  const {
    appearance,
    setTheme,
    setMarkdownFont,
    setMarkdownFontSize,
    resetMarkdownText,
    resetMarkdownFontSize,
  } = useAppearance();

  const [section, setSection] = useState<SettingsSection>(readPersistedSection);
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SETTINGS_SECTION_KEY, section);
  }, [section]);

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
            Application preferences, account access, and server connection.
          </span>
        </div>
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
          ) : section === 'account' ? (
            <AccountPane />
          ) : (
            <ConnectionPane />
          )}
        </div>
      </div>
    </main>
  );
}

/** Page-internal vertical nav. The settings sub-nav is *secondary*
 *  navigation (the user already chose Settings from the rail). Rows
 *  follow the app-wide selected-row vocabulary: hover paints a pale
 *  `--bg-option-hover` preview, the selected row a bright
 *  `--bg-row-selected` fill + `--text-on-selected` ink — the same
 *  two-step hierarchy as the channel sidebar / task board, with radius
 *  on `--control-radius`. */
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
    { id: 'account', label: 'Account', icon: <KeyRound className="size-3.5" /> },
    { id: 'connection', label: 'Connection', icon: <Server className="size-3.5" /> },
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
                'flex w-full items-center gap-2 rounded-[var(--control-radius)] px-2.5 py-1.5 text-left text-sm transition-colors',
                selected
                  ? 'bg-[var(--bg-row-selected)] font-medium text-[color:var(--text-on-selected)]'
                  : 'text-text-secondary hover:bg-[var(--bg-option-hover)] hover:text-text-primary',
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
            description="Choose the visual theme and how chat messages are arranged."
          >
            <div className="grid gap-4">
              <div className="grid gap-3 sm:grid-cols-2">
              {THEME_IDS.map(id => {
                const meta = THEME_META[id];
                const active = appearance.theme === id;
                return (
                  <button
                    key={id}
                    type="button"
                    // v6.9.5 #task:917 (shiki "圆角都不一致了, 固定一个
                    // 圆角数值就好"): the three theme cards live as a
                    // single grid, so the GRID needs to read as one set.
                    // Two earlier iterations got the geometry wrong:
                    //   v6.9.3 used `data-settings-card` → radius
                    //     followed the viewer theme, cards morphed on
                    //     toggle.
                    //   v6.9.4 pinned per-target `meta.radius` → cards
                    //     stopped morphing but the 3-tile row showed
                    //     12px / 6px / 0 side-by-side, reading as
                    //     "inconsistent UI", not "preview tiles".
                    // The colour gradient + 4-dot swatch already carry
                    // the theme's identity; the card chrome should be
                    // uniform scaffolding. Fixed `rounded-[10px]` across
                    // all three, no hook, no per-target override.
                    onClick={() => setTheme(id)}
                    // Hover moves the card, it does not recolour it (shiki
                    // 2026-07-27: "hover 不要改变任何 border，直接去掉，使用
                    // hover 上移 1px 效果"). The old `hover:border-accent` was
                    // both wrong and dead: wrong because the border here is
                    // IDENTITY — the idle tile paints the previewed theme's own
                    // border and the active tile paints `accent` to mark "you
                    // are here", so a hover recolour would impersonate the
                    // selected state; dead because the idle border arrives as
                    // an inline `style.borderColor`, which outranks any
                    // Tailwind hover class. Motion is the honest channel:
                    // `CONTROL_HOVER_LIFT` is the app's shared 1px lift plus
                    // the transition tuple it needs (a bare
                    // `transition-colors` would not animate transform).
                    className={cn(
                      'group relative flex min-h-[92px] flex-col items-start justify-between overflow-hidden rounded-[10px] border-2 p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus',
                      CONTROL_HOVER_LIFT,
                      active ? 'border-accent' : 'border-border-subtle',
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
              <MessageAlignmentControl />
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

/** Message alignment — the user-side switch for `useMessageLayoutMode`
 *  (shiki 2026-08-06「这个 mode 没有真实的用户侧开关,把他做到设置页中」,
 *  #task:1841).
 *
 *  It sits in Appearance rather than in a section of its own: one row does
 *  not carry a section header, and "how the app looks" already covers row
 *  arrangement. Unlike the theme controls it takes no props — the mode is a
 *  module store (a chat row is the reader and this is the writer, so the
 *  value cannot live in either surface's `useState`), and reading it here
 *  through the same hook is what makes the selection and every mounted
 *  message row flip together.
 *
 *  Two named options rather than a checkbox: both alignments are real
 *  layouts with a name, and the labels state the scope that an on/off box
 *  would leave the user guessing at. Recipe is the app's two-option
 *  radiogroup (see `CreateChannelDialog`) — selected paints the app-wide
 *  selected-row pair (`--bg-row-selected` / `--border-row-selected`), the
 *  same vocabulary as the sub-nav beside it, so it never invents a second
 *  way to say "this one". */
const MESSAGE_LAYOUT_META: Record<
  MessageLayoutMode,
  { label: string; icon: typeof AlignLeft }
> = {
  'all-left': { label: 'All left', icon: AlignLeft },
  'user-right': { label: 'Mine right', icon: AlignRight },
};

function MessageAlignmentControl(): JSX.Element {
  const mode = useMessageLayoutMode();
  return (
    <div
      data-settings-card
      className="grid gap-2 rounded-[8px] border border-border-subtle bg-bg-floating p-3"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-primary">
            Message alignment
          </h3>
          <p className="truncate text-xs text-text-muted">
            Only your own messages move
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label="Message alignment"
          className="flex shrink-0 gap-2"
        >
          {MESSAGE_LAYOUT_MODES.map(id => {
            const meta = MESSAGE_LAYOUT_META[id];
            const selected = id === mode;
            const Icon = meta.icon;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setMessageLayoutMode(id)}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-[var(--control-radius)] border-[length:var(--control-border-width)] px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus',
                  selected
                    ? 'border-[color:var(--border-row-selected)] bg-[var(--bg-row-selected)] text-[color:var(--text-on-selected)]'
                    : 'border-border-subtle bg-[var(--bg-base)] text-text-secondary hover:border-[color:var(--border-control-hover)] hover:bg-[var(--bg-option-hover)] hover:text-text-primary',
                )}
              >
                <Icon className="size-3.5" />
                {meta.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Account pane — user-session operations only. Log out ends the
 *  current sign-in on this computer; Computer lifecycle (revoke,
 *  refresh credentials, delete) lives on Computer Detail
 *  (`features/hosts/HostDetailView`) because sessions are user-level
 *  and independent of Computer lifecycle. Display name and avatar
 *  edits live on `HumanProfileCard` in the Members panel, so
 *  `/api/me` mutations have exactly one long-lived surface.
 *
 *  Log out wears the DESTRUCTIVE rank (shiki 2026-07-26: "Settings → Account 的
 *  Log out,用 Delete 语义,因为也是 danger 操作") — red frame on paper, the same
 *  `DESTRUCTIVE_TRIGGER` recipe as `Delete computer` / `Revoke`, not a solid fill
 *  (this is a settings page, and a filled red would out-rank every other pane's
 *  primary). It is the only action on the pane, so the red is not competing with
 *  anything; what it buys is that the one irreversible-feeling verb in Settings
 *  is not dressed as a reversible one. */
function AccountPane(): JSX.Element {
  const viewer = useViewerUser();
  const logout = useLogout();
  const [error, setError] = useState<string | null>(null);

  // AccountPane only mounts after registration (App.tsx gates the shell
  // behind <RegistrationGate />), so any `registration_required` shape
  // here is a transient race during refetch. Narrow once and treat it
  // as `undefined` for the rest of the pane.
  const dto =
    viewer.data
    && !isRegistrationRequired(viewer.data)
    && !isBackendUnreachable(viewer.data)
      ? viewer.data
      : undefined;

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
        Loading account…
      </section>
    );
  }
  if (!dto) {
    return (
      <section className="flex min-w-0 flex-1 items-center justify-center py-10 text-xs text-text-muted">
        Could not load your account. Please retry from the main app.
      </section>
    );
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-5 px-5 py-5">
      <header className="flex flex-col gap-1">
        <h2 className="font-serif text-base font-semibold text-text-primary">
          Account
        </h2>
      </header>

      <div className="flex max-w-2xl flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-text-secondary">Log out</p>
            <p className="text-[11px] text-text-muted">
              Ends the current sign-in on this computer.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void onLogout()}
            disabled={logout.isPending}
            {...destructiveAction(DESTRUCTIVE_TRIGGER)}
          >
            {logout.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <LogOut className="size-3.5" />
            )}
            Log out
          </Button>
        </div>
        {error ? (
          <p className="text-xs text-error" role="alert">{error}</p>
        ) : null}
      </div>
    </section>
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
    <div
      data-settings-card
      className="grid gap-2 rounded-[8px] border border-border-subtle bg-bg-floating p-3"
    >
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
            data-settings-card
            onClick={onReset}
            disabled={!isOverride}
            // Hover border = `--border-control-hover` (ink in every theme),
            // not `accent` — see the font-preset pill below for why the
            // saturated hue can't be spent on a utility state.
            className="inline-flex shrink-0 items-center gap-1.5 rounded-[6px] border border-border-subtle bg-bg-primary px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:border-[color:var(--border-control-hover)] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border-subtle disabled:hover:text-text-secondary"
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
          data-settings-slider
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
        ? 'var(--appearance-code-font, var(--font-mono))'
        : 'var(--appearance-prose-font, var(--font-sans))'),
    fontSize: `${previewSize}px`,
  };

  return (
    <div
      data-settings-card
      className="grid gap-3 rounded-[8px] border border-border-subtle bg-bg-floating p-3"
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            data-settings-icon-chip
            className="flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-bg-elevated text-text-secondary"
          >
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
          data-settings-card
          onClick={onReset}
          disabled={!fontValue}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[6px] border border-border-subtle bg-bg-primary px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:border-[color:var(--border-control-hover)] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border-subtle disabled:hover:text-text-secondary"
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
          {presets.map(preset => {
            const isSelected = fontValue === preset.value;
            return (
              <button
                key={`${title}-${preset.label}`}
                type="button"
                // v6.9.3 #task:917 (shiki settings audit "B"):
                // `data-settings-pill` + `data-selected` let forza6
                // override the generic `border-accent bg-accent` pink
                // fill with the v6.9.2 ink-fill + paper-text recipe
                // and square the 999px radius — keeps the rest of
                // the pill (sizing, hover) intact and other themes
                // untouched.
                data-settings-pill
                data-selected={isSelected || undefined}
                onClick={() => onFontChange(preset.value)}
                className={cn(
                  'rounded-[999px] border px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus',
                  isSelected
                    ? 'border-accent bg-accent text-text-on-accent'
                    // Hover is a UTILITY state, so its border rides the
                    // canonical control token, never `accent` (shiki
                    // 2026-07-27: in forza6 `--accent` is MAGENTA, so
                    // `hover:border-accent` put a hot pink frame around an
                    // unselected font pill and read as a selection signal).
                    // `--border-control-hover` is ink in every theme
                    // (forza6 near-black / warm dark brown / slack neutral),
                    // which keeps the saturated hue budget for the SELECTED
                    // pill above.
                    : 'border-border-subtle bg-bg-primary text-text-secondary hover:border-[color:var(--border-control-hover)] hover:text-text-primary',
                )}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </div>

      <div
        data-settings-card
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
        <span
          data-settings-icon-chip
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-bg-elevated text-text-secondary"
        >
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
