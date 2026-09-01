//! The regular-workspace METADATA write authority — the domain behind
//! `PATCH /api/workspaces/:id` (rename + description) and
//! `PATCH /api/workspaces/:id/archive`.
//!
//! Its reason to change is the editable-workspace contract: a workspace's
//! display name (and the uniqueness key that name folds to), its description, and
//! whether it is archived. That is a DISTINCT authority from
//! [`crate::identity_access::workspace_face`] (which only PROJECTS a workspace's published face for
//! a reader) and from [`crate::identity_access::access`] enrollment (which writes roster edges).
//! This context owns the mutation and the fact it yields, nothing more.
//!
//! ## Only regular workspaces have metadata to edit
//!
//! An agent-home workspace (`owner_agent_id IS NOT NULL`) has no editable name —
//! it stores no `name_key`, is not in the regular-workspace namespace, and its
//! label is a projection of its owner. Rename/description/archive therefore act on
//! REGULAR workspaces only, and a home is the same `404` a missing id earns
//! ([`WorkspaceMetadataWrite::NoSuchWorkspace`]). The committed fact is always a
//! regular [`WorkspaceFace`] (`owner_agent_id: None`, no DM channels), so the write
//! can project it whole without a cross-aggregate read.
//!
//! ## The write is atomic and self-deciding, and the fact is sealed
//!
//! Like the profile-metadata write, this is a self-deciding unit of work: the
//! adapter reserves the single writer, re-reads the authoritative row UNDER that
//! lock, re-derives the caller's governance ceiling from the role it re-reads
//! there (a pre-lock boundary verdict can go stale — a demotion may commit in the
//! seam), decides name collision against the regular namespace under the same
//! lock, writes, and returns the fact its own write produced (via `RETURNING`),
//! never a post-commit re-read.
//!
//! The returned fact is then SEALED against the request before any product outcome
//! is minted ([`update_workspace_metadata`] / [`archive_workspace`]): a committed
//! face carrying a foreign id, a name the caller did not ask for, a description
//! that does not match, a committed `name_key` that is not the fold of the
//! requested name, an `updated_at` that is not the sampled write instant, or a
//! claim to have renamed a workspace whose home flag is set is a broken adapter —
//! refused as [`WorkspaceMetadataWriteError::UntrustworthyWriteFact`] (a safe
//! `500`), never trusted as a second identity/value channel. This is the
//! committed-fact / single-identity discipline: the request carries the sole
//! identity and the sole target value, and the returned projection is only ever a
//! SECOND WITNESS of them.
//!
//! Crucially the name-change EFFECT gate is DERIVED here in the domain, never
//! supplied by the adapter: the write reports only the before-image it read under
//! its own lock ([`PriorWorkspaceAddress`]) and the `name_key` it committed, and the
//! seal computes whether a display name actually moved. So the adapter can no longer
//! OMIT the verdict (hand back a pre-computed "no change" to skip the fan-out) or
//! fabricate one — it does not decide, it only witnesses, and the domain derives.
//! What the seal CANNOT catch by itself is a dishonest before-image: an adapter that
//! reports `prior.name` equal to the committed name would derive `None` for a rename
//! that did happen. That honesty is not a type guarantee — it is enforced by the
//! production SQLite adapter reading the before-image and committing under ONE
//! `BEGIN IMMEDIATE` transaction (so `prior` is the row's true pre-write address) and
//! by its adapter tests, exactly as the truthfulness of any committed value the seal
//! binds rests on the adapter's guarded write.
//!
//! ## `updated_at` always bumps; the no-op is the EFFECT gate, not a skipped write
//!
//! Parity note, load-bearing for checkpoint B: the product's `updateMutableMetadata`
//! ALWAYS writes (and bumps `updated_at`) whenever a field is present — there is no
//! write-skipping no-op on the metadata path, and archive always writes too. So the
//! "changed / no-op" distinction is NOT an `updated_at`-skipping write. It is
//! carried as [`WorkspaceNameChange`]: the seal derives it as `Some` exactly when a
//! name was supplied AND the committed display differs from the before-image the
//! write read under its lock (mirroring the route's `parsed.data.name && name.name
//! !== workspace.name`). That is the signal a later seam needs to decide whether the
//! workspace-channel rename system message and the `viewer_workspaces_changed`
//! fan-out are owed — the write itself commits either way. Archive owes no such gate
//! and commits regardless of whether the archived state flipped.
//!
//! ## Boundary invariant: a committed rename cannot skip its announce
//!
//! [`update_workspace_metadata_and_announce`] is the ONLY public door into a
//! committed rename. The pure [`update_workspace_metadata`] and its sealed success
//! value [`CommittedWorkspaceMetadata`] (and the [`WorkspaceMetadataUpdate`] it
//! returns) are crate-private, so no server boundary can mint a committed face,
//! put it on the wire, and quietly drop the `metadata_changed` fan-out the commit
//! owes: the only reachable outcome hands the face and the announce fate back
//! together ([`AnnouncedWorkspaceMetadata::into_parts`]). Archive owes no fan-out,
//! so its [`archive_workspace`] use case and sealed [`ArchivedWorkspace`] stay
//! public.
//!
//! The public door resolves at this path:
//!
//! ```
//! use silverhand_backend_core::identity_access::workspace_metadata_write::{
//!     AnnouncedWorkspaceMetadata, WorkspaceMetadataUpdateWithAnnounce,
//! };
//! ```
//!
//! The pure seal path does NOT — a boundary that tries to reach it fails to
//! compile (`E0603`, the item is private), which is the negative gate that keeps
//! the announce obligation unskippable:
//!
//! ```compile_fail
//! use silverhand_backend_core::identity_access::workspace_metadata_write::{
//!     CommittedWorkspaceMetadata, update_workspace_metadata,
//! };
//! ```

use std::future::Future;

use thiserror::Error;

use crate::{
    identity::{Principal, WorkspaceId},
    identity_access::workspace_face::WorkspaceFace,
    identity_access::workspace_name::CanonicalWorkspaceName,
    persistence::PersistenceFailure,
};

/// A metadata edit, modeled as the THREE shapes the write actually performs —
/// never a `(Option<name>, Option<description>)` product with an unrepresentable
/// fourth "neither field" state.
///
/// The product route validates `{ name?, description? }` with a `refine` that at
/// least one field is present; the empty edit is a `400` at the wire and never
/// reaches this domain. Encoding the three real shapes as arms — rather than a
/// pair of options — makes that empty state UNCONSTRUCTABLE here rather than a
/// branch the adapter must defend against, and mirrors exactly the product
/// `updateMutableMetadata`'s three `SET` branches (both fields / name only /
/// description only). A `description` of `None` is an explicit "clear the
/// description to NULL", distinct from "leave the description untouched" (the
/// [`Name`](Self::Name) arm) — the same distinction the product's per-branch SQL
/// draws.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkspaceMetadataEdit {
    /// Set both the name (with its folded key) and the description.
    NameAndDescription {
        name: CanonicalWorkspaceName,
        description: Option<String>,
    },
    /// Set the name (with its folded key) only; leave the description untouched.
    Name(CanonicalWorkspaceName),
    /// Set the description only (or clear it with `None`); leave the name untouched.
    Description(Option<String>),
}

impl WorkspaceMetadataEdit {
    /// The display name this edit would write, or `None` when it touches only the
    /// description. Used by the seal to bind the committed name against the request.
    pub fn requested_name(&self) -> Option<&CanonicalWorkspaceName> {
        match self {
            Self::NameAndDescription { name, .. } | Self::Name(name) => Some(name),
            Self::Description(_) => None,
        }
    }

    /// The description this edit would write (`Some(None)` = clear to NULL,
    /// `Some(Some(s))` = set to `s`), or `None` when it leaves the description
    /// untouched. Used by the seal to bind the committed description.
    pub fn requested_description(&self) -> Option<Option<&str>> {
        match self {
            Self::NameAndDescription { description, .. } | Self::Description(description) => {
                Some(description.as_deref())
            }
            Self::Name(_) => None,
        }
    }
}

