//! The agent task-write DOOR's board resolution — the parity of the TS
//! `resolveAgentTaskBoard`, deciding which board a by-number write targets and
//! whether the acting agent may target it, BEFORE the write transaction.
//!
//! It composes the core [`TaskWriteDoorReads`] port in the fixed TS branch/refusal
//! order:
//!
//! 1. `workspace_id` AND `workspace_name` together → `unknown_workspace` (XOR).
//! 2. explicit `workspace_id` → the workspace must exist (membership read is
//!    3-valued: absent → `unknown_workspace`).
//! 3. explicit `workspace_name` → canonicalize (reusing the existing
//!    [`CanonicalWorkspaceName`]); a parse failure resolves to no match →
//!    `unknown_workspace`; the name lookup then gives 0 → `unknown_workspace`,
//!    `> 1` → `ambiguous_workspace` (deterministic candidate list), `1` → that
//!    workspace. AMBIGUITY IS DECIDED HERE, before any membership read.
//! 4. no selector → the source conversation's own board: a workspace placement
//!    uses its workspace; a direct-pair uses its own board (no capability axis); an
//!    agent-slot with no source, or a conversation with no board, is
//!    `unknown_workspace`.
//! 5. finally, for a workspace board, membership → else
//!    `workspace_membership_required`.
//!
//! Capability (`write_tasks`/`read_tasks`/`create_tasks`) is the CALLER's next
//! step (each face decides its token), not this resolver's — it returns the
//! resolved board and leaves the capability gate to the adapter, matching TS.

use silverhand_backend_core::conversation_messaging::messaging::task::{
    BoardKey, TaskWriteDoorReads, WorkspaceMembership,
};
use silverhand_backend_core::foundation::identity::{AgentId, ConversationId, WorkspaceId};
use silverhand_backend_core::foundation::persistence::PersistenceFailure;
use silverhand_backend_core::identity_access::workspace_name::CanonicalWorkspaceName;

/// The board a by-number task write resolved to.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ResolvedBoard {
    /// A workspace board — the caller still owns the capability gate (`write_tasks`
    /// / `read_tasks` / `create_tasks`) on `workspace`.
    Workspace {
        board_key: String,
        workspace: WorkspaceId,
    },
    /// A direct-pair board — participation is the whole authority (no capability
    /// axis); the write UoW re-checks participation under its own lock.
    DirectPair { board_key: String },
}

/// Why board resolution refused, mirroring the TS `resolveAgentTaskBoard` codes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum BoardResolveRefusal {
    /// Unknown/absent workspace, or a source frame with no nameable board.
    UnknownWorkspace { reason: String },
    /// A name matched more than one workspace; `candidates` is the deterministic
    /// TS order (regular workspaces first, then `created_at ASC`).
    AmbiguousWorkspace {
        reason: String,
        candidates: Vec<WorkspaceId>,
    },
    /// The workspace exists but the agent is not a member.
    WorkspaceMembershipRequired { reason: String },
}

impl BoardResolveRefusal {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::UnknownWorkspace { .. } => "unknown_workspace",
            Self::AmbiguousWorkspace { .. } => "ambiguous_workspace",
            Self::WorkspaceMembershipRequired { .. } => "workspace_membership_required",
        }
    }

    pub(crate) fn reason(&self) -> &str {
        match self {
            Self::UnknownWorkspace { reason }
            | Self::AmbiguousWorkspace { reason, .. }
            | Self::WorkspaceMembershipRequired { reason } => reason,
        }
    }

    pub(crate) fn candidates(&self) -> Option<&[WorkspaceId]> {
        match self {
            Self::AmbiguousWorkspace { candidates, .. } => Some(candidates),
            _ => None,
        }
    }
}

/// A workspace selector as it arrives on the wire (already XOR-validated by the
/// DTO, but the resolver re-guards the both-set case defensively).
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct WorkspaceSelector {
    pub(crate) workspace_id: Option<String>,
    pub(crate) workspace_name: Option<String>,
}

/// Resolve the by-number write board for `agent`, given the `selector` and the
/// agent's `source` conversation (`None` for an agent-slot). The fixed
/// branch/refusal order is the TS one, and ambiguity is decided before any
/// membership read.
pub(crate) async fn resolve_write_board<R: TaskWriteDoorReads>(
    reads: &mut R,
    agent: &AgentId,
    source: Option<&ConversationId>,
    selector: &WorkspaceSelector,
) -> Result<Result<ResolvedBoard, BoardResolveRefusal>, PersistenceFailure> {
    resolve_write_board_with_source_board(reads, agent, source, None, selector).await
}

