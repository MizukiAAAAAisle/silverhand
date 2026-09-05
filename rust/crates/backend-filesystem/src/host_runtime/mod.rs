//! `host_runtime` — a namespace container for backend-filesystem's host-runtime adapter.
//!
//! A namespace container, not a bounded context or a shared lifecycle: it groups the
//! backend-filesystem crate roots the organization map assigns to owner `C2`
//! (`host_runtime`) under a single Rust module path (`crate::host_runtime::*`). It
//! declares its members and holds no adapter logic itself.
//!
//! Its sole member, `runtime_detection`, both reads the machine's installed runtime
//! catalogue and SPAWNS local processes to do so. That is a wider capability than
//! reading a directory, and it is the reason it stays one module behind a port the
//! application declares: everything that starts a child process on this machine is in
//! one place.

pub mod runtime_detection;
