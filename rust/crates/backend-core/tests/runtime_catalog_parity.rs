//! Rust half of the cross-language gate on WHICH runtimes the product offers
//! (#task:2195, root ops).
//!
//! The offered set and its order are a PRODUCT decision owned by
//! `packages/shared/src/runtime-catalog.ts` (`RUNTIME_ORDER` filtered by
//! `selectable: true`). Rust re-states that decision in `SELECTABLE_RUNTIMES` because
//! the detector's arity is derived from it, so the two spellings can drift: a runtime
//! newly offered in the picker, or reordered there, would leave this crate answering
//! for the old set with every in-crate assertion still green.
//!
//! Both sides are therefore held to one checked-in artifact,
//! `packages/shared/tests/fixtures/offered-runtimes.json`, which the TypeScript half
//! (`packages/shared/tests/runtime-catalog-parity.test.ts`) signs from the real TS
//! catalogue. Neither half hand-writes the runtime names in its own test — that is the
//! defect this replaces: an in-crate list of string literals agrees with itself no
//! matter what the product decided.
//!
//! The two halves of the artifact are compared under different rules, on purpose.
//! `offered` is a sequence: it is the picker's order, and both sides own it.
//! `vocabularyOnly` is a sorted SET: display order is a TS-only fact, while
//! [`RuntimeKind::ALL`] is the closed vocabulary in its own order, so asserting an
//! order for the remainder would pin something neither side owns.

use serde_json::Value;
use silverhand_backend_core::identity_access::agents::{
    runtime::RuntimeKind,
    runtime_catalog::{SELECTABLE_RUNTIME_COUNT, SELECTABLE_RUNTIMES},
};

const FIXTURE: &str =
    include_str!("../../../../packages/shared/tests/fixtures/offered-runtimes.json");

fn signed_names(field: &str) -> Vec<String> {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("shared fixture is valid JSON");
    fixture[field]
        .as_array()
        .unwrap_or_else(|| panic!("shared fixture declares `{field}` as an array"))
        .iter()
        .map(|name| {
            name.as_str()
                .expect("every signed runtime name is a string")
                .to_string()
        })
        .collect()
}

/// The offered catalogue is the product's list, in the product's order — read from the
/// shared artifact rather than repeated here.
#[test]
fn the_offered_runtimes_and_their_order_are_the_shared_products() {
    let offered: Vec<String> = SELECTABLE_RUNTIMES
        .iter()
        .map(|kind| kind.as_str().to_string())
        .collect();
    assert_eq!(offered, signed_names("offered"));
    assert_eq!(offered.len(), SELECTABLE_RUNTIME_COUNT);
}

/// Everything else in the vocabulary is offered by neither side. Compared as a sorted
/// set: a row may hold these kinds, but no picker lists them, so there is no order to
/// agree on.
#[test]
fn the_kinds_the_product_does_not_offer_are_the_shared_remainder() {
    let mut unoffered: Vec<String> = RuntimeKind::ALL
        .into_iter()
        .filter(|kind| !SELECTABLE_RUNTIMES.contains(kind))
        .map(|kind| kind.as_str().to_string())
        .collect();
    unoffered.sort();

    let mut signed = signed_names("vocabularyOnly");
    signed.sort();

    assert_eq!(unoffered, signed);
}

/// The artifact covers the vocabulary exactly once: every kind is either offered or in
/// the remainder, and none is in both. Without this, a kind dropped from BOTH halves of
/// the fixture — the shape a bad hand-edit takes — would satisfy the two tests above.
#[test]
fn the_two_halves_partition_the_closed_vocabulary() {
    let mut signed = signed_names("offered");
    signed.extend(signed_names("vocabularyOnly"));
    signed.sort();

    let mut vocabulary: Vec<String> = RuntimeKind::ALL
        .into_iter()
        .map(|kind| kind.as_str().to_string())
        .collect();
    vocabulary.sort();

    assert_eq!(signed, vocabulary);
}
