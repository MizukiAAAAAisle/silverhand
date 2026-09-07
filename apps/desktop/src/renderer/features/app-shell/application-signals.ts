import { deriveNavRailDots } from '@/components/layout/NavRail';
import { useBackendInfoSnapshot } from '@/features/hosts/hooks';
import { useTaskBoardRealtime } from '@/features/tasks/useBoard';
import {
  useAppShellGlobalSync,
  useShutdownProgress,
  useComposerDraftCleanup,
  useDockBadge,
  useSettingsMenuNav,
} from '@/features/app-shell/effects';
import { useNavSectionShortcuts } from '@/features/app-shell/keyboard-shortcuts';
import { useUnreadCounts } from '@/features/notifications/hooks';
import { useMessageUnreadSummary } from '@/features/channels/hooks';
import { useActivity, useAttentionBadges, useAttentionRealtime } from '@/features/attention/hooks';
import { useNav } from '@/router';

export function useApplicationSignals() {
  const nav = useNav();
  useAppShellGlobalSync();

  const shutdownStep = useShutdownProgress();

  useComposerDraftCleanup();

  useSettingsMenuNav(nav.toSettings);

  useNavSectionShortcuts(nav);

  const { data: unreadCounts } = useUnreadCounts();

  useMessageUnreadSummary();

  useAttentionRealtime();

  const { data: attentionBadges } = useAttentionBadges();

  useTaskBoardRealtime();

  const { data: activityData } = useActivity();

  const navRailDots = deriveNavRailDots({
    workspaceUnread: attentionBadges?.by_workspace,
    activityItemCount: activityData?.items.length,
  });

  useDockBadge(attentionBadges?.total);

  useBackendInfoSnapshot({ pollProtocolCompatibility: true });

  return { shutdownStep, unreadCounts, attentionBadges, navRailDots };
}
