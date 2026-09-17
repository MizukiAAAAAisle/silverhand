//! Identity discovery is counted and bounded only after visibility admission.
use super::*;
use crate::{
    conversation_messaging::messaging::AvatarRevision,
    identity_access::agents::runtime::RuntimeKind,
};

pub const IDENTITY_CATEGORY_LIMIT: usize = 20;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchIdentity {
    pub identity: PrincipalIdentity,
    pub name: String,
    pub display_name: String,
    pub avatar: Option<AvatarRevision>,
    pub runtime: Option<RuntimeKind>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IdentitySearchStatus {
    Searched,
    Filtered,
    EmptyQuery,
}

impl HumanSearchQuery {
    pub fn identity_search_status(&self) -> IdentitySearchStatus {
        if self.workspace().is_some()
            || self.conversation().is_some()
            || self.sender().is_some()
            || self.from().is_some()
            || self.to().is_some()
        {
            IdentitySearchStatus::Filtered
        } else if self.identity_needle().is_empty() {
            IdentitySearchStatus::EmptyQuery
        } else {
            IdentitySearchStatus::Searched
        }
    }

    fn identity_needle(&self) -> String {
        self.text()
            .as_str()
            .strip_prefix('@')
            .unwrap_or(self.text().as_str())
            .to_lowercase()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IdentitySearchCategory {
    results: Vec<SearchIdentity>,
    total: usize,
}

impl IdentitySearchCategory {
    pub fn results(&self) -> &[SearchIdentity] {
        &self.results
    }
    pub fn total(&self) -> usize {
        self.total
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IdentitySearchGroups {
    source_viewer: UserId,
    query: HumanSearchQuery,
    status: IdentitySearchStatus,
    humans: IdentitySearchCategory,
    agents: IdentitySearchCategory,
}

impl IdentitySearchGroups {
    pub fn status(&self) -> IdentitySearchStatus {
        self.status
    }
    pub fn humans(&self) -> &IdentitySearchCategory {
        &self.humans
    }
    pub fn agents(&self) -> &IdentitySearchCategory {
        &self.agents
    }

    /// The adapter supplies only current ACL-admitted, active, agent-scoped agents.
    /// Matching, deterministic order and counts are shared by both identity kinds.
    pub fn from_visible(
        viewer: UserId,
        query: HumanSearchQuery,
        candidates: Vec<SearchIdentity>,
    ) -> Result<Self, HumanSearchCorruption> {
        let status = query.identity_search_status();
        if !query.include_identities()
            || (status != IdentitySearchStatus::Searched && !candidates.is_empty())
        {
            return Err(HumanSearchCorruption::ResultSet);
        }
        let needle = query.identity_needle();
        let mut humans = Vec::new();
        let mut agents = Vec::new();
        let mut seen = HashSet::new();
        for row in candidates {
            if row.name.is_empty() || row.display_name.is_empty() {
                return Err(HumanSearchCorruption::ResultSet);
            }
            let (kind, rows) = match &row.identity {
                PrincipalIdentity::Human(id) => {
                    if row.runtime.is_some() {
                        return Err(HumanSearchCorruption::ResultSet);
                    }
                    if id == &viewer {
                        continue;
                    }
                    ("human", &mut humans)
                }
                PrincipalIdentity::Agent(_) => {
                    if row.runtime.is_none() {
                        return Err(HumanSearchCorruption::ResultSet);
                    }
                    ("agent", &mut agents)
                }
            };
            if !seen.insert((kind, row.identity.as_str().to_owned())) {
                return Err(HumanSearchCorruption::ResultSet);
            }
            if row.name.to_lowercase().contains(&needle)
                || row.display_name.to_lowercase().contains(&needle)
            {
                rows.push(row);
            }
        }
        fn category(mut rows: Vec<SearchIdentity>) -> IdentitySearchCategory {
            rows.sort_by_cached_key(|row| {
                (
                    row.display_name.to_lowercase(),
                    row.name.to_lowercase(),
                    row.identity.as_str().to_owned(),
                )
            });
            let total = rows.len();
            rows.truncate(IDENTITY_CATEGORY_LIMIT);
            IdentitySearchCategory {
                results: rows,
                total,
            }
        }
        Ok(Self {
            source_viewer: viewer,
            query,
            status,
            humans: category(humans),
            agents: category(agents),
        })
    }

    pub(super) fn matches(&self, viewer: &UserId, query: &HumanSearchQuery) -> bool {
        &self.source_viewer == viewer && &self.query == query
    }
}
