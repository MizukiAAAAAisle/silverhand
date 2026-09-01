//! The human governance ROLE AXIS, as a pure rule.
//!
//! `owner ⊇ admin ⊇ member`: a higher role can do everything a lower one can,
//! and callers pass the MINIMUM role an operation requires. This axis is
//! deliberately separate from the agent [`Capability`](super::Capability) axis —
//! workspace roles never reference agent capabilities and vice versa.
//!
//! The rank lives here as a single home so the pre-lock request-boundary gate
//! (the workspace-governance context) and the in-lock re-derivation on the write
//! path cannot drift: both consult [`role_governs_workspace`] over the same
//! ordering, exactly as the TypeScript `roleGovernsWorkspace` / `workspaceRole`
//! pair does.

/// A human's governance role in a workspace. The set is closed and mirrors the
/// persisted `CHECK (role IN ('owner','admin','member'))`; an unknown role is
/// not expressible.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum WorkspaceRole {
    Owner,
    Admin,
    Member,
}

impl WorkspaceRole {
    /// The stable token this role persists as. Adapters write and read exactly
    /// these strings; nothing else may invent role text.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Admin => "admin",
            Self::Member => "member",
        }
    }

    /// Parse a persisted role token, or `None` for an unrecognized value. The
    /// database `CHECK` constraint guarantees a committed row is one of these, so
    /// an adapter treats `None` as a persistence-integrity failure rather than a
    /// silent default.
    pub fn parse(token: &str) -> Option<Self> {
        match token {
            "owner" => Some(Self::Owner),
            "admin" => Some(Self::Admin),
            "member" => Some(Self::Member),
            _ => None,
        }
    }

    /// Rank on the governance axis; a higher number outranks a lower one.
    fn rank(self) -> u8 {
        match self {
            Self::Member => 0,
            Self::Admin => 1,
            Self::Owner => 2,
        }
    }

    /// Does this role satisfy an operation whose floor is `min_role`?
    pub fn meets_floor(self, min_role: WorkspaceRole) -> bool {
        self.rank() >= min_role.rank()
    }
}

/// The governance predicate: may the holder of this role write the things that
/// require `admin` governance (adding to the workspace's PEOPLE roster, among
/// them)? A `None` role is not workspace membership at all, so it fails this and
/// every floor built on it — stated once so the pre-lock gate and the in-lock
/// re-derivation cannot disagree.
pub fn role_governs_workspace(role: Option<WorkspaceRole>) -> bool {
    matches!(role, Some(role) if role.meets_floor(WorkspaceRole::Admin))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_round_trip_through_parse() {
        for role in [
            WorkspaceRole::Owner,
            WorkspaceRole::Admin,
            WorkspaceRole::Member,
        ] {
            assert_eq!(WorkspaceRole::parse(role.as_str()), Some(role));
        }
        assert_eq!(WorkspaceRole::parse("editor"), None);
    }

    #[test]
    fn the_member_floor_admits_every_role() {
        for role in [
            WorkspaceRole::Owner,
            WorkspaceRole::Admin,
            WorkspaceRole::Member,
        ] {
            assert!(role.meets_floor(WorkspaceRole::Member));
        }
    }

    #[test]
    fn only_owner_and_admin_govern_the_workspace() {
        assert!(role_governs_workspace(Some(WorkspaceRole::Owner)));
        assert!(role_governs_workspace(Some(WorkspaceRole::Admin)));
        assert!(!role_governs_workspace(Some(WorkspaceRole::Member)));
        assert!(
            !role_governs_workspace(None),
            "a non-member never governs the workspace"
        );
    }
}
