#![forbid(unsafe_code)]
//! Adapters for the local machine this process runs on.
//!
//! Two kinds of local fact live here: files this backend owns (the blob store), and
//! executables it merely finds (the runtime catalogue). Both are answers only the
//! host operating system can give, and neither is storage of domain data — which is
//! the line that keeps SQL out of this crate and the OS out of the others.
//!
//! Detecting runtimes also SPAWNS local processes. That is a wider capability than
//! reading a directory, and it is the reason it is confined to one module here
//! rather than reached from a route: everything that starts a child process on this
//! machine is in one place, behind a port the application declares.

pub mod audit_sink;
pub mod blob_store;
pub mod runtime_detection;
