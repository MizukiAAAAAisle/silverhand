use std::{
    future::Future,
    sync::{Arc, OnceLock},
    time::Instant,
};

use argon2::{
    Algorithm, Argon2, Params, Version,
    password_hash::{PasswordHash, PasswordHasher as _, PasswordVerifier as _, SaltString},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

use crate::host_runtime::environment::EntropySource;

/// The one algorithm this backend issues and accepts.
pub const ARGON2ID_ALGORITHM: &str = "argon2id";
/// The Argon2 version tag, spelled the way it is persisted (`0x13` == 19).
pub const ARGON2ID_VERSION: &str = "0x13";
/// Password-security floor: never calibrate below 19 MiB of memory…
pub const FLOOR_MEMORY_COST_KIB: u32 = 19 * 1024;
/// …nor below two passes.
pub const FLOOR_TIME_COST: u32 = 2;
/// Derived-key length in bytes.
pub const OUTPUT_LEN: u32 = 32;
/// Calibration aims for a hash that costs roughly this many milliseconds.
pub const TARGET_HASH_MILLIS: u64 = 250;
/// The honest producer identifier this backend stamps into provenance. It
/// deliberately is NOT `@node-rs/argon2`: these rows are produced by the Rust
/// implementation and must say so.
pub const RUST_PRODUCER: &str = "silverhand/argon2-rustcrypto";

/// Salt length in bytes (matches the TS `randomBytes(16)` precedent).
const SALT_BYTES: usize = 16;
/// The fixed dummy password length drawn for the uniform-timing verify.
const DUMMY_PASSWORD_BYTES: usize = 32;

/// The Argon2id cost knobs. These are the shared, cross-producer fields of the
/// persisted provenance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Argon2idCost {
    pub memory_cost_kib: u32,
    pub time_cost: u32,
    pub parallelism: u32,
    pub output_len: u32,
}

/// Honest calibration metadata for a Rust-produced row: what the calibration
/// targeted, what the selected cost actually measured, how many candidates were
/// evaluated, and the floors it was clamped against. It does NOT carry
/// Node-only fields (`selectedAt`, `cpuCount`, `totalMemoryMiB`) — inventing
/// those would be a persisted lie.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RustCalibration {
    pub target_millis: u64,
    pub measured_millis: u64,
    pub candidate_count: u32,
    pub floor_memory_cost_kib: u32,
    pub floor_time_cost: u32,
}

/// The structured provenance a Rust-produced credential carries. The
/// persistence layer serializes this into `password_hash_params`; the PHC
/// string remains the sole verify authority.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PasswordHashParams {
    pub cost: Argon2idCost,
    pub calibration: RustCalibration,
}

/// The two products of hashing a plaintext: the PHC string to store as
/// `password_hash`, and the structured provenance to store as
/// `password_hash_params`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedPasswordCredential {
    pub phc: String,
    pub params: PasswordHashParams,
}

/// A hashing failure is an infrastructure fault (entropy refused, or the KDF
/// itself errored), never a product outcome — routes map it to a safe-500.
#[derive(Debug, thiserror::Error)]
#[error("failed to hash a password")]
pub struct PasswordHashError {
    #[source]
    source: Box<dyn std::error::Error + Send + Sync>,
}

impl PasswordHashError {
    fn from_source<E>(source: E) -> Self
    where
        E: std::error::Error + Send + Sync + 'static,
    {
        Self {
            source: Box::new(source),
        }
    }

    fn message(message: impl Into<String>) -> Self {
        #[derive(Debug, thiserror::Error)]
        #[error("{0}")]
        struct Message(String);

        Self {
            source: Box::new(Message(message.into())),
        }
    }

