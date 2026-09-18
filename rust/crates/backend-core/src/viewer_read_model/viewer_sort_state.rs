//! The viewer-sort write authority and its generalized read projection.
//!
//! Sidebar ordering is manual-only; channels and favorites retain recent/manual modes.
use std::collections::BTreeMap;

use crate::foundation::identity::UserId;
use crate::foundation::identity::WorkspaceId;
use crate::foundation::persistence::PersistenceFailure;
use std::future::Future;

/// The persisted `list_key`, parsed against the closed grammar the TS
/// `SortListKeySchema` refines: the two literals plus the `channels:` prefix.
///
/// The TS refinement only checks `startsWith('channels:')`, so `channels:` with an
/// EMPTY workspace suffix passes admission and is later a list `404` (the empty id
/// names no workspace). To match that wire exactly, the channels arm holds the raw
/// suffix string (which may be empty); the resolver maps an empty/unknown workspace
/// to `list not found`, never a stricter admission `422`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SortListKey {
    Sidebar,
    Favorites,
    Channels(String),
}

/// The `channels:` prefix, spelled once so parse and render cannot drift.
const CHANNELS_PREFIX: &str = "channels:";

impl SortListKey {
    /// Parse a wire `list_key`. Returns `None` only for a string outside the closed
    /// grammar (`sidebar`, `favorites`, or a `channels:`-prefixed key) — matching
    /// the TS `startsWith('channels:')` refinement, which admits `channels:` with an
    /// empty suffix (that becomes a list `404`, not an admission failure).
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "sidebar" => Some(Self::Sidebar),
            "favorites" => Some(Self::Favorites),
            other => other
                .strip_prefix(CHANNELS_PREFIX)
                .map(|suffix| Self::Channels(suffix.to_owned())),
        }
    }

    /// The exact stored/echoed `list_key` string.
    pub fn as_stored(&self) -> String {
        match self {
            Self::Sidebar => "sidebar".to_owned(),
            Self::Favorites => "favorites".to_owned(),
            Self::Channels(workspace) => format!("{CHANNELS_PREFIX}{workspace}"),
        }
    }
}

/// The ordering mode shared by active lists.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SortMode {
    Recent,
    Manual,
}

impl SortMode {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "recent" => Some(Self::Recent),
            "manual" => Some(Self::Manual),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Recent => "recent",
            Self::Manual => "manual",
        }
    }
}

/// A sort group — an independently toggleable `[recent|manual]` axis within a
/// list. The closed set is the union the TS `SortGroupSchema` enumerates; which
/// members are LEGAL for a given list is decided by [`SortListKey::legal_groups`].
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum SortGroup {
    Sidebar,
    Channels,
    Favorites,
}

impl SortGroup {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "sidebar" => Some(Self::Sidebar),
            "channels" => Some(Self::Channels),
            "favorites" => Some(Self::Favorites),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sidebar => "sidebar",
            Self::Channels => "channels",
            Self::Favorites => "favorites",
        }
    }
}

impl SortListKey {
    /// The groups that legally partition this list, mirroring the TS
    /// `legalGroups(listKey)`:
    ///   - `sidebar`         → `sidebar`
    ///   - `favorites`       → `favorites`
    ///   - `channels:<ws>`   → `channels`
    pub fn legal_groups(&self) -> &'static [SortGroup] {
        match self {
            Self::Sidebar => &[SortGroup::Sidebar],
            Self::Favorites => &[SortGroup::Favorites],
            Self::Channels(_) => &[SortGroup::Channels],
        }
    }

    /// Every active list uses the list-wide scope.
    pub fn mode_scope(&self) -> &'static str {
        ""
    }
}

/// One viewer-sort entry in the generalized projection, keyed by an OPAQUE
/// entity id. The workspace rail's entities are workspace ids; a channel list's
/// and the favorites list's are conversation ids. The projection carries the id
/// as a string because the wire DTO (`ViewerSortEntryDtoSchema.entity_id`) is an
/// opaque `z.string()`; typed parsing belongs to the caller that reads a single
/// list's live set.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ViewerSortEntryProjection {
    pub entity_id: String,
    pub rank: Option<i64>,
    pub last_accessed_at: Option<i64>,
    pub starred_at: Option<i64>,
}

