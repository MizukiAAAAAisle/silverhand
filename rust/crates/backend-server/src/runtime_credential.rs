//! Process-local runtime bearer custody and its HTTP/runtime handoff boundary.

use std::{
    collections::{HashMap, HashSet},
    error::Error,
    fmt,
    future::Future,
    sync::{Arc, Weak},
};

use axum::{
    Json, Router,
    extract::{FromRequestParts, Path, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use silverhand_backend_core::{
    foundation::identity::{AgentId, ConversationId, DaemonInstanceId},
    foundation::persistence::PersistenceFailure,
    host_runtime::runtime_credential::{
        AgentSlotPresentationFocusPort, ClaimRuntimeCustody, FinalizeRuntimeCustody,
        RuntimeCustodyPort, RuntimeCustodyReadPort, RuntimeEventTime, RuntimeFinalStatus,
        RuntimePrincipal, RuntimeScope,
    },
    host_runtime::runtime_event::{
        CommitRuntimeExit, DaemonEventDurablePort, RuntimeExitCommitResult, RuntimeExitDisposition,
    },
};
use tokio::sync::{Mutex, OwnedMutexGuard, RwLock};

use crate::{
    error,
    foundation::{
        bearer::strict_bearer_credential,
        clock::{ProcessClock, SystemProcessClock},
    },
};

const TOKEN_BYTES: usize = 32;
const TOKEN_GENERATION_ATTEMPTS: usize = 8;
const LEGACY_PRINCIPAL_HEADER: &str = "x-silverhand-principal";

/// A bearer presented by one runtime child.
///
/// It has no ordinary copy, comparison, string-view, or serialization surface.
/// The only raw view belongs to [`RuntimeStartHandoff`], where the daemon
/// transport consumes it for one child start.
///
/// ```compile_fail
/// use silverhand_backend_server::runtime_credential::RuntimeBearer;
/// let token = RuntimeBearer::parse("secret").unwrap();
/// let _ = token.clone();
/// ```
///
/// ```compile_fail
/// use silverhand_backend_server::runtime_credential::RuntimeBearer;
/// let left = RuntimeBearer::parse("secret").unwrap();
/// let right = RuntimeBearer::parse("secret").unwrap();
/// let _ = left == right;
/// ```
///
/// ```compile_fail
/// use std::ops::Deref;
/// use silverhand_backend_server::runtime_credential::RuntimeBearer;
/// let token = RuntimeBearer::parse("secret").unwrap();
/// let _: &str = Deref::deref(&token);
/// ```
///
/// ```compile_fail
/// use silverhand_backend_server::runtime_credential::RuntimeBearer;
/// let token = RuntimeBearer::parse("secret").unwrap();
/// let _: &str = token.as_ref();
/// ```
///
/// ```compile_fail
/// use silverhand_backend_server::runtime_credential::RuntimeBearer;
/// let token = RuntimeBearer::parse("secret").unwrap();
/// let _ = serde_json::to_string(&token).unwrap();
/// ```
pub struct RuntimeBearer(String);

impl RuntimeBearer {
    pub fn parse(raw: impl Into<String>) -> Option<Self> {
        let normalized = raw.into().trim().to_owned();
        (!normalized.is_empty()).then_some(Self(normalized))
    }

    fn hash(&self) -> TokenHash {
        TokenHash(Sha256::digest(self.0.as_bytes()).into())
    }
}

impl fmt::Debug for RuntimeBearer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RuntimeBearer([REDACTED])")
    }
}

#[derive(Clone, Copy, Eq, Hash, PartialEq)]
struct TokenHash([u8; 32]);

enum TokenRecord {
    Reserved,
    Active(RuntimePrincipal),
}

#[derive(Default)]
struct ProcessTokenStore {
    tokens: HashMap<TokenHash, TokenRecord>,
    by_principal: HashMap<RuntimePrincipal, HashSet<TokenHash>>,
}

#[derive(Default)]
struct ScopeGuards {
    by_scope: Mutex<HashMap<RuntimeScope, Weak<Mutex<()>>>>,
}

impl ScopeGuards {
    async fn acquire(&self, scope: &RuntimeScope) -> OwnedMutexGuard<()> {
        let guard = {
            let mut guards = self.by_scope.lock().await;
            guards.retain(|_, guard| guard.strong_count() > 0);
            if let Some(guard) = guards.get(scope).and_then(Weak::upgrade) {
                guard
            } else {
                let guard = Arc::new(Mutex::new(()));
                guards.insert(scope.clone(), Arc::downgrade(&guard));
                guard
            }
        };
        guard.lock_owned().await
    }
}

