//! The single-workspace detail read: `GET /api/workspaces/:id`.
//!
//! This is a VISIBILITY read, not a governance one. The product's
//! `canViewWorkspace` for a human principal reduces to `isWorkspaceMember`, so a
//! plain member may read a workspace's published face. The governance role that
//! decides who may rename, archive or delete a workspace is a SEPARATE authority
//! ([`crate::identity_access::access::WorkspaceGovernance`]) that deliberately never gates this
//! read — a member with no admin standing still sees the face. Conflating the two
//! would smuggle a governance floor into data visibility.
//!
//! Existence is resolved BEFORE visibility, exactly as the TypeScript route
//! (`workspaces.get` then `canViewWorkspace`): a workspace that is not there is
//! `404` for everyone, and only a present one is graded — a non-member then sees
//! `403`, observably distinct from `404`. That ordering is a property of the pure
//! rule below, not of the adapter's read sequence, so it holds no matter how the
//! two facts are fetched.
//!
//! ## The success path is IDENTITY-SEALED
//!
//! A read adapter is not trusted to hand back a face for the workspace the caller
//! asked about, or a membership computed for the viewer the perimeter
//! authenticated. It is therefore not trusted to VERDICT the read at all: the port
//! ([`WorkspaceDetailReadUnitOfWork`]) returns only the raw read fact — the row's
//! own workspace coordinate (`face.id`) and the `workspace_users.user_id` the
//! membership row matched — and never a [`WorkspaceView`]. Classification is the
//! job of the authenticated boundary, which alone holds the request's `(viewer,
//! workspace_id)`: it calls [`classify_workspace_view`] with THOSE coordinates, and
//! that function — the ONLY minter of a servable face — binds the read fact against
//! them before it will produce a [`WorkspaceView::Visible`]. A row for another
//! workspace, or a membership matched to another subject, is not a `403`/`404`
//! product answer: it is a corrupt or misdirected read fact and takes the safe-500
//! seam.
//!
//! Because the port cannot mint a view, the classic splice is structurally gone: a
//! lying adapter that ignores its arguments and fabricates a self-consistent fact
//! for some OTHER workspace B still only returns raw data, and the boundary
//! classifies it under the authentic request A — where B's coordinate fails the
//! bind. There is no untrusted, pre-classified fact to re-check at the wire because
//! the mint happens at the authenticated request itself.
//!
//! The load-bearing guarantee is that guarantee about WHERE the value is minted,
//! not any property of the value's copyability. [`AuthorizedWorkspaceFace`] has no
//! public constructor, so the ONLY way to obtain one is through
//! [`classify_workspace_view`], which mints it bound to the requested workspace and
//! the authenticated viewer. When the wire boundary accepts nothing but this sealed
//! type, every `200` it can serve was necessarily minted under an authentic
//! `(viewer, workspace_id)` — an unauthorized face is unconstructable, so it cannot
//! be handed to the projector at all. That the type is not `Clone` is a minimal-
//! capability choice, NOT a security root: the classifier can be re-invoked and
//! [`AuthorizedWorkspaceFace::face`] borrows a `WorkspaceFace` the caller may itself
//! clone, so non-`Clone` does not — and is not relied upon to — make the binding
//! unduplicable. The server factory carries the complementary gate that the wire
//! projector's input is this sealed type and nothing wider.

use std::future::Future;

use thiserror::Error;

use crate::{
    foundation::identity::{UserId, WorkspaceId},
    foundation::persistence::PersistenceFailure,
    identity_access::workspace_face::WorkspaceFace,
};

/// A workspace's published face together with the identity facts the read
/// resolved it under. Both are sourced from the row itself, never echoed from the
/// request, so the boundary can hold them against the authenticated request:
///
/// - `face.id` is the workspace coordinate the row actually is.
/// - `membership_subject` is the `workspace_users.user_id` the membership row
///   matched, or `None` when the viewer holds no membership row. A `Some` value
///   that is not the authenticated viewer means the adapter bound the wrong
///   subject — corruption, not a product answer.
///
/// No governance role is carried: visibility is membership, never a role floor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceDetailForViewer {
    pub face: WorkspaceFace,
    pub membership_subject: Option<UserId>,
}

/// A workspace face whose identity has been bound to the authenticated request.
///
/// It is unconstructable outside this module: the ONLY minter is
/// [`classify_workspace_view`], which refuses to produce one unless the read
/// fact's workspace coordinate is the requested workspace and its membership
/// subject is the authenticated viewer. A handler holding this value therefore
/// KNOWS the face it is about to serialize belongs to the very workspace the
/// caller asked for and the very viewer the perimeter authenticated — because the
/// wire boundary accepts nothing but this sealed type, the `200` path cannot serve
/// another tenant's face. It is deliberately NOT `Clone`, but only as a minimal-
/// capability choice: non-`Clone` is NOT what makes the binding trustworthy (the
/// classifier is re-invokable and [`face`](Self::face) borrows a clonable
/// `WorkspaceFace`). The guarantee rests entirely on the sealed constructor plus
/// the wire boundary's sealed-type-only input, not on copyability.
#[derive(Debug, Eq, PartialEq)]
pub struct AuthorizedWorkspaceFace(WorkspaceFace);

