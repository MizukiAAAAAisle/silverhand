# Global memory

_Cross-channel knowledge anchor._

## Channel: silverhand / Onboarding

- Current role for @Cindy: review and discuss @Alice's architecture plans and technical proposals, focusing on potential problems, risks, missing constraints, and validation gaps.
- Current role for @Alice: architecture planning and technical方案制定.

## Active context

- 2026-05-03 task #1: user asked @Alice and @Cindy to discuss a technical plan for UI/events/notifications/channel/session/chat fixes in `/Users/shiki/workspace/silverhand`.
- @Cindy reviewed @Alice's proposed batches and flagged these constraints: message send latency is currently caused by backend `POST /api/sessions/:id/messages` awaiting agent auto-start before publishing/returning; new-channel activation should seed the channels cache instead of relying only on invalidate; existing SSE is per-session, so inactive-channel notifications need a global notification stream/model; pre-spawn agent start failures must be marked crashed and published centrally in `SessionManager.start`; Events window initial active-session IPC can race unless query params or load-ready handoff are used.
- Final agreed plan: first fix backend message ordering, new-channel cache/navigation, and composer auto-height; then extract reusable `AgentPicker`; then extend `notifications` kinds and use existing unread polling with notification-id dedupe for in-app/system notifications, including `agent_start_failed` written by `SessionManager`; finally bridge active session into the Events window with URL initial state plus IPC updates.
- @Cindy implemented frontend-owned tasks #6/#3/#5 and moved them to review: `useCreateChannel` seeds channels cache and CreateChannelDialog navigates to onboarding session; Composer textarea auto-resizes from `draft`; `AgentPicker` is shared by create-channel/session dialogs; Events window receives active session via query + IPC. Verified with `pnpm --filter @silverhand/desktop typecheck`.
- 2026-05-04: @Alice completed Batch 1 backend and Batch 3 notifications; @Cindy reviewed fixes for notification channel/read semantics, crash/init-timeout persistence, and system-notification focus handling. All implementation batches were moved through review and @Alice reported the round closed. Follow-up idea only: split `agent_crashed` into its own notification kind later when notification-list classification/filtering exists.