/// A workspace's address changed: its display name from `old_name` to `new_name`,
/// and the uniqueness key it folds to from `old_key` to `new_key`.
///
/// Present on a committed metadata fact exactly when the edit supplied a name AND
/// that name's display form differs from the workspace's current one. It is the
/// EFFECT gate for the post-commit fan-out (the workspace-channel rename system
/// message and the `viewer_workspaces_changed` announce), AND the committed record
/// of the address pair the write actually left — so the boundary's audit
/// (the product's `logWorkspaceAddressAssignment(oldKey, newKey)`) reads the keys
/// straight off this fact and never re-canonicalizes the name a second time. The
/// key pair is carried, not just the display pair, because a display change and an
/// address (key) change are distinct: `"Regular"` → `"REGULAR"` changes the display
/// while folding to the same key, so a consumer that owes an address-reassignment
/// effect must compare the keys, not the display.
///
/// Fields are public because it is data the boundary reads, not a verdict. The
/// record is DERIVED by the seal from the write's witnessed before-image
/// ([`PriorWorkspaceAddress`]) and committed `name_key`, never supplied by the
/// adapter: `old_*` is the before-image the write read under its lock, `new_name`
/// is the committed display (already bound to the request), and `new_key` is the
/// committed fold key (bound to the fold of the requested name) — so an adapter that
/// wrote (or read back) the wrong committed key cannot slip a bogus record through,
/// and the adapter cannot OMIT the record for a rename it committed. The one thing
/// the derivation cannot catch is a dishonest before-image (an adapter reporting a
/// `prior.name` that was never the row's address); that rests on the production
/// adapter reading `prior` in the SAME write transaction, not on this type. A
/// description-only edit, or a rename to the identical display name, leaves the whole
/// record `None` and owes no fan-out.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceNameChange {
    pub old_name: String,
    pub new_name: String,
    pub old_key: String,
    pub new_key: String,
}

/// The address a metadata write read under its OWN write lock, BEFORE it wrote —
/// the display name the workspace carried and the fold key it addressed by.
///
/// This is the write's before-image WITNESS, not a verdict. The adapter reports
/// what it read; the core seal ([`seal_metadata_write_fact`]) compares it against
/// the committed face to DERIVE the [`WorkspaceNameChange`] gate. Deriving the gate
/// in the domain — rather than trusting an adapter-computed `Option<WorkspaceNameChange>` —
/// is what stops an adapter from OMITTING the fan-out decision: it can no longer
/// hand back "no change" as a verdict, because it no longer produces a verdict; it
/// reports the before-image and the domain compares. That closes the omitted-verdict
/// channel, not every lie: an adapter that reports a `name` it never read (a
/// before-image equal to the committed display) would still derive `None`. The
/// production SQLite adapter forecloses that by reading this before-image and
/// committing under ONE `BEGIN IMMEDIATE` transaction — so `name`/`key` are the
/// row's true pre-write address — with adapter tests that pin it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriorWorkspaceAddress {
    pub name: String,
    pub key: String,
}

/// The closed outcome of a metadata write, decided inside the write's own
/// transaction — the RAW fact a [`WorkspaceMetadataWriteUnitOfWork`] returns,
/// before the use case seals it.
///
/// `Forbidden`, `NameTaken`, and `NoSuchWorkspace` are product answers (a `403`,
/// `409`, and `404` at the wire), decided under the write lock; they are `Ok`
/// values here, not faults. `Committed` carries the projected regular
/// [`WorkspaceFace`] the write left (with the bumped `updated_at`), the before-image
/// the write witnessed under its lock ([`PriorWorkspaceAddress`]), and the committed
/// `name_key` — the raw witnesses from which the use case DERIVES the
/// [`WorkspaceNameChange`] gate; the adapter does not decide it. Because a lying
/// adapter could put anything in `Committed`, the use case never trusts it directly —
/// it seals it against the request first.
// The `Committed` arm dwarfs the unit refusal arms because it carries the whole
// committed face plus its effect gate — that payload IS the outcome, the same
// result-or-refusal shape as `WorkspaceView`. Boxing it would add heap indirection
// to a value moved once per request purely to satisfy a stack-size heuristic.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkspaceMetadataWrite {
    /// No regular workspace answers to this id (missing, or an agent-home). The
    /// two are one fact on purpose, so a caller cannot distinguish them.
    NoSuchWorkspace,
    /// The caller's in-lock governance ceiling did not clear the `Admin` floor a
    /// rename/description edit requires. A rollback; nothing was written.
    Forbidden,
    /// The requested name's folded key is already held by a DIFFERENT regular
    /// workspace. A rollback; nothing was written.
    NameTaken,
    /// The edit committed. Carries the regular workspace's projected face, the
    /// before-image the write read under its lock (from which the domain DERIVES
    /// the name-change gate), and the `name_key` the write actually committed (its
    /// `RETURNING` value, bound by the seal against the fold of the requested name).
    Committed {
        face: WorkspaceFace,
        prior: PriorWorkspaceAddress,
        committed_name_key: String,
    },
}

/// The closed outcome of an archive write, decided inside the write's own
/// transaction — the RAW fact a [`WorkspaceMetadataWriteUnitOfWork`] returns.
///
/// Archive requires the `Owner` floor (stricter than rename's `Admin`). The write
/// commits (and bumps `updated_at`) regardless of whether the archived state
/// actually flipped, matching the product's `setArchived`; archive owes no fan-out,
/// so no "changed" gate is carried.
#[allow(clippy::large_enum_variant)] // `Committed` carries the whole face; see `WorkspaceMetadataWrite`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkspaceArchiveWrite {
    /// No regular workspace answers to this id (missing, or an agent-home).
    NoSuchWorkspace,
    /// The caller's in-lock governance ceiling did not clear the `Owner` floor.
    Forbidden,
    /// The archive state was written. Carries the projected face; the write
    /// committed (bumping `updated_at`) whether or not the state flipped.
    Committed { face: WorkspaceFace },
}

/// The atomic metadata write: rename/describe and archive a REGULAR workspace,
/// each self-deciding under its own write lock.
///
/// The unit re-reads the authoritative row and the caller's role under the lock,
/// applies the pure governance floor (`Admin` for `update_metadata`, `Owner` for
/// `set_archived`) via the shared
/// [`governance_floor_verdict`](crate::identity_access::access::governance_floor_verdict), decides
/// name collision against the regular namespace, writes, and returns the fact its
/// own write produced. The `actor` is passed in so the adapter re-derives authority
/// under the same lock a pre-lock boundary verdict cannot guarantee is still
/// current. `now_ms` is the write instant the application sampled — the value the
/// always-bumped `updated_at` takes (and, for an archive, the `archived_at`
/// timestamp): this crate owns no clock, so the time source stays in the
/// application exactly as the enrollment join time does. The `edit` is borrowed:
/// the use case keeps ownership to seal the returned fact against it.
pub trait WorkspaceMetadataWriteUnitOfWork: Clone + Send + Sync + 'static {
    fn update_metadata(
        &self,
        actor: Principal,
        workspace_id: &WorkspaceId,
        edit: &WorkspaceMetadataEdit,
        now_ms: i64,
    ) -> impl Future<Output = Result<WorkspaceMetadataWrite, PersistenceFailure>> + Send;

    fn set_archived(
        &self,
        actor: Principal,
        workspace_id: &WorkspaceId,
        archived: bool,
        now_ms: i64,
    ) -> impl Future<Output = Result<WorkspaceArchiveWrite, PersistenceFailure>> + Send;
}

/// A committed, SEALED metadata write: the regular workspace's face and the
/// name-change effect gate, together.
///
/// Reachable only by minting inside [`update_workspace_metadata`] AFTER the seal —
/// private fields, no public constructor — so a boundary that receives one holds
/// proof the returned fact matched the request. The face and the gate are carried
/// together (via [`into_parts`](Self::into_parts)) so a consumer that wants the
/// face to serve the wire receives, in the same move, the gate that decides whether
/// the rename fan-out is owed; the two cannot be read apart and drift.
///
/// Crate-private (like [`update_workspace_metadata`] itself): a committed rename is
/// only ever reachable through [`update_workspace_metadata_and_announce`], which
/// binds the face to its announce fate, so no boundary can put this face on the
/// wire while skipping the `metadata_changed` obligation.
#[derive(Debug)]
pub(crate) struct CommittedWorkspaceMetadata {
    face: WorkspaceFace,
    name_change: Option<WorkspaceNameChange>,
}