impl AuthorizedWorkspaceFace {
    /// The published face, BORROWED for projection. Borrow rather than consume so
    /// the seal outlives the DTO build. There is deliberately no accessor that
    /// hands out an owned [`AuthorizedWorkspaceFace`]; note this does not make the
    /// underlying face uncopyable — the returned `WorkspaceFace` is itself
    /// `Clone` — it only keeps the SEAL (the authorized wrapper) from being minted
    /// anywhere but [`classify_workspace_view`].
    pub fn face(&self) -> &WorkspaceFace {
        &self.0
    }
}

/// The GET-one-workspace verdict, in the product's observable order.
#[derive(Debug, Eq, PartialEq)]
pub enum WorkspaceView {
    /// No workspace answers to the id — `404` for every caller, decided before
    /// visibility is ever consulted.
    NotFound,
    /// The workspace exists but the viewer is not a member — `403`, observably
    /// distinct from `404` so existence is not hidden from a non-member.
    Forbidden,
    /// The viewer is a member and the read fact's identity matched the request:
    /// the identity-sealed face is returned.
    Visible(AuthorizedWorkspaceFace),
}

/// A read fact whose identity does not match the authenticated request. This is
/// never a product refusal: it means the read layer returned a face for a
/// different workspace, or a membership matched to a different subject, than the
/// boundary asked for. It surfaces through the persistence safe-500 seam. The
/// mismatching coordinates are kept for tests and diagnostics, not for the wire.
#[derive(Clone, Debug, Eq, PartialEq, Error)]
pub enum WorkspaceViewIdentityError {
    #[error("workspace detail row identity does not match the requested workspace")]
    WorkspaceCoordinate {
        requested: WorkspaceId,
        found: WorkspaceId,
    },
    #[error("workspace membership subject does not match the authenticated viewer")]
    MembershipSubject { viewer: UserId, matched: UserId },
}

/// The pure boundary rule, and the SOLE minter of an [`AuthorizedWorkspaceFace`].
///
/// The authenticated boundary calls this with the request's OWN `requested` id and
/// `viewer` — never a port's echo — so every path to a `200` binds the raw read
/// fact to the authenticated request: the row's workspace coordinate must be the
/// `requested` id, and any membership subject must be the authenticated `viewer`.
/// A mismatch returns `Err` for the safe-500 seam rather than a product code.
///
/// Existence is still resolved before visibility: `None` is
/// [`WorkspaceView::NotFound`] without consulting membership at all, and a present
/// workspace with no membership subject is [`WorkspaceView::Forbidden`] — so an
/// absent workspace can never leak as a `403`, and a present one is graded purely
/// on membership.
pub fn classify_workspace_view(
    requested: &WorkspaceId,
    viewer: &UserId,
    detail: Option<WorkspaceDetailForViewer>,
) -> Result<WorkspaceView, WorkspaceViewIdentityError> {
    let Some(detail) = detail else {
        return Ok(WorkspaceView::NotFound);
    };
    if detail.face.id != *requested {
        return Err(WorkspaceViewIdentityError::WorkspaceCoordinate {
            requested: requested.clone(),
            found: detail.face.id,
        });
    }
    match detail.membership_subject {
        None => Ok(WorkspaceView::Forbidden),
        Some(subject) if subject == *viewer => {
            Ok(WorkspaceView::Visible(AuthorizedWorkspaceFace(detail.face)))
        }
        Some(matched) => Err(WorkspaceViewIdentityError::MembershipSubject {
            viewer: viewer.clone(),
            matched,
        }),
    }
}

/// The unit of work the HTTP boundary depends on: report one workspace's raw read
/// fact for the authenticated viewer — the published face plus the membership
/// subject the viewer's row matched, or `None` when no workspace answers to the
/// id. This port carries NO verdict: it does not, and cannot, classify the read
/// into a [`WorkspaceView`]. The authenticated boundary applies
/// [`classify_workspace_view`] with the request's own coordinates, so a port that
/// misreports a fact for another workspace or subject is caught by that bind
/// rather than trusted. Its one implementation reads the face and the viewer's
/// membership in a single query; tests drive the boundary with a driver-free fake
/// and the composition root wires the SQLite adapter. The `viewer` and `id` handed
/// in are the query keys; the seal binds against the same authenticated values at
/// the boundary.
pub trait WorkspaceDetailReadUnitOfWork {
    fn load_workspace_detail(
        &self,
        viewer: &UserId,
        id: &WorkspaceId,
    ) -> impl Future<Output = Result<Option<WorkspaceDetailForViewer>, PersistenceFailure>> + Send;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::foundation::identity::AgentId;