impl ProcessTokenStore {
    fn reserve(&mut self, hash: TokenHash) -> bool {
        if self.tokens.contains_key(&hash) {
            return false;
        }
        self.tokens.insert(hash, TokenRecord::Reserved);
        true
    }

    fn release_reservation(&mut self, hash: TokenHash) {
        if matches!(self.tokens.get(&hash), Some(TokenRecord::Reserved)) {
            self.tokens.remove(&hash);
        }
    }

    fn activate(&mut self, hash: TokenHash, principal: RuntimePrincipal) -> bool {
        if !matches!(self.tokens.get(&hash), Some(TokenRecord::Reserved)) {
            return false;
        }
        self.tokens
            .insert(hash, TokenRecord::Active(principal.clone()));
        self.by_principal.entry(principal).or_default().insert(hash);
        true
    }

    fn principal(&self, hash: TokenHash) -> Option<RuntimePrincipal> {
        match self.tokens.get(&hash) {
            Some(TokenRecord::Active(principal)) => Some(principal.clone()),
            Some(TokenRecord::Reserved) | None => None,
        }
    }

    fn revoke_hash(&mut self, hash: TokenHash) {
        let Some(record) = self.tokens.remove(&hash) else {
            return;
        };
        let TokenRecord::Active(principal) = record else {
            return;
        };
        let remove_principal = if let Some(tokens) = self.by_principal.get_mut(&principal) {
            tokens.remove(&hash);
            tokens.is_empty()
        } else {
            false
        };
        if remove_principal {
            self.by_principal.remove(&principal);
        }
    }

    fn revoke_for(&mut self, principal: &RuntimePrincipal) {
        let Some(hashes) = self.by_principal.remove(principal) else {
            return;
        };
        for hash in hashes {
            self.tokens.remove(&hash);
        }
    }

    fn has_active_for(&self, principal: &RuntimePrincipal) -> bool {
        self.by_principal
            .get(principal)
            .is_some_and(|hashes| !hashes.is_empty())
    }
}

pub trait RuntimeEntropy: Clone + Send + Sync + 'static {
    type Error: Error + Send + Sync + 'static;

    fn fill(&self, bytes: &mut [u8]) -> Result<(), Self::Error>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemRuntimeEntropy;

impl RuntimeEntropy for SystemRuntimeEntropy {
    type Error = getrandom::Error;

    fn fill(&self, bytes: &mut [u8]) -> Result<(), Self::Error> {
        getrandom::fill(bytes)
    }
}

#[derive(Debug)]
pub enum PrepareRuntimeCredentialError {
    Entropy(Box<dyn Error + Send + Sync + 'static>),
    CollisionExhausted,
    Persistence(PersistenceFailure),
    ReservationLost,
    ReservationCompensation(PersistenceFailure),
}

impl fmt::Display for PrepareRuntimeCredentialError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Entropy(_) => "runtime credential entropy failed",
            Self::CollisionExhausted => {
                "runtime credential entropy repeatedly produced an active token"
            }
            Self::Persistence(_) => "persistence operation failed",
            Self::ReservationLost => "runtime credential reservation disappeared before activation",
            Self::ReservationCompensation(_) => {
                "runtime credential reservation was lost and custody compensation failed"
            }
        })
    }
}

impl Error for PrepareRuntimeCredentialError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Entropy(source) => Some(source.as_ref()),
            Self::Persistence(source) | Self::ReservationCompensation(source) => Some(source),
            Self::CollisionExhausted | Self::ReservationLost => None,
        }
    }
}

impl From<PersistenceFailure> for PrepareRuntimeCredentialError {
    fn from(source: PersistenceFailure) -> Self {
        Self::Persistence(source)
    }
}

pub struct RuntimeStartHandoff {
    principal: RuntimePrincipal,
    bearer: RuntimeBearer,
    token_hash: TokenHash,
    newly_claimed: bool,
}

impl RuntimeStartHandoff {
    pub fn principal(&self) -> &RuntimePrincipal {
        &self.principal
    }

    pub fn daemon_auth_token(&self) -> &str {
        &self.bearer.0
    }
}

