import {
  type Driver,
  type DriverIO,
  type DriverSpawnContext,
  type ParsedEvent,
} from './index.js';
import {
  AcpClient,
  type AcpPermissionPolicy,
  type AcpRuntimeAdapter,
} from './acp.js';

const OPENCODE_PERMISSION_POLICY: AcpPermissionPolicy = {
  // Match the rest of Silverhand's agent runtimes: the runtime process is
  // trusted with machine access, while Silverhand's own capability buckets stay
  // the authorization boundary.
  shouldAllow: () => true,
};

class OpenCodeAcpAdapter implements AcpRuntimeAdapter {
  readonly runtimeLabel = 'OpenCode';
  readonly permissionPolicy = OPENCODE_PERMISSION_POLICY;

  buildInitializeParams(_ctx: DriverSpawnContext): Record<string, unknown> {
    return {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
        session: {
          configOptions: {
            select: true,
            boolean: false,
          },
        },
      },
      clientInfo: {
        name: 'silverhand',
        version: '1.0.0',
      },
    };
  }

  buildSessionParams(ctx: DriverSpawnContext): Record<string, unknown> {
    return {
      cwd: ctx.workspacePath,
      mcpServers: [],
      ...(ctx.cliSessionId ? { sessionId: ctx.cliSessionId } : {}),
    };
  }

  buildSetModelParams(
    ctx: DriverSpawnContext,
    sessionId: string,
  ): Record<string, unknown> | null {
    if (!ctx.model) return null;
    return {
      sessionId,
      configId: 'model',
      value: ctx.model,
    };
  }
}

/**
 * OpenCode ACP driver.
 *
 * OpenCode is a long-lived ACP v1 JSON-RPC/stdio runtime (`opencode acp`).
 * The supervisor still sees the ordinary Driver contract; ACP handshake,
 * session/prompt lifecycle, permission requests, and turn-boundary gating
 * live inside the composed AcpClient.
 */
export class OpenCodeDriver implements Driver {
  readonly kind = 'opencode' as const;
  readonly binary = 'opencode';
  readonly kickoffMode = 'self_inits' as const;
  readonly busyDeliveryMode = 'gated' as const;
  readonly oneShot = false;
  readonly supportsNativeStandingPrompt = true;
  readonly initLivenessSilenceMs = 30 * 1000;
  readonly initPreProtocolCapMs = 5 * 60 * 1000;
  readonly initPostProtocolMs = 60 * 1000;

  private readonly acp = new AcpClient(new OpenCodeAcpAdapter());

  buildArgs(ctx: DriverSpawnContext): string[] {
    return ['acp', '--cwd', ctx.workspacePath];
  }

  applyEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...baseEnv, NO_COLOR: '1' };
  }

  bindIO(io: DriverIO): void {
    this.acp.bindIO(io);
  }

  encodeStdinMessage(content: string, _cliSessionId: string | null): string | null {
    return this.acp.encodeStdinMessage(content);
  }

  readyToEncode(): boolean {
    return this.acp.readyToEncode();
  }

  encodeInterruptControl(): string | null {
    return this.acp.encodeInterruptControl();
  }

  parseLine(line: string): ParsedEvent[] {
    return this.acp.parseLine(line);
  }

  classifyInitProgress(line: string): 'protocol_ready' | 'session_ready' | null {
    return this.acp.classifyInitProgress(line);
  }
}
