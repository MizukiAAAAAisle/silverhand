//! `GET /internal/agents/{aid}/peer-profile` — an agent reading ANOTHER agent's
//! narrow profile by a caller-supplied handle.
//!
//! ## `{aid}` is still the executing agent; the target is the `handle` query
//!
//! Like the self routes, this sits behind
//! [`require_runtime_credential`](crate::runtime_credential::require_runtime_credential),
//! which self-pins `{aid}` to the caller's own agent. Read HORIZON and write
//! AUTHORITY are different axes: the self routes are self-only structurally, and
//! that is worth keeping, so the peer read is a separate route with a
//! caller-supplied HANDLE rather than a widened gate on the self URL. `{aid}` here
//! means "the executing agent"; the target is named by `?handle=`.
//!
//! ## The gate order is anti-enumeration, and it is load-bearing
//!
//! Query SYNTAX is validated FIRST — a malformed handle is a statement about the
//! request, never about who exists — and only then does the caller-side ladder run
//! ([`admit_peer_profile`]): conversation floor → workspace scope → workspace
//! horizon → `read_messages` capability. Nothing about the target, not even whether
//! the handle exists, is observable until every caller-side gate passes; past them,
//! an unknown handle, a handle that belongs to a human, and an agent outside the
//! workspace all collapse into ONE identical `404`.

use axum::{
    Json, Router,
    extract::{Extension, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use silverhand_backend_core::{
    foundation::identity::WorkspaceId,
    foundation::name_canonicalization::is_ecmascript_trim_whitespace,
    host_runtime::runtime_credential::RuntimePrincipal,
    identity_access::agent_peer_profile::{
        CallerConversationPlacement, CallerReadMessagesCapability, CallerWorkspaceHorizon,
        PeerProfileOutcome, PeerTargetMembership, admit_peer_profile,
    },
    identity_access::agent_profile_read::{AgentProfileReadModel, ProfileReadFault},
    identity_access::user_identity::ParticipantHandle,
};

use super::wire::{AgentProfileDto, agent_profile_dto};
use crate::error;

/// The product route template. `{aid}` is consumed by the credential layer, which
/// self-pins it to the executing agent; the target is the `handle` query parameter.
pub const PEER_PROFILE_PATH: &str = "/internal/agents/{aid}/peer-profile";

/// The unmapped-error body: a bare `text/plain` `500`, never a JSON envelope.
const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

/// The `read_messages` capability token, spelled once for the denial body.
const READ_MESSAGES: &str = "read_messages";

/// The five caller/target ports the peer read composes — three answered by the
/// messaging store (placement, horizon, capability), the profile reader, and the
/// membership edge. Bundled as ONE cloneable state so the composition root wires the
/// production adapters and tests drive fakes; the router self-pins `{aid}` via its
/// layer exactly as the self route does.
#[derive(Clone)]
pub struct PeerProfilePorts<P, H, C, R, M> {
    pub placement: P,
    pub horizon: H,
    pub capability: C,
    pub reader: R,
    pub membership: M,
}

/// Mount the peer-profile read generic over its ports. This builder yields the bare
/// route; the composition root (backend-app, #2234 CP7a) registers it and composes the
/// runtime-credential layer that self-pins `{aid}` in front.
pub fn peer_profile_router<P, H, C, R, M>(ports: PeerProfilePorts<P, H, C, R, M>) -> Router
where
    P: CallerConversationPlacement + Clone + Send + Sync + 'static,
    H: CallerWorkspaceHorizon + Clone + Send + Sync + 'static,
    C: CallerReadMessagesCapability + Clone + Send + Sync + 'static,
    R: AgentProfileReadModel + Clone + Send + Sync + 'static,
    M: PeerTargetMembership + Clone + Send + Sync + 'static,
{
    Router::new()
        .route(PEER_PROFILE_PATH, get(peer_profile::<P, H, C, R, M>))
        .with_state(ports)
}

/// The raw query as it arrives on the wire. Both fields are optional at extraction
/// so a missing or malformed query never yields axum's own plain-text `400`; the
/// handler classifies them into the product `400 invalid query` itself.
#[derive(Deserialize)]
struct PeerProfileQueryRaw {
    handle: Option<String>,
    workspace_id: Option<String>,
}

/// `{ profile: <AgentProfileDto> }` — the SAME envelope the self read serves, so
/// "what a profile is" cannot fork into a self shape and a peer shape.
#[derive(Serialize)]
struct PeerProfileResponse {
    profile: AgentProfileDto,
}

/// Strip the display `@` and surrounding whitespace to get the stored name —
/// parity of the shared `normalizeHandle` (`handle.trim().replace(/^@/, '')`): trim,
/// then strip AT MOST ONE leading `@`. A pasted mention (`@alice`) and a bare name
/// (`alice`) must resolve to the same participant.
///
/// The trim folds against [`is_ecmascript_trim_whitespace`] — the ONE authority the
/// name envelope already uses — NOT Rust's `str::trim` (Unicode White_Space): the two
/// sets disagree (Rust trims U+0085, ECMAScript does not; ECMAScript trims U+FEFF,
/// Rust does not), so a second hand-written trim here would admit or reject handles
/// the TS door would not.
fn normalize_handle(handle: &str) -> &str {
    let trimmed = handle.trim_matches(is_ecmascript_trim_whitespace);
    trimmed.strip_prefix('@').unwrap_or(trimmed)
}

fn invalid_query() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "error": "invalid query" })),
    )
        .into_response()
}

