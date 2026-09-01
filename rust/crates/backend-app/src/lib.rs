#![forbid(unsafe_code)]
#![deny(rustdoc::broken_intra_doc_links)]
//! The sole executable composition root for the Rust backend.

use std::{
    env,
    error::Error,
    future::{Future, IntoFuture},
    net::SocketAddr,
    path::{Path, PathBuf},
    time::SystemTime,
};

use axum::Router;
use silverhand_backend_core::{
    application_orchestration::teardown::computer_delete::DeleteComputer,
    foundation::blob_store::StorageKind,
    host_runtime::{
        claim::ClaimLocalComputer,
        environment::{OsEntropy, SystemClock},
        invite::CreateHostInvite,
        revoke::RevokeComputer,
        rotation::{RotateConnectToken, RotateHostToken, RotateHostTokenThroughDaemon},
    },
    identity_access::access::{EnrollmentClock, unix_millis},
    identity_access::auth::{
        EntropySessionTokenMint, HumanSessionAuthenticator, SessionTtl, SystemSessionClock,
    },
    identity_access::credential::Argon2idPasswordHasher,
    policy::presence_grace::GraceWindow,
};
#[cfg(test)]
use silverhand_backend_filesystem::foundation::audit_sink::CliPreflightFileSink;
use silverhand_backend_filesystem::foundation::{
    audit_sink::{AgentAuditFileSink, CliAuditFile},
    blob_store::LocalBlobStore,
};
use silverhand_backend_filesystem::host_runtime::runtime_detection::MachineRuntimeDetector;
#[cfg(test)]
use silverhand_backend_server::internal_agent::cli_invoke::CLI_INVOKE_PRODUCTION_PERIMETER;
use silverhand_backend_server::{
    access, agent_name_availability,
    auth::{PublicJsonUnauthorized, require_human_session},
    avatar_blob::SingleKindAvatarBlobs,
    clock::SystemProcessClock,
    daemon_delivery::{
        DaemonDeliveryController, DaemonDeliveryRuntime, DaemonHostConnections,
        OnboardingDeliveryAdapter,
    },
    direct_pairs, embedded_bootstrap,
    foundation::scope_event_transport::{
        AllowedOrigin, EventWebSocketConfig, EventWebSocketController, ScopeEventHub,
    },
    host_agent::{
        agent_audit, agent_avatar, agent_avatar_write, agent_clear_session, agent_create,
        agent_delete, agent_detail, agent_list, agent_patch, agent_presence, agent_runtime_state,
        agent_runtime_switch, agent_stop, availability, public_profile_mcp,
        schedule_management::{schedule_cancel_router, schedule_list_router},
    },
    host_agent_background::{
        agent_deletion_resumer::AgentDeletionResumer, presence_grace_timer::PresenceGraceTimers,
    },
    host_control::management::{self},
    host_control::runtime_availability::DataPlaneRuntimeAvailabilityProbe,
    host_resources, host_runtime,
    human_auth::{self, HumanAuthDeps},
    internal_agent::{
        cli_invoke::audit_cli_invocations,
        diagnostics::cli_trace::cli_trace_router,
        peer_profile::{PeerProfilePorts, peer_profile_router},
        profile::self_profile_router,
        profile_mcp::profile_mcp_router,
        profile_write::{
            InternalAvatarWriteState, InternalProfileWriteState, internal_avatar_write_router,
            internal_profile_write_router,
        },
    },
    messaging::{
        TargetAddressRefusalLog,
        collaboration::{
            activity,
            attachment::{
                self, HostAttachmentEnvironment, agent_attachment_download_router,
                agent_attachment_locate_router, agent_attachment_update_router,
                agent_attachment_upload_router,
            },
            attention_projection, channel_directory, channel_lifecycle,
            conversation_agent_activity, conversation_agent_directory, conversation_agent_runtime,
            conversation_message_window, conversation_ref, conversation_threads,
            conversation_unread, human_search, message_unread, notification, reaction, saved,
            stale_message_resolution::{
                TracingStaleMessageResolutionObserver, router as stale_message_resolution_router,
            },
            thread_follow,
        },
        task::{TaskListState, task_list_router},
    },
    ops::{
        bind_address::classify_bind_address_scope,
        deployment::DeploymentProfile,
        health,
        readiness::{self, BootProgress},
        runtimes,
        server_info::{self, ServerAdvertisement},
    },
    password_hasher::SpawnBlockingHasher,
    runtime_credential::{RuntimeCredentialAuthority, require_runtime_credential},
    users::{self, UsersDeps},
    viewer_read_model::presence::{
        HubPresencePublisher, SystemDisconnectClock, compose_presence_vertical,
    },
    workspace_data_plane, workspace_detail, workspace_metadata_write, workspace_name_availability,
    workspace_rename_fanout::WorkspaceRenameFanoutAdapter,
    workspaces,
};
use silverhand_backend_sqlite::{
    access::SqliteAccessStore,
    agent_profile_write::SqliteAgentProfileWrite,
    auth::SqliteSessionStore,
    conversation_messaging::direct_pair_read::SqliteDirectPairReadModel,
    conversation_messaging::messaging::{
        HostEnvironment, MessagingStore,
        schedule::{SqliteScheduleCancel, SqliteScheduleListRead},
        task::SqliteTaskStore,
    },
    conversation_messaging::runtime_delivery::SqliteRuntimeDeliveryStore,
    embedded_bootstrap::SqliteEmbeddedBootstrap,
    foundation::scope_event::SqliteEventScopeAuthority,
    host_agent::SqliteHostAgentStore,
    host_runtime::SqliteHostRuntimeStore,
    host_runtime::agent_availability_read::SqliteAgentAvailabilityColdRead,
    host_runtime::agent_presence_read::SqliteAgentPresenceColdRead,
    host_runtime::agent_runtime_state_read::SqliteAgentRuntimeStateColdRead,
    host_runtime::computer_agents_read::SqliteComputerAgentsRead,
    host_runtime::host_resources_read::SqliteHostResourcesColdRead,
    host_runtime::runtime_credential::SqliteRuntimeCustodyStore,
    human_registration::SqliteHumanRegistration,
    identity_access::agent_audit_read::SqliteAgentAuditRead,
    identity_access::agent_avatar_read::SqliteAgentAvatarRead,
    identity_access::agent_detail_read::SqliteAgentDetailColdRead,
    identity_access::agent_list_read::SqliteAgentListColdRead,
    identity_access::agent_profile_read::SqliteAgentProfileRead,
    identity_access::credential::SqliteCredentialStore,
    identity_access::handle_namespace::SqliteHandleNamespace,
    identity_access::workspace_audience_read::SqliteWorkspaceAudienceRead,
    identity_access::workspace_cold_read::SqliteWorkspaceColdRead,
    identity_access::workspace_detail_read::SqliteWorkspaceDetailRead,
    identity_access::workspace_name_availability::SqliteRegularWorkspaceNamespace,
    user_identity::SqliteUserStore,
    viewer_read_model::unread_read::SqliteUnreadReadModel,
    viewer_read_model::user_presence_cold_read::SqliteUserPresenceColdRead,
    viewer_read_model::user_presence_last_seen::SqliteLastSeenSink,
    workspace_data_plane::SqliteWorkspaceScopeStore,
    workspace_metadata_write::SqliteWorkspaceMetadataWrite,
};
use sqlx::{Row, sqlite::SqlitePoolOptions};
use thiserror::Error;
use tokio::{net::TcpListener, sync::oneshot};

