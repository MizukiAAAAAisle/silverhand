//! Attachment references as the send path judges them.
//!
//! Two rules and no more: a reference must name an attachment of the target
//! channel, and a label the sender supplied must agree with the attachment's own
//! content type. Uploader identity, prior use, size and MIME are decided when the
//! attachment is created, not when a message points at it.

use std::fmt;

use super::{AttachmentId, ConversationId};

/// The two kinds a label may claim. Derived from the content type, never from the
/// filename.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AttachmentLabelKind {
    Image,
    File,
}

impl AttachmentLabelKind {
    pub fn of_content_type(content_type: &str) -> Self {
        if content_type.starts_with("image/") {
            Self::Image
        } else {
            Self::File
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Image => "Image",
            Self::File => "File",
        }
    }
}

/// The canonical label form `Image #1` / `File #12`. Only this spelling exists:
/// an ordinal is 1..=9999 with no leading zero, so a label round-trips and two
/// spellings cannot denote the same position.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AttachmentLabel {
    kind: AttachmentLabelKind,
    ordinal: u16,
}

const MAX_LABEL_ORDINAL: u16 = 9_999;

impl AttachmentLabel {
    pub fn parse(raw: &str) -> Option<Self> {
        let (kind_text, ordinal_text) = raw.split_once(" #")?;
        let kind = match kind_text {
            "Image" => AttachmentLabelKind::Image,
            "File" => AttachmentLabelKind::File,
            _ => return None,
        };
        if ordinal_text.starts_with('0') {
            return None;
        }
        let ordinal = ordinal_text.parse::<u16>().ok()?;
        if ordinal == 0 || ordinal > MAX_LABEL_ORDINAL {
            return None;
        }
        Some(Self { kind, ordinal })
    }

    pub fn kind(self) -> AttachmentLabelKind {
        self.kind
    }

    pub fn ordinal(self) -> u16 {
        self.ordinal
    }
}

impl fmt::Display for AttachmentLabel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} #{}", self.kind.as_str(), self.ordinal)
    }
}

/// What the sender asked for. The label arrives as raw text because rejecting it
/// is one of the two refusals this module owns.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentRef {
    pub id: AttachmentId,
    pub label: Option<String>,
}

/// The facts the decision needs about a stored attachment. Storage location and
/// revision are deliberately absent: a message snapshot describes what was
/// attached, not where the bytes live.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentSource {
    pub id: AttachmentId,
    pub channel_id: ConversationId,
    pub filename: String,
    pub size: i64,
    pub content_type: String,
}

/// What the message carries once accepted. It is a snapshot: later renames of the
/// attachment do not rewrite the message.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentSnapshot {
    pub id: AttachmentId,
    pub filename: String,
    pub size: i64,
    pub content_type: String,
    pub label: Option<AttachmentLabel>,
}

/// An attachment reference the store would not accept. "Unknown" and "belongs to
/// another conversation" are deliberately one answer, so a reference cannot be
/// used to probe for existence.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AttachmentRefusal {
    #[error("attachment does not belong to this channel")]
    OutsideChannel { attachment_id: AttachmentId },
    #[error("attachment label kind does not match its content type")]
    LabelKindMismatch { attachment_id: AttachmentId },
}

impl AttachmentRefusal {
    pub fn attachment_id(&self) -> &AttachmentId {
        match self {
            Self::OutsideChannel { attachment_id } | Self::LabelKindMismatch { attachment_id } => {
                attachment_id
            }
        }
    }
}

