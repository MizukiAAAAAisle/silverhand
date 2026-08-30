//! Workspace data-plane route family (Rust residual wave).
//!
//! Scaffold only: declared beside the existing workspace surfaces
//! (`workspaces`, `workspace_detail`, `workspace_metadata_write`,
//! `workspace_name_availability`, `workspace_rename_fanout`) so the workspace
//! data-plane lane can land in a file-disjoint subtree. No route, handler, DTO,
//! factory, port or mount yet, and not named by any composition root —
//! UNMOUNTED. The implementing lane fills it with `mod`/`use` submodule
//! declarations here and route files beside this `mod.rs`.
