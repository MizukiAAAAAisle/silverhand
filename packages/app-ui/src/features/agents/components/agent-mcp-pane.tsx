import { McpSkeleton } from "./agent-loading";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  GlobeIcon,
  InfoIcon,
  IntegrationIcon,
  LockIcon,
  ShieldCheckIcon,
  SpinnerIcon,
  TerminalIcon,
  WarningIcon,
} from "@/icons";
import {
  MCP_CONFIG_FILENAME,
  parseMcpConfig,
  projectProfileMcpForRuntime,
  runtimeCatalogEntry,
  runtimeLabel,
  runtimeMcpServerName,
  type McpProbePhase,
  type McpProbeResult,
  type McpServerConfig,
  type RuntimeKind,
} from "@silverhand/shared";
import { cn } from "@/lib/cn";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ProfileSection } from "@/features/profile/profile-summary-sections";
import { useAgentProfileMcp, useMcpProbe } from "../hooks/hooks";
import { t, withStrong } from "@/lib/i18n";

interface AgentMcpPaneProps {
  agentId: string;
  runtime: RuntimeKind;
}

/**
 * MCP section of the agent panel — a **read-only overview with explicit
 * triggers**. Opening the page has zero side effects: it only renders the
 * already-stored raw `mcp.json` and a locally-parsed server summary. It never
 * auto-checks and never connects to an MCP server.
 *
 * Two distinct checks, deliberately kept apart so the UI never overclaims:
 *  - **Check config** (v1, here) — the in-process static check: parse + schema
 *    (`parseMcpConfig`) + runtime projection, the SAME `@silverhand/shared`
 *    code the CLI's `profile mcp validate` and the spawn loader run. Answers
 *    "is this file well-formed and projectable?" — NOT "does the server work?".
 *    No network, no new backend route.
 *  - **Probe** (Test connection / List tools, per-server) — the live "is this
 *    server usable" check: the host opens the transport, runs the MCP
 *    `initialize` handshake and optionally `tools/list`, then closes (one-shot;
 *    the renderer holds NO connection). Runs on the host/daemon — CORS, secret
 *    headers, stdio `command` spawn, and the "issued from the agent's own
 *    network" boundary all rule out the renderer. The UI just fires
 *    `useMcpProbe` and renders the redacted snapshot. Explicit, per-server,
 *    never on mount, never polled (#1138 UI ↔ Alice's #1137 host action).
 *
 * Scope model: the page is "MCP"; this block is the **Profile** scope (the
 * `mcp.json` in the subject's L1 home dir). A future Workspace scope
 * stacks as a sibling block on the same page — it is intentionally NOT bound to
 * any single workspace panel.
 *
 * Config truth stays the raw `mcp.json`; the summary and any trigger result are
 * derived views / one-shot diagnostics, never written back.
 */
export function AgentMcpPane({ agentId, runtime }: AgentMcpPaneProps): JSX.Element {
  const query = useAgentProfileMcp(agentId);

  if (query.isLoading) {
    return <McpSkeleton />;
  }

  // The raw config can carry secrets, so the backend hands it to the creator
  // only — a non-editor viewer gets 403. Render that as a calm "private" state,
  // not a generic error (mirrors AgentProfileCard's read-only notice intent).
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 403) {
      return (
        <div className="mx-auto max-w-3xl">
          <EmptyCard
            icon={<LockIcon className="size-6 text-text-muted" />}
            title={t("agents.mcpConfigIsPrivate")}
            body={t("agents.onlyTheAgentsCreator")}
          />
        </div>
      );
    }
    return (
      <PaneMessage>
        {t("agents.mcpLoadFailed")} {String(query.error)}
      </PaneMessage>
    );
  }

  return <ProfileMcpScope agentId={agentId} runtime={runtime} raw={query.data ?? null} />;
}

// ── Profile scope block ──────────────────────────────────────────────────

