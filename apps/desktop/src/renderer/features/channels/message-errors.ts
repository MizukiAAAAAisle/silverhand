// Channel agent-mutation error formatting (#task:1292), extracted verbatim from
// hooks.ts. Leaf module (only depends on the ApiError shape).
import { ApiError } from '@/lib/api';

function parseApiErrorBody(err: ApiError): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(err.body) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function formatStartAgentError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = parseApiErrorBody(err);
    const code = typeof body?.code === 'string' ? body.code : null;
    const detail =
      typeof body?.error === 'string'
        ? body.error
        : typeof body?.message === 'string'
          ? body.message
          : err.body || err.message;
    if (code === 'host_attach_pending') {
      return 'Agent 启动失败：daemon host 还未连接，稍后重试。';
    }
    if (code === 'workspace_path_missing') {
      return `Agent 启动失败：${detail}`;
    }
    if (code === 'workspace_not_provisioned') {
      return `Agent 启动失败：workspace 尚未 provision。${detail}`;
    }
    if (code === 'registry_unavailable') {
      return `Agent 启动失败：daemon workspace registry 不可用。${detail}`;
    }
    return `Agent 启动失败：${detail}`;
  }
  return `Agent 启动失败：${err instanceof Error ? err.message : String(err)}`;
}

export function formatRemoveAgentError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = parseApiErrorBody(err);
    const code = typeof body?.code === 'string' ? body.code : null;
    if (code === 'conversation_member_remove_unsupported') {
      return '只能从 channel 或 thread 移除成员(DM 不支持)。';
    }
    if (code === 'conversation_closed') {
      return '该会话已关闭,无法移除成员。';
    }
    if (err.status === 403) return '没有权限将该 agent 从此频道移除。';
    if (err.status === 404) return '该 agent 已不在此频道。';
    const detail =
      typeof body?.error === 'string'
        ? body.error
        : typeof body?.message === 'string'
          ? body.message
          : `HTTP ${err.status}`;
    return `移除失败：${detail}`;
  }
  return `移除失败：${err instanceof Error ? err.message : String(err)}`;
}
