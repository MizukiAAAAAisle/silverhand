//! The copy a conversation sends to someone it cannot reach.
//!
//! A mention CC is a durable message: it lands in `messages.content`, and it is
//! read again by cold reads, by replay, and by the recipient runtime's own input.
//! So its body is a product projection, not a rendering choice — the escaping
//! below is what stops a free-text label from fabricating Markdown structure or a
//! reference destination, and the quoted original is a blockquote precisely so
//! that re-stating its references addresses nobody a second time.
//!
//! Everything here is a pure function of facts the caller read. How the results
//! are encoded for storage belongs to whatever writes the row.

use super::{
    AgentId, ConversationId, FromKind, MessageId, MessageSeq, ParticipantHandle, PrincipalKind,
    UserId, WorkspaceId, addressing::format_reference_token,
};

/// The subtype a stored copy carries, so a reader can recognise one without
/// parsing its prose.
pub const MENTION_COPY_SUBTYPE: &str = "mention_cc";

/// How much of the original a notification repeats. Long enough to recognise the
/// message, short enough not to become a second copy of it.
pub const MENTION_EXCERPT_LIMIT: usize = 160;

/// What became of one addressed agent. Reported per handle, because the reason a
/// copy did not happen is what a later reader needs — "nothing was copied" alone
/// cannot distinguish a member from a stranger.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MentionCopyOutcome {
    Copied {
        handle: ParticipantHandle,
        agent: AgentId,
        /// Boxed so an outcome costs the same whichever arm it is: a skip is a
        /// handle and a reason, and it should not carry the footprint of a copy.
        copy: Box<CommittedMentionCopy>,
    },
    Skipped {
        handle: ParticipantHandle,
        reason: MentionCopySkip,
        /// Present once the handle has been resolved, so a reader can tell which
        /// agent was passed over.
        agent: Option<AgentId>,
    },
}

/// Why an addressed agent received no copy. In the order the reasons are decided:
/// each one answers a question the next has no meaning without.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MentionCopySkip {
    /// A copy is named after the workspace it came from, and a direct line has no
    /// workspace to be named after.
    SourceNotWorkspacePlaced,
    UnknownHandle,
    /// Already a participant of the source, so it already received the original.
    AlreadyMember,
    /// The author may not open a direct line to this agent.
    NoDirectLine,
}

/// One committed copy, as the business fact it is.
///
/// Everything a later reader or a published event needs is here, because it was
/// here when the row was written: reading the row back or rendering the body a
/// second time would make the acknowledgement and the event two projections of two
/// different things, which is the disagreement this shape exists to prevent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommittedMentionCopy {
    pub id: MessageId,
    /// The direct line the copy travelled on, minted with it when it did not
    /// already exist.
    pub conversation_id: ConversationId,
    pub from_kind: FromKind,
    pub content: String,
    pub metadata: MentionCopyMetadata,
    pub seq: MessageSeq,
    pub created_at_ms: i64,
    /// The message this is a copy of. The two are never independent facts.
    pub cc_source_message_id: MessageId,
}

/// The stored facts a copy carries besides its body, so a reader can render a card
/// without fetching a conversation it may not be allowed to see. Encoding is the
/// store's business; these are the facts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MentionCopyMetadata {
    pub subtype: &'static str,
    pub source_workspace_id: WorkspaceId,
    pub source_workspace_name: String,
    pub source_conversation_id: ConversationId,
    pub source_conversation_title: String,
    pub source_message_id: MessageId,
    pub source_from_kind: FromKind,
    pub source_from_user_id: UserId,
    pub source_message_content: String,
}

/// What the author's own notification carries about the mention.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MentionNotificationPayload<'facts> {
    pub source_workspace_name: &'facts str,
    pub source_conversation_title: &'facts str,
    pub mention_excerpt: String,
}

impl<'facts> MentionNotificationPayload<'facts> {
    pub fn of(
        source_workspace_name: &'facts str,
        source_conversation_title: &'facts str,
        source_content: &str,
    ) -> Self {
        Self {
            source_workspace_name,
            source_conversation_title,
            mention_excerpt: mention_excerpt(source_content),
        }
    }
}

/// The facts a copy is rendered from, all read inside the sending transaction.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MentionCopySource<'facts> {
    /// The recipient is named, not spelled: a raw string here could close the
    /// destination it is interpolated into or start a line of its own.
    pub recipient_handle: &'facts ParticipantHandle,
    pub source_workspace_name: &'facts str,
    pub source_conversation_title: &'facts str,
    pub source_content: &'facts str,
}

/// The stored copy's body.
///
/// It states what the recipient can and cannot do, because a copy exists only for
/// someone who is not a member of the source: they cannot read that conversation
/// and cannot answer there, and only a person can put them in it. The line they
/// can answer on is the direct line with whoever mentioned them.
pub fn render_copy_body(source: &MentionCopySource<'_>) -> String {
    let recipient = format_reference_token(PrincipalKind::Agent, source.recipient_handle);
    let workspace = super::markdown::inline_code(source.source_workspace_name);
    let title = super::markdown::inline_code(source.source_conversation_title);

    format!(
        "A user mentioned you ({recipient}) in {workspace} · {title}.\nYou are not a member of \
         that channel, so you cannot read it or reply there. This line is your direct message \
         with the person who mentioned you — answer here and they will see it.\n\nOriginal \
         message:\n{}\n\nIf the work belongs in that channel, say so here: only a person can put \
         you in it.",
        blockquote(source.source_content)
    )
}

