//! Host-control faces answered from process-local state pinned to a daemon instance.
//!
//! Every fact here belongs to ONE daemon custody, and no leaf decides which
//! custody is current: the `daemon_delivery` registry already owns that — a
//! reserved slot with no daemon instance is a connection that is not ready yet,
//! and an attached one names the instance every answer must be bound to. These
//! leaves are handed that identity; a second current-connection map inside this
//! namespace is the defect the split exists to prevent.
//!
//! One change reason per leaf. Each command owns what it sends and what its answer
//! means, and the two commands are separate leaves rather than one because they
//! share no payload and no outcome vocabulary: the same transport failure is a
//! different report for each. The remaining two reasons are the status seed's
//! caching and retry policy, and the admission refusal's observable lifetime.

pub mod admission;
pub mod management;
pub mod proxy_config;
pub mod runtime_catalog;
pub mod status_seed;
pub mod status_snapshot;
pub(crate) mod wire_number;