impl fmt::Debug for RuntimeStartHandoff {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeStartHandoff")
            .field("principal", &self.principal)
            .field("bearer", &"[REDACTED]")
            .field("newly_claimed", &self.newly_claimed)
            .finish()
    }
}

#[derive(Clone)]
pub struct RuntimeCredentialAuthority<C, E = SystemRuntimeEntropy, K = SystemProcessClock> {
    custody: C,
    tokens: Arc<RwLock<ProcessTokenStore>>,
    presentation_focus: Arc<RwLock<HashMap<RuntimePrincipal, ConversationId>>>,
    scope_guards: Arc<ScopeGuards>,
    entropy: E,
    /// Neutral wall clock. Custody stamps are runtime-event instants, so the branding
    /// happens here — where a stamp means something — rather than in the shared clock.
    clock: K,
}

impl<C> RuntimeCredentialAuthority<C>
where
    C: RuntimeCustodyPort,
{
    pub fn production(custody: C) -> Self {
        Self::new(custody, SystemRuntimeEntropy, SystemProcessClock)
    }
}

impl<C, E, K> RuntimeCredentialAuthority<C, E, K>
where
    C: RuntimeCustodyPort,
    E: RuntimeEntropy,
    K: ProcessClock,
{
    pub fn new(custody: C, entropy: E, clock: K) -> Self {
        Self {
            custody,
            tokens: Arc::new(RwLock::new(ProcessTokenStore::default())),
            presentation_focus: Arc::new(RwLock::new(HashMap::new())),
            scope_guards: Arc::new(ScopeGuards::default()),
            entropy,
            clock,
        }
    }

    /// This process's reading, branded as the runtime-event instant custody stores.
    fn event_time(&self) -> RuntimeEventTime {
        RuntimeEventTime::from_unix_millis(self.clock.now_unix_millis())
    }

    async fn prepare(
        &self,
        scope: RuntimeScope,
        daemon_instance: DaemonInstanceId,
    ) -> Result<Option<RuntimeStartHandoff>, PrepareRuntimeCredentialError> {
        let (bearer, token_hash) = self.reserve_secret().await?;
        let claim = self
            .custody
            .claim_or_current(ClaimRuntimeCustody::new(
                scope,
                daemon_instance,
                self.event_time(),
            ))
            .await;
        let claimed = match claim {
            Ok(Some(claimed)) => claimed,
            Ok(None) => {
                self.tokens.write().await.release_reservation(token_hash);
                return Ok(None);
            }
            Err(error) => {
                self.tokens.write().await.release_reservation(token_hash);
                return Err(error.into());
            }
        };
        let principal = claimed.principal().clone();
        if !self
            .tokens
            .write()
            .await
            .activate(token_hash, principal.clone())
        {
            if claimed.is_newly_claimed() {
                let compensated = self
                    .custody
                    .finalize(FinalizeRuntimeCustody::new(
                        principal,
                        RuntimeFinalStatus::Crashed,
                        self.event_time(),
                    ))
                    .await;
                match compensated {
                    Ok(true) => {}
                    Ok(false) => return Err(PrepareRuntimeCredentialError::ReservationLost),
                    Err(error) => {
                        return Err(PrepareRuntimeCredentialError::ReservationCompensation(
                            error,
                        ));
                    }
                }
            }
            return Err(PrepareRuntimeCredentialError::ReservationLost);
        }
        Ok(Some(RuntimeStartHandoff {
            principal,
            bearer,
            token_hash,
            newly_claimed: claimed.is_newly_claimed(),
        }))
    }

    async fn authenticate(
        &self,
        bearer: RuntimeBearer,
        route_agent: AgentId,
    ) -> Result<Option<RuntimePrincipal>, PersistenceFailure> {
        let principal = self.tokens.read().await.principal(bearer.hash());
        let Some(principal) = principal else {
            return Ok(None);
        };
        if principal.agent() != &route_agent {
            return Ok(None);
        }
        if !self.custody.is_current(principal.clone()).await? {
            return Ok(None);
        }
        Ok(Some(principal))
    }

    pub async fn finalize(
        &self,
        principal: RuntimePrincipal,
        status: RuntimeFinalStatus,
    ) -> Result<bool, PersistenceFailure> {
        let _scope_guard = self.scope_guards.acquire(&principal.scope()).await;
        self.finalize_locked(principal, status).await
    }

    pub(crate) async fn commit_daemon_exit<P>(
        &self,
        durable: &P,
        event: CommitRuntimeExit,
    ) -> Result<RuntimeExitCommitResult, PersistenceFailure>
    where
        P: DaemonEventDurablePort,
    {
        let principal = event.admission().principal().clone();
        let _scope_guard = self.scope_guards.acquire(&principal.scope()).await;
        let disposition = durable.commit_exit(event).await?;
        if disposition.disposition() == RuntimeExitDisposition::Applied {
            self.tokens.write().await.revoke_for(&principal);
            self.presentation_focus.write().await.remove(&principal);
        }
        Ok(disposition)
    }

    async fn finalize_locked(
        &self,
        principal: RuntimePrincipal,
        status: RuntimeFinalStatus,
    ) -> Result<bool, PersistenceFailure> {
        let finalized = self
            .custody
            .finalize(FinalizeRuntimeCustody::new(
                principal.clone(),
                status,
                self.event_time(),
            ))
            .await?;
        if finalized {
            self.tokens.write().await.revoke_for(&principal);
            self.presentation_focus.write().await.remove(&principal);
        }
        Ok(finalized)
    }

    pub async fn current(
        &self,
        scope: RuntimeScope,
    ) -> Result<Option<RuntimePrincipal>, PersistenceFailure> {
        self.custody.current(scope).await
    }

    async fn has_active_for(&self, principal: &RuntimePrincipal) -> bool {
        self.tokens.read().await.has_active_for(principal)
    }

    async fn reserve_secret(
        &self,
    ) -> Result<(RuntimeBearer, TokenHash), PrepareRuntimeCredentialError> {
        for _ in 0..TOKEN_GENERATION_ATTEMPTS {
            let mut bytes = [0_u8; TOKEN_BYTES];
            self.entropy
                .fill(&mut bytes)
                .map_err(|error| PrepareRuntimeCredentialError::Entropy(Box::new(error)))?;
            let bearer = RuntimeBearer(URL_SAFE_NO_PAD.encode(bytes));
            let hash = bearer.hash();
            if self.tokens.write().await.reserve(hash) {
                return Ok((bearer, hash));
            }
        }
        Err(PrepareRuntimeCredentialError::CollisionExhausted)
    }

    pub async fn dispatch_start<T>(
        &self,
        scope: RuntimeScope,
        daemon_instance: DaemonInstanceId,
        presentation_origin: ConversationId,
        transport: &T,
    ) -> Result<RuntimePrincipal, RuntimeStartFailure<T::Error>>
    where
        T: RuntimeStartTransport,
    {
        let _scope_guard = self.scope_guards.acquire(&scope).await;
        let Some(handoff) = self
            .prepare(scope, daemon_instance)
            .await
            .map_err(RuntimeStartFailure::Prepare)?
        else {
            return Err(RuntimeStartFailure::MissingSlot);
        };
        let principal = handoff.principal.clone();
        match transport.dispatch(&handoff).await {
            Ok(()) => {
                if matches!(&principal, RuntimePrincipal::AgentSlot { .. }) {
                    let mut focus = self.presentation_focus.write().await;
                    focus.retain(|existing, _| {
                        existing.agent() != principal.agent() || existing.source().is_some()
                    });
                    focus.insert(principal.clone(), presentation_origin);
                }
                Ok(principal)
            }
            Err(RuntimeDispatchFailure::Ambiguous(source)) => {
                Err(RuntimeStartFailure::Ambiguous(source))
            }
            Err(RuntimeDispatchFailure::ProvenNotDispatched(source)) => {
                if handoff.newly_claimed {
                    match self
                        .finalize_locked(principal, RuntimeFinalStatus::Crashed)
                        .await
                    {
                        Ok(true) => {}
                        Ok(false) => {
                            self.tokens.write().await.revoke_hash(handoff.token_hash);
                        }
                        Err(compensation) => {
                            return Err(RuntimeStartFailure::Compensation {
                                dispatch: source,
                                compensation,
                            });
                        }
                    }
                } else {
                    self.tokens.write().await.revoke_hash(handoff.token_hash);
                }
                Err(RuntimeStartFailure::ProvenNotDispatched(source))
            }
        }
    }

    pub async fn reconcile_hydrated<T>(
        &self,
        principal: RuntimePrincipal,
        transport: &T,
    ) -> Result<HydrateCredentialDisposition, HydrateCredentialFailure<T::Error>>
    where
        T: RuntimeStopTransport,
    {
        let _scope_guard = self.scope_guards.acquire(&principal.scope()).await;
        if !self
            .custody
            .is_current(principal.clone())
            .await
            .map_err(HydrateCredentialFailure::Persistence)?
        {
            return Ok(HydrateCredentialDisposition::Superseded);
        }
        if self.has_active_for(&principal).await {
            return Ok(HydrateCredentialDisposition::CredentialPresent);
        }
        transport
            .stop_exact(&principal)
            .await
            .map_err(HydrateCredentialFailure::Stop)?;
        let finalized = self
            .finalize_locked(principal, RuntimeFinalStatus::Crashed)
            .await
            .map_err(HydrateCredentialFailure::Persistence)?;
        Ok(if finalized {
            HydrateCredentialDisposition::Finalized
        } else {
            HydrateCredentialDisposition::Superseded
        })
    }
}

