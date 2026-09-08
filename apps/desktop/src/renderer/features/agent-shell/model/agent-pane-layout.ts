/**
 * The ONE content inset for every agent-page section pane — equal 12px on all
 * sides, the Workspace browser's inset (#task:2116, shiki: 统一成 workspace nav
 * 的 padding). Chats / Profile / MCP / Schedules previously carried a looser
 * `px-8 py-6`; they now read this single value so the agent page's section
 * insets can never drift apart pane-by-pane.
 *
 * Deliberately NOT applied to Activity: it is a full-bleed master-detail
 * surface (conversation rail + timeline) that owns its own scroll regions, so
 * an outer inset would eat its rail width. Lives in its own module rather than
 * `AgentView` to avoid an import cycle (AgentView → AgentChatsPane → back).
 */
export const AGENT_PANE_INSET = "p-3";
