//! Classifying the address this server is bound to, for the one field that tells an
//! operator how exposed the process is.
//!
//! A pure, total function over a single hostname or IP literal. It does NOT resolve
//! DNS and does not enumerate interfaces: the input is what the operator configured,
//! and the answer is what that configuration can be read to mean.
//!
//! ## The bias is deliberate and one-directional
//!
//! Every uncertain input classifies as [`BindAddressScope::Public`] — the empty
//! string, a wildcard bind, an unparseable literal, any name the classifier does not
//! recognise. `bind_address_scope` gates a boot WARN about a reachable server with
//! open signup, so UNDER-stating exposure suppresses the warning exactly where it
//! matters most. Over-stating it costs a warning nobody needed.
//!
//! Ported from `packages/shared/src/bind-address-scope.ts`, arm for arm and in the
//! same order, including its wider-than-elsewhere loopback range: the whole of
//! `127.0.0.0/8` is loopback here, so an operator who binds `127.0.0.2` is not warned
//! at a machine that is in fact unreachable.

/// How reachable the bound address is.
///
/// Pinned to `BindAddressScopeSchema` (`packages/shared/src/api/server.ts`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BindAddressScope {
    /// `localhost` / `127.0.0.0/8` / `::1`. No reachability beyond this machine.
    Loopback,
    /// RFC1918, IPv4 link-local, IPv6 link-local and unique-local, or an mDNS
    /// `*.local` name: reachable from the same network, not from the internet.
    Lan,
    /// Anything else, including every wildcard bind and every input the classifier
    /// cannot place.
    Public,
}

impl BindAddressScope {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Loopback => "loopback",
            Self::Lan => "lan",
            Self::Public => "public",
        }
    }
}

/// Loopback literals. Kept as its own list rather than shared with client-side URL
/// classification: this one accepts the whole space an operator may pass through the
/// listen configuration, and the two surfaces have different threat models.
const LOOPBACK_LITERALS: [&str; 4] = ["localhost", "127.0.0.1", "::1", "[::1]"];

/// Wildcard binds, classified public because what they actually expose depends on the
/// interfaces the machine happens to have. The bracketed IPv6 form appears because
/// some configuration sources surface it that way.
const WILDCARD_LITERALS: [&str; 3] = ["0.0.0.0", "::", "[::]"];

pub fn classify_bind_address_scope(raw: &str) -> BindAddressScope {
    let lowered = raw.trim().to_lowercase();
    if lowered.is_empty() {
        // Usually a mis-set default rather than a deliberate choice; treated as a
        // wildcard, which is the conservative reading.
        return BindAddressScope::Public;
    }
    if LOOPBACK_LITERALS.contains(&lowered.as_str()) {
        return BindAddressScope::Loopback;
    }
    if WILDCARD_LITERALS.contains(&lowered.as_str()) {
        return BindAddressScope::Public;
    }
    if ipv4_within(&lowered, [127, 0, 0, 0], 8) {
        return BindAddressScope::Loopback;
    }
    for (network, prefix) in [
        ([10, 0, 0, 0], 8),
        ([172, 16, 0, 0], 12),
        ([192, 168, 0, 0], 16),
        // RFC 3927 IPv4 link-local: same reachability story as RFC1918.
        ([169, 254, 0, 0], 16),
    ] {
        if ipv4_within(&lowered, network, prefix) {
            return BindAddressScope::Lan;
        }
    }
    let unbracketed = lowered
        .strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .unwrap_or(&lowered);
    // `fe80::/10` spelled as the four nibble prefixes it can start with, and `fc00::/7`
    // as its two — the product's own approximation, kept rather than tightened so the
    // two implementations classify identically.
    if ["fe8", "fe9", "fea", "feb"]
        .iter()
        .any(|prefix| unbracketed.starts_with(prefix))
    {
        return BindAddressScope::Lan;
    }
    if unbracketed.starts_with("fc") || unbracketed.starts_with("fd") {
        return BindAddressScope::Lan;
    }
    // mDNS: formally a different namespace, but the same "same local network"
    // exposure, so the same bucket. Read from the bracketed form exactly as the
    // product does — a `*.local` name is never bracketed.
    if lowered.ends_with(".local") {
        return BindAddressScope::Lan;
    }
    BindAddressScope::Public
}