impl CommittedWorkspaceMetadata {
    /// Split into the committed face and the name-change gate at once — the only
    /// accessor, so the face and its fan-out decision are taken together and can
    /// never be read apart and drift. There is deliberately no borrowing `face()` /
    /// `name_change()` pair: the sole consumer is
    /// [`update_workspace_metadata_and_announce`], which needs both halves in the
    /// same move to bind the face to its announce fate.
    pub(crate) fn into_parts(self) -> (WorkspaceFace, Option<WorkspaceNameChange>) {
        (self.face, self.name_change)
    }
}

/// A committed, SEALED archive write: the regular workspace's face. Minted only
/// inside [`archive_workspace`] after the seal.
#[derive(Debug)]
pub struct ArchivedWorkspace {
    face: WorkspaceFace,
}

impl ArchivedWorkspace {
    /// The committed regular-workspace face (bumped `updated_at`), for the wire.
    pub fn face(&self) -> &WorkspaceFace {
        &self.face
    }

    pub fn into_face(self) -> WorkspaceFace {
        self.face
    }
}

/// The closed outcome of the [`update_workspace_metadata`] use case.
///
/// Crate-private: the pure write is an internal step of
/// [`update_workspace_metadata_and_announce`], never the boundary's own door.
#[allow(clippy::large_enum_variant)] // `Committed` carries the whole face; see `WorkspaceMetadataWrite`.
#[derive(Debug)]
pub(crate) enum WorkspaceMetadataUpdate {
    /// The edit committed and its fact was sealed against the request.
    Committed(CommittedWorkspaceMetadata),
    /// The requested name is held by another regular workspace — the surface's `409`.
    NameTaken,
    /// The caller lacked the `Admin` governance floor — the surface's `403`.
    Forbidden,
    /// No such regular workspace — the surface's `404`.
    NoSuchWorkspace,
}

/// The closed outcome of the [`archive_workspace`] use case.
#[allow(clippy::large_enum_variant)] // `Committed` carries the whole face; see `WorkspaceMetadataWrite`.
#[derive(Debug)]
pub enum WorkspaceArchiveUpdate {
    /// The archive state committed and its fact was sealed against the request.
    Committed(ArchivedWorkspace),
    /// The caller lacked the `Owner` governance floor — the surface's `403`.
    Forbidden,
    /// No such regular workspace — the surface's `404`.
    NoSuchWorkspace,
}

/// Why a metadata/archive write could not yield a trustworthy product answer. Both
/// arms are safe `500`s, never a product refusal, and are DISTINCT facts:
///
/// * [`Persistence`](Self::Persistence) — the write port itself faulted (driver
///   error, corrupt committed row). Surfaced, never folded into a product `4xx`.
/// * [`UntrustworthyWriteFact`](Self::UntrustworthyWriteFact) — the port returned a
///   committed fact whose identity, name, description, home flag, committed
///   `name_key`, or write instant does NOT match the write it was asked to perform.
///   That is the channel by which a broken adapter could splice one workspace's
///   write onto another, hand back a foreign face, or commit a name/key the request
///   never asked for, so the use case SEALS same-origin before minting any outcome
///   and fails closed here — not a `debug_assert` (a release build must fail closed
///   too). This binds the COMMITTED fact to the request; the honesty of the
///   before-image the fan-out gate derives from is a separate guarantee the
///   production adapter provides (reading it in the write's own transaction), not
///   one this seal can enforce.
#[derive(Debug, Error)]
pub enum WorkspaceMetadataWriteError {
    #[error(transparent)]
    Persistence(#[from] PersistenceFailure),
    #[error(
        "workspace metadata write returned a fact whose identity or value does not match the request"
    )]
    UntrustworthyWriteFact,
}

/// Seal a committed metadata fact against the request that produced it AND derive
/// the name-change fan-out gate from the write's own witnesses.
///
/// The request carries the sole identity (`workspace_id`) and the sole target
/// values (the edit's name/description). A correct adapter's guarded
/// `WHERE id = ? AND owner_agent_id IS NULL ... RETURNING` guarantees the committed
/// face agrees; a disagreement is a broken adapter. Sealing here — before the
/// outcome is minted — keeps the returned face a second witness of the request
/// rather than a second, trusted channel. The bind refuses:
///
/// * a foreign id or a home workspace (`owner_agent_id` set) reported as a
///   regular-metadata commit;
/// * an `updated_at` that is not the sampled write instant `now_ms` (the write
///   always bumps it; a fact carrying a different stamp did not come from this write);
/// * a committed display or description that is not what the edit asked to write;
/// * a name-bearing edit whose committed `name_key` is not the fold of the requested
///   name (the face never publishes the key, so an adapter that wrote or read back
///   the wrong `name_key` would otherwise slip through unnoticed);
/// * a description-only edit whose committed display or `name_key` moved off the
///   before-image — the adapter renamed a workspace the request never asked to rename.
///
/// The name-change gate is DERIVED, never supplied: the adapter reports only the
/// before-image it read under its own lock (`prior`) and the `name_key` it
/// committed. The seal computes `Some` exactly when a name was supplied AND the
/// committed display differs from the before-image, carrying the true address pair
/// (`prior.name`/`prior.key` → committed display/`committed_name_key`). An adapter
/// therefore cannot OMIT the fan-out decision (hand back a "no change" verdict) or
/// fabricate one — it does not decide, it only witnesses. The seal cannot, on its
/// own, catch a dishonest before-image; that the before-image is the row's true
/// pre-write address rests on the production adapter reading it in the same write
/// transaction, not on this function.
fn seal_metadata_write_fact(
    workspace_id: &WorkspaceId,
    edit: &WorkspaceMetadataEdit,
    face: &WorkspaceFace,
    prior: &PriorWorkspaceAddress,
    committed_name_key: &str,
    now_ms: i64,
) -> Result<Option<WorkspaceNameChange>, WorkspaceMetadataWriteError> {
    // Identity, home flag, and the always-bumped write instant.
    if face.id != *workspace_id || face.owner_agent_id.is_some() || face.updated_at != now_ms {
        return Err(WorkspaceMetadataWriteError::UntrustworthyWriteFact);
    }
    // The description the edit asked to write (when it carries one).
    if let Some(description) = edit.requested_description()
        && face.description.as_deref() != description
    {
        return Err(WorkspaceMetadataWriteError::UntrustworthyWriteFact);
    }
    match edit.requested_name() {
        // A name-bearing edit: the committed display AND fold key must both equal the
        // request; the gate is then derived from whether the display moved off the
        // before-image the write read under its own lock.
        Some(name) => {
            if face.name != name.name() || committed_name_key != name.key() {
                return Err(WorkspaceMetadataWriteError::UntrustworthyWriteFact);
            }
            if prior.name != face.name {
                Ok(Some(WorkspaceNameChange {
                    old_name: prior.name.clone(),
                    new_name: face.name.clone(),
                    old_key: prior.key.clone(),
                    new_key: committed_name_key.to_owned(),
                }))
            } else {
                // A no-op rename to the identical display name: committed (updated_at
                // bumped), but no label moved, so no fan-out is owed.
                Ok(None)
            }
        }
        // A description-only edit must not have moved the address at all: the
        // committed display and fold key must equal the before-image, or the adapter
        // renamed a workspace the request never asked to rename.
        None => {
            if face.name != prior.name || committed_name_key != prior.key {
                return Err(WorkspaceMetadataWriteError::UntrustworthyWriteFact);
            }
            Ok(None)
        }
    }
}

