//! Human-session HTTP adapters for the viewer-sort / favorite capability.
//!
//! Six routes across one bounded context — the per-viewer sort preferences the
//! renderer composes list order from:
//!   - `POST`/`DELETE /api/channels/{id}/star` — toggle a conversation's star,
//!   - `POST /api/sort/touch` — stamp recent-opened,
//!   - `PUT  /api/sort/mode` — set one scope's [recent|manual] mode,
//!   - `PUT  /api/sort/order` — rewrite one group's dense ranks (⇒ manual),
//!   - `GET  /api/favorites` — the global starred-conversation list.
//!
//! All six mount behind the composition's `require_human_session` perimeter, so
//! the acting viewer arrives as an `Extension<UserId>` and a missing session is
//! that perimeter's 401 before any handler runs. The list-group resolution
//! (`resolveListGroups`) reuses the existing channel-directory / workspace-face
//! read authorities; the writes reuse the one viewer-sort write authority. No
//! second sort store, clock, or permission model is minted here.

mod favorites;
mod mutation;
mod star;
mod wire;

pub use favorites::{FAVORITES_PATH, FavoritesState, favorites_router};
pub use mutation::{
    SORT_MODE_PATH, SORT_ORDER_PATH, SORT_TOUCH_PATH, SortMutationState, sort_mutation_router,
};
pub use star::{CHANNEL_STAR_PATH, ChannelStarState, star_router};
pub use wire::{ViewerSortEntryDto, ViewerSortStateDto};
