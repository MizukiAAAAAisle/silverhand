//! Conversation-scoped committed agent roster.
//!
//! Runtime custody is deliberately absent.  This face answers which agent
//! membership facts are committed for one conversation; callers that need live
//! process state join the independent runtime projection at presentation time.

use std::{error::Error, future::Future};

use crate::identity::{AgentId, ConversationId, UserId};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct JoinedAt(i64);

impl JoinedAt {
    const MAX_JAVASCRIPT_INTEGER: i64 = 9_007_199_254_740_991;

    pub fn new(value: i64) -> Result<Self, InvalidJoinedAt> {
        if !(0..=Self::MAX_JAVASCRIPT_INTEGER).contains(&value) {
            return Err(InvalidJoinedAt);
        }
        Ok(Self(value))
    }

    pub const fn get(self) -> i64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("agent membership joined_at must be nonnegative and exact on the JavaScript wire")]
pub struct InvalidJoinedAt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversationAgentMember {
    conversation: ConversationId,
    agent: AgentId,
    joined_at: JoinedAt,
}

impl ConversationAgentMember {
    pub fn projected(conversation: ConversationId, agent: AgentId, joined_at: JoinedAt) -> Self {
        Self {
            conversation,
            agent,
            joined_at,
        }
    }

    pub fn agent(&self) -> &AgentId {
        &self.agent
    }

    pub const fn joined_at(&self) -> JoinedAt {
        self.joined_at
    }
}

/// An unbound roster fact returned by a read port.
///
/// The coordinate remains on the fact until the consumer binds it to the
/// authenticated request.  Removing it would make an A-request/B-result splice
/// impossible to detect at the public port boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversationAgentDirectory {
    conversation: ConversationId,
    members: Vec<ConversationAgentMember>,
}

impl ConversationAgentDirectory {
    pub fn projected(
        conversation: ConversationId,
        members: Vec<ConversationAgentMember>,
    ) -> Result<Self, MalformedAgentDirectory> {
        if !members
            .windows(2)
            .all(|pair| member_key(&pair[0]) < member_key(&pair[1]))
        {
            return Err(MalformedAgentDirectory);
        }
        Ok(Self {
            conversation,
            members,
        })
    }

    pub fn bind(
        self,
        requested: &ConversationId,
    ) -> Result<BoundConversationAgentDirectory, ConversationAgentDirectoryIdentityMismatch> {
        if &self.conversation != requested
            || self
                .members
                .iter()
                .any(|member| &member.conversation != requested)
        {
            return Err(ConversationAgentDirectoryIdentityMismatch);
        }
        Ok(BoundConversationAgentDirectory(self))
    }
}

fn member_key(member: &ConversationAgentMember) -> (JoinedAt, &str) {
    (member.joined_at, member.agent.as_str())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundConversationAgentDirectory(ConversationAgentDirectory);

impl BoundConversationAgentDirectory {
    pub fn conversation(&self) -> &ConversationId {
        &self.0.conversation
    }

    pub fn members(&self) -> &[ConversationAgentMember] {
        &self.0.members
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("conversation-agent directory rows are not in unique total order")]
pub struct MalformedAgentDirectory;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("conversation-agent directory identity differs from the requested conversation")]
pub struct ConversationAgentDirectoryIdentityMismatch;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ConversationAgentDirectoryRefusal {
    #[error("conversation not found")]
    NotFound,
    #[error("viewer cannot read conversation agent roster")]
    Forbidden,
}

pub trait ConversationAgentDirectoryReadPort {
    type Error: Error + Send + Sync + 'static;

    fn read(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
    ) -> impl Future<
        Output = Result<
            Result<ConversationAgentDirectory, ConversationAgentDirectoryRefusal>,
            Self::Error,
        >,
    > + Send;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(agent: &str, joined_at: i64) -> ConversationAgentMember {
        ConversationAgentMember::projected(
            ConversationId::parse("c").unwrap(),
            AgentId::parse(agent).unwrap(),
            JoinedAt::new(joined_at).unwrap(),
        )
    }

    #[test]
    fn directory_is_totally_ordered_and_identity_bound() {
        let value = ConversationAgentDirectory::projected(
            ConversationId::parse("c").unwrap(),
            vec![member("a", 1), member("b", 1), member("c", 2)],
        )
        .unwrap();
        assert!(
            value
                .clone()
                .bind(&ConversationId::parse("other").unwrap())
                .is_err()
        );
        let bound = value.bind(&ConversationId::parse("c").unwrap()).unwrap();
        assert_eq!(bound.conversation().as_str(), "c");
        assert_eq!(
            bound
                .members()
                .iter()
                .map(|member| member.agent().as_str())
                .collect::<Vec<_>>(),
            ["a", "b", "c"]
        );

        let spliced = ConversationAgentDirectory::projected(
            ConversationId::parse("c").unwrap(),
            vec![ConversationAgentMember::projected(
                ConversationId::parse("other").unwrap(),
                AgentId::parse("a").unwrap(),
                JoinedAt::new(1).unwrap(),
            )],
        )
        .unwrap();
        assert!(spliced.bind(&ConversationId::parse("c").unwrap()).is_err());

        assert!(
            ConversationAgentDirectory::projected(
                ConversationId::parse("c").unwrap(),
                vec![member("b", 1), member("a", 1)],
            )
            .is_err()
        );
        assert!(
            ConversationAgentDirectory::projected(
                ConversationId::parse("c").unwrap(),
                vec![member("a", 1), member("a", 1)],
            )
            .is_err()
        );
    }

    #[test]
    fn joined_at_rejects_values_a_correct_writer_cannot_mint() {
        assert!(JoinedAt::new(-1).is_err());
        assert_eq!(JoinedAt::new(0).unwrap().get(), 0);
        assert_eq!(
            JoinedAt::new(JoinedAt::MAX_JAVASCRIPT_INTEGER)
                .unwrap()
                .get(),
            JoinedAt::MAX_JAVASCRIPT_INTEGER
        );
        assert!(JoinedAt::new(JoinedAt::MAX_JAVASCRIPT_INTEGER + 1).is_err());
    }
}
