//! Wire tri-state primitives for PATCH bodies.
//!
//! These live in the server (wire) layer, not the domain crate: they are HTTP/Serde
//! transport vocabulary — how a JSON object encodes "missing vs null vs present" — not
//! domain edit algebra. The domain's own edit types (`FieldEdit`/`RequiredEdit`) live in
//! `backend-core::agent_profile_write`; a route's `TryFrom<Raw>` maps these wire arms to
//! them. Kept crate-private so the presence algebra never leaks as domain API.
//!
//! A PATCH body distinguishes three things a JSON object can say about an optional,
//! nullable key: the key is ABSENT (leave the column alone), the key is present and
//! `null` (clear it), or the key is present with a value (set it). Serde's own
//! `Option<T>` collapses the first two — both decode to `None` — so a field that must
//! tell "leave" from "clear" apart cannot be an `Option`. [`PatchField`] carries all
//! three arms; [`RequiredPatchField`] carries only two, for a key that is optional but
//! NOT nullable (a present `null` is a decode error); [`Forbidden`] is a key that must
//! not appear at all. [`RequiredNullable`] is the mandatory-key sibling: the key MUST be
//! present, but its value may be `null` — absent is a native `missing field` rejection,
//! present `null` and present value are the two distinct arms.
//!
//! The three OPTIONAL types decode ONLY when their key is present: the containing struct
//! annotates the field `#[serde(default)]`, so an absent key takes the type's `Default`
//! (the `Missing`/absent arm) and the `Deserialize` impl below runs only for a present
//! key. This keeps the missing/null/value decision in the type system — there is no
//! hand-written "is the key in the map" branch to drift.
//!
//! [`RequiredNullable`] is the deliberate exception, because "required" is a fact the
//! containing struct's derive owns, not the value type. It implements NO `Default` and
//! carries NO `Missing` arm, and its field is annotated
//! `#[serde(deserialize_with = "RequiredNullable::deserialize_present")]` WITHOUT
//! `#[serde(default)]`: the derive emits the native `missing field` error for an absent
//! key BEFORE the helper runs, and the helper decides `null` vs value only for a present
//! key. A naive two-arm enum with a plain `Deserialize` that calls `deserialize_option`
//! would NOT work — serde's missing-field path routes an absent key to `visit_none`, so
//! a missing key would decode as `Null`, indistinguishable from an explicit `null`. That
//! collision is exactly what the resident `{}`-rejects test pins.
//!
//! These are pure wire shapes. Mapping an arm to a domain edit, and any normalization
//! or cross-field rule, belong to the route's `TryFrom<Raw>` — not here.

use std::fmt;
use std::marker::PhantomData;

use serde::{
    Deserialize, Deserializer,
    de::{self, Visitor},
};

/// An optional, nullable key: absent (`Missing`), present `null` (`Null`), or present
/// with a value (`Value`).
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) enum PatchField<T> {
    /// The key was absent from the body.
    #[default]
    Missing,
    /// The key was present and explicitly `null`.
    Null,
    /// The key was present with a value.
    Value(T),
}

impl<'de, T> Deserialize<'de> for PatchField<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        // Reached only for a PRESENT key (the field is `#[serde(default)]`). A present
        // `null` decodes to `Null`; any other value is decoded as `T`, so a wrong JSON
        // type surfaces as `T`'s own decode error (the native extractor's 422).
        match Option::<T>::deserialize(deserializer)? {
            Some(value) => Ok(PatchField::Value(value)),
            None => Ok(PatchField::Null),
        }
    }
}

/// An optional but NON-nullable key: absent (`Missing`) or present with a value
/// (`Value`). A present `null` is a decode error, never a distinct arm — the key has no
/// "clear" meaning.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) enum RequiredPatchField<T> {
    /// The key was absent from the body.
    #[default]
    Missing,
    /// The key was present with a value.
    Value(T),
}