function ProfileMcpScope({
  agentId,
  runtime,
  raw,
}: {
  agentId: string;
  runtime: RuntimeKind;
  raw: string | null;
}): JSX.Element {
  // Best-effort parse for the *display* summary. This is pure local parsing of
  // bytes we already hold — not the "Check config" action, which is the
  // explicit, button-triggered verdict below. A malformed file simply can't
  // render a summary; we say so and lean on Check config (or the raw view).
  const parsed = useMemo(() => parseMcpConfig(raw ?? ""), [raw]);
  const servers = parsed.ok ? parsed.config.mcpServers : null;
  const serverNames = servers ? Object.keys(servers) : [];
  // Does this runtime actually load profile MCP at spawn? When not, the config
  // is kept and shown but never takes effect — so we drop the Check config
  // trigger (there's no projection to check against) and replace the next-spawn
  // promise with an honest "ignored at spawn" warning.
  const supported = runtimeSupportsProfileMcp(runtime);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-serif text-lg font-semibold leading-tight text-text-primary">
            {t("agents.profileMcp")}
          </h2>
          {runtime !== "pi" ? (
            <p className="mt-1 text-sm text-text-muted">{t("agents.globalMcpServersLoaded")}</p>
          ) : null}
        </div>
        {supported ? <ConfigCheckButton raw={raw} runtime={runtime} /> : null}
      </header>

      {supported ? (
        <NoticeLine icon={<InfoIcon className="size-3.5 shrink-0" />}>
          {withStrong(t("agents.mcpNextSpawn"))}
        </NoticeLine>
      ) : (
        <div className={cn(NOTICE_FRAME_CLASS, "text-text-secondary")}>
          <WarningIcon className="mt-0.5 size-3.5 shrink-0 text-error" />
          <span>
            {runtime === "pi" ? (
              <>{t("agents.mcpIsConfiguredThrough")}</>
            ) : (
              <>{withStrong(t("agents.mcpUnsupported", { runtime: runtimeLabel(runtime) }))}</>
            )}
          </span>
        </div>
      )}

      <ProfileSection title={t("agents.servers")}>
        {!parsed.ok ? (
          <div className="flex items-start gap-2 text-sm text-text-secondary">
            <WarningIcon className="size-4 shrink-0 text-error" />
            <span>
              {t("agents.mcpInvalid")}{" "}
              {supported ? (
                <>{withStrong(t("agents.mcpRunCheck"))}</>
              ) : (
                <>{t("agents.expandTheRawView")}</>
              )}
            </span>
          </div>
        ) : serverNames.length === 0 ? (
          <EmptyServers />
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle/70">
            {serverNames.map((name) => (
              <ServerRow
                key={name}
                agentId={agentId}
                name={name}
                server={servers![name]!}
                canProbe={supported}
              />
            ))}
          </ul>
        )}
      </ProfileSection>

      <RawConfig raw={raw} />
    </div>
  );
}

// ── Server summary row ───────────────────────────────────────────────────