    /// A blocking-offload join failure — the KDF task panicked or the runtime is
    /// shutting down. An infrastructure fault the server adapter surfaces so the
    /// flow takes the safe-500, never a product answer. Public so the server's
    /// single offload adapter (the only thing that runs the KDF off-reactor) can
    /// construct it without a second error home.
    pub fn offload_join_failed<E>(source: E) -> Self
    where
        E: std::error::Error + Send + Sync + 'static,
    {
        Self::from_source(source)
    }

    /// A test-only fault value, so a fake KDF in another module can prove the
    /// dummy-verify failure path propagates rather than silently no-ops.
    #[cfg(test)]
    pub(crate) fn for_test() -> Self {
        Self::message("test-induced password hash failure")
    }
}

/// A hasher authority was asked to calibrate against an empty candidate ladder.
/// That is a construction/configuration fault the public constructor reports
/// rather than panicking on — a hasher with nothing to select from could never
/// produce an honest `candidateCount`.
#[derive(Debug, thiserror::Error)]
#[error("the argon2 candidate ladder is empty")]
pub struct EmptyCandidateLadder;

/// The credential context's hashing port — **async so the synchronous Argon2id
/// KDF can be offloaded off the request reactor**. Argon2id is a deliberately
/// ~250ms CPU computation; the production adapter (the server's single
/// [`SpawnBlockingHasher`](../../../silverhand_backend_server/index.html)) runs it
/// on a blocking pool so concurrent signup/login cannot starve unrelated
/// health/readiness/WS futures. Fakes implement this directly with immediate
/// futures; core never offloads (it must not depend on any runtime).
///
/// `verify` returns `Ok(false)` for a malformed *stored* PHC (matching the TS
/// `try/catch → false`) — that is a product "wrong credential", not a fault. It
/// Errs ONLY on an infrastructure fault (a blocking-pool join failure).
/// `verify_dummy` spends the same cost on a missing account so login timing cannot
/// distinguish "unknown email" from "wrong password"; it Errs if the dummy PHC
/// itself cannot be produced (entropy/KDF fault) — the login flow must take the
/// safe-500 there, never silently skip the uniform-timing cost. Every Err is a
/// safe-500 seam, never a product answer.
pub trait PasswordHasher: Clone + Send + Sync + 'static {
    fn hash(
        &self,
        password: &str,
    ) -> impl Future<Output = Result<PreparedPasswordCredential, PasswordHashError>> + Send;
    fn verify(
        &self,
        phc: &str,
        password: &str,
    ) -> impl Future<Output = Result<bool, PasswordHashError>> + Send;
    fn verify_dummy(&self, password: &str)
    -> impl Future<Output = Result<(), PasswordHashError>> + Send;
}

/// The synchronous Argon2id computation, split from the async [`PasswordHasher`]
/// port so the CPU work has ONE home and the offload boundary has ONE home.
/// Production wires a [`PasswordKdf`] into the server's single offload adapter,
/// which is the sole thing that turns these blocking calls into the async port;
/// core defines the computation and lets the packaging layer own where it runs.
///
/// Same answer contract as the async port, minus the offload fault: `verify`
/// returns `false` for a malformed stored PHC (never an error — a product "wrong
/// credential"), and `verify_dummy` Errs only when the dummy PHC cannot be
/// produced (an entropy/KDF fault), so the login flow can take the safe-500 rather
/// than silently skipping the uniform-timing cost.
pub trait PasswordKdf: Clone + Send + Sync + 'static {
    fn hash(&self, password: &str) -> Result<PreparedPasswordCredential, PasswordHashError>;
    fn verify(&self, phc: &str, password: &str) -> bool;
    fn verify_dummy(&self, password: &str) -> Result<(), PasswordHashError>;
}

/// Measures how long one hash costs at a given candidate. Injected so tests can
/// select calibration deterministically without touching the wall clock.
pub trait CostMeasurer: Send + Sync + 'static {
    fn measure_millis(&self, cost: &Argon2idCost) -> u64;
}

