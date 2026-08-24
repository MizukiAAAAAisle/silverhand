//! Admission: what a send request must be, decided before any principal is known.
//!
//! ONE use-case, two orderable stages (@Cindy's ruling). This is the first, and it
//! owns every rule about the request's own content: shape, the UTF-8 content cap, the
//! attachment list's accepted forms and bounds, and the payload refine. It cannot see
//! a principal, an authority or a unit of work, and that is enforced by its signature
//! rather than by discipline: there is nothing in scope for it to consult.
//!
//! The second stage is [`super::execute`], which is where a principal and the write
//! unit finally appear. Splitting them this way is what lets the two doors run the
//! same rules in DIFFERENT ORDERS — the human door authorizes before it has a body,
//! the agent door validates before it resolves a target — without either door
//! carrying a second copy of a rule.
//!
//! THE TWO DOORS DO NOT ACCEPT THE SAME BODY, which is why one set of rules has two
//! entry points. Everything about the payload is shared and defined once; what differs
//! is the DESTINATION COORDINATE the body carries. The human door's body may name a
//! reply target inside the conversation it is already posting to. The agent door's
//! body must carry an absolute address, and carry it REQUIRED, because an agent's
//! credential says where it lives and never where its words go. One shape for both
//! costs a wrong destination in both directions: a reply silently flattened onto the
//! main line, or an address taken from whatever coordinate happened to be at hand.

use serde::{Serialize, Serializer};
use silverhand_backend_core::messaging::{
    AttachmentId, MessageContent, MessageId,
    attachments::{AttachmentLabel, AttachmentRef},
};

/// The most attachments one message may reference.
pub(crate) const MAX_MESSAGE_ATTACHMENTS: usize = 20;

/// A request whose own content is settled: within the cap, with a legal attachment
/// list, and carrying something to say. No principal has been considered.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ValidatedSendPayload {
    content: MessageContent,
    attachments: Vec<AttachmentRef>,
}

impl ValidatedSendPayload {
    pub(crate) fn content(&self) -> &MessageContent {
        &self.content
    }

    pub(crate) fn attachments(&self) -> &[AttachmentRef] {
        &self.attachments
    }
}

/// A settled HUMAN request: the shared payload plus the only destination this door can
/// express — a message in the same conversation to reply to.
///
/// The coordinate is `Option`, not a default: absent means the main line, and the
/// distinction is the difference between a reply and a top-level message.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ValidatedHumanSend {
    payload: ValidatedSendPayload,
    reply_to: Option<MessageId>,
}

impl ValidatedHumanSend {
    pub(crate) fn reply_to(&self) -> Option<&MessageId> {
        self.reply_to.as_ref()
    }

    pub(crate) fn into_payload(self) -> ValidatedSendPayload {
        self.payload
    }
}

/// A settled AGENT request: the shared payload, the address it named, and whether it
/// asked to skip the freshness guard.
///
/// The address is carried as the RAW STRING the caller wrote. Its grammar has exactly
/// one authority — the resolver behind [`super::adapters::TargetAccess`] — and restating
/// any part of it here would give the system two answers to "is this a legal address".
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ValidatedAgentSend {
    payload: ValidatedSendPayload,
    target: String,
    freshness_bypass: bool,
}

impl ValidatedAgentSend {
    pub(crate) fn target(&self) -> &str {
        &self.target
    }

    pub(crate) fn freshness_bypass(&self) -> bool {
        self.freshness_bypass
    }

    pub(crate) fn into_payload(self) -> ValidatedSendPayload {
        self.payload
    }
}

/// Why admission refused, as the reason and not its rendering. Each door maps these
/// to its own wire words; the decision itself happens once.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum PayloadRefusal {
    /// The body is not the shape a send has. Carries the privacy-safe issues: what
    /// kind of problem and where, never the value.
    Shape(Vec<ShapeIssue>),
    /// Legal shape, but the content is over the UTF-8 cap. The two doors word this
    /// one differently, which is why it is its own variant.
    ContentTooLarge { actual_bytes: usize },
}

/// One step in the path to a rejected member. A field serializes as a string, an
/// index as a NUMBER — which is what the reference reports, and what a client
/// already parses. A stringified index would not match it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum IssuePathSegment {
    Field(&'static str),
    Index(usize),
}

impl Serialize for IssuePathSegment {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Field(name) => serializer.serialize_str(name),
            Self::Index(index) => serializer.serialize_u64(*index as u64),
        }
    }
}

/// One thing wrong with the request's shape, in the reference's privacy-safe form:
/// what kind of problem, where, and — for a rule the contract words itself — that
/// message. Never the value that caused it. The ONE authority for this shape.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct ShapeIssue {
    pub code: &'static str,
    pub path: Vec<IssuePathSegment>,
    /// Present only where the contract defines its own message for the rule; a
    /// generic type failure carries none, exactly as the schema does.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<&'static str>,
}

impl ShapeIssue {
    fn at(code: &'static str, path: Vec<IssuePathSegment>) -> Self {
        Self {
            code,
            path,
            message: None,
        }
    }

    fn custom(message: &'static str, path: Vec<IssuePathSegment>) -> Self {
        Self {
            code: "custom",
            path,
            message: Some(message),
        }
    }
}

const CONTENT: IssuePathSegment = IssuePathSegment::Field("content");
const ATTACHMENT_IDS: IssuePathSegment = IssuePathSegment::Field("attachment_ids");
const REPLY_TO_MESSAGE_ID: IssuePathSegment = IssuePathSegment::Field("reply_to_message_id");
const TARGET: IssuePathSegment = IssuePathSegment::Field("target");
const STALE_EVENT_ID: IssuePathSegment = IssuePathSegment::Field("stale_event_id");
const STALE_RESOLUTION_REASON: IssuePathSegment =
    IssuePathSegment::Field("stale_resolution_reason");
