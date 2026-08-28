//! The host-agent management-plane routes (#2195).
//!
//! This module is the route track's home for the #2192 closed set. It replaces
//! the compile-only scaffold that only resolved the crate-root declaration: each
//! batch adds one reachable vertical here, and the composition-root mount for a
//! batch's `router()` lands with that batch's own checksum and E2E.
//!
//! Landed so far: the public `user_presence` cold read ([`presence`]), the
//! authenticated `agent availability` cold read ([`availability`]), the
//! authenticated `agent detail` cold read ([`agent_detail`]), the authenticated
//! `agent presence` cold read ([`agent_presence`]), and the authenticated
//! `GET /api/agents` list cold read ([`agent_list`]).
//!
//! `agent_wire` is a `pub(crate)` module: the full-`AgentDto` projector and the
//! shared post-commit `reproject_committed_agent` face are the single crate-private
//! authority every face that returns an agent goes through — the sibling
//! [`agent_detail`] and [`agent_list`] cold reads, the [`agent_patch`] and
//! [`agent_avatar_write`] mutating faces, and #task:2226's internal avatar faces.
//! It is `pub(crate)`, not `pub`: shared crate-wide, but not a public API surface.

pub mod agent_avatar;
pub mod agent_avatar_write;
pub mod agent_detail;
pub mod agent_list;
pub mod agent_patch;
pub mod agent_presence;
pub mod agent_stop;
pub(crate) mod agent_wire;
pub mod availability;
pub mod host_attachment;
mod online_viewers;
pub mod presence;
