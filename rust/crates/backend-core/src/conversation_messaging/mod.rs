//! `conversation_messaging` — the C3 (Conversation & Messaging) business-owner namespace.
//!
//! A namespace container, not a business unit of its own: it groups the crate
//! roots the organization map assigns to owner `C3` under a single Rust module
//! path (`crate::conversation_messaging::*`). It declares its members and holds no
//! domain logic itself.
//!
//! Colocation does NOT merge the members' responsibilities: `direct_pair_read` is a
//! read model, `messaging` is the messaging domain (one mapped directory leaf whose
//! internal children stay internal, not separate business units), and
//! `runtime_delivery` is the delivery vocabulary — three distinct authorities that
//! merely share this namespace.

pub mod direct_pair_read;
pub mod messaging;
pub mod runtime_delivery;
