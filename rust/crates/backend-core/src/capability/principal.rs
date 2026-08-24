//! Who is asking.
//!
//! Three arms because the product has three callers with different authority:
//! a human session, an agent's own runtime acting as itself, and the system
//! acting from inside (migrations, internal hosts) where no ACL applies.
//!
//! The arms carry only the identity each rule reads. `System` carries none: a
//! rule that admits it never looks further.

use crate::identity::{AgentId, UserId};

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