function ServerRow({
  agentId,
  name,
  server,
  canProbe,
}: {
  agentId: string;
  name: string;
  server: McpServerConfig;
  canProbe: boolean;
}): JSX.Element {
  const isRemote = "url" in server;
  const type = isRemote ? server.type : "stdio";
  const target = isRemote ? server.url : [server.command, ...(server.args ?? [])].join(" ");
  // Secrets live in env / headers values — we count keys, never show values.
  const secretCount = isRemote
    ? server.headers
      ? Object.keys(server.headers).length
      : 0
    : server.env
      ? Object.keys(server.env).length
      : 0;
  const secretLabel = isRemote ? "headers" : "env";
  const runtimeName = runtimeMcpServerName("profile", name);

  // One probe mutation per row → isolated pending/result state. `variables`
  // tells which action (Test connection vs List tools) is currently in flight.
  const probe = useMcpProbe(agentId);
  const pendingTools = probe.isPending && probe.variables?.include_tools === true;
  const pendingConnect = probe.isPending && !probe.variables?.include_tools;
  // The probe result is the OUTPUT of an explicit action — only mount its block
  // once something has happened, so an idle row stays pure static config and the
  // result never reads as just another metadata field.
  const showProbe = canProbe && (probe.isPending || probe.isError || probe.data != null);

  return (
    <li className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-2">
        <span className="truncate font-mono text-sm text-text-primary">{name}</span>
        <TypeBadge type={type} />
        {canProbe ? (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <ProbeButton
              label={t("agents.testConnection")}
              pending={pendingConnect}
              disabled={probe.isPending}
              onClick={() => probe.mutate({ server_name: name, include_tools: false })}
            />
            <ProbeButton
              label={t("agents.listTools")}
              pending={pendingTools}
              disabled={probe.isPending}
              onClick={() => probe.mutate({ server_name: name, include_tools: true })}
            />
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5 font-mono text-xs text-text-muted" title={target}>
        {isRemote ? (
          <GlobeIcon className="size-3 shrink-0" />
        ) : (
          <TerminalIcon className="size-3 shrink-0" />
        )}
        <span className="truncate">{target}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-(length:--text-meta) text-text-muted">
        <span title={t("agents.mcpRuntimeNameHint")}>
          {t("agents.mcpRuntimeName")} <code className="font-mono">{runtimeName}</code>
        </span>
        {secretCount > 0 ? (
          <span title={t("agents.presentButNotShown")}>
            {secretLabel}: {secretCount}
          </span>
        ) : null}
      </div>
      {showProbe ? (
        // Set the live-probe snapshot apart from the static config above with a
        // neutral-ink left rule — it's diagnostic output, not a config field.
        <div className="mt-0.5 border-l-2 border-border-subtle pl-2.5">
          <ProbeResult probe={probe} />
        </div>
      ) : null}
    </li>
  );
}

function ProbeButton({
  label,
  pending,
  disabled,
  onClick,
}: {
  label: string;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-6 gap-1.5 px-2 text-(length:--text-meta)"
      disabled={disabled}
      onClick={onClick}
    >
      {pending ? <SpinnerIcon className="size-3 shrink-0 animate-spin" /> : null}
      {label}
    </Button>
  );
}

/**
 * One-shot probe result snapshot for a server row. Renders nothing until the
 * user triggers a probe. Two failure layers: a transport/HTTP error (the
 * request itself failed — `probe.isError`) vs a protocol failure (HTTP 200 with
 * `ok: false`, the host reached a `phase` and stopped). `message` is already
 * redacted server-side.
 */
function ProbeResult({ probe }: { probe: ReturnType<typeof useMcpProbe> }): JSX.Element | null {
  if (probe.isPending) {
    return (
      <div className="flex items-center gap-1.5 text-(length:--text-meta) text-text-muted">
        <SpinnerIcon className="size-3 shrink-0 animate-spin" />
        {t("agents.probing")}
      </div>
    );
  }
  if (probe.isError) {
    const err = probe.error;
    const detail =
      err instanceof ApiError && err.status === 404
        ? t("agents.probeEndpointNotAvailable")
        : String(err);
    return <ProbeLine ok={false}>{t("agents.probeFailedDetail", { detail })}</ProbeLine>;
  }
  const result = probe.data;
  if (!result) return null;

  if (!result.ok) {
    return (
      <ProbeLine ok={false}>
        {probePhaseLabel(result.phase)}
        {result.message ? <span className="font-mono"> — {result.message}</span> : null}
      </ProbeLine>
    );
  }

  // Success. `tools` phase → the user asked for tools; otherwise it's a plain
  // reachability check that completed `initialize`.
  if (result.phase === "tools") {
    return <ProbeTools tools={result.tools ?? []} />;
  }
  return (
    <ProbeLine ok>
      {t("agents.connected")}
      {result.server_info?.name ? (
        <span className="text-text-muted">
          {" "}
          {result.server_info.name}
          {result.server_info.version ? ` ${result.server_info.version}` : ""}
        </span>
      ) : null}
    </ProbeLine>
  );
}

function ProbeTools({ tools }: { tools: NonNullable<McpProbeResult["tools"]> }): JSX.Element {
  const [open, setOpen] = useState(true);
  const list = tools ?? [];
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs text-success transition-colors"
      >
        <ShieldCheckIcon className="size-3.5 shrink-0" />
        <span>{t("agents.connectedTools", { count: list.length })}</span>
        {list.length > 0 ? (
          <ChevronRightIcon
            className={cn("size-3.5 text-text-muted transition-transform", open ? "rotate-90" : "")}
          />
        ) : null}
      </button>
      {open && list.length > 0 ? (
        <ul className="max-h-40 overflow-auto border border-border-subtle bg-bg-base/60 p-2">
          {list.map((tool) => (
            <li key={tool.name} className="flex flex-col py-0.5">
              <span className="font-mono text-xs text-text-primary">{tool.name}</span>
              {tool.description ? (
                <span
                  className="truncate text-(length:--text-meta) text-text-muted"
                  title={tool.description}
                >
                  {tool.description}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ProbeLine({ ok, children }: { ok: boolean; children: ReactNode }): JSX.Element {
  return (
    <div className={cn("flex items-start gap-1.5 text-xs", ok ? "text-success" : "text-error")}>
      {ok ? (
        <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" />
      ) : (
        <WarningIcon className="mt-0.5 size-3.5 shrink-0" />
      )}
      <span className="leading-snug">{children}</span>
    </div>
  );
}

function probePhaseLabel(phase: McpProbePhase): string {
  switch (phase) {
    case "parse":
      return t("agents.configParseFailed");
    case "not_found":
      return t("agents.serverNotFoundIn");
    case "connect":
      return t("agents.connectionFailed");
    case "initialize":
      return t("agents.initializeFailed");
    case "tools":
      return t("agents.toolsListFailed");
    default:
      return t("agents.probeFailed");
  }
}

function TypeBadge({ type }: { type: string }): JSX.Element {
  return (
    <span className="shrink-0 border border-border-subtle px-1.5 py-0.5 text-(length:--text-badge) font-medium uppercase tracking-wide text-text-muted">
      {type}
    </span>
  );
}

// ── Check config (explicit, client-side, no side effects) ────────────────

type ConfigCheckResult = { ok: true; count: number } | { ok: false; error: string };

/**
 * Run the canonical STATIC config check in-process. Identical source to the
 * CLI's `profile mcp validate`: parse + schema (`parseMcpConfig`), then the
 * runtime projection. The codex projection is fail-loud (TOML serialization),
 * so projecting here surfaces the same error the spawn loader would hit. No
 * network, no MCP connection — a pure function of the raw text. This is NOT a
 * liveness/protocol check (that's the daemon's Test connection, phase 2).
 */
function runConfigCheck(raw: string | null, runtime: RuntimeKind): ConfigCheckResult {
  const parsed = parseMcpConfig(raw ?? "");
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  try {
    projectProfileMcpForRuntime(parsed.config, runtime);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, count: Object.keys(parsed.config.mcpServers).length };
}

/**
 * Does this runtime actually load profile MCP at spawn? The shared runtime
 * catalog mirrors the host spawn loader and a host-side test asserts the two
 * stay in lockstep, so reading
 * `supportsProfileMcp` here keeps this UI in step automatically.
 */
function runtimeSupportsProfileMcp(runtime: RuntimeKind): boolean {
  return runtimeCatalogEntry(runtime).supportsProfileMcp;
}

function ConfigCheckButton({
  raw,
  runtime,
}: {
  raw: string | null;
  runtime: RuntimeKind;
}): JSX.Element {
  const [result, setResult] = useState<ConfigCheckResult | null>(null);

  // One-shot diagnostic — drop it whenever the underlying config changes so a
  // stale verdict never lingers over different bytes.
  useEffect(() => setResult(null), [raw, runtime]);

  return (
    <div className="flex shrink-0 flex-col items-end gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setResult(runConfigCheck(raw, runtime))}
        title={t("agents.staticCheckWellFormed")}
      >
        {t("agents.checkConfig")}
      </Button>
      {result ? <CheckBadge result={result} /> : null}
    </div>
  );
}

function CheckBadge({ result }: { result: ConfigCheckResult }): JSX.Element {
  if (result.ok) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-success">
        <ShieldCheckIcon className="size-3.5 shrink-0" />
        <span>{t("agents.configOk", { count: result.count })}</span>
      </div>
    );
  }
  return (
    <div className="flex max-w-[16rem] items-start gap-1.5 text-xs text-error">
      <WarningIcon className="mt-0.5 size-3.5 shrink-0" />
      <span className="font-mono leading-snug">{result.error}</span>
    </div>
  );
}

// ── Raw mcp.json (collapsed by default) ──────────────────────────────────

function RawConfig({ raw }: { raw: string | null }): JSX.Element {
  // Collapsed by default: the summary is the friendly view, and the raw file
  // can contain secret values we'd rather not splash on screen until asked.
  const [open, setOpen] = useState(false);
  const hasRaw = raw != null && raw.trim().length > 0;

  return (
    <ProfileSection
      title={t("agents.rawMcpJson")}
      headerSlot={hasRaw ? <CopyButton text={raw} label={t("agents.copy")} /> : undefined}
    >
      {!hasRaw ? (
        <p className="text-sm text-text-muted">
          {t("agents.noConfigFile", { file: MCP_CONFIG_FILENAME })}
        </p>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary"
          >
            <ChevronRightIcon
              className={cn("size-3.5 transition-transform", open ? "rotate-90" : "")}
            />
            {open ? t("agents.hideRawConfig") : t("agents.showRawConfig")}
          </button>
          {open ? (
            <pre className="mt-2 max-h-96 overflow-auto border border-border-subtle bg-bg-base/60 p-3 font-mono text-xs leading-relaxed text-text-primary">
              {raw}
            </pre>
          ) : null}
        </>
      )}
    </ProfileSection>
  );
}

// ── Small shared bits ────────────────────────────────────────────────────

function EmptyServers(): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 py-6 text-center">
      <IntegrationIcon className="size-6 text-text-muted" />
      <p className="text-sm text-text-primary">{t("agents.noMcpServersConfigured")}</p>
      <p className="max-w-xs text-xs text-text-muted">{t("agents.askThisAgentTo")}</p>
    </div>
  );
}

function EmptyCard({
  icon,
  title,
  body,
}: {
  icon: JSX.Element;
  title: string;
  body: string;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 border border-border-subtle bg-bg-floating/50 py-10 text-center">
      {icon}
      <p className="text-sm text-text-primary">{title}</p>
      <p className="max-w-md text-xs text-text-muted">{body}</p>
    </div>
  );
}

// Same frame tokens as the profile sections below, so the notice follows each
// theme's panel border and radius.
const NOTICE_FRAME_CLASS =
  "flex items-start gap-2 rounded-[var(--profile-section-radius,var(--card-radius))] border-(length:--panel-border-width) border-border-subtle bg-bg-floating/50 px-3 py-2 text-xs leading-relaxed";

function NoticeLine({ icon, children }: { icon: JSX.Element; children: ReactNode }): JSX.Element {
  return (
    <div className={cn(NOTICE_FRAME_CLASS, "text-text-muted")}>
      <span className="mt-0.5 text-text-muted">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

function PaneMessage({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="mx-auto max-w-3xl py-10 text-center text-sm text-text-muted">{children}</div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="inline-flex items-center gap-1.5 rounded-(--control-radius) text-(length:--text-meta) text-text-secondary transition-colors hover:text-text-primary focus-outline"
      title={t("agents.copyToClipboard")}
    >
      {copied ? (
        <CheckIcon className="size-3 shrink-0" />
      ) : (
        <CopyIcon className="size-3 shrink-0" />
      )}
      <span className="truncate">{copied ? t("agents.copied") : label}</span>
    </button>
  );
}
