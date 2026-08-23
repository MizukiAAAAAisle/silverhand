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

use super::{ParticipantHandle, PrincipalKind, format_reference_token};

/// The subtype a stored copy carries, so a reader can recognise one without
/// parsing its prose.
pub const MENTION_COPY_SUBTYPE: &str = "mention_cc";

/// How much of the original a notification repeats. Long enough to recognise the
/// message, short enough not to become a second copy of it.
pub const MENTION_EXCERPT_LIMIT: usize = 160;

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
    let workspace = inline_code(source.source_workspace_name);
    let title = inline_code(source.source_conversation_title);

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

/// Renders a value as a single-line code span it cannot escape from.
///
/// Two properties carry the weight. The value becomes one line: every break
/// character collapses to a space, including the Unicode separators that survive
/// naive JSON handling, so a label cannot end the line it was quoted into. And the
/// delimiter is always longer than the longest backtick run inside the value, with
/// the padding CommonMark requires when the content itself starts or ends with a
/// backtick — without it a value ending in a backtick merges with the closing
/// fence and the whole span degrades into live prose. Inside a code span a handle
/// is not a mention and a destination is not a reference.
fn inline_code(value: &str) -> String {
    let single_line = collapse_line_breaks(value);
    let longest_run = single_line
        .split(|character| character != '`')
        .map(str::len)
        .max()
        .unwrap_or(0);

    if longest_run == 0 {
        return format!("`{single_line}`");
    }
    let delimiter = "`".repeat(longest_run + 1);
    format!("{delimiter} {single_line} {delimiter}")
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

fn is_line_break(character: char) -> bool {
    matches!(
        character,
        '\r' | '\n' | '\u{2028}' | '\u{2029}' | '\u{0085}'
    )
}

fn collapse_line_breaks(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_break = false;
    for character in value.chars() {
        if is_line_break(character) {
            if !in_break {
                out.push(' ');
            }
            in_break = true;
            continue;
        }
        in_break = false;
        out.push(character);
    }
    out
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

    #[test]
    fn the_body_names_its_recipient_with_the_canonical_form() {
        let body = render_copy_body(&source(&alice(), "Space", "General", "ping"));

        assert_eq!(
            body,
            "A user mentioned you (<silverhand://agent/Alice>) in `Space` · `General`.\nYou are \
             not a member of that channel, so you cannot read it or reply there. This line is \
             your direct message with the person who mentioned you — answer here and they will \
             see it.\n\nOriginal message:\n> ping\n\nIf the work belongs in that channel, say so \
             here: only a person can put you in it."
        );
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

    /// A backtick run inside a label must not close the span early, and a value
    /// touching a backtick at either end needs the padding CommonMark requires.
    #[test]
    fn a_label_cannot_close_its_own_code_span() {
        let single = render_copy_body(&source(&alice(), "a`b", "General", "ping"));
        let run = render_copy_body(&source(&alice(), "a``b", "General", "ping"));
        let edge = render_copy_body(&source(&alice(), "`", "General", "ping"));

        assert!(single.contains("`` a`b ``"));
        assert!(run.contains("``` a``b ```"));
        assert!(edge.contains("`` ` ``"));
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

    #[test]
    fn an_excerpt_collapses_whitespace_and_trims() {
        assert_eq!(mention_excerpt("  hello\n\tthere  "), "hello there");
        assert_eq!(mention_excerpt("a\u{feff}b"), "a b");
        assert_eq!(mention_excerpt("   "), "");
    }

    /// The limit is a count of characters, and the ellipsis stands in for what was
    /// cut — so the result never exceeds the limit.
    #[test]
    fn an_excerpt_is_cut_at_the_limit() {
        let exactly = "a".repeat(MENTION_EXCERPT_LIMIT);
        let over = "a".repeat(MENTION_EXCERPT_LIMIT + 1);

        assert_eq!(mention_excerpt(&exactly), exactly);
        let cut = mention_excerpt(&over);
        assert_eq!(cut.chars().count(), MENTION_EXCERPT_LIMIT);
        assert!(cut.ends_with('…'));
        assert_eq!(
            cut.chars().filter(|character| *character == 'a').count(),
            MENTION_EXCERPT_LIMIT - 1
        );
    }

    /// A character is never cut in half, which is the one place this deliberately
    /// answers better than the implementation it mirrors: counting UTF-16 units can
    /// split a surrogate pair, and a lone surrogate is not text.
    #[test]
    fn an_excerpt_never_splits_a_character() {
        let astral = "𝄞".repeat(MENTION_EXCERPT_LIMIT + 10);

        let cut = mention_excerpt(&astral);

        assert_eq!(cut.chars().count(), MENTION_EXCERPT_LIMIT);
        assert!(
            cut.chars()
                .take(MENTION_EXCERPT_LIMIT - 1)
                .all(|c| c == '𝄞')
        );
    }
}

#[cfg(test)]
mod escape_tests {
    use super::*;

    /// A bare carriage return ends a line for a Markdown reader, so the original
    /// must be quoted at it too — otherwise the rest of someone else's message
    /// becomes live prose in a body that addresses people.
    #[test]
    fn every_line_ending_keeps_the_original_inside_the_quote() {
        let recipient = ParticipantHandle::parse("Alice").unwrap();
        for original in [
            "safe\r<silverhand://agent/Bob>",
            "safe\r\n<silverhand://agent/Bob>",
            "safe\n<silverhand://agent/Bob>",
        ] {
            let body = render_copy_body(&MentionCopySource {
                recipient_handle: &recipient,
                source_workspace_name: "Space",
                source_conversation_title: "General",
                source_content: original,
            });

            for line in body.lines() {
                let names_someone_else = line.contains("silverhand://agent/Bob");
                assert!(
                    !names_someone_else || line.starts_with("> "),
                    "a line of the original escaped the quote for {original:?}: {line}"
                );
            }
            assert!(body.contains("> safe"));
        }
    }

    /// The excerpt's whitespace set is the other implementation's, character for
    /// character: U+0085 is Unicode whitespace that it does NOT collapse, and a
    /// byte-order mark is not whitespace that it DOES.
    #[test]
    fn the_excerpt_whitespace_set_is_the_one_the_other_side_uses() {
        assert_eq!(mention_excerpt("a\u{feff}b"), "a b");
        assert_eq!(mention_excerpt("a\u{a0}b"), "a b");
        assert_eq!(mention_excerpt("a\u{2028}b"), "a b");
        assert_eq!(mention_excerpt("a\u{2029}b"), "a b");
        assert_eq!(mention_excerpt("a\u{3000}b"), "a b");
        // Collapsed by `char::is_whitespace`, and deliberately not here.
        assert_eq!(mention_excerpt("a\u{85}b"), "a\u{85}b");
    }

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