/// Reject a committed archive fact that does not belong to the request.
///
/// Binds the committed face's id and home flag, that its `updated_at` is the sampled
/// write instant `now_ms` (the write always bumps it), and that its archived state
/// matches the request: `archived_at == Some(now_ms)` when archiving, `None` when
/// un-archiving. A fact carrying a stale stamp or a contradictory archived state did
/// not come from this write.
fn seal_archive_write_fact(
    workspace_id: &WorkspaceId,
    archived: bool,
    face: &WorkspaceFace,
    now_ms: i64,
) -> Result<(), WorkspaceMetadataWriteError> {
    let archived_at_matches = if archived {
        face.archived_at == Some(now_ms)
    } else {
        face.archived_at.is_none()
    };
    if face.id != *workspace_id
        || face.owner_agent_id.is_some()
        || face.updated_at != now_ms
        || !archived_at_matches
    {
        return Err(WorkspaceMetadataWriteError::UntrustworthyWriteFact);
    }
    Ok(())
}

/// Rename and/or describe a regular workspace.
///
/// The write self-decides collision, governance, and the name-change gate under its
/// own lock. Before ANY product outcome is minted, the returned fact is
/// [sealed](seal_metadata_write_fact) against the request; a fact that fails the
/// seal is [`WorkspaceMetadataWriteError::UntrustworthyWriteFact`] (a safe `500`),
/// never returned. `NameTaken`, `Forbidden`, and `NoSuchWorkspace` pass through as
/// the surface's `409` / `403` / `404`.
///
/// Crate-private: this pure write is the internal first half of
/// [`update_workspace_metadata_and_announce`], which is the boundary's only door
/// into a committed rename. Keeping it (and its sealed [`CommittedWorkspaceMetadata`]
/// outcome) unreachable from outside the crate is what makes the post-commit
/// `metadata_changed` obligation impossible to bypass.
pub(crate) async fn update_workspace_metadata<W>(
    writes: &W,
    actor: Principal,
    workspace_id: &WorkspaceId,
    edit: WorkspaceMetadataEdit,
    now_ms: i64,
) -> Result<WorkspaceMetadataUpdate, WorkspaceMetadataWriteError>
where
    W: WorkspaceMetadataWriteUnitOfWork,
{
    match writes
        .update_metadata(actor, workspace_id, &edit, now_ms)
        .await?
    {
        WorkspaceMetadataWrite::NoSuchWorkspace => Ok(WorkspaceMetadataUpdate::NoSuchWorkspace),
        WorkspaceMetadataWrite::Forbidden => Ok(WorkspaceMetadataUpdate::Forbidden),
        WorkspaceMetadataWrite::NameTaken => Ok(WorkspaceMetadataUpdate::NameTaken),
        WorkspaceMetadataWrite::Committed {
            face,
            prior,
            committed_name_key,
        } => {
            // Seal the fact and DERIVE the name-change gate from the write's own
            // witnesses (before-image + committed key), rather than trusting an
            // adapter-supplied verdict.
            let name_change = seal_metadata_write_fact(
                workspace_id,
                &edit,
                &face,
                &prior,
                &committed_name_key,
                now_ms,
            )?;
            Ok(WorkspaceMetadataUpdate::Committed(
                CommittedWorkspaceMetadata { face, name_change },
            ))
        }
    }
}

/// Archive or un-archive a regular workspace.
///
/// The write self-decides governance (the `Owner` floor) under its own lock and
/// always commits when authorized (bumping `updated_at`), recording whether the
/// archived state flipped. The returned fact is [sealed](seal_archive_write_fact)
/// against the request before the outcome is minted.
pub async fn archive_workspace<W>(
    writes: &W,
    actor: Principal,
    workspace_id: &WorkspaceId,
    archived: bool,
    now_ms: i64,
) -> Result<WorkspaceArchiveUpdate, WorkspaceMetadataWriteError>
where
    W: WorkspaceMetadataWriteUnitOfWork,
{
    match writes
        .set_archived(actor, workspace_id, archived, now_ms)
        .await?
    {
        WorkspaceArchiveWrite::NoSuchWorkspace => Ok(WorkspaceArchiveUpdate::NoSuchWorkspace),
        WorkspaceArchiveWrite::Forbidden => Ok(WorkspaceArchiveUpdate::Forbidden),
        WorkspaceArchiveWrite::Committed { face } => {
            seal_archive_write_fact(workspace_id, archived, &face, now_ms)?;
            Ok(WorkspaceArchiveUpdate::Committed(ArchivedWorkspace {
                face,
            }))
        }
    }
}

/// The post-commit obligation THIS write context owns: when a rename COMMITS,
/// every human read model that renders the workspace label from OUTSIDE any one
/// channel — the workspace list, the Saved/Task joins keyed on `['workspaces']`,
/// Search's frozen label copy — must be told to refetch. The route fans a
/// `viewer_workspaces_changed { metadata_changed }` hint to each human member,
/// who then re-reads `GET /api/workspaces` as the authority.
///
/// The hint carries only the workspace id — never a projected value — so it is a
/// cache-INVALIDATION signal, not a second identity/value channel: nothing
/// downstream trusts its payload for anything but "refetch this workspace's
/// readers". That is why it can safely fire post-commit off the sealed
/// [`WorkspaceNameChange`] gate without re-reading anything.
///
/// This is a SEPARATE port from [`crate::identity_access::access::ViewerWorkspacesChangedSink`],
/// not a second method on it. That sink announces the `added` change on the
/// enrollment write's commit and carries the new `role`; this one announces
/// `metadata_changed` on the rename write's commit and has no role. They share a
/// wire event FAMILY but are owed by different bounded contexts on different
/// facts, and the production adapter that carries this arm ([#task:2215]'s
/// `ScopeEventHub`) composes it independently. Fusing them would make a rename
/// obligation ride the enrollment sink and force this context to invent a role it
/// does not have.
///
/// Firing is gated by the sealed [`WorkspaceNameChange`]: the sink is called iff
/// the committed fact carries one (the display name actually moved). A
/// description-only edit, a rename to the identical display name, and an archive
/// owe NOTHING — the write commits regardless, but no label moved, so no read
/// model is stale.
pub trait WorkspaceMetadataChangedSink: Clone + Send + Sync + 'static {
    fn workspace_metadata_changed(
        &self,
        workspace_id: &WorkspaceId,
    ) -> impl Future<Output = Result<(), WorkspaceMetadataAnnounceFailure>> + Send;
}

/// An outward `metadata_changed` announce could not be delivered. Opaque like
/// [`PersistenceFailure`] and [`crate::identity_access::access::ViewerAnnounceFailure`], and for
/// the same reason — the transport's concrete error stays available as the
/// `source` for the boundary that records it, while no transport type leaks into
/// this context.
///
/// Deliberately NOT a [`PersistenceFailure`]: announcing is not storing. A
/// transport that could not reach a reader has lost a cache hint, not corrupted a
/// fact, and calling it persistence would send a reader looking for a database
/// problem that is not there.
#[derive(Debug, Error)]
#[error("workspace metadata-changed announce could not be delivered")]
pub struct WorkspaceMetadataAnnounceFailure {
    #[source]
    source: Box<dyn std::error::Error + Send + Sync + 'static>,
}

impl WorkspaceMetadataAnnounceFailure {
    pub fn from_source<E>(source: E) -> Self
    where
        E: std::error::Error + Send + Sync + 'static,
    {
        Self {
            source: Box::new(source),
        }
    }
}

/// What became of the post-commit `metadata_changed` announce — a value the write
/// hands back rather than a `Result` its caller may quietly drop. The rename is
/// committed either way and nothing here can unhappen it; mirroring
/// [`crate::identity_access::access::ViewerAnnounce`], the three arms are the three distinct facts a
/// boundary may need to record.
#[derive(Debug)]
pub enum WorkspaceMetadataAnnounce {
    /// No announce was owed: this edit changed no display name (a description-only
    /// edit, or a rename to the identical display name), so the sink was never
    /// called. Distinct from `Delivered`: there was nothing to deliver.
    NotOwed,
    /// The announce was owed (the display name moved) and the sink accepted it.
    Delivered,
    /// The announce was owed and could not be delivered. The rename is committed
    /// regardless; the affected readers simply were not told, so their read models
    /// stay stale until they refetch for another reason.
    Failed(WorkspaceMetadataAnnounceFailure),
}

