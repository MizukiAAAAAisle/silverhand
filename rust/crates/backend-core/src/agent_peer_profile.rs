//! The peer-profile target-resolution tail (`GET
//! /internal/agents/{aid}/peer-profile`).
//!
//! The route reads ANOTHER agent's narrow profile by a caller-supplied handle.
//! Its caller-side gates — the conversation floor, the workspace horizon, the
//! `read_messages` capability — are resolved in the SERVER handler BEFORE this
//! runs, and deliberately so: nothing about the target, not even whether the
//! handle exists, may be observable by a caller who fails them (anti-enumeration,
//! #957). By the time [`resolve_peer_target`] is called the caller has already
//! earned the right to ask "who is this handle in this workspace"; this function
//! is only the target tail.
//!
//! ## The tail's own order is load-bearing too
//!
//! read-by-handle → BIND the returned name to the requested handle → require the
//! target be a member of the workspace. The binding is FIRST: a reader that
//! hands back the wrong row is a safe `500` that short-circuits before the
//! membership edge is even consulted, so a broken read can never be laundered
//! into a membership answer about some other agent. Past the binding, an unknown
//! handle and a handle that resolves to a non-member collapse into ONE
//! [`PeerTargetOutcome::NotFound`] — the single, indistinguishable `404` the
//! route serves, so a caller cannot enumerate who exists across workspaces.

use std::future::Future;

use crate::{
    agent_profile_read::{
        AgentProfileFact, AgentProfileReadModel, ProfileReadFault, bind_to_handle,
    },
    identity::{AgentId, ConversationId, WorkspaceId},
    persistence::PersistenceFailure,
};

/// Whether an agent is a member of a workspace — the authoritative
/// `workspace_members` edge the peer read gates its target on.
///
/// This is the NARROW requirement the peer tail consumes: a single boolean edge,
/// not a membership directory or a governance read. Its production adapter is the
/// canonical `workspace_members` query (`SELECT 1 FROM workspace_members WHERE
/// workspace_id = ? AND agent_id = ?`), the same edge the TS `workspaces.isMember`
/// resolves — this port must be answerable by that authority directly, with no
/// second membership model minted here.
pub trait PeerTargetMembership {
    fn agent_is_member(
        &self,
        workspace: &WorkspaceId,
        agent: &AgentId,
    ) -> impl Future<Output = Result<bool, PersistenceFailure>> + Send;
}

/// The target tail's outcome. `NotFound` is the collapsed `404`: it does not say
/// whether the collapse was an unknown handle or a known-but-non-member agent,
/// because distinguishing them would answer a cross-workspace existence question.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PeerTargetOutcome {
    Found(AgentProfileFact),
    NotFound,
}

/// Resolve a peer target after the caller-side gates have passed: read by handle,
/// bind the returned name to `handle`, then require the target be a member of
/// `workspace`.
///
/// Order: the source-binding runs BEFORE membership, so a dishonest reader is a
/// safe `500` ([`ProfileReadFault::Source`]) and the membership edge is never
/// consulted for a row that is not the requested handle. Unknown handle → the
/// membership edge is not consulted (there is nothing to check) and the outcome
/// is `NotFound`; a bound non-member → `NotFound` as well. The two collapse into
/// the one indistinguishable answer.
pub async fn resolve_peer_target<R, M>(
    reader: &R,
    membership: &M,
    handle: &str,
    workspace: &WorkspaceId,
) -> Result<PeerTargetOutcome, ProfileReadFault>
where
    R: AgentProfileReadModel + ?Sized,
    M: PeerTargetMembership + ?Sized,
{
    let Some(fact) = reader.read_agent_profile_by_handle(handle).await? else {
        return Ok(PeerTargetOutcome::NotFound);
    };
    // Bind FIRST — a wrong row is a fault, not a membership question.
    let fact = bind_to_handle(handle, fact)?;
    if membership.agent_is_member(workspace, &fact.id).await? {
        Ok(PeerTargetOutcome::Found(fact))
    } else {
        Ok(PeerTargetOutcome::NotFound)
    }
}

