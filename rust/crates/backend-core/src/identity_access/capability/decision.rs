//! The verdict every capability returns.

/// Exactly two arms. A capability either admits the caller or refuses with a
/// reason, and the reason type belongs to the capability that produced it: a
/// surface matching on it exhaustively can never be handed an arm that decision
/// does not have, which is what keeps a refusal from being flattened on its way
/// to the wire.
///
/// There is deliberately no third arm for "the facts could not be read". Fact
/// acquisition happens before any of this, in the caller's own `Result`, so an
/// unreadable row cannot become a product refusal.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Decision<R> {
    Allow,
    Denied(R),
}

impl<R> Decision<R> {
    pub fn is_allowed(&self) -> bool {
        matches!(self, Self::Allow)
    }

    pub fn denial(&self) -> Option<&R> {
        match self {
            Self::Allow => None,
            Self::Denied(reason) => Some(reason),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum Reason {
        Absent,
    }

    #[test]
    fn a_verdict_reads_as_its_own_arm() {
        let allowed: Decision<Reason> = Decision::Allow;
        assert!(allowed.is_allowed());
        assert_eq!(allowed.denial(), None);

        let denied = Decision::Denied(Reason::Absent);
        assert!(!denied.is_allowed());
        assert_eq!(denied.denial(), Some(&Reason::Absent));
    }
}
