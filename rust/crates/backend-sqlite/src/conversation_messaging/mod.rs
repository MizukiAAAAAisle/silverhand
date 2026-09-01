//! `conversation_messaging` — a namespace container for backend-sqlite's C3 adapters.
//!
//! A namespace container, not a bounded context or a shared lifecycle: it groups the
//! backend-sqlite crate roots the organization map assigns to owner `C3`
//! (`conversation_messaging`) under a single Rust module path
//! (`crate::conversation_messaging::*`). It declares its members and holds no SQL,
//! policy, orchestration, transaction, or lifecycle logic.
//!
//! Colocation does NOT merge the members: the direct-pair read adapter
//! (`direct_pair_read`) and the runtime-delivery custody/settlement adapter
//! (`runtime_delivery`) remain independent responsibilities with their own SQL,
//! transactions, and error taxonomies. The large `messaging/` directory (owner C3 in the
//! map) is NOT yet relocated here — it stays a crate-root module as the sole named
//! residual for a separate closure wave; there is no compatibility bridge between it and
//! this container.

pub mod direct_pair_read;
pub mod runtime_delivery;
