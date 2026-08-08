import { useEffect, useState, type JSX } from 'react';
import { Check, Copy, Eye, EyeOff, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import { assembleConnectCommand } from '@silverhand/shared';
import { computerCopy } from './computer-copy';

interface ConnectionCommandCardProps {
  /** Server-owned launch recipe (npm spec) from the bootstrap payload —
   *  passed straight to `assembleConnectCommand`. */
  daemonNpmSpec: string;
  /** The reveal-once connect credential minted by the server. Assembled INTO
   *  the command here, and also used to locate + mask the secret span for the
   *  masked view. Never persisted, never cached. */
  connectToken: string;
  /** This desktop's OWN connected server URL (`BackendInfo.url`) — the
   *  proven-reachable origin it already talks to, and the SOLE source of the
   *  daemon's reach URL. Never the server's bind address. */
  connectedServerUrl: string;
  /** Header-bar label. Defaults to "Connection command". */
  label?: string;
}

/**
 * #task:1348 / #task:1428 — the reveal-once connection-command card, shared by
 * the Add-computer flow (`NewComputerDialog`) and the target-page rotate flow
 * (`HostDetailView` → Connection).
 *
 * **#task:1428 reversal of #task:1348's "backend mints, client never
 * recomposes"**: the command is now ASSEMBLED HERE, locally, via the shared
 * `assembleConnectCommand`. The reach URL is a topology fact the EDGE owns
 * (`docs/orchestration-boundary-v1.md §4.3`): the desktop knows the server URL
 * it is actually connected to — a proven-reachable origin — while the server,
 * behind a reverse proxy / NAT, only ever saw its own bind address (the old
 * bug: a plausible-but-wrong `http://<bind-ip>` command). So the server now
 * ships only identity + recipe (token + `daemonNpmSpec`); the reach URL is
 * ALWAYS this desktop's own connected server URL — server-origin input is fully
 * out of the connect-command path (no split-horizon override). The arg-name
 * format is NOT re-spelled here — `assembleConnectCommand` is the single source
 * (symmetric with the daemon's `parseConnectArgv`), so this card carries zero
 * command-format knowledge.
 *
 * **Reveal-once discipline is unchanged** — the security property rides the
 * TOKEN, not the string. Copy ALWAYS writes the locally-assembled verbatim
 * command (never the masked display, never the `$` prompt); the cleartext token
 * lives in caller-owned local state only, and the assembled string is a
 * render-scope value — never cached, never logged, discarded on unmount. The
 * caller owns the mint and decides when to mount/unmount.
 *
 * **Terminal chrome** (shiki dogfood: "command background 不是 shell 那种
 * 感觉；reveal/copy button 位置也不对"; then 2026-07-26: "黑色背景 + 绿色字体，
 * 就像终端那样"): the command is a command you run in a shell, so the card is
 * dressed as the shell itself — the non-themable `terminal` token family
 * (`--bg-terminal` / `--bg-terminal-chrome` / `--text-terminal` /
 * `--border-terminal`, defined once in `global.css`). It deliberately does NOT
 * follow the theme palette: it used to ride the `island` code-block family,
 * whose whole contract is "each theme owns the code surface", which made this
 * card read as three different app surfaces and as no terminal at all. A header
 * strip carries the label + the Reveal/Copy actions (top-right,
 * terminal-title-bar style — not a footer bar); the body shows a `$` prompt
 * before the monospace command. The green is spent on the COMMAND only — the
 * title bar keeps neutral ink (`--text-terminal-chrome`; shiki: "卡片的 header
 * 不需要一起变绿"), so the phosphor marks shell output instead of decorating the
 * whole card. Selection is scoped too, via the `data-terminal-surface` hook on
 * the root: a surface that opts out of the theme palette must design its own
 * `::selection`, or the global theme wash lands on a ground it was never
 * chosen for (shiki saw forza6's faint magenta read as muddy purple here).
 */
export function ConnectionCommandCard({
  daemonNpmSpec,
  connectToken,
  connectedServerUrl,
  label = computerCopy.connectionCommandLabel,
}: ConnectionCommandCardProps): JSX.Element {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(t);
  }, [copied]);

  // The reach URL is ALWAYS this desktop's own connected server URL — the
  // single source, so the two callers can never diverge and the server bind
  // address never reaches here. Assembled locally (see docblock). Empty only
  // for the sub-second tick before BackendInfo resolves — guarded so we never
  // render a malformed `--server-url` with no value or copy a broken command.
  const daemonCommand = connectedServerUrl
    ? assembleConnectCommand({
        daemonNpmSpec,
        serverUrl: connectedServerUrl,
        connectToken,
      })
    : '';

  const displayCommand = revealed
    ? daemonCommand
    : maskToken(daemonCommand, connectToken);

  const handleCopy = async (): Promise<void> => {
    if (!daemonCommand) return;
    // Copy source is ALWAYS the locally-assembled verbatim command.
    await navigator.clipboard.writeText(daemonCommand);
    setCopied(true);
    toast.success(computerCopy.copied);
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        data-terminal-surface
        className="overflow-hidden rounded-[var(--floating-radius)] border border-[var(--border-terminal)] bg-[var(--bg-terminal)]"
      >
        {/* Terminal title bar: label left, Reveal + Copy right. */}
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border-terminal)] bg-[var(--bg-terminal-chrome)] px-3 py-1.5">
          <span className="inline-flex items-center gap-1.5 font-mono text-[length:var(--text-meta)] uppercase tracking-wider text-[var(--text-terminal-chrome)]">
            <Terminal className="size-3.5" aria-hidden />
            {label}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setRevealed(v => !v)}
              disabled={!daemonCommand}
              className="inline-flex items-center gap-1 px-1.5 py-1 font-mono text-[length:var(--text-meta)] text-[var(--text-terminal-chrome)] transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
              aria-label={revealed ? computerCopy.hide : computerCopy.reveal}
            >
              {revealed ? (
                <EyeOff className="size-3.5" />
              ) : (
                <Eye className="size-3.5" />
              )}
              {revealed ? computerCopy.hide : computerCopy.reveal}
            </button>
            <button
              type="button"
              onClick={() => void handleCopy()}
              disabled={!daemonCommand}
              className="inline-flex items-center gap-1 px-1.5 py-1 font-mono text-[length:var(--text-meta)] text-[var(--text-terminal-chrome)] transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
              aria-label={computerCopy.copy}
            >
              {copied ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
              {copied ? computerCopy.copied : computerCopy.copy}
            </button>
          </div>
        </div>
        {/* Body: `$` prompt + the command. The prompt is decorative
          * (select-none, its own span) so it's never part of the copy. */}
        <div className="max-h-32 overflow-y-auto px-3 py-2.5">
          <code className="block whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-[var(--text-terminal)]">
            <span className="select-none opacity-50" aria-hidden>
              ${' '}
            </span>
            {displayCommand}
          </code>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-text-muted">
        {computerCopy.revealOnceNotice}
      </p>
    </div>
  );
}

/**
 * Replace every occurrence of the cleartext token inside the verbatim
 * command with a fixed-width dot run for the masked display. Pure so a
 * unit test can pin "mask hides the token, reveal is verbatim" without
 * rendering. Never used to reconstruct the command.
 */
export function maskToken(command: string, token: string): string {
  if (!token) return command;
  return command.split(token).join('•'.repeat(12));
}
