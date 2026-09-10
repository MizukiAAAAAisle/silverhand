import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { toAcpMcpServers } from '@silverhand/shared';
import { AcpClient, type AcpRuntimeAdapter } from './acp.js';
import type { Driver, DriverIO, DriverSpawnContext } from './index.js';

function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

class GrokAcpAdapter implements AcpRuntimeAdapter {
  readonly runtimeLabel = 'Grok';
  readonly permissionPolicy = { shouldAllow: () => true };
  readonly suppressPreSessionUpdates = true;

  buildInitializeParams(): Record<string, unknown> {
    return {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'silverhand', version: '1.0.0' },
    };
  }

  sessionMethod(ctx: DriverSpawnContext, result: unknown): string {
    const initialized = record(result);
    if (initialized.protocolVersion !== 1)
      throw new Error('Grok ACP protocol version is unsupported.');
    const capabilities = record(initialized.agentCapabilities);
    const transports = record(capabilities.mcpCapabilities);
    for (const server of Object.values(ctx.profileMcp?.mcpServers ?? {})) {
      if ('url' in server && transports[server.type] !== true) {
        throw new Error(`Grok does not advertise MCP ${server.type} support.`);
      }
    }
    if (!ctx.cliSessionId) return 'session/new';
    if (record(capabilities.sessionCapabilities).resume) return 'session/resume';
    if (capabilities.loadSession === true) return 'session/load';
    throw new Error('Grok does not support restoring this session.');
  }

  buildSessionParams(ctx: DriverSpawnContext): Record<string, unknown> {
    const mcpServers = toAcpMcpServers(ctx.profileMcp ?? { mcpServers: {} }, 'profile');

    return {
      cwd: ctx.workspacePath,
      mcpServers,
      ...(ctx.cliSessionId ? { sessionId: ctx.cliSessionId } : {}),
      // Reapply the current Silverhand identity on both new and resumed sessions.
      _meta: { systemPromptOverride: readFileSync(ctx.systemPromptPath, 'utf8') },
    };
  }

  validateSession(ctx: DriverSpawnContext, value: unknown): string | null {
    const result = record(value);
    const models = record(result.models);
    const options = Array.isArray(result.configOptions) ? result.configOptions : [];
    const model = options.find((option: any) => option.id === 'model');
    if (ctx.model && (model?.currentValue ?? models.currentModelId) !== ctx.model) {
      return 'Grok did not select the requested model.';
    }
    if (ctx.reasoningEffort) {
      const effort = options.find((option: any) => option.id === 'reasoning_effort');
      if (effort?.currentValue !== ctx.reasoningEffort) {
        return 'Grok did not apply the requested reasoning effort for this model.';
      }
    }
    return null;
  }

  buildSessionConfigRequests(ctx: DriverSpawnContext, sessionId: string) {
    return [
      ...(ctx.model ? [{ sessionId, configId: 'model', value: ctx.model }] : []),
      ...(ctx.reasoningEffort
        ? [{ sessionId, configId: 'reasoning_effort', value: ctx.reasoningEffort }]
        : []),
    ];
  }

  buildBusyRequest(sessionId: string, text: string) {
    return { method: '_x.ai/interject', params: { sessionId, text, interjectionId: randomUUID() } };
  }
}

/** Grok Build owns its login/config; ACP errors use the ordinary activity path. */
export class GrokDriver implements Driver {
  readonly kind = 'grok' as const;
  readonly binary = 'grok';
  readonly kickoffMode = 'self_inits' as const;
  readonly releaseProfile = 'native-steer' as const;
  readonly admissionPolicy = 'write-success' as const;
  readonly oneShot = false;
  readonly supportsNativeStandingPrompt = true;
  readonly initLivenessSilenceMs = 30_000;
  readonly initPreProtocolCapMs = 300_000;
  readonly initPostProtocolMs = 60_000;
  private readonly acp = new AcpClient(new GrokAcpAdapter());

  bindRuntimeVersion(version: string | null): void {
    const match = version?.match(/^(\d+)\.(\d+)\.(\d+)(?:\b|$)/);
    if (
      !match ||
      Number(match[1]) < 1 ||
      (Number(match[1]) === 1 && Number(match[2]) === 0 && Number(match[3]) < 24)
    ) {
      throw new Error('Grok Build 1.0.24 or newer is required.');
    }
  }

  buildArgs(ctx: DriverSpawnContext): string[] {
    return ['agent', '--no-leader', 'stdio'];
  }

  applyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...env, NO_COLOR: '1' };
  }
  bindIO(io: DriverIO): void {
    this.acp.bindIO(io);
  }
  readyToEncode(): boolean {
    return this.acp.readyToEncode();
  }
  encodeStdinMessage(content: string): string | null {
    return this.acp.encodeStdinMessage(content);
  }
  encodeInterruptControl(): string | null {
    return this.acp.encodeInterruptControl();
  }
  parseLine(line: string) {
    return this.acp.parseLine(line);
  }
  classifyInitProgress(line: string) {
    return this.acp.classifyInitProgress(line);
  }
}