/// The generalized `ViewerSortStateDto`: the list it describes, the per-scope
/// mode map (sparse — an absent scope is the renderer's `recent` default), and
/// the entries already filtered to the list's live visible set. Every sort
/// mutation echoes this so the renderer reconciles against authoritative state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ViewerSortStateProjection {
    pub list_key: SortListKey,
    pub modes: BTreeMap<String, SortMode>,
    pub entries: Vec<ViewerSortEntryProjection>,
}

/// The reorder completeness verdict, computed purely from the declared group's
/// live members and the requested `ordered_ids`. Mirrors the TS `sort.order`
/// route's two post-parse rules:
///   - every id is a live, non-starred member of the declared group, and
///   - the ids are exactly that group's live members (no dupes, no omissions).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReorderVerdict {
    /// Every id belongs to the group and the set is exactly the live members.
    Accepted,
    /// An id is not a live member of the declared group (or is starred). Carries
    /// the offending id, matching the TS `{ error, id }` body.
    IdNotInGroup { id: String },
    /// The ids are not exactly the group's live members (duplicate or wrong
    /// count). Carries the expected count, matching the TS `{ error,
    /// expected_count }` body.
    NotExactMembers { expected_count: usize },
}

/// Decide a reorder against the declared group's live member set.
///
/// `live_group_ids` is the ordered live-and-visible member set of the declared
/// group EXCLUDING starred entities (the TS `liveGroupIds`); `ordered_ids` is the
/// requested new order. The rule order matches the reference: per-id membership
/// first (returning the first offending id), then whole-group completeness.
pub fn decide_reorder(live_group_ids: &[String], ordered_ids: &[String]) -> ReorderVerdict {
    use std::collections::HashSet;
    let live: HashSet<&str> = live_group_ids.iter().map(String::as_str).collect();
    for id in ordered_ids {
        if !live.contains(id.as_str()) {
            return ReorderVerdict::IdNotInGroup { id: id.clone() };
        }
    }
    let unique: HashSet<&str> = ordered_ids.iter().map(String::as_str).collect();
    if unique.len() != ordered_ids.len() || ordered_ids.len() != live_group_ids.len() {
        return ReorderVerdict::NotExactMembers {
            expected_count: live_group_ids.len(),
        };
    }
    ReorderVerdict::Accepted
}

/// The favorites-list sort identity for a starred conversation, mirroring the TS
/// `favoriteKey(id) = "conversation:<id>"`. It is the `user_sort_entry.entity_id`
/// under `list_key = 'favorites'` (distinct from the conversation's HOME-list
/// entity id, which is the bare conversation id) and the favorites row's stable
/// drag/sort key. Unstar drops exactly this favorites orphan.
pub fn favorite_key(conversation_id: &str) -> String {
    format!("conversation:{conversation_id}")
}

/// The resolved membership of a list the viewer named: each visible live entity
/// mapped to its group, plus the star-exclusion set (the live starred members
/// that have MOVED to the global favorites list and so are excluded from a
/// channel-list reorder). Mirrors the reference `resolveListGroups` `{ groups,
/// starred }` result.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ResolvedListGroups {
    pub groups: BTreeMap<String, SortGroup>,
    pub starred: std::collections::HashSet<String>,
}

/// Why `resolveListGroups` refused: the list's workspace does not exist (404) or
/// the viewer cannot view it (403). The `sidebar` and `favorites` lists never
/// refuse (they are the viewer's own state); only `channels:<ws>` can.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ListGroupsRefusal {
    NotFound,
    Forbidden,
}
/// The requested sort mutation, in domain vocabulary — the intent a route hands to
/// the ONE transactional writer. The writer re-resolves the list's live membership
/// UNDER the write lock, applies the rule, writes, and reads back the committed
/// post-image, so no decision fact is a stale pre-lock witness.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SortMutation {
    /// `POST /api/sort/touch` — stamp recent-opened on `entity_id` (must be a live
    /// member of the list; `favorites` list is rejected before the writer).
    Touch { entity_id: String },
    /// `PUT /api/sort/mode` — set the `scope`'s mode. `group` is already validated
    /// against the list; the writer derives the scope.
    SetMode {
        group: Option<SortGroup>,
        mode: SortMode,
    },
    /// `PUT /api/sort/order` — rewrite `group`'s dense ranks (⇒ manual). The writer
    /// re-derives the live group set and re-checks completeness under the lock.
    Reorder {
        group: SortGroup,
        ordered_ids: Vec<String>,
    },
    /// `POST`/`DELETE /api/channels/{id}/star` — toggle the star on `entity_id`
    /// (a channel-home conversation; the list is `channels:<ws>`).
    SetStarred { entity_id: String, starred: bool },
}