/// A committed metadata update together with the fate of its `metadata_changed`
/// announce.
///
/// The three travel together because they are one request's outcome: the committed
/// face is the product answer (the `200` body), the announce is the id-only
/// cache-invalidation side obligation THIS context owns and already discharged
/// (not owed, met, or lost), and the [`WorkspaceNameChange`] is the sealed address
/// pair a rename left. The name-change gate is surfaced — not consumed here — so
/// the boundary that owns the SEPARATE messaging context (the per-channel rename
/// system message) and the audit (`logWorkspaceAddressAssignment`) can drive them
/// off the same committed fact: this context fires the viewer hint it owns and
/// hands the gate onward rather than reaching across into messaging. It is `Some`
/// exactly when the display name moved (and then the announce is `Delivered` or
/// `Failed`); a description-only or same-name edit leaves it `None` (and the
/// announce `NotOwed`). The fields are SEALED and reachable only through
/// [`into_parts`](Self::into_parts), which yields all three at once — so a boundary
/// cannot take the face to serve the wire while letting the announce fate fall on
/// the floor unrecorded or the rename fan-out go undone, the same discipline as
/// [`crate::identity_access::access::HumanEnrollmentOutcome`].
#[derive(Debug)]
#[must_use = "a committed metadata update carries an announce outcome and a rename gate that must be handled"]
pub struct AnnouncedWorkspaceMetadata {
    face: WorkspaceFace,
    name_change: Option<WorkspaceNameChange>,
    announce: WorkspaceMetadataAnnounce,
}

impl AnnouncedWorkspaceMetadata {
    /// Split into the committed face (for the wire), the sealed name-change gate
    /// (the address pair a rename left, for the messaging fan-out and the audit —
    /// `None` when no display name moved), and the fate of the viewer hint (to
    /// record) at once — the only door in, so a caller that wants the face
    /// necessarily receives the gate and the announce in the same move.
    pub fn into_parts(
        self,
    ) -> (
        WorkspaceFace,
        Option<WorkspaceNameChange>,
        WorkspaceMetadataAnnounce,
    ) {
        (self.face, self.name_change, self.announce)
    }
}

/// The closed outcome of [`update_workspace_metadata_and_announce`]: the sealed
/// commit-plus-announce, or one of the three refusals that owe no announce because
/// nothing committed.
#[allow(clippy::large_enum_variant)] // `Committed` carries the whole face; see `WorkspaceMetadataWrite`.
#[derive(Debug)]
pub enum WorkspaceMetadataUpdateWithAnnounce {
    /// The edit committed; carries the sealed face and its announce fate.
    Committed(AnnouncedWorkspaceMetadata),
    /// The requested name is held by another regular workspace — the surface's `409`.
    NameTaken,
    /// The caller lacked the `Admin` governance floor — the surface's `403`.
    Forbidden,
    /// No such regular workspace — the surface's `404`.
    NoSuchWorkspace,
}