mod foundation;

mod application_orchestration;
use application_orchestration::create_aftermath::CreateAftermath;

const DATABASE_PATH_ENV: &str = "SILVERHAND_DATABASE_PATH";
/// The local blob-storage root. Required and launcher-provided, exactly like the
/// database path: the shared app-data resolver hands the backend an EXPLICIT blobs
/// directory (`packages/shared/src/app-data-layout.ts`, #task:1598 — the overloaded
/// `silverhandDir` root is retired), separate from the database file, for BOTH the
/// embedded and standalone profiles. The filesystem blob store ensures it exists on
/// open (its own `create_dir_all`, mirroring the product's `ensureReady`).
const BLOBS_ROOT_ENV: &str = "SILVERHAND_BLOBS_ROOT";
const LISTEN_ADDR_ENV: &str = "SILVERHAND_LISTEN_ADDR";
const ALLOWED_ORIGINS_ENV: &str = "SILVERHAND_ALLOWED_ORIGINS";
const DAEMON_NPM_SPEC_ENV: &str = "SILVERHAND_DAEMON_NPM_SPEC";
/// The launcher's packaging choice. Required with NO default: a backend that is not
/// told which profile it is must fail to start rather than guess (see
/// [`DeploymentProfile`]). Binding the Desktop and standalone-server entrypoints to
/// their profiles is a named packaging residual — there is no Rust launcher yet.
const DEPLOYMENT_PROFILE_ENV: &str = "SILVERHAND_DEPLOYMENT_PROFILE";
/// Optional. When set to a truthy value, public signup is closed; otherwise it is
/// open, matching the product default.
const DISABLE_SIGNUP_ENV: &str = "SILVERHAND_DISABLE_SIGNUP";
/// Required at startup. The directory categorized log files (the CLI preflight-failure
/// and agent owner-audit streams among them) are written to. GENERAL, not CLI-specific:
/// every audit surface writes its own `<prefix>-<utc>.log` under the SAME directory. The
/// Rust backend NEVER self-derives this root — no hard-coded `~/.silverhand/logs`; the
/// launcher hands it an explicit path exactly like the database and blobs roots. Unset or
/// blank becomes the typed [`StartupError::AuditLogDirectoryRequired`] mount refusal: once
/// the two producers are mounted there is no legitimate production no-sink state.
const LOG_DIR_ENV: &str = "SILVERHAND_LOG_DIR";
/// Optional. The path the embedded-bootstrap one-shot token file is written to when
/// the process is on the embedded profile bound to a loopback address. This is the
/// convergence-owned launcher contract: the backend NEVER self-derives it (no
/// hard-coded `~/.silverhand/…`) — the launcher hands it an explicit path exactly
/// like the database, blobs, and log roots. Unset (or empty) means no token file is
/// armed; combined with a non-embedded or non-loopback listener the authority stays
/// disabled and configured stale artifacts are cleaned best-effort. Environment blank is
/// normalized to unset by [`AppConfig::from_env`]; direct construction with
/// `AppConfig::new(..., Some(PathBuf::new()))` is invalid.
const BOOTSTRAP_TOKEN_PATH_ENV: &str = "SILVERHAND_BOOTSTRAP_TOKEN_PATH";
const BASELINE_MIGRATION_STEP: i64 = const_parse_i64(env!("SILVERHAND_BASELINE_MIGRATION_STEP"));
const CURRENT_MIGRATION_STEP: i64 = const_parse_i64(env!("SILVERHAND_CURRENT_MIGRATION_STEP"));
const MIGRATION_STEPS: &str = env!("SILVERHAND_MIGRATION_STEPS");

