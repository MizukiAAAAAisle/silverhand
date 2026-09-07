import type { RouteState } from '@/router';

type TaskDetailRoute = Pick<RouteState, 'section' | 'chatView' | 'channelId' | 'taskDetailId'>;

export function resolveTaskDetailSurface(route: TaskDetailRoute): 'dialog' | 'pane' | null {
  if (route.taskDetailId === null) {
    return null;
  }

  if (route.section === 'tasks') {
    return 'dialog';
  }

  if (
    (route.section === 'chat' || route.section === 'activity') &&
    route.chatView === 'channel' &&
    route.channelId !== null
  ) {
    return 'pane';
  }

  return null;
}
