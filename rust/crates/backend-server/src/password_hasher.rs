//! The ONE offload boundary between the async [`PasswordHasher`] port and the
//! synchronous Argon2id computation.
//!
//! Argon2id is a deliberately ~250ms CPU burn. Running it inline on an Axum
//! request task would occupy a Tokio worker for that whole time, so a burst of
//! concurrent signups/logins could starve unrelated futures (health, readiness,
//! websockets) sharing the runtime. This adapter is the single place that turns
//! the core's runtime-agnostic sync [`PasswordKdf`] into the async port, moving
//! every one of the three operations (`hash`, `verify`, `verify_dummy`) onto
//! Tokio's blocking pool via `spawn_blocking`.
//!
//! It is the ONLY thing in the system that offloads: the core port stays
//! Tokio-free (fakes implement it with immediate futures), and there is exactly
//! one adapter rather than a per-route wrapper, so the offload rule has one home.
//! A join failure — the blocking task panicked or the runtime is shutting down —
//! is an infrastructure fault, surfaced through
//! [`PasswordHashError::offload_join_failed`] so the flow takes the lane's
//! safe-500, never a product answer.

use silverhand_backend_core::credential::{
    PasswordHashError, PasswordHasher, PasswordKdf, PreparedPasswordCredential,
};

/// Wraps a synchronous [`PasswordKdf`] and offloads its work onto Tokio's
/// blocking pool, presenting the async [`PasswordHasher`] port the routes depend
/// on. Clone is cheap: the inner KDF is itself `Clone` (its calibration cell is
/// shared, so clones never recalibrate).
#[derive(Clone)]
pub struct SpawnBlockingHasher<K> {
    kdf: K,
}

impl<K> SpawnBlockingHasher<K> {
    /// Wrap a KDF. The single production hasher authority is constructed once by
    /// the composition root and wrapped here; cloning the wrapper shares the KDF's
    /// calibration.
    pub fn new(kdf: K) -> Self {
        Self { kdf }
    }
}