impl<C, E, K> AgentSlotPresentationFocusPort for RuntimeCredentialAuthority<C, E, K>
where
    C: RuntimeCustodyPort,
    E: RuntimeEntropy,
    K: ProcessClock,
{
    async fn agent_slot_presentation_focus(
        &self,
        principal: RuntimePrincipal,
    ) -> Result<Option<ConversationId>, PersistenceFailure> {
        if !matches!(&principal, RuntimePrincipal::AgentSlot { .. }) {
            return Ok(None);
        }
        let _scope_guard = self.scope_guards.acquire(&principal.scope()).await;
        if !self.custody.is_current(principal.clone()).await? {
            self.presentation_focus.write().await.remove(&principal);
            return Ok(None);
        }
        Ok(self
            .presentation_focus
            .read()
            .await
            .get(&principal)
            .cloned())
    }
}

/// The switch route reads live custody through the authority, never the raw store: this
/// hands it exactly `current` (its source-bind read) while `claim_or_current`/`finalize`
/// stay sealed inside the authority, so a product route can never bypass the token,
/// scope-guard, and presentation-focus invariants those mutations enforce.
impl<C, E, K> RuntimeCustodyReadPort for RuntimeCredentialAuthority<C, E, K>
where
    C: RuntimeCustodyPort,
    E: RuntimeEntropy,
    K: ProcessClock,
{
    async fn current(
        &self,
        scope: RuntimeScope,
    ) -> Result<Option<RuntimePrincipal>, PersistenceFailure> {
        RuntimeCredentialAuthority::current(self, scope).await
    }
}