const FRESHNESS_BYPASS: IssuePathSegment = IssuePathSegment::Field("freshness_bypass");

/// The stale-resolution reasons a SEND may carry. Three, not four: `obsolete` says
/// "those words are no longer worth writing", which is the one resolution that cannot
/// arrive attached to a message being written.
const SEND_STALE_RESOLUTION_REASONS: &[&str] = &["unaffected", "revised", "force_send"];

fn shape(issue: ShapeIssue) -> PayloadRefusal {
    PayloadRefusal::Shape(vec![issue])
}

/// ECMAScript's `WhiteSpace` and `LineTerminator`, which is what the reference's
/// `.trim()` removes.
///
/// NOT `char::is_whitespace`, and the difference is not academic: JavaScript trims
/// U+FEFF and leaves U+0085, while Rust does the exact opposite. Delegating to the
/// Unicode property would admit a body of nothing but a zero-width space AND refuse
/// one containing a legal next-line character — two wrong answers in opposite
/// directions, on the rule that decides whether a message says anything.
const ECMASCRIPT_WHITESPACE: &[char] = &[
    '\u{9}', '\u{A}', '\u{B}', '\u{C}', '\u{D}', '\u{20}', '\u{A0}', '\u{1680}', '\u{2000}',
    '\u{2001}', '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}', '\u{2007}', '\u{2008}',
    '\u{2009}', '\u{200A}', '\u{2028}', '\u{2029}', '\u{202F}', '\u{205F}', '\u{3000}', '\u{FEFF}',
];

/// The reference's `.trim()`, exactly.
pub(crate) fn ecmascript_trim(value: &str) -> &str {
    value.trim_matches(|character| ECMASCRIPT_WHITESPACE.contains(&character))
}

/// The refine's message, which the reference reports at `content` rather than at the
/// root or at the attachment list.
pub(crate) const PAYLOAD_REFINE_MESSAGE: &str =
    "message must include text or at least one attachment";
/// Reported when two attachments claim the same label.
pub(crate) const DUPLICATE_LABEL_MESSAGE: &str =
    "attachment labels must be unique within a message";

/// Collects each key's issues in schema key order, and hands back a value only when
/// nothing was reported for that key.
///
/// The pairing is the point: a `None` can only come from a branch that recorded why, so
/// "refused" and "carries at least one issue" cannot come apart. A shared mutable vector
/// with separate `Option`s would let a future key report nothing and still refuse.
#[derive(Default)]
struct KeyIssues(Vec<ShapeIssue>);

impl KeyIssues {
    fn keep<T>(&mut self, outcome: Result<T, Vec<ShapeIssue>>) -> Option<T> {
        match outcome {
            Ok(value) => Some(value),
            Err(issues) => {
                self.0.extend(issues);
                None
            }
        }
    }

    fn refusal(self) -> PayloadRefusal {
        PayloadRefusal::Shape(self.0)
    }
}

/// The HUMAN door's body: content, the attachment list, and an optional reply target.
///
/// EVERY failing key is reported, in the schema's own key order. One issue at a time
/// would cost a caller a round trip per mistake, and the reference answers all of them
/// together — so a body with a bad `content` AND a bad `attachment_ids` gets two issues,
/// not the first one twice.
pub(crate) fn validate_human_payload(
    body: Option<serde_json::Value>,
) -> Result<ValidatedHumanSend, PayloadRefusal> {
    let body = document(body)?;
    let mut keys = KeyIssues::default();

    let content = keys.keep(content_string(&body));
    let attachments = keys.keep(attachment_list(body.get("attachment_ids")));
    // A message in the SAME conversation. Which cluster that message belongs to is
    // resolved inside the write transaction, so this door carries the coordinate and
    // claims nothing about it.
    let reply_to = keys.keep(optional_identifier(
        &body,
        "reply_to_message_id",
        REPLY_TO_MESSAGE_ID,
    ));

    let (Some(content), Some(attachments), Some(reply_to)) = (content, attachments, reply_to)
    else {
        return Err(keys.refusal());
    };

    Ok(ValidatedHumanSend {
        payload: settle(content, attachments)?,
        reply_to,
    })
}

/// The AGENT door's body: content, the required address, the stale-resolution telemetry,
/// the freshness escape hatch, and the attachment list — in that order, which is the
/// schema's.
pub(crate) fn validate_agent_payload(
    body: Option<serde_json::Value>,
) -> Result<ValidatedAgentSend, PayloadRefusal> {
    let body = document(body)?;
    let mut keys = KeyIssues::default();

    let content = keys.keep(content_string(&body));
    // REQUIRED, with no ambient default. An omitted address used to mean "here", and
    // "here" is the one spelling that becomes wrong the moment an agent serves more than
    // one stream — so a request without one is a client bug, answered as a missing field
    // rather than silently aimed at the caller's own conversation.
    let target = keys.keep(required_non_empty(&body, "target", TARGET));
    // Shape only. These two correlate a retry with the refusal that caused it, and this
    // slice has nothing that records them — but their SHAPE is still part of what the door
    // accepts, so a malformed one is a refusal here rather than a value dropped further
    // in. Carrying them no further is a named gap (R5), not a decision that they do not
    // matter.
    let stale_event_id = keys.keep(optional_non_empty(&body, "stale_event_id", STALE_EVENT_ID));
    let stale_resolution_reason = keys.keep(optional_enum(
        &body,
        "stale_resolution_reason",
        STALE_RESOLUTION_REASON,
        SEND_STALE_RESOLUTION_REASONS,
    ));
    let freshness_bypass = keys.keep(optional_flag(&body, "freshness_bypass", FRESHNESS_BYPASS));
    let attachments = keys.keep(attachment_list(body.get("attachment_ids")));

    // The two telemetry values are dropped but still have to have PARSED — dropping them
    // from this pattern would accept a body whose only fault was one of them.
    let (
        Some(content),
        Some(target),
        Some(_stale_event_id),
        Some(_stale_resolution_reason),
        Some(freshness_bypass),
        Some(attachments),
    ) = (
        content,
        target,
        stale_event_id,
        stale_resolution_reason,
        freshness_bypass,
        attachments,
    )
    else {
        return Err(keys.refusal());
    };

    Ok(ValidatedAgentSend {
        payload: settle(content, attachments)?,
        target,
        freshness_bypass,
    })
}