/// Variant for routes that have already resolved the runtime frame before the
/// actor-existence gate. Passing that snapshot avoids a second conversation read
/// and preserves the TS order `source conversation → actor → frame authority`.
pub(crate) async fn resolve_write_board_with_source_board<R: TaskWriteDoorReads>(
    reads: &mut R,
    agent: &AgentId,
    source: Option<&ConversationId>,
    source_board: Option<&BoardKey>,
    selector: &WorkspaceSelector,
) -> Result<Result<ResolvedBoard, BoardResolveRefusal>, PersistenceFailure> {
    // (1) XOR: both set is unknown_workspace (defensive; the DTO also enforces it).
    if selector.workspace_id.is_some() && selector.workspace_name.is_some() {
        return Ok(Err(BoardResolveRefusal::UnknownWorkspace {
            reason: "workspace_id and workspace_name are mutually exclusive".to_owned(),
        }));
    }

    // (2)/(3)/(4): settle which workspace (or direct-pair board) this targets.
    let workspace: WorkspaceId = if let Some(raw_id) = &selector.workspace_id {
        let Ok(id) = WorkspaceId::parse(raw_id.clone()) else {
            // A malformed id names no workspace — same envelope as absent.
            return Ok(Err(BoardResolveRefusal::UnknownWorkspace {
                reason: format!("workspace {raw_id} not found"),
            }));
        };
        id
    } else if let Some(raw_name) = &selector.workspace_name {
        // Canonicalize with the existing workspace-name authority; a parse failure
        // (too long / forbidden / empty) matches nothing → unknown_workspace,
        // exactly as TS `findAllByName` returns [] for an unparseable name.
        let Ok(canonical) = CanonicalWorkspaceName::parse(raw_name) else {
            return Ok(Err(BoardResolveRefusal::UnknownWorkspace {
                reason: format!("no workspace named \"{raw_name}\""),
            }));
        };
        let mut candidates = reads.workspaces_named(&canonical).await?;
        match candidates.len() {
            0 => {
                return Ok(Err(BoardResolveRefusal::UnknownWorkspace {
                    reason: format!("no workspace named \"{raw_name}\""),
                }));
            }
            // AMBIGUITY BEFORE MEMBERSHIP: return the deterministic candidate list
            // without consulting membership, so the count cannot be rewritten.
            n if n > 1 => {
                return Ok(Err(BoardResolveRefusal::AmbiguousWorkspace {
                    reason: format!(
                        "{n} workspaces named \"{raw_name}\"; disambiguate with --workspace-id"
                    ),
                    candidates,
                }));
            }
            _ => candidates.remove(0),
        }
    } else {
        // (4) No selector: the board is the source conversation's own.
        let Some(source) = source else {
            // Agent-slot with no conversation frame: must name a workspace.
            return Ok(Err(BoardResolveRefusal::UnknownWorkspace {
                reason: "agent-scoped task-number operations must name a workspace".to_owned(),
            }));
        };
        let board = match source_board {
            Some(board) => board.clone(),
            None => {
                let Some(board) = reads.conversation_board(source).await? else {
                    return Ok(Err(BoardResolveRefusal::UnknownWorkspace {
                        reason: "current conversation belongs to no workspace, so it has no task board; pass --workspace-id to name one".to_owned(),
                    }));
                };
                board
            }
        };
        match board {
            BoardKey::Workspace(workspace) => workspace,
            BoardKey::Pair(pair) => {
                // A direct-pair frame reads its OWN pair board; no capability axis,
                // participation is the write UoW's gate.
                return Ok(Ok(ResolvedBoard::DirectPair {
                    board_key: format!("pair:{}", pair.as_str()),
                }));
            }
        }
    };

    // (5) Membership on the resolved workspace board (last).
    match reads.workspace_membership(&workspace, agent).await? {
        WorkspaceMembership::Absent => Ok(Err(BoardResolveRefusal::UnknownWorkspace {
            reason: if selector.workspace_id.is_some() || selector.workspace_name.is_some() {
                format!("workspace {} not found", workspace.as_str())
            } else {
                "current conversation workspace not found".to_owned()
            },
        })),
        WorkspaceMembership::NotMember => {
            Ok(Err(BoardResolveRefusal::WorkspaceMembershipRequired {
                reason: format!("agent is not a member of workspace {}", workspace.as_str()),
            }))
        }
        WorkspaceMembership::Member => Ok(Ok(ResolvedBoard::Workspace {
            board_key: format!("ws:{}", workspace.as_str()),
            workspace,
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use silverhand_backend_core::conversation_messaging::messaging::task::TaskWriteCapability;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A recording `TaskWriteDoorReads` fake: it answers each read from a fixed
    /// script AND counts the calls, so a test proves the selector BRANCH actually
    /// consulted (or did NOT consult) a given read — not merely that the read works.
    #[derive(Default)]
    struct Reads {
        named: Vec<WorkspaceId>,
        board: Option<BoardKey>,
        membership: WorkspaceMembershipScript,
        named_calls: AtomicUsize,
        board_calls: AtomicUsize,
        membership_calls: AtomicUsize,
    }

    #[derive(Clone, Copy, Default)]
    enum WorkspaceMembershipScript {
        #[default]
        Member,
        NotMember,
        Absent,
    }

    impl TaskWriteDoorReads for Reads {
        async fn may_mutate_task_by_id(
            &mut self,
            _task: &silverhand_backend_core::conversation_messaging::messaging::task::TaskId,
            _agent: &AgentId,
            _required: silverhand_backend_core::conversation_messaging::messaging::task::TaskByIdCapability,
        ) -> Result<bool, PersistenceFailure> {
            Ok(true)
        }

        async fn workspaces_named(
            &mut self,
            _canonical: &CanonicalWorkspaceName,
        ) -> Result<Vec<WorkspaceId>, PersistenceFailure> {
            self.named_calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.named.clone())
        }
        async fn conversation_board(
            &mut self,
            _conversation: &ConversationId,
        ) -> Result<Option<BoardKey>, PersistenceFailure> {
            self.board_calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.board.clone())
        }
        async fn workspace_membership(
            &mut self,
            _workspace: &WorkspaceId,
            _agent: &AgentId,
        ) -> Result<WorkspaceMembership, PersistenceFailure> {
            self.membership_calls.fetch_add(1, Ordering::SeqCst);
            Ok(match self.membership {
                WorkspaceMembershipScript::Member => WorkspaceMembership::Member,
                WorkspaceMembershipScript::NotMember => WorkspaceMembership::NotMember,
                WorkspaceMembershipScript::Absent => WorkspaceMembership::Absent,
            })
        }
        async fn has_capability(
            &mut self,
            _capability: TaskWriteCapability,
            _workspace: &WorkspaceId,
            _agent: &AgentId,
        ) -> Result<bool, PersistenceFailure> {
            Ok(true)
        }
    }

    fn agent() -> AgentId {
        AgentId::parse("agent-1").unwrap()
    }
    fn ws(id: &str) -> WorkspaceId {
        WorkspaceId::parse(id).unwrap()
    }

    fn sel(id: Option<&str>, name: Option<&str>) -> WorkspaceSelector {
        WorkspaceSelector {
            workspace_id: id.map(str::to_owned),
            workspace_name: name.map(str::to_owned),
        }
    }

    #[tokio::test]
    async fn both_selectors_set_is_unknown_workspace_without_any_read() {
        let mut reads = Reads::default();
        let out = resolve_write_board(&mut reads, &agent(), None, &sel(Some("w"), Some("n")))
            .await
            .unwrap();
        assert_eq!(
            out.unwrap_err().reason(),
            "workspace_id and workspace_name are mutually exclusive"
        );
        assert_eq!(reads.named_calls.load(Ordering::SeqCst), 0);
        assert_eq!(reads.membership_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn explicit_id_member_resolves_the_workspace_board() {
        let mut reads = Reads {
            membership: WorkspaceMembershipScript::Member,
            ..Default::default()
        };
        let out = resolve_write_board(&mut reads, &agent(), None, &sel(Some("ws-1"), None))
            .await
            .unwrap();
        assert_eq!(
            out,
            Ok(ResolvedBoard::Workspace {
                board_key: "ws:ws-1".to_owned(),
                workspace: ws("ws-1"),
            })
        );
        // Membership WAS consulted (the id branch reaches it); the name lookup was not.
        assert_eq!(reads.membership_calls.load(Ordering::SeqCst), 1);
        assert_eq!(reads.named_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn explicit_id_absent_is_unknown_workspace() {
        let mut reads = Reads {
            membership: WorkspaceMembershipScript::Absent,
            ..Default::default()
        };
        let out = resolve_write_board(&mut reads, &agent(), None, &sel(Some("ws-x"), None))
            .await
            .unwrap();
        assert_eq!(out.unwrap_err().reason(), "workspace ws-x not found");
    }

    #[tokio::test]
    async fn explicit_id_present_but_not_member_is_membership_required() {
        let mut reads = Reads {
            membership: WorkspaceMembershipScript::NotMember,
            ..Default::default()
        };
        let out = resolve_write_board(&mut reads, &agent(), None, &sel(Some("ws-1"), None))
            .await
            .unwrap();
        assert_eq!(
            out.unwrap_err().reason(),
            "agent is not a member of workspace ws-1"
        );
    }

    #[tokio::test]
    async fn name_matching_none_is_unknown_workspace() {
        let mut reads = Reads {
            named: vec![],
            ..Default::default()
        };
        let out = resolve_write_board(&mut reads, &agent(), None, &sel(None, Some("nope")))
            .await
            .unwrap();
        assert_eq!(out.unwrap_err().reason(), "no workspace named \"nope\"");
        assert_eq!(reads.named_calls.load(Ordering::SeqCst), 1);
        assert_eq!(reads.membership_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn name_matching_many_is_ambiguous_before_membership_with_deterministic_candidates() {
        let mut reads = Reads {
            named: vec![ws("ws-a"), ws("ws-b")],
            // Even a member verdict must not be reached; the ambiguity is decided first.
            membership: WorkspaceMembershipScript::Member,
            ..Default::default()
        };
        let out = resolve_write_board(&mut reads, &agent(), None, &sel(None, Some("dupe")))
            .await
            .unwrap();
        assert_eq!(
            out,
            Err(BoardResolveRefusal::AmbiguousWorkspace {
                reason: "2 workspaces named \"dupe\"; disambiguate with --workspace-id".to_owned(),
                candidates: vec![ws("ws-a"), ws("ws-b")],
            })
        );
        assert_eq!(reads.named_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            reads.membership_calls.load(Ordering::SeqCst),
            0,
            "ambiguity is decided BEFORE any membership read"
        );
    }

    #[tokio::test]
    async fn name_matching_one_member_resolves_it() {
        let mut reads = Reads {
            named: vec![ws("ws-only")],
            membership: WorkspaceMembershipScript::Member,
            ..Default::default()
        };
        let out = resolve_write_board(&mut reads, &agent(), None, &sel(None, Some("uniq")))
            .await
            .unwrap();
        assert_eq!(
            out,
            Ok(ResolvedBoard::Workspace {
                board_key: "ws:ws-only".to_owned(),
                workspace: ws("ws-only"),
            })
        );
        assert_eq!(reads.membership_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn no_selector_agent_slot_must_name_a_workspace() {
        let mut reads = Reads::default();
        // Agent-slot: source is None.
        let out = resolve_write_board(&mut reads, &agent(), None, &sel(None, None))
            .await
            .unwrap();
        assert_eq!(
            out.unwrap_err().reason(),
            "agent-scoped task-number operations must name a workspace"
        );
        assert_eq!(reads.board_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn no_selector_workspace_frame_uses_its_workspace() {
        let mut reads = Reads {
            board: Some(BoardKey::Workspace(ws("ws-src"))),
            membership: WorkspaceMembershipScript::Member,
            ..Default::default()
        };
        let source = ConversationId::parse("conv-src").unwrap();
        let out = resolve_write_board(&mut reads, &agent(), Some(&source), &sel(None, None))
            .await
            .unwrap();
        assert_eq!(
            out,
            Ok(ResolvedBoard::Workspace {
                board_key: "ws:ws-src".to_owned(),
                workspace: ws("ws-src"),
            })
        );
        assert_eq!(reads.board_calls.load(Ordering::SeqCst), 1);
        assert_eq!(reads.membership_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn no_selector_frame_without_a_board_preserves_the_contextual_reason() {
        let mut reads = Reads::default();
        let source = ConversationId::parse("conv-src").unwrap();
        let out = resolve_write_board(&mut reads, &agent(), Some(&source), &sel(None, None))
            .await
            .unwrap();
        assert_eq!(
            out.unwrap_err().reason(),
            "current conversation belongs to no workspace, so it has no task board; pass --workspace-id to name one"
        );
        assert_eq!(reads.board_calls.load(Ordering::SeqCst), 1);
        assert_eq!(reads.membership_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn no_selector_missing_source_workspace_preserves_the_contextual_reason() {
        let mut reads = Reads {
            board: Some(BoardKey::Workspace(ws("ws-gone"))),
            membership: WorkspaceMembershipScript::Absent,
            ..Default::default()
        };
        let source = ConversationId::parse("conv-src").unwrap();
        let out = resolve_write_board(&mut reads, &agent(), Some(&source), &sel(None, None))
            .await
            .unwrap();
        assert_eq!(
            out.unwrap_err().reason(),
            "current conversation workspace not found"
        );
        assert_eq!(reads.board_calls.load(Ordering::SeqCst), 1);
        assert_eq!(reads.membership_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn no_selector_direct_pair_frame_uses_its_pair_board_no_membership() {
        use silverhand_backend_core::conversation_messaging::messaging::task::PairKey;
        let mut reads = Reads {
            board: Some(BoardKey::Pair(PairKey::parse("a3:x").unwrap())),
            ..Default::default()
        };
        let source = ConversationId::parse("pair-src").unwrap();
        let out = resolve_write_board(&mut reads, &agent(), Some(&source), &sel(None, None))
            .await
            .unwrap();
        assert_eq!(
            out,
            Ok(ResolvedBoard::DirectPair {
                board_key: "pair:a3:x".to_owned(),
            })
        );
        // A direct-pair board has no capability/membership axis.
        assert_eq!(reads.membership_calls.load(Ordering::SeqCst), 0);
    }
}