/// Whether a dotted-decimal IPv4 literal falls inside `network/prefix`.
///
/// Strict: exactly four canonical octets. Shorthand, hex and decimal forms are not
/// accepted — a bind address never arrives in them, and accepting them would mean
/// this classifier had to agree with a resolver about what they mean.
fn ipv4_within(input: &str, network: [u8; 4], prefix: u32) -> bool {
    let mut octets = [0u8; 4];
    let mut filled = 0;
    for part in input.split('.') {
        let Some(octet) = canonical_octet(part) else {
            return false;
        };
        if filled == octets.len() {
            return false;
        }
        octets[filled] = octet;
        filled += 1;
    }
    if filled != octets.len() {
        return false;
    }
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    u32::from_be_bytes(octets) & mask == u32::from_be_bytes(network) & mask
}

/// One octet in its canonical printable form: digits only, in range, and no leading
/// zero — `010` is not how a bind address is written, and reading it as ten would make
/// this function disagree with the product's parser.
fn canonical_octet(part: &str) -> Option<u8> {
    if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if part.len() > 1 && part.starts_with('0') {
        return None;
    }
    part.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(raw: &str) -> &'static str {
        classify_bind_address_scope(raw).as_str()
    }

    #[test]
    fn loopback_is_the_whole_of_127_8_and_the_names_for_it() {
        for local in [
            "localhost",
            "LOCALHOST",
            "  127.0.0.1  ",
            "127.0.0.2",
            "127.255.255.254",
            "::1",
            "[::1]",
        ] {
            assert_eq!(scope(local), "loopback", "{local}");
        }
    }

    #[test]
    fn private_link_local_unique_local_and_mdns_are_lan() {
        for lan in [
            "10.0.0.1",
            "10.255.255.255",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.10",
            "169.254.0.1",
            "fe80::1",
            "[fe80::1]",
            "feb0::1",
            "fc00::1",
            "fd12:3456::1",
            "my-box.local",
            "MY-BOX.LOCAL",
        ] {
            assert_eq!(scope(lan), "lan", "{lan}");
        }
    }

    /// A wildcard bind exposes whichever interfaces the machine has, so it is public
    /// even though it is spelled like an absence of choice.
    #[test]
    fn every_wildcard_bind_is_public() {
        for wildcard in ["0.0.0.0", "::", "[::]", "", "   "] {
            assert_eq!(scope(wildcard), "public", "{wildcard:?}");
        }
    }

    #[test]
    fn routable_addresses_and_global_names_are_public() {
        for public in [
            "8.8.8.8",
            "172.15.255.255",
            "172.32.0.1",
            "192.167.1.1",
            "169.253.0.1",
            "128.0.0.1",
            "silverhand.example.com",
            "2001:db8::1",
        ] {
            assert_eq!(scope(public), "public", "{public}");
        }
    }

    /// The parser's strictness is what keeps the classifier from having to agree with a
    /// resolver: anything that is not four canonical octets simply is not an IPv4
    /// literal here, and falls through to the conservative answer.
    #[test]
    fn a_literal_that_is_not_four_canonical_octets_is_not_matched_as_ipv4() {
        for malformed in [
            "010.0.0.1",
            "10.0.0",
            "10.0.0.1.2",
            "10.0.0.",
            "10.0.0.256",
            "10.0.0.-1",
            "10.0.0.0x1",
            "127.1",
        ] {
            assert_eq!(
                scope(malformed),
                "public",
                "{malformed} must not be read as a private or loopback literal"
            );
        }
    }

    #[test]
    fn the_three_scopes_spell_themselves_the_way_the_schema_does() {
        assert_eq!(
            [
                BindAddressScope::Loopback.as_str(),
                BindAddressScope::Lan.as_str(),
                BindAddressScope::Public.as_str()
            ],
            ["loopback", "lan", "public"]
        );
    }
}
