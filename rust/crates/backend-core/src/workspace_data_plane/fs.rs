//! The workspace filesystem data-plane port and its transport-neutral facts.
//!
//! Two reads back the two-column agent workspace pane: a flat tree of every
//! visible node under a workspace root, and one file by virtual path. Both are
//! answered by an owning-host daemon over correlated RPC; this port is the typed
//! seam between the route and that transport.
//!
//! The caller-supplied `path` is deliberately OPAQUE here: it is a `&str` that
//! this crate never parses, splits, or normalizes. The daemon's virtual-path
//! resolver is the single security boundary for traversal, symlink escape, and
//! dotfile rejection, and duplicating any of that grammar in Rust would only add
//! a second place for the rule to drift. A shape-rejected path comes back as the
//! [`WorkspaceFsFaultCode::ForbiddenPath`] arm, authored by the daemon, not this
//! layer.
//!
//! Byte counts and mtimes are carried as [`JsSafeInteger`], not a naked `i64`:
//! the wire contract is an integer every JavaScript JSON consumer can represent
//! exactly, so the type itself owns the binary64 precision boundary. The codec
//! mints these on the way in — rejecting a fraction, an out-of-`i64` number, or a
//! magnitude past `2^53-1` that would round on the JS side — and the route emits
//! the guaranteed-safe `i64` back out. A stat the boundary refuses is a daemon
//! answer the codec cannot represent, folded to `daemon_internal_error` rather
//! than widening the domain to carry an unsafe value.

use std::future::Future;

use crate::foundation::identity::{AgentId, HostId, WorkspaceId};
use crate::foundation::wire_number::JsSafeInteger;

/// Whether a tree node is a file or a directory. The wire spells these
/// `"file"` / `"directory"`; the codec owns that spelling.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceNodeKind {
    File,
    Directory,
}

/// One entry in the flat workspace tree — a virtual path, its kind, and its
/// stat pair. The path is whatever the daemon reported; this crate does not
/// interpret it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceTreeNode {
    pub path: String,
    pub kind: WorkspaceNodeKind,
    pub size: JsSafeInteger,
    pub mtime: JsSafeInteger,
}

/// The flat listing returned by the tree read: every visible node under the
/// resolved root, in the order the daemon walked them.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceTree {
    pub nodes: Vec<WorkspaceTreeNode>,
}

/// One file read by virtual path: its content (possibly truncated at the
/// daemon's cap), the stat pair, and whether the daemon truncated it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceFileRead {
    pub path: String,
    pub content: String,
    pub size: JsSafeInteger,
    pub mtime: JsSafeInteger,
    pub truncated: bool,
}

/// The closed set of faults a workspace filesystem read may report. Every arm is
/// reachable for the tree and file reads; a daemon answer outside it — an
/// unknown wire code, a corrupt frame, a refusal in a vocabulary these commands
/// do not speak — converges to [`Self::DaemonInternalError`] at the adapter, so
/// no caller ever meets a fault it has no arm for and nothing panics on an
/// unrecognized code.
///
/// The HTTP status and the stable wire token each arm maps to live in the route
/// that authors the product envelope, not here: this enum is the semantic fault,
/// transport- and protocol-neutral, in the same spirit as the rest of the
/// domain.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceFsFaultCode {
    /// No daemon is currently attached for the agent's host, or the attachment
    /// changed under the check→dispatch window. The operator can re-attach and
    /// retry.
    HostAttachPending,
    /// A daemon was attached but the round trip did not answer within budget.
    DaemonTimeout,
    /// The daemon answered unusably: a corrupt frame, a refusal in the wrong
    /// vocabulary, an unrecognized wire code, or a shape the codec rejects. The
    /// catch-all for everything the closed set does not name.
    DaemonInternalError,
    /// A hard host-local filesystem failure under the resolved root. Retriable
    /// once the operator clears the condition.
    FsUnavailable,
    /// The daemon has no attached computer to resolve an agents root under, so it
    /// cannot form a bundle coordinate. Retriable for the attach case.
    RegistryUnavailable,
    /// The caller-supplied virtual path was shape-rejected or its resolution
    /// would escape the workspace root. A request-level reject, never retried.
    ForbiddenPath,
    /// The path resolved to nothing, or resolved to a directory when a file was
    /// asked for.
    NotFound,
}

/// A workspace filesystem fault: its closed [`WorkspaceFsFaultCode`] plus a
/// stable, product-authored message. The daemon's own error string never crosses
/// this port — it is discarded at refusal decode — so a message here can only be
/// one this codebase wrote, and cannot leak an upstream detail.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceFsFault {
    pub code: WorkspaceFsFaultCode,
    pub message: String,
}

/// The typed seam a workspace-pane route dispatches through. Implementors pair a
/// host coordinate (resolved from the agent's row before the call) and an
/// optional workspace scope with one daemon command; the caller never assembles
/// command JSON or names a wire kind.
///
/// `workspace` is `None` for the agent's default home view and `Some` for the
/// narrower per-workspace/L2 view — exactly the scope the route resolved.
pub trait WorkspaceDataPlane {
    /// The flat tree under the resolved root.
    fn read_tree(
        &self,
        agent: &AgentId,
        host: &HostId,
        workspace: Option<&WorkspaceId>,
    ) -> impl Future<Output = Result<WorkspaceTree, WorkspaceFsFault>> + Send;

    /// One file by opaque virtual path under the resolved root.
    fn read_file(
        &self,
        agent: &AgentId,
        host: &HostId,
        workspace: Option<&WorkspaceId>,
        path: &str,
    ) -> impl Future<Output = Result<WorkspaceFileRead, WorkspaceFsFault>> + Send;
}
