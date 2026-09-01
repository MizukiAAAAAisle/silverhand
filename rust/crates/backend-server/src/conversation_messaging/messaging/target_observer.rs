use std::{convert::Infallible, fmt::Write};

use sha2::{Digest, Sha256};
use silverhand_backend_core::conversation_messaging::messaging::{
    AddressRefusal, TargetAddressRefusalPort, TargetAddressRefusalReport,
};

/// The production operator-only target-refusal exit.
///
/// The raw address reaches this required capability so it can correlate retries,
/// but the log stores only a versioned digest. Named targets can contain user
/// prose, and refused targets can be guesses the actor was not authorized to
/// resolve.
#[derive(Clone, Copy, Debug, Default)]
pub struct TargetAddressRefusalLog;

impl TargetAddressRefusalPort for TargetAddressRefusalLog {
    type Error = Infallible;

    async fn refused(&self, report: &TargetAddressRefusalReport) -> Result<(), Self::Error> {
        tracing::warn!(
            delivery_target_event = "refused",
            code = refusal_code(report.refusal()),
            operator_reason = report.reason().as_str(),
            intent = intent_name(report.intent()),
            principal_id = report.principal().as_str(),
            address_hash = %hash_address(report.address()),
            "delivery target refused"
        );
        Ok(())
    }
}

fn intent_name(
    intent: silverhand_backend_core::conversation_messaging::messaging::DeliveryIntent,
) -> &'static str {
    match intent {
        silverhand_backend_core::conversation_messaging::messaging::DeliveryIntent::Write => {
            "write"
        }
    }
}

fn refusal_code(refusal: AddressRefusal) -> &'static str {
    match refusal {
        AddressRefusal::Malformed => "target_malformed",
        AddressRefusal::SelfPair => "self_pair_not_addressable",
        AddressRefusal::Unresolved => "target_unresolved",
        AddressRefusal::ThreadNotInTarget => "thread_not_in_target",
    }
}

fn hash_address(address: &str) -> String {
    let digest = Sha256::digest(address.as_bytes());
    let mut output = String::from("sha256:");
    for byte in &digest[..12] {
        write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::hash_address;

    #[test]
    fn address_correlation_is_versioned_and_bounded() {
        assert_eq!(
            hash_address("#Private/Planning"),
            "sha256:c0cbd4212bcb5bd590189c20"
        );
    }
}