/// Why a transactional sort mutation refused, decided UNDER the write lock. Maps to
/// the reference statuses at the route: list-not-found (404 / channels), forbidden
/// (403 / channels), and the product 400s (favorites-not-touchable, unknown entity,
/// group mismatch, reorder id-not-in-group / not-exact-members).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SortMutationRefusal {
    ReorderOnly,
    SidebarSetChanged,
    /// The list's workspace does not exist (channels list) — 404 `list not found`
    /// (touch/mode/order) or 404 `not found` (star).
    ListNotFound,
    /// The viewer cannot view the list's workspace — 403 `forbidden`.
    Forbidden,
    /// `favorites` does not support touch — 400.
    FavoritesNotTouchable,
    /// `entity_id` is not a live member of the list — 400 `unknown entity_id`
    /// (touch) / 404 `not found` (star).
    UnknownEntity,
    /// `group` was supplied for a list-wide list (favorites/channels) — 400 `group
    /// is not supported for this list (list-wide mode)`, echoing the group.
    GroupNotSupportedForList {
        group: Option<SortGroup>,
    },
    /// A reorder named a group not valid for the list — 400 `group is not valid for
    /// this list`, echoing the group.
    GroupNotValidForList {
        group: Option<SortGroup>,
    },
    /// A reorder id is not a live member of the declared group — 400, carrying it.
    IdNotInGroup {
        id: String,
    },
    /// The reorder ids are not exactly the group's live members — 400, count.
    NotExactMembers {
        expected_count: usize,
    },
}

/// The one transactional sort-mutation authority: a single connection-bound writer
/// transaction that (1) samples the clock once, (2) re-resolves the list's live
/// existence / visibility / membership / group / star-exclusion under the lock,
/// (3) applies the domain rule (refusing without writing on any failure), (4)
/// writes, and (5) reads back the committed `viewer_sort` post-image. The route is
/// thin over this — it owns only body admission and refusal-order hints, never a
/// pre-lock authority witness.
pub trait ViewerSortMutationWriter {
    fn apply_sort_mutation(
        &self,
        viewer: &UserId,
        list_key: &SortListKey,
        mutation: &SortMutation,
    ) -> impl Future<
        Output = Result<Result<ViewerSortStateProjection, SortMutationRefusal>, PersistenceFailure>,
    > + Send;
}

/// A channel-like conversation's home coordinate, as the star routes read it
/// before resolving the `channels:<ws>` list — mirroring the TS
/// `conversations.getChannelLike(id)` at the top of the star handler. A
/// workspace-placed conversation carries its parent workspace; a direct pair or
/// a missing row is not a star target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelHome {
    pub conversation: crate::foundation::identity::ConversationId,
    pub workspace: WorkspaceId,
}

/// The three-valued channel-home verdict: the star target's existence
/// fact must be preserved, NOT null-collapsed. TS `getChannelLike(id)` passes for a
/// real `direct_pair` (which then forms `channels:null` and `resolveListGroups`
/// returns `not found`), whereas a truly missing id is `channel not found`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChannelHomeVerdict {
    /// A workspace-placed conversation carrying a parent workspace — the star target.
    WorkspacePlaced(ChannelHome),
    /// A conversation that EXISTS but is workspace-less (a direct pair) — passes the
    /// existence gate but cannot resolve a channels list → the reference `not found`.
    WorkspaceLessExisting,
}