/// The root gate. THREE cases, and they are three answers — collapsing any two of them
/// reports a fault that is not the one the caller made (@Cindy, review of `4adfb12e`).
///
/// A body that could not be read as JSON at all becomes an empty document, because that is
/// what the reference substitutes before letting its schema speak: every required field is
/// then reported missing rather than the request collapsing into one unlocatable error.
///
/// LEGAL JSON THAT IS NOT AN OBJECT IS A DIFFERENT ANSWER. `7`, `null`, `[]`, `"x"` — the
/// schema judges the DOCUMENT, so it reports one `invalid_type` at the ROOT and stops. It
/// does not go looking for fields a number does not have, and reporting `content` (or
/// `content` and `target`) as missing would name faults in a body that has no fields at
/// all.
///
/// The document stays RAW JSON. Deserializing into a typed body first would put a second,
/// dumber validator in front of this one: any member it could not shape — a `null`
/// attachment, an object where a string belongs — collapses the whole request into
/// "unparseable", and the refusal then names `content` for a problem that was somewhere
/// else. A path that points at the wrong field is one a caller cannot act on.
///
/// It hands back the MAP rather than the value, so no later step can ask a non-object for a
/// field: the distinction is kept by the type instead of by every helper remembering it.
/// A document that HAS fields. Every key helper takes this rather than a bare value.
type Fields = serde_json::Map<String, serde_json::Value>;

fn document(body: Option<serde_json::Value>) -> Result<Fields, PayloadRefusal> {
    match body {
        None => Ok(serde_json::Map::new()),
        Some(serde_json::Value::Object(fields)) => Ok(fields),
        Some(_) => Err(shape(ShapeIssue::at("invalid_type", Vec::new()))),
    }
}

/// The rules that close a request, in the order the reference runs them, and only once
/// EVERY key has parsed: the refine belongs to the schema and reads values, so it has
/// nothing to read while a key is still malformed; the content cap sits outside the schema
/// altogether.
///
/// The order is observable. A body of 70KiB of spaces is answered "this says nothing", not
/// "this is too big", because the schema is what rejects it first; and a body that is both
/// oversized and carrying a malformed attachment is answered about the attachment.
/// Checking the cap early would answer both the other way round. Collecting several issues
/// does not move these two gates — they still run after the whole shape passes.
fn settle(
    content: String,
    attachments: Vec<AttachmentRef>,
) -> Result<ValidatedSendPayload, PayloadRefusal> {
    // THE REFINE, and it lives here rather than in `MessageContent`. An attachment-only
    // send is legal, so an empty string is legal CONTENT — the rule is "this request says
    // something", a fact about the request and not an invariant of the value. In the
    // domain type it would forbid a legal send.
    if ecmascript_trim(&content).is_empty() && attachments.is_empty() {
        return Err(shape(ShapeIssue::custom(
            PAYLOAD_REFINE_MESSAGE,
            vec![CONTENT],
        )));
    }

    // The cap is the domain type's own invariant, asked here rather than restated: one
    // comparison, in one place, and no way to build content that skipped it.
    let content =
        MessageContent::parse(content).map_err(|too_long| PayloadRefusal::ContentTooLarge {
            actual_bytes: too_long.actual_bytes,
        })?;

    Ok(ValidatedSendPayload {
        content,
        attachments,
    })
}

/// `z.string()`: required, any length, and the type is the whole rule.
fn content_string(body: &Fields) -> Result<String, Vec<ShapeIssue>> {
    match body.get("content") {
        Some(serde_json::Value::String(content)) => Ok(content.clone()),
        Some(_) | None => Err(vec![ShapeIssue::at("invalid_type", vec![CONTENT])]),
    }
}

/// `z.string().min(1)`: required and non-empty.
fn required_non_empty(
    body: &Fields,
    key: &str,
    at: IssuePathSegment,
) -> Result<String, Vec<ShapeIssue>> {
    match body.get(key) {
        Some(serde_json::Value::String(value)) if !value.is_empty() => Ok(value.clone()),
        Some(serde_json::Value::String(_)) => Err(vec![ShapeIssue::at("too_small", vec![at])]),
        Some(_) | None => Err(vec![ShapeIssue::at("invalid_type", vec![at])]),
    }
}

/// `z.string().min(1).optional()`. Absent is a legal answer; `null` is not — the schema
/// says optional, and optional is not nullable.
fn optional_non_empty(
    body: &Fields,
    key: &str,
    at: IssuePathSegment,
) -> Result<Option<String>, Vec<ShapeIssue>> {
    match body.get(key) {
        None => Ok(None),
        Some(_) => required_non_empty(body, key, at).map(Some),
    }
}