const fn const_parse_i64(value: &str) -> i64 {
    let bytes = value.as_bytes();
    let mut index = 0;
    let mut parsed = 0_i64;
    while index < bytes.len() {
        let digit = bytes[index] - b'0';
        parsed = parsed * 10 + digit as i64;
        index += 1;
    }
    parsed
}

#[derive(Clone, Debug)]
pub struct AppConfig {
    database_path: PathBuf,
    blobs_root: PathBuf,
    listen_addr: SocketAddr,
    allowed_origins: Vec<AllowedOrigin>,
    daemon_npm_spec: Option<String>,
    /// The launcher-chosen packaging profile. Both mode axes and the runtime-detection
    /// capability project from this ONE value — never picked per factory, never
    /// inferred from the listen address or the daemon spec.
    deployment_profile: DeploymentProfile,
    /// Whether public signup is open. Advertised by `/api/server/info`.
    signup_enabled: bool,
    /// The categorized-log root. `None` is representable only so startup can return the
    /// typed [`StartupError::AuditLogDirectoryRequired`] refusal; it is not a legitimate
    /// production state now that both audit producers are mounted. A configured but
    /// unopenable directory also fails startup.
    log_dir: Option<PathBuf>,
    /// The embedded-bootstrap one-shot token file path, or `None` when the launcher
    /// did not supply one. Whether a token is actually armed is a further AND with the
    /// embedded profile and the actual bound listener being loopback, decided only after
    /// `TcpListener::bind` succeeds; this field is only the launcher-provided coordinate.
    bootstrap_token_path: Option<PathBuf>,
}

