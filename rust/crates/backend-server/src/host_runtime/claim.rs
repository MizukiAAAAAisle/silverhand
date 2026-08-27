//! Authenticated `POST /api/hosts/claim-or-create`: the desktop main process names
//! the installation it runs on and asks for the computer that installation owns, plus
//! the daemon token it needs to attach.
//!
//! Two authorities, in order:
//!
//!  1. VALIDATE — the request body is admitted against the same shape the TypeScript
//!     `HostClaimOrCreateInputSchema` enforces: `installation_id` a required uuid,
//!     `label` a trimmed 1..=64 unit string, `current_host_id` a non-empty string, and
//!     no unknown keys. A malformed or non-object body is `Expected object, received
//!     <type>` — the same `null` fallback the handler's `c.req.json().catch(() => null)`
//!     produces — and the issue grid is projected through the shared Zod vocabulary.
//!  2. CLAIM — [`ClaimLocalComputer`] owns the three-way reuse/adopt/register branch and
//!     the one credential mint; this factory only carries its refusals to the wire. A
//!     credential refused because the computer was revoked under the claim is the one
//!     typed race with a `409` of its own; every other refusal is a composition fault
//!     that takes a fail-closed `500`.
//!
//! The human principal is proof the authenticating perimeter ran; its ABSENCE is a
//! composition fault, not a product request, so it takes a fail-closed `500` having read
//! and parsed nothing. Mounting the real bearer perimeter is the composition root's job
//! (#task:2197), not this factory's.

use std::{collections::HashSet, sync::Arc};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Extension, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use serde::{
    Deserialize, Deserializer, Serialize,
    de::{IgnoredAny, MapAccess, SeqAccess, Visitor},
};
use silverhand_backend_core::{
    host_runtime::{
        claim::{
            ClaimLocalComputer, ClaimLocalComputerError, ClaimLocalComputerUnitOfWork,
            LocalClaimRequest,
        },
        computer::{ComputerDisplayLabel, DisplayLabelRefusal},
        custody::{CredentialIssueRefusal, CredentialIssueUnitOfWork, HostCredentialInventory},
        environment::{Clock, EntropySource},
    },
    identity::{HostId, UserId},
};

use crate::error;

use super::{
    ErrorBody, ZodIssue,
    host_wire::{HostDto, host_wire},
    internal_error, invalid_input, js_object_keys, unrecognized_keys_message,
};

pub const HOST_CLAIM_OR_CREATE_PATH: &str = "/api/hosts/claim-or-create";

/// The credential-revoked race, pinned to the TypeScript handler's defensive branch
/// (`{ error: 'host has been revoked', error_code: 'host_revoked' }`).
const HOST_REVOKED: &str = "host has been revoked";
const HOST_REVOKED_CODE: &str = "host_revoked";

struct ClaimState<U, I, W, R, C>(Arc<ClaimLocalComputer<U, I, W, R, C>>);

impl<U, I, W, R, C> Clone for ClaimState<U, I, W, R, C> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

pub fn router<U, I, W, R, C>(claim: ClaimLocalComputer<U, I, W, R, C>) -> Router
where
    U: ClaimLocalComputerUnitOfWork,
    I: HostCredentialInventory,
    W: CredentialIssueUnitOfWork,
    R: EntropySource + 'static,
    C: Clock + 'static,
{
    Router::new()
        .route(
            HOST_CLAIM_OR_CREATE_PATH,
            post(claim_or_create::<U, I, W, R, C>),
        )
        .with_state(ClaimState(Arc::new(claim)))
}

