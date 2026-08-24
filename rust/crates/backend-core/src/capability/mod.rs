//! Who may see or act on an agent.
//!
//! Every module here is a pure decision over facts the caller has ALREADY read:
//! nothing in this namespace holds a connection, issues a read, or owns a
//! repository. That is what lets the same rule serve a face that reads its facts
//! before an independent write and a face that must read them under the write
//! lock it is about to commit in — the decision is wrapped by a unit of work,
//! never cut by one.
//!
//! Acquiring the facts can fail (a missing driver, an unreadable row). That
//! failure is the caller's `Err`, upstream of every function here, so folding a
//! read failure into a refusal is not expressible rather than merely discouraged.

pub mod agent_audit;
pub mod agent_authority;
pub mod agent_view;
pub mod decision;
pub mod principal;