impl AppConfig {
    // The arity mirrors the launcher-provided config field set (each field is an
    // independent, separately-validated input), not a factorable parameter cluster; a
    // params struct would only restate `AppConfig` itself.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        database_path: PathBuf,
        blobs_root: PathBuf,
        listen_addr: SocketAddr,
        allowed_origins: Vec<AllowedOrigin>,
        daemon_npm_spec: Option<String>,
        deployment_profile: DeploymentProfile,
        signup_enabled: bool,
        log_dir: Option<PathBuf>,
        bootstrap_token_path: Option<PathBuf>,
    ) -> Result<Self, ConfigError> {
        if database_path.as_os_str().is_empty() {
            return Err(ConfigError::EmptyDatabasePath);
        }
        if blobs_root.as_os_str().is_empty() {
            return Err(ConfigError::EmptyBlobsRoot);
        }
        if allowed_origins.is_empty() {
            return Err(ConfigError::EmptyAllowedOrigins);
        }
        // An explicitly-supplied but empty log directory is a config mistake. `None`
        // remains representable so bound-listener preparation can surface the more
        // specific mounted-producer startup refusal.
        if log_dir
            .as_ref()
            .is_some_and(|dir| dir.as_os_str().is_empty())
        {
            return Err(ConfigError::EmptyLogDir);
        }
        // Same rule as the log dir: `None` (unset) is the legitimate no-token state; an
        // explicitly-supplied empty path is a launcher mistake.
        if bootstrap_token_path
            .as_ref()
            .is_some_and(|path| path.as_os_str().is_empty())
        {
            return Err(ConfigError::EmptyBootstrapTokenPath);
        }
        let daemon_npm_spec = daemon_npm_spec
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        Ok(Self {
            database_path,
            blobs_root,
            listen_addr,
            allowed_origins,
            daemon_npm_spec,
            deployment_profile,
            signup_enabled,
            log_dir,
            bootstrap_token_path,
        })
    }

    pub fn from_env() -> Result<Self, ConfigError> {
        let database_path = required_env(DATABASE_PATH_ENV)?.into();
        let blobs_root = required_env(BLOBS_ROOT_ENV)?.into();
        let listen_addr = required_env(LISTEN_ADDR_ENV)?
            .parse()
            .map_err(ConfigError::InvalidListenAddress)?;
        let allowed_origins = required_env(ALLOWED_ORIGINS_ENV)?
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| AllowedOrigin::parse(value.to_owned()).map_err(ConfigError::InvalidOrigin))
            .collect::<Result<Vec<_>, _>>()?;
        let daemon_npm_spec = env::var(DAEMON_NPM_SPEC_ENV).ok();
        // Required, no default: an unset profile is a launcher that has not said what
        // this process is, and the only safe answer is to refuse to start.
        let deployment_profile = match required_env(DEPLOYMENT_PROFILE_ENV)?.as_str() {
            "embedded" => DeploymentProfile::Embedded,
            "remote-only" => DeploymentProfile::RemoteOnly,
            other => return Err(ConfigError::InvalidDeploymentProfile(other.to_owned())),
        };
        let signup_enabled = parse_signup_enabled(
            deployment_profile,
            env::var(DISABLE_SIGNUP_ENV).ok().as_deref(),
        )?;
        // Unset or blank is retained as `None` so startup can emit the typed
        // `AuditLogDirectoryRequired` mount refusal; a set path is taken verbatim. The
        // backend never fabricates a default root.
        let log_dir = env::var(LOG_DIR_ENV)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from);
        // Unset or blank means no bootstrap token file is provisioned; a set path is
        // taken verbatim (the embedded+actual-bound-loopback AND is applied only after
        // binding succeeds).
        let bootstrap_token_path = env::var(BOOTSTRAP_TOKEN_PATH_ENV)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from);
        Self::new(
            database_path,
            blobs_root,
            listen_addr,
            allowed_origins,
            daemon_npm_spec,
            deployment_profile,
            signup_enabled,
            log_dir,
            bootstrap_token_path,
        )
    }

    pub fn listen_addr(&self) -> SocketAddr {
        self.listen_addr
    }
}

fn required_env(name: &'static str) -> Result<String, ConfigError> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or(ConfigError::MissingEnvironment(name))
}