/// Production measurer: actually runs one Argon2id hash at the candidate cost
/// and times it. Only ever consulted during the one-time calibration.
#[derive(Clone, Copy, Debug, Default)]
pub struct RealArgon2Measurer;

impl CostMeasurer for RealArgon2Measurer {
    fn measure_millis(&self, cost: &Argon2idCost) -> u64 {
        let sample_salt = match SaltString::encode_b64(&[0u8; SALT_BYTES]) {
            Ok(salt) => salt,
            Err(_) => return u64::MAX,
        };
        let Some(hasher) = argon2_for(cost) else {
            return u64::MAX;
        };
        let started = Instant::now();
        let _ = hasher.hash_password(b"calibration-sample", &sample_salt);
        u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

/// Build an `Argon2` configured for `cost`, or `None` if the knobs are invalid.
fn argon2_for(cost: &Argon2idCost) -> Option<Argon2<'static>> {
    let params = Params::new(
        cost.memory_cost_kib,
        cost.time_cost,
        cost.parallelism,
        Some(cost.output_len as usize),
    )
    .ok()?;
    Some(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

/// The production Argon2id hasher.
///
/// Calibration happens **once per hasher authority**: the result lives in a
/// shared [`OnceLock`], and cloning the hasher (as routers do) shares that same
/// cell — clones never recalibrate. A freshly constructed hasher is a *new*
/// authority and would calibrate on its own; the guarantee that exactly one
/// exists in production is a composition-root property, proven by the mount
/// wiring, not a type-level invariant.
pub struct Argon2idPasswordHasher<E, M> {
    entropy: Arc<E>,
    measurer: Arc<M>,
    candidates: Arc<[Argon2idCost]>,
    target_millis: u64,
    calibrated: Arc<OnceLock<PasswordHashParams>>,
    dummy_phc: Arc<OnceLock<String>>,
}

impl<E, M> Clone for Argon2idPasswordHasher<E, M> {
    fn clone(&self) -> Self {
        Self {
            entropy: Arc::clone(&self.entropy),
            measurer: Arc::clone(&self.measurer),
            candidates: Arc::clone(&self.candidates),
            target_millis: self.target_millis,
            calibrated: Arc::clone(&self.calibrated),
            dummy_phc: Arc::clone(&self.dummy_phc),
        }
    }
}

impl<E> Argon2idPasswordHasher<E, RealArgon2Measurer>
where
    E: EntropySource + 'static,
{
    /// The production constructor: a real timing measurer and a memory-scaling
    /// candidate ladder anchored at the floor, with parallelism clamped to the
    /// host's available parallelism (1..=4, matching the TS clamp).
    pub fn production(entropy: E) -> Self {
        let parallelism = std::thread::available_parallelism()
            .map(|value| value.get() as u32)
            .unwrap_or(1)
            .clamp(1, 4);
        let candidates: Vec<Argon2idCost> = [1u32, 2, 3, 4, 5, 6, 8, 10]
            .into_iter()
            .map(|multiple| Argon2idCost {
                memory_cost_kib: FLOOR_MEMORY_COST_KIB * multiple,
                time_cost: FLOOR_TIME_COST,
                parallelism,
                output_len: OUTPUT_LEN,
            })
            .collect();
        // The production ladder is a fixed non-empty literal, so this bypasses
        // the empty-ladder check by construction rather than unwrapping a Result
        // (no panic path). `production_ladder_is_never_empty` is the positive gate
        // that keeps `candidateCount >= 1` a by-construction persistent property.
        Self::from_candidates(entropy, RealArgon2Measurer, candidates, TARGET_HASH_MILLIS)
    }
}

impl<E, M> Argon2idPasswordHasher<E, M>
where
    E: EntropySource + 'static,
    M: CostMeasurer,
{
    /// Full constructor with an injected measurer and candidate ladder. Tests
    /// use this with a deterministic measurer so calibration is reproducible
    /// and never touches the wall clock.
    ///
    /// **Fallible**: an empty candidate ladder is a construction/configuration
    /// fault, not a process panic — a hasher with nothing to select from could
    /// never produce an honest `candidateCount`. Callers that supply their own
    /// ladder handle [`EmptyCandidateLadder`]; the production ladder is a fixed
    /// non-empty literal and takes the infallible internal path.
    pub fn with_measurer(
        entropy: E,
        measurer: M,
        candidates: Vec<Argon2idCost>,
        target_millis: u64,
    ) -> Result<Self, EmptyCandidateLadder> {
        if candidates.is_empty() {
            return Err(EmptyCandidateLadder);
        }
        Ok(Self::from_candidates(entropy, measurer, candidates, target_millis))
    }

    /// Infallible internal constructor over an already-non-empty ladder. Only
    /// [`with_measurer`](Self::with_measurer) (after its emptiness check) and
    /// [`production`](Self::production) (with its fixed literal ladder) reach it.
    fn from_candidates(
        entropy: E,
        measurer: M,
        candidates: Vec<Argon2idCost>,
        target_millis: u64,
    ) -> Self {
        Self {
            entropy: Arc::new(entropy),
            measurer: Arc::new(measurer),
            candidates: Arc::from(candidates),
            target_millis,
            calibrated: Arc::new(OnceLock::new()),
            dummy_phc: Arc::new(OnceLock::new()),
        }
    }

    /// The calibrated parameters, computed once and shared thereafter.
    fn params(&self) -> PasswordHashParams {
        *self
            .calibrated
            .get_or_init(|| self.calibrate())
    }

    /// Walk the candidate ladder, clamping every candidate up to the floor, and
    /// select the first whose measured cost meets the target (or the strongest
    /// if none does). Records honest calibration metadata.
    fn calibrate(&self) -> PasswordHashParams {
        let mut evaluated = 0u32;
        let mut selected: Option<(Argon2idCost, u64)> = None;
        for candidate in self.candidates.iter() {
            let cost = clamp_to_floor(candidate);
            let measured = self.measurer.measure_millis(&cost);
            evaluated += 1;
            let strongest_so_far = selected
                .map(|(prior, _)| cost_is_at_least(&cost, &prior))
                .unwrap_or(true);
            if strongest_so_far {
                selected = Some((cost, measured));
            }
            if measured >= self.target_millis {
                selected = Some((cost, measured));
                break;
            }
        }
        let (cost, measured_millis) = selected.unwrap_or_else(|| {
            let cost = clamp_to_floor(&Argon2idCost {
                memory_cost_kib: FLOOR_MEMORY_COST_KIB,
                time_cost: FLOOR_TIME_COST,
                parallelism: 1,
                output_len: OUTPUT_LEN,
            });
            (cost, 0)
        });
        PasswordHashParams {
            cost,
            calibration: RustCalibration {
                target_millis: self.target_millis,
                measured_millis,
                candidate_count: evaluated,
                floor_memory_cost_kib: FLOOR_MEMORY_COST_KIB,
                floor_time_cost: FLOOR_TIME_COST,
            },
        }
    }

    /// Hash `password` at the calibrated cost with a fresh entropy-drawn salt.
    fn hash_with(&self, params: &PasswordHashParams, password: &str) -> Result<String, PasswordHashError> {
        let mut salt_bytes = [0u8; SALT_BYTES];
        self.entropy
            .fill(&mut salt_bytes)
            .map_err(PasswordHashError::from_source)?;
        let salt = SaltString::encode_b64(&salt_bytes).map_err(|error| {
            PasswordHashError::message(format!("failed to encode salt: {error}"))
        })?;
        let hasher = argon2_for(&params.cost)
            .ok_or_else(|| PasswordHashError::message("invalid calibrated argon2 parameters"))?;
        let hash = hasher
            .hash_password(password.as_bytes(), &salt)
            .map_err(|error| PasswordHashError::message(format!("argon2 hash failed: {error}")))?;
        Ok(hash.to_string())
    }

    /// The memoized dummy PHC, hashed once at the calibrated cost from an
    /// entropy-drawn dummy password (mirrors the TS `getDummyHash`). Fallible:
    /// an entropy or KDF fault here must propagate so the login flow takes the
    /// safe-500 rather than silently skipping the uniform-timing cost.
    fn dummy_phc(&self) -> Result<&str, PasswordHashError> {
        if let Some(existing) = self.dummy_phc.get() {
            return Ok(existing.as_str());
        }
        let params = self.params();
        let mut dummy_bytes = [0u8; DUMMY_PASSWORD_BYTES];
        self.entropy
            .fill(&mut dummy_bytes)
            .map_err(PasswordHashError::from_source)?;
        let dummy_password = URL_SAFE_NO_PAD.encode(dummy_bytes);
        let phc = self.hash_with(&params, &dummy_password)?;
        let _ = self.dummy_phc.set(phc);
        // `set` raced-lost only if another thread just filled it; either way the
        // cell now holds a valid dummy PHC.
        Ok(self
            .dummy_phc
            .get()
            .map(String::as_str)
            .expect("the dummy PHC cell was just populated"))
    }
}

impl<E, M> PasswordKdf for Argon2idPasswordHasher<E, M>
where
    E: EntropySource + 'static,
    M: CostMeasurer,
{
    fn hash(&self, password: &str) -> Result<PreparedPasswordCredential, PasswordHashError> {
        let params = self.params();
        let phc = self.hash_with(&params, password)?;
        Ok(PreparedPasswordCredential { phc, params })
    }

    fn verify(&self, phc: &str, password: &str) -> bool {
        // The PHC string is the verify authority: params come from it, not from
        // the calibrated cost or the stored provenance JSON.
        let Ok(parsed) = PasswordHash::new(phc) else {
            return false;
        };
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    }

    fn verify_dummy(&self, password: &str) -> Result<(), PasswordHashError> {
        let phc = self.dummy_phc()?;
        let _ = self.verify(phc, password);
        Ok(())
    }
}

/// Raise a candidate's memory/time knobs to the security floor.
fn clamp_to_floor(cost: &Argon2idCost) -> Argon2idCost {
    Argon2idCost {
        memory_cost_kib: cost.memory_cost_kib.max(FLOOR_MEMORY_COST_KIB),
        time_cost: cost.time_cost.max(FLOOR_TIME_COST),
        parallelism: cost.parallelism.max(1),
        output_len: OUTPUT_LEN,
    }
}

/// A total-ish "at least as strong" comparison over the two hardness knobs.
fn cost_is_at_least(candidate: &Argon2idCost, baseline: &Argon2idCost) -> bool {
    candidate.memory_cost_kib >= baseline.memory_cost_kib && candidate.time_cost >= baseline.time_cost
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic measurer: each candidate's measured time is a pure
    /// function of its memory cost, so calibration is reproducible with no
    /// wall-clock involvement.
    struct LinearMeasurer {
        millis_per_mib: u64,
    }

    impl CostMeasurer for LinearMeasurer {
        fn measure_millis(&self, cost: &Argon2idCost) -> u64 {
            (cost.memory_cost_kib as u64 / 1024) * self.millis_per_mib
        }
    }

    struct ZeroEntropy;

    impl EntropySource for ZeroEntropy {
        type Error = std::convert::Infallible;

        fn fill(&self, destination: &mut [u8]) -> Result<(), Self::Error> {
            destination.fill(0);
            Ok(())
        }
    }

    /// An entropy source that always refuses. Used to prove the real hasher's
    /// dummy-verify path surfaces an infrastructure fault instead of swallowing
    /// it into a silent `Ok(())`.
    #[derive(Debug, thiserror::Error)]
    #[error("entropy source refused")]
    struct EntropyRefused;

    struct FailingEntropy;

    impl EntropySource for FailingEntropy {
        type Error = EntropyRefused;

        fn fill(&self, _destination: &mut [u8]) -> Result<(), Self::Error> {
            Err(EntropyRefused)
        }
    }

    fn ladder() -> Vec<Argon2idCost> {
        [1u32, 2, 3, 4]
            .into_iter()
            .map(|m| Argon2idCost {
                memory_cost_kib: FLOOR_MEMORY_COST_KIB * m,
                time_cost: FLOOR_TIME_COST,
                parallelism: 1,
                output_len: OUTPUT_LEN,
            })
            .collect()
    }

    #[test]
    fn calibration_selects_the_first_candidate_meeting_target_and_is_shared() {
        // 19 MiB -> 190ms, 38 -> 380ms: target 250 first met at the 2x rung.
        let hasher = Argon2idPasswordHasher::with_measurer(
            ZeroEntropy,
            LinearMeasurer { millis_per_mib: 10 },
            ladder(),
            TARGET_HASH_MILLIS,
        )
        .unwrap();
        let params = hasher.params();
        assert_eq!(params.cost.memory_cost_kib, FLOOR_MEMORY_COST_KIB * 2);
        assert_eq!(params.cost.time_cost, FLOOR_TIME_COST);
        assert_eq!(params.cost.output_len, OUTPUT_LEN);
        assert_eq!(params.calibration.target_millis, TARGET_HASH_MILLIS);
        assert_eq!(params.calibration.measured_millis, 380);
        assert_eq!(params.calibration.candidate_count, 2);

        // A clone shares the calibrated cell — same params, no recalibration.
        assert_eq!(hasher.clone().params(), params);
    }

    #[test]
    fn calibration_never_drops_below_the_floor() {
        let hasher = Argon2idPasswordHasher::with_measurer(
            ZeroEntropy,
            // Even the floor already exceeds target, so the weakest is selected…
            LinearMeasurer { millis_per_mib: 100 },
            ladder(),
            TARGET_HASH_MILLIS,
        )
        .unwrap();
        let params = hasher.params();
        assert!(params.cost.memory_cost_kib >= FLOOR_MEMORY_COST_KIB);
        assert!(params.cost.time_cost >= FLOOR_TIME_COST);
    }

    #[test]
    fn hash_then_verify_round_trips_and_rejects_the_wrong_password() {
        let hasher = Argon2idPasswordHasher::with_measurer(
            ZeroEntropy,
            LinearMeasurer { millis_per_mib: 0 },
            ladder(),
            TARGET_HASH_MILLIS,
        )
        .unwrap();
        let prepared = hasher.hash("correct horse").unwrap();
        assert!(hasher.verify(&prepared.phc, "correct horse"));
        assert!(!hasher.verify(&prepared.phc, "wrong horse"));
    }

    #[test]
    fn phc_declares_argon2id_v0x13_and_the_calibrated_cost() {
        let hasher = Argon2idPasswordHasher::with_measurer(
            ZeroEntropy,
            LinearMeasurer { millis_per_mib: 10 },
            ladder(),
            TARGET_HASH_MILLIS,
        )
        .unwrap();
        let prepared = hasher.hash("pw").unwrap();
        let parsed = PasswordHash::new(&prepared.phc).unwrap();
        assert_eq!(parsed.algorithm.as_str(), ARGON2ID_ALGORITHM);
        assert_eq!(parsed.version, Some(Version::V0x13 as u32));
        let phc_params = Params::try_from(&parsed).unwrap();
        assert_eq!(phc_params.m_cost(), prepared.params.cost.memory_cost_kib);
        assert_eq!(phc_params.t_cost(), prepared.params.cost.time_cost);
    }

    #[test]
    fn verify_of_a_malformed_phc_is_false_not_an_error() {
        let hasher = Argon2idPasswordHasher::with_measurer(
            ZeroEntropy,
            LinearMeasurer { millis_per_mib: 0 },
            ladder(),
            TARGET_HASH_MILLIS,
        )
        .unwrap();
        assert!(!hasher.verify("not-a-phc-string", "pw"));
    }

    #[test]
    fn verify_dummy_runs_without_a_stored_credential() {
        let hasher = Argon2idPasswordHasher::with_measurer(
            ZeroEntropy,
            LinearMeasurer { millis_per_mib: 0 },
            ladder(),
            TARGET_HASH_MILLIS,
        )
        .unwrap();
        // Its only observable effect is spending hash cost; with sound entropy
        // and KDF it succeeds rather than silently no-opping.
        hasher.verify_dummy("some password").unwrap();
    }

    #[test]
    fn verify_dummy_propagates_an_entropy_fault_rather_than_swallowing_it() {
        // The REAL production hasher, given a refusing entropy source: producing
        // the dummy PHC needs a drawn dummy password, so the fault must surface as
        // an Err. This is the load-bearing gate for the safe-500 seam — if
        // `dummy_phc` ever swallowed the fault (e.g. `.ok()` + a fallback), the
        // login flow would silently skip the uniform-timing cost and this gate
        // goes red. `FailingDummyHasher` in `human_auth_flows` only proves the flow
        // propagates an already-returned Err; only this exercises the real KDF.
        let hasher = Argon2idPasswordHasher::with_measurer(
            FailingEntropy,
            LinearMeasurer { millis_per_mib: 0 },
            ladder(),
            TARGET_HASH_MILLIS,
        )
        .unwrap();
        assert!(
            hasher.verify_dummy("some password").is_err(),
            "an entropy fault in the dummy hash must propagate, never become Ok(())"
        );
    }

    #[test]
    fn with_measurer_rejects_an_empty_candidate_ladder() {
        // An empty ladder is a construction fault reported as an error, never a
        // panic and never a hasher that would fabricate `candidateCount = 0`.
        let outcome = Argon2idPasswordHasher::with_measurer(
            ZeroEntropy,
            LinearMeasurer { millis_per_mib: 0 },
            Vec::new(),
            TARGET_HASH_MILLIS,
        );
        assert!(matches!(outcome, Err(EmptyCandidateLadder)));
    }

    #[test]
    fn production_ladder_is_never_empty() {
        // The positive gate behind `production`'s infallible construction: the
        // fixed ladder yields a real selection, so `candidateCount >= 1` holds by
        // construction for every shipped hasher.
        let hasher = Argon2idPasswordHasher::production(ZeroEntropy);
        assert!(hasher.params().calibration.candidate_count >= 1);
    }

    /// A PHC string produced by the Node `@node-rs/argon2` implementation at the
    /// same floor cost (m=19456, t=2, p=1, outputLen=32) over the password below.
    /// Checked-in fixture proves the shared persisted contract: an old Node row
    /// verifies under the Rust Argon2id verifier byte-for-byte.
    const NODE_ARGON2ID_PHC: &str =
        include_str!("../../tests/fixtures/node-argon2id-phc.txt");
    const NODE_FIXTURE_PASSWORD: &str = "correct-horse-battery-staple";

    #[test]
    fn verifies_a_node_produced_phc_for_the_shared_persisted_contract() {
        let hasher = Argon2idPasswordHasher::with_measurer(
            ZeroEntropy,
            LinearMeasurer { millis_per_mib: 0 },
            ladder(),
            TARGET_HASH_MILLIS,
        )
        .unwrap();
        let node_phc = NODE_ARGON2ID_PHC.trim();
        assert!(
            hasher.verify(node_phc, NODE_FIXTURE_PASSWORD),
            "a Node-produced PHC must verify under the Rust verifier"
        );
        assert!(
            !hasher.verify(node_phc, "the-wrong-password"),
            "the same PHC must reject a wrong password"
        );
    }
}
