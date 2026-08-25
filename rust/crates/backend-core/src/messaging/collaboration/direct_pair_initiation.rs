//! Human initiation of an agent-scoped direct-message line.
//!
//! This operation deliberately has three stages.  The initiation authority runs
//! before body admission and collapses an invisible target to `NotFound`.  After
//! the caller has admitted the complete first-message body, the pair is opened
//! through the canonical get-or-create operation.  Only then does a caller-owned
//! closure enter the existing message-send unit.  There is no compensation port:
//! a send failure after a winning mint leaves the announced empty pair committed,
//! which is the product contract rather than an accident to hide.
//!
//! An authorized value cannot be rebuilt from coordinates.  This is a negative
//! API fence, not proof that an arbitrary authority implementation is honest;
//! the positive proof is the source-coordinate bind performed by
//! [`authorize_direct_pair_initiation`].
//!
//! ```compile_fail
//! use silverhand_backend_core::{
//!     identity::{AgentId, UserId},
//!     messaging::collaboration::direct_pair_initiation::AuthorizedDirectPairInitiation,
//! };
//! let _forged = AuthorizedDirectPairInitiation {
//!     viewer: UserId::parse("user-1").unwrap(),
//!     target: AgentId::parse("agent-1").unwrap(),
//! };
//! ```

use std::{error::Error, future::Future};

use crate::{
    identity::{AgentId, UserId},
    messaging::{
        ConversationId, DirectPairMint, DirectPairOpenedPort, DirectPairParticipants,
        EnvironmentUnavailable, OpenDirectPairError, PrincipalIdentity, SameDirectPairParticipant,
        SendClock, open_direct_pair,
    },
};

/// The anti-enumeration ladder's closed answer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DirectPairInitiationDecision {
    /// The target is missing or not visible to this viewer.
    NotFound,
    /// The target is visible, but this principal may not initiate a pair.
    Forbidden,
    /// Both gates passed.  Coordinates remain attached until the consumer binds
    /// them to the authenticated request.
    Granted(DirectPairInitiationGrantFact),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectPairInitiationGrantFact {
    source_viewer: UserId,
    source_target: AgentId,
}

