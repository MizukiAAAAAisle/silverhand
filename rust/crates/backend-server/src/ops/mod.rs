//! The root operational read cluster: four faces that describe the PROCESS rather than
//! anything in it.
//!
//! `GET /api/server/info` — what this build is.
//! `GET /api/health` — that this process is alive.
//! `GET /readyz` — whether it is ready to serve, and why not.
//! `GET /api/runtimes` — what the machine it runs on has.
//!
//! Three of the four are ANONYMOUS: `server_info` and `health` sit ahead of the bearer
//! middleware on the product's `/api/*` allowlist, and `/readyz` is registered outside
//! `/api/*` entirely, so a supervisor can probe liveness and readiness without a
//! session. `/api/runtimes` is the exception — it is under `/api/*` with no allowlist
//! entry, so the product refuses an anonymous request `401` before the handler; the
//! composition mounts it behind the human-session perimeter to match.
//!
//! ## Why none of this is in `backend-core`
//!
//! A domain fact is one a row could hold and any reader could ask about. None of these
//! is: a build's protocol version, a process's liveness, a boot sequence's progress and
//! a filesystem's contents are all properties of THIS assembly of THIS process. Putting
//! them in the domain crate would give every application module a vocabulary for
//! process state it has no business reading, and would make the domain crate the place
//! a deployment concern goes to be defined.
//!
//! The one exception proves the rule: the offered runtime catalogue IS domain
//! vocabulary — a product decision about the closed runtime set — so it lives in
//! `backend-core::agents::runtime_catalog`, and only its WIRE SPELLING lives here.
//!
//! ## What the composition root still owns
//!
//! Each face is a factory over the facts it reports; none of them establishes a fact.
//! Two things are therefore named handoffs rather than omissions:
//!
//!  - [`readiness::BootProgress`] — this module delivers the live holder and the three
//!    `mark_*` calls; the composition root calls them where the facts actually happen
//!    (migration runner, accept loop, transport wiring). Nothing here defaults them,
//!    because a default would be an assertion nobody checked.
//!  - The runtime detector — this module delivers TWO routers, and the composition
//!    root picks between them by deployment profile: an embedded backend constructs the
//!    process's one detector and mounts [`runtimes::detecting_router`]; a standalone
//!    backend mounts [`runtimes::control_plane_router`], which has no detector to hold.
//!    Constructing the detector ONCE for the process is what makes the thirty-second
//!    detection window a property of the machine instead of of a request; giving the
//!    standalone face no detector at all is what makes its refusal structural.

pub mod bind_address;
pub mod deployment;
pub mod health;
pub mod readiness;
pub mod runtimes;
pub mod server_info;
