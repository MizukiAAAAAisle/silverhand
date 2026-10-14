import { useEffect } from 'react';
import { toast } from 'sonner';
import { getPlatform } from '@/platform';
import { onWsFrame, subscribeViewerScope, isCurrentViewerScope } from '@/lib/ws-client';
import { startHookFeed } from './feed';

export function useEventHooks() {
  const hooks = getPlatform().eventHooks;
  useEffect(() => {
    if (!hooks) return;
    const stop = startHookFeed(hooks, {
      subscribe: onWsFrame,
      isViewer: isCurrentViewerScope,
      warning: (message) => toast.error(message, { id: 'desktop-hooks-delivery' }),
    });
    const subscription = subscribeViewerScope();
    return () => {
      stop();
      subscription.unsubscribe();
    };
  }, [hooks]);
}
