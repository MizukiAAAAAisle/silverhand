//! `identity_access` — a namespace container for backend-sqlite's identity/access read adapters.
//!
//! A namespace container, not a bounded context or a self-named business unit: it groups
//! the backend-sqlite crate roots the organization map assigns to owner `identity_access`
//! under a single Rust module path (`crate::identity_access::*`). It declares its members
//! and holds no SQL, policy, projection, or lifecycle logic; there is no backend-sqlite
//! `identity_access` self-row.
//!
//! Colocation does NOT merge the members' responsibilities: the agent avatar serve-ref
//! read (`agent_avatar_read`), the agent detail / list / profile cold reads
//! (`agent_detail_read`, `agent_list_read`, `agent_profile_read`), the shared agent
//! visibility ACL authority (`agent_view_acl`), and the handle-namespace probe
//! (`handle_namespace`) remain independent adapters with their own SQL and error taxonomies.

pub mod agent_avatar_read;
pub mod agent_detail_read;
pub mod agent_list_read;
pub mod agent_profile_read;
pub mod agent_view_acl;
pub mod handle_namespace;