/// An optional identifier. The `.min(1)` rule is expressed THROUGH the domain type, whose
/// only rejection is emptiness — the same rule, asked once, with no second check here to
/// disagree with it and no unreachable branch to assert about.
fn optional_identifier(
    body: &Fields,
    key: &str,
    at: IssuePathSegment,
) -> Result<Option<MessageId>, Vec<ShapeIssue>> {
    match body.get(key) {
        None => Ok(None),
        Some(serde_json::Value::String(raw)) => MessageId::parse(raw.clone())
            .map(Some)
            .map_err(|_| vec![ShapeIssue::at("too_small", vec![at])]),
        Some(_) => Err(vec![ShapeIssue::at("invalid_type", vec![at])]),
    }
}

/// `z.enum([...]).optional()`. A value outside the set is its own refusal rather than a
/// type failure: the caller sent a string, just not one of these.
fn optional_enum(
    body: &Fields,
    key: &str,
    at: IssuePathSegment,
    accepted: &[&str],
) -> Result<Option<String>, Vec<ShapeIssue>> {
    match body.get(key) {
        None => Ok(None),
        Some(serde_json::Value::String(value)) if accepted.contains(&value.as_str()) => {
            Ok(Some(value.clone()))
        }
        Some(serde_json::Value::String(_)) => {
            Err(vec![ShapeIssue::at("invalid_enum_value", vec![at])])
        }
        Some(_) => Err(vec![ShapeIssue::at("invalid_type", vec![at])]),
    }
}

/// `z.boolean().optional()`. Absent means "did not ask", which is not the same claim as
/// `false` at the wire even though both refuse the bypass.
fn optional_flag(body: &Fields, key: &str, at: IssuePathSegment) -> Result<bool, Vec<ShapeIssue>> {
    match body.get(key) {
        None => Ok(false),
        Some(serde_json::Value::Bool(value)) => Ok(*value),
        Some(_) => Err(vec![ShapeIssue::at("invalid_type", vec![at])]),
    }
}

/// The attachment list's own rules: how many, what each may be, and that no two claim the
/// same label. All of them, not the first — this key reports as completely as the object
/// around it.
fn attachment_list(raw: Option<&serde_json::Value>) -> Result<Vec<AttachmentRef>, Vec<ShapeIssue>> {
    // `.optional()`, NOT nullable: an ABSENT list is a message with no attachments, while
    // an explicit `null` is the wrong type. Accepting null would widen the accepted set
    // past the schema — and the defensive `normalizeAttachmentRefs` helper on the other
    // side is no evidence for it, because the route runs the schema first and a null never
    // reaches normalization.
    let entries = match raw {
        None => return Ok(Vec::new()),
        Some(serde_json::Value::Array(entries)) => entries,
        Some(_) => return Err(vec![ShapeIssue::at("invalid_type", vec![ATTACHMENT_IDS])]),
    };

    let mut issues = Vec::new();
    // The bound is reported FIRST and does not end the traversal: it is a check on the
    // list, and the members still have their own answers to give.
    if entries.len() > MAX_MESSAGE_ATTACHMENTS {
        issues.push(ShapeIssue::at("too_big", vec![ATTACHMENT_IDS]));
    }

    let mut refs = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        match attachment_ref(entry, index) {
            Ok(reference) => refs.push(reference),
            Err(issue) => issues.push(issue),
        }
    }

    // Uniqueness is a rule ABOUT the list, so it needs a list — a member that failed to
    // parse left no label to compare, and the reference skips the refine for exactly that
    // reason. Being over the bound does not skip it.
    if refs.len() == entries.len()
        && let Some(issue) = duplicate_label(&refs)
    {
        issues.push(issue);
    }

    if issues.is_empty() {
        Ok(refs)
    } else {
        Err(issues)
    }
}

/// One member of the list: the union the reference accepts, and at most one issue, which
/// is what the reference reports per member.
fn attachment_ref(entry: &serde_json::Value, index: usize) -> Result<AttachmentRef, ShapeIssue> {
    let at = |field: &'static str| {
        vec![
            ATTACHMENT_IDS,
            IssuePathSegment::Index(index),
            IssuePathSegment::Field(field),
        ]
    };

    // Unknown object members are ignored rather than refused, so a client's
    // forward-compatible field is not a rejection.
    let (raw_id, raw_label) = match entry {
        serde_json::Value::String(id) => (id.clone(), None),
        serde_json::Value::Object(fields) => match fields.get("id") {
            Some(serde_json::Value::String(id)) => (
                id.clone(),
                // `.optional()` here too: absent is unlabelled, `null` is a wrong type
                // rather than a way to say "no label".
                match fields.get("label") {
                    None => None,
                    Some(serde_json::Value::String(label)) => Some(label.clone()),
                    Some(_) => return Err(ShapeIssue::at("invalid_type", at("label"))),
                },
            ),
            Some(_) | None => return Err(ShapeIssue::at("invalid_type", at("id"))),
        },
        _ => {
            return Err(ShapeIssue::at(
                "invalid_type",
                vec![ATTACHMENT_IDS, IssuePathSegment::Index(index)],
            ));
        }
    };

    // Emptiness only, through the domain id rather than a second check here: `" "` is
    // legal at this stage and is refused later as an attachment nobody owns, which is a
    // reason a caller can act on.
    let Ok(id) = AttachmentId::parse(raw_id) else {
        return Err(ShapeIssue::at("too_small", at("id")));
    };

    let label = match raw_label {
        None => None,
        Some(raw) => {
            // Trimmed before the grammar applies, which admits `" Image #1 "`.
            let Some(label) = AttachmentLabel::parse(ecmascript_trim(&raw)) else {
                return Err(ShapeIssue::at("invalid_string", at("label")));
            };
            Some(label.to_string())
        }
    };

    Ok(AttachmentRef { id, label })
}