/// Signup admission is parsed PER PROFILE, because the two launchers ship two
/// different contracts for `SILVERHAND_DISABLE_SIGNUP` and a generic truthy helper
/// would invent a silent third one that neither honours.
///
/// - `Embedded` (`packages/backend/src/auth/config.ts`: `signupEnabled = env !== '1'`):
///   no trim, case-sensitive, ONLY the exact string `"1"` disables signup. Every other
///   value — unset, `"0"`, `"true"`, `" 1 "`, garbage, empty — enables it, and nothing
///   fails to start.
/// - `RemoteOnly` (`packages/server/src/config.ts`): unset or the exactly-empty string
///   default to enabled; any other value is trimmed and only `"0"` (enable) and `"1"`
///   (disable) are legal — everything else (including whitespace-only, `"true"`,
///   garbage) is a hard startup failure, matching `parseBoolean01`.
fn parse_signup_enabled(
    profile: DeploymentProfile,
    raw: Option<&str>,
) -> Result<bool, ConfigError> {
    match profile {
        DeploymentProfile::Embedded => Ok(raw != Some("1")),
        DeploymentProfile::RemoteOnly => match raw {
            // `resolveValue` short-circuits `undefined`/`''` to the default BEFORE the
            // parser runs; a whitespace-only value is NOT empty and does reach it.
            None | Some("") => Ok(true),
            Some(value) => match value.trim() {
                "0" => Ok(true),
                "1" => Ok(false),
                _ => Err(ConfigError::InvalidDisableSignup(value.to_owned())),
            },
        },
    }
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("required environment variable {0} is missing or empty")]
    MissingEnvironment(&'static str),
    #[error("database path must not be empty")]
    EmptyDatabasePath,
    #[error("blob storage root must not be empty")]
    EmptyBlobsRoot,
    #[error("categorized log directory must not be empty when set")]
    EmptyLogDir,
    #[error("embedded-bootstrap token path must not be empty when set")]
    EmptyBootstrapTokenPath,
    #[error("event websocket origin allowlist must not be empty")]
    EmptyAllowedOrigins,
    #[error("listen address is invalid")]
    InvalidListenAddress(#[source] std::net::AddrParseError),
    #[error("event websocket origin is invalid")]
    InvalidOrigin(
        #[source]
        silverhand_backend_server::foundation::scope_event_transport::InvalidAllowedOrigin,
    ),
    #[error("deployment profile {0:?} is not one of: embedded, remote-only")]
    InvalidDeploymentProfile(String),
    #[error("SILVERHAND_DISABLE_SIGNUP {0:?} must be 0 or 1")]
    InvalidDisableSignup(String),
}

#[derive(Debug, Error)]
pub enum StartupError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error("database schema admission failed")]
    Schema(#[source] SchemaAdmissionError),
    #[error(
        "a categorized audit log directory (SILVERHAND_LOG_DIR) is required: the mounted \
         CLI-preflight and agent owner-audit routes are durable audit producers and may not \
         run without a sink"
    )]
    AuditLogDirectoryRequired,
    #[error("failed to open production adapter {name}")]
    Adapter {
        name: &'static str,
        #[source]
        source: Box<dyn Error + Send + Sync>,
    },
    #[error("failed to construct {name}")]
    Composition {
        name: &'static str,
        #[source]
        source: Box<dyn Error + Send + Sync>,
    },
    #[error("failed to bind the configured listener")]
    Bind(#[source] std::io::Error),
    #[error("failed to read the bound listener address")]
    BoundListenerAddress(#[source] std::io::Error),
    #[error("failed to provision the embedded-bootstrap token file")]
    BootstrapToken(#[source] std::io::Error),
    #[error("served backend failed")]
    Serve(#[source] std::io::Error),
    #[error("shutdown signal authority failed")]
    ShutdownSignal(#[source] Box<dyn Error + Send + Sync>),
}

#[derive(Debug, Error)]
pub enum SchemaAdmissionError {
    #[error("database operation failed while checking the migration ledger")]
    Sql(#[source] sqlx::Error),
    #[error("database migration ledger is not the exact prefix owned by this binary")]
    LedgerMismatch,
}

/// The production [`EnrollmentClock`]. Reading the wall clock is a
/// composition-root concern, so the environment read lives here while the
/// signed/saturating `Date.now()`-parity rule stays in the domain
/// ([`unix_millis`]); this adapter is that rule's trivial one-line wrapper.
#[derive(Clone, Copy, Debug, Default)]
struct SystemEnrollmentClock;

impl EnrollmentClock for SystemEnrollmentClock {
    fn now_unix_millis(&self) -> i64 {
        unix_millis(SystemTime::now())
    }
}

/// The one production agent-deletion resumer type, spelled once so `PreparedApp` and
/// `serve` can name the shared worker without repeating its three concrete authorities:
/// the SQLite `deletion_started_at` lifecycle store, the daemon fence binder minted from
/// the one registry, and the production cascade residue. A clone of this shares its
/// `Arc<Mutex<..>>` state; there is never a second worker.
type ProductionAgentDeletionResumer = AgentDeletionResumer<
    SqliteHostAgentStore,
    DaemonHostConnections,
    host_runtime::cascade_effects::ProductionComputerCascadeEffects<
        host_runtime::cascade_effects::HubAgentDeletedAnnouncer,
    >,
>;

pub struct PreparedApp {
    pub router: Router,
    /// The live boot facts the `/readyz` router reads. Carried out of bound-listener
    /// finalization so [`serve`] can mark `listen_ready` as a witnessed consequence of
    /// serving, never merely binding/finalizing and never a handler.
    boot: BootProgress,
    event_controller: EventWebSocketController,
    daemon_controller: DaemonDeliveryController,
    presence_timers: PresenceGraceTimers<SqliteLastSeenSink, HubPresencePublisher>,
    /// The single agent-deletion resumer, already `recover`ed at boot. Carried so
    /// shutdown can `close` it FIRST — before any transport closes — so the shutdown
    /// window never keeps scheduling against a daemon that is being torn down.
    deletion_resumer: ProductionAgentDeletionResumer,
    /// #2234 CP6: the single create-aftermath boundary the `POST /api/agents` route hands
    /// its two remote post-commit legs to. Carried so shutdown can `close` it FIRST — while
    /// the daemon transport its legs drive is still alive — cancelling any in-flight leg and
    /// rejecting any dispatched afterward, exactly like the deletion resumer above.
    create_aftermath: CreateAftermath,
    /// #2256/#2261: the ONE composition-owned CLI audit-file lifecycle owner. Its two
    /// narrow facades record preflight failures and authenticated invocations into the
    /// same `cli-*.log`; neither facade can open or close the writer. Required
    /// (not optional) because mounted audit producers must
    /// have a durable sink, so bound-listener finalization fails closed without a log
    /// directory rather than degrading to a no-op. Carried so BOTH shutdown paths
    /// flush+close the same instance
    /// idempotently; it holds a background writer task whose queued lines must drain to
    /// disk before the process exits.
    cli_audit_sink: CliAuditFile<SystemProcessClock>,
    /// #2254/#2257: the ONE composition-owned owner-only agent-chat audit sink. Required on
    /// the same footing as [`Self::cli_audit_sink`] — its owner-audit read routes are
    /// mounted, so a durable sink is a startup precondition, never a no-op. Carried so BOTH
    /// shutdown paths flush+close the same instance idempotently. It writes its OWN
    /// `agent-audit-*` files through #2256's writer primitive and shares no record with the
    /// CLI sink.
    agent_audit_sink: AgentAuditFileSink<SystemProcessClock>,
    /// #2255/#2257: the process-lifetime embedded-bootstrap one-shot token authority. When
    /// armed (embedded profile + loopback listener + a launcher-provided path), it holds the
    /// SHA-256 of a token whose plaintext was written to a `0600` file before serving; when
    /// disabled it holds nothing. Carried so EVERY path after it can be armed — later
    /// startup rollback, a server-first error, or graceful shutdown — runs the SAME
    /// idempotent `cleanup`, deleting an UNCONSUMED token and disarming so it can never be
    /// spent after. A bind failure occurs before minting and therefore creates no authority.
    embedded_bootstrap_token: embedded_bootstrap::EmbeddedBootstrapTokenAuthority,
    /// #2234 CP7a (test-only): a clone of the ONE runtime-credential authority the
    /// `agent_products` perimeter is wrapped with. Carried so a composition test can mint a
    /// real bearer through `dispatch_start` against the SAME in-memory token store the mounted
    /// perimeter authenticates against — the authority is `Arc`-backed, so the clone shares its
    /// process-local token map. This is the only way to drive the internal self-scope routes'
    /// authenticated effect through the real `prepare()` router; never read in production.
    #[cfg(test)]
    test_runtime_credentials: RuntimeCredentialAuthority<SqliteRuntimeCustodyStore>,
}

impl PreparedApp {
    pub async fn close_connections(&self) {
        // The resumer stops scheduling FIRST, synchronously, while the daemon controller
        // and the SQLite owner it holds are both still alive — a stopped worker cannot
        // start a new attempt during the transport teardown below.
        self.deletion_resumer.close();
        // #2234 CP6: the create-aftermath boundary closes alongside the resumer — before any
        // transport — so an in-flight onboarding/runtime-start leg is cancelled AND its
        // future awaited-to-drop before the daemon it drives is torn down.
        self.create_aftermath.close().await;
        shut_down_transports(
            &self.event_controller,
            &self.daemon_controller,
            &self.presence_timers,
        )
        .await;
        // #2256: drain and close the audit sink's writer task. Independent of the
        // transports above, so it runs last; idempotent, so the serve-path close below
        // and this method never double-close a shared instance into a hang.
        self.cli_audit_sink.close().await;
        // #2254/#2257: the agent-chat audit sink drains on the same footing — idempotent.
        self.agent_audit_sink.close().await;
        // #2255/#2257: the embedded-bootstrap token is disarmed and its unconsumed file
        // unlinked on this teardown path too; idempotent and ENOENT-tolerant.
        self.embedded_bootstrap_token.cleanup().await;
    }

    /// A clone of the composition-owned CLI audit sink, for composition tests to record
    /// through the REAL `prepare()`-constructed sink (and to witness its terminal state
    /// after close). The sink shares its writer via `Arc`, so the clone drives the SAME
    /// file.
    #[cfg(test)]
    fn cli_audit_sink(&self) -> CliPreflightFileSink<SystemProcessClock> {
        self.cli_audit_sink.preflight_sink()
    }

    /// A clone of the composition-owned agent-chat audit sink, for composition tests to
    /// record through the REAL `prepare()`-constructed sink. It shares its writer via
    /// `Arc`, so the clone drives the SAME file.
    #[cfg(test)]
    fn agent_audit_sink(&self) -> AgentAuditFileSink<SystemProcessClock> {
        self.agent_audit_sink.clone()
    }

    /// A clone of the composition-owned embedded-bootstrap token authority, for
    /// composition tests to witness the enable/disable decision (`consume` succeeds only
    /// on an armed authority) and its shutdown cleanup. The authority is `Arc`-backed, so
    /// the clone shares the one in-memory one-shot cell the mounted route consults.
    #[cfg(test)]
    fn embedded_bootstrap_token(&self) -> embedded_bootstrap::EmbeddedBootstrapTokenAuthority {
        self.embedded_bootstrap_token.clone()
    }
}

/// The one shutdown order shared by [`PreparedApp::close_connections`] and
/// [`serve`], so the two can never drift. The event transport closes and the INSTANT
/// it does the presence authority disposes its live grace windows — mirroring the TS
/// `eventWs.close()` → `ctx.presence.dispose()` sequence. A pending grace window is a
/// live intention, never a durable one, so shutdown drops it without emitting an
/// offline.
///
/// The daemon transport is unrelated to user presence, so its close runs CONCURRENTLY
/// with the whole event→dispose chain; it must never sit BETWEEN the event close and
/// the dispose. Sequencing `join!(event.close(), daemon.close())` before a bare
/// dispose only guarantees "after both", which lets the unrelated daemon close delay
/// the dispose — under a config where daemon shutdown outlasts the grace window, a
/// disconnect that already started its window could seal and publish an offline
/// mid-shutdown. The order is a contract, not a coincidence of today's 1.5s < 20s
/// constants.
async fn shut_down_transports(
    event_controller: &EventWebSocketController,
    daemon_controller: &DaemonDeliveryController,
    presence_timers: &PresenceGraceTimers<SqliteLastSeenSink, HubPresencePublisher>,
) {
    tokio::join!(
        async {
            event_controller.close().await;
            presence_timers.dispose();
        },
        daemon_controller.close(),
    );
}

async fn open<T, E>(
    name: &'static str,
    operation: impl Future<Output = Result<T, E>>,
) -> Result<T, StartupError>
where
    E: Error + Send + Sync + 'static,
{
    operation.await.map_err(|source| StartupError::Adapter {
        name,
        source: Box::new(source),
    })
}

/// Write the embedded-bootstrap token plaintext to a fresh file at `path`, created
/// mode-0600 on unix, via a same-directory temp + atomic rename so a reader never
/// observes a partial token and the final file is owner-only from the instant it is
/// linked into place. The parent directory must already exist (the launcher owns it).
/// The raw token flows only through here; it is never logged, and on any error the
/// `io::Error` is returned WITHOUT the token in its message.
async fn write_bootstrap_token_file(path: &Path, token: &str) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;

    let tmp = bootstrap_token_tmp_path(path);
    // Clear a leftover temp from a crashed prior boot so `create_new` below cannot fail
    // spuriously; a missing temp is the normal case.
    match tokio::fs::remove_file(&tmp).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let write_result = async {
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&tmp).await?;
        file.write_all(token.as_bytes()).await?;
        file.write_all(b"\n").await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&tmp, path).await
    }
    .await;

    if let Err(error) = write_result {
        // A write/sync/rename fault must not leave a plaintext temp token behind. Preserve
        // the original startup error; an unlink fault is separately observable and never
        // includes the raw token.
        if let Err(cleanup_error) = tokio::fs::remove_file(&tmp).await
            && cleanup_error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(
                error = %cleanup_error,
                "embedded bootstrap: failed to remove a partial token temp file"
            );
        }
        return Err(error);
    }
    Ok(())
}

/// The sibling temp path for the atomic token write (`<name>.tmp` in the same directory,
/// so the final rename stays on one filesystem).
fn bootstrap_token_tmp_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".tmp");
    path.with_file_name(name)
}

