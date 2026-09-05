//! Host custody: the computers a user owns, and the credentials that let their
//! daemons speak for them.
//!
//! The decomposition follows what each part is allowed to decide:
//!
//! - [`environment`] names the two capabilities the domain cannot invent — randomness
//!   and the clock — and the failures they report.
//! - [`computer`] says what a computer IS, and declares the closed vocabularies that
//!   describe one, because this namespace owns computers.
//! - [`lifecycle`] decides the ONE state a computer's stamps add up to, and what that
//!   state permits. Nothing stores a status.
//! - [`read`] resolves a NAMED computer for a requester, and is the one place a
//!   missing computer and someone else's computer become the same answer.
//! - [`custody`] owns a connect credential's whole life: minting it, hashing it,
//!   judging a presented one, and deciding whether a host may receive one at all.
//!   Nothing outside it can bring a credential into existence.
//! - [`invite`] creates a user-managed computer and its first credential.
//! - [`claim`] resolves the computer an installation runs on — reusing, adopting or
//!   registering one — and decides whether its daemon needs a new token.
//! - [`revoke`] ends a computer's custody, and is the only place that decides what
//!   ending it does and does not reach.
//! - [`rotation`] replaces a live credential with a fresh one, and owns the order the
//!   replacement must happen in for no holder to be left with only a dead token.
//! - [`aftermath`] names what a change of custody owes the rest of the system once it
//!   has committed, and nothing else here may decide those effects are optional.
//! - [`agent_roster`] enumerates the agents a computer carries, the set the
//!   availability fan-out walks when custody moves them all at once.
//!
//! `host_runtime` is BOTH this self-named bounded context (the modules above) AND the
//! C2 relocation namespace (`crate::host_runtime::*`). The `pub mod` entries below the
//! context list are relocated business leaves whose owner/target the organization
//! map/gate assigns to `host_runtime::<leaf>`; they are distinct capabilities that merely
//! share this namespace, not internal submodules of the custody context and not merged
//! into it (#task:2280 and later host_runtime waves).

pub mod aftermath;
pub mod agent_roster;
pub mod claim;
pub mod computer;
pub mod custody;
pub mod environment;
pub mod invite;
pub mod lifecycle;
pub mod read;
pub mod revoke;
pub mod rotation;
pub mod status;
pub mod update;

// Relocated C2 business leaves (organization namespace role). `availability`,
// `agent_availability_read`, `agent_presence_read`, and `host_resources_read` are
// independent read models; `agent_presence` is pure domain policy; and
// `agent_materialize` / `scope_runtime_stop` are application contracts. Each is its own
// capability; the organization map/gate owns its exact role and target here.
pub mod agent_availability_read;
pub mod agent_materialize;
pub mod agent_presence;
pub mod agent_presence_read;
pub mod availability;
pub mod host_resources_read;
pub mod scope_runtime_stop;

// Relocated C2 runtime-authority vocabulary leaves (#task:2281). Three independent
// authorities that merely share this namespace — the credential principal/scope/generation
// vocabulary, the observed runtime event/status vocabulary, and the durable runtime
// transition lock/facts — with disjoint types, ports, and error taxonomies (not merged).
pub mod runtime_credential;
pub mod runtime_event;
pub mod runtime_transition;

// Relocated C2 leaves (#task:2282). The agent-scoped bulk-stop orchestration vocabulary
// and the runtime-state read model — two independent units sharing this namespace, not
// merged. The runtime-state read model is a directory leaf: it is one mapped business unit;
// its internal children (`model`) are not separate map units.
pub mod agent_bulk_stop;
pub mod agent_runtime_state_read;

// Relocated C2 leaf (#task:2283) — closed the settled host_runtime namespace at 11/11/0. The
// agent runtime-switch saga (`PUT /api/agents/{id}/runtime`): a distinct orchestration unit
// that reuses the runtime-transition lock, kept separate from the credential/event/transition,
// stop, and state-read units also colocated here; namespace closure is not a conceptual merger.
pub mod agent_runtime_switch;
