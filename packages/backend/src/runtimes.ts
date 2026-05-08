import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import type { RuntimeInfo, RuntimeKind } from '@silverhand/shared';

const DETECT_BINARIES: Record<RuntimeKind, string> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor-agent',
  gemini: 'gemini',
};

/**
 * Per-kind, per-platform candidate paths probed BEFORE `which <bin>`.
 *
 * Motivation (codex / macOS): the npm-installed wrapper at
 * `~/.npm-global/bin/codex` is a Node script that re-spawns the real
 * `@openai/codex-darwin-arm64` binary after a fresh dyld + Node startup.
 * Cold-start latency for the wrapper is empirically 10–22s, which used
 * to push our 30s init watchdog past the line and SIGTERM Codex before
 * it could emit `session_init` (see
 * `docs/incident-2026-05-08-codex-init-watchdog.md` §5 P2). Slock-ai
 * resolves codex by preferring the native bundle binary inside
 * `Codex.app` on macOS, which skips the wrapper entirely and typically
 * cuts cold start in half.
 *
 * We deliberately do NOT version-match the bundle against the npm CLI:
 * the user has already accepted the bundle by installing Codex.app, and
 * gating on version equality would silently disable the optimization
 * for anyone on a slightly different release. If alpha-bundle
 * incompatibility surfaces, fix the driver to handle both — don't fall
 * back to the slow wrapper.
 */
const PLATFORM_CANDIDATES: Partial<Record<RuntimeKind, Partial<Record<NodeJS.Platform, string[]>>>> = {
  codex: {
    darwin: ['/Applications/Codex.app/Contents/Resources/codex'],
  },
};

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

async function which(bin: string): Promise<string | null> {
  return new Promise(resolve => {
    const proc = spawn('which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.on('error', () => resolve(null));
    proc.on('close', code => {
      const path = out.trim();
      resolve(code === 0 && path ? path : null);
    });
  });
}

/**
 * Resolve `kind` to an executable path. Tries platform-specific known
 * locations first (see `PLATFORM_CANDIDATES`), then falls back to a
 * PATH lookup via `which`.
 */
async function resolveBinary(kind: RuntimeKind, bin: string): Promise<string | null> {
  const candidates = PLATFORM_CANDIDATES[kind]?.[process.platform] ?? [];
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return which(bin);
}

/**
 * Run `<bin> --version` and parse a semver-ish token out of the first
 * line of output.
 *
 * Timeout note: bumped from 3s to 30s on 2026-05-08. The codex npm
 * wrapper takes 10–22s on a cold dyld (fnm Node start + `require.resolve`
 * + spawning the real binary), so a 3s probe was returning `null`
 * version even when the runtime was perfectly installed and would have
 * answered eventually. 30s leaves headroom for the slowest observed
 * wrapper start while still bounding the hang if a binary is genuinely
 * stuck. Same incident: `docs/incident-2026-05-08-codex-init-watchdog.md`.
 */
async function probeVersion(bin: string): Promise<string | null> {
  return new Promise(resolve => {
    const proc = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    proc.on('error', () => resolve(null));
    const timer = setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 30_000);
    proc.on('close', () => {
      clearTimeout(timer);
      const text = (out || err).trim();
      const match = text.match(/\d+\.\d+(?:\.\d+)?/);
      resolve(match ? match[0] : (text.split('\n')[0]?.trim() ?? null));
    });
  });
}

export async function detectRuntimes(): Promise<RuntimeInfo[]> {
  const kinds = Object.keys(DETECT_BINARIES) as RuntimeKind[];
  const results = await Promise.all(
    kinds.map(async kind => {
      const bin = DETECT_BINARIES[kind];
      const path = await resolveBinary(kind, bin);
      if (!path) {
        return { kind, installed: false, binary: null, version: null } satisfies RuntimeInfo;
      }
      const version = await probeVersion(path);
      return { kind, installed: true, binary: path, version } satisfies RuntimeInfo;
    }),
  );
  return results;
}