/// ONE issue for the whole list however many labels repeat, which is what a single refine
/// reports.
fn duplicate_label(refs: &[AttachmentRef]) -> Option<ShapeIssue> {
    let mut seen: Vec<&str> = Vec::new();
    for reference in refs {
        // An unlabelled member is skipped, not the end of the scan: the reference collects
        // the labels that exist and compares those.
        let Some(label) = reference.label.as_deref() else {
            continue;
        };
        if seen.contains(&label) {
            return Some(ShapeIssue::custom(
                DUPLICATE_LABEL_MESSAGE,
                vec![ATTACHMENT_IDS],
            ));
        }
        seen.push(label);
    }
    None
}

#[cfg(test)]
mod tests {
    use silverhand_backend_core::messaging::MAX_MESSAGE_CONTENT_BYTES;

    use super::*;

    fn body(json: serde_json::Value) -> Option<serde_json::Value> {
        Some(json)
    }

    /// The rules BOTH doors share, reached through one of them. Which door asks is
    /// irrelevant to every assertion below: that is the point of one rule set.
    fn admit(body: Option<serde_json::Value>) -> Result<ValidatedSendPayload, PayloadRefusal> {
        validate_human_payload(body).map(ValidatedHumanSend::into_payload)
    }

    fn issues(refusal: PayloadRefusal) -> Vec<ShapeIssue> {
        match refusal {
            PayloadRefusal::Shape(issues) => issues,
            other => panic!("expected a shape refusal, got {other:?}"),
        }
    }

    /// The four readings a narrower rule gets wrong.
    #[test]
    fn the_attachment_list_accepts_exactly_what_the_contract_accepts() {
        let mixed = admit(body(serde_json::json!({
            "content": "hi",
            "attachment_ids": ["att-1", {"id": "att-2"}, {"id": "att-3", "label": "Image #1"}]
        })))
        .unwrap();
        assert_eq!(mixed.attachments().len(), 3);
        assert_eq!(mixed.attachments()[2].label.as_deref(), Some("Image #1"));

        let padded = admit(body(serde_json::json!({
            "content": "hi",
            "attachment_ids": [{"id": "att-1", "label": " Image #1 "}]
        })))
        .unwrap();
        assert_eq!(padded.attachments()[0].label.as_deref(), Some("Image #1"));

        // A bare id is NOT trimmed.
        let blank = admit(body(
            serde_json::json!({"content": "hi", "attachment_ids": [" "]}),
        ))
        .unwrap();
        assert_eq!(blank.attachments()[0].id.as_str(), " ");

        // Unknown object members are dropped, not refused.
        assert!(
            admit(body(serde_json::json!({
                "content": "hi",
                "attachment_ids": [{"id": "att-1", "future_field": 7}]
            })))
            .is_ok()
        );
    }

    /// A member this stage cannot shape is located WHERE IT IS, never blamed on
    /// `content`. This is exactly what a typed deserialization in front of admission
    /// destroys: it collapses the request and the refusal points at the wrong field.
    #[test]
    fn a_bad_attachment_member_is_reported_at_its_own_path() {
        for (entry, tail) in [
            (serde_json::json!(null), None),
            (serde_json::json!({"id": 7}), Some("id")),
            (
                serde_json::json!({"id": "att-2", "label": 7}),
                Some("label"),
            ),
            (
                serde_json::json!({"id": "att-2", "label": "nonsense"}),
                Some("label"),
            ),
            (serde_json::json!(""), Some("id")),
        ] {
            let refusal = admit(body(serde_json::json!({
                "content": "hi",
                "attachment_ids": ["att-1", entry]
            })));
            let reported = issues(refusal.unwrap_err());
            let mut expected = vec![ATTACHMENT_IDS, IssuePathSegment::Index(1)];
            if let Some(field) = tail {
                expected.push(IssuePathSegment::Field(field));
            }
            assert_eq!(reported[0].path, expected);
            assert_ne!(reported[0].path, vec![CONTENT]);
        }
    }

    /// `.optional()` is not nullable. An absent member is legal; an explicit `null`
    /// is the wrong type, and accepting it would admit requests the schema refuses.
    #[test]
    fn an_absent_member_is_legal_but_an_explicit_null_is_not() {
        // Absent: a message with no attachments.
        assert!(
            admit(body(serde_json::json!({"content": "hi"})))
                .unwrap()
                .attachments()
                .is_empty()
        );
        // Present and null: wrong type, located at the list.
        assert_eq!(
            issues(
                admit(body(
                    serde_json::json!({"content": "hi", "attachment_ids": null})
                ))
                .unwrap_err()
            )[0],
            ShapeIssue::at("invalid_type", vec![ATTACHMENT_IDS])
        );

        // The same distinction one level down: absent label is unlabelled…
        let unlabelled = admit(body(
            serde_json::json!({"content": "hi", "attachment_ids": [{"id": "att-1"}]}),
        ))
        .unwrap();
        assert_eq!(unlabelled.attachments()[0].label, None);
        // …while `label: null` is a wrong type at its own numeric-indexed path.
        let refused = issues(
            admit(body(serde_json::json!({
                "content": "hi",
                "attachment_ids": [{"id": "att-1", "label": null}]
            })))
            .unwrap_err(),
        );
        assert_eq!(
            serde_json::to_value(&refused[0]).unwrap(),
            serde_json::json!({"code": "invalid_type", "path": ["attachment_ids", 0, "label"]})
        );
    }