/// Best-effort removal of both stale token artifacts when the authority is NOT armed (not
/// the embedded profile, or a non-loopback listener): the final file and the deterministic
/// same-directory `.tmp` that a crashed write may have left behind. A missing artifact is
/// success; any other unlink fault is observable as a warning and swallowed so cleanup
/// never aborts startup. Neither artifact path nor its raw contents enter the log.
async fn remove_stale_bootstrap_token(path: &Path) {
    for artifact in [path.to_path_buf(), bootstrap_token_tmp_path(path)] {
        match tokio::fs::remove_file(artifact).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(
                    error = %error,
                    "embedded bootstrap: failed to clear a stale token artifact"
                );
            }
        }
    }
}

async fn verify_schema(path: &Path) -> Result<(), SchemaAdmissionError> {
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(SchemaAdmissionError::Sql)?;
    let rows = sqlx::query("SELECT version FROM _migrations ORDER BY version")
        .fetch_all(&pool)
        .await
        .map_err(SchemaAdmissionError::Sql)?;
    let actual = rows
        .iter()
        .map(|row| row.try_get::<i64, _>("version"))
        .collect::<Result<Vec<_>, _>>()
        .map_err(SchemaAdmissionError::Sql)?;
    pool.close().await;
    let expected = MIGRATION_STEPS
        .split(',')
        .map(|step| {
            step.parse::<i64>()
                .expect("build script emitted numeric migration step")
        })
        .collect::<Vec<_>>();
    if actual.iter().any(|step| *step > CURRENT_MIGRATION_STEP) {
        return Err(SchemaAdmissionError::LedgerMismatch);
    }
    let active = actual
        .into_iter()
        .filter(|step| *step >= BASELINE_MIGRATION_STEP)
        .collect::<Vec<_>>();
    if active != expected || active.last() != Some(&CURRENT_MIGRATION_STEP) {
        return Err(SchemaAdmissionError::LedgerMismatch);
    }
    Ok(())
}

