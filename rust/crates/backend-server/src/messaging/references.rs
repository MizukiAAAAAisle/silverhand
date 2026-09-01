//! WHERE a body may address from: a CommonMark autolink in prose.
//!
//! The rule is structure, not text. `<silverhand://agent/Alice>` addresses;
//! `[Alice](silverhand://agent/Alice)` does not, because a label is a place to hide a
//! different identity and the surfaces where that lie is visible — agent stdin, message
//! history, every export — are not the surfaces that decide delivery. An autolink cannot
//! lie: its text IS its destination.
//!
//! Quoted syntax and quoted words address nobody. A reference shown as an EXAMPLE must not
//! summon its subject, and re-delivering to everyone named in a quote would make every
//! reply a broadcast.
//!
//! It answers WHERE only. The bytes at these spans are read and parsed by
//! `backend-core`, so this rule can narrow or widen where a body addresses FROM and can
//! never introduce a name the body does not contain.

use std::ops::Range;

use pulldown_cmark::{Event, LinkType, Options, Parser, Tag, TagEnd};
use silverhand_backend_core::conversation_messaging::messaging::{
    MessageContent, ReferencePositions,
};

/// The product position rule.
pub struct MarkdownReferencePositions;

impl ReferencePositions for MarkdownReferencePositions {
    fn autolink_spans(&self, content: &MessageContent) -> Vec<Range<usize>> {
        let body = content.as_str();
        // ONE LEADING U+FEFF COMES OFF BEFORE PARSING, and the reason is block structure
        // rather than tidiness. The reference implementation's parser drops exactly one, so
        // a body that begins with a BOM and four spaces is an INDENTED CODE BLOCK there and
        // would be a paragraph here — the same bytes addressing nobody on one side and
        // somebody on the other. Dropping the same one character makes the two agree, and
        // the direction matters: the reference's answer is the narrower one.
        //
        // Exactly one, never the run. A surviving BOM opens its line as prose, which is why
        // `\u{FEFF}\u{FEFF}` + four spaces addresses while a single one does not.
        let prefix = if body.starts_with('\u{FEFF}') {
            '\u{FEFF}'.len_utf8()
        } else {
            0
        };

        let mut spans = Vec::new();
        let mut quoted = 0usize;
        // Plain CommonMark, deliberately without the GFM extensions the renderer enables:
        // GFM adds containers and emphasis forms rather than link syntaxes that could
        // produce this scheme, so the accepted set is the same either way — and asking for
        // fewer extensions cannot widen it.
        for (event, range) in Parser::new_ext(&body[prefix..], Options::empty()).into_offset_iter()
        {
            match event {
                Event::Start(Tag::BlockQuote(_)) => quoted += 1,
                Event::End(TagEnd::BlockQuote(_)) => quoted = quoted.saturating_sub(1),
                // The link TYPE is the discriminator, so no slice comparison is needed to
                // tell `<url>` from `[label](url)`: the parser already knows which syntax it
                // read. Code spans and code blocks are excluded by construction rather than
                // by a rule here — neither emits a link event at all — so blockquotes are
                // the only position this has to refuse itself.
                Event::Start(Tag::Link {
                    link_type: LinkType::Autolink,
                    ..
                }) if quoted == 0 => {
                    // Offsets are the parser's own, which are byte offsets into what it was
                    // given; the prefix goes back so the span indexes the ORIGINAL body,
                    // which is what reads the destination.
                    spans.push(range.start + prefix..range.end + prefix);
                }
                _ => {}
            }
        }
        spans
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spans(body: &str) -> Vec<String> {
        let content = MessageContent::parse(body).unwrap();
        MarkdownReferencePositions
            .autolink_spans(&content)
            .into_iter()
            .map(|span| body[span].to_owned())
            .collect()
    }

    /// A SPAN IS A WHOLE AUTOLINK OF THIS BODY, brackets included — the shape the
    /// derivation strips before it parses a destination. A rule that reported the
    /// destination alone, or a span one byte out, would address nobody while looking
    /// exactly as correct from the outside.
    #[test]
    fn a_span_covers_the_autolink_it_found() {
        assert_eq!(
            spans("hello <silverhand://agent/Alice> there"),
            ["<silverhand://agent/Alice>"]
        );
        // Multibyte prose before it: the offsets are bytes, so a character count would be
        // short here and the slice would start inside the previous character.
        assert_eq!(
            spans("héllo — <silverhand://agent/Alice>"),
            ["<silverhand://agent/Alice>"]
        );
        // And with the byte order mark put back, which is the arithmetic this rule adds.
        assert_eq!(
            spans("\u{FEFF}<silverhand://agent/Alice>"),
            ["<silverhand://agent/Alice>"]
        );
    }

    /// Source order, and every occurrence — deduplication is identity's job, not
    /// position's, and a rule that deduplicated here would hide the repeat that decides
    /// which occurrence is first.
    #[test]
    fn every_occurrence_is_reported_in_source_order() {
        assert_eq!(
            spans(
                "<silverhand://human/shiki> then <silverhand://agent/Alice> then <silverhand://human/shiki>"
            ),
            [
                "<silverhand://human/shiki>",
                "<silverhand://agent/Alice>",
                "<silverhand://human/shiki>"
            ]
        );
    }

    /// Nesting depth does not launder a quote: an autolink inside a list inside a
    /// blockquote is still someone else's words.
    #[test]
    fn a_quote_stays_a_quote_however_deeply_it_is_nested() {
        assert!(spans("> - <silverhand://agent/Alice>").is_empty());
        assert!(spans(">>> <silverhand://agent/Alice>").is_empty());
        // …and the depth counter comes back down, so prose AFTER a quote still addresses.
        assert_eq!(
            spans("> quoted <silverhand://human/shiki>\n\nmine <silverhand://agent/Alice>"),
            ["<silverhand://agent/Alice>"]
        );
    }
}
