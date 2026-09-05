//! `conversation_messaging` — a namespace container for backend-sqlite's C3 adapters.
//!
//! A namespace container, not a bounded context or a shared lifecycle: it groups the
//! backend-sqlite crate roots the organization map assigns to owner `C3`
//! (`conversation_messaging`) under a single Rust module path
//! (`crate::conversation_messaging::*`). It declares its members and holds no SQL,
//! policy, orchestration, transaction, or lifecycle logic.
//!
//! Colocation does NOT merge the members: the direct-pair read adapter
//! (`direct_pair_read`), the runtime-delivery custody/settlement adapter
//! (`runtime_delivery`), and the messaging store directory (`messaging`) remain
//! independent responsibilities with their own SQL, transactions, and error taxonomies.
//! `messaging` is one mapped directory leaf: its `mod.rs`, `collaboration/`, `schedule/`,
//! and `task/` children stay internal to it and are not separate business units.

pub mod direct_pair_read;
pub mod messaging;
pub mod runtime_delivery;
