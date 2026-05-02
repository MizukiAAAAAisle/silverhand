import { spawn } from 'node:child_process';
import type { RuntimeInfo, RuntimeKind } from '@silverhand/shared';

const DETECT_BINARIES: Record<RuntimeKind, string> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor-agent',
  gemini: 'gemini',
};

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
    }, 3000);
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
      const path = await which(bin);
      if (!path) {
        return { kind, installed: false, binary: null, version: null } satisfies RuntimeInfo;
      }
      const version = await probeVersion(path);
      return { kind, installed: true, binary: path, version } satisfies RuntimeInfo;
    }),
  );
  return results;
}