pub async fn run(config: AppConfig) -> Result<(), StartupError> {
    let (listener, app) = application_orchestration::bind_and_prepare(&config).await?;
    // The bound listener is the bootstrap decision witness; `serve` establishes
    // `listen_ready` from that SAME socket. A failed bind never minted a token, and a
    // post-bind prepare failure released the socket before returning.
    serve(listener, app, shutdown_signal()).await
}

pub async fn serve<F, E>(
    listener: TcpListener,
    app: PreparedApp,
    shutdown: F,
) -> Result<(), StartupError>
where
    F: Future<Output = Result<(), E>> + Send,
    E: Error + Send + Sync + 'static,
{
    let PreparedApp {
        router,
        boot,
        event_controller,
        daemon_controller,
        presence_timers,
        deletion_resumer,
        create_aftermath,
        cli_audit_sink,
        agent_audit_sink,
        embedded_bootstrap_token,
        #[cfg(test)]
            test_runtime_credentials: _,
    } = app;
    // The serving boundary, witnessed by the already-bound `TcpListener` this function
    // was handed: reaching here means a listener exists, so `/readyz` may now report
    // `listen_ready`. Marked from the listener rather than by a public `PreparedApp`
    // method, so EVERY caller that serves a bound listener establishes the fact and no
    // caller can fake it without one — a prepared-but-unserved app stays 503.
    boot.mark_listen_ready();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    // #2255/#2257: serve with per-connection `ConnectInfo<SocketAddr>` so the
    // embedded-bootstrap `LoopbackPeer` gate can read the real TCP peer. Every other
    // route ignores the extension; absent connect-info the gate fails closed to 404.
    let server = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        let _ = shutdown_rx.await;
    })
    .into_future();
    tokio::pin!(server);
    tokio::pin!(shutdown);
    let outcome = tokio::select! {
        result = &mut server => {
            // The server terminated on its own — an error return, or an unexpected
            // completion — WITHOUT our shutdown signal. The audit sink still owns lines
            // accepted before this instant; its drain+close runs in the shared tail
            // below, so this path can never lose them to a bare object drop.
            result.map_err(StartupError::Serve)
        }
        signal = &mut shutdown => {
            let _ = shutdown_tx.send(());
            // #2234 CP3: the resumer stops scheduling FIRST — synchronously, while the
            // daemon controller and its SQLite owner are both still alive — so no attempt
            // can be started during the transport teardown that follows.
            deletion_resumer.close();
            // #2234 CP6: the create-aftermath boundary closes alongside it — same window,
            // ahead of transport teardown — cancelling any in-flight leg and awaiting its
            // future to drop before the daemon it drives is torn down.
            create_aftermath.close().await;
            // The one shared shutdown order (see `shut_down_transports`): event close
            // then an immediate presence dispose, daemon close concurrent but never
            // wedged between the two.
            shut_down_transports(&event_controller, &daemon_controller, &presence_timers).await;
            server
                .as_mut()
                .await
                .map_err(StartupError::Serve)
                .and_then(|()| {
                    signal.map_err(|source| StartupError::ShutdownSignal(Box::new(source)))
                })
        }
    };
    // #2256: the audit sink's drain+close is the LAST step on EVERY termination path —
    // the graceful signal arm and a server-first error return alike — so accepted lines
    // are never lost to a bare object drop, and it runs after the transports the signal
    // arm tore down. Idempotent, so it is a safe no-op if any other entry point already
    // closed the shared instance.
    cli_audit_sink.close().await;
    // #2254/#2257: the agent-chat audit sink drains on the SAME last-step footing —
    // idempotent.
    agent_audit_sink.close().await;
    // #2255/#2257: the embedded-bootstrap token is disarmed and any unconsumed file
    // unlinked on EVERY termination path (graceful signal or server-first error) — the
    // one-shot cleanup is idempotent and safe after a consume, and never re-arms.
    embedded_bootstrap_token.cleanup().await;
    outcome
}

async fn shutdown_signal() -> Result<(), std::io::Error> {
    tokio::signal::ctrl_c().await
}

pub fn describe(error: &(dyn Error + 'static)) -> String {
    let mut rendered = error.to_string();
    let mut current = error.source();
    while let Some(source) = current {
        rendered.push_str(": ");
        rendered.push_str(&source.to_string());
        current = source.source();
    }
    rendered
}

#[cfg(test)]
#[path = "../../backend-sqlite/tests/support/current_schema_snapshot.rs"]
mod current_schema;