pub trait RuntimeStartTransport: Send + Sync {
    type Error: Error + Send + Sync + 'static;

    fn dispatch(
        &self,
        handoff: &RuntimeStartHandoff,
    ) -> impl Future<Output = Result<(), RuntimeDispatchFailure<Self::Error>>> + Send;
}

#[derive(Debug)]
pub enum RuntimeDispatchFailure<E: Error + 'static> {
    ProvenNotDispatched(E),
    Ambiguous(E),
}

impl<E: Error + 'static> fmt::Display for RuntimeDispatchFailure<E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::ProvenNotDispatched(_) => "runtime start was proven not dispatched",
            Self::Ambiguous(_) => "runtime start dispatch outcome is ambiguous",
        })
    }
}

impl<E: Error + 'static> Error for RuntimeDispatchFailure<E> {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::ProvenNotDispatched(source) | Self::Ambiguous(source) => Some(source),
        }
    }
}

#[derive(Debug)]
pub enum RuntimeStartFailure<E: Error + 'static> {
    Prepare(PrepareRuntimeCredentialError),
    MissingSlot,
    ProvenNotDispatched(E),
    Ambiguous(E),
    Compensation {
        dispatch: E,
        compensation: PersistenceFailure,
    },
}

impl<E: Error + 'static> fmt::Display for RuntimeStartFailure<E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Prepare(source) => fmt::Display::fmt(source, formatter),
            Self::MissingSlot => formatter.write_str("runtime slot does not exist"),
            Self::ProvenNotDispatched(_) => {
                formatter.write_str("runtime start was proven not dispatched")
            }
            Self::Ambiguous(_) => {
                formatter.write_str("runtime start dispatch outcome is ambiguous")
            }
            Self::Compensation { .. } => formatter.write_str(
                "runtime start was proven not dispatched but custody compensation failed",
            ),
        }
    }
}

impl<E: Error + 'static> Error for RuntimeStartFailure<E> {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Prepare(source) => Some(source),
            Self::ProvenNotDispatched(source) | Self::Ambiguous(source) => Some(source),
            Self::Compensation { compensation, .. } => Some(compensation),
            Self::MissingSlot => None,
        }
    }
}