async fn claim_or_create<U, I, W, R, C>(
    State(state): State<ClaimState<U, I, W, R, C>>,
    principal: Option<Extension<UserId>>,
    body: Bytes,
) -> Response
where
    U: ClaimLocalComputerUnitOfWork,
    I: HostCredentialInventory,
    W: CredentialIssueUnitOfWork,
    R: EntropySource + 'static,
    C: Clock + 'static,
{
    let Some(Extension(user_id)) = principal else {
        tracing::error!("claim-or-create route reached without its human principal fact");
        return internal_error();
    };

    let request = match parse_claim_or_create(&body) {
        Ok(request) => request,
        Err(issues) => return invalid_input(issues),
    };

    match state.0.execute(user_id, request).await {
        Ok(claimed) => {
            let host_token = claimed.host_token.map(|token| token.reveal_once());
            Json(ClaimOrCreateResponse {
                host_id: claimed.computer.id.as_str().to_owned(),
                host: host_wire(&claimed.computer),
                host_token,
            })
            .into_response()
        }
        Err(ClaimLocalComputerError::CredentialRefused(CredentialIssueRefusal::HostRevoked)) => (
            StatusCode::CONFLICT,
            Json(ErrorBody {
                error: HOST_REVOKED,
                error_code: HOST_REVOKED_CODE,
            }),
        )
            .into_response(),
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "claim-or-create failed"
            );
            internal_error()
        }
    }
}

/// Success body: `{ host_id, host, host_token? }`. `host_token` is present only when a
/// token was minted, matching the TypeScript `...(hostToken ? { host_token } : {})`.
#[derive(Serialize)]
struct ClaimOrCreateResponse {
    host_id: String,
    host: HostDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_token: Option<String>,
}

/// Admit the body, or return the Zod-shaped `400` it fails against.
///
/// Known fields are validated in schema order — `installation_id`, `label`,
/// `current_host_id` — then `.strict()`'s unrecognized keys are appended, so the issue
/// list matches Zod's for any combination of failures.
fn parse_claim_or_create(body: &[u8]) -> Result<LocalClaimRequest, Vec<ZodIssue>> {
    let fields =
        match serde_json::from_slice::<ClaimBody>(body).unwrap_or(ClaimBody::NonObject("null")) {
            ClaimBody::Object(fields) => fields,
            ClaimBody::NonObject(received) => {
                return Err(vec![ZodIssue::InvalidType {
                    code: "invalid_type",
                    expected: "object",
                    received,
                    path: Vec::new(),
                    message: format!("Expected object, received {received}"),
                }]);
            }
        };

    let mut issues = Vec::new();

    let installation_id = match &fields.installation_id {
        None => {
            issues.push(required_string("installation_id"));
            None
        }
        Some(FieldValue::Other(received)) => {
            issues.push(invalid_type_string("installation_id", received));
            None
        }
        Some(FieldValue::Str(value)) => {
            if is_uuid(value) {
                Some(value.clone())
            } else {
                issues.push(invalid_uuid("installation_id"));
                None
            }
        }
    };

    let label = match &fields.label {
        None => None,
        Some(FieldValue::Other(received)) => {
            issues.push(invalid_type_string("label", received));
            None
        }
        Some(FieldValue::Str(value)) => match ComputerDisplayLabel::parse(value) {
            Ok(label) => Some(label),
            Err(DisplayLabelRefusal::Empty) => {
                issues.push(too_small("label"));
                None
            }
            Err(DisplayLabelRefusal::TooLong { .. }) => {
                issues.push(too_big("label"));
                None
            }
        },
    };

    let current_computer = match &fields.current_host_id {
        None => None,
        Some(FieldValue::Other(received)) => {
            issues.push(invalid_type_string("current_host_id", received));
            None
        }
        Some(FieldValue::Str(value)) => match HostId::parse(value) {
            Ok(host) => Some(host),
            Err(_) => {
                issues.push(too_small("current_host_id"));
                None
            }
        },
    };

    if !fields.unknown_keys.is_empty() {
        let keys = js_object_keys(fields.unknown_keys);
        let message = unrecognized_keys_message(&keys);
        issues.push(ZodIssue::UnrecognizedKeys {
            code: "unrecognized_keys",
            keys,
            path: Vec::new(),
            message,
        });
    }

    if !issues.is_empty() {
        return Err(issues);
    }

    Ok(LocalClaimRequest {
        installation_id: installation_id
            .expect("installation_id is Some once no issue was recorded"),
        label,
        current_computer,
    })
}

