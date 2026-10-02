import { useCompactLayout } from "@/navigation/layout";
import { useLocation } from "react-router-dom";
import { useNav } from "@/router";
import { AccountSkeleton } from "./components/account-skeleton";
import { ChangePasswordForm } from "./components/change-password-form";
import { RangeInput } from "@/components/ui/range-input";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  Check,
  Code2,
  LogOut,
  Loader2,
  Palette,
  RotateCcw,
  Server,
  Settings,
  Type,
  User,
} from "lucide-react";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SidebarRow, SidebarSection } from "@/components/layout/sidebar-shared";
import { CONTROL_HOVER_LIFT } from "@/components/common/control-ink-border";
import { cn } from "@/lib/cn";
import { useAppearance } from "@/features/appearance/use-appearance";
import {
  MESSAGE_LAYOUT_MODES,
  setMessageLayoutMode,
  useMessageLayoutMode,
  type MessageLayoutMode,
} from "@/features/messages/hooks/use-message-layout-mode";
import {
  isBackendUnreachable,
  isRegistrationRequired,
  isUpdateRequired,
  useLogout,
  useViewerUser,
} from "@/features/session/hooks";
import { ViewerProfileEditor } from "@/pages/settings/components/viewer-profile-editor";
import { SettingsHeading } from "./components/settings-heading";
import {
  DEFAULT_MARKDOWN_FONT_SIZE,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  THEME_IDS,
  type ThemeId,
} from "@/features/appearance/types";
import {
  CODE_FONT_PRESETS,
  PROSE_FONT_PRESETS,
  type FontPreset,
} from "@/features/appearance/font-presets";
import {
  SETTINGS_SECTIONS,
  persistSettingsSection,
  readSettingsSection,
  type SettingsSection,
} from "../../features/settings/model/settings-section";
import { ConnectionPane } from "./components/connection-pane";
import { PaneHeader, PaneShell } from "@/components/layout/pane-shell";
import { Sidebar } from "@/components/layout/sidebar";

/** 4-color swatch preview and display name for each theme. */
const THEME_META: Record<
  ThemeId,
  {
    label: string;
    bg: string;
    surface: string;
    text: string;
    accent: string;
  }
> = {
  "studio-light": {
    label: "Studio Light",
    bg: "#F2F5F9",
    surface: "#DEE3EB",
    text: "#111725",
    accent: "#2F5AD0",
  },
  forza6: {
    label: "Forza6",
    bg: "#F4F8E8",
    surface: "#FF2C7A",
    text: "#0A0A0A",
    accent: "#D4F523",
  },
  "slack-dark": {
    label: "Slack Dark",
    bg: "#19171D",
    surface: "#350D36",
    text: "#E2E3E3",
    accent: "#1D9BD1",
  },
  iris: {
    label: "Iris",
    bg: "#E6E6B6",
    surface: "#C4D0DA",
    text: "#1F1A12",
    accent: "#6D28C9",
  },
};

export function SettingsShell(): JSX.Element {
  const {
    appearance,
    setTheme,
    setMarkdownFont,
    setMarkdownFontSize,
    resetMarkdownText,
    resetMarkdownFontSize,
  } = useAppearance();

  const compact = useCompactLayout();
  const location = useLocation();
  const nav = useNav();
  const sectionParam = new URLSearchParams(location.search).get("settingsSection");
  const [rememberedSection, setRememberedSection] = useState<SettingsSection>(readSettingsSection);
  const section = SETTINGS_SECTIONS.includes(sectionParam as SettingsSection)
    ? (sectionParam as SettingsSection)
    : rememberedSection;
  const setSection = (next: SettingsSection) => {
    setRememberedSection(next);
    nav.go(`/settings?settingsSection=${next}`);
  };
  useEffect(() => {
    persistSettingsSection(section);
  }, [section]);

  const content = (
    <PaneShell>
      <PaneHeader icon={SECTION_CHROME[section].icon} title={SECTION_CHROME[section].label} />

      <div className="flex min-h-0 min-w-0 flex-1 justify-center">
        <div className="flex min-h-0 w-full min-w-0 max-w-196 flex-col">
          {section === "appearance" ? (
            <AppearancePane
              appearance={appearance}
              setTheme={setTheme}
              setMarkdownFont={setMarkdownFont}
              setMarkdownFontSize={setMarkdownFontSize}
              resetMarkdownText={resetMarkdownText}
              resetMarkdownFontSize={resetMarkdownFontSize}
            />
          ) : section === "account" ? (
            <AccountPane />
          ) : (
            <ConnectionPane />
          )}
        </div>
      </div>
    </PaneShell>
  );
  if (compact)
    return sectionParam ? (
      content
    ) : (
      <Sidebar
        name="settings"
        fill
        sidebar={<SettingsRailNav section={null} bare onSelect={setSection} />}
      />
    );
  return (
    <Sidebar
      name="settings"
      label="Settings sections"
      width="var(--sidebar-width)"
      sidebar={<SettingsRailNav section={section} onSelect={setSection} />}
    >
      {content}
    </Sidebar>
  );
}

