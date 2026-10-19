//! The favorites read model — the global list of the viewer's starred
//! conversations, with the favorites ordering state carried inline.
//!
//! Membership is the single source of truth: a conversation is a favorite iff a
//! `starred_at` row exists on its HOME list (`channels:<workspace_id>`) AND the
//! viewer can still see the (non-archived) conversation in a non-archived
//! workspace; a direct pair is a favorite iff the viewer is its human endpoint
//! and its `direct_pairs` home row is starred. The favorites list stores ONLY its
//! own ordering (`list_key = 'favorites'` rank/mode) — never membership — so the
//! projected item set and the reorder-validation set can never diverge.
//!
//! The row projection carries the disambiguating parent label as TEXT (workspace
//! name, or the bound agent's display name / handle for an agent home), the
//! stored visibility, the star/created timestamps, and the per-conversation
//! unread rollup drawn from the ONE canonical unread predicate.

use std::future::Future;

use crate::{
    conversation_messaging::direct_pair_read::DirectPairCounterpart,
    conversation_messaging::messaging::collaboration::channel_directory::DirectoryRoster,
    foundation::identity::{ConversationId, UserId, WorkspaceId},
    foundation::persistence::PersistenceFailure,
    viewer_read_model::viewer_sort_state::ViewerSortStateProjection,
};

/// The stored visibility a favorite row carries, so a starred row draws the same
/// glyph its in-tree row does. Mirrors `ConversationVisibilitySchema`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FavoriteVisibility {
    Private,
    Public,
}

impl FavoriteVisibility {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "private" => Some(Self::Private),
            "public" => Some(Self::Public),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Private => "private",
            Self::Public => "public",
        }
    }
}

/// One projected favorite row (`FavoriteRowDto`). `favorite_key` is the favorites
/// sort identity (`conversation:<entity_id>`); `entity_id` is the conversation's
/// own id (its home-list key + the star/navigation target). `parent_title` is the
/// text disambiguator, always populated.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FavoriteRow {
    pub roster_policy: DirectoryRoster,
    pub favorite_key: String,
    pub entity_id: ConversationId,
    pub workspace_id: WorkspaceId,
    pub title: String,
    pub parent_title: String,
    pub starred_at: i64,
    pub created_at: i64,
    pub unread_count: i64,
    pub visibility: FavoriteVisibility,
}

/// One starred direct pair. It shares `favorite_key` and the favorites ordering
/// with [`FavoriteRow`]; its label is the counterpart, not a title.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectPairFavoriteRow {
    pub favorite_key: String,
    pub entity_id: ConversationId,
    pub counterpart: DirectPairCounterpart,
    pub starred_at: i64,
    pub created_at: i64,
    pub unread_count: i64,
}

/// The `GET /api/favorites` body (`ListFavoritesDto`): the projected rows plus the
/// viewer's `favorites`-list sort state. Rows carry a deterministic fallback order
/// (`starred_at DESC, favorite_key ASC`); the authoritative display order is
/// composed by the renderer from `viewer_sort`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListFavorites {
    pub items: Vec<FavoriteRow>,
    pub direct_pairs: Vec<DirectPairFavoriteRow>,
    pub viewer_sort: ViewerSortStateProjection,
}

/// Reads the viewer's favorites list. Always the viewer's own state — the route
/// gate is owned-state (self only), so there is no 404/403 arm here.
pub trait FavoritesReadPort {
    fn list_favorites(
        &self,
        viewer: &UserId,
    ) -> impl Future<Output = Result<ListFavorites, PersistenceFailure>> + Send;
}
