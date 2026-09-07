import { useCallback, useRef } from 'react';
import { useNav, useRouteState } from '@/router';
import {
  useMessageJumpController,
  type MessageJumpTarget,
} from '@/features/channels/useMessageJumpController';
import type { DirectPairAuthority } from '@/lib/chat-place-restore';
import { executeMessageJump, type MessageJumpEnvironment } from './message-jump';

export function useConversationJump(
  pairs: DirectPairAuthority,
  resolveWorkspace: MessageJumpEnvironment['resolveWorkspace'],
) {
  const { section } = useRouteState();
  const nav = useNav();
  const jump = useMessageJumpController();
  const environment = useRef<MessageJumpEnvironment>({
    section,
    pairs,
    resolveWorkspace,
    prime: jump.requestJump,
    navigate: nav.go,
  });
  environment.current = {
    section,
    pairs,
    resolveWorkspace,
    prime: jump.requestJump,
    navigate: nav.go,
  };

  const handleJumpToMessage = useCallback(
    (target: MessageJumpTarget) => executeMessageJump(target, environment.current),
    [],
  );

  return {
    ...jump,
    handleJumpToMessage,
    handleJumpToMessageStable: handleJumpToMessage,
    handleJumped: jump.clearJump,
  };
}