impl<K> PasswordHasher for SpawnBlockingHasher<K>
where
    K: PasswordKdf,
{
    async fn hash(&self, password: &str) -> Result<PreparedPasswordCredential, PasswordHashError> {
        let kdf = self.kdf.clone();
        let password = password.to_owned();
        tokio::task::spawn_blocking(move || kdf.hash(&password))
            .await
            .map_err(PasswordHashError::offload_join_failed)?
    }

    async fn verify(&self, phc: &str, password: &str) -> Result<bool, PasswordHashError> {
        let kdf = self.kdf.clone();
        let phc = phc.to_owned();
        let password = password.to_owned();
        tokio::task::spawn_blocking(move || kdf.verify(&phc, &password))
            .await
            .map_err(PasswordHashError::offload_join_failed)
    }

    async fn verify_dummy(&self, password: &str) -> Result<(), PasswordHashError> {
        let kdf = self.kdf.clone();
        let password = password.to_owned();
        tokio::task::spawn_blocking(move || kdf.verify_dummy(&password))
            .await
            .map_err(PasswordHashError::offload_join_failed)?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use silverhand_backend_core::{
        credential::{
            Argon2idCost, Argon2idPasswordHasher, CostMeasurer, FLOOR_MEMORY_COST_KIB,
            FLOOR_TIME_COST, OUTPUT_LEN, TARGET_HASH_MILLIS,
        },
        host_runtime::environment::OsEntropy,
    };
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    };

    /// A KDF that parks inside `verify` on a channel until the test releases it,
    /// signalling first that it has entered. It lets the test hold the blocking
    /// computation open and observe the reactor meanwhile.
    #[derive(Clone)]
    struct GatedKdf {
        entered_tx: mpsc::Sender<()>,
        release_rx: Arc<Mutex<mpsc::Receiver<()>>>,
    }

    impl PasswordKdf for GatedKdf {
        fn hash(&self, _password: &str) -> Result<PreparedPasswordCredential, PasswordHashError> {
            unreachable!("this fake only exercises verify")
        }

        fn verify(&self, _phc: &str, _password: &str) -> bool {
            // Announce that the offloaded computation is running, then park until
            // released — holding a would-be reactor thread hostage IF this ran
            // inline instead of on the blocking pool.
            self.entered_tx.send(()).unwrap();
            self.release_rx.lock().unwrap().recv().unwrap();
            true
        }

        fn verify_dummy(&self, _password: &str) -> Result<(), PasswordHashError> {
            Ok(())
        }
    }

    /// The offload discriminator, on a single-threaded runtime. While the KDF is
    /// parked inside its blocking computation, an unrelated future MUST still make
    /// progress and the offloaded verify MUST still be pending — both of which are
    /// impossible if the ~250ms KDF ran inline on the one reactor thread (that
    /// would wedge the worker and hang this test to a CI timeout).
    #[tokio::test]
    async fn the_kdf_runs_off_reactor_so_an_unrelated_future_still_progresses() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let hasher = SpawnBlockingHasher::new(GatedKdf {
            entered_tx,
            release_rx: Arc::new(Mutex::new(release_rx)),
        });

        // Kick off the offloaded verify; it will park inside the blocking KDF.
        let verify = tokio::spawn(async move { hasher.verify("phc", "pw").await });

        // Confirm the KDF has actually entered its blocking park (waiting on a
        // blocking thread so as not to occupy the single reactor worker).
        tokio::task::spawn_blocking(move || entered_rx.recv().unwrap())
            .await
            .unwrap();

        // The verify is parked. An unrelated future scheduled on the SAME
        // single-threaded reactor still runs to completion — proof the KDF is not
        // sitting on the worker.
        let progressed = Arc::new(AtomicBool::new(false));
        let flag = progressed.clone();
        tokio::spawn(async move { flag.store(true, Ordering::SeqCst) })
            .await
            .unwrap();
        assert!(
            progressed.load(Ordering::SeqCst),
            "an unrelated future must progress while the KDF is parked"
        );
        assert!(
            !verify.is_finished(),
            "the offloaded verify must still be parked, not resolved"
        );

        // Release the KDF; the verify now resolves to its computed answer.
        release_tx.send(()).unwrap();
        assert!(matches!(verify.await.unwrap(), Ok(true)));
    }

    /// A measurer that reports a fixed time, so calibration is deterministic and
    /// never touches the wall clock.
    struct FixedMeasurer(u64);
    impl CostMeasurer for FixedMeasurer {
        fn measure_millis(&self, _cost: &Argon2idCost) -> u64 {
            self.0
        }
    }

    /// The real production KDF satisfies [`PasswordKdf`] and pairs with the
    /// adapter: a hash offloaded through `spawn_blocking` verifies back through it.
    /// This is the type-level + behavioral proof that the shipping Argon2id hasher
    /// is what the offload boundary wraps (calibration uses a fixed measurer so the
    /// floor rung is selected without a wall-clock probe; the hash itself is real).
    #[tokio::test]
    async fn the_production_argon2_kdf_pairs_with_the_offload_adapter() {
        let floor_only = vec![Argon2idCost {
            memory_cost_kib: FLOOR_MEMORY_COST_KIB,
            time_cost: FLOOR_TIME_COST,
            parallelism: 1,
            output_len: OUTPUT_LEN,
        }];
        let kdf = Argon2idPasswordHasher::with_measurer(
            OsEntropy,
            FixedMeasurer(TARGET_HASH_MILLIS),
            floor_only,
            TARGET_HASH_MILLIS,
        )
        .unwrap();
        let hasher = SpawnBlockingHasher::new(kdf);

        let prepared = hasher.hash("correct horse").await.unwrap();
        assert!(hasher.verify(&prepared.phc, "correct horse").await.unwrap());
        assert!(!hasher.verify(&prepared.phc, "wrong horse").await.unwrap());
    }
}