impl<'de, T> Deserialize<'de> for RequiredPatchField<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        // Reached only for a PRESENT key. The non-nullable guarantee is enforced HERE,
        // not delegated to `T`: `deserialize_option` routes a present `null` to
        // `visit_none` (a fixed error) and a present value to `visit_some` (delegated to
        // `T`). So the "present null is rejected" contract holds for EVERY `T`, including
        // a `T` that would itself accept null (e.g. `Option<U>`) — the type never makes a
        // promise it leaves to its parameter to keep.
        struct NonNull<T>(PhantomData<T>);

        impl<'de, T> Visitor<'de> for NonNull<T>
        where
            T: Deserialize<'de>,
        {
            type Value = RequiredPatchField<T>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a non-null value")
            }

            fn visit_none<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Err(de::Error::custom("field must not be null"))
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Err(de::Error::custom("field must not be null"))
            }

            fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
            where
                D: Deserializer<'de>,
            {
                T::deserialize(deserializer).map(RequiredPatchField::Value)
            }
        }

        deserializer.deserialize_option(NonNull(PhantomData))
    }
}

/// A REQUIRED, nullable key: present `null` (`Null`) or present with a value (`Value`).
///
/// Unlike the optional trio, the key is MANDATORY — an absent key is a native Serde
/// `missing field` rejection, never a distinct arm. The type therefore implements NO
/// `Default` and has NO `Missing` arm on purpose: there is nothing for an absent key to
/// silently fall into, so a `#[serde(default)]` annotation on such a field will not even
/// compile, and the required-key contract cannot decay into an optional one.
///
/// Decode it via [`deserialize_present`](Self::deserialize_present) on a field that is
/// NOT `#[serde(default)]`. See the module docs for why a plain two-arm `Deserialize`
/// (routing an absent key through `visit_none`) collapses `missing` into `null`.
///
/// The mounted runtime-switch face (#2241) is its first consumer; resident tests exercise
/// every arm independently of that route.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RequiredNullable<T> {
    /// The key was present and explicitly `null`.
    Null,
    /// The key was present with a value.
    Value(T),
}

impl<T> RequiredNullable<T> {
    /// Decode a PRESENT key's value: `null` → [`Null`](Self::Null), any other value →
    /// [`Value`](Self::Value). A wrong JSON type surfaces as `T`'s own decode error.
    ///
    /// Wired as `#[serde(deserialize_with = "RequiredNullable::deserialize_present")]` on
    /// a field WITHOUT `#[serde(default)]`, so the containing struct's derive owns the
    /// missing verdict: an absent key errors natively before this helper is ever called.
    pub(crate) fn deserialize_present<'de, D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
        T: Deserialize<'de>,
    {
        match Option::<T>::deserialize(deserializer)? {
            Some(value) => Ok(RequiredNullable::Value(value)),
            None => Ok(RequiredNullable::Null),
        }
    }
}

/// A key that must not appear at all (the product's `z.never()`). Absent decodes to the
/// default; a present key — with ANY value, `null` included — is a decode error.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct Forbidden;

impl<'de> Deserialize<'de> for Forbidden {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        // Reached only for a PRESENT key. Consume whatever value it carries so the
        // decoder stays well-formed, then always fail.
        de::IgnoredAny::deserialize(deserializer)?;
        Err(de::Error::custom("field is not accepted"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Deserialize, Eq, PartialEq)]
    struct Body {
        #[serde(default)]
        opt: PatchField<String>,
        #[serde(default)]
        req: RequiredPatchField<String>,
        #[serde(default)]
        forbidden: Forbidden,
    }

    fn parse(json: &str) -> Result<Body, serde_json::Error> {
        serde_json::from_str(json)
    }

    #[test]
    fn absent_keys_take_the_missing_arms() {
        let body = parse("{}").unwrap();
        assert_eq!(body.opt, PatchField::Missing);
        assert_eq!(body.req, RequiredPatchField::Missing);
        assert_eq!(body.forbidden, Forbidden);
    }