    fn regular_face() -> WorkspaceFace {
        WorkspaceFace {
            id: WorkspaceId::parse("ws-1").unwrap(),
            name: "Regular".to_owned(),
            description: None,
            owner_agent_id: None,
            owner_user_id: Some(UserId::parse("user-1").unwrap()),
            dm_channel_id: None,
            dm_channel_ids: Vec::new(),
            archived_at: None,
            created_at: 1,
            updated_at: 2,
        }
    }

    fn agent_home_face() -> WorkspaceFace {
        WorkspaceFace {
            id: WorkspaceId::parse("ws-home").unwrap(),
            name: "Home".to_owned(),
            description: None,
            owner_agent_id: Some(AgentId::parse("agent-1").unwrap()),
            owner_user_id: None,
            dm_channel_id: None,
            dm_channel_ids: Vec::new(),
            archived_at: None,
            created_at: 1,
            updated_at: 2,
        }
    }

    fn viewer() -> UserId {
        UserId::parse("user-1").unwrap()
    }

    #[test]
    fn an_absent_workspace_is_not_found_without_grading_membership() {
        assert_eq!(
            classify_workspace_view(&WorkspaceId::parse("ws-1").unwrap(), &viewer(), None),
            Ok(WorkspaceView::NotFound)
        );
    }

    #[test]
    fn a_member_reading_their_own_workspace_sees_the_sealed_face() {
        let face = regular_face();
        let view = classify_workspace_view(
            &WorkspaceId::parse("ws-1").unwrap(),
            &viewer(),
            Some(WorkspaceDetailForViewer {
                face: face.clone(),
                membership_subject: Some(viewer()),
            }),
        )
        .expect("a matched member is not an identity violation");
        let WorkspaceView::Visible(authorized) = view else {
            panic!("a member must see the workspace, got {view:?}");
        };
        assert_eq!(authorized.face(), &face);
    }

    #[test]
    fn a_present_workspace_with_no_membership_subject_is_forbidden() {
        // The workspace exists, so a non-member gets 403 — existence is not hidden
        // behind a 404. This is the branch that separates the two codes.
        assert_eq!(
            classify_workspace_view(
                &WorkspaceId::parse("ws-1").unwrap(),
                &viewer(),
                Some(WorkspaceDetailForViewer {
                    face: regular_face(),
                    membership_subject: None,
                }),
            ),
            Ok(WorkspaceView::Forbidden)
        );
    }

    #[test]
    fn visibility_is_membership_alone_never_the_workspace_kind() {
        // An agent-home workspace is graded by the SAME membership rule as any
        // other: a viewer with a membership row sees it, one without is forbidden.
        // GET :id, unlike the metadata write, does not filter agent-home rows.
        let home_viewer = viewer();
        assert_eq!(
            classify_workspace_view(
                &WorkspaceId::parse("ws-home").unwrap(),
                &home_viewer,
                Some(WorkspaceDetailForViewer {
                    face: agent_home_face(),
                    membership_subject: None,
                }),
            ),
            Ok(WorkspaceView::Forbidden)
        );
        let view = classify_workspace_view(
            &WorkspaceId::parse("ws-home").unwrap(),
            &home_viewer,
            Some(WorkspaceDetailForViewer {
                face: agent_home_face(),
                membership_subject: Some(home_viewer.clone()),
            }),
        )
        .expect("a matched member of an agent home is not a violation");
        assert!(matches!(view, WorkspaceView::Visible(_)));
    }

    #[test]
    fn a_row_for_another_workspace_is_a_coordinate_violation_not_a_face() {
        // A read layer that answers the request for `ws-1` with the face of `ws-2`
        // must NOT reach a 200: the coordinate bind fails and it is corruption.
        let mut foreign = regular_face();
        foreign.id = WorkspaceId::parse("ws-2").unwrap();
        assert_eq!(
            classify_workspace_view(
                &WorkspaceId::parse("ws-1").unwrap(),
                &viewer(),
                Some(WorkspaceDetailForViewer {
                    face: foreign,
                    membership_subject: Some(viewer()),
                }),
            ),
            Err(WorkspaceViewIdentityError::WorkspaceCoordinate {
                requested: WorkspaceId::parse("ws-1").unwrap(),
                found: WorkspaceId::parse("ws-2").unwrap(),
            })
        );
    }

    #[test]
    fn a_membership_matched_to_another_subject_is_a_violation_not_visibility() {
        // The row is the right workspace, but the membership was matched to a
        // DIFFERENT user than the authenticated viewer: a port that computed
        // membership for someone else cannot mint this viewer a 200.
        let other = UserId::parse("user-2").unwrap();
        assert_eq!(
            classify_workspace_view(
                &WorkspaceId::parse("ws-1").unwrap(),
                &viewer(),
                Some(WorkspaceDetailForViewer {
                    face: regular_face(),
                    membership_subject: Some(other.clone()),
                }),
            ),
            Err(WorkspaceViewIdentityError::MembershipSubject {
                viewer: viewer(),
                matched: other,
            })
        );
    }
}
