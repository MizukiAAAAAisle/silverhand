//! Opening a direct pair as one application operation.

use std::{error::Error, future::Future};

use super::{ConversationId, PrincipalIdentity, PrincipalKind};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectPairParticipants {
    first: PrincipalIdentity,
    second: PrincipalIdentity,
}

impl DirectPairParticipants {
    pub fn between(
        left: PrincipalIdentity,
        right: PrincipalIdentity,
    ) -> Result<Self, SameDirectPairParticipant> {
        if left == right {
            return Err(SameDirectPairParticipant);
        }
        let (first, second) = if principal_key(&left) <= principal_key(&right) {
            (left, right)
        } else {
            (right, left)
        };
        Ok(Self { first, second })
    }

    pub fn first(&self) -> &PrincipalIdentity {
        &self.first
    }

    pub fn second(&self) -> &PrincipalIdentity {
        &self.second
    }

    pub fn both(&self) -> [&PrincipalIdentity; 2] {
        [&self.first, &self.second]
    }
}

fn principal_key(principal: &PrincipalIdentity) -> (u8, &str) {
    let rank = match principal.kind() {
        PrincipalKind::Agent => 0,
        PrincipalKind::Human => 1,
    };
    (rank, principal.as_str())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("a direct pair needs two distinct participants")]
pub struct SameDirectPairParticipant;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectPairOpenedFact {
    conversation: ConversationId,
    participants: DirectPairParticipants,
}

impl DirectPairOpenedFact {
    pub(super) fn committed(
        conversation: ConversationId,
        participants: DirectPairParticipants,
    ) -> Self {
        Self {
            conversation,
            participants,
        }
    }

    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }

    pub fn participants(&self) -> &DirectPairParticipants {
        &self.participants
    }
}

pub struct DirectPairMinted {
    conversation: ConversationId,
    created: bool,
}

impl DirectPairMinted {
    pub fn committed(conversation: ConversationId, created: bool) -> Self {
        Self {
            conversation,
            created,
        }
    }
}

pub trait DirectPairMint {
    type Error: Error + Send + Sync + 'static;

    fn mint_direct_pair(
        &mut self,
        participants: &DirectPairParticipants,
        now_unix_ms: i64,
    ) -> impl Future<Output = Result<DirectPairMinted, Self::Error>> + Send;
}

pub trait DirectPairOpenedPort: Send + Sync {
    type Error: Error + Send + Sync + 'static;

    fn direct_pair_opened(
        &self,
        fact: &DirectPairOpenedFact,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send;
}

pub async fn open_direct_pair<M, O>(
    mint: &mut M,
    opened: &O,
    participants: DirectPairParticipants,
    now_unix_ms: i64,
) -> Result<ConversationId, OpenDirectPairError<M::Error, O::Error>>
where
    M: DirectPairMint,
    O: DirectPairOpenedPort,
{
    let minted = mint
        .mint_direct_pair(&participants, now_unix_ms)
        .await
        .map_err(OpenDirectPairError::Mint)?;
    if minted.created {
        opened
            .direct_pair_opened(&DirectPairOpenedFact::committed(
                minted.conversation.clone(),
                participants,
            ))
            .await
            .map_err(OpenDirectPairError::Announcement)?;
    }
    Ok(minted.conversation)
}

#[derive(Debug, thiserror::Error)]
pub enum OpenDirectPairError<M, O>
where
    M: Error + Send + Sync + 'static,
    O: Error + Send + Sync + 'static,
{
    #[error("direct-pair mint failed")]
    Mint(#[source] M),
    #[error("direct-pair opened announcement failed")]
    Announcement(#[source] O),
}

#[cfg(test)]
mod tests {
    use std::{convert::Infallible, sync::Mutex};

    use crate::identity::{AgentId, UserId};

    use super::*;

    struct Mint {
        created: bool,
    }

    impl DirectPairMint for Mint {
        type Error = Infallible;

        async fn mint_direct_pair(
            &mut self,
            _participants: &DirectPairParticipants,
            _now_unix_ms: i64,
        ) -> Result<DirectPairMinted, Self::Error> {
            Ok(DirectPairMinted::committed(
                ConversationId::parse("pair-1").unwrap(),
                self.created,
            ))
        }
    }

    #[derive(Default)]
    struct Opened(Mutex<Vec<DirectPairOpenedFact>>);

    impl DirectPairOpenedPort for Opened {
        type Error = Infallible;

        async fn direct_pair_opened(&self, fact: &DirectPairOpenedFact) -> Result<(), Self::Error> {
            self.0.lock().unwrap().push(fact.clone());
            Ok(())
        }
    }

    fn participants() -> DirectPairParticipants {
        DirectPairParticipants::between(
            PrincipalIdentity::Human(UserId::parse("user-1").unwrap()),
            PrincipalIdentity::Agent(AgentId::parse("agent-1").unwrap()),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn only_the_insert_winner_announces_the_opened_fact() {
        let opened = Opened::default();
        let mut winner = Mint { created: true };
        let mut existing = Mint { created: false };
        open_direct_pair(&mut winner, &opened, participants(), 1)
            .await
            .unwrap();
        open_direct_pair(&mut existing, &opened, participants(), 2)
            .await
            .unwrap();
        let facts = opened.0.lock().unwrap();
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].conversation().as_str(), "pair-1");
        assert_eq!(facts[0].participants(), &participants());
    }
}