/// Reads a channel-like conversation's home verdict, or `None` when the id names NO
/// conversation at all (the reference `404 channel not found`). A workspace-less
/// existing conversation returns `WorkspaceLessExisting` (rendered `404 not found`),
/// distinct from missing — the existence fact must not be null-collapsed (#39).
pub trait ChannelHomeReadPort {
    fn channel_home(
        &self,
        conversation_id: &str,
    ) -> impl Future<Output = Result<Option<ChannelHomeVerdict>, PersistenceFailure>> + Send;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_key_parses_the_closed_grammar_and_rejects_the_rest() {
        assert_eq!(SortListKey::parse("workspaces"), None);
        assert_eq!(
            SortListKey::parse("favorites"),
            Some(SortListKey::Favorites)
        );
        assert_eq!(
            SortListKey::parse("channels:ws-1"),
            Some(SortListKey::Channels("ws-1".to_owned()))
        );
        // `channels:` with an EMPTY suffix passes admission (TS only checks the
        // prefix); it becomes a list `404` at resolve, never an admission failure.
        assert_eq!(
            SortListKey::parse("channels:"),
            Some(SortListKey::Channels(String::new()))
        );
        assert_eq!(SortListKey::parse("channel:ws-1"), None);
        assert_eq!(SortListKey::parse(""), None);
        assert_eq!(SortListKey::parse("anything"), None);
    }

    #[test]
    fn list_key_round_trips_through_stored_form() {
        for raw in ["sidebar", "favorites", "channels:ws-42"] {
            let parsed = SortListKey::parse(raw).unwrap();
            assert_eq!(parsed.as_stored(), raw);
            assert_eq!(SortListKey::parse(&parsed.as_stored()), Some(parsed));
        }
    }

    #[test]
    fn legal_groups_partition_each_list() {
        assert_eq!(SortListKey::Sidebar.legal_groups(), &[SortGroup::Sidebar]);
        assert_eq!(
            SortListKey::Favorites.legal_groups(),
            &[SortGroup::Favorites]
        );
        assert_eq!(
            SortListKey::Channels("ws-1".to_owned()).legal_groups(),
            &[SortGroup::Channels]
        );
    }

    #[test]
    fn mode_scope_is_always_list_wide() {
        for list in [
            SortListKey::Sidebar,
            SortListKey::Favorites,
            SortListKey::Channels("ws-1".to_owned()),
        ] {
            assert_eq!(list.mode_scope(), "");
        }
    }

    #[test]
    fn reorder_accepts_an_exact_permutation_of_the_live_members() {
        let live = vec!["a".to_owned(), "b".to_owned(), "c".to_owned()];
        assert_eq!(
            decide_reorder(&live, &["c".to_owned(), "a".to_owned(), "b".to_owned()]),
            ReorderVerdict::Accepted
        );
    }

    #[test]
    fn reorder_rejects_an_id_outside_the_group_first() {
        let live = vec!["a".to_owned(), "b".to_owned()];
        assert_eq!(
            decide_reorder(&live, &["a".to_owned(), "x".to_owned()]),
            ReorderVerdict::IdNotInGroup { id: "x".to_owned() }
        );
    }

    #[test]
    fn reorder_rejects_a_duplicate_or_incomplete_set() {
        let live = vec!["a".to_owned(), "b".to_owned()];
        // A duplicate: `a` is a live member so the per-id loop passes, but the
        // completeness rule catches the wrong count.
        assert_eq!(
            decide_reorder(&live, &["a".to_owned(), "a".to_owned()]),
            ReorderVerdict::NotExactMembers { expected_count: 2 }
        );
        // An omission: fewer ids than live members.
        assert_eq!(
            decide_reorder(&live, &["a".to_owned()]),
            ReorderVerdict::NotExactMembers { expected_count: 2 }
        );
    }

    #[test]
    fn favorite_key_prefixes_the_conversation_id() {
        assert_eq!(favorite_key("conv-1"), "conversation:conv-1");
    }
}

/// Read the complete, authorized, server-ordered sidebar in one snapshot.
pub trait ViewerSidebarRead {
    fn sidebar_sort(
        &self,
        viewer: &UserId,
    ) -> impl Future<Output = Result<ViewerSortStateProjection, PersistenceFailure>> + Send;
}
