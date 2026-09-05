//! Wire projection for the viewer-sort DTOs, matching `ViewerSortStateDtoSchema`
//! and `ViewerSortEntryDtoSchema`.

use std::collections::BTreeMap;

use serde::Serialize;
use silverhand_backend_core::viewer_read_model::viewer_sort_state::ViewerSortStateProjection;

/// `ViewerSortEntryDtoSchema`: `{ entity_id, rank, last_accessed_at, starred_at }`,
/// every ordinal nullable. `entity_id` is the opaque per-list id.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ViewerSortEntryDto {
    pub entity_id: String,
    pub rank: Option<i64>,
    pub last_accessed_at: Option<i64>,
    pub starred_at: Option<i64>,
}

/// `ViewerSortStateDtoSchema`: `{ list_key, modes: Record<scope, mode>, entries }`.
/// `modes` is the sparse per-scope map (an absent scope is the renderer's
/// `recent` default); `list_key` is the exact stored key string.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ViewerSortStateDto {
    pub list_key: String,
    pub modes: BTreeMap<String, String>,
    pub entries: Vec<ViewerSortEntryDto>,
}

impl From<ViewerSortStateProjection> for ViewerSortStateDto {
    fn from(projection: ViewerSortStateProjection) -> Self {
        Self {
            list_key: projection.list_key.as_stored(),
            modes: projection
                .modes
                .into_iter()
                .map(|(scope, mode)| (scope, mode.as_str().to_owned()))
                .collect(),
            entries: projection
                .entries
                .into_iter()
                .map(|entry| ViewerSortEntryDto {
                    entity_id: entry.entity_id,
                    rank: entry.rank,
                    last_accessed_at: entry.last_accessed_at,
                    starred_at: entry.starred_at,
                })
                .collect(),
        }
    }
}