pub trait RuntimeStopTransport: Send + Sync {
    type Error: Error + Send + Sync + 'static;

    fn stop_exact(
        &self,
        principal: &RuntimePrincipal,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HydrateCredentialDisposition {
    CredentialPresent,
    Finalized,
    Superseded,
}

#[derive(Debug)]
pub enum HydrateCredentialFailure<E: Error + 'static> {
    Stop(E),
    Persistence(PersistenceFailure),
}

impl<E: Error + 'static> fmt::Display for HydrateCredentialFailure<E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Stop(_) => formatter.write_str("stopping a hydrated runtime failed"),
            Self::Persistence(source) => fmt::Display::fmt(source, formatter),
        }
    }
}

impl<E: Error + 'static> Error for HydrateCredentialFailure<E> {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Stop(source) => Some(source),
            Self::Persistence(source) => Some(source),
        }
    }
}

pub trait AuthenticateRuntimeCredential: Clone + Send + Sync + 'static {
    fn authenticate_runtime(
        &self,
        bearer: RuntimeBearer,
        route_agent: AgentId,
    ) -> impl Future<Output = Result<Option<RuntimePrincipal>, PersistenceFailure>> + Send;
}

impl<C, E, K> AuthenticateRuntimeCredential for RuntimeCredentialAuthority<C, E, K>
where
    C: RuntimeCustodyPort,
    E: RuntimeEntropy,
    K: ProcessClock,
{
    async fn authenticate_runtime(
        &self,
        bearer: RuntimeBearer,
        route_agent: AgentId,
    ) -> Result<Option<RuntimePrincipal>, PersistenceFailure> {
        self.authenticate(bearer, route_agent).await
    }
}

#[derive(Clone)]
struct RuntimeCredentialState<A> {
    authority: A,
}

#[derive(Deserialize)]
struct RuntimeAgentPath {
    aid: String,
}

pub fn require_runtime_credential<A>(router: Router, authority: A) -> Router
where
    A: AuthenticateRuntimeCredential,
{
    router.route_layer(middleware::from_fn_with_state(
        RuntimeCredentialState { authority },
        authenticate_request::<A>,
    ))
}