/// Rename/describe a regular workspace AND fire the `metadata_changed` fan-out the
/// commit owes — the composed use case the `PATCH /api/workspaces/:id` route drives.
///
/// This layers the post-commit obligation onto the pure write
/// [`update_workspace_metadata`] WITHOUT re-deciding anything the write already
/// sealed: it consumes the write's sealed [`WorkspaceNameChange`] gate and fires
/// the sink iff a display name actually moved. The obligation lives HERE, in the
/// domain, rather than in the HTTP handler — the same placement as the profile
/// write's `user_changed` announce and the enrollment write's `added` announce —
/// so any caller that commits a rename necessarily carries the announce fate, and
/// the rule "a rename owes a hint, a description-only edit does not" is proven in
/// this layer's own tests rather than restated at each transport.
///
/// The announce is best-effort: a [`WorkspaceMetadataAnnounce::Failed`] never
/// downgrades the committed rename to an error — it is carried back as a value to
/// be recorded, exactly like the enrollment announce. Only the pure write's own
/// faults (`Persistence` / `UntrustworthyWriteFact`) surface as
/// [`WorkspaceMetadataWriteError`].
pub async fn update_workspace_metadata_and_announce<W, S>(
    writes: &W,
    announce_sink: &S,
    actor: Principal,
    workspace_id: &WorkspaceId,
    edit: WorkspaceMetadataEdit,
    now_ms: i64,
) -> Result<WorkspaceMetadataUpdateWithAnnounce, WorkspaceMetadataWriteError>
where
    W: WorkspaceMetadataWriteUnitOfWork,
    S: WorkspaceMetadataChangedSink,
{
    match update_workspace_metadata(writes, actor, workspace_id, edit, now_ms).await? {
        WorkspaceMetadataUpdate::NoSuchWorkspace => {
            Ok(WorkspaceMetadataUpdateWithAnnounce::NoSuchWorkspace)
        }
        WorkspaceMetadataUpdate::Forbidden => Ok(WorkspaceMetadataUpdateWithAnnounce::Forbidden),
        WorkspaceMetadataUpdate::NameTaken => Ok(WorkspaceMetadataUpdateWithAnnounce::NameTaken),
        WorkspaceMetadataUpdate::Committed(committed) => {
            // Take the sealed face and its name-change gate together; the gate is
            // the sole authority on whether the fan-out is owed.
            let (face, name_change) = committed.into_parts();
            let announce = match &name_change {
                // A real rename: the hint is owed. Fire it against the request's
                // own workspace id (which the seal already bound to `face.id`), and
                // carry the delivery fate — a failure is recorded, never a rollback.
                Some(_) => match announce_sink.workspace_metadata_changed(workspace_id).await {
                    Ok(()) => WorkspaceMetadataAnnounce::Delivered,
                    Err(failure) => WorkspaceMetadataAnnounce::Failed(failure),
                },
                // Description-only, or a rename to the same display name: no label
                // moved, so no read model is stale and nothing is owed.
                None => WorkspaceMetadataAnnounce::NotOwed,
            };
            Ok(WorkspaceMetadataUpdateWithAnnounce::Committed(
                AnnouncedWorkspaceMetadata {
                    face,
                    name_change,
                    announce,
                },
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{AgentId, UserId};

    /// The write instant every committed-path test samples: a committed face's
    /// `updated_at` (and an archived face's `archived_at`) must equal it, or the seal
    /// refuses the fact.
    const NOW: i64 = 1_000;

    fn workspace_id() -> WorkspaceId {
        WorkspaceId::parse("workspace-1").unwrap()
    }

    fn name(raw: &str) -> CanonicalWorkspaceName {
        CanonicalWorkspaceName::parse(raw).unwrap()
    }

    /// A regular-workspace face with a chosen id and display name, stamped at the
    /// [`NOW`] write instant; the fields the seal inspects are explicit, the rest are
    /// inert defaults.
    fn regular_face(id: &str, display_name: &str) -> WorkspaceFace {
        WorkspaceFace {
            id: WorkspaceId::parse(id).unwrap(),
            name: display_name.to_owned(),
            description: None,
            owner_agent_id: None,
            owner_user_id: None,
            dm_channel_id: None,
            dm_channel_ids: Vec::new(),
            archived_at: None,
            created_at: 1,
            updated_at: NOW,
        }
    }

    /// The before-image `{name, key}` an adapter reports for a workspace whose
    /// display was `display` and whose fold key was `display`'s canonical key.
    fn prior_of(display: &str) -> PriorWorkspaceAddress {
        PriorWorkspaceAddress {
            name: display.to_owned(),
            key: name(display).key().to_owned(),
        }
    }

    /// A write port that replays one chosen outcome for each method.
    #[derive(Clone)]
    struct FakeWrites {
        metadata: WorkspaceMetadataWrite,
        archive: WorkspaceArchiveWrite,
    }

    impl FakeWrites {
        fn on_metadata(metadata: WorkspaceMetadataWrite) -> Self {
            Self {
                metadata,
                archive: WorkspaceArchiveWrite::NoSuchWorkspace,
            }
        }

        fn on_archive(archive: WorkspaceArchiveWrite) -> Self {
            Self {
                metadata: WorkspaceMetadataWrite::NoSuchWorkspace,
                archive,
            }
        }
    }

    impl WorkspaceMetadataWriteUnitOfWork for FakeWrites {
        async fn update_metadata(
            &self,
            _actor: Principal,
            _workspace_id: &WorkspaceId,
            _edit: &WorkspaceMetadataEdit,
            _now_ms: i64,
        ) -> Result<WorkspaceMetadataWrite, PersistenceFailure> {
            Ok(self.metadata.clone())
        }

        async fn set_archived(
            &self,
            _actor: Principal,
            _workspace_id: &WorkspaceId,
            _archived: bool,
            _now_ms: i64,
        ) -> Result<WorkspaceArchiveWrite, PersistenceFailure> {
            Ok(self.archive.clone())
        }
    }

    fn system() -> Principal {
        Principal::System
    }

    // ---- metadata seal: the happy paths ----

    #[tokio::test]
    async fn a_rename_commits_with_the_name_change_gate_set() {
        let writes = FakeWrites::on_metadata(WorkspaceMetadataWrite::Committed {
            face: regular_face("workspace-1", "Design Team"),
            prior: PriorWorkspaceAddress {
                name: "Old".to_owned(),
                key: "old".to_owned(),
            },
            committed_name_key: name("Design Team").key().to_owned(),
        });
        let outcome = update_workspace_metadata(
            &writes,
            system(),
            &workspace_id(),
            WorkspaceMetadataEdit::Name(name("Design Team")),
            NOW,
        )
        .await
        .unwrap();
        let WorkspaceMetadataUpdate::Committed(committed) = outcome else {
            panic!("expected Committed");
        };
        let (face, name_change) = committed.into_parts();
        assert_eq!(face.name, "Design Team");
        let change = name_change.expect("a real rename carries the fan-out gate");
        // The address pair is DERIVED: old_* from the witnessed before-image, new_*
        // from the committed face and key.
        assert_eq!(change.old_name, "Old");
        assert_eq!(change.old_key, "old");
        assert_eq!(change.new_name, "Design Team");
        assert_eq!(change.new_key, name("Design Team").key());
    }

    #[tokio::test]
    async fn a_description_only_edit_commits_with_no_name_change_gate() {
        let mut face = regular_face("workspace-1", "Unchanged");
        face.description = Some("hello".to_owned());
        let writes = FakeWrites::on_metadata(WorkspaceMetadataWrite::Committed {
            face,
            // A description-only edit leaves the address untouched: the before-image
            // and the committed key both equal the current "Unchanged" address.
            prior: prior_of("Unchanged"),
            committed_name_key: name("Unchanged").key().to_owned(),
        });
        let outcome = update_workspace_metadata(
            &writes,
            system(),
            &workspace_id(),
            WorkspaceMetadataEdit::Description(Some("hello".to_owned())),
            NOW,
        )
        .await
        .unwrap();
        let WorkspaceMetadataUpdate::Committed(committed) = outcome else {
            panic!("expected Committed");
        };
        let (face, name_change) = committed.into_parts();
        assert!(
            name_change.is_none(),
            "a description-only edit owes no rename fan-out"
        );
        assert_eq!(face.description.as_deref(), Some("hello"));
    }

    #[tokio::test]
    async fn a_no_op_rename_to_the_same_display_name_commits_without_a_gate() {
        // The edit supplied a name equal to the current display, so the write still
        // committed (updated_at bumped) but the fan-out gate is None because the
        // before-image display equals the committed display.
        let writes = FakeWrites::on_metadata(WorkspaceMetadataWrite::Committed {
            face: regular_face("workspace-1", "Same"),
            prior: prior_of("Same"),
            committed_name_key: name("Same").key().to_owned(),
        });
        let outcome = update_workspace_metadata(
            &writes,
            system(),
            &workspace_id(),
            WorkspaceMetadataEdit::Name(name("Same")),
            NOW,
        )
        .await
        .unwrap();
        let WorkspaceMetadataUpdate::Committed(committed) = outcome else {
            panic!("expected Committed");
        };
        let (_face, name_change) = committed.into_parts();
        assert!(name_change.is_none());
    }

    #[tokio::test]
    async fn the_product_refusals_pass_through_unsealed() {
        for (raw, want) in [
            (WorkspaceMetadataWrite::NoSuchWorkspace, "no-such"),
            (WorkspaceMetadataWrite::Forbidden, "forbidden"),
            (WorkspaceMetadataWrite::NameTaken, "name-taken"),
        ] {
            let writes = FakeWrites::on_metadata(raw);
            let outcome = update_workspace_metadata(
                &writes,
                system(),
                &workspace_id(),
                WorkspaceMetadataEdit::Name(name("Anything")),
                0,
            )
            .await
            .unwrap();
            let got = match outcome {
                WorkspaceMetadataUpdate::NoSuchWorkspace => "no-such",
                WorkspaceMetadataUpdate::Forbidden => "forbidden",
                WorkspaceMetadataUpdate::NameTaken => "name-taken",
                WorkspaceMetadataUpdate::Committed(_) => "committed",
            };
            assert_eq!(got, want);
        }
    }

    // ---- metadata seal: the falsifiers ----

    async fn assert_metadata_untrustworthy(
        write: WorkspaceMetadataWrite,
        edit: WorkspaceMetadataEdit,
    ) {
        let writes = FakeWrites::on_metadata(write);
        let result = update_workspace_metadata(&writes, system(), &workspace_id(), edit, NOW).await;
        assert!(
            matches!(
                result,
                Err(WorkspaceMetadataWriteError::UntrustworthyWriteFact)
            ),
            "expected an untrustworthy-fact seal violation, got {result:?}"
        );
    }

    #[tokio::test]
    async fn a_committed_fact_for_a_foreign_workspace_is_sealed_off() {
        assert_metadata_untrustworthy(
            WorkspaceMetadataWrite::Committed {
                face: regular_face("workspace-2", "Design Team"),
                prior: prior_of("Old Name"),
                committed_name_key: name("Design Team").key().to_owned(),
            },
            WorkspaceMetadataEdit::Name(name("Design Team")),
        )
        .await;
    }

    #[tokio::test]
    async fn a_committed_fact_that_wrote_a_different_name_is_sealed_off() {
        assert_metadata_untrustworthy(
            WorkspaceMetadataWrite::Committed {
                face: regular_face("workspace-1", "Something Else"),
                prior: prior_of("Old Name"),
                committed_name_key: name("Something Else").key().to_owned(),
            },
            WorkspaceMetadataEdit::Name(name("Design Team")),
        )
        .await;
    }

    #[tokio::test]
    async fn a_committed_fact_that_wrote_a_different_description_is_sealed_off() {
        let mut face = regular_face("workspace-1", "Unchanged");
        face.description = Some("not what was asked".to_owned());
        assert_metadata_untrustworthy(
            WorkspaceMetadataWrite::Committed {
                face,
                prior: prior_of("Unchanged"),
                committed_name_key: name("Unchanged").key().to_owned(),
            },
            WorkspaceMetadataEdit::Description(Some("please store this".to_owned())),
        )
        .await;
    }

    #[tokio::test]
    async fn a_home_workspace_reported_as_a_regular_metadata_commit_is_sealed_off() {
        let mut face = regular_face("workspace-1", "Design Team");
        face.owner_agent_id = Some(AgentId::parse("agent-1").unwrap());
        assert_metadata_untrustworthy(
            WorkspaceMetadataWrite::Committed {
                face,
                prior: prior_of("Old Name"),
                committed_name_key: name("Design Team").key().to_owned(),
            },
            WorkspaceMetadataEdit::Name(name("Design Team")),
        )
        .await;
    }

    #[tokio::test]
    async fn a_committed_name_key_that_is_not_the_requested_fold_is_sealed_off() {
        // The committed display agrees with the request, but the committed address key
        // is not the fold of the requested name — an adapter that bound or read back
        // the wrong `name_key` must be refused before the row is trusted, because the
        // face never publishes the key and no other check would catch it.
        assert_metadata_untrustworthy(
            WorkspaceMetadataWrite::Committed {
                face: regular_face("workspace-1", "Design Team"),
                prior: prior_of("Old Name"),
                committed_name_key: "a-key-that-is-not-the-fold".to_owned(),
            },
            WorkspaceMetadataEdit::Name(name("Design Team")),
        )
        .await;
    }

    #[tokio::test]
    async fn an_updated_at_that_is_not_the_write_instant_is_sealed_off() {
        // The write always bumps `updated_at` to the sampled instant; a committed fact
        // carrying a different stamp did not come from this write.
        let mut face = regular_face("workspace-1", "Design Team");
        face.updated_at = NOW + 1;
        assert_metadata_untrustworthy(
            WorkspaceMetadataWrite::Committed {
                face,
                prior: prior_of("Old Name"),
                committed_name_key: name("Design Team").key().to_owned(),
            },
            WorkspaceMetadataEdit::Name(name("Design Team")),
        )
        .await;
    }

    #[tokio::test]
    async fn a_description_only_edit_whose_committed_display_moved_is_sealed_off() {
        // A description-only edit must leave the address alone; a committed display
        // that moved off the before-image means the adapter renamed a workspace the
        // request never asked to rename.
        let mut face = regular_face("workspace-1", "Moved Away");
        face.description = Some("desc".to_owned());
        assert_metadata_untrustworthy(
            WorkspaceMetadataWrite::Committed {
                face,
                prior: prior_of("Original"),
                committed_name_key: name("Original").key().to_owned(),
            },
            WorkspaceMetadataEdit::Description(Some("desc".to_owned())),
        )
        .await;
    }

    #[tokio::test]
    async fn a_description_only_edit_that_changed_the_committed_key_is_sealed_off() {
        // The committed display equals the before-image, but the committed fold key
        // moved — a description-only edit may not re-address the workspace.
        let mut face = regular_face("workspace-1", "Same");
        face.description = Some("desc".to_owned());
        assert_metadata_untrustworthy(
            WorkspaceMetadataWrite::Committed {
                face,
                prior: prior_of("Same"),
                committed_name_key: "a-different-key".to_owned(),
            },
            WorkspaceMetadataEdit::Description(Some("desc".to_owned())),
        )
        .await;
    }

    #[tokio::test]
    async fn a_metadata_persistence_fault_is_a_safe_500_not_a_product_arm() {
        #[derive(Clone)]
        struct FaultingWrites;
        #[derive(Debug, Error)]
        #[error("stub metadata fault")]
        struct StubFault;
        impl WorkspaceMetadataWriteUnitOfWork for FaultingWrites {
            async fn update_metadata(
                &self,
                _actor: Principal,
                _workspace_id: &WorkspaceId,
                _edit: &WorkspaceMetadataEdit,
                _now_ms: i64,
            ) -> Result<WorkspaceMetadataWrite, PersistenceFailure> {
                Err(PersistenceFailure::from_source(StubFault))
            }
            async fn set_archived(
                &self,
                _actor: Principal,
                _workspace_id: &WorkspaceId,
                _archived: bool,
                _now_ms: i64,
            ) -> Result<WorkspaceArchiveWrite, PersistenceFailure> {
                Err(PersistenceFailure::from_source(StubFault))
            }
        }
        let result = update_workspace_metadata(
            &FaultingWrites,
            system(),
            &workspace_id(),
            WorkspaceMetadataEdit::Name(name("Design Team")),
            0,
        )
        .await;
        assert!(matches!(
            result,
            Err(WorkspaceMetadataWriteError::Persistence(_))
        ));
    }

    // ---- archive seal ----

    #[tokio::test]
    async fn an_archive_commits_and_stamps_archived_at() {
        let mut face = regular_face("workspace-1", "Design Team");
        face.archived_at = Some(NOW);
        let writes = FakeWrites::on_archive(WorkspaceArchiveWrite::Committed { face });
        let outcome = archive_workspace(&writes, system(), &workspace_id(), true, NOW)
            .await
            .unwrap();
        let WorkspaceArchiveUpdate::Committed(archived) = outcome else {
            panic!("expected Committed");
        };
        assert_eq!(archived.face().archived_at, Some(NOW));
    }

    #[tokio::test]
    async fn an_unarchive_commits_with_a_null_archived_at() {
        let writes = FakeWrites::on_archive(WorkspaceArchiveWrite::Committed {
            face: regular_face("workspace-1", "Design Team"),
        });
        let outcome = archive_workspace(&writes, system(), &workspace_id(), false, NOW)
            .await
            .unwrap();
        let WorkspaceArchiveUpdate::Committed(archived) = outcome else {
            panic!("expected Committed");
        };
        assert!(archived.face().archived_at.is_none());
    }

    #[tokio::test]
    async fn a_committed_archive_whose_state_disagrees_with_the_request_is_sealed_off() {
        // Requested archive=true but the committed row carries no archived_at: the
        // adapter's fact contradicts the write it claimed to perform.
        let writes = FakeWrites::on_archive(WorkspaceArchiveWrite::Committed {
            face: regular_face("workspace-1", "Design Team"),
        });
        let result = archive_workspace(&writes, system(), &workspace_id(), true, NOW).await;
        assert!(matches!(
            result,
            Err(WorkspaceMetadataWriteError::UntrustworthyWriteFact)
        ));
    }

    #[tokio::test]
    async fn a_committed_archive_whose_archived_at_is_not_the_write_instant_is_sealed_off() {
        // Archived, but stamped at some other instant than the sampled write time —
        // the fact did not come from this write.
        let mut face = regular_face("workspace-1", "Design Team");
        face.archived_at = Some(NOW - 1);
        let writes = FakeWrites::on_archive(WorkspaceArchiveWrite::Committed { face });
        let result = archive_workspace(&writes, system(), &workspace_id(), true, NOW).await;
        assert!(matches!(
            result,
            Err(WorkspaceMetadataWriteError::UntrustworthyWriteFact)
        ));
    }

    #[tokio::test]
    async fn a_committed_archive_whose_updated_at_is_not_the_write_instant_is_sealed_off() {
        let mut face = regular_face("workspace-1", "Design Team");
        face.archived_at = Some(NOW);
        face.updated_at = NOW + 5;
        let writes = FakeWrites::on_archive(WorkspaceArchiveWrite::Committed { face });
        let result = archive_workspace(&writes, system(), &workspace_id(), true, NOW).await;
        assert!(matches!(
            result,
            Err(WorkspaceMetadataWriteError::UntrustworthyWriteFact)
        ));
    }

    #[tokio::test]
    async fn a_committed_archive_for_a_foreign_workspace_is_sealed_off() {
        let mut face = regular_face("workspace-2", "Design Team");
        face.archived_at = Some(NOW);
        let writes = FakeWrites::on_archive(WorkspaceArchiveWrite::Committed { face });
        let result = archive_workspace(&writes, system(), &workspace_id(), true, NOW).await;
        assert!(matches!(
            result,
            Err(WorkspaceMetadataWriteError::UntrustworthyWriteFact)
        ));
    }

    #[tokio::test]
    async fn archive_product_refusals_pass_through() {
        let human = Principal::Human {
            user_id: UserId::parse("user-1").unwrap(),
        };
        for (raw, want) in [
            (WorkspaceArchiveWrite::NoSuchWorkspace, "no-such"),
            (WorkspaceArchiveWrite::Forbidden, "forbidden"),
        ] {
            let writes = FakeWrites::on_archive(raw);
            let outcome = archive_workspace(&writes, human.clone(), &workspace_id(), true, NOW)
                .await
                .unwrap();
            let got = match outcome {
                WorkspaceArchiveUpdate::NoSuchWorkspace => "no-such",
                WorkspaceArchiveUpdate::Forbidden => "forbidden",
                WorkspaceArchiveUpdate::Committed(_) => "committed",
            };
            assert_eq!(got, want);
        }
    }

    // ---- the announce wrapper: the fan-out gate and best-effort semantics ----

    /// A `metadata_changed` sink that counts calls and can be made to fail. The
    /// counter is what makes "fires iff the display name moved" load-bearing: a
    /// wrapper that fired on the wrong gate would call it when it must not, or skip
    /// it when it must.
    #[derive(Clone)]
    struct FakeSink {
        calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        fail: bool,
    }

    impl FakeSink {
        fn new(fail: bool) -> Self {
            Self {
                calls: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                fail,
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl WorkspaceMetadataChangedSink for FakeSink {
        async fn workspace_metadata_changed(
            &self,
            _workspace_id: &WorkspaceId,
        ) -> Result<(), WorkspaceMetadataAnnounceFailure> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.fail {
                #[derive(Debug, thiserror::Error)]
                #[error("transport down")]
                struct TransportDown;
                Err(WorkspaceMetadataAnnounceFailure::from_source(TransportDown))
            } else {
                Ok(())
            }
        }
    }

    #[tokio::test]
    async fn a_committed_rename_fires_the_hint_exactly_once_and_reports_delivered() {
        let writes = FakeWrites::on_metadata(WorkspaceMetadataWrite::Committed {
            face: regular_face("workspace-1", "Design Team"),
            prior: PriorWorkspaceAddress {
                name: "Old".to_owned(),
                key: "old".to_owned(),
            },
            committed_name_key: name("Design Team").key().to_owned(),
        });
        let sink = FakeSink::new(false);
        let outcome = update_workspace_metadata_and_announce(
            &writes,
            &sink,
            system(),
            &workspace_id(),
            WorkspaceMetadataEdit::Name(name("Design Team")),
            NOW,
        )
        .await
        .unwrap();
        let WorkspaceMetadataUpdateWithAnnounce::Committed(announced) = outcome else {
            panic!("expected Committed");
        };
        let (face, name_change, announce) = announced.into_parts();
        assert_eq!(face.name, "Design Team");
        let change = name_change.expect("a real rename surfaces its address pair for the fan-out");
        assert_eq!(change.old_name, "Old");
        assert_eq!(change.new_name, "Design Team");
        assert!(matches!(announce, WorkspaceMetadataAnnounce::Delivered));
        assert_eq!(sink.calls(), 1, "a real rename fires the hint exactly once");
    }

    #[tokio::test]
    async fn a_description_only_edit_owes_no_hint_and_never_calls_the_sink() {
        let mut face = regular_face("workspace-1", "Unchanged");
        face.description = Some("hello".to_owned());
        let writes = FakeWrites::on_metadata(WorkspaceMetadataWrite::Committed {
            face,
            prior: prior_of("Unchanged"),
            committed_name_key: name("Unchanged").key().to_owned(),
        });
        let sink = FakeSink::new(false);
        let outcome = update_workspace_metadata_and_announce(
            &writes,
            &sink,
            system(),
            &workspace_id(),
            WorkspaceMetadataEdit::Description(Some("hello".to_owned())),
            NOW,
        )
        .await
        .unwrap();
        let WorkspaceMetadataUpdateWithAnnounce::Committed(announced) = outcome else {
            panic!("expected Committed");
        };
        let (_face, name_change, announce) = announced.into_parts();
        assert!(
            name_change.is_none(),
            "a description-only edit surfaces no address pair"
        );
        assert!(matches!(announce, WorkspaceMetadataAnnounce::NotOwed));
        assert_eq!(
            sink.calls(),
            0,
            "a description-only edit moved no label, so the sink is never called"
        );
    }

    #[tokio::test]
    async fn a_no_op_rename_to_the_same_display_name_owes_no_hint() {
        // The write committed (updated_at bumped) but the gate is None, so no hint.
        let writes = FakeWrites::on_metadata(WorkspaceMetadataWrite::Committed {
            face: regular_face("workspace-1", "Same"),
            prior: prior_of("Same"),
            committed_name_key: name("Same").key().to_owned(),
        });
        let sink = FakeSink::new(false);
        let outcome = update_workspace_metadata_and_announce(
            &writes,
            &sink,
            system(),
            &workspace_id(),
            WorkspaceMetadataEdit::Name(name("Same")),
            NOW,
        )
        .await
        .unwrap();
        let WorkspaceMetadataUpdateWithAnnounce::Committed(announced) = outcome else {
            panic!("expected Committed");
        };
        let (_face, name_change, announce) = announced.into_parts();
        assert!(name_change.is_none());
        assert!(matches!(announce, WorkspaceMetadataAnnounce::NotOwed));
        assert_eq!(sink.calls(), 0);
    }

    #[tokio::test]
    async fn a_failed_hint_is_carried_as_a_value_and_never_flips_the_commit() {
        let writes = FakeWrites::on_metadata(WorkspaceMetadataWrite::Committed {
            face: regular_face("workspace-1", "Design Team"),
            prior: PriorWorkspaceAddress {
                name: "Old".to_owned(),
                key: "old".to_owned(),
            },
            committed_name_key: name("Design Team").key().to_owned(),
        });
        let sink = FakeSink::new(true);
        let outcome = update_workspace_metadata_and_announce(
            &writes,
            &sink,
            system(),
            &workspace_id(),
            WorkspaceMetadataEdit::Name(name("Design Team")),
            NOW,
        )
        .await
        .unwrap();
        // The rename still committed: the outcome is Committed, and the failure is a
        // recorded value on the announce, not an Err and not a lost commit.
        let WorkspaceMetadataUpdateWithAnnounce::Committed(announced) = outcome else {
            panic!("a failed announce must not turn the commit into a refusal");
        };
        let (face, name_change, announce) = announced.into_parts();
        assert_eq!(face.name, "Design Team");
        assert!(
            name_change.is_some(),
            "the rename committed, so its address pair is still surfaced even when the hint failed"
        );
        assert!(matches!(announce, WorkspaceMetadataAnnounce::Failed(_)));
        assert_eq!(sink.calls(), 1);
    }

    #[tokio::test]
    async fn the_wrapper_passes_refusals_through_and_never_announces() {
        for (raw, want) in [
            (WorkspaceMetadataWrite::NoSuchWorkspace, "no-such"),
            (WorkspaceMetadataWrite::Forbidden, "forbidden"),
            (WorkspaceMetadataWrite::NameTaken, "name-taken"),
        ] {
            let writes = FakeWrites::on_metadata(raw);
            let sink = FakeSink::new(false);
            let outcome = update_workspace_metadata_and_announce(
                &writes,
                &sink,
                system(),
                &workspace_id(),
                WorkspaceMetadataEdit::Name(name("Anything")),
                0,
            )
            .await
            .unwrap();
            let got = match outcome {
                WorkspaceMetadataUpdateWithAnnounce::NoSuchWorkspace => "no-such",
                WorkspaceMetadataUpdateWithAnnounce::Forbidden => "forbidden",
                WorkspaceMetadataUpdateWithAnnounce::NameTaken => "name-taken",
                WorkspaceMetadataUpdateWithAnnounce::Committed(_) => "committed",
            };
            assert_eq!(got, want);
            assert_eq!(
                sink.calls(),
                0,
                "a refusal committed nothing, so nothing is announced"
            );
        }
    }

    #[tokio::test]
    async fn a_write_fault_surfaces_as_an_error_and_never_announces() {
        // A committed fact for a foreign workspace fails the seal inside the pure
        // write; the wrapper must propagate that Err and never reach the sink.
        let writes = FakeWrites::on_metadata(WorkspaceMetadataWrite::Committed {
            face: regular_face("workspace-2", "Design Team"),
            prior: prior_of("Old Name"),
            committed_name_key: name("Design Team").key().to_owned(),
        });
        let sink = FakeSink::new(false);
        let result = update_workspace_metadata_and_announce(
            &writes,
            &sink,
            system(),
            &workspace_id(),
            WorkspaceMetadataEdit::Name(name("Design Team")),
            NOW,
        )
        .await;
        assert!(matches!(
            result,
            Err(WorkspaceMetadataWriteError::UntrustworthyWriteFact)
        ));
        assert_eq!(sink.calls(), 0, "an untrustworthy write never fans out");
    }
}