/// Resolves every reference or refuses at the first one that fails.
///
/// An unknown id and an id belonging to another channel are one answer, so a
/// reference cannot be used to probe which attachments exist. Duplicates are kept
/// rather than collapsed: the sender's list is what the message reports.
pub fn resolve_attachment_snapshots(
    channel: &ConversationId,
    refs: &[AttachmentRef],
    sources: &[AttachmentSource],
) -> Result<Vec<AttachmentSnapshot>, AttachmentRefusal> {
    let mut snapshots = Vec::with_capacity(refs.len());
    for reference in refs {
        let source = sources
            .iter()
            .find(|source| source.id == reference.id && source.channel_id == *channel)
            .ok_or_else(|| AttachmentRefusal::OutsideChannel {
                attachment_id: reference.id.clone(),
            })?;

        let label = match reference.label.as_deref() {
            None => None,
            Some(raw) => Some(
                AttachmentLabel::parse(raw)
                    .filter(|label| {
                        label.kind() == AttachmentLabelKind::of_content_type(&source.content_type)
                    })
                    .ok_or_else(|| AttachmentRefusal::LabelKindMismatch {
                        attachment_id: reference.id.clone(),
                    })?,
            ),
        };

        snapshots.push(AttachmentSnapshot {
            id: reference.id.clone(),
            filename: source.filename.clone(),
            size: source.size,
            content_type: source.content_type.clone(),
            label,
        });
    }
    Ok(snapshots)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel() -> ConversationId {
        ConversationId::parse("conv-1").unwrap()
    }

    fn attachment(id: &str, content_type: &str) -> AttachmentSource {
        AttachmentSource {
            id: AttachmentId::parse(id).unwrap(),
            channel_id: channel(),
            filename: "note.txt".to_owned(),
            size: 12,
            content_type: content_type.to_owned(),
        }
    }

    fn reference(id: &str, label: Option<&str>) -> AttachmentRef {
        AttachmentRef {
            id: AttachmentId::parse(id).unwrap(),
            label: label.map(str::to_owned),
        }
    }

    #[test]
    fn label_kind_follows_the_content_type() {
        assert_eq!(
            AttachmentLabelKind::of_content_type("image/png"),
            AttachmentLabelKind::Image
        );
        assert_eq!(
            AttachmentLabelKind::of_content_type("text/plain"),
            AttachmentLabelKind::File
        );
        // A filename that looks like an image does not make one.
        assert_eq!(
            AttachmentLabelKind::of_content_type("application/octet-stream"),
            AttachmentLabelKind::File
        );
    }

    #[test]
    fn only_the_canonical_label_spelling_parses() {
        assert_eq!(
            AttachmentLabel::parse("Image #1").unwrap().to_string(),
            "Image #1"
        );
        assert_eq!(
            AttachmentLabel::parse("File #9999").unwrap().ordinal(),
            9_999
        );
        assert!(AttachmentLabel::parse("File #10000").is_none());
        assert!(AttachmentLabel::parse("File #0").is_none());
        assert!(AttachmentLabel::parse("File #01").is_none());
        assert!(AttachmentLabel::parse("file #1").is_none());
        assert!(AttachmentLabel::parse("Image#1").is_none());
        assert!(AttachmentLabel::parse("Image #1 ").is_none());
    }

    #[test]
    fn an_empty_reference_list_needs_no_sources() {
        assert_eq!(
            resolve_attachment_snapshots(&channel(), &[], &[]).unwrap(),
            vec![]
        );
    }

    #[test]
    fn unknown_and_foreign_references_are_one_answer() {
        let foreign = AttachmentSource {
            channel_id: ConversationId::parse("conv-2").unwrap(),
            ..attachment("att-1", "text/plain")
        };

        let unknown =
            resolve_attachment_snapshots(&channel(), &[reference("att-1", None)], &[]).unwrap_err();
        let outside =
            resolve_attachment_snapshots(&channel(), &[reference("att-1", None)], &[foreign])
                .unwrap_err();

        assert_eq!(unknown, outside);
        assert!(matches!(unknown, AttachmentRefusal::OutsideChannel { .. }));
        assert_eq!(unknown.attachment_id().as_str(), "att-1");
    }

    #[test]
    fn a_label_must_agree_with_the_attachments_own_kind() {
        let sources = vec![attachment("att-1", "text/plain")];

        let mismatch = resolve_attachment_snapshots(
            &channel(),
            &[reference("att-1", Some("Image #1"))],
            &sources,
        )
        .unwrap_err();
        let accepted = resolve_attachment_snapshots(
            &channel(),
            &[reference("att-1", Some("File #2"))],
            &sources,
        )
        .unwrap();

        assert!(matches!(
            mismatch,
            AttachmentRefusal::LabelKindMismatch { .. }
        ));
        assert_eq!(
            accepted[0].label.unwrap(),
            AttachmentLabel::parse("File #2").unwrap()
        );
    }

    #[test]
    fn a_non_canonical_label_is_refused_as_a_kind_mismatch() {
        let sources = vec![attachment("att-1", "image/png")];

        let refusal = resolve_attachment_snapshots(
            &channel(),
            &[reference("att-1", Some("Photo #1"))],
            &sources,
        )
        .unwrap_err();

        assert!(matches!(
            refusal,
            AttachmentRefusal::LabelKindMismatch { .. }
        ));
    }

    #[test]
    fn the_first_failing_reference_decides() {
        let sources = vec![attachment("att-1", "text/plain")];

        let refusal = resolve_attachment_snapshots(
            &channel(),
            &[
                reference("att-1", Some("Image #1")),
                reference("att-missing", None),
            ],
            &sources,
        )
        .unwrap_err();

        // The label mismatch is reported even though a later reference names
        // nothing at all: resolution stops at the first failure.
        assert!(matches!(
            refusal,
            AttachmentRefusal::LabelKindMismatch { .. }
        ));
    }

    #[test]
    fn a_repeated_reference_is_carried_twice() {
        let sources = vec![attachment("att-1", "image/png")];

        let snapshots = resolve_attachment_snapshots(
            &channel(),
            &[reference("att-1", None), reference("att-1", None)],
            &sources,
        )
        .unwrap();

        assert_eq!(snapshots.len(), 2);
        assert_eq!(snapshots[0], snapshots[1]);
        assert_eq!(snapshots[0].filename, "note.txt");
        assert_eq!(snapshots[0].size, 12);
    }

    #[test]
    fn an_attachment_refusal_names_the_reference_it_rejected() {
        let refusal = AttachmentRefusal::OutsideChannel {
            attachment_id: AttachmentId::parse("att-1").unwrap(),
        };

        assert_eq!(refusal.attachment_id().as_str(), "att-1");
    }
}
