//! Destroying an agent, and the computer an agent sits on.
//!
//! The two cascades destroy the SAME rows, so they share one vocabulary of facts
//! and one durable mechanism rather than diverging into two. Every phase reads
//! the narrowest facts it consumes, and no physical row or repository DTO crosses
//! this boundary, so a column added to an agent, workspace or conversation cannot
//! silently become an input to a delete.
//!
//! Both cascades must read before they write — one purges host-local files, which
//! may not run inside a write lock, and one answers a refusal without taking a
//! write lock to say no. Those pre-lock reads are HINTS; the authoritative facts
//! are re-read under the mechanism and judged by
//! [`eligibility::eligibility_moved`].

pub mod eligibility;
pub mod facts;
pub mod intent;
