//! The two mode axes an operational face reports.
//!
//! They answer different questions and are configured independently — the boot
//! options carry one as `mode` and the other inside `serverConfig` — so they are two
//! types rather than one. Both spell one of their values `"embedded"`, which is
//! exactly why folding them would be dangerous: a face that read the deployment axis
//! and rendered it as the server axis would agree with the product on every embedded
//! deployment and only diverge on the configurations nobody runs in a test.

/// How this server is being run relative to the desktop app it serves.
///
/// Pinned to `ServerModeSchema` (`packages/shared/src/config.ts`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ServerMode {
    Embedded,
    Remote,
}

impl ServerMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Embedded => "embedded",
            Self::Remote => "remote",
        }
    }
}

/// Which composition installed this backend, and therefore which capabilities it is
/// expected to have. A standalone backend is control-plane only: it has no
/// co-located daemon host, so the machine it runs on is not a machine any agent runs
/// on.
///
/// Pinned to `BackendDeploymentMode` (`packages/backend/src/context.ts`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeploymentMode {
    Embedded,
    Standalone,
}

impl DeploymentMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Embedded => "embedded",
            Self::Standalone => "standalone",
        }
    }

    /// The product's `standaloneMode(ctx)` predicate, owned by the axis it reads so a
    /// route asks the question instead of re-spelling the comparison.
    pub const fn is_standalone(self) -> bool {
        matches!(self, Self::Standalone)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both axes' wire spellings, pinned to their TypeScript authorities.
    #[test]
    fn each_axis_spells_its_own_values() {
        assert_eq!(
            [ServerMode::Embedded.as_str(), ServerMode::Remote.as_str()],
            ["embedded", "remote"]
        );
        assert_eq!(
            [
                DeploymentMode::Embedded.as_str(),
                DeploymentMode::Standalone.as_str()
            ],
            ["embedded", "standalone"]
        );
    }

    /// The standalone predicate is the axis's own, and `remote` is NOT standalone —
    /// the confusion the two types exist to prevent.
    #[test]
    fn only_the_standalone_deployment_is_standalone() {
        assert!(DeploymentMode::Standalone.is_standalone());
        assert!(!DeploymentMode::Embedded.is_standalone());
    }
}