    /// An index is a NUMBER on the wire, and a rule the contract words itself carries
    /// that message. Both were missing while the constants sat unused.
    #[test]
    fn issues_serialize_the_way_the_reference_reports_them() {
        let typed = issues(
            admit(body(serde_json::json!({
                "content": "hi",
                "attachment_ids": ["att-1", {"id": "att-2", "label": 7}]
            })))
            .unwrap_err(),
        );
        assert_eq!(
            serde_json::to_value(&typed[0]).unwrap(),
            serde_json::json!({"code": "invalid_type", "path": ["attachment_ids", 1, "label"]})
        );

        let refined = issues(admit(body(serde_json::json!({"content": ""}))).unwrap_err());
        assert_eq!(
            serde_json::to_value(&refined[0]).unwrap(),
            serde_json::json!({
                "code": "custom",
                "path": ["content"],
                "message": PAYLOAD_REFINE_MESSAGE
            })
        );

        let duplicated = issues(
            admit(body(serde_json::json!({
                "content": "hi",
                "attachment_ids": [
                    {"id": "att-1", "label": "Image #1"},
                    {"id": "att-2", "label": " Image #1 "}
                ]
            })))
            .unwrap_err(),
        );
        assert_eq!(
            serde_json::to_value(&duplicated[0]).unwrap(),
            serde_json::json!({
                "code": "custom",
                "path": ["attachment_ids"],
                "message": DUPLICATE_LABEL_MESSAGE
            })
        );
    }

    /// The count is asked before uniqueness, and BOTH are reported: the bound is a check
    /// on the list and the members still have their own answer to give.
    #[test]
    fn the_bound_is_asked_before_uniqueness_and_neither_hides_the_other() {
        let over: Vec<serde_json::Value> = (0..MAX_MESSAGE_ATTACHMENTS + 1)
            .map(|_| serde_json::json!({"id": "att", "label": "Image #1"}))
            .collect();
        assert_eq!(
            issues(
                admit(body(
                    serde_json::json!({"content": "hi", "attachment_ids": over})
                ))
                .unwrap_err()
            ),
            vec![
                ShapeIssue::at("too_big", vec![ATTACHMENT_IDS]),
                ShapeIssue::custom(DUPLICATE_LABEL_MESSAGE, vec![ATTACHMENT_IDS]),
            ]
        );

        // A member that failed to parse leaves no label to compare, so uniqueness is
        // skipped for that list rather than reported against a half-read one.
        assert_eq!(
            issues(
                admit(body(serde_json::json!({
                    "content": "hi",
                    "attachment_ids": [
                        {"id": "att-1", "label": "Image #1"},
                        {"id": "att-2", "label": "Image #1"},
                        {"id": 7}
                    ]
                })))
                .unwrap_err()
            ),
            vec![ShapeIssue::at(
                "invalid_type",
                vec![
                    ATTACHMENT_IDS,
                    IssuePathSegment::Index(2),
                    IssuePathSegment::Field("id")
                ]
            )]
        );
    }

    /// EVERY failing top-level key is reported, in the schema's own key order.
    ///
    /// One issue at a time costs a caller a round trip per mistake, and it disagrees with
    /// the `issues` array consumers already read (@Cindy's ruling on R11). The order is the
    /// schema's, not this file's, which is why the two doors' lists differ.
    #[test]
    fn every_failing_key_is_reported_in_schema_key_order() {
        let two = issues(
            admit(body(serde_json::json!({"content": 7, "attachment_ids": 5}))).unwrap_err(),
        );
        assert_eq!(
            two,
            vec![
                ShapeIssue::at("invalid_type", vec![CONTENT]),
                ShapeIssue::at("invalid_type", vec![ATTACHMENT_IDS]),
            ]
        );

        // The human door: content, attachment_ids, reply_to_message_id.
        let human = issues(
            admit(body(serde_json::json!({
                "content": 7,
                "attachment_ids": 5,
                "reply_to_message_id": ""
            })))
            .unwrap_err(),
        );
        assert_eq!(
            human
                .iter()
                .map(|issue| issue.path.clone())
                .collect::<Vec<_>>(),
            vec![
                vec![CONTENT],
                vec![ATTACHMENT_IDS],
                vec![REPLY_TO_MESSAGE_ID]
            ]
        );

        // The agent door: content, target, stale_event_id, stale_resolution_reason,
        // freshness_bypass, attachment_ids — a different list AND a different order.
        let agent = issues(
            validate_agent_payload(body(serde_json::json!({
                "content": 7,
                "target": "",
                "stale_event_id": 7,
                "stale_resolution_reason": "obsolete",
                "freshness_bypass": "yes",
                "attachment_ids": 5
            })))
            .unwrap_err(),
        );
        assert_eq!(
            agent
                .iter()
                .map(|issue| (issue.code, issue.path.clone()))
                .collect::<Vec<_>>(),
            vec![
                ("invalid_type", vec![CONTENT]),
                ("too_small", vec![TARGET]),
                ("invalid_type", vec![STALE_EVENT_ID]),
                ("invalid_enum_value", vec![STALE_RESOLUTION_REASON]),
                ("invalid_type", vec![FRESHNESS_BYPASS]),
                ("invalid_type", vec![ATTACHMENT_IDS]),
            ]
        );
    }

    /// A shape refusal always names at least one thing.
    ///
    /// Collecting introduces the one way this could go wrong — refusing with an empty list
    /// — so it is read back behaviourally rather than left to the accumulator's invariant.
    #[test]
    fn a_shape_refusal_never_arrives_empty() {
        for body_value in [
            serde_json::json!({}),
            serde_json::json!({"content": 7}),
            serde_json::json!({"content": "hi", "attachment_ids": [{"id": 7}]}),
            serde_json::json!({"content": "hi", "reply_to_message_id": ""}),
            serde_json::json!({"content": ""}),
        ] {
            let refusal = admit(body(body_value.clone())).unwrap_err();
            assert!(!issues(refusal).is_empty(), "{body_value}");
        }
        assert!(!issues(admit(None).unwrap_err()).is_empty());
    }

