//! Identities shared across application capabilities.

use thiserror::Error;

macro_rules! opaque_identity {
    ($name:ident, $error:ident, $label:literal) => {
        #[derive(Clone, Debug, Eq, Hash, PartialEq)]
        pub struct $name(String);

        impl $name {
            pub fn parse(raw: impl Into<String>) -> Result<Self, $error> {
                let raw = raw.into();
                if raw.is_empty() {
                    return Err($error);
                }
                Ok(Self(raw))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_inner(self) -> String {
                self.0
            }
        }

        #[derive(Debug, Error)]
        #[error($label)]
        pub struct $error;
    };
}

/// The one user identity used by authentication and every product module.
///
/// User ids are opaque coordinates. The system has historically minted more
/// than one shape, so the stable invariant at a read boundary is only that the
/// coordinate is not empty.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct UserId(String);

impl UserId {
    pub fn parse(raw: impl Into<String>) -> Result<Self, EmptyUserId> {
        let raw = raw.into();
        if raw.is_empty() {
            return Err(EmptyUserId);
        }
        Ok(Self(raw))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }
}

#[derive(Debug, Error)]
#[error("user id must not be empty")]
pub struct EmptyUserId;

opaque_identity!(AgentId, EmptyAgentId, "agent id must not be empty");
opaque_identity!(
    WorkspaceId,
    EmptyWorkspaceId,
    "workspace id must not be empty"
);
opaque_identity!(
    ConversationId,
    EmptyConversationId,
    "conversation id must not be empty"
);
opaque_identity!(
    DaemonInstanceId,
    EmptyDaemonInstanceId,
    "daemon instance id must not be empty"
);
opaque_identity!(HostId, EmptyHostId, "host id must not be empty");

/// Who is asking. The one application principal, shared by every capability that
/// decides on authority — enrollment, governance and the agent surfaces all read
/// the same three arms, so a second definition would be a second vocabulary for
/// one concept.
///
/// Three arms because the product has three callers with different authority: a
/// human session, an agent's own runtime acting as itself, and the system acting
/// from inside (migrations, internal hosts) where no ACL applies. Each arm
/// carries only the identity a rule reads; `System` carries none, because a rule
/// that admits it never looks further.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Principal {
    System,
    Human { user_id: UserId },
    Agent { agent_id: AgentId },
}

impl Principal {
    pub fn human(user_id: UserId) -> Self {
        Self::Human { user_id }
    }

    pub fn agent(agent_id: AgentId) -> Self {
        Self::Agent { agent_id }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_id_is_opaque_but_never_empty() {
        assert!(UserId::parse("").is_err());
        let user = UserId::parse("legacy:user/1").unwrap();
        assert_eq!(user.as_str(), "legacy:user/1");
        assert_eq!(user.into_inner(), "legacy:user/1");
    }

    #[test]
    fn runtime_coordinates_share_the_same_nonempty_identity_rule() {
        assert!(AgentId::parse("").is_err());
        assert!(WorkspaceId::parse("").is_err());
        assert!(ConversationId::parse("").is_err());
        assert!(DaemonInstanceId::parse("").is_err());

        assert_eq!(AgentId::parse("agent-1").unwrap().as_str(), "agent-1");
        assert_eq!(
            WorkspaceId::parse("workspace-1").unwrap().as_str(),
            "workspace-1"
        );
        assert_eq!(
            ConversationId::parse("conversation-1").unwrap().as_str(),
            "conversation-1"
        );
        assert_eq!(
            DaemonInstanceId::parse("daemon-1").unwrap().as_str(),
            "daemon-1"
        );
    }
}