impl DirectPairInitiationGrantFact {
    pub fn granted(source_viewer: UserId, source_target: AgentId) -> Self {
        Self {
            source_viewer,
            source_target,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum DirectPairInitiationRefusal {
    #[error("target agent was not found")]
    NotFound,
    #[error("viewer may not initiate a direct pair with the target agent")]
    Forbidden,
}

/// Minimal consumer port for the named initiation policy.  Its adapter owns the
/// ACL evaluation order; this capability consumes only its closed verdict.
pub trait DirectPairInitiationAuthority {
    type Error: Error + Send + Sync + 'static;

    fn decide(
        &self,
        viewer: &UserId,
        target: &AgentId,
    ) -> impl Future<Output = Result<DirectPairInitiationDecision, Self::Error>> + Send;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthorizedDirectPairInitiation {
    viewer: UserId,
    target: AgentId,
}

impl AuthorizedDirectPairInitiation {
    pub fn viewer(&self) -> &UserId {
        &self.viewer
    }

    pub fn target(&self) -> &AgentId {
        &self.target
    }
}

pub async fn authorize_direct_pair_initiation<A: DirectPairInitiationAuthority>(
    authority: &A,
    viewer: UserId,
    target: AgentId,
) -> Result<
    Result<AuthorizedDirectPairInitiation, DirectPairInitiationRefusal>,
    DirectPairInitiationAuthorityError<A::Error>,
> {
    let decision = authority
        .decide(&viewer, &target)
        .await
        .map_err(DirectPairInitiationAuthorityError::Authority)?;
    match decision {
        DirectPairInitiationDecision::NotFound => Ok(Err(DirectPairInitiationRefusal::NotFound)),
        DirectPairInitiationDecision::Forbidden => Ok(Err(DirectPairInitiationRefusal::Forbidden)),
        DirectPairInitiationDecision::Granted(fact) => {
            if fact.source_viewer != viewer || fact.source_target != target {
                return Err(DirectPairInitiationAuthorityError::ForeignGrant(
                    ForeignDirectPairInitiationGrant,
                ));
            }
            Ok(Ok(AuthorizedDirectPairInitiation { viewer, target }))
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum DirectPairInitiationAuthorityError<E: Error + 'static> {
    #[error("direct-pair initiation authority failed")]
    Authority(#[source] E),
    #[error(transparent)]
    ForeignGrant(#[from] ForeignDirectPairInitiationGrant),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("direct-pair initiation grant does not belong to the authenticated request")]
pub struct ForeignDirectPairInitiationGrant;

/// The only value handed to the existing send unit.  It binds the minted
/// conversation to the same viewer and target admitted before the request body.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenedDirectPairFirstMessage {
    viewer: UserId,
    target: AgentId,
    conversation: ConversationId,
}

impl OpenedDirectPairFirstMessage {
    pub fn viewer(&self) -> &UserId {
        &self.viewer
    }

    pub fn target(&self) -> &AgentId {
        &self.target
    }

    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }
}

/// Open the pair and then enter the already-existing send unit through `send`.
///
/// Callers invoke this only after body/schema/reply/content admission.  A race
/// loser still sends through the existing pair but never publishes a second
/// `direct_pairs_changed`; a winner publishes before `send` is invoked.  No
/// rollback/delete capability exists here, so a later send error cannot
/// compensate the committed pair.
pub async fn open_and_send_direct_pair<M, O, C, F, Fut, T, S>(
    authorized: AuthorizedDirectPairInitiation,
    mint: &mut M,
    opened: &O,
    clock: &C,
    send: F,
) -> Result<T, DirectPairFirstSendError<M::Error, O::Error, S>>
where
    M: DirectPairMint,
    O: DirectPairOpenedPort,
    C: SendClock,
    F: FnOnce(OpenedDirectPairFirstMessage) -> Fut,
    Fut: Future<Output = Result<T, S>>,
    S: Error + Send + Sync + 'static,
{
    let participants = DirectPairParticipants::between(
        PrincipalIdentity::Human(authorized.viewer.clone()),
        PrincipalIdentity::Agent(authorized.target.clone()),
    )
    .map_err(DirectPairFirstSendError::Participants)?;
    let now = clock
        .now_unix_ms()
        .map_err(DirectPairFirstSendError::Clock)?;
    let conversation = open_direct_pair(mint, opened, participants, now)
        .await
        .map_err(DirectPairFirstSendError::Open)?;

    send(OpenedDirectPairFirstMessage {
        viewer: authorized.viewer,
        target: authorized.target,
        conversation,
    })
    .await
    .map_err(DirectPairFirstSendError::Send)
}

#[derive(Debug, thiserror::Error)]
pub enum DirectPairFirstSendError<M, O, S>
where
    M: Error + Send + Sync + 'static,
    O: Error + Send + Sync + 'static,
    S: Error + Send + Sync + 'static,
{
    #[error("direct-pair participants are invalid")]
    Participants(#[source] SameDirectPairParticipant),
    #[error("direct-pair initiation clock failed")]
    Clock(#[source] EnvironmentUnavailable),
    #[error("direct-pair opening failed")]
    Open(#[source] OpenDirectPairError<M, O>),
    #[error("first direct-pair message failed after opening")]
    Send(#[source] S),
}

#[cfg(test)]
mod tests {
    use std::{
        convert::Infallible,
        error::Error,
        sync::{Arc, Mutex},
    };

    use super::*;
    use crate::messaging::{DirectPairMinted, DirectPairOpenedFact};

    fn user(raw: &str) -> UserId {
        UserId::parse(raw).unwrap()
    }

    fn agent(raw: &str) -> AgentId {
        AgentId::parse(raw).unwrap()
    }

    struct Authority(DirectPairInitiationDecision);

    impl DirectPairInitiationAuthority for Authority {
        type Error = Infallible;

        async fn decide(
            &self,
            _viewer: &UserId,
            _target: &AgentId,
        ) -> Result<DirectPairInitiationDecision, Self::Error> {
            Ok(self.0.clone())
        }
    }

    #[tokio::test]
    async fn anti_enumeration_and_initiation_refusals_remain_distinct() {
        let viewer = user("user-1");
        let target = agent("agent-1");
        assert_eq!(
            authorize_direct_pair_initiation(
                &Authority(DirectPairInitiationDecision::NotFound),
                viewer.clone(),
                target.clone(),
            )
            .await
            .unwrap(),
            Err(DirectPairInitiationRefusal::NotFound)
        );
        assert_eq!(
            authorize_direct_pair_initiation(
                &Authority(DirectPairInitiationDecision::Forbidden),
                viewer,
                target,
            )
            .await
            .unwrap(),
            Err(DirectPairInitiationRefusal::Forbidden)
        );
    }

    #[tokio::test]
    async fn a_grant_is_bound_to_both_authenticated_request_coordinates() {
        let viewer = user("user-1");
        let target = agent("agent-1");
        let wrong_viewer = Authority(DirectPairInitiationDecision::Granted(
            DirectPairInitiationGrantFact::granted(user("user-2"), target.clone()),
        ));
        let wrong_target = Authority(DirectPairInitiationDecision::Granted(
            DirectPairInitiationGrantFact::granted(viewer.clone(), agent("agent-2")),
        ));
        assert!(matches!(
            authorize_direct_pair_initiation(&wrong_viewer, viewer.clone(), target.clone()).await,
            Err(DirectPairInitiationAuthorityError::ForeignGrant(_))
        ));
        assert!(matches!(
            authorize_direct_pair_initiation(&wrong_target, viewer.clone(), target.clone()).await,
            Err(DirectPairInitiationAuthorityError::ForeignGrant(_))
        ));

        let granted = authorize_direct_pair_initiation(
            &Authority(DirectPairInitiationDecision::Granted(
                DirectPairInitiationGrantFact::granted(viewer.clone(), target.clone()),
            )),
            viewer.clone(),
            target.clone(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(granted.viewer(), &viewer);
        assert_eq!(granted.target(), &target);
    }

    #[derive(Clone)]
    struct FixedClock;

    impl SendClock for FixedClock {
        fn now_unix_ms(&self) -> Result<i64, EnvironmentUnavailable> {
            Ok(42)
        }
    }

    struct FailingClock;

    #[derive(Debug, thiserror::Error)]
    #[error("clock boom")]
    struct ClockBoom;

    impl SendClock for FailingClock {
        fn now_unix_ms(&self) -> Result<i64, EnvironmentUnavailable> {
            Err(EnvironmentUnavailable::from_source(ClockBoom))
        }
    }

    struct Mint {
        created: bool,
        log: Arc<Mutex<Vec<&'static str>>>,
    }

    impl DirectPairMint for Mint {
        type Error = Infallible;

        async fn mint_direct_pair(
            &mut self,
            _participants: &DirectPairParticipants,
            now_unix_ms: i64,
        ) -> Result<DirectPairMinted, Self::Error> {
            assert_eq!(now_unix_ms, 42);
            self.log.lock().unwrap().push("mint");
            Ok(DirectPairMinted::committed(
                ConversationId::parse("pair-1").unwrap(),
                self.created,
            ))
        }
    }

    struct Opened {
        fail: bool,
        log: Arc<Mutex<Vec<&'static str>>>,
    }

    #[derive(Debug, thiserror::Error)]
    #[error("publication boom")]
    struct PublicationBoom;

    impl DirectPairOpenedPort for Opened {
        type Error = PublicationBoom;

        async fn direct_pair_opened(&self, fact: &DirectPairOpenedFact) -> Result<(), Self::Error> {
            assert_eq!(fact.conversation().as_str(), "pair-1");
            self.log.lock().unwrap().push("opened");
            if self.fail {
                Err(PublicationBoom)
            } else {
                Ok(())
            }
        }
    }

    fn authorized() -> AuthorizedDirectPairInitiation {
        AuthorizedDirectPairInitiation {
            viewer: user("user-1"),
            target: agent("agent-1"),
        }
    }

    #[derive(Debug, thiserror::Error)]
    #[error("send boom")]
    struct SendBoom;

    #[tokio::test]
    async fn only_the_mint_winner_publishes_but_both_paths_send() {
        for (created, expected) in [
            (true, vec!["mint", "opened", "send"]),
            (false, vec!["mint", "send"]),
        ] {
            let log = Arc::new(Mutex::new(Vec::new()));
            let mut mint = Mint {
                created,
                log: log.clone(),
            };
            let opened = Opened {
                fail: false,
                log: log.clone(),
            };
            let send_log = log.clone();
            let result = open_and_send_direct_pair(
                authorized(),
                &mut mint,
                &opened,
                &FixedClock,
                move |fact| async move {
                    assert_eq!(fact.viewer().as_str(), "user-1");
                    assert_eq!(fact.target().as_str(), "agent-1");
                    assert_eq!(fact.conversation().as_str(), "pair-1");
                    send_log.lock().unwrap().push("send");
                    Ok::<_, SendBoom>("ack")
                },
            )
            .await
            .unwrap();
            assert_eq!(result, "ack");
            assert_eq!(*log.lock().unwrap(), expected);
        }
    }

    #[tokio::test]
    async fn clock_failure_happens_before_mint_publication_or_send() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut mint = Mint {
            created: true,
            log: log.clone(),
        };
        let opened = Opened {
            fail: false,
            log: log.clone(),
        };
        let send_log = log.clone();
        let error = open_and_send_direct_pair(
            authorized(),
            &mut mint,
            &opened,
            &FailingClock,
            move |_| async move {
                send_log.lock().unwrap().push("send");
                Ok::<(), SendBoom>(())
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(error, DirectPairFirstSendError::Clock(_)));
        assert_eq!(
            error.source().unwrap().source().unwrap().to_string(),
            "clock boom"
        );
        assert!(log.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn send_failure_does_not_compensate_the_committed_announced_pair() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut mint = Mint {
            created: true,
            log: log.clone(),
        };
        let opened = Opened {
            fail: false,
            log: log.clone(),
        };
        let send_log = log.clone();
        let error = open_and_send_direct_pair(
            authorized(),
            &mut mint,
            &opened,
            &FixedClock,
            move |_| async move {
                send_log.lock().unwrap().push("send");
                Err::<(), _>(SendBoom)
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(error, DirectPairFirstSendError::Send(_)));
        assert_eq!(error.source().unwrap().to_string(), "send boom");
        assert_eq!(*log.lock().unwrap(), vec!["mint", "opened", "send"]);
    }

    #[tokio::test]
    async fn publication_failure_preserves_source_and_never_enters_send() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut mint = Mint {
            created: true,
            log: log.clone(),
        };
        let opened = Opened {
            fail: true,
            log: log.clone(),
        };
        let send_log = log.clone();
        let error = open_and_send_direct_pair(
            authorized(),
            &mut mint,
            &opened,
            &FixedClock,
            move |_| async move {
                send_log.lock().unwrap().push("send");
                Ok::<(), SendBoom>(())
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(error, DirectPairFirstSendError::Open(_)));
        assert_eq!(
            error.source().unwrap().source().unwrap().to_string(),
            "publication boom"
        );
        assert_eq!(*log.lock().unwrap(), vec!["mint", "opened"]);
    }
}