    #[test]
    fn patch_field_tells_null_from_value() {
        assert_eq!(parse(r#"{"opt":null}"#).unwrap().opt, PatchField::Null);
        assert_eq!(
            parse(r#"{"opt":"x"}"#).unwrap().opt,
            PatchField::Value("x".to_owned())
        );
    }

    #[test]
    fn patch_field_wrong_type_is_a_decode_error() {
        assert!(parse(r#"{"opt":123}"#).is_err());
    }

    #[test]
    fn required_patch_field_rejects_present_null() {
        assert!(parse(r#"{"req":null}"#).is_err());
        assert_eq!(
            parse(r#"{"req":"x"}"#).unwrap().req,
            RequiredPatchField::Value("x".to_owned())
        );
    }

    #[test]
    fn required_patch_field_rejects_present_null_even_when_t_accepts_null() {
        // The falsifier for the generic promise: with `T = Option<String>`, a naive
        // `T::deserialize(null)` would succeed as `Value(None)` and silently break the
        // "non-nullable" contract. The `deserialize_option` visitor rejects the present
        // `null` regardless of `T`.
        #[derive(Debug, Deserialize)]
        struct OptBody {
            #[serde(default)]
            req: RequiredPatchField<Option<String>>,
        }

        assert!(serde_json::from_str::<OptBody>(r#"{"req":null}"#).is_err());
        let present = serde_json::from_str::<OptBody>(r#"{"req":"x"}"#).unwrap();
        assert_eq!(present.req, RequiredPatchField::Value(Some("x".to_owned())));
    }

    #[test]
    fn forbidden_rejects_any_present_value_including_null() {
        assert!(parse(r#"{"forbidden":null}"#).is_err());
        assert!(parse(r#"{"forbidden":"x"}"#).is_err());
        assert!(parse(r#"{"forbidden":false}"#).is_err());
    }

    #[test]
    fn unknown_keys_are_ignored_not_rejected() {
        // No `#[serde(deny_unknown_fields)]`: an unknown key is dropped, matching the
        // product schema's strip-unknowns behavior.
        let body = parse(r#"{"nonesuch":1}"#).unwrap();
        assert_eq!(body.opt, PatchField::Missing);
    }

    // `RequiredNullable` is decoded via `deserialize_present` on a field that is NOT
    // `#[serde(default)]`, so the derive owns the missing verdict.
    #[derive(Debug, Deserialize, Eq, PartialEq)]
    struct RequiredNullableBody {
        #[serde(deserialize_with = "RequiredNullable::deserialize_present")]
        reqnull: RequiredNullable<String>,
    }

    fn parse_required_nullable(json: &str) -> Result<RequiredNullableBody, serde_json::Error> {
        serde_json::from_str(json)
    }

    #[test]
    fn required_nullable_rejects_a_missing_key_natively() {
        // THE guard: an absent key must be a native `missing field` rejection, NOT a
        // silent `Null`. A naive two-arm enum with a plain `Deserialize` calling
        // `deserialize_option` would decode `{}` as `Null` (serde routes the missing
        // field to `visit_none`); the `deserialize_with`-without-`default` shape makes
        // the derive emit the missing-field error first. If this ever turns green as a
        // decoded value, the required-key contract has silently decayed into optional.
        let err = parse_required_nullable("{}").unwrap_err();
        assert!(
            err.to_string().contains("missing field"),
            "absent key must be the native missing-field rejection, got: {err}"
        );
    }

    #[test]
    fn required_nullable_admits_present_null_distinctly_from_a_value() {
        assert_eq!(
            parse_required_nullable(r#"{"reqnull":null}"#)
                .unwrap()
                .reqnull,
            RequiredNullable::Null
        );
        assert_eq!(
            parse_required_nullable(r#"{"reqnull":"x"}"#)
                .unwrap()
                .reqnull,
            RequiredNullable::Value("x".to_owned())
        );
    }

    #[test]
    fn required_nullable_wrong_type_is_a_decode_error() {
        assert!(parse_required_nullable(r#"{"reqnull":123}"#).is_err());
    }
}