// ---------------------------------------------------------------------------
// Caller-side admission gates.
//
// Everything below runs BEFORE the target tail. Their whole purpose is
// anti-enumeration: until the caller has proven it may ask "who is this handle
// in this workspace", NOTHING about the target — not the reader, not the
// membership edge — is consulted. The gate ORDER is the contract, so it lives
// here in the domain, tested with fakes, not scattered across the wire handler.
// ---------------------------------------------------------------------------

/// A caller-bound conversation's workspace placement. `WorkspaceLess` is a
/// direct-pair placement, which derives no source workspace, so a peer lookup
/// from it must be given an explicit `workspace_id`.
///
/// The lookup port returns `Option<WorkspacePlacement>`: `None` is a MISSING
/// conversation (the route's `404`); `Some(_)` is a present row whose placement
/// is one of these two legal shapes. A present row whose placement is illegal or
/// whose coordinate is absent is NOT representable here — the adapter surfaces it
/// as a [`PersistenceFailure`] (safe `500`), never collapsing corruption into
/// `WorkspaceLess`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkspacePlacement {
    Workspace(WorkspaceId),
    WorkspaceLess,
}

/// Resolve the placement of the caller's bound conversation. Consulted ONLY when
/// the caller is bound to a conversation (a `ConversationSlot` principal); an
/// `AgentSlot` caller has no conversation and this is never called for it.
pub trait CallerConversationPlacement {
    fn conversation_placement(
        &self,
        conversation: &ConversationId,
    ) -> impl Future<Output = Result<Option<WorkspacePlacement>, PersistenceFailure>> + Send;
}

/// Whether an agent can REACH a workspace — the caller's read horizon, `regular
/// workspace_members membership ∪ owned agent_home`. This is a DIFFERENT axis
/// from [`PeerTargetMembership`]: the horizon is the caller's own reach (and
/// admits its owned home), whereas the target membership is the target's regular
/// `workspace_members` edge (and excludes an owned home). Consulted only when the
/// target workspace differs from the caller's source workspace.
pub trait CallerWorkspaceHorizon {
    fn can_access_workspace(
        &self,
        agent: &AgentId,
        workspace: &WorkspaceId,
    ) -> impl Future<Output = Result<bool, PersistenceFailure>> + Send;
}

/// Whether an agent holds the `read_messages` capability in a workspace — the
/// caller-side capability the peer read requires, ALWAYS. A dedicated predicate
/// keyed on the `read_messages` token: it is not the `read_tasks`/`send_messages`
/// capability under another name, and the token is not a caller-supplied
/// parameter.
pub trait CallerReadMessagesCapability {
    fn may_read_messages(
        &self,
        agent: &AgentId,
        workspace: &WorkspaceId,
    ) -> impl Future<Output = Result<bool, PersistenceFailure>> + Send;
}

/// The whole route's outcome. Each arm is a distinct product status; the two
/// `404`s are deliberately distinct FACTS — a missing bound conversation
/// (`ConversationMissing`) is about the caller's own frame, whereas `NotFound` is
/// the collapsed target answer (unknown handle ∪ non-member) that reveals nothing
/// about who exists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PeerProfileOutcome {
    /// The target profile — `200`.
    Profile(AgentProfileFact),
    /// The caller's bound conversation does not exist — `404` `conversation not found`.
    ConversationMissing,
    /// A workspace-less caller named no workspace — `400` `workspace_scope_required`.
    WorkspaceScopeRequired,
    /// The caller cannot reach the target workspace — `403` `forbidden`. This is the
    /// horizon refusal, which MERGES "no such workspace" with "outside your reach" so
    /// a caller cannot probe workspace existence.
    HorizonForbidden,
    /// The caller can reach the workspace but lacks the `read_messages` capability —
    /// a `403` carrying the distinct `capability_denied` body. It is deliberately a
    /// DIFFERENT response than [`HorizonForbidden`]: a caller who reaches this gate
    /// has already earned the right to know the workspace is within its horizon.
    CapabilityDenied,
    /// The collapsed target `404` (unknown handle or non-member).
    NotFound,
}