/// The Zod uuid check reduced to its observable behavior: 8-4-4-4-12 hex with dashes at
/// the four fixed offsets. The regex's `\b` anchors sit between a hex digit and a dash —
/// always a word boundary — so they never reject anything the length-and-shape test
/// admits.
fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            *byte == b'-'
        } else {
            byte.is_ascii_hexdigit()
        }
    })
}

fn required_string(field: &str) -> ZodIssue {
    ZodIssue::InvalidType {
        code: "invalid_type",
        expected: "string",
        received: "undefined",
        path: vec![field.to_owned()],
        message: "Required".to_owned(),
    }
}

fn invalid_type_string(field: &str, received: &'static str) -> ZodIssue {
    ZodIssue::InvalidType {
        code: "invalid_type",
        expected: "string",
        received,
        path: vec![field.to_owned()],
        message: format!("Expected string, received {received}"),
    }
}

fn invalid_uuid(field: &str) -> ZodIssue {
    ZodIssue::InvalidString {
        validation: "uuid",
        code: "invalid_string",
        message: "Invalid uuid",
        path: vec![field.to_owned()],
    }
}

fn too_small(field: &str) -> ZodIssue {
    ZodIssue::TooSmall {
        code: "too_small",
        minimum: 1,
        value_type: "string",
        inclusive: true,
        exact: false,
        message: "String must contain at least 1 character(s)",
        path: vec![field.to_owned()],
    }
}

fn too_big(field: &str) -> ZodIssue {
    ZodIssue::TooBig {
        code: "too_big",
        maximum: 64,
        value_type: "string",
        inclusive: true,
        exact: false,
        message: "String must contain at most 64 character(s)",
        path: vec![field.to_owned()],
    }
}

/// The body as one of two shapes: a JSON object, or anything else named for the wire.
enum ClaimBody {
    Object(ClaimFields),
    NonObject(&'static str),
}

/// The three known fields captured verbatim, plus the unknown keys `.strict()` refuses.
/// A repeated known key keeps its last value, as `JSON.parse` does.
#[derive(Default)]
struct ClaimFields {
    installation_id: Option<FieldValue>,
    label: Option<FieldValue>,
    current_host_id: Option<FieldValue>,
    unknown_keys: Vec<String>,
}

/// A field's value reduced to what validation needs: its string, or the wire name of the
/// non-string type it was, so `invalid_type` can report `received`.
enum FieldValue {
    Str(String),
    Other(&'static str),
}

impl<'de> Deserialize<'de> for FieldValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(FieldValueVisitor)
    }
}

struct FieldValueVisitor;

impl<'de> Visitor<'de> for FieldValueVisitor {
    type Value = FieldValue;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(FieldValue::Str(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(FieldValue::Str(value))
    }

    fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
        Ok(FieldValue::Other("boolean"))
    }

    fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
        Ok(FieldValue::Other("number"))
    }

    fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
        Ok(FieldValue::Other("number"))
    }

    fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
        Ok(FieldValue::Other("number"))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(FieldValue::Other("null"))
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(FieldValue::Other("null"))
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(self)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        while sequence.next_element::<IgnoredAny>()?.is_some() {}
        Ok(FieldValue::Other("array"))
    }

    fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
    where
        M: MapAccess<'de>,
    {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(FieldValue::Other("object"))
    }
}

impl<'de> Deserialize<'de> for ClaimBody {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(ClaimBodyVisitor)
    }
}

struct ClaimBodyVisitor;