    /// The trim is ECMAScript's, and it disagrees with Rust's in BOTH directions.
    #[test]
    fn the_refine_trims_what_the_reference_trims() {
        // U+FEFF: JavaScript trims it, so this body says nothing. Rust's `trim` keeps
        // it and would let this through.
        assert_eq!(
            issues(admit(body(serde_json::json!({"content": "\u{FEFF}"}))).unwrap_err())[0],
            ShapeIssue::custom(PAYLOAD_REFINE_MESSAGE, vec![CONTENT])
        );
        // U+0085: JavaScript does NOT trim it, so this body says something. Rust's
        // `trim` removes it and would refuse a legal send.
        assert!(admit(body(serde_json::json!({"content": "\u{85}"}))).is_ok());

        // The same disagreement on a label, where it decides admission.
        let feff = admit(body(serde_json::json!({
            "content": "hi",
            "attachment_ids": [{"id": "att-1", "label": "\u{FEFF}Image #1\u{FEFF}"}]
        })))
        .unwrap();
        assert_eq!(feff.attachments()[0].label.as_deref(), Some("Image #1"));
        // U+0085 stays part of the text, so this is not a legal label.
        assert!(
            admit(body(serde_json::json!({
                "content": "hi",
                "attachment_ids": [{"id": "att-1", "label": "\u{85}Image #1"}]
            })))
            .is_err()
        );
    }

    /// The refine belongs to the request, not to the content value.
    #[test]
    fn a_send_must_say_something_but_the_content_value_keeps_no_such_rule() {
        assert_eq!(
            issues(admit(body(serde_json::json!({"content": "   "}))).unwrap_err())[0],
            ShapeIssue::custom(PAYLOAD_REFINE_MESSAGE, vec![CONTENT])
        );

        let attachment_only = admit(body(
            serde_json::json!({"content": "", "attachment_ids": ["att-1"]}),
        ))
        .unwrap();
        assert_eq!(attachment_only.content().as_str(), "");

        assert!(MessageContent::parse("").is_ok());
    }

    /// THE CAP IS ASKED LAST, because in the reference it lives OUTSIDE the schema:
    /// everything the schema decides — the content's type, the attachment list, the
    /// refine — is answered before "this send is too big" is even considered.
    ///
    /// Both cells here are reachable and both used to be answered the other way round.
    #[test]
    fn the_schema_is_answered_before_the_content_cap() {
        // Oversized AND saying nothing: the refine is a schema rule, so it wins.
        let silent = " ".repeat(MAX_MESSAGE_CONTENT_BYTES + 1);
        assert_eq!(
            issues(admit(body(serde_json::json!({"content": silent}))).unwrap_err())[0],
            ShapeIssue::custom(PAYLOAD_REFINE_MESSAGE, vec![CONTENT])
        );

        // Oversized AND carrying a malformed attachment: the list is a schema rule too.
        let over = "a".repeat(MAX_MESSAGE_CONTENT_BYTES + 1);
        assert_eq!(
            issues(
                admit(body(
                    serde_json::json!({"content": over.clone(), "attachment_ids": 7})
                ))
                .unwrap_err()
            )[0],
            ShapeIssue::at("invalid_type", vec![ATTACHMENT_IDS])
        );

        // Nothing else wrong with it: now the cap is the answer, and it reports the
        // real size rather than the bound.
        assert_eq!(
            admit(body(serde_json::json!({"content": over}))).unwrap_err(),
            PayloadRefusal::ContentTooLarge {
                actual_bytes: MAX_MESSAGE_CONTENT_BYTES + 1
            }
        );

        // Collecting several issues does not move either gate. The refine reads values, so
        // while a key is still malformed it does not run at all — this body says nothing
        // AND has a broken list, and only the list is reported.
        assert_eq!(
            issues(
                admit(body(
                    serde_json::json!({"content": "", "attachment_ids": 5})
                ))
                .unwrap_err()
            ),
            vec![ShapeIssue::at("invalid_type", vec![ATTACHMENT_IDS])]
        );
        // With the list fixed, the refine is the answer and it is alone.
        assert_eq!(
            issues(
                admit(body(
                    serde_json::json!({"content": "", "attachment_ids": []})
                ))
                .unwrap_err()
            ),
            vec![ShapeIssue::custom(PAYLOAD_REFINE_MESSAGE, vec![CONTENT])]
        );
    }