/// Admit a peer-profile read, running the caller-side gate ladder and then the
/// target tail. The order is load-bearing and every early return happens BEFORE
/// [`resolve_peer_target`], so the reader and the membership edge are consulted
/// only once ALL caller-side gates have passed:
///
/// 1. **Conversation floor** (principal-branched): a `ConversationSlot` caller
///    (`source = Some`) reads its placement — a missing row is `ConversationMissing`;
///    an `AgentSlot` caller (`source = None`) runs no lookup and simply has no
///    source workspace.
/// 2. **Workspace scope**: the explicit `workspace_id` wins, else the source
///    workspace; a caller with neither gets `WorkspaceScopeRequired`.
/// 3. **Horizon**: consulted only when the target workspace differs from the
///    source workspace; a caller outside its reach is `HorizonForbidden`.
/// 4. **`read_messages` capability**: always consulted; absence is `CapabilityDenied`.
/// 5. **Target tail**: only now are the reader and membership edge consulted.
#[allow(clippy::too_many_arguments)]
pub async fn admit_peer_profile<P, H, C, R, M>(
    placement: &P,
    horizon: &H,
    capability: &C,
    reader: &R,
    membership: &M,
    caller: &AgentId,
    source: Option<&ConversationId>,
    requested_workspace: Option<&WorkspaceId>,
    handle: &str,
) -> Result<PeerProfileOutcome, ProfileReadFault>
where
    P: CallerConversationPlacement + ?Sized,
    H: CallerWorkspaceHorizon + ?Sized,
    C: CallerReadMessagesCapability + ?Sized,
    R: AgentProfileReadModel + ?Sized,
    M: PeerTargetMembership + ?Sized,
{
    // 1. Conversation floor — branched on the caller's binding, never faked.
    let source_workspace: Option<WorkspaceId> = match source {
        Some(conversation) => match placement.conversation_placement(conversation).await? {
            None => return Ok(PeerProfileOutcome::ConversationMissing),
            Some(WorkspacePlacement::Workspace(workspace)) => Some(workspace),
            Some(WorkspacePlacement::WorkspaceLess) => None,
        },
        None => None,
    };

    // 2. Workspace scope — explicit wins, else the source, else refuse.
    let target_workspace = match requested_workspace {
        Some(workspace) => workspace.clone(),
        None => match &source_workspace {
            Some(workspace) => workspace.clone(),
            None => return Ok(PeerProfileOutcome::WorkspaceScopeRequired),
        },
    };

    // 3. Horizon — only when the target is a DIFFERENT workspace than the source.
    if source_workspace.as_ref() != Some(&target_workspace)
        && !horizon
            .can_access_workspace(caller, &target_workspace)
            .await?
    {
        return Ok(PeerProfileOutcome::HorizonForbidden);
    }

    // 4. read_messages — always.
    if !capability
        .may_read_messages(caller, &target_workspace)
        .await?
    {
        return Ok(PeerProfileOutcome::CapabilityDenied);
    }

    // 5. Target tail — reader + membership, reached only past every gate.
    Ok(
        match resolve_peer_target(reader, membership, handle, &target_workspace).await? {
            PeerTargetOutcome::Found(fact) => PeerProfileOutcome::Profile(fact),
            PeerTargetOutcome::NotFound => PeerProfileOutcome::NotFound,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messaging::AvatarRevision;
    use std::{
        collections::{HashMap, HashSet},
        sync::atomic::{AtomicBool, Ordering},
    };

    struct FakeProfiles {
        rows: HashMap<String, AgentProfileFact>,
    }

    impl AgentProfileReadModel for FakeProfiles {
        async fn read_agent_profile(
            &self,
            agent: &AgentId,
        ) -> Result<Option<AgentProfileFact>, PersistenceFailure> {
            Ok(self.rows.get(agent.as_str()).cloned())
        }

        async fn read_agent_profile_by_handle(
            &self,
            handle: &str,
        ) -> Result<Option<AgentProfileFact>, PersistenceFailure> {
            Ok(self.rows.values().find(|fact| fact.name == handle).cloned())
        }
    }

    /// A liar whose by-handle read returns a row whose name is NOT the handle.
    struct LiarReader {
        row: AgentProfileFact,
    }

    impl AgentProfileReadModel for LiarReader {
        async fn read_agent_profile(
            &self,
            _agent: &AgentId,
        ) -> Result<Option<AgentProfileFact>, PersistenceFailure> {
            Ok(Some(self.row.clone()))
        }

        async fn read_agent_profile_by_handle(
            &self,
            _handle: &str,
        ) -> Result<Option<AgentProfileFact>, PersistenceFailure> {
            Ok(Some(self.row.clone()))
        }
    }

    /// Records whether the membership edge was consulted, so a test can prove the
    /// binding short-circuits BEFORE it.
    struct RecordingMembership {
        members: HashSet<String>,
        consulted: AtomicBool,
    }

    impl RecordingMembership {
        fn with(members: impl IntoIterator<Item = &'static str>) -> Self {
            Self {
                members: members.into_iter().map(str::to_string).collect(),
                consulted: AtomicBool::new(false),
            }
        }

        fn consulted(&self) -> bool {
            self.consulted.load(Ordering::SeqCst)
        }
    }

    impl PeerTargetMembership for RecordingMembership {
        async fn agent_is_member(
            &self,
            _workspace: &WorkspaceId,
            agent: &AgentId,
        ) -> Result<bool, PersistenceFailure> {
            self.consulted.store(true, Ordering::SeqCst);
            Ok(self.members.contains(agent.as_str()))
        }
    }

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn workspace() -> WorkspaceId {
        WorkspaceId::parse("w1").expect("workspace id")
    }

    fn fact(id: &str, name: &str) -> AgentProfileFact {
        AgentProfileFact {
            id: agent(id),
            name: name.to_string(),
            display_name: name.to_string(),
            description: None,
            avatar: Some(AvatarRevision::at(10)),
        }
    }

    #[tokio::test]
    async fn a_bound_member_is_found() {
        let profiles = FakeProfiles {
            rows: HashMap::from([("t1".to_string(), fact("t1", "target"))]),
        };
        let membership = RecordingMembership::with(["t1"]);
        let outcome = resolve_peer_target(&profiles, &membership, "target", &workspace())
            .await
            .expect("honest read");
        assert_eq!(outcome, PeerTargetOutcome::Found(fact("t1", "target")));
    }

    #[tokio::test]
    async fn a_bound_non_member_collapses_to_not_found() {
        let profiles = FakeProfiles {
            rows: HashMap::from([("t1".to_string(), fact("t1", "target"))]),
        };
        // Membership is consulted (the handle bound) and answers false.
        let membership = RecordingMembership::with([]);
        let outcome = resolve_peer_target(&profiles, &membership, "target", &workspace())
            .await
            .expect("honest read");
        assert_eq!(outcome, PeerTargetOutcome::NotFound);
        assert!(membership.consulted(), "a bound handle is checked");
    }

    #[tokio::test]
    async fn an_unknown_handle_collapses_without_consulting_membership() {
        let profiles = FakeProfiles {
            rows: HashMap::new(),
        };
        let membership = RecordingMembership::with(["t1"]);
        let outcome = resolve_peer_target(&profiles, &membership, "ghost", &workspace())
            .await
            .expect("absent is not a fault");
        assert_eq!(outcome, PeerTargetOutcome::NotFound);
        assert!(
            !membership.consulted(),
            "no row means nothing to check membership for"
        );
    }

    /// Liar-reader test #2 (by-handle): a reader that returns a row whose name is
    /// not the requested handle is a safe `500`, AND the membership edge is never
    /// consulted — the binding short-circuits before it, so a broken read cannot
    /// be laundered into a membership answer about another agent.
    #[tokio::test]
    async fn a_by_handle_liar_is_a_source_violation_before_membership() {
        use crate::agent_profile_read::ProfileSourceViolation;

        let liar = LiarReader {
            row: fact("t1", "someone-else"),
        };
        let membership = RecordingMembership::with(["t1"]);
        let outcome = resolve_peer_target(&liar, &membership, "target", &workspace()).await;
        match outcome {
            Err(ProfileReadFault::Source(ProfileSourceViolation::Handle {
                requested,
                returned,
            })) => {
                assert_eq!(requested, "target");
                assert_eq!(returned, "someone-else");
            }
            other => panic!("expected a handle source violation, got {other:?}"),
        }
        assert!(
            !membership.consulted(),
            "the binding must short-circuit before membership"
        );
    }

    // -- admit_peer_profile: the caller-side gate ladder --------------------

    /// A reader that records whether EITHER read method was consulted, so a test
    /// can prove the target tail is never reached before the gates pass.
    struct RecordingProfiles {
        rows: HashMap<String, AgentProfileFact>,
        consulted: AtomicBool,
    }

    impl RecordingProfiles {
        fn with(rows: impl IntoIterator<Item = AgentProfileFact>) -> Self {
            Self {
                rows: rows
                    .into_iter()
                    .map(|fact| (fact.name.clone(), fact))
                    .collect(),
                consulted: AtomicBool::new(false),
            }
        }

        fn consulted(&self) -> bool {
            self.consulted.load(Ordering::SeqCst)
        }
    }

    impl AgentProfileReadModel for RecordingProfiles {
        async fn read_agent_profile(
            &self,
            _agent: &AgentId,
        ) -> Result<Option<AgentProfileFact>, PersistenceFailure> {
            self.consulted.store(true, Ordering::SeqCst);
            unreachable!("the peer route reads only by handle")
        }

        async fn read_agent_profile_by_handle(
            &self,
            handle: &str,
        ) -> Result<Option<AgentProfileFact>, PersistenceFailure> {
            self.consulted.store(true, Ordering::SeqCst);
            Ok(self.rows.get(handle).cloned())
        }
    }

    struct RecordingPlacement {
        placement: Option<WorkspacePlacement>,
        consulted: AtomicBool,
    }

    impl RecordingPlacement {
        fn of(placement: Option<WorkspacePlacement>) -> Self {
            Self {
                placement,
                consulted: AtomicBool::new(false),
            }
        }
    }

    impl CallerConversationPlacement for RecordingPlacement {
        async fn conversation_placement(
            &self,
            _conversation: &ConversationId,
        ) -> Result<Option<WorkspacePlacement>, PersistenceFailure> {
            self.consulted.store(true, Ordering::SeqCst);
            Ok(self.placement.clone())
        }
    }

    /// A placement port that MUST NOT be consulted — an `AgentSlot` caller runs no
    /// conversation lookup.
    struct UnreachablePlacement;

    impl CallerConversationPlacement for UnreachablePlacement {
        async fn conversation_placement(
            &self,
            _conversation: &ConversationId,
        ) -> Result<Option<WorkspacePlacement>, PersistenceFailure> {
            unreachable!("an AgentSlot caller must not trigger a placement lookup")
        }
    }

    struct RecordingHorizon {
        reachable: HashSet<String>,
        consulted: AtomicBool,
    }

    impl RecordingHorizon {
        fn reaching(reachable: impl IntoIterator<Item = &'static str>) -> Self {
            Self {
                reachable: reachable.into_iter().map(str::to_string).collect(),
                consulted: AtomicBool::new(false),
            }
        }

        fn consulted(&self) -> bool {
            self.consulted.load(Ordering::SeqCst)
        }
    }

    impl CallerWorkspaceHorizon for RecordingHorizon {
        async fn can_access_workspace(
            &self,
            _agent: &AgentId,
            workspace: &WorkspaceId,
        ) -> Result<bool, PersistenceFailure> {
            self.consulted.store(true, Ordering::SeqCst);
            Ok(self.reachable.contains(workspace.as_str()))
        }
    }

    struct RecordingCapability {
        allowed: HashSet<String>,
        consulted: AtomicBool,
    }

    impl RecordingCapability {
        fn granting(allowed: impl IntoIterator<Item = &'static str>) -> Self {
            Self {
                allowed: allowed.into_iter().map(str::to_string).collect(),
                consulted: AtomicBool::new(false),
            }
        }

        fn consulted(&self) -> bool {
            self.consulted.load(Ordering::SeqCst)
        }
    }

    impl CallerReadMessagesCapability for RecordingCapability {
        async fn may_read_messages(
            &self,
            _agent: &AgentId,
            workspace: &WorkspaceId,
        ) -> Result<bool, PersistenceFailure> {
            self.consulted.store(true, Ordering::SeqCst);
            Ok(self.allowed.contains(workspace.as_str()))
        }
    }

    fn conversation() -> ConversationId {
        ConversationId::parse("c1").expect("conversation id")
    }

    fn ws(id: &str) -> WorkspaceId {
        WorkspaceId::parse(id).expect("workspace id")
    }

    /// AgentSlot caller with no `workspace_id` → `WorkspaceScopeRequired`, and NO
    /// downstream port (placement, horizon, capability, reader, membership) is
    /// consulted.
    #[tokio::test]
    async fn an_agent_slot_without_a_workspace_is_scope_required() {
        let horizon = RecordingHorizon::reaching([]);
        let capability = RecordingCapability::granting([]);
        let reader = RecordingProfiles::with([]);
        let membership = RecordingMembership::with([]);
        let outcome = admit_peer_profile(
            &UnreachablePlacement,
            &horizon,
            &capability,
            &reader,
            &membership,
            &agent("caller"),
            None,
            None,
            "target",
        )
        .await
        .expect("no fault");
        assert_eq!(outcome, PeerProfileOutcome::WorkspaceScopeRequired);
        assert!(!horizon.consulted());
        assert!(!capability.consulted());
        assert!(!reader.consulted());
        assert!(!membership.consulted());
    }

    /// ConversationSlot caller whose bound conversation is missing → 404
    /// `ConversationMissing`, and nothing past the floor is consulted.
    #[tokio::test]
    async fn a_missing_bound_conversation_is_conversation_missing() {
        let placement = RecordingPlacement::of(None);
        let horizon = RecordingHorizon::reaching([]);
        let capability = RecordingCapability::granting([]);
        let reader = RecordingProfiles::with([]);
        let membership = RecordingMembership::with([]);
        let outcome = admit_peer_profile(
            &placement,
            &horizon,
            &capability,
            &reader,
            &membership,
            &agent("caller"),
            Some(&conversation()),
            Some(&ws("w2")),
            "target",
        )
        .await
        .expect("no fault");
        assert_eq!(outcome, PeerProfileOutcome::ConversationMissing);
        assert!(!horizon.consulted());
        assert!(!capability.consulted());
        assert!(!reader.consulted());
        assert!(!membership.consulted());
    }

    /// A workspace-less (direct-pair) source with no explicit `workspace_id` →
    /// `WorkspaceScopeRequired`.
    #[tokio::test]
    async fn a_workspace_less_source_without_a_workspace_is_scope_required() {
        let placement = RecordingPlacement::of(Some(WorkspacePlacement::WorkspaceLess));
        let horizon = RecordingHorizon::reaching([]);
        let capability = RecordingCapability::granting([]);
        let reader = RecordingProfiles::with([]);
        let membership = RecordingMembership::with([]);
        let outcome = admit_peer_profile(
            &placement,
            &horizon,
            &capability,
            &reader,
            &membership,
            &agent("caller"),
            Some(&conversation()),
            None,
            "target",
        )
        .await
        .expect("no fault");
        assert_eq!(outcome, PeerProfileOutcome::WorkspaceScopeRequired);
        assert!(!reader.consulted());
        assert!(!membership.consulted());
    }

    /// Same-workspace target (explicit == source): the horizon is SKIPPED; only
    /// the always-on capability gate runs before the tail.
    #[tokio::test]
    async fn a_same_workspace_target_skips_the_horizon() {
        let placement = RecordingPlacement::of(Some(WorkspacePlacement::Workspace(ws("w1"))));
        let horizon = RecordingHorizon::reaching([]); // would deny if consulted
        let capability = RecordingCapability::granting(["w1"]);
        let reader = RecordingProfiles::with([fact("t1", "target")]);
        let membership = RecordingMembership::with(["t1"]);
        let outcome = admit_peer_profile(
            &placement,
            &horizon,
            &capability,
            &reader,
            &membership,
            &agent("caller"),
            Some(&conversation()),
            None,
            "target",
        )
        .await
        .expect("no fault");
        assert_eq!(outcome, PeerProfileOutcome::Profile(fact("t1", "target")));
        assert!(
            !horizon.consulted(),
            "same-workspace target skips the horizon"
        );
        assert!(
            capability.consulted(),
            "the capability gate is always consulted"
        );
    }

    /// Cross-workspace target outside the caller's horizon → `HorizonForbidden`, and
    /// the capability, reader, and membership are never reached.
    #[tokio::test]
    async fn a_cross_workspace_target_outside_the_horizon_is_forbidden() {
        let placement = RecordingPlacement::of(Some(WorkspacePlacement::Workspace(ws("w1"))));
        let horizon = RecordingHorizon::reaching([]); // w2 not reachable
        let capability = RecordingCapability::granting(["w2"]);
        let reader = RecordingProfiles::with([fact("t1", "target")]);
        let membership = RecordingMembership::with(["t1"]);
        let outcome = admit_peer_profile(
            &placement,
            &horizon,
            &capability,
            &reader,
            &membership,
            &agent("caller"),
            Some(&conversation()),
            Some(&ws("w2")),
            "target",
        )
        .await
        .expect("no fault");
        assert_eq!(outcome, PeerProfileOutcome::HorizonForbidden);
        assert!(horizon.consulted());
        assert!(!capability.consulted(), "horizon refuses before capability");
        assert!(!reader.consulted());
        assert!(!membership.consulted());
    }

    /// Past the horizon, a missing `read_messages` capability → `CapabilityDenied`,
    /// and the target tail is never reached.
    #[tokio::test]
    async fn a_missing_read_messages_capability_is_forbidden() {
        let placement = RecordingPlacement::of(Some(WorkspacePlacement::Workspace(ws("w1"))));
        let horizon = RecordingHorizon::reaching(["w2"]);
        let capability = RecordingCapability::granting([]); // no read_messages anywhere
        let reader = RecordingProfiles::with([fact("t1", "target")]);
        let membership = RecordingMembership::with(["t1"]);
        let outcome = admit_peer_profile(
            &placement,
            &horizon,
            &capability,
            &reader,
            &membership,
            &agent("caller"),
            Some(&conversation()),
            Some(&ws("w2")),
            "target",
        )
        .await
        .expect("no fault");
        assert_eq!(outcome, PeerProfileOutcome::CapabilityDenied);
        assert!(capability.consulted());
        assert!(
            !reader.consulted(),
            "a capability refusal never reaches the reader"
        );
        assert!(!membership.consulted());
    }

    /// An AgentSlot caller naming a workspace it can reach, with the capability,
    /// reaches the target tail and is served the profile — proving the AgentSlot
    /// path DOES run horizon + capability (target differs from a null source).
    #[tokio::test]
    async fn an_agent_slot_naming_a_reachable_workspace_is_served() {
        let horizon = RecordingHorizon::reaching(["w2"]);
        let capability = RecordingCapability::granting(["w2"]);
        let reader = RecordingProfiles::with([fact("t1", "target")]);
        let membership = RecordingMembership::with(["t1"]);
        let outcome = admit_peer_profile(
            &UnreachablePlacement,
            &horizon,
            &capability,
            &reader,
            &membership,
            &agent("caller"),
            None,
            Some(&ws("w2")),
            "target",
        )
        .await
        .expect("no fault");
        assert_eq!(outcome, PeerProfileOutcome::Profile(fact("t1", "target")));
        assert!(
            horizon.consulted(),
            "an AgentSlot target always differs from a null source"
        );
        assert!(capability.consulted());
    }

    /// All gates pass but the handle is unknown → the collapsed `NotFound`, with
    /// the membership edge not consulted (nothing to check).
    #[tokio::test]
    async fn all_gates_pass_but_an_unknown_handle_is_not_found() {
        let placement = RecordingPlacement::of(Some(WorkspacePlacement::Workspace(ws("w1"))));
        let horizon = RecordingHorizon::reaching([]);
        let capability = RecordingCapability::granting(["w1"]);
        let reader = RecordingProfiles::with([]); // no such handle
        let membership = RecordingMembership::with(["t1"]);
        let outcome = admit_peer_profile(
            &placement,
            &horizon,
            &capability,
            &reader,
            &membership,
            &agent("caller"),
            Some(&conversation()),
            None,
            "ghost",
        )
        .await
        .expect("no fault");
        assert_eq!(outcome, PeerProfileOutcome::NotFound);
        assert!(reader.consulted());
        assert!(
            !membership.consulted(),
            "an unknown handle has nothing to check"
        );
    }
}