const SECTION_CHROME: Record<SettingsSection, { label: string; icon: ReactNode }> = {
  account: { label: "Account", icon: <User className="size-3.5" /> },
  appearance: { label: "Appearance", icon: <Palette className="size-3.5" /> },
  connection: { label: "Connection", icon: <Server className="size-3.5" /> },
};

function SettingsRailNav({
  section,
  bare = false,
  onSelect,
}: {
  /** Null on the compact list page: no detail pane is showing, so no row is current. */
  section: SettingsSection | null;
  /** Drop the group header when the page title already names the only group. */
  bare?: boolean;
  onSelect: (next: SettingsSection) => void;
}): JSX.Element {
  const rows = SETTINGS_SECTIONS.map((id) => {
    const { label, icon } = SECTION_CHROME[id];
    const selected = id === section;

    return (
      <SidebarRow
        key={id}
        icon={icon}
        title={label}
        selected={selected}
        aria-current={selected ? "page" : undefined}
        onClick={() => onSelect(id)}
      />
    );
  });

  return (
    <nav className="scrollbar-hide flex-1 overflow-y-auto py-1.5">
      {bare ? (
        <ul className="space-y-0.5">{rows}</ul>
      ) : (
        <SidebarSection
          label="SETTINGS"
          icon={<Settings className="size-3.5" />}
          collapsible
          defaultExpanded
          persistId="settings-directory"
        >
          {rows}
        </SidebarSection>
      )}
    </nav>
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
  appearance: ReturnType<typeof useAppearance>["appearance"];
  setTheme: ReturnType<typeof useAppearance>["setTheme"];
  setMarkdownFont: ReturnType<typeof useAppearance>["setMarkdownFont"];
  setMarkdownFontSize: ReturnType<typeof useAppearance>["setMarkdownFontSize"];
  resetMarkdownText: ReturnType<typeof useAppearance>["resetMarkdownText"];
  resetMarkdownFontSize: ReturnType<typeof useAppearance>["resetMarkdownFontSize"];
}): JSX.Element {
  return (
    <section
      data-appearance-pane
      className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6"
    >
      <div className="mx-auto w-full min-w-0 max-w-3xl">
        <div className="min-w-0 space-y-8">
          <SettingsSection
            id="settings-appearance"
            icon={<Palette className="size-4" />}
            title="Appearance"
          >
            <div className="grid min-w-0 grid-cols-1 gap-4">
              <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                {THEME_IDS.map((id) => {
                  const meta = THEME_META[id];
                  const active = appearance.theme === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setTheme(id)}
                      className={cn(
                        "group relative flex min-h-23 min-w-0 flex-col items-start justify-between overflow-hidden rounded-[10px] p-3 text-left focus-outline",
                        CONTROL_HOVER_LIFT,
                      )}
                      style={{
                        background: `linear-gradient(135deg, ${meta.bg}, ${meta.surface})`,
                      }}
                    >
                      <div className="flex gap-1">
                        {[meta.bg, meta.surface, meta.text, meta.accent].map((c) => (
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
          >
            <div className="grid min-w-0 grid-cols-1 gap-4">
              <SharedFontSizeControl
                value={appearance.fontSize}
                onChange={(value) => setMarkdownFontSize(value)}
                onReset={() => resetMarkdownFontSize()}
              />
              <MarkdownFontControl
                title="Prose"
                icon={<Type className="size-4" />}
                fontFamily={appearance.prose?.fontFamily}
                fontSize={appearance.fontSize}
                presets={PROSE_FONT_PRESETS}
                sample="正文预览 / Markdown body text"
                onFontChange={(value) => setMarkdownFont("prose", value || undefined)}
                onReset={() => resetMarkdownText("prose")}
              />
              <MarkdownFontControl
                title="Code"
                icon={<Code2 className="size-4" />}
                fontFamily={appearance.code?.fontFamily}
                fontSize={appearance.fontSize}
                presets={CODE_FONT_PRESETS}
                sample="const size = 12"
                onFontChange={(value) => setMarkdownFont("code", value || undefined)}
                onReset={() => resetMarkdownText("code")}
                code
              />
            </div>
          </SettingsSection>
        </div>
      </div>
    </section>
  );
}

const MESSAGE_LAYOUT_META: Record<MessageLayoutMode, string> = {
  "all-left": "All left",
  "user-right": "Mine right",
};

function MessageAlignmentControl(): JSX.Element {
  const mode = useMessageLayoutMode();

  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 rounded-(--card-radius) border border-border-subtle bg-bg-floating p-3">
      <h3 className="text-sm font-semibold text-text-primary">Message alignment</h3>
      <div role="radiogroup" aria-label="Message alignment" className="grid grid-cols-2 gap-3">
        {MESSAGE_LAYOUT_MODES.map((id) => {
          const selected = id === mode;

          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={MESSAGE_LAYOUT_META[id]}
              onClick={() => setMessageLayoutMode(id)}
              className={cn(
                "flex min-w-0 flex-col gap-3 rounded-(--control-radius) border-(length:--control-border-width) p-3 text-xs font-medium transition-colors focus-outline",
                selected
                  ? "border-(--border-row-selected) bg-(--bg-row-selected) text-text-on-selected"
                  : "border-border-subtle bg-bg-base text-text-secondary hover:border-(--border-control-hover) hover:bg-(--bg-hover) hover:text-text-primary",
              )}
            >
              <div aria-hidden="true" className="flex w-full flex-col gap-2">
                {[0, 1, 2].map((row) => (
                  <div
                    key={row}
                    className={cn(
                      "flex w-3/4 items-center gap-1.5",
                      id === "user-right" && row === 1 && "self-end flex-row-reverse",
                    )}
                  >
                    <span className="size-4 shrink-0 rounded-(--control-radius) bg-current opacity-40" />
                    <span
                      className={cn(
                        "h-3 rounded-(--control-radius) bg-current opacity-20",
                        row === 2 ? "w-2/3" : "flex-1",
                      )}
                    />
                  </div>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AccountPane(): JSX.Element {
  const viewer = useViewerUser();
  const logout = useLogout();
  const [error, setError] = useState<string | null>(null);

  const dto =
    viewer.data &&
    !isRegistrationRequired(viewer.data) &&
    !isBackendUnreachable(viewer.data) &&
    !isUpdateRequired(viewer.data)
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
    return <AccountSkeleton />;
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
      <SettingsHeading icon={<User className="size-4" />} title="Account" />

      <div className="flex max-w-2xl flex-col gap-6">
        <ViewerProfileEditor user={dto} />
        <ChangePasswordForm key={dto.id} userId={dto.id} />

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-text-secondary">Log out</p>
              <p className="text-(length:--text-meta) text-text-muted">
                Ends the current sign-in on this computer.
              </p>
            </div>
            <Button
              type="button"
              variant="destructive-outline"
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
          {error ? (
            <p className="text-xs text-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
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
  const isOverride = typeof value === "number";
  const [dragRaw, setDragRaw] = useState<number | null>(null);
  const thumbValue = dragRaw ?? sizeValue;
  const settleDrag = (): void => setDragRaw(null);
  const stepBy = (delta: number): void => {
    const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, sizeValue + delta));
    if (next !== sizeValue) onChange(next);
    setDragRaw(null);
  };

  return (
    <div className="grid min-w-0 grid-cols-1 gap-2 rounded-(--card-radius) border border-border-subtle bg-bg-floating p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-primary">Font size</h3>
          <p className="truncate text-xs text-text-muted">
            Shared by prose and code
            {isOverride ? "" : " theme default"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span
            aria-live="polite"
            className={cn(
              "font-mono text-lg font-semibold leading-none tabular-nums",
              isOverride ? "text-accent" : "text-text-secondary",
            )}
          >
            {sizeValue}
            <span className="ml-0.5 text-xs font-medium text-text-muted">px</span>
          </span>
          <button
            type="button"
            onClick={onReset}
            disabled={!isOverride}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-(--control-radius) border border-border-subtle bg-bg-elevated px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:border-(--border-control-hover) hover:text-text-primary focus-outline disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border-subtle disabled:hover:text-text-secondary"
          >
            <RotateCcw className="size-3.5" />
            Reset
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 pt-1">
        <span className="font-mono text-(length:--text-meta) text-text-muted">
          {FONT_SIZE_MIN}px
        </span>
        <RangeInput
          id="markdown-font-size"

          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step="any"
          value={thumbValue}
          aria-label="Markdown font size"
          onChange={(e) => {
            const raw = Number(e.target.value);
            setDragRaw(raw);
            const rounded = Math.round(raw);
            if (rounded !== sizeValue) onChange(rounded);
          }}
          onPointerUp={settleDrag}
          onPointerCancel={settleDrag}
          onBlur={settleDrag}
          onKeyDown={(e) => {
            switch (e.key) {
              case "ArrowLeft":
              case "ArrowDown":
                e.preventDefault();
                stepBy(-1);
                break;
              case "ArrowRight":
              case "ArrowUp":
                e.preventDefault();
                stepBy(1);
                break;
              case "PageDown":
                e.preventDefault();
                stepBy(-2);
                break;
              case "PageUp":
                e.preventDefault();
                stepBy(2);
                break;
              case "Home":
                e.preventDefault();
                if (sizeValue !== FONT_SIZE_MIN) onChange(FONT_SIZE_MIN);
                setDragRaw(null);
                break;
              case "End":
                e.preventDefault();
                if (sizeValue !== FONT_SIZE_MAX) onChange(FONT_SIZE_MAX);
                setDragRaw(null);
                break;
              default:
                break;
            }
          }}
          className="w-full"
        />
        <span className="font-mono text-(length:--text-meta) text-text-muted">
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
  const fontValue = fontFamily ?? "";
  const previewSize = fontSize ?? DEFAULT_MARKDOWN_FONT_SIZE;
  const sampleStyle: CSSProperties = {
    fontFamily:
      fontValue ||
      (code
        ? "var(--appearance-code-font, var(--font-mono))"
        : "var(--appearance-prose-font, var(--font-sans))"),
    fontSize: `${previewSize}px`,
  };

  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 rounded-(--card-radius) border border-border-subtle bg-bg-floating p-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            data-settings-icon-chip
            className="flex size-7 shrink-0 items-center justify-center rounded-(--control-radius) bg-bg-elevated text-text-secondary"
          >
            {icon}
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
            <p className="truncate text-xs text-text-muted">{fontValue || "Theme default font"}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onReset}
          disabled={!fontValue}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-(--control-radius) border border-border-subtle bg-bg-elevated px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:border-(--border-control-hover) hover:text-text-primary focus-outline disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border-subtle disabled:hover:text-text-secondary"
        >
          <RotateCcw className="size-3.5" />
          Reset
        </button>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-2">
        <Label htmlFor={`markdown-${title.toLowerCase()}-font`}>Font family</Label>
        <Input
          className="min-w-0"
          id={`markdown-${title.toLowerCase()}-font`}
          value={fontValue}
          onChange={(e) => onFontChange(e.target.value)}
          placeholder="Theme default"
          spellCheck={false}
        />
        <div className="flex flex-wrap gap-1.5">
          {presets.map((preset) => {
            const isSelected = fontValue === preset.value;
            return (
              <button
                key={`${title}-${preset.label}`}
                type="button"
                data-settings-pill
                data-selected={isSelected || undefined}
                onClick={() => onFontChange(preset.value)}
                className={cn(
                  "max-w-full [overflow-wrap:anywhere] rounded-(--pill-radius) border px-2 py-1 text-(length:--text-meta) font-medium transition-colors focus-outline",
                  isSelected
                    ? "border-accent bg-accent text-text-on-accent"
                    : "border-border-subtle bg-bg-elevated text-text-secondary hover:border-(--border-control-hover) hover:text-text-primary",
                )}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </div>

      <div
        className={cn(
          "min-w-0 [overflow-wrap:anywhere] rounded-(--control-radius) border border-border-subtle bg-bg-elevated px-3 py-2 text-text-primary",
          code ? "font-mono" : "",
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
  children,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section id={id} className="min-w-0 scroll-mt-6 grid grid-cols-1 gap-4">
      <SettingsHeading icon={icon} title={title} />
      <div className="min-w-0">{children}</div>
    </section>
  );
}