async fn peer_profile<P, H, C, R, M>(
    credential: Option<Extension<RuntimePrincipal>>,
    Query(query): Query<PeerProfileQueryRaw>,
    State(ports): State<PeerProfilePorts<P, H, C, R, M>>,
) -> Response
where
    P: CallerConversationPlacement,
    H: CallerWorkspaceHorizon,
    C: CallerReadMessagesCapability,
    R: AgentProfileReadModel,
    M: PeerTargetMembership,
{
    // 1. Query SYNTAX first — a malformed handle is a statement about the request,
    //    resolved before anything about the target or even the caller is consulted.
    //    A handle is required; it validates on the SHARED handle grammar (trim + one
    //    leading `@`, then the stored participant-name schema). `workspace_id` is
    //    optional and empty-as-absent (parity of `c.req.query(...) || undefined` with
    //    a `.min(1)`): a present blank names no workspace.
    let Some(raw_handle) = query.handle.as_deref() else {
        return invalid_query();
    };
    let normalized = normalize_handle(raw_handle);
    if ParticipantHandle::parse(normalized).is_err() {
        return invalid_query();
    }
    let requested_workspace = match query.workspace_id.as_deref() {
        Some(workspace) if !workspace.is_empty() => match WorkspaceId::parse(workspace) {
            Ok(workspace) => Some(workspace),
            // A syntactically present but unparseable workspace id is a request-shape
            // fault, not a scope answer — the same `400` the schema would give.
            Err(_) => return invalid_query(),
        },
        _ => None,
    };

    // The principal is read, never derived. Absent means the credential layer was not
    // composed in front of this route — a composition fault, the safe `500`.
    let Some(Extension(credential)) = credential else {
        tracing::error!("peer-profile route reached without its runtime credential");
        return (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response();
    };
    let caller = credential.agent();
    let source = credential.source();

    match admit_peer_profile(
        &ports.placement,
        &ports.horizon,
        &ports.capability,
        &ports.reader,
        &ports.membership,
        caller,
        source,
        requested_workspace.as_ref(),
        normalized,
    )
    .await
    {
        Ok(PeerProfileOutcome::Profile(fact)) => Json(PeerProfileResponse {
            profile: agent_profile_dto(&fact),
        })
        .into_response(),
        // The caller's bound conversation does not exist.
        Ok(PeerProfileOutcome::ConversationMissing) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "conversation not found" })),
        )
            .into_response(),
        // No workspace could be resolved. The `code` is stable; the human `error`
        // differs by WHY, and the handler derives that from the caller's binding: an
        // `AgentSlot` caller (`source = None`) never had a conversation, while a
        // caller WITH a conversation that reached here had a workspace-less
        // (direct-pair) one — the only placement that resolves no workspace.
        Ok(PeerProfileOutcome::WorkspaceScopeRequired) => {
            let error = if source.is_none() {
                "agent-scoped peer lookup must name workspace_id"
            } else {
                "this conversation has no workspace (placement_kind=direct_pair), \
                 so a workspace-scoped query must name one: pass workspace_id"
            };
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": error,
                    "code": "workspace_scope_required",
                })),
            )
                .into_response()
        }
        // Outside the caller's horizon — merges "no such workspace" with "unreachable"
        // so workspace existence cannot be probed.
        Ok(PeerProfileOutcome::HorizonForbidden) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "forbidden" })),
        )
            .into_response(),
        // Reachable workspace, but no `read_messages` capability — the distinct
        // `capability_denied` body the CLI keys on, carrying the typed capability.
        Ok(PeerProfileOutcome::CapabilityDenied) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "code": "capability_denied",
                "capability": READ_MESSAGES,
                "message": format!("missing '{READ_MESSAGES}' capability in this workspace"),
                "details": { "capability": READ_MESSAGES },
            })),
        )
            .into_response(),
        // The collapsed target `404`: unknown handle, a human's handle, or a
        // non-member — all indistinguishable, so no cross-workspace existence leaks.
        Ok(PeerProfileOutcome::NotFound) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "agent not found" })),
        )
            .into_response(),
        // A persistence fault OR a source-binding violation (a reader that handed back
        // a row that is not the requested handle) is the lane's safe `500`.
        Err(fault) => {
            let cause: &dyn std::error::Error = match &fault {
                ProfileReadFault::Persistence(failure) => failure,
                ProfileReadFault::Source(violation) => violation,
            };
            tracing::error!(
                error_chain = %error::describe(cause),
                "peer-profile read failed"
            );
            (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use serde_json::{Value, json};
    use silverhand_backend_core::{
        foundation::identity::{AgentId, ConversationId, DaemonInstanceId},
        foundation::persistence::PersistenceFailure,
        host_runtime::runtime_credential::{RuntimeCustody, RuntimeGeneration, RuntimeScope},
        identity_access::agent_peer_profile::WorkspacePlacement,
        identity_access::agent_profile_read::AgentProfileFact,
        messaging::AvatarRevision,
    };
    use std::{
        collections::{HashMap, HashSet},
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };
    use tower::ServiceExt;

    /// One cloneable fake standing in for all five ports, so a test can steer
    /// `admit_peer_profile` to a chosen outcome and observe which ports were
    /// consulted. All calls share an `Arc` so the clone `with_state` holds records
    /// into the same counters.
    #[derive(Clone)]
    struct Ports {
        inner: Arc<Inner>,
    }

    struct Inner {
        placement: Option<WorkspacePlacement>,
        placement_calls: AtomicUsize,
        horizon_ok: bool,
        capability_ok: bool,
        rows: HashMap<String, AgentProfileFact>,
        reader_asked: Mutex<Vec<String>>,
        members: HashSet<String>,
    }

    /// A permissive default that serves the target at `200`: a workspace-placed
    /// source, an open horizon and capability, one target row, and its membership.
    struct PortsBuilder {
        placement: Option<WorkspacePlacement>,
        horizon_ok: bool,
        capability_ok: bool,
        rows: Vec<AgentProfileFact>,
        members: Vec<String>,
    }

    impl PortsBuilder {
        fn build(self) -> Ports {
            Ports {
                inner: Arc::new(Inner {
                    placement: self.placement,
                    placement_calls: AtomicUsize::new(0),
                    horizon_ok: self.horizon_ok,
                    capability_ok: self.capability_ok,
                    rows: self
                        .rows
                        .into_iter()
                        .map(|fact| (fact.name.clone(), fact))
                        .collect(),
                    reader_asked: Mutex::new(Vec::new()),
                    members: self.members.into_iter().collect(),
                }),
            }
        }
    }

    fn permissive() -> PortsBuilder {
        permissive_fields()
    }

    impl Ports {
        fn placement_calls(&self) -> usize {
            self.inner.placement_calls.load(Ordering::SeqCst)
        }

        fn reader_asked(&self) -> Vec<String> {
            self.inner.reader_asked.lock().unwrap().clone()
        }
    }

    impl CallerConversationPlacement for Ports {
        async fn conversation_placement(
            &self,
            _conversation: &ConversationId,
        ) -> Result<Option<WorkspacePlacement>, PersistenceFailure> {
            self.inner.placement_calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.inner.placement.clone())
        }
    }

    impl CallerWorkspaceHorizon for Ports {
        async fn can_access_workspace(
            &self,
            _agent: &AgentId,
            _workspace: &WorkspaceId,
        ) -> Result<bool, PersistenceFailure> {
            Ok(self.inner.horizon_ok)
        }
    }

    impl CallerReadMessagesCapability for Ports {
        async fn may_read_messages(
            &self,
            _agent: &AgentId,
            _workspace: &WorkspaceId,
        ) -> Result<bool, PersistenceFailure> {
            Ok(self.inner.capability_ok)
        }
    }

    impl AgentProfileReadModel for Ports {
        async fn read_agent_profile(
            &self,
            _agent: &AgentId,
        ) -> Result<Option<AgentProfileFact>, PersistenceFailure> {
            unreachable!("the peer route reads only by handle")
        }

        async fn read_agent_profile_by_handle(
            &self,
            handle: &str,
        ) -> Result<Option<AgentProfileFact>, PersistenceFailure> {
            self.inner
                .reader_asked
                .lock()
                .unwrap()
                .push(handle.to_string());
            Ok(self.inner.rows.get(handle).cloned())
        }
    }

    impl PeerTargetMembership for Ports {
        async fn agent_is_member(
            &self,
            _workspace: &WorkspaceId,
            agent: &AgentId,
        ) -> Result<bool, PersistenceFailure> {
            Ok(self.inner.members.contains(agent.as_str()))
        }
    }

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn workspace(id: &str) -> WorkspaceId {
        WorkspaceId::parse(id).expect("workspace id")
    }

    fn fact(id: &str, name: &str) -> AgentProfileFact {
        AgentProfileFact {
            id: agent(id),
            name: name.to_string(),
            display_name: name.to_string(),
            description: Some("a bio".to_string()),
            avatar: Some(AvatarRevision::at(7)),
        }
    }

    fn custody() -> RuntimeCustody {
        RuntimeCustody::new(
            RuntimeGeneration::new(1).unwrap(),
            DaemonInstanceId::parse("daemon-1").unwrap(),
        )
    }

    fn agent_slot(id: &str) -> RuntimePrincipal {
        RuntimePrincipal::for_scope(RuntimeScope::AgentSlot { agent: agent(id) }, custody())
    }

    fn conversation_slot(id: &str, source: &str) -> RuntimePrincipal {
        RuntimePrincipal::for_scope(
            RuntimeScope::ConversationSlot {
                agent: agent(id),
                source: ConversationId::parse(source).expect("conversation id"),
            },
            custody(),
        )
    }

    async fn call(ports: Ports, query: &str, credential: Option<RuntimePrincipal>) -> Response {
        let mut request =
            Request::builder().uri(format!("/internal/agents/a1/peer-profile{query}"));
        if let Some(credential) = credential {
            request = request.extension(credential);
        }
        // One fake answers all five ports; bundle five clones so the router's generic
        // state is satisfied while every call still records into the same counters.
        let bundle = PeerProfilePorts {
            placement: ports.clone(),
            horizon: ports.clone(),
            capability: ports.clone(),
            reader: ports.clone(),
            membership: ports,
        };
        peer_profile_router(bundle)
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    async fn body_json(response: Response) -> Value {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    }

    /// Query syntax is validated FIRST: a missing handle is a `400 invalid query`
    /// and NO port — not even the placement floor — is consulted.
    #[tokio::test]
    async fn a_missing_handle_is_a_400_before_any_port() {
        let ports = permissive().build();
        let response = call(
            ports.clone(),
            "",
            Some(conversation_slot("a1", "conv000000000001")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(response).await,
            json!({ "error": "invalid query" })
        );
        assert_eq!(
            ports.placement_calls(),
            0,
            "syntax refuses before the floor"
        );
        assert!(ports.reader_asked().is_empty());
    }

    /// A handle that fails the participant grammar (does not start with a letter) is
    /// the same `400`, still before any port.
    #[tokio::test]
    async fn a_malformed_handle_is_a_400() {
        let ports = permissive().build();
        let response = call(
            ports.clone(),
            "?handle=1nope",
            Some(conversation_slot("a1", "conv000000000001")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(ports.placement_calls(), 0);
    }

    /// A present-but-blank `workspace_id` is treated as ABSENT (parity of
    /// `c.req.query(...) || undefined`), so an AgentSlot caller reaches the
    /// scope-required gate rather than a workspace-parse `400`.
    #[tokio::test]
    async fn a_blank_workspace_id_is_absent_not_a_parse_error() {
        let ports = permissive().build();
        let response = call(ports, "?handle=alice&workspace_id=", Some(agent_slot("a1"))).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(response).await["code"],
            json!("workspace_scope_required")
        );
    }

    /// The leading display `@` is stripped before the reader is asked — a pasted
    /// mention and a bare name resolve to the same participant.
    #[tokio::test]
    async fn a_leading_at_is_normalized_before_the_reader() {
        let ports = permissive().build();
        let response = call(
            ports.clone(),
            "?handle=@alice",
            Some(conversation_slot("a1", "conv000000000001")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_json(response).await["profile"]["name"], json!("alice"));
        assert_eq!(ports.reader_asked(), vec!["alice".to_string()]);
    }

    /// Parity guard, direction A: U+0085 (NEL) is Unicode White_Space — Rust's
    /// `str::trim` WOULD strip it — but it is NOT in the ECMAScript trim set, so the TS
    /// door does not. The handle stays `\u{0085}alice`, fails the leading-letter
    /// grammar, and is a `400` with NO port consulted. A second hand-written `trim()`
    /// here would have wrongly resolved it.
    #[tokio::test]
    async fn a_nel_prefix_is_not_trimmed_and_is_a_400() {
        let ports = permissive().build();
        let response = call(
            ports.clone(),
            "?handle=%C2%85alice",
            Some(conversation_slot("a1", "conv000000000001")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            ports.placement_calls(),
            0,
            "NEL is not ECMAScript whitespace"
        );
        assert!(ports.reader_asked().is_empty());
    }

    /// Parity guard, direction B: U+FEFF (ZWNBSP/BOM) IS in the ECMAScript trim set —
    /// the TS door strips it — but Rust's `str::trim` does NOT. Folding against the
    /// canonical predicate strips it, so `\u{FEFF}alice` reaches the reader as the same
    /// `alice` a bare name would.
    #[tokio::test]
    async fn a_bom_prefix_is_trimmed_like_a_bare_name() {
        let ports = permissive().build();
        let response = call(
            ports.clone(),
            "?handle=%EF%BB%BFalice",
            Some(conversation_slot("a1", "conv000000000001")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(ports.reader_asked(), vec!["alice".to_string()]);
    }

    /// A valid query with no injected credential is a composition fault — the safe
    /// `500`, never a `401` (that verdict is the layer's alone).
    #[tokio::test]
    async fn an_absent_credential_is_a_safe_500() {
        let ports = permissive().build();
        let response = call(ports, "?handle=alice", None).await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    /// A ConversationSlot caller whose bound conversation is missing → `404
    /// conversation not found`.
    #[tokio::test]
    async fn a_missing_conversation_is_a_404() {
        let ports = PortsBuilder {
            placement: None,
            ..permissive_fields()
        }
        .build();
        let response = call(
            ports,
            "?handle=alice&workspace_id=w1",
            Some(conversation_slot("a1", "conv000000000001")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body_json(response).await,
            json!({ "error": "conversation not found" })
        );
    }

    /// An AgentSlot caller (no conversation) with no `workspace_id` → the
    /// scope-required `400` whose human message names the missing argument.
    #[tokio::test]
    async fn an_agent_slot_without_a_workspace_names_workspace_id() {
        let ports = permissive().build();
        let response = call(ports, "?handle=alice", Some(agent_slot("a1"))).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body_json(response).await;
        assert_eq!(body["code"], json!("workspace_scope_required"));
        assert_eq!(
            body["error"],
            json!("agent-scoped peer lookup must name workspace_id")
        );
    }

    /// A workspace-less (direct-pair) conversation with no `workspace_id` → the SAME
    /// `code`, but the human message names the placement instead.
    #[tokio::test]
    async fn a_workspace_less_conversation_names_the_placement() {
        let ports = PortsBuilder {
            placement: Some(WorkspacePlacement::WorkspaceLess),
            ..permissive_fields()
        }
        .build();
        let response = call(
            ports,
            "?handle=alice",
            Some(conversation_slot("a1", "conv000000000001")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body_json(response).await;
        assert_eq!(body["code"], json!("workspace_scope_required"));
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("placement_kind=direct_pair"),
            "the direct-pair message names its placement: {}",
            body["error"]
        );
    }

    /// A cross-workspace target outside the caller's horizon → a bare `403 forbidden`
    /// (workspace existence stays unprobed).
    #[tokio::test]
    async fn outside_the_horizon_is_a_bare_forbidden() {
        let ports = PortsBuilder {
            horizon_ok: false,
            ..permissive_fields()
        }
        .build();
        let response = call(
            ports,
            "?handle=alice&workspace_id=w2",
            Some(agent_slot("a1")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(body_json(response).await, json!({ "error": "forbidden" }));
    }

    /// A reachable workspace but no `read_messages` grant → the distinct
    /// `capability_denied` body, carrying the typed capability.
    #[tokio::test]
    async fn a_missing_capability_is_the_capability_denied_body() {
        let ports = PortsBuilder {
            capability_ok: false,
            ..permissive_fields()
        }
        .build();
        let response = call(
            ports,
            "?handle=alice",
            Some(conversation_slot("a1", "conv000000000001")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            body_json(response).await,
            json!({
                "code": "capability_denied",
                "capability": "read_messages",
                "message": "missing 'read_messages' capability in this workspace",
                "details": { "capability": "read_messages" }
            })
        );
    }

    /// Every gate passes but the handle is unknown → the collapsed `404 agent not
    /// found`, indistinguishable from a non-member.
    #[tokio::test]
    async fn an_unknown_target_is_the_collapsed_404() {
        let ports = PortsBuilder {
            rows: vec![],
            ..permissive_fields()
        }
        .build();
        let response = call(
            ports,
            "?handle=alice",
            Some(conversation_slot("a1", "conv000000000001")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body_json(response).await,
            json!({ "error": "agent not found" })
        );
    }

    /// The whole ladder passes → the target profile at `200`, in the SAME envelope
    /// the self read serves.
    #[tokio::test]
    async fn a_present_peer_is_projected_at_200() {
        let ports = permissive().build();
        let response = call(
            ports,
            "?handle=alice",
            Some(conversation_slot("a1", "conv000000000001")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await,
            json!({
                "profile": {
                    "id": "t1",
                    "name": "alice",
                    "display_name": "alice",
                    "description": "a bio",
                    "avatar_url": "/api/agents/t1/avatar?v=7"
                }
            })
        );
    }

    /// The permissive default's raw fields, so a test can override exactly one.
    fn permissive_fields() -> PortsBuilder {
        PortsBuilder {
            placement: Some(WorkspacePlacement::Workspace(workspace("w1"))),
            horizon_ok: true,
            capability_ok: true,
            rows: vec![fact("t1", "alice")],
            members: vec!["t1".to_string()],
        }
    }
}
