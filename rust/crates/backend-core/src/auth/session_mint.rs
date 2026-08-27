use std::{fmt, sync::Arc};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use thiserror::Error;

use crate::{auth::session::SessionTokenHash, host_runtime::EntropySource};

/// Number of CSPRNG bytes behind one session bearer, matching the TS
/// `randomBytes(32)` issue precedent.
const SESSION_SECRET_BYTES: usize = 32;

/// A freshly minted bearer plaintext on its way to the one caller that issued
/// it. The value is deliberately unclonable and never printed: the only way to
/// read it is to *consume* it via [`IssuedSessionSecret::into_wire`], so the
/// domain and persistence layers cannot fan a second copy out. This narrows the
/// live surface of the plaintext; it is not a global unrepresentability claim.
///
/// ```compile_fail
/// use silverhand_backend_core::auth::IssuedSessionSecret;
/// fn duplicate(secret: &IssuedSessionSecret) -> IssuedSessionSecret {
///     secret.clone()
/// }
/// ```
pub struct IssuedSessionSecret(String);

impl IssuedSessionSecret {
    /// Consume the secret, yielding the wire plaintext exactly once. After this
    /// the secret no longer exists, so a response projector holds the single
    /// surviving copy.
    pub fn into_wire(self) -> String {
        self.0
    }
}

impl fmt::Debug for IssuedSessionSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("IssuedSessionSecret([REDACTED])")
    }
}

/// The two products of one mint: the opaque plaintext for the caller and the
/// lookup coordinate to persist. Both are mandatory, so they are surrendered
/// together through [`MintedSession::into_parts`] rather than a consume-to-one
/// accessor that would silently drop the other half.
pub struct MintedSession {
    secret: IssuedSessionSecret,
    token_hash: SessionTokenHash,
}

impl MintedSession {
    pub fn into_parts(self) -> (IssuedSessionSecret, SessionTokenHash) {
        (self.secret, self.token_hash)
    }
}

/// The outbound port that produces one fresh session bearer. Cloneable so it
/// can be shared across a router's handlers exactly like the other session
/// ports.
pub trait SessionTokenMint: Clone + Send + Sync + 'static {
    fn mint(&self) -> Result<MintedSession, SessionMintError>;
}

/// A mint failure is an infrastructure fault (the CSPRNG refused), never a
/// product outcome. Routes map it onto the safe-500 seam.
#[derive(Debug, Error)]
#[error("failed to mint a session token")]
pub struct SessionMintError {
    #[source]
    source: Box<dyn std::error::Error + Send + Sync>,
}

/// Production mint: draws [`SESSION_SECRET_BYTES`] from the injected entropy
/// source, encodes them as url-safe base64 (the plaintext), and derives the
/// stored coordinate through the single canonical [`SessionTokenHash`]
/// derivation. The entropy source is held behind an `Arc` so the mint stays
/// `Clone` without constraining the source itself.
pub struct EntropySessionTokenMint<E> {
    entropy: Arc<E>,
}

impl<E> EntropySessionTokenMint<E> {
    pub fn new(entropy: E) -> Self {
        Self {
            entropy: Arc::new(entropy),
        }
    }
}

impl<E> Clone for EntropySessionTokenMint<E> {
    fn clone(&self) -> Self {
        Self {
            entropy: Arc::clone(&self.entropy),
        }
    }
}

impl<E> SessionTokenMint for EntropySessionTokenMint<E>
where
    E: EntropySource + 'static,
{
    fn mint(&self) -> Result<MintedSession, SessionMintError> {
        let mut bytes = [0u8; SESSION_SECRET_BYTES];
        self.entropy
            .fill(&mut bytes)
            .map_err(|error| SessionMintError {
                source: Box::new(error),
            })?;
        let plaintext = URL_SAFE_NO_PAD.encode(bytes);
        let token_hash = SessionTokenHash::of_plaintext(&plaintext);
        Ok(MintedSession {
            secret: IssuedSessionSecret(plaintext),
            token_hash,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// Deterministic entropy: each fill emits a distinct, reproducible pattern
    /// so tests can assert exact plaintext/hash relationships without a real
    /// CSPRNG.
    struct CountingEntropy {
        next: Mutex<u8>,
    }

    impl CountingEntropy {
        fn starting_at(seed: u8) -> Self {
            Self {
                next: Mutex::new(seed),
            }
        }
    }

    #[derive(Debug, Error)]
    #[error("entropy exhausted")]
    struct NeverFails;

    impl EntropySource for CountingEntropy {
        type Error = NeverFails;

        fn fill(&self, destination: &mut [u8]) -> Result<(), Self::Error> {
            let mut cursor = self.next.lock().unwrap();
            for slot in destination.iter_mut() {
                *slot = *cursor;
                *cursor = cursor.wrapping_add(1);
            }
            Ok(())
        }
    }

    #[derive(Debug, Error)]
    #[error("csprng unavailable")]
    struct AlwaysFails;

    struct FailingEntropy;

    impl EntropySource for FailingEntropy {
        type Error = AlwaysFails;

        fn fill(&self, _destination: &mut [u8]) -> Result<(), Self::Error> {
            Err(AlwaysFails)
        }
    }

    #[test]
    fn mints_thirty_two_bytes_whose_hash_matches_the_canonical_derivation() {
        let mint = EntropySessionTokenMint::new(CountingEntropy::starting_at(0));
        let (secret, token_hash) = mint.mint().unwrap().into_parts();
        let plaintext = secret.into_wire();

        let decoded = URL_SAFE_NO_PAD.decode(&plaintext).unwrap();
        assert_eq!(decoded.len(), SESSION_SECRET_BYTES);
        assert_eq!(decoded, (0u8..32).collect::<Vec<_>>());
        assert_eq!(
            token_hash.as_str(),
            SessionTokenHash::of_plaintext(&plaintext).as_str()
        );
    }

    #[test]
    fn consecutive_mints_differ() {
        let mint = EntropySessionTokenMint::new(CountingEntropy::starting_at(0));
        let (first_secret, first_hash) = mint.mint().unwrap().into_parts();
        let (second_secret, second_hash) = mint.mint().unwrap().into_parts();

        assert_ne!(first_secret.into_wire(), second_secret.into_wire());
        assert_ne!(first_hash.as_str(), second_hash.as_str());
    }

    #[test]
    fn entropy_failure_surfaces_as_a_mint_error() {
        let mint = EntropySessionTokenMint::new(FailingEntropy);
        assert!(mint.mint().is_err());
    }

    #[test]
    fn secret_debug_is_redacted() {
        let mint = EntropySessionTokenMint::new(CountingEntropy::starting_at(7));
        let (secret, _) = mint.mint().unwrap().into_parts();
        assert_eq!(format!("{secret:?}"), "IssuedSessionSecret([REDACTED])");
    }
}