impl<'de> Visitor<'de> for ClaimBodyVisitor {
    type Value = ClaimBody;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
    where
        M: MapAccess<'de>,
    {
        let mut fields = ClaimFields::default();
        let mut seen_unknown = HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "installation_id" => fields.installation_id = Some(map.next_value()?),
                "label" => fields.label = Some(map.next_value()?),
                "current_host_id" => fields.current_host_id = Some(map.next_value()?),
                _ => {
                    map.next_value::<IgnoredAny>()?;
                    if seen_unknown.insert(key.clone()) {
                        fields.unknown_keys.push(key);
                    }
                }
            }
        }
        Ok(ClaimBody::Object(fields))
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        while sequence.next_element::<IgnoredAny>()?.is_some() {}
        Ok(ClaimBody::NonObject("array"))
    }

    fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
        Ok(ClaimBody::NonObject("boolean"))
    }

    fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
        Ok(ClaimBody::NonObject("number"))
    }

    fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
        Ok(ClaimBody::NonObject("number"))
    }

    fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
        Ok(ClaimBody::NonObject("number"))
    }

    fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E> {
        Ok(ClaimBody::NonObject("string"))
    }

    fn visit_string<E>(self, _value: String) -> Result<Self::Value, E> {
        Ok(ClaimBody::NonObject("string"))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(ClaimBody::NonObject("null"))
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(ClaimBody::NonObject("null"))
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        convert::Infallible,
        io,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering::SeqCst},
        },
    };

    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use serde_json::{Value, json};
    use silverhand_backend_core::{
        host_runtime::{
            claim::{LocalClaimAttempt, LocalClaimWriteError},
            computer::{ComputerRecord, HostKind, ProvisioningSource},
            custody::{CredentialSweep, NewLongLivedCredential},
        },
        persistence::PersistenceFailure,
    };
    use tower::ServiceExt;

    use super::*;

    const OWNER: &str = "u-owner";
    const CLAIMED_ID: &str = "computer-1";

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn claimed_record() -> ComputerRecord {
        ComputerRecord {
            id: HostId::parse(CLAIMED_ID).expect("host id"),
            name: "shiki-mac".to_owned(),
            kind: HostKind::Local,
            created_at: 1,
            owner: Some(user(OWNER)),
            installation_id: Some("11111111-1111-4111-8111-111111111111".to_owned()),
            last_seen_at: Some(9),
            activated_at: Some(2),
            finalized_at: Some(3),
            revoked_at: None,
            provisioning_source: ProvisioningSource::AppInstall,
            display_label: None,
        }
    }

    #[derive(Clone)]
    struct FakeClaim {
        computer: ComputerRecord,
        calls: Arc<AtomicUsize>,
    }

    impl ClaimLocalComputerUnitOfWork for FakeClaim {
        async fn claim_local_computer(
            &self,
            _attempt: LocalClaimAttempt,
        ) -> Result<ComputerRecord, LocalClaimWriteError> {
            self.calls.fetch_add(1, SeqCst);
            Ok(self.computer.clone())
        }
    }

    #[derive(Clone)]
    struct FakeInventory {
        has_active: bool,
    }

    impl HostCredentialInventory for FakeInventory {
        async fn has_active_long_lived_credential(
            &self,
            _computer: HostId,
            _now: i64,
        ) -> Result<bool, PersistenceFailure> {
            Ok(self.has_active)
        }
    }

    #[derive(Clone, Copy)]
    enum IssueOutcome {
        Ok,
        Refused(CredentialIssueRefusal),
        Fails,
    }

    #[derive(Clone)]
    struct FakeIssuer {
        outcome: IssueOutcome,
        issued: Arc<AtomicUsize>,
    }

    impl CredentialIssueUnitOfWork for FakeIssuer {
        async fn issue_credential(
            &self,
            _credential: NewLongLivedCredential,
            sweep: Option<CredentialSweep>,
        ) -> Result<Result<(), CredentialIssueRefusal>, PersistenceFailure> {
            assert!(
                sweep.is_none(),
                "a claim mints a first token; it never sweeps"
            );
            self.issued.fetch_add(1, SeqCst);
            match self.outcome {
                IssueOutcome::Ok => Ok(Ok(())),
                IssueOutcome::Refused(refusal) => Ok(Err(refusal)),
                IssueOutcome::Fails => Err(PersistenceFailure::from_source(io::Error::other(
                    "issue failed",
                ))),
            }
        }
    }

    struct FixedEntropy(Mutex<VecDeque<u8>>);

    impl FixedEntropy {
        fn sequence() -> Self {
            Self(Mutex::new((0..1024).map(|index| index as u8).collect()))
        }
    }

    impl EntropySource for FixedEntropy {
        type Error = Infallible;
        fn fill(&self, destination: &mut [u8]) -> Result<(), Self::Error> {
            let mut bytes = self.0.lock().unwrap();
            for destination in destination {
                *destination = bytes.pop_front().unwrap();
            }
            Ok(())
        }
    }

    struct FixedClock;

    impl Clock for FixedClock {
        type Error = Infallible;
        fn unix_time_ms(&self) -> Result<i64, Self::Error> {
            Ok(1_700_000_000_123)
        }
    }

    struct Reply {
        status: StatusCode,
        body: String,
        claim_calls: usize,
        issued: usize,
    }

    async fn post(
        body: &str,
        with_principal: bool,
        inventory: FakeInventory,
        outcome: IssueOutcome,
    ) -> Reply {
        let claim_calls = Arc::new(AtomicUsize::new(0));
        let issued = Arc::new(AtomicUsize::new(0));
        let uow = FakeClaim {
            computer: claimed_record(),
            calls: claim_calls.clone(),
        };
        let issuer = FakeIssuer {
            outcome,
            issued: issued.clone(),
        };
        let app = router(ClaimLocalComputer::new(
            uow,
            inventory,
            issuer,
            FixedEntropy::sequence(),
            FixedClock,
        ));
        let mut request =
            Request::post(HOST_CLAIM_OR_CREATE_PATH).header("content-type", "application/json");
        if with_principal {
            request = request.extension(user(OWNER));
        }
        let response = app
            .oneshot(request.body(Body::from(body.to_owned())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        Reply {
            status,
            body: String::from_utf8(bytes.to_vec()).unwrap(),
            claim_calls: claim_calls.load(SeqCst),
            issued: issued.load(SeqCst),
        }
    }

    /// The default: a principal is present, nothing is already attached, and issuance
    /// succeeds.
    async fn post_valid(body: &str) -> Reply {
        post(
            body,
            true,
            FakeInventory { has_active: false },
            IssueOutcome::Ok,
        )
        .await
    }

    fn parsed(body: &str) -> Value {
        serde_json::from_str::<Value>(body).unwrap()
    }

    fn fixture() -> Value {
        serde_json::from_str(include_str!("fixtures/claim_or_create_parity.json")).unwrap()
    }

    /// Every rejected input the Zod schema produces is reproduced field for field, and
    /// the claim authority is never reached.
    #[tokio::test]
    async fn every_invalid_input_matches_zod_and_stops_before_the_claim() {
        for entry in fixture()["invalid_inputs"].as_array().unwrap() {
            let request = serde_json::to_string(&entry["request"]).unwrap();
            let reply = post_valid(&request).await;
            assert_eq!(reply.status, StatusCode::BAD_REQUEST, "for {request}");
            assert_eq!(parsed(&reply.body), entry["body"], "for {request}");
            assert_eq!(reply.claim_calls, 0, "for {request}");
        }
    }

    /// A non-object body collapses to `invalid_type` naming the type it was, exactly as
    /// Zod's `safeParse` of the parsed value does.
    #[tokio::test]
    async fn every_invalid_shape_is_the_zod_invalid_type() {
        for entry in fixture()["invalid_shapes"].as_array().unwrap() {
            let request = serde_json::to_string(&entry["request"]).unwrap();
            let reply = post_valid(&request).await;
            assert_eq!(reply.status, StatusCode::BAD_REQUEST, "for {request}");
            assert_eq!(parsed(&reply.body), entry["body"], "for {request}");
            assert_eq!(reply.claim_calls, 0, "for {request}");
        }
    }

    /// A body that is not JSON at all is the handler's `catch(() => null)` — parsed as
    /// `null`, refused as a non-object, never reaching the claim.
    #[tokio::test]
    async fn malformed_json_is_the_null_invalid_type() {
        let reply = post_valid("{not json").await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            parsed(&reply.body),
            json!({
                "error": "invalid input",
                "issues": [{
                    "code": "invalid_type",
                    "expected": "object",
                    "received": "null",
                    "path": [],
                    "message": "Expected object, received null"
                }]
            })
        );
        assert_eq!(reply.claim_calls, 0);
    }

    /// The principal is the perimeter's contribution; without it the route parses
    /// NOTHING and fails closed rather than guessing a requester.
    #[tokio::test]
    async fn a_missing_principal_reads_nothing_and_fails_closed() {
        let reply = post(
            r#"{"installation_id":"11111111-1111-4111-8111-111111111111"}"#,
            false,
            FakeInventory { has_active: false },
            IssueOutcome::Ok,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
        assert_eq!(reply.claim_calls, 0);
        assert_eq!(reply.issued, 0);
    }

    /// A well-formed claim projects the computer through the one wire and reveals the
    /// freshly minted token exactly once.
    #[tokio::test]
    async fn a_valid_claim_projects_the_computer_and_reveals_the_token() {
        let input = &fixture()["success_full"]["parsed"];
        let reply = post_valid(&serde_json::to_string(input).unwrap()).await;
        assert_eq!(reply.status, StatusCode::OK);
        let body = parsed(&reply.body);
        assert_eq!(body["host_id"], CLAIMED_ID);
        assert_eq!(body["host"]["id"], CLAIMED_ID);
        assert_eq!(body["host"]["kind"], "local");
        assert_eq!(body["host"]["status"], "active");
        assert_eq!(body["host"]["creator_user_id"], OWNER);
        assert_eq!(body["host_token"].as_str().unwrap().len(), 43);
        assert_eq!(reply.claim_calls, 1);
        assert_eq!(reply.issued, 1);
    }

    /// A padded but non-empty label is trimmed and accepted, never a `too_small`.
    #[tokio::test]
    async fn a_padded_label_is_trimmed_and_accepted() {
        let reply = post_valid(
            r#"{"installation_id":"11111111-1111-4111-8111-111111111111","label":"  Foo  "}"#,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.issued, 1);
    }

    /// A caller already on this computer with a working credential is given no token:
    /// the response omits `host_token` and nothing is minted.
    #[tokio::test]
    async fn a_reattach_with_a_live_credential_omits_the_token() {
        let reply = post(
            &format!(
                r#"{{"installation_id":"11111111-1111-4111-8111-111111111111","current_host_id":"{CLAIMED_ID}"}}"#
            ),
            true,
            FakeInventory { has_active: true },
            IssueOutcome::Ok,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        let body = parsed(&reply.body);
        assert_eq!(body["host_id"], CLAIMED_ID);
        assert!(body.get("host_token").is_none());
        assert_eq!(reply.issued, 0);
    }

    /// A credential refused because the computer was revoked under the claim is the one
    /// typed race with a `409` of its own.
    #[tokio::test]
    async fn a_revoked_computer_under_the_claim_is_a_409() {
        let reply = post(
            r#"{"installation_id":"11111111-1111-4111-8111-111111111111"}"#,
            true,
            FakeInventory { has_active: false },
            IssueOutcome::Refused(CredentialIssueRefusal::HostRevoked),
        )
        .await;
        assert_eq!(reply.status, StatusCode::CONFLICT);
        assert_eq!(
            parsed(&reply.body),
            json!({ "error": "host has been revoked", "error_code": "host_revoked" })
        );
        assert_eq!(reply.issued, 1);
    }

    /// Any other credential refusal is a composition fault, not a product answer, so it
    /// takes a fail-closed `500`.
    #[tokio::test]
    async fn a_non_revoked_refusal_is_a_fail_closed_500() {
        let reply = post(
            r#"{"installation_id":"11111111-1111-4111-8111-111111111111"}"#,
            true,
            FakeInventory { has_active: false },
            IssueOutcome::Refused(CredentialIssueRefusal::HostUnbound),
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
    }

    /// A persistence failure in the claim is the framework's plain `500`.
    #[tokio::test]
    async fn a_write_failure_is_the_frameworks_plain_500() {
        let reply = post(
            r#"{"installation_id":"11111111-1111-4111-8111-111111111111"}"#,
            true,
            FakeInventory { has_active: false },
            IssueOutcome::Fails,
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.body, "Internal Server Error");
    }
}
