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