async fn authenticate_request<A>(
    State(state): State<RuntimeCredentialState<A>>,
    request: Request,
    next: Next,
) -> Response
where
    A: AuthenticateRuntimeCredential,
{
    if request.headers().contains_key(LEGACY_PRINCIPAL_HEADER) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "principal header is not allowed on internal routes"
            })),
        )
            .into_response();
    }
    let Some(bearer) = strict_bearer_credential(request.headers())
        .and_then(|credential| RuntimeBearer::parse(credential.to_owned()))
    else {
        return unauthorized();
    };
    let (mut parts, body) = request.into_parts();
    let Ok(Path(path)) = Path::<RuntimeAgentPath>::from_request_parts(&mut parts, &()).await else {
        return unauthorized();
    };
    let Some(route_agent) = AgentId::parse(path.aid).ok() else {
        return unauthorized();
    };
    let mut request = Request::from_parts(parts, body);
    match state
        .authority
        .authenticate_runtime(bearer, route_agent)
        .await
    {
        Ok(Some(principal)) => {
            request.extensions_mut().insert(principal);
            next.run(request).await
        }
        Ok(None) => unauthorized(),
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "runtime credential authentication failed"
            );
            (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
        }
    }
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({ "error": "unauthorized" })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use std::{
        future::poll_fn,
        io,
        pin::Pin,
        sync::{Arc, Mutex as StdMutex},
        task::Poll,
    };

    use silverhand_backend_core::{
        foundation::identity::ConversationId,
        host_runtime::runtime_credential::{ClaimedRuntime, RuntimeCustody, RuntimeGeneration},
    };

    use super::*;

    #[test]
    fn runtime_secret_debug_is_redacted() {
        assert_eq!(
            format!("{:?}", RuntimeBearer::parse("top-secret").unwrap()),
            "RuntimeBearer([REDACTED])"
        );
    }

    #[tokio::test]
    async fn scope_guards_share_only_the_exact_runtime_scope() {
        let guards = ScopeGuards::default();
        let agent = AgentId::parse("agent-1").unwrap();
        let scope = RuntimeScope::ConversationSlot {
            agent: agent.clone(),
            source: ConversationId::parse("source-1").unwrap(),
        };
        let different_source = RuntimeScope::ConversationSlot {
            agent,
            source: ConversationId::parse("source-2").unwrap(),
        };
        let held = guards.acquire(&scope).await;

        let mut same_scope = Box::pin(guards.acquire(&scope));
        assert!(matches!(
            poll_once(same_scope.as_mut()).await,
            Poll::Pending
        ));

        let mut other_scope = Box::pin(guards.acquire(&different_source));
        let Poll::Ready(other_guard) = poll_once(other_scope.as_mut()).await else {
            panic!("a different runtime scope shared the held mutex");
        };

        drop(held);
        assert!(matches!(
            poll_once(same_scope.as_mut()).await,
            Poll::Ready(_)
        ));
        drop(other_guard);
    }

    async fn poll_once<F: Future>(mut future: Pin<&mut F>) -> Poll<F::Output> {
        poll_fn(|context| Poll::Ready(future.as_mut().poll(context))).await
    }

    #[derive(Clone, Default)]
    struct FocusCustody {
        current: Arc<StdMutex<Option<RuntimePrincipal>>>,
        next_generation: Arc<StdMutex<i64>>,
    }

    impl FocusCustody {
        fn clear(&self) {
            *self.current.lock().unwrap() = None;
        }
    }

    impl RuntimeCustodyPort for FocusCustody {
        async fn claim_or_current(
            &self,
            claim: ClaimRuntimeCustody,
        ) -> Result<Option<ClaimedRuntime>, PersistenceFailure> {
            if let Some(current) = self.current.lock().unwrap().clone().filter(|principal| {
                principal.scope() == *claim.scope()
                    && principal.custody().daemon_instance() == claim.daemon_instance()
            }) {
                return Ok(Some(ClaimedRuntime::new(current, false)));
            }
            let generation = {
                let mut next = self.next_generation.lock().unwrap();
                *next += 1;
                RuntimeGeneration::new(*next).unwrap()
            };
            let principal = RuntimePrincipal::for_scope(
                claim.scope().clone(),
                RuntimeCustody::new(generation, claim.daemon_instance().clone()),
            );
            *self.current.lock().unwrap() = Some(principal.clone());
            Ok(Some(ClaimedRuntime::new(principal, true)))
        }

        async fn current(
            &self,
            scope: RuntimeScope,
        ) -> Result<Option<RuntimePrincipal>, PersistenceFailure> {
            Ok(self
                .current
                .lock()
                .unwrap()
                .clone()
                .filter(|principal| principal.scope() == scope))
        }

        async fn is_current(
            &self,
            principal: RuntimePrincipal,
        ) -> Result<bool, PersistenceFailure> {
            Ok(self.current.lock().unwrap().as_ref() == Some(&principal))
        }

        async fn finalize(
            &self,
            finalization: FinalizeRuntimeCustody,
        ) -> Result<bool, PersistenceFailure> {
            let mut current = self.current.lock().unwrap();
            if current.as_ref() != Some(finalization.principal()) {
                return Ok(false);
            }
            *current = None;
            Ok(true)
        }
    }

    #[derive(Clone, Copy)]
    enum StartResult {
        Started,
        ProvenNotDispatched,
        Ambiguous,
        ExitBeforeStartedAck,
    }

    struct FocusTransport {
        result: StartResult,
        custody: FocusCustody,
    }

    impl RuntimeStartTransport for FocusTransport {
        type Error = io::Error;

        async fn dispatch(
            &self,
            _handoff: &RuntimeStartHandoff,
        ) -> Result<(), RuntimeDispatchFailure<Self::Error>> {
            match self.result {
                StartResult::Started => Ok(()),
                StartResult::ProvenNotDispatched => Err(
                    RuntimeDispatchFailure::ProvenNotDispatched(io::Error::other("not sent")),
                ),
                StartResult::Ambiguous => Err(RuntimeDispatchFailure::Ambiguous(io::Error::other(
                    "late or invalid answer",
                ))),
                StartResult::ExitBeforeStartedAck => {
                    self.custody.clear();
                    Ok(())
                }
            }
        }
    }

    fn daemon(raw: &str) -> DaemonInstanceId {
        DaemonInstanceId::parse(raw).unwrap()
    }

    fn origin(raw: &str) -> ConversationId {
        ConversationId::parse(raw).unwrap()
    }

    fn agent_slot() -> RuntimeScope {
        RuntimeScope::AgentSlot {
            agent: AgentId::parse("agent-focus").unwrap(),
        }
    }

    #[tokio::test]
    async fn agent_slot_focus_is_read_derived_generation_bound_and_success_only() {
        let custody = FocusCustody::default();
        let authority = RuntimeCredentialAuthority::production(custody.clone());
        let no_focus = authority
            .dispatch_start(
                agent_slot(),
                daemon("daemon-ambiguous"),
                origin("conversation-0"),
                &FocusTransport {
                    result: StartResult::Ambiguous,
                    custody: custody.clone(),
                },
            )
            .await;
        let Err(RuntimeStartFailure::Ambiguous(_)) = no_focus else {
            panic!("late/invalid start must remain ambiguous");
        };
        let ambiguous = custody.current(agent_slot()).await.unwrap().unwrap();
        assert_eq!(
            authority
                .agent_slot_presentation_focus(ambiguous.clone())
                .await
                .unwrap(),
            None
        );

        let retry_origin = origin("conversation-retry");
        let retried = authority
            .dispatch_start(
                agent_slot(),
                daemon("daemon-ambiguous"),
                retry_origin.clone(),
                &FocusTransport {
                    result: StartResult::Started,
                    custody: custody.clone(),
                },
            )
            .await
            .unwrap();
        assert_eq!(retried, ambiguous);
        assert_eq!(
            authority
                .agent_slot_presentation_focus(retried.clone())
                .await
                .unwrap(),
            Some(retry_origin)
        );

        let latest_origin = origin("conversation-latest");
        let same_principal = authority
            .dispatch_start(
                agent_slot(),
                daemon("daemon-ambiguous"),
                latest_origin.clone(),
                &FocusTransport {
                    result: StartResult::Started,
                    custody: custody.clone(),
                },
            )
            .await
            .unwrap();
        assert_eq!(same_principal, retried);
        assert_eq!(
            authority
                .agent_slot_presentation_focus(same_principal)
                .await
                .unwrap(),
            Some(latest_origin)
        );

        let c1 = origin("conversation-1");
        let first = authority
            .dispatch_start(
                agent_slot(),
                daemon("daemon-a"),
                c1.clone(),
                &FocusTransport {
                    result: StartResult::Started,
                    custody: custody.clone(),
                },
            )
            .await
            .unwrap();
        assert_eq!(
            authority
                .agent_slot_presentation_focus(first.clone())
                .await
                .unwrap(),
            Some(c1)
        );

        let c2 = origin("conversation-2");
        let successor = authority
            .dispatch_start(
                agent_slot(),
                daemon("daemon-b"),
                c2.clone(),
                &FocusTransport {
                    result: StartResult::Started,
                    custody: custody.clone(),
                },
            )
            .await
            .unwrap();
        assert_eq!(
            authority
                .agent_slot_presentation_focus(first)
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            authority
                .agent_slot_presentation_focus(successor)
                .await
                .unwrap(),
            Some(c2)
        );

        let failed = authority
            .dispatch_start(
                agent_slot(),
                daemon("daemon-c"),
                origin("conversation-3"),
                &FocusTransport {
                    result: StartResult::ProvenNotDispatched,
                    custody: custody.clone(),
                },
            )
            .await;
        assert!(matches!(
            failed,
            Err(RuntimeStartFailure::ProvenNotDispatched(_))
        ));
        assert!(
            authority
                .presentation_focus
                .read()
                .await
                .keys()
                .all(|principal| principal.custody().daemon_instance() != &daemon("daemon-c"))
        );
    }

    #[tokio::test]
    async fn exit_before_focus_install_can_leave_only_an_invisible_stale_entry() {
        let custody = FocusCustody::default();
        let authority = RuntimeCredentialAuthority::production(custody.clone());
        let principal = authority
            .dispatch_start(
                agent_slot(),
                daemon("daemon-a"),
                origin("conversation-1"),
                &FocusTransport {
                    result: StartResult::ExitBeforeStartedAck,
                    custody,
                },
            )
            .await
            .unwrap();
        assert!(
            authority
                .presentation_focus
                .read()
                .await
                .contains_key(&principal)
        );
        assert_eq!(
            authority
                .agent_slot_presentation_focus(principal.clone())
                .await
                .unwrap(),
            None
        );
        assert!(
            !authority
                .presentation_focus
                .read()
                .await
                .contains_key(&principal)
        );
    }
}
