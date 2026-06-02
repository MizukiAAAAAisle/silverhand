/**
 * `#task:809` polish — condense `composeHostOs()` output for the host
 * detail card.
 *
 * `composeHostOs()` (daemon-side, `packages/host/src/daemon/host-os.ts`)
 * already emits reasonable strings, but Linux PRETTY_NAME values are
 * verbose by convention. shiki dogfood feedback: "OS 简写" — keep
 * distro + version, drop marketing/codename suffixes and the LTS
 * decoration so the System field stays scannable.
 *
 * Examples (input → output):
 *   "macOS 15.0.1"                         → "macOS 15.0.1"     (unchanged)
 *   "macOS 24.0.0"                         → "macOS 24.0.0"     (unchanged)
 *   "Ubuntu 22.04.4 LTS"                   → "Ubuntu 22.04.4"
 *   "Fedora Linux 40 (Workstation Edition)"→ "Fedora Linux 40"
 *   "Debian GNU/Linux 12 (bookworm)"       → "Debian GNU/Linux 12"
 *   "Arch Linux"                           → "Arch Linux"        (unchanged)
 *   "Linux 6.5.0-27-generic"               → "Linux 6.5.0-27-generic" (unchanged)
 *   "win32 10.0.19045"                     → "win32 10.0.19045"  (unchanged)
 *
 * The function is intentionally narrow — it does NOT try to map kernel
 * versions to release names, NOR localize the output. If the daemon
 * yields an empty/whitespace string we return the original verbatim
 * rather than guessing (the field renders best-effort, never throws).
 */
export function formatOsShort(os: string): string {
  if (typeof os !== 'string') return '';
  // Strip a single trailing parenthesized suffix:
  //   "Fedora Linux 40 (Workstation Edition)" → "Fedora Linux 40"
  //   "Debian GNU/Linux 12 (bookworm)"        → "Debian GNU/Linux 12"
  //   "macOS 15.0.1 (24A335)"                 → "macOS 15.0.1"
  // Only the final paren group is removed — middle-of-string parens
  // (rare in OS names) survive.
  let s = os.replace(/\s*\([^()]*\)\s*$/u, '').trim();
  // Strip the LTS decoration on Debian/Ubuntu-style PRETTY_NAMEs.
  s = s.replace(/\s+LTS$/u, '').trim();
  return s.length === 0 ? os : s;
}