/// The part of the original a notification carries: whitespace collapsed to single
/// spaces, trimmed, and cut to the limit with an ellipsis standing for the rest.
pub fn mention_excerpt(content: &str) -> String {
    let flattened = collapse_whitespace(content);
    if flattened.chars().count() <= MENTION_EXCERPT_LIMIT {
        return flattened;
    }
    let kept: String = flattened.chars().take(MENTION_EXCERPT_LIMIT - 1).collect();
    format!("{kept}…")
}

/// Quotes a value line by line, so a multi-line original stays inside the quote
/// rather than continuing as prose after its first line.
///
/// Every line ending counts, not just the one that is easy to split on: a bare
/// carriage return ends a line for a Markdown reader too, so quoting only at
/// newlines would leave the rest of the original as live prose — and a reference in
/// it would address someone a second time.
fn blockquote(text: &str) -> String {
    logical_lines(text)
        .into_iter()
        .map(|line| format!("> {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn logical_lines(text: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let mut rest = text;
    loop {
        match rest.find(['\r', '\n']) {
            None => {
                lines.push(rest);
                return lines;
            }
            Some(at) => {
                lines.push(&rest[..at]);
                let skip = if rest[at..].starts_with("\r\n") { 2 } else { 1 };
                rest = &rest[at + skip..];
            }
        }
    }
}

/// The whitespace an excerpt collapses, listed rather than delegated to a Unicode
/// property.
///
/// Two characters are the reason it is a list. A byte-order mark is not
/// Unicode whitespace but the other implementation collapses it, and U+0085 IS
/// Unicode whitespace but that implementation does NOT collapse it. Asking
/// `char::is_whitespace` would silently disagree on both, and an excerpt is
/// compared against the other side's output character for character.
fn is_excerpt_space(character: char) -> bool {
    matches!(
        character,
        '\u{9}'
            | '\u{a}'
            | '\u{b}'
            | '\u{c}'
            | '\u{d}'
            | '\u{20}'
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn collapse_whitespace(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_space = false;
    for character in value.chars() {
        if is_excerpt_space(character) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
            continue;
        }
        in_space = false;
        out.push(character);
    }
    out.trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alice() -> ParticipantHandle {
        ParticipantHandle::parse("Alice").unwrap()
    }

    fn source<'a>(
        recipient: &'a ParticipantHandle,
        workspace: &'a str,
        title: &'a str,
        content: &'a str,
    ) -> MentionCopySource<'a> {
        MentionCopySource {
            recipient_handle: recipient,
            source_workspace_name: workspace,
            source_conversation_title: title,
            source_content: content,
        }
    }

    /// A label is free text, so it must not be able to end the line it was quoted
    /// into — including through the separators that are not `\n`.
    #[test]
    fn a_label_cannot_break_out_of_its_line() {
        let plain_lines = render_copy_body(&source(&alice(), "one two", "General", "ping"))
            .lines()
            .count();

        for label in [
            "one\ntwo",
            "one\r\ntwo",
            "one\u{2028}two",
            "one\u{2029}two",
            "one\u{0085}two",
        ] {
            let body = render_copy_body(&source(&alice(), label, "General", "ping"));
            let first_line = body.lines().next().unwrap();

            assert!(
                first_line.contains("`one two`"),
                "{label:?} was not flattened: {first_line}"
            );
            assert_eq!(
                body.lines().count(),
                plain_lines,
                "{label:?} added a line to the body"
            );
        }
    }

    /// Quoting an original re-states whatever it said, so every line of it has to
    /// stay inside the quote: a reference in the original addresses nobody again.
    #[test]
    fn the_original_is_quoted_line_by_line() {
        let body = render_copy_body(&source(
            &alice(),
            "Space",
            "General",
            "hello <silverhand://agent/Bob>\nand <silverhand://human/shiki>",
        ));

        assert!(
            body.contains("> hello <silverhand://agent/Bob>\n> and <silverhand://human/shiki>")
        );
        for line in body.lines() {
            let quotes_a_reference = line.contains("silverhand://") && !line.starts_with("A user");
            assert!(
                !quotes_a_reference || line.starts_with("> "),
                "a reference from the original escaped the quote: {line}"
            );
        }
    }
}

#[cfg(test)]
mod escape_tests {
    use super::*;

    #[test]
    fn a_recipient_is_named_or_refused() {
        for raw in [
            "a>", "a/b", "a?x=1", "a b", "a\nb", "a\rb", "a<b", "1abc", "", "a.b",
        ] {
            assert!(
                ParticipantHandle::parse(raw).is_err(),
                "{raw:?} was accepted as a name"
            );
        }
        let longest = format!("a{}", "b".repeat(63));
        let too_long = format!("a{}", "b".repeat(64));
        assert_eq!(
            ParticipantHandle::parse(&longest).unwrap().as_str(),
            longest
        );
        assert!(ParticipantHandle::parse(&too_long).is_err());
    }
}
