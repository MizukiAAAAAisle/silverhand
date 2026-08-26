import { SILVERHAND_OPENCODE_AGENT } from '@silverhand/shared';
import {
  AcpClient,
  type AcpPermissionPolicy,
  type AcpRuntimeAdapter,
} from './acp.js';
import {
  type Driver,
  type DriverIO,
  type DriverSpawnContext,
  type ParsedEvent,
} from './index.js';

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

  buildSessionConfigRequests(
    ctx: DriverSpawnContext,
    sessionId: string,
  ): Array<Record<string, unknown>> {
    const requests: Array<Record<string, unknown>> = [
      {
        sessionId,
        configId: 'mode',
        value: SILVERHAND_OPENCODE_AGENT,
      },
    ];
    if (ctx.model) {
      requests.push({
        sessionId,
        configId: 'model',
        value: ctx.model,
      });
    }
    return requests;
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
  readonly releaseProfile = 'prompt-boundary' as const;
  // #task:2210: OpenCode's ACP protocol serializes prompts (one active
  // `session/prompt` at a time; `readyToEncode()` is false while one is
  // live), so the driver can only write a new prompt once the prompt slot
  // reopens at the previous turn boundary. shiki explicitly accepts that
  // once that release fires and the `session/prompt` write succeeds, the
  // payload is delivered — no waiting for the first `session/update` or
  // `turn_end`. That is exactly OpenCode's current settlement point, so
  // #2210 leaves its behavior unchanged; the prompt-boundary releaseProfile
  // remains the sole gate keeping the write inside a safe window.
  readonly admissionPolicy = 'write-success' as const;
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
