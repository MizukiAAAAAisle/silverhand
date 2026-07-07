import { useEffect, useState, type JSX } from 'react';
import { Check, Copy, Eye, EyeOff, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import { computerCopy } from './computer-copy';

interface ConnectionCommandCardProps {
  /** The verbatim, backend-minted connect command. This is the ONLY
   *  copy/display source — never reassembled client-side. */
  daemonCommand: string;
  /** The cleartext connect token, used solely to locate + mask the secret
   *  span inside `daemonCommand` for the masked view. Never the copy
   *  source, never reconstructs the command, never persisted. */
  connectToken: string;
  /** Header-bar label. Defaults to "Connection command". */
  label?: string;
}

/**
 * #task:1348 — the reveal-once connection-command card, shared by the
 * Add-computer flow (`NewComputerDialog`) and the target-page rotate flow
 * (`HostDetailView` → Connection).
 *
 * **Terminal chrome** (shiki dogfood: "command background 不是 shell 那种
 * 感觉；reveal/copy button 位置也不对"): the command is a command you run in
 * a shell, so it's dressed as one — it reuses the app's `island` code-block
 * token family (`--bg-island` / `--bg-island-deep` / `--text-island` /
 * `--border-island`), the same surface chat renders fenced code on, so each
 * theme owns the palette (forza6's deep teal-black HUD, warm-script's warm
 * stone, slack-dark's ink). A header strip carries the label + the
 * Reveal/Copy actions (top-right, terminal-title-bar style — not a footer
 * bar); the body shows a `$` prompt before the monospace command.
 *
 * **Reveal-once discipline** (unchanged): masked by default; Reveal toggles
 * to verbatim; Copy ALWAYS writes the verbatim `daemonCommand` (never the
 * masked display, never the `$` prompt, never a reassembly); the cleartext
 * lives in local state only — never cached, never logged, discarded on
 * unmount. The caller owns the mint and decides when to mount/unmount.
 */
export function ConnectionCommandCard({
  daemonCommand,
  connectToken,
  label = computerCopy.connectionCommandLabel,
}: ConnectionCommandCardProps): JSX.Element {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(t);
  }, [copied]);

  const displayCommand = revealed
    ? daemonCommand
    : maskToken(daemonCommand, connectToken);

  const handleCopy = async (): Promise<void> => {
    // Copy source is ALWAYS the verbatim backend command.
    await navigator.clipboard.writeText(daemonCommand);
    setCopied(true);
    toast.success(computerCopy.copied);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-[var(--floating-radius)] border border-[var(--border-island)] bg-[var(--bg-island)]">
        {/* Terminal title bar: label left, Reveal + Copy right. */}
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border-island)] bg-[var(--bg-island-deep)] px-3 py-1.5">
          <span className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-[var(--text-island)] opacity-70">
            <Terminal className="size-3.5" aria-hidden />
            {label}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setRevealed(v => !v)}
              className="inline-flex items-center gap-1 px-1.5 py-1 text-[11px] font-medium text-[var(--text-island)] opacity-70 transition-opacity hover:opacity-100"
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
              className="inline-flex items-center gap-1 px-1.5 py-1 text-[11px] font-medium text-[var(--text-island)] opacity-70 transition-opacity hover:opacity-100"
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
          <code className="block whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-[var(--text-island)]">
            <span className="select-none opacity-40" aria-hidden>
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
