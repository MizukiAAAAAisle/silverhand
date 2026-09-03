//! The two narrow admission ports the schedule-create route consults, expressed
//! in SCHEDULING's own vocabulary.
//!
//! Neither is `messaging::pre_send`. Delivery-target resolution in the send lane
//! is a concrete pre-send use-case: its port carries a `DirectPairAllocation`, its
//! refusals are entangled with the send door's slot-reach verdict and pair-mint
//! announcement, and there is no production implementation of it in this base yet.
//! Depending on it from scheduling would import that pre-send admission shape and
//! could silently reorder schedule create's own resolve→capability sequence. So
//! scheduling declares what IT needs — an address→conversation resolution with a
//! conversation-granular result, and a `manage_schedules` judgment at the resolved
//! destination — and composition later implements each by delegating to whatever
//! the real resolver/capability authority is. The type dependency points at
//! scheduling's requirement, not the other way around.

use std::error::Error;
use std::future::Future;

use silverhand_backend_core::foundation::identity::{AgentId, ConversationId};

/// Why a schedule target address did not resolve to a usable destination. The
/// codes and their statuses mirror the TypeScript delivery-target route mapping
/// for the schedule-create door EXACTLY, so reusing a resolver cannot change the
/// observable verdict:
///
/// - [`Malformed`](Self::Malformed) — the token is not an address (`400`).
/// - [`SelfPairNotAddressable`](Self::SelfPairNotAddressable) — a DM to oneself
///   (`400`).
/// - [`Unresolved`](Self::Unresolved) — names no stream the caller can use; this
///   is where UNKNOWN and UNAUTHORIZED-TO-REACH COLLAPSE to one anti-enumeration
///   answer (`404`).
/// - [`ThreadNotInTarget`](Self::ThreadNotInTarget) — a reply id that is not a
///   cluster root of the named conversation (`404`).
/// - [`ThreadSuffixUnsupported`](Self::ThreadSuffixUnsupported) — a `/thread:`
///   suffix on a conversation-granular door: a schedule wakes a conversation
///   runtime, not a cluster, so the suffix names nothing this field can act on
///   (`400`).
/// - [`SlotOutOfScope`](Self::SlotOutOfScope) — resolution PROVED participation,
///   but the credential's slot may not reach this stream (`403`). Distinct from
///   `Unresolved` on purpose: a 403 here is only ever about a stream the actor can
///   already enumerate; a non-participant still gets the byte-identical `404`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScheduleTargetRefusal {
    Malformed,
    SelfPairNotAddressable,
    Unresolved,
    ThreadNotInTarget,
    ThreadSuffixUnsupported,
    SlotOutOfScope,
}

/// A resolved schedule destination: a single conversation id. Conversation-
/// granular by construction — the resolver has already refused any `/thread:`
/// suffix ([`ScheduleTargetRefusal::ThreadSuffixUnsupported`]), so there is no
/// thread coordinate to carry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedScheduleTarget {
    pub conversation: ConversationId,
}

/// Pair-allocation policy explicitly required by this consumer. Schedule create
/// permits allocation for both runtime slot kinds.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScheduleTargetAllocation {
    Permitted,
}

/// Target operation intent explicitly required by this consumer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScheduleTargetIntent {
    Write,
}

/// Resolve the wire `target_conversation` address to the conversation a fire wakes.
/// The caller must supply the consumer-owned allocation and intent values explicitly;
/// an unwritable or unreachable destination is refused HERE, and a `dm:@handle` with
/// no pair yet is the resolver's business to mint when allocation is permitted. This
/// port performs ADDRESS RESOLUTION ONLY: it never judges `manage_schedules` (that is
/// [`ScheduleManageCapability`], consulted strictly after a successful resolve) and
/// never runs `send_messages` admission.
pub trait ScheduleTargetResolver {
    type Error: Error + Send + Sync + 'static;

    fn resolve(
        &self,
        agent: &AgentId,
        address: &str,
        allocation: ScheduleTargetAllocation,
        intent: ScheduleTargetIntent,
    ) -> impl Future<
        Output = Result<Result<ResolvedScheduleTarget, ScheduleTargetRefusal>, Self::Error>,
    > + Send;
}

/// The credential lacks the `manage_schedules` grant at the resolved destination.
/// Rendered through the typed `capability_denied` envelope with the
/// `manage_schedules` token. A plain verdict marker, not a `std::error::Error`: it
/// is an authorization ANSWER, distinct from the port implementation's own
/// infrastructure `Error`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ScheduleCapabilityDenied;

/// Judge `manage_schedules` at the RESOLVED destination, by the placement rule —
/// not the calling conversation's workspace, and not a raw `workspace_id` (a
/// `direct_pair` has none, and reading its null coordinate as "no grant can exist
/// here" would make every DM unschedulable). Consulted STRICTLY AFTER a successful
/// [`ScheduleTargetResolver::resolve`], mirroring the TS door order.
///
/// This is a `manage_schedules` authority ONLY. It is deliberately NOT the send
/// lane's `send_messages` capability: the two grants are independent, so a
/// credential with `manage_schedules` but not `send_messages` is authorized here,
/// and one with `send_messages` but not `manage_schedules` is refused.
pub trait ScheduleManageCapability {
    type Error: Error + Send + Sync + 'static;

    fn may_manage_schedules(
        &self,
        agent: &AgentId,
        destination: &ConversationId,
    ) -> impl Future<Output = Result<Result<(), ScheduleCapabilityDenied>, Self::Error>> + Send;
}