    /// THE ROOT IS ITS OWN ANSWER, and the three cases are three answers.
    ///
    /// Legal JSON that is not an object is judged as a DOCUMENT: one `invalid_type` at the
    /// root, empty path, and no field collection at all. Treating it as an empty object —
    /// which is what a bare `.get(key)` on any value does — reports fields missing from a
    /// body that has no fields, and on the agent door it invents a second issue as well.
    #[test]
    fn a_root_that_is_not_an_object_is_answered_at_the_root() {
        let at_root = ShapeIssue::at("invalid_type", Vec::new());

        for root in [
            serde_json::json!(7),
            serde_json::json!(null),
            serde_json::json!([]),
            serde_json::json!(["content"]),
            serde_json::json!("x"),
            serde_json::json!(true),
        ] {
            for reported in [
                issues(admit(body(root.clone())).unwrap_err()),
                issues(validate_agent_payload(body(root.clone())).unwrap_err()),
            ] {
                assert_eq!(reported, vec![at_root.clone()], "{root}");
                // The path is EMPTY on the wire, not an omitted member.
                assert_eq!(
                    serde_json::to_value(&reported[0]).unwrap(),
                    serde_json::json!({"code": "invalid_type", "path": []}),
                    "{root}"
                );
            }
        }

        // The two neighbouring cases keep their own answers. A body that could not be read
        // as JSON at all is judged as an empty OBJECT — fields missing, per door…
        assert_eq!(
            issues(admit(None).unwrap_err()),
            vec![ShapeIssue::at("invalid_type", vec![CONTENT])]
        );
        assert_eq!(
            issues(validate_agent_payload(None).unwrap_err()),
            vec![
                ShapeIssue::at("invalid_type", vec![CONTENT]),
                ShapeIssue::at("invalid_type", vec![TARGET]),
            ]
        );
        // …and an actual empty object answers identically, which is what makes the
        // substitution honest rather than a third behaviour.
        assert_eq!(
            issues(admit(body(serde_json::json!({}))).unwrap_err()),
            issues(admit(None).unwrap_err())
        );
        assert_eq!(
            issues(validate_agent_payload(body(serde_json::json!({}))).unwrap_err()),
            issues(validate_agent_payload(None).unwrap_err())
        );
    }

    /// EACH DOOR READS ONLY ITS OWN DESTINATION FIELD, and a member the other door owns
    /// is an unknown one — stripped, exactly as the reference's schemas strip unknown
    /// members rather than refusing them.
    ///
    /// The falsifier for one shared shape: a single schema would either demand `target`
    /// from a person's client or accept an agent send with no address at all.
    #[test]
    fn a_door_reads_its_own_destination_field_and_ignores_the_other_doors() {
        // The human door has no `target` rule; the member is dropped.
        let human = validate_human_payload(body(serde_json::json!({
            "content": "hi",
            "target": "#conv:elsewhere"
        })))
        .unwrap();
        assert_eq!(human.reply_to(), None);

        // The agent door has no `reply_to_message_id` rule, and still requires its own
        // address.
        assert_eq!(
            issues(
                validate_agent_payload(body(serde_json::json!({
                    "content": "hi",
                    "reply_to_message_id": "msg-1"
                })))
                .unwrap_err()
            )[0],
            ShapeIssue::at("invalid_type", vec![TARGET])
        );
        let agent = validate_agent_payload(body(serde_json::json!({
            "content": "hi",
            "target": "#conv:elsewhere",
            "reply_to_message_id": "msg-1"
        })))
        .unwrap();
        assert_eq!(agent.target(), "#conv:elsewhere");
    }

    /// The agent door's telemetry members are shape-checked even though this slice
    /// carries them no further: a malformed one is a refusal, not a value quietly
    /// dropped.
    #[test]
    fn the_stale_resolution_members_are_shape_checked_where_they_arrive() {
        let legal = |extra: serde_json::Value| {
            let mut object = serde_json::json!({"content": "hi", "target": "#conv:elsewhere"});
            let map = object.as_object_mut().unwrap();
            for (key, value) in extra.as_object().unwrap() {
                map.insert(key.clone(), value.clone());
            }
            body(object)
        };

        assert!(
            validate_agent_payload(legal(serde_json::json!({
                "stale_event_id": "evt-1",
                "stale_resolution_reason": "revised"
            })))
            .is_ok()
        );

        for (extra, expected) in [
            (
                serde_json::json!({"stale_event_id": ""}),
                ShapeIssue::at("too_small", vec![STALE_EVENT_ID]),
            ),
            (
                serde_json::json!({"stale_event_id": 7}),
                ShapeIssue::at("invalid_type", vec![STALE_EVENT_ID]),
            ),
            (
                // `obsolete` resolves a refusal by abandoning the message, so it is not
                // one of the three a SEND may carry.
                serde_json::json!({"stale_resolution_reason": "obsolete"}),
                ShapeIssue::at("invalid_enum_value", vec![STALE_RESOLUTION_REASON]),
            ),
            (
                serde_json::json!({"stale_resolution_reason": 7}),
                ShapeIssue::at("invalid_type", vec![STALE_RESOLUTION_REASON]),
            ),
            (
                serde_json::json!({"freshness_bypass": "yes"}),
                ShapeIssue::at("invalid_type", vec![FRESHNESS_BYPASS]),
            ),
        ] {
            assert_eq!(
                issues(validate_agent_payload(legal(extra.clone())).unwrap_err())[0],
                expected,
                "{extra}"
            );
        }
    }

    /// The reply coordinate's `.min(1)` is the identifier's own rule, so an empty string
    /// is reported as too small rather than accepted as "no reply".
    #[test]
    fn an_empty_reply_target_is_a_refusal_rather_than_the_main_line() {
        assert_eq!(
            issues(
                validate_human_payload(body(
                    serde_json::json!({"content": "hi", "reply_to_message_id": ""})
                ))
                .unwrap_err()
            )[0],
            ShapeIssue::at("too_small", vec![REPLY_TO_MESSAGE_ID])
        );
        assert_eq!(
            issues(
                validate_human_payload(body(
                    serde_json::json!({"content": "hi", "reply_to_message_id": null})
                ))
                .unwrap_err()
            )[0],
            ShapeIssue::at("invalid_type", vec![REPLY_TO_MESSAGE_ID])
        );
        assert_eq!(
            validate_human_payload(body(
                serde_json::json!({"content": "hi", "reply_to_message_id": "msg-1"})
            ))
            .unwrap()
            .reply_to()
            .map(MessageId::as_str),
            Some("msg-1")
        );
    }
}
