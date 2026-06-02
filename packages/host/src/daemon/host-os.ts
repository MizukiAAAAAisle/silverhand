/**
 * #task:808 — daemon-side OS string composition for the `host_status`
 * snapshot consumed by the ComputerPane / host-registry view.
 *
 * Why daemon-owned (and not "stick os.platform() into the hosts table at
 * claim time"): shiki's spec — "OS 和 daemon version 是动态获取的，而不是
 * 写在 db 中的". The hosts row is identity / ACL; the operating system
 * underneath is a runtime fact that may change between daemon boots
 * (OS upgrades, future remote daemon reattach to a different host). The
 * value travels on the same `host_status` envelope as `daemon_version`
 * so backend's adapter dispatches once and lets the renderer show
 * verbatim — no per-OS UI branching.
 *
 * Best-effort detection: `node:os` + Darwin's `sw_vers` / Linux's
 * `/etc/os-release` give a friendly human label when available, with a
 * `${platform} ${release}` fallback so an unrecognized environment
 * always renders SOMETHING (renderer never sees an empty string).
 * Filesystem / child_process reads are SYNCHRONOUS by design — the
 * snapshot is small, runs once per refresh button, and stays on the
 * daemon thread (no need to plumb async into the dispatcher arm for
 * a < 5 ms call).
 *
 * NEVER throws. Every detection path swallows ENOENT / EACCES /
 * spawn failure and falls through to the generic `${platform}
 * ${release}` shape; OS labeling is cosmetic and must never tank a
 * `host_status` response.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { arch as osArch, platform as osPlatform, release as osRelease } from 'node:os';

export function composeHostOs(): string {
  const platform = osPlatform();
  if (platform === 'darwin') return composeDarwin();
  if (platform === 'linux') return composeLinux();
  // Best-effort: Windows / FreeBSD / other Node-supported targets render
  // as `${platform} ${release}` (e.g. `win32 10.0.19045`). v1 is macOS-only
  // (CLAUDE.md), but the daemon protocol is host-generic — we don't
  // pretend the field is meaningful, we just don't blank it.
  return `${platform} ${osRelease()}`.trim();
}

export function hostOsArch(): string {
  return osArch();
}

function composeDarwin(): string {
  try {
    const productVersion = execFileSync('sw_vers', ['-productVersion'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();
    if (productVersion) return `macOS ${productVersion}`;
  } catch {
    // sw_vers missing / sandboxed / timed out — fall through.
  }
  return `macOS ${osRelease()}`;
}

function composeLinux(): string {
  try {
    // /etc/os-release is the systemd-era cross-distro convention; the
    // `PRETTY_NAME` line is the user-facing label distros set for themselves
    // (e.g. `Ubuntu 22.04.4 LTS`, `Fedora Linux 40 (Workstation Edition)`).
    const content = readFileSync('/etc/os-release', 'utf8');
    for (const line of content.split('\n')) {
      const m = line.match(/^PRETTY_NAME=(.+)$/);
      if (!m || m[1] === undefined) continue;
      const raw = m[1].trim();
      // Strip optional surrounding quotes (the spec allows both forms).
      const stripped = raw.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      if (stripped) return stripped;
    }
  } catch {
    // ENOENT (alpine without os-release, container slim images), EACCES,
    // etc. — fall through to the generic shape.
  }
  return `Linux ${osRelease()}`;
}
