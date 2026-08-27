#![forbid(unsafe_code)]
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
    access::{EnrollmentClock, unix_millis},
    auth::{EntropySessionTokenMint, HumanSessionAuthenticator, SessionTtl, SystemSessionClock},
    credential::Argon2idPasswordHasher,
    host_runtime::{
        claim::ClaimLocalComputer,
        environment::{OsEntropy, SystemClock},
        invite::CreateHostInvite,
        rotation::{RotateHostToken, RotateHostTokenThroughDaemon},
    },
    policy::presence_grace::GraceWindow,
};
use silverhand_backend_filesystem::runtime_detection::MachineRuntimeDetector;
use silverhand_backend_server::{
    access,
    auth::{PublicJsonUnauthorized, require_human_session},
    clock::SystemProcessClock,
    daemon_delivery::{DaemonDeliveryController, DaemonDeliveryRuntime},
    direct_pairs,
    host_agent::{agent_detail, agent_list, agent_presence, availability},
    host_agent_background::presence_grace_timer::PresenceGraceTimers,
    host_resources, host_runtime,
    human_auth::{self, HumanAuthDeps},
    messaging::{
        TargetAddressRefusalLog,
        collaboration::{
            activity, attention_projection, channel_directory, channel_lifecycle,
            conversation_agent_activity, conversation_agent_directory, conversation_agent_runtime,
            conversation_message_window, conversation_ref, conversation_threads,
            conversation_unread, human_search, message_unread, saved,
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
    scope_events::{
        AllowedOrigin, EventWebSocketConfig, EventWebSocketController, HubPresenceSink,
        ScopeEventHub, SystemDisconnectClock, compose_presence_vertical,
    },
    workspace_detail,
    workspace_metadata_write::{self, WorkspaceMetadataClock},
    workspace_name_availability,
    workspace_rename_fanout::WorkspaceRenameFanoutAdapter,
    workspaces,
};
use silverhand_backend_sqlite::{
    access::SqliteAccessStore,
    agent_availability_read::SqliteAgentAvailabilityColdRead,
    agent_detail_read::SqliteAgentDetailColdRead,
    agent_list_read::SqliteAgentListColdRead,
    agent_presence_read::SqliteAgentPresenceColdRead,
    auth::SqliteSessionStore,
    credential::SqliteCredentialStore,
    direct_pair_read::SqliteDirectPairReadModel,
    handle_namespace::SqliteHandleNamespace,
    host_resources_read::SqliteHostResourcesColdRead,
    host_runtime::SqliteHostRuntimeStore,
    human_registration::SqliteHumanRegistration,
    messaging::{MessagingStore, task::SqliteTaskStore},
    runtime_credential::SqliteRuntimeCustodyStore,
    runtime_delivery::SqliteRuntimeDeliveryStore,
    scope_event::SqliteEventScopeAuthority,
    unread_read::SqliteUnreadReadModel,
    user_identity::SqliteUserStore,
    user_presence_cold_read::SqliteUserPresenceColdRead,
    user_presence_last_seen::SqliteLastSeenSink,
    workspace_audience_read::SqliteWorkspaceAudienceRead,
    workspace_cold_read::SqliteWorkspaceColdRead,
    workspace_detail_read::SqliteWorkspaceDetailRead,
    workspace_metadata_write::SqliteWorkspaceMetadataWrite,
    workspace_name_availability::SqliteRegularWorkspaceNamespace,
};
use sqlx::{Row, sqlite::SqlitePoolOptions};
use thiserror::Error;
use tokio::{net::TcpListener, sync::oneshot};

mod request_perimeter;

const DATABASE_PATH_ENV: &str = "SILVERHAND_DATABASE_PATH";
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
    listen_addr: SocketAddr,
    allowed_origins: Vec<AllowedOrigin>,
    daemon_npm_spec: Option<String>,
    /// The launcher-chosen packaging profile. Both mode axes and the runtime-detection
    /// capability project from this ONE value — never picked per factory, never
    /// inferred from the listen address or the daemon spec.
    deployment_profile: DeploymentProfile,
    /// Whether public signup is open. Advertised by `/api/server/info`.
    signup_enabled: bool,
}

impl AppConfig {
    pub fn new(
        database_path: PathBuf,
        listen_addr: SocketAddr,
        allowed_origins: Vec<AllowedOrigin>,
        daemon_npm_spec: Option<String>,
        deployment_profile: DeploymentProfile,
        signup_enabled: bool,
    ) -> Result<Self, ConfigError> {
        if database_path.as_os_str().is_empty() {
            return Err(ConfigError::EmptyDatabasePath);
        }
        if allowed_origins.is_empty() {
            return Err(ConfigError::EmptyAllowedOrigins);
        }
        let daemon_npm_spec = daemon_npm_spec
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        Ok(Self {
            database_path,
            listen_addr,
            allowed_origins,
            daemon_npm_spec,
            deployment_profile,
            signup_enabled,
        })
    }

    pub fn from_env() -> Result<Self, ConfigError> {
        let database_path = required_env(DATABASE_PATH_ENV)?.into();
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
        Self::new(
            database_path,
            listen_addr,
            allowed_origins,
            daemon_npm_spec,
            deployment_profile,
            signup_enabled,
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
    #[error("event websocket origin allowlist must not be empty")]
    EmptyAllowedOrigins,
    #[error("listen address is invalid")]
    InvalidListenAddress(#[source] std::net::AddrParseError),
    #[error("event websocket origin is invalid")]
    InvalidOrigin(#[source] silverhand_backend_server::scope_events::InvalidAllowedOrigin),
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

/// The production [`WorkspaceMetadataClock`]. The workspace-metadata write leaf
/// states the clock as its narrow time capability and deliberately ships no
/// production or no-op adapter, so this composition root supplies the trivial
/// wrapper the leaf's own doc names — the same `unix_millis(SystemTime::now())`
/// wall-clock read as [`SystemEnrollmentClock`], with the signed `Date.now()`-parity
/// conversion staying in the domain ([`unix_millis`]). Injecting it lets a test pin
/// the stamped `updated_at`/`archived_at`; production reads the real clock here.
#[derive(Clone, Copy, Debug, Default)]
struct SystemWorkspaceMetadataClock;

impl WorkspaceMetadataClock for SystemWorkspaceMetadataClock {
    fn now_unix_millis(&self) -> i64 {
        unix_millis(SystemTime::now())
    }
}

pub struct PreparedApp {
    pub router: Router,
    /// The live boot facts the `/readyz` router reads. Carried out of `prepare()` so
    /// [`serve`] — which holds the already-bound `TcpListener` — can mark `listen_ready`
    /// as a witnessed consequence of serving, never `prepare()` and never a handler.
    boot: BootProgress,
    event_controller: EventWebSocketController,
    daemon_controller: DaemonDeliveryController,
    presence_timers: PresenceGraceTimers<SqliteLastSeenSink, HubPresenceSink>,
}

impl PreparedApp {
    pub async fn close_connections(&self) {
        shut_down_transports(
            &self.event_controller,
            &self.daemon_controller,
            &self.presence_timers,
        )
        .await;
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
    presence_timers: &PresenceGraceTimers<SqliteLastSeenSink, HubPresenceSink>,
) {
    tokio::join!(
        async {
            event_controller.close().await;
            presence_timers.dispose();
        },
        daemon_controller.close(),
    );
}

pub async fn prepare(config: &AppConfig) -> Result<PreparedApp, StartupError> {
    verify_schema(&config.database_path)
        .await
        .map_err(StartupError::Schema)?;

    // The migration ledger has just been verified as the exact prefix this binary owns,
    // which is the fact `/readyz` reports. `listen_ready` is NOT marked here — it is a
    // serving-boundary fact, established in `run()` after the listener binds. The
    // outbound-fanout fact has no mark call anywhere yet: that transport is unmigrated,
    // so a standalone deployment stays honestly `503` rather than claiming a projection
    // it does not run.
    let boot = BootProgress::new();
    boot.mark_migrations_applied();

    let server_mode = config.deployment_profile.server_mode();
    let deployment_mode = config.deployment_profile.deployment_mode();

    let host_store = open(
        "host runtime",
        SqliteHostRuntimeStore::open(&config.database_path),
    )
    .await?;
    let session_store = open(
        "human session",
        SqliteSessionStore::open(&config.database_path),
    )
    .await?;
    let messaging_store = open("messaging", MessagingStore::open(&config.database_path)).await?;
    // The board-list candidate fetch. A SECOND handle on the same product database, not a
    // second authority: `MessagingStore` settles which boards and rows this viewer may see,
    // this store only reads the joined `tasks` candidates that decision narrows.
    let task_store = open("task board", SqliteTaskStore::open(&config.database_path)).await?;
    let custody_store = open(
        "runtime custody",
        SqliteRuntimeCustodyStore::open(&config.database_path),
    )
    .await?;
    let delivery_store = open(
        "runtime delivery",
        SqliteRuntimeDeliveryStore::open(&config.database_path),
    )
    .await?;
    let scope_authority = open(
        "event scope",
        SqliteEventScopeAuthority::open(&config.database_path),
    )
    .await?;
    let unread_read_model = open(
        "unread read model",
        SqliteUnreadReadModel::open(&config.database_path),
    )
    .await?;
    let direct_pair_read_model = open(
        "direct-pair read model",
        SqliteDirectPairReadModel::open(&config.database_path),
    )
    .await?;
    let access_store = open(
        "workspace access",
        SqliteAccessStore::open(&config.database_path),
    )
    .await?;
    let workspace_cold_read = open(
        "workspace cold read",
        SqliteWorkspaceColdRead::open(&config.database_path),
    )
    .await?;
    let agent_availability_cold_read = open(
        "agent availability cold read",
        SqliteAgentAvailabilityColdRead::open(&config.database_path),
    )
    .await?;
    let agent_detail_cold_read = open(
        "agent detail cold read",
        SqliteAgentDetailColdRead::open(&config.database_path),
    )
    .await?;
    let agent_list_cold_read = open(
        "agent list cold read",
        SqliteAgentListColdRead::open(&config.database_path),
    )
    .await?;
    let agent_presence_cold_read = open(
        "agent presence cold read",
        SqliteAgentPresenceColdRead::open(&config.database_path),
    )
    .await?;
    let presence_cold_read = open(
        "presence cold read",
        SqliteUserPresenceColdRead::open(&config.database_path),
    )
    .await?;
    let last_seen_sink = open(
        "presence last-seen sink",
        SqliteLastSeenSink::open(&config.database_path),
    )
    .await?;
    // Wave 3A checkpoint A5: the host-resources read door opens its OWN cold-read pool
    // by path, the sanctioned pattern every sibling `*ColdRead` above uses — a read-only
    // snapshot handle on the same database file, NOT the teardown resource authority
    // (`AgentTeardownReadPort`) and never sharing its projection.
    let host_resources_cold_read = open(
        "host resources cold read",
        SqliteHostResourcesColdRead::open(&config.database_path),
    )
    .await?;
    // #2223 CP3 workspace-write + human-auth store handles. Each is a read-only-or-
    // scoped snapshot pool on the SAME product database file, opened by path exactly
    // like every sibling `*ColdRead`/store above — no second authority, no shared god
    // object. The user store answers three human-auth capabilities (email lookup,
    // profile read, profile write) off one handle; the audience read feeds the
    // workspace `metadata_changed` publisher's per-viewer human enumeration.
    let workspace_detail_read = open(
        "workspace detail read",
        SqliteWorkspaceDetailRead::open(&config.database_path),
    )
    .await?;
    let workspace_metadata_writes = open(
        "workspace metadata write",
        SqliteWorkspaceMetadataWrite::open(&config.database_path),
    )
    .await?;
    let workspace_namespace = open(
        "workspace name availability",
        SqliteRegularWorkspaceNamespace::open(&config.database_path),
    )
    .await?;
    let workspace_audience_read = open(
        "workspace human audience read",
        SqliteWorkspaceAudienceRead::open(&config.database_path),
    )
    .await?;
    let handle_namespace = open(
        "handle namespace",
        SqliteHandleNamespace::open(&config.database_path),
    )
    .await?;
    let user_store = open(
        "user identity",
        SqliteUserStore::open(&config.database_path),
    )
    .await?;
    let human_registration = open(
        "human registration",
        SqliteHumanRegistration::open(&config.database_path),
    )
    .await?;
    let credential_store = open(
        "login credential",
        SqliteCredentialStore::open(&config.database_path),
    )
    .await?;

    let hub = ScopeEventHub::production().map_err(|source| StartupError::Composition {
        name: "scope event hub",
        source: Box::new(source),
    })?;
    // The presence axis is one authority with two faces, built through the ONE
    // `compose_presence_vertical` factory so production and the composed E2E share
    // the identical construction. The `PresenceGraceTimers` inside is the
    // `OnlineViewers` the presence GET route reads AND, wrapped in a
    // `PresenceConnectionFeed`, the transport's connect/disconnect sink; a decided
    // offline fact projects once through the `HubPresenceSink` into
    // `EventScope::App`; it is never re-injected downstream. Production seals the
    // disconnect instant with the system wall clock and takes the 20s grace TS
    // parity fixes (`index.ts` passes no override).
    let (presence_router, presence_feed, presence_timers) = compose_presence_vertical(
        presence_cold_read,
        last_seen_sink,
        hub.clone(),
        SystemDisconnectClock,
        GraceWindow::from_millis_or_default(None),
    );
    // #2223 CP3: the human-auth issue/revoke writes ride the SAME session store the
    // read authenticator holds — cloned as shared-pool handles (the store is an `Arc`
    // pool), captured before `HumanSessionAuthenticator::new` moves the original just
    // below. Not a second authority: the same `auth_sessions` table backs the issue
    // that login/signup performs, the revoke that logout performs, and the read the
    // `/api/me` perimeter performs.
    let session_issue = session_store.clone();
    let session_revoke = session_store.clone();
    let sessions =
        HumanSessionAuthenticator::new(session_store, SystemSessionClock, SessionTtl::default());
    let runtime_credentials = RuntimeCredentialAuthority::production(custody_store);
    let daemon_runtime = DaemonDeliveryRuntime::production(
        runtime_credentials.clone(),
        delivery_store,
        host_store.clone(),
        hub.clone(),
    )
    .map_err(|source| StartupError::Composition {
        name: "daemon delivery runtime",
        source: Box::new(source),
    })?;
    let (daemon_router, daemon_controller) = daemon_runtime.router();

    let target_address = messaging_store.target_address(hub.clone(), TargetAddressRefusalLog);
    // The task board list reads its board/capability/participation authority from the SAME
    // `MessagingStore` the send door holds; captured before `send_routers` consumes it as the
    // send unit-of-work.
    let task_list_boards = messaging_store.clone();
    // The stale-message resolution route rides the SAME post authority (agent
    // participation + placement + half-dead narrowing) and the independent
    // `send_messages` capability the send door holds; both captured before
    // `send_routers` consumes the store as the send unit-of-work.
    let stale_admission = messaging_store.stale_message_resolution_admission();
    let stale_capability = messaging_store.clone();
    // The five channel directory/detail read doors ride the SAME `MessagingStore` the
    // send door holds — each `&self` builder clones only the shared pool, opening no
    // second authority. Captured before `send_routers` consumes the store as the send
    // unit-of-work. One handle satisfies the directory factory's three-port bound.
    let channel_directory_read = messaging_store.channel_directory();
    let channel_detail_read = messaging_store.channel_lifecycle();
    let conversation_agent_directory_read = messaging_store.conversation_agent_directory();
    // Wave 3A checkpoint A2: the four runtime/activity projection doors ride the SAME
    // `MessagingStore` (each `&self` builder clones only the shared pool, no second
    // authority) and — for the live run-state map — the SAME `daemon_runtime` owner
    // already composed for delivery, cloned at the merge (a clone shares the owner's
    // `Arc<Mutex<..>>` state; it is never a second runtime snapshot). The run-states
    // admission takes its own `channel_lifecycle()` handle because the A1 detail handle
    // above is moved into its own router.
    let conversation_agent_runtime_read = messaging_store.conversation_agent_runtime();
    let conversation_agent_activity_read = messaging_store.conversation_agent_activity();
    let activity_read_model = messaging_store.activity_read_model();
    let agent_run_states_admission = messaging_store.channel_lifecycle();
    // Wave 3A checkpoint A3: the five message navigation/search read doors ride the SAME
    // `MessagingStore` (each `&self` builder clones only the shared pool, no second
    // authority), captured before `send_routers` moves the store as the send UoW. The
    // message-window GET shares its path with the send POST — see the merge below.
    let conversation_ref_read = messaging_store.conversation_refs();
    let conversation_unread_read = messaging_store.conversation_unread();
    let conversation_threads_read = messaging_store.conversation_threads();
    let conversation_message_window_read = messaging_store.conversation_message_window();
    let human_search_read = messaging_store.human_search();
    // Wave 3A checkpoint A4: the five unread/attention read doors ride the SAME
    // `MessagingStore` (each `&self` builder clones only the shared pool, no second
    // authority), captured before `send_routers` moves the store as the send UoW. One
    // `message_unread()` handle satisfies the three-port unread bound (workspace roll-up,
    // viewer summary, per-conversation).
    let message_unread_read = messaging_store.message_unread();
    let attention_projection_read = messaging_store.attention_projection();
    // #2217: the two viewer-owned message-state lanes ride the SAME `MessagingStore`
    // (each `&self` builder clones only the shared pool, no second authority), captured
    // before `write_doors` moves the store below. `saved` serves both the read and the
    // mutation port; `thread_follow` is the follow/unfollow write door.
    let saved_store = messaging_store.saved();
    let thread_follow_store = messaging_store.thread_follow();
    // #2223 CP3: the workspace-rename fan-out's three read/author ports (channel
    // population, per-channel system-message author, per-channel agent audience) are
    // answered by the SAME `MessagingStore` — one `&self` builder handle, captured
    // before `write_doors` moves the store below. The adapter that wraps this with the
    // daemon delivery effect and the hub publication is assembled just before the merge.
    let workspace_rename_messaging = messaging_store.workspace_rename_messaging();
    // `/readyz`'s live write probe rides the SAME `MessagingStore` pool handle the send
    // door holds — it does NOT reopen SQLite by path. Captured before `write_doors`
    // moves the store below. The probe is the one thing readiness cannot answer from
    // cached boot state: a fully booted process can still have lost its database.
    let readiness_write_probe = messaging_store.write_probe();
    // The thread-follow post-commit unread axis binds the SAME two authorities the
    // messaging aftermath's unread publisher binds — this `hub` and this `unread_read_model`
    // (cloned as a shared-pool handle, no second audience authority) — before the messaging
    // aftermath moves the original just below. It is a separate publisher instance over the
    // same authorities, not a second unread path. This factory does not touch
    // `messaging_aftermath`'s signature — the two events thread through separate hub
    // factories by design (#2205 seam left untouched).
    let thread_follow_aftermath = hub.thread_follow_aftermath(unread_read_model.clone());
    // The one post-commit fan-out, built by the hub over itself: the publication authority
    // and the hub the unread axis routes through are both `hub`, and this statement has no
    // hub argument that could name a second transport.
    let aftermath = hub.messaging_aftermath(
        daemon_runtime.effects(),
        messaging_store.clone(),
        unread_read_model,
    );
    // Wave 3A checkpoint A6 (#2203) + #2205: every authenticated write door — the two
    // ordinary sends and the human direct-pair initiation — rides the SAME
    // `MessagingStore`, in every write role it needs: channel access, send capability,
    // direct-line authority, send unit-of-work, and the get-or-create initiation source.
    // One statement, one store, and no argument for the transport the winner-only
    // pair-opened fact leaves on: the seam binds the initiation port to the one aftermath
    // above, which is itself that transport. So this mount cannot announce a pair-open on
    // one hub while the pair's first message publishes on another — there is no parameter
    // to say it in.
    let (human_writes, agent_writes) = aftermath.write_doors(messaging_store, target_address);

    let host = host_runtime::router(
        CreateHostInvite::new(host_store.clone(), OsEntropy, SystemClock),
        config.daemon_npm_spec.clone(),
    );
    // #2219 CP4 host-custody batch (scope B): the FOUR routes whose production
    // authorities already exist — read/list, connect-token resolve, claim-or-create, and
    // token rotation. Three (list/claim/rotate) sit behind the human session perimeter;
    // `resolve` is the one door the product ALLOWLISTS past the bearer gate (it is
    // daemon-authenticated: the caller proves possession of its connect token in the
    // handler, not a human session), so it mounts anonymously at the top level with the
    // other allowlisted faces, mirroring `installPublicBearerMiddleware`'s allowlist
    // (`health`, `server/info`, `hostConnectTokenResolve`). The other four CP4 handlers
    // (detail/revoke/connect-token rotate/delete) travel in this convergence tree but stay
    // UNMOUNTED: each needs an effect authority with no production implementer yet
    // (self-reported daemon name, per-host disconnect, whole-computer availability
    // announcement, computer-cascade teardown), tracked as follow-up seams by authority
    // family. All four here bind the ONE `SqliteHostRuntimeStore` (its Arc pool clones
    // cheaply), never a second store.
    let host_list = host_runtime::list::router(host_store.clone());
    let host_resolve =
        host_runtime::resolve::router(host_store.clone(), host_store.clone(), SystemProcessClock);
    let host_claim = host_runtime::claim::router(ClaimLocalComputer::new(
        host_store.clone(),
        host_store.clone(),
        host_store.clone(),
        OsEntropy,
        SystemClock,
    ));
    // rotate-token's arm is the deployment profile, exactly like `runtimes_router` below.
    // EMBEDDED mints in-process and reveals the secret in the HTTP body. REMOTE-ONLY
    // delivers the replacement over the daemon's OWN websocket — the transport the
    // `daemon_router` accepts in either profile — and returns no secret, matching the TS
    // `standaloneMode` branch that drives `hostWsController.sendCommand(id,'rotate_token')`
    // rather than refusing. So the coordinator is `Some`, bound to the live delivery
    // registry via `host_token_rotation()`; a `transport_no_connection`/`503` is the
    // coordinator's own answer when that daemon is offline, NOT a composition-time `None`
    // stub (which would be a parity break — TS never categorically refuses here).
    let host_rotate_token = match config.deployment_profile {
        DeploymentProfile::Embedded => host_runtime::rotate_token::embedded_router(
            host_store.clone(),
            RotateHostToken::new(host_store.clone(), OsEntropy, SystemClock),
        ),
        DeploymentProfile::RemoteOnly => host_runtime::rotate_token::standalone_router(
            host_store.clone(),
            Some(RotateHostTokenThroughDaemon::new(
                RotateHostToken::new(host_store.clone(), OsEntropy, SystemClock),
                daemon_controller.host_token_rotation(),
            )),
        ),
    };
    // `/api/runtimes` is the one root face that is NOT anonymous (it sits under the
    // product's `/api/*` bearer gate with no allowlist entry), so it mounts behind this
    // same human-session perimeter. The profile — not a per-request flag — decides which
    // router: an embedded backend constructs the process's ONE runtime detector and can
    // answer; a control-plane backend is handed [`runtimes::control_plane_router`], which
    // has no detector field to hold and so can only refuse `503`. The detector is
    // constructed ONLY in the embedded arm, so a standalone process never obtains one.
    let runtimes_router = match config.deployment_profile {
        DeploymentProfile::Embedded => {
            runtimes::detecting_router(MachineRuntimeDetector::for_this_process())
        }
        DeploymentProfile::RemoteOnly => runtimes::control_plane_router(),
    };
    // #2223 CP3: assemble the two workspace-metadata-write outbound authorities and the
    // human-auth deps from real production adapters, BEFORE `hub`/`sessions` are moved
    // into the event transport below. The rename fan-out is ONE whole effect — author +
    // daemon delivery + conversation-scope publication — never a half-effect: the
    // messaging store answers author/read, `daemon_runtime.effects()` is the per-agent
    // runtime push, and the hub is the conversation-scope `message` publication. The
    // `metadata_changed` viewer hint routes through the SAME hub over the audience read.
    let workspace_rename_fanout = WorkspaceRenameFanoutAdapter::new(
        workspace_rename_messaging,
        daemon_runtime.effects(),
        hub.clone(),
    );
    let workspace_metadata_sink = hub.workspace_metadata_changed_sink(workspace_audience_read);
    // The five human identity/session routes, generic over each capability. In
    // production several resolve to one store: the user store answers email lookup +
    // profile read + profile write, and the session store answers issue + revoke. The
    // hasher is the real spawn-blocking Argon2id KDF; the mint is the real CSPRNG bearer
    // mint; `user_changed` is the production hub sink (signup + profile edit announce).
    // The router self-applies `require_human_session` to only its `me` pair, so it must
    // mount at the TOP LEVEL — inside `human_products` the anonymous signup/login/logout
    // trio would be gated before a session can exist. It is handed the SAME session-read
    // authority the outer perimeter uses.
    let human_auth_router = human_auth::router(
        HumanAuthDeps {
            handles: handle_namespace,
            emails: user_store.clone(),
            hasher: SpawnBlockingHasher::new(Argon2idPasswordHasher::production(OsEntropy)),
            registration: human_registration,
            mint: EntropySessionTokenMint::new(OsEntropy),
            sessions: session_issue,
            revoke: session_revoke,
            credentials: credential_store,
            reads: user_store.clone(),
            writes: user_store,
            user_changed: hub.clone(),
            clock: SystemSessionClock,
            signup_enabled: config.signup_enabled,
        },
        sessions.clone(),
    );
    let human_products = require_human_session(
        host.merge(human_writes)
            // Wave 3A checkpoint A6 (#2203): `POST /api/agents/{id}/direct-messages`, the
            // human direct-pair initiation write door, is not merged here — it arrives
            // inside `human_writes`, bound to the aftermath by the seam above. Its
            // method/path is distinct from the direct-pair read door merged next, so
            // neither shadows the other.
            .merge(direct_pairs::router(direct_pair_read_model))
            .merge(workspaces::router(workspace_cold_read))
            // #2223 CP3: the three authenticated workspace-metadata routes, behind this
            // same human perimeter. `workspace_detail` GET and `workspace_metadata_write`
            // PATCH share the `/api/workspaces/{id}` node — axum accumulates the disjoint
            // methods into one method router, so neither shadows the other, and both share
            // the parent `/api/workspaces` with the static `name-availability` GET and the
            // list GET already merged above. The metadata-write door binds the governance
            // read (`access_store`), the write UoW, the `metadata_changed` viewer-hint sink
            // and the whole rename fan-out assembled above, and the production wall clock.
            .merge(workspace_detail::router(workspace_detail_read))
            .merge(workspace_name_availability::router(workspace_namespace))
            .merge(workspace_metadata_write::router(
                access_store.clone(),
                workspace_metadata_writes,
                workspace_metadata_sink,
                workspace_rename_fanout,
                SystemWorkspaceMetadataClock,
            ))
            .merge(availability::router(
                agent_availability_cold_read,
                daemon_controller.clone(),
            ))
            .merge(agent_detail::router(agent_detail_cold_read))
            .merge(agent_list::router(agent_list_cold_read))
            .merge(agent_presence::router(
                agent_presence_cold_read,
                SystemProcessClock,
            ))
            .merge(channel_directory::router(channel_directory_read))
            .merge(channel_lifecycle::router(channel_detail_read))
            .merge(conversation_agent_directory::router(
                conversation_agent_directory_read,
            ))
            .merge(conversation_agent_runtime::router(
                conversation_agent_runtime_read,
            ))
            // The reader owner is not chosen here: the seam binds it to the
            // delivery runtime by construction, so this line cannot fork the
            // HTTP reader onto an owner other than the one delivery writes into.
            .merge(daemon_runtime.agent_run_states_router(agent_run_states_admission))
            .merge(conversation_agent_activity::router(
                conversation_agent_activity_read,
            ))
            .merge(activity::router(activity_read_model))
            .merge(conversation_ref::router(conversation_ref_read))
            .merge(conversation_unread::router(conversation_unread_read))
            .merge(conversation_threads::router(conversation_threads_read))
            // #2217: the two viewer-owned message-state lanes, mounted behind this same
            // authenticated human perimeter. Thread follow/unfollow rides its store and
            // the reused unread aftermath; saved read+mutation ride the one saved store,
            // with the hub itself as the scope-addressed `saved_changed` aftermath.
            .merge(thread_follow::router(
                thread_follow_store,
                thread_follow_aftermath,
            ))
            .merge(saved::router(saved_store.clone(), saved_store, hub.clone()))
            // Same path as the send POST already merged via `human_writes`. axum
            // accumulates the GET and the POST into one method router on the
            // shared path node, so neither shadows the other; only a repeated
            // *method* would panic, and GET vs POST is disjoint.
            .merge(conversation_message_window::router(
                conversation_message_window_read,
            ))
            .merge(human_search::router(human_search_read))
            // Unread/attention read lane, Wave 3A checkpoint A4. One `message_unread`
            // handle serves all three unread roll-up doors; `attention_projection` serves
            // the two tiered-attention doors.
            .merge(message_unread::router(message_unread_read))
            .merge(attention_projection::router(attention_projection_read))
            // Host-resources read lane, Wave 3A checkpoint A5 (#2198). Rides its own
            // by-path cold-read pool captured above, kept distinct from the teardown
            // resource authority.
            .merge(host_resources::router(host_resources_cold_read))
            .merge(presence_router)
            .merge(access::router(
                access_store.clone(),
                access_store,
                hub.clone(),
                SystemEnrollmentClock,
            ))
            // #2219 CP4 batch B, behind this same human perimeter. `host_list`'s
            // `GET /api/hosts` shares the path node with the invite `POST /api/hosts`
            // (`host` above): axum accumulates the two methods into one method router, so
            // neither shadows the other — only a repeated *method* would panic, and
            // GET vs POST is disjoint. `host_resolve` is NOT merged here: it is the one
            // allowlisted (anonymous) host door and mounts at the top level below. The
            // remaining two carry their own distinct paths.
            .merge(host_list)
            .merge(host_claim)
            .merge(host_rotate_token)
            // #2218: `/api/runtimes`, behind the human perimeter — anonymous → 401,
            // exactly as the product's un-allowlisted `/api/*` bearer gate refuses it.
            .merge(runtimes_router),
        sessions.clone(),
        PublicJsonUnauthorized,
    );
    let agent_products = require_runtime_credential(
        agent_writes
            .merge(task_list_router(TaskListState {
                boards: task_list_boards,
                fetch: task_store,
            }))
            .merge(stale_message_resolution_router(
                stale_admission,
                stale_capability,
                TracingStaleMessageResolutionObserver,
            )),
        runtime_credentials,
    );

    let event_config =
        EventWebSocketConfig::production(config.allowed_origins.clone()).map_err(|source| {
            StartupError::Composition {
                name: "event websocket configuration",
                source: Box::new(source),
            }
        })?;
    let (event_router, event_controller) = silverhand_backend_server::scope_events::router(
        hub,
        sessions,
        scope_authority,
        // The transport's connect/disconnect sink is the presence feed sharing the
        // single `PresenceGraceTimers` above with the presence GET route. A live WS
        // connection marks the viewer online in the very set that route reads.
        presence_feed,
        event_config,
    );

    // The three ANONYMOUS root faces — mounted at the top level, ahead of no perimeter,
    // because a supervisor probes liveness/readiness and a client reads discovery before
    // it holds any session (the product allowlists `server/info` + `health` past the
    // bearer gate and registers `/readyz` outside `/api/*`). All three project from the
    // ONE deployment profile and the ONE process clock; `/readyz` additionally reads the
    // live `boot` holder and the shared-pool write probe.
    let server_info_router = server_info::router(ServerAdvertisement {
        signup_enabled: config.signup_enabled,
        bind_address_scope: classify_bind_address_scope(&config.listen_addr.ip().to_string()),
    });
    let health_router = health::router(server_mode, SystemProcessClock);
    let readyz_router = readiness::router(
        server_mode,
        deployment_mode,
        boot.clone(),
        readiness_write_probe,
        SystemProcessClock,
    );

    Ok(PreparedApp {
        router: Router::new()
            .merge(human_products)
            // #2223 CP3: the five human identity/session routes mount at the top level,
            // NOT inside `human_products`. The router self-wraps `require_human_session`
            // around only its `me` pair; the anonymous signup/login/logout trio is merged
            // outside any perimeter, exactly as the product allowlists them past the
            // bearer gate — placing it behind the outer perimeter would make login
            // unreachable before a session exists.
            .merge(human_auth_router)
            .merge(agent_products)
            .merge(event_router)
            .merge(daemon_router)
            .merge(server_info_router)
            .merge(health_router)
            // #2219: the connect-token resolve door is allowlisted past the bearer gate
            // (daemon-authenticated in-handler), so it mounts here at the top level ahead
            // of the human perimeter, alongside the other anonymous faces — never behind
            // `require_human_session`, which would reject the daemon's connect-token bearer
            // before the handler's own verification could run.
            .merge(host_resolve)
            .merge(readyz_router)
            // The one app/proxy request-body ceiling (128 MiB, uniform 413), applied
            // as the OUTERMOST layer over the fully-composed router — ahead of every
            // auth perimeter and domain check, and covering both deployment arms since
            // they are already merged into this single router. Product routes keep their
            // tighter in-stream caps; this only bounds the outer envelope.
            .layer(axum::middleware::from_fn(
                request_perimeter::enforce_request_body_ceiling,
            )),
        boot,
        event_controller,
        daemon_controller,
        presence_timers,
    })
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
    let app = prepare(&config).await?;
    let listener = TcpListener::bind(config.listen_addr)
        .await
        .map_err(StartupError::Bind)?;
    // `run` only binds; the bound listener is the witness, and `serve` establishes
    // `listen_ready` from it. So `run` cannot report readiness a caller-less `serve`
    // would miss, and a bind that fails here never reaches a `mark`.
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
    } = app;
    // The serving boundary, witnessed by the already-bound `TcpListener` this function
    // was handed: reaching here means a listener exists, so `/readyz` may now report
    // `listen_ready`. Marked from the listener rather than by a public `PreparedApp`
    // method, so EVERY caller that serves a bound listener establishes the fact and no
    // caller can fake it without one — a prepared-but-unserved app stays 503.
    boot.mark_listen_ready();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let server = axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        })
        .into_future();
    tokio::pin!(server);
    tokio::pin!(shutdown);
    tokio::select! {
        result = &mut server => result.map_err(StartupError::Serve),
        signal = &mut shutdown => {
            let _ = shutdown_tx.send(());
            // The one shared shutdown order (see `shut_down_transports`): event close
            // then an immediate presence dispose, daemon close concurrent but never
            // wedged between the two.
            shut_down_transports(&event_controller, &daemon_controller, &presence_timers).await;
            server.await.map_err(StartupError::Serve)?;
            signal.map_err(|source| StartupError::ShutdownSignal(Box::new(source)))
        }
    }
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

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use futures_util::{SinkExt, StreamExt};
    use silverhand_backend_server::{
        daemon_delivery::{HOST_WEBSOCKET_PATH, OUTBOUND_PROTOCOL_VERSION},
        messaging::MESSAGE_SEND_MAX_BODY_BYTES,
        scope_events::{
            DESKTOP_API_EPOCH_HEADER, EVENT_WEBSOCKET_PATH, EVENT_WS_SESSION_COOKIE,
            MINIMUM_CLIENT_API_EPOCH,
        },
    };
    use sqlx::{Connection, Executor};
    use tempfile::TempDir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_tungstenite::{
        connect_async,
        tungstenite::{
            Message as ClientMessage,
            client::IntoClientRequest,
            http::header::{COOKIE, ORIGIN},
        },
    };
    use tower::ServiceExt;

    use super::*;

    const TOKEN: &str = "valid-token";
    const TOKEN_HASH: &str = "OXoqnFv14szsOMJZa2grsb0F_m5OzqbBDPQnVf8iVAM";
    // A second seeded principal: the admin actor who performs the enrollment. The
    // target viewer (TOKEN) and this admin are told apart purely by which seeded
    // session their bearer hashes to.
    const ADMIN_TOKEN: &str = "admin-token";
    const ADMIN_HASH: &str = "EKTHyfxSBtbzbcaUSoG7b0o8sOJQFK47EubD5ScSKSo";
    const CONVERSATION_ID: &str = "conv000000000001";
    const WORKSPACE_ID: &str = "workspace0000001";
    // A long-lived host credential: its bearer (`HOST_TOKEN`) hashes to
    // `HOST_TOKEN_HASH`, the value seeded into `host_credentials` so a daemon can
    // authenticate the mounted host WebSocket and attach `h-online`.
    const HOST_TOKEN: &str = "host-token-cp2";
    const HOST_TOKEN_HASH: &str = "3fQKxe8pqexFp6vP8YxtFscumzfMzrDjOG4Jz-e7j1E";

    /// The same shared cold-read fixture the #2190 parity gate replays: it makes
    /// `user-1` a member of `ws-archived`/`ws-regular`/`ws-agent` and NOT of
    /// `ws-foreign`.
    const ENROLLMENT_SEED_SQL: &str =
        include_str!("../../../../packages/backend/tests/fixtures/workspace-cold-read/seed.sql");

    struct Fixture {
        _directory: TempDir,
        path: PathBuf,
    }

    async fn fixture(with_ledger: bool) -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backend-app.sqlite");
        let mut database = current_schema::create_current_schema(&path).await;
        if with_ledger {
            database
                .execute(
                    "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
                )
                .await
                .unwrap();
            for step in MIGRATION_STEPS.split(',') {
                sqlx::query(
                    "INSERT INTO _migrations (version, name, applied_at) VALUES (?, 'applied', 1)",
                )
                .bind(step.parse::<i64>().unwrap())
                .execute(&mut database)
                .await
                .unwrap();
            }
        }
        database.close().await.unwrap();
        Fixture {
            _directory: directory,
            path,
        }
    }

    fn config(path: PathBuf) -> AppConfig {
        AppConfig::new(
            path,
            "127.0.0.1:0".parse().unwrap(),
            vec![AllowedOrigin::parse("http://localhost:5173".to_owned()).unwrap()],
            Some("@silverhand-ai/daemon@test".to_owned()),
            // The composition gates seed a human perimeter and probe the embedded shape:
            // Embedded projects `ServerMode::Embedded` + `DeploymentMode::Embedded`, so
            // `/api/runtimes` is the detecting router (still anon → 401 behind the
            // perimeter) and `/readyz` omits the fanout key.
            DeploymentProfile::Embedded,
            true,
        )
        .unwrap()
    }

    /// The same config as [`config`] but under the standalone launcher's profile, so a
    /// composition differential can drive the RemoteOnly half of the ONE product:
    /// `ServerMode::Remote` + `DeploymentMode::Standalone`, the control-plane runtimes
    /// router (no detector), and a `/readyz` whose Standalone shape carries the
    /// (uninstalled) fanout key.
    fn remote_config(path: PathBuf) -> AppConfig {
        AppConfig::new(
            path,
            "127.0.0.1:0".parse().unwrap(),
            vec![AllowedOrigin::parse("http://localhost:5173".to_owned()).unwrap()],
            Some("@silverhand-ai/daemon@test".to_owned()),
            DeploymentProfile::RemoteOnly,
            true,
        )
        .unwrap()
    }

    async fn seed_human(path: &Path) {
        let now = i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap();
        let pool = SqlitePoolOptions::new()
            .connect(path.to_str().unwrap())
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO users (id, name, display_name, created_at, updated_at) VALUES ('user-1', 'viewer', 'Viewer', 1, 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO auth_sessions (id, user_id, token_hash, created_at, last_used_at, revoked_at, user_agent, ip_first_seen) VALUES ('session-1', 'user-1', ?, ?, ?, NULL, NULL, NULL)",
        )
        .bind(TOKEN_HASH)
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
    }

    async fn seed_workspace_conversation(path: &Path) {
        let pool = SqlitePoolOptions::new()
            .connect(path.to_str().unwrap())
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO workspaces (id, name, name_key, owner_user_id, created_at, updated_at) VALUES (?, 'Space', 'space', 'user-1', 1, 1)",
        )
        .bind(WORKSPACE_ID)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) VALUES (?, 'user-1', 1, 'owner')",
        )
        .bind(WORKSPACE_ID)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO conversations (id, workspace_id, placement_kind, roster_policy, title, title_key, status, visibility, created_at, updated_at) VALUES (?, ?, 'workspace', 'open', 'General', 'general', 'open', 'private', 1, 1)",
        )
        .bind(CONVERSATION_ID)
        .bind(WORKSPACE_ID)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO conversation_users (conversation_id, user_id, joined_at) VALUES (?, 'user-1', 1)",
        )
        .bind(CONVERSATION_ID)
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
    }

    /// Seed the channel-directory/detail read surface for viewer `user-1`: a Regular
    /// workspace they belong to, one open workspace channel they are a member of, and the
    /// sort state the active projection reads. Mirrors the leaf directory fixture's proven
    /// column/value set — a valid `ChannelStatus` (`idle`) and a `title_key` that is both
    /// canonical to its title and spelling-valid (so the detail decode's
    /// `CanonicalConversationTitle` and the directory decode's spelling check both pass) —
    /// which `seed_workspace_conversation`'s `status='open'` does NOT satisfy for this
    /// adapter (that helper serves routes that never decode a `ChannelStatus`). The
    /// literals equal `WORKSPACE_ID`/`CONVERSATION_ID`; the E2E asserts on those consts,
    /// so any drift fails loudly.
    async fn seed_channel_directory(path: &Path) {
        let pool = SqlitePoolOptions::new()
            .connect(path.to_str().unwrap())
            .await
            .unwrap();
        sqlx::raw_sql(
            "INSERT INTO workspaces(id,name,name_key,created_at,updated_at) VALUES \
               ('workspace0000001','Workspace','directory-space',1,1); \
             INSERT INTO workspace_users(workspace_id,user_id,joined_at,role) VALUES \
               ('workspace0000001','user-1',1,'owner'); \
             INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,title,title_key,status,visibility,archived_at,created_at,updated_at) VALUES \
               ('conv000000000001','workspace0000001','workspace','open','General','general','idle','private',NULL,1,1); \
             INSERT INTO conversation_users(conversation_id,user_id,joined_at) VALUES \
               ('conv000000000001','user-1',1); \
             INSERT INTO user_list_sort_mode(user_id,list_key,scope,mode,updated_at) VALUES \
               ('user-1','channels:workspace0000001','','manual',1); \
             INSERT INTO user_sort_entry(user_id,list_key,entity_id,rank,last_accessed_at,starred_at) VALUES \
               ('user-1','channels:workspace0000001','conv000000000001',1,4,5);",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
    }

    /// Seed two agents `user-1` can view through the creator arm, each on its own
    /// live, unrevoked host. `a-online` sits on `h-online`, whose long-lived
    /// credential lets a daemon attach over the mounted host WebSocket; `a-offline`
    /// sits on `h-offline`, which no daemon ever attaches. The two are equally
    /// visible and equally reachable — their ONLY difference is the live attachment,
    /// so a difference in the availability answer can come only from the route
    /// reading the real transport registry the WebSocket mutates.
    async fn seed_reachable_agents(path: &Path) {
        let pool = SqlitePoolOptions::new()
            .connect(path.to_str().unwrap())
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO hosts (id, name, kind, created_at, user_id) VALUES ('h-online', 'host-online', 'remote', 1, 'user-1')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO hosts (id, name, kind, created_at, user_id) VALUES ('h-offline', 'host-offline', 'remote', 1, 'user-1')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO host_credentials (id, host_id, token_hash, kind, expires_at, consumed_at, revoked_at) VALUES ('cred-online', 'h-online', ?, 'long_lived', NULL, NULL, NULL)",
        )
        .bind(HOST_TOKEN_HASH)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, created_by_user_id) VALUES ('a-online', 'agent-online', 'qoder', 'h-online', 1, 1, 'user-1')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, created_by_user_id) VALUES ('a-offline', 'agent-offline', 'qoder', 'h-offline', 1, 1, 'user-1')",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
    }

    /// Seed the agent-presence ACL fixture behind the perimeter: a creator-visible
    /// agent carrying a committed `last_activity_at` (so a real away deadline
    /// projects), and a registered agent owned by a DIFFERENT human that the viewer
    /// (`user-1`) is in no arm of (not creator, no direct pair, no shared workspace)
    /// — its presence must collapse to the same anti-enumeration 404 as an absent id.
    /// Both rows carry `materialization_status = 'active'`, which the presence adapter
    /// strict-decodes; `seed_reachable_agents` omits it, so this leaf seeds its own.
    async fn seed_presence_agents(path: &Path) {
        let pool = SqlitePoolOptions::new()
            .connect(path.to_str().unwrap())
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO users (id, name, display_name, created_at, updated_at) VALUES ('u-other', 'other', 'Other', 1, 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO hosts (id, name, kind, created_at, user_id) VALUES ('h-presence', 'host-presence', 'remote', 1, 'user-1')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO hosts (id, name, kind, created_at, user_id) VALUES ('h-other', 'host-other', 'remote', 1, 'u-other')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, created_by_user_id, materialization_status, last_activity_at) VALUES ('a-presence', 'agent-presence', 'qoder', 'h-presence', 1, 1, 'user-1', 'active', 1000)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, created_by_user_id, materialization_status, last_activity_at) VALUES ('a-stranger', 'agent-stranger', 'qoder', 'h-other', 1, 1, 'u-other', 'active', 1000)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
    }

    async fn request(
        router: &Router,
        method: &str,
        uri: &str,
        bearer: Option<&str>,
    ) -> (StatusCode, String) {
        request_with_body(router, method, uri, bearer, Body::from("{}")).await
    }

    async fn request_with_body(
        router: &Router,
        method: &str,
        uri: &str,
        bearer: Option<&str>,
        body: Body,
    ) -> (StatusCode, String) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(bearer) = bearer {
            builder = builder.header("authorization", bearer);
        }
        let response = router
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(body.to_vec()).unwrap())
    }

    async fn http_over_tcp(
        address: SocketAddr,
        method: &str,
        path: &str,
        bearer: Option<&str>,
        body: &str,
    ) -> String {
        let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
        let authorization = bearer
            .map(|value| format!("Authorization: {value}\r\n"))
            .unwrap_or_default();
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\n{authorization}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        client.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        String::from_utf8(response).unwrap()
    }

    #[test]
    fn config_has_no_implicit_database_listener_or_origin_defaults() {
        assert!(matches!(
            AppConfig::new(
                PathBuf::new(),
                "127.0.0.1:0".parse().unwrap(),
                vec![AllowedOrigin::parse("http://localhost:5173".to_owned()).unwrap()],
                None,
                DeploymentProfile::Embedded,
                true,
            ),
            Err(ConfigError::EmptyDatabasePath)
        ));
        assert!(matches!(
            AppConfig::new(
                "database.sqlite".into(),
                "127.0.0.1:0".parse().unwrap(),
                Vec::new(),
                None,
                DeploymentProfile::Embedded,
                true,
            ),
            Err(ConfigError::EmptyAllowedOrigins)
        ));
    }

    #[tokio::test]
    async fn startup_refuses_missing_or_unowned_schema_before_a_listener_exists() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing.sqlite");
        let Err(error) = prepare(&config(missing.clone())).await else {
            panic!("missing database must fail closed");
        };
        assert!(matches!(error, StartupError::Schema(_)));
        assert!(!missing.exists());

        let unowned = fixture(false).await;
        let Err(error) = prepare(&config(unowned.path)).await else {
            panic!("schema without migration ownership must fail closed");
        };
        assert!(describe(&error).contains("no such table: _migrations"));

        let fixture = fixture(true).await;
        verify_schema(&fixture.path).await.unwrap();
        let pool = SqlitePoolOptions::new()
            .connect(fixture.path.to_str().unwrap())
            .await
            .unwrap();
        for historical in 1..BASELINE_MIGRATION_STEP {
            sqlx::query(
                "INSERT INTO _migrations (version, name, applied_at) VALUES (?, 'history', 1)",
            )
            .bind(historical)
            .execute(&pool)
            .await
            .unwrap();
        }
        verify_schema(&fixture.path).await.unwrap();

        sqlx::query("DELETE FROM _migrations WHERE version = ?")
            .bind(CURRENT_MIGRATION_STEP - 1)
            .execute(&pool)
            .await
            .unwrap();
        assert!(matches!(
            verify_schema(&fixture.path).await,
            Err(SchemaAdmissionError::LedgerMismatch)
        ));
        sqlx::query(
            "INSERT INTO _migrations (version, name, applied_at) VALUES (?, 'restored', 1)",
        )
        .bind(CURRENT_MIGRATION_STEP - 1)
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("DELETE FROM _migrations WHERE version = ?")
            .bind(CURRENT_MIGRATION_STEP)
            .execute(&pool)
            .await
            .unwrap();
        assert!(matches!(
            verify_schema(&fixture.path).await,
            Err(SchemaAdmissionError::LedgerMismatch)
        ));
        sqlx::query(
            "INSERT INTO _migrations (version, name, applied_at) VALUES (?, 'restored', 1)",
        )
        .bind(CURRENT_MIGRATION_STEP)
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("INSERT INTO _migrations (version, name, applied_at) VALUES (?, 'future', 1)")
            .bind(CURRENT_MIGRATION_STEP + 1)
            .execute(&pool)
            .await
            .unwrap();
        assert!(matches!(
            verify_schema(&fixture.path).await,
            Err(SchemaAdmissionError::LedgerMismatch)
        ));
        pool.close().await;
    }

    #[tokio::test]
    async fn the_executable_root_mounts_real_human_products_and_auth_precedes_product_work() {
        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();

        let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
            .fetch_one(
                &SqlitePoolOptions::new()
                    .connect(fixture.path.to_str().unwrap())
                    .await
                    .unwrap(),
            )
            .await
            .unwrap();
        let refused_human =
            request(&app.router, "POST", "/api/channels/missing/messages", None).await;
        assert_eq!(refused_human.0, StatusCode::UNAUTHORIZED);
        assert_eq!(refused_human.1, r#"{"error":"unauthorized"}"#);
        let refused_agent = request(
            &app.router,
            "POST",
            "/internal/agents/agent-1/send-message",
            Some("Bearer unknown-runtime-token"),
        )
        .await;
        assert_eq!(refused_agent.0, StatusCode::UNAUTHORIZED);
        let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
            .fetch_one(
                &SqlitePoolOptions::new()
                    .connect(fixture.path.to_str().unwrap())
                    .await
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!((before, after), (0, 0));

        let direct_pairs = request(
            &app.router,
            "GET",
            "/api/direct-pairs",
            Some(&format!("Bearer {TOKEN}")),
        )
        .await;
        assert_eq!(direct_pairs.0, StatusCode::OK);
        assert_eq!(direct_pairs.1, r#"{"direct_pairs":[]}"#);

        let host = request(
            &app.router,
            "POST",
            "/api/hosts",
            Some(&format!("Bearer {TOKEN}")),
        )
        .await;
        assert_eq!(host.0, StatusCode::OK, "{}", host.1);
        assert!(
            host.1
                .contains(r#""daemon_npm_spec":"@silverhand-ai/daemon@test""#)
        );
        app.close_connections().await;
    }

    #[tokio::test]
    async fn both_auth_boundaries_precede_body_fences_and_broken_product_authorities() {
        let fixture = fixture(true).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let oversized = vec![b'x'; MESSAGE_SEND_MAX_BODY_BYTES + 1];

        let human_oversized = request_with_body(
            &app.router,
            "POST",
            &format!("/api/channels/{CONVERSATION_ID}/messages"),
            None,
            Body::from(oversized.clone()),
        )
        .await;
        assert_eq!(human_oversized.0, StatusCode::UNAUTHORIZED);
        let agent_oversized = request_with_body(
            &app.router,
            "POST",
            "/internal/agents/agent-1/send-message",
            Some("Bearer unknown-runtime-token"),
            Body::from(oversized),
        )
        .await;
        assert_eq!(agent_oversized.0, StatusCode::UNAUTHORIZED);

        let pool = SqlitePoolOptions::new()
            .connect(fixture.path.to_str().unwrap())
            .await
            .unwrap();
        sqlx::query("DROP TABLE conversations")
            .execute(&pool)
            .await
            .unwrap();
        let messages_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
            .fetch_one(&pool)
            .await
            .unwrap();

        let human_broken_authority = request_with_body(
            &app.router,
            "POST",
            &format!("/api/channels/{CONVERSATION_ID}/messages"),
            Some("Bearer unknown-human-token"),
            Body::from(r#"{"content":"hello"}"#),
        )
        .await;
        assert_eq!(human_broken_authority.0, StatusCode::UNAUTHORIZED);
        let agent_broken_authority = request_with_body(
            &app.router,
            "POST",
            "/internal/agents/agent-1/send-message",
            Some("Bearer unknown-runtime-token"),
            Body::from(format!(
                r##"{{"content":"hello","target":"#conv:{CONVERSATION_ID}"}}"##
            )),
        )
        .await;
        assert_eq!(agent_broken_authority.0, StatusCode::UNAUTHORIZED);
        let messages_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!((messages_before, messages_after), (0, 0));
        pool.close().await;
        app.close_connections().await;
    }

    #[tokio::test]
    async fn a_composed_human_send_commits_and_reaches_the_same_production_event_hub() {
        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        seed_workspace_conversation(&fixture.path).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let running = tokio::spawn(serve(listener, app, async move {
            let _ = shutdown_rx.await;
            Ok::<(), std::io::Error>(())
        }));

        let mut websocket_request = format!("ws://{address}{EVENT_WEBSOCKET_PATH}")
            .into_client_request()
            .unwrap();
        websocket_request
            .headers_mut()
            .insert(ORIGIN, "http://localhost:5173".parse().unwrap());
        websocket_request.headers_mut().insert(
            COOKIE,
            format!("{EVENT_WS_SESSION_COOKIE}={TOKEN}")
                .parse()
                .unwrap(),
        );
        websocket_request
            .headers_mut()
            .insert(DESKTOP_API_EPOCH_HEADER, MINIMUM_CLIENT_API_EPOCH.into());
        let (mut socket, _) = connect_async(websocket_request).await.unwrap();
        let authenticated = socket.next().await.unwrap().unwrap();
        let ClientMessage::Text(authenticated) = authenticated else {
            panic!("authenticated frame must be text");
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&authenticated).unwrap()["type"],
            "authenticated"
        );
        socket
            .send(ClientMessage::Text(
                serde_json::json!({
                    "type": "subscribe",
                    "scope": format!("conversation:{CONVERSATION_ID}"),
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        let subscribed = socket.next().await.unwrap().unwrap();
        let ClientMessage::Text(subscribed) = subscribed else {
            panic!("subscribed frame must be text");
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&subscribed).unwrap()["type"],
            "subscribed"
        );

        let response = http_over_tcp(
            address,
            "POST",
            &format!("/api/channels/{CONVERSATION_ID}/messages"),
            Some(&format!("Bearer {TOKEN}")),
            r#"{"content":"composed hello"}"#,
        )
        .await;
        assert!(
            response.starts_with("HTTP/1.1 201 Created\r\n"),
            "{response}"
        );

        let event = socket.next().await.unwrap().unwrap();
        let ClientMessage::Text(event) = event else {
            panic!("message event must be text");
        };
        let event: serde_json::Value = serde_json::from_str(&event).unwrap();
        assert_eq!(event["scope"], format!("conversation:{CONVERSATION_ID}"));
        assert_eq!(event["kind"], "message");
        assert_eq!(event["payload"]["message"]["content"], "composed hello");

        let pool = SqlitePoolOptions::new()
            .connect(fixture.path.to_str().unwrap())
            .await
            .unwrap();
        let committed: (String, String) =
            sqlx::query_as("SELECT id, content FROM messages WHERE conversation_id = ?")
                .bind(CONVERSATION_ID)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(committed.1, "composed hello");
        assert_eq!(event["payload"]["message"]["id"], committed.0);
        pool.close().await;

        socket.close(None).await.unwrap();
        shutdown_tx.send(()).unwrap();
        running.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn the_real_listener_serves_the_composed_router_then_shuts_down_cleanly() {
        let fixture = fixture(true).await;
        let app = prepare(&config(fixture.path)).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let running = tokio::spawn(serve(listener, app, async move {
            let _ = shutdown_rx.await;
            Ok::<(), std::io::Error>(())
        }));

        let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
        client
            .write_all(
                b"GET /api/direct-pairs HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        let response = String::from_utf8(response).unwrap();
        assert!(response.starts_with("HTTP/1.1 401 Unauthorized\r\n"));
        assert!(response.ends_with(r#"{"error":"unauthorized"}"#));

        shutdown_tx.send(()).unwrap();
        running.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn shutdown_signal_failure_is_a_sourced_nonzero_run_failure() {
        let fixture = fixture(true).await;
        let app = prepare(&config(fixture.path)).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let failure = std::io::Error::other("signal authority unavailable");
        let error = serve(listener, app, async move { Err(failure) })
            .await
            .unwrap_err();
        assert!(matches!(error, StartupError::ShutdownSignal(_)));
        assert_eq!(
            describe(&error),
            "shutdown signal authority failed: signal authority unavailable"
        );
    }

    /// Seeds the enrollment E2E database: the shared cold-read fixture, the
    /// enrolling admin and its `ws-foreign` admin membership, two live sessions
    /// (valid under the real system clock), and the migration ledger the schema
    /// admission owns — so `prepare` opens it as a fully-owned production database.
    async fn seed_enrollment_scenario(path: &Path) {
        let now = i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap();
        let mut db = current_schema::create_current_schema(path).await;
        db.execute(sqlx::raw_sql(ENROLLMENT_SEED_SQL))
            .await
            .expect("shared cold-read seed must load against the current schema");
        for statement in [
            "INSERT INTO users (id, name, display_name, created_at, updated_at) \
             VALUES ('admin-1', 'Admin', 'Admin', 1, 1)",
            "INSERT INTO workspace_users (workspace_id, user_id, joined_at, role) \
             VALUES ('ws-foreign', 'admin-1', 1, 'admin')",
        ] {
            sqlx::query(statement).execute(&mut db).await.unwrap();
        }
        for (id, user, hash) in [
            ("session-target", "user-1", TOKEN_HASH),
            ("session-admin", "admin-1", ADMIN_HASH),
        ] {
            sqlx::query(
                "INSERT INTO auth_sessions (id, user_id, token_hash, created_at, last_used_at, \
                 revoked_at, user_agent, ip_first_seen) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)",
            )
            .bind(id)
            .bind(user)
            .bind(hash)
            .bind(now)
            .bind(now)
            .execute(&mut db)
            .await
            .unwrap();
        }
        db.execute(
            "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
        )
        .await
        .unwrap();
        for step in MIGRATION_STEPS.split(',') {
            sqlx::query(
                "INSERT INTO _migrations (version, name, applied_at) VALUES (?, 'applied', 1)",
            )
            .bind(step.parse::<i64>().unwrap())
            .execute(&mut db)
            .await
            .unwrap();
        }
        db.close().await.unwrap();
    }

    /// Parses the JSON body of a `Connection: close` HTTP/1.1 response (headers and
    /// body are split by the blank line; these small bodies carry `Content-Length`,
    /// never chunked framing).
    fn http_json_body(response: &str) -> serde_json::Value {
        let body = response
            .split_once("\r\n\r\n")
            .expect("response separates headers from body")
            .1;
        serde_json::from_str(body).expect("response body is JSON")
    }

    fn workspace_ids(envelope: &serde_json::Value) -> Vec<String> {
        envelope["workspaces"]
            .as_array()
            .expect("the envelope carries a workspaces array")
            .iter()
            .map(|workspace| workspace["id"].as_str().unwrap().to_owned())
            .collect()
    }

    /// The mounted enrollment→hint→cold-read contract, proven through the ONE served
    /// composition root over real TCP (#task:2171).
    ///
    /// The seam-level causal proof (`add_workspace_human_member` → one hub → frame +
    /// cold read) is owned by #2190 and composes the surfaces ad hoc. This test proves
    /// the remaining, composition-only obligation: that `prepare` actually MOUNTS the
    /// enrollment route, `GET /api/workspaces`, and the scope-events WebSocket onto the
    /// single served router, all sharing ONE process `ScopeEventHub` and ONE real
    /// `HumanSessionAuthenticator`. Nothing here is driven in-process — every HTTP call
    /// and the socket cross the real listener.
    ///
    /// It goes RED if the mount regresses: if the enrollment sink and the WS perimeter
    /// held different hubs the frame would never reach the socket; if the two doors did
    /// not share the one session authority the seeded bearers would not authenticate;
    /// if either route were left unmounted its request would 404 instead of the asserted
    /// answer.
    #[tokio::test]
    async fn the_mounted_root_carries_enrollment_to_the_ws_hint_and_the_fresh_cold_read() {
        use futures_util::SinkExt;
        use tokio_tungstenite::{
            connect_async,
            tungstenite::{
                Message as ClientMessage,
                client::IntoClientRequest,
                http::header::{COOKIE, ORIGIN},
            },
        };

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("enroll-e2e.sqlite");
        seed_enrollment_scenario(&path).await;
        let app = prepare(&config(path.clone())).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let running = tokio::spawn(serve(listener, app, async move {
            let _ = shutdown_rx.await;
            Ok::<(), std::io::Error>(())
        }));

        // Auth-before-product at BOTH mounted doors: a missing credential is a 401 that
        // never reaches the product port, so `ws-foreign` gains no member.
        let unauth_read = http_over_tcp(address, "GET", "/api/workspaces", None, "").await;
        assert!(
            unauth_read.starts_with("HTTP/1.1 401 Unauthorized\r\n"),
            "{unauth_read}"
        );
        let unauth_enroll = http_over_tcp(
            address,
            "POST",
            "/api/workspaces/ws-foreign/members",
            None,
            r#"{"kind":"human","user_id":"user-1"}"#,
        )
        .await;
        assert!(
            unauth_enroll.starts_with("HTTP/1.1 401 Unauthorized\r\n"),
            "{unauth_enroll}"
        );

        // The page-load authority BEFORE the change, through the mounted cold endpoint:
        // `ws-foreign` is absent for the target viewer.
        let before = http_over_tcp(
            address,
            "GET",
            "/api/workspaces",
            Some(&format!("Bearer {TOKEN}")),
            "",
        )
        .await;
        assert!(before.starts_with("HTTP/1.1 200 OK\r\n"), "{before}");
        let before_ids = workspace_ids(&http_json_body(&before));
        assert_eq!(before_ids, ["ws-archived", "ws-regular", "ws-agent"]);

        // The target subscribes its own viewer stream on the mounted WebSocket, its WS
        // principal resolved from the seeded target bearer by the same real session
        // authority the HTTP doors use.
        let mut request = format!("ws://{address}{EVENT_WEBSOCKET_PATH}")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert(ORIGIN, "http://localhost:5173".parse().unwrap());
        request.headers_mut().insert(
            COOKIE,
            format!("{EVENT_WS_SESSION_COOKIE}={TOKEN}")
                .parse()
                .unwrap(),
        );
        request
            .headers_mut()
            .insert(DESKTOP_API_EPOCH_HEADER, MINIMUM_CLIENT_API_EPOCH.into());
        let (mut socket, _) = connect_async(request).await.unwrap();
        let authenticated = next_socket_json(&mut socket).await;
        assert_eq!(authenticated["type"], "authenticated");
        socket
            .send(ClientMessage::Text(
                serde_json::json!({ "type": "subscribe", "scope": "viewer:self" })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        assert_eq!(next_socket_json(&mut socket).await["type"], "subscribed");

        // The CAUSE: the admin's authenticated enrollment POST across real TCP.
        let enroll = http_over_tcp(
            address,
            "POST",
            "/api/workspaces/ws-foreign/members",
            Some(&format!("Bearer {ADMIN_TOKEN}")),
            r#"{"kind":"human","user_id":"user-1"}"#,
        )
        .await;
        assert!(enroll.starts_with("HTTP/1.1 201 Created\r\n"), "{enroll}");

        // EFFECT — the hint crosses the mounted WebSocket to the target's own viewer
        // subscription: the coordinate + role, carried as a whole envelope, no list.
        let hint = next_socket_json(&mut socket).await;
        assert_eq!(hint["scope"], "viewer:user-1");
        assert_eq!(hint["kind"], "viewer_workspaces_changed");
        assert_eq!(hint["seq"], 1);
        assert_eq!(
            hint["payload"],
            serde_json::json!({
                "change": "added", "workspace_id": "ws-foreign", "role": "member"
            })
        );

        // The durable committed row the frame must agree with: exactly one, default role.
        let pool = SqlitePoolOptions::new()
            .connect(path.to_str().unwrap())
            .await
            .unwrap();
        let row: (String,) = sqlx::query_as(
            "SELECT role FROM workspace_users WHERE workspace_id = 'ws-foreign' AND user_id = 'user-1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, "member");

        // The SAME mounted cold read now honors the hint: `ws-foreign` leads and is the
        // only id the target gained. Cold read — not the transport seq — is the list
        // authority.
        let after = http_over_tcp(
            address,
            "GET",
            "/api/workspaces",
            Some(&format!("Bearer {TOKEN}")),
            "",
        )
        .await;
        assert!(after.starts_with("HTTP/1.1 200 OK\r\n"), "{after}");
        let after_ids = workspace_ids(&http_json_body(&after));
        assert_eq!(
            after_ids,
            ["ws-foreign", "ws-archived", "ws-regular", "ws-agent"]
        );
        let gained: Vec<&String> = after_ids
            .iter()
            .filter(|id| !before_ids.contains(id))
            .collect();
        assert_eq!(gained, ["ws-foreign"]);

        // Idempotent re-enroll: still 201, still exactly one row.
        let reenroll = http_over_tcp(
            address,
            "POST",
            "/api/workspaces/ws-foreign/members",
            Some(&format!("Bearer {ADMIN_TOKEN}")),
            r#"{"kind":"human","user_id":"user-1"}"#,
        )
        .await;
        assert!(
            reenroll.starts_with("HTTP/1.1 201 Created\r\n"),
            "{reenroll}"
        );
        let count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM workspace_users WHERE workspace_id = 'ws-foreign' AND user_id = 'user-1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count.0, 1, "re-enroll must not add a second membership");
        pool.close().await;
        socket.close(None).await.unwrap();

        // The re-enroll owed NO announce. Prove the stream did not advance by the hub's
        // own high-water, not by a wait that merely fails to observe: a FRESH subscription
        // to the same viewer scope is TOLD the current seq in its `subscribed` ack, and
        // that value is deterministic. Exactly one hint was ever emitted (the create), so
        // the witness must be 1; a spurious re-enroll frame would have advanced it to 2.
        // The cold read above — not this seq — is the list-completion authority; seq only
        // bounds how many events were emitted.
        let mut witness = format!("ws://{address}{EVENT_WEBSOCKET_PATH}")
            .into_client_request()
            .unwrap();
        witness
            .headers_mut()
            .insert(ORIGIN, "http://localhost:5173".parse().unwrap());
        witness.headers_mut().insert(
            COOKIE,
            format!("{EVENT_WS_SESSION_COOKIE}={TOKEN}")
                .parse()
                .unwrap(),
        );
        witness
            .headers_mut()
            .insert(DESKTOP_API_EPOCH_HEADER, MINIMUM_CLIENT_API_EPOCH.into());
        let (mut witness_socket, _) = connect_async(witness).await.unwrap();
        assert_eq!(
            next_socket_json(&mut witness_socket).await["type"],
            "authenticated"
        );
        witness_socket
            .send(ClientMessage::Text(
                serde_json::json!({ "type": "subscribe", "scope": "viewer:self" })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let subscribed = next_socket_json(&mut witness_socket).await;
        assert_eq!(subscribed["type"], "subscribed");
        assert_eq!(subscribed["scope"], "viewer:user-1");
        assert_eq!(
            subscribed["seq"], 1,
            "one create hint was emitted and the idempotent re-enroll emitted none, \
             so a fresh subscription's high-water must be exactly 1"
        );

        witness_socket.close(None).await.unwrap();
        shutdown_tx.send(()).unwrap();
        running.await.unwrap().unwrap();
    }

    /// Auth-before-product, proven positively at BOTH mounted doors under a broken product
    /// state (`workspace_users` dropped after `prepare`, so the cold read's membership
    /// `EXISTS` and the enrollment policy's role read both fault). A missing OR unknown
    /// credential is still an EXACT 401 at each door — auth runs to completion before the
    /// product port is consulted, so the break is invisible to it. The SAME broken state
    /// drives an authenticated caller through to the product surface and a safe 500, which
    /// excludes the two false-greens a bare 401 cannot: a route never mounted (would 404)
    /// and a "broken" table that never took effect (would 200/201).
    #[tokio::test]
    async fn auth_precedes_product_at_both_doors_under_a_broken_product_state() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("auth-order-e2e.sqlite");
        seed_enrollment_scenario(&path).await;
        let app = prepare(&config(path.clone())).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let running = tokio::spawn(serve(listener, app, async move {
            let _ = shutdown_rx.await;
            Ok::<(), std::io::Error>(())
        }));

        // Healthy first: the authenticated target's read WORKS, so a later 500 is caused by
        // the break we introduce, not by a pre-existing fault.
        let healthy = http_over_tcp(
            address,
            "GET",
            "/api/workspaces",
            Some(&format!("Bearer {TOKEN}")),
            "",
        )
        .await;
        assert!(healthy.starts_with("HTTP/1.1 200 OK\r\n"), "{healthy}");

        // Break the one product table BOTH doors consult; auth's own tables are untouched.
        let pool = SqlitePoolOptions::new()
            .connect(path.to_str().unwrap())
            .await
            .unwrap();
        sqlx::query("DROP TABLE workspace_users")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        // Missing AND unknown credential, both doors → exact 401: auth refuses before the
        // now-broken product port is ever touched.
        for bearer in [None, Some("Bearer not-a-real-token")] {
            let read = http_over_tcp(address, "GET", "/api/workspaces", bearer, "").await;
            assert!(
                read.starts_with("HTTP/1.1 401 Unauthorized\r\n"),
                "unauthenticated read must be 401 regardless of product health: {read}"
            );
            let enroll = http_over_tcp(
                address,
                "POST",
                "/api/workspaces/ws-foreign/members",
                bearer,
                r#"{"kind":"human","user_id":"user-1"}"#,
            )
            .await;
            assert!(
                enroll.starts_with("HTTP/1.1 401 Unauthorized\r\n"),
                "unauthenticated enroll must be 401 regardless of product health: {enroll}"
            );
        }

        // The SAME broken state with real credentials: each door authenticates, then reaches
        // the broken product port and fails safe. Not 404 (route IS mounted), not 200/201
        // (the break IS effective) — a safe 500.
        let broken_read = http_over_tcp(
            address,
            "GET",
            "/api/workspaces",
            Some(&format!("Bearer {TOKEN}")),
            "",
        )
        .await;
        assert!(
            broken_read.starts_with("HTTP/1.1 500 Internal Server Error\r\n"),
            "an authenticated read must reach the broken product port and fail safe: {broken_read}"
        );
        let broken_enroll = http_over_tcp(
            address,
            "POST",
            "/api/workspaces/ws-foreign/members",
            Some(&format!("Bearer {ADMIN_TOKEN}")),
            r#"{"kind":"human","user_id":"user-1"}"#,
        )
        .await;
        assert!(
            broken_enroll.starts_with("HTTP/1.1 500 Internal Server Error\r\n"),
            "an authenticated enroll must reach the broken product port and fail safe: {broken_enroll}"
        );

        shutdown_tx.send(()).unwrap();
        running.await.unwrap().unwrap();
    }

    /// The composition mounts `GET /api/agents/{id}/availability` behind the SAME
    /// human bearer/session perimeter that fronts the other human products, wired to
    /// the real SQLite availability cold read and the real daemon attachment
    /// controller. This proves the composition-only obligation — routed to the leaf,
    /// behind the perimeter, over a real adapter — and not the leaf's
    /// ACL/reachability behavior, which its own component and parity tests own.
    #[tokio::test]
    async fn the_composition_serves_agent_availability_behind_the_perimeter() {
        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let router = app.router;
        let bearer = format!("Bearer {TOKEN}");
        // `AVAILABILITY_PATH` is a `{id}` template; drive a concrete, unseeded id.
        let path = "/api/agents/agent-absent/availability";

        // Anonymous → the shared perimeter's exact refusal envelope, reading nothing:
        // the 401 belongs to the perimeter the root mounts, so it is byte-identical to
        // the envelope every human product behind it answers with.
        let (status, body) = request(&router, "GET", path, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(body, r#"{"error":"unauthorized"}"#);

        // Authenticated → the request clears the perimeter, reaches the mounted leaf,
        // and the real cold read finds no such agent: the route's OWN anti-enumeration
        // 404 JSON. An UNMOUNTED path would give a bare framework 404; a leaf reached
        // without its injected principal would give a 500. Neither is this.
        let (status, body) = request(&router, "GET", path, Some(&bearer)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({ "error": "agent not found" })
        );

        // Route checksum: the availability path carries exactly one method. An
        // authenticated POST clears the perimeter and then meets 405 — one route, one
        // handler entry, no second mount.
        let (status, body) = request(&router, "POST", path, Some(&bearer)).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "{body}");
    }

    /// The composition's availability route consumes the SAME live attachment the
    /// production daemon WebSocket populates. `a-online` and `a-offline` are equally
    /// visible (creator arm) and equally reachable (live, unrevoked hosts); they
    /// differ ONLY in that a real daemon attaches `h-online` over the mounted
    /// `HOST_WEBSOCKET_PATH` through the production admission→attachment path — no
    /// test-only attach hook or fake registry. The route reads `online` for the
    /// attached agent and `offline` for the other through the one
    /// `DaemonDeliveryController` the composition root shares between the daemon
    /// runtime and the availability leaf. The leaf's own fake-attachment component
    /// tests prove the reachability RULE; only this proves the MOUNT reaches the real
    /// registry the transport mutates — swapping the mounted arg for an
    /// always-detached adapter, or a SECOND controller registry that the WebSocket
    /// never touches, turns the `online` assertion RED.
    #[tokio::test]
    async fn the_composition_availability_reads_the_live_daemon_attachment() {
        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        seed_reachable_agents(&fixture.path).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        // A clone shares the served router's Arc-backed daemon registry, so a GET on
        // this handle observes the live attachment made against the TCP server below.
        let router = app.router.clone();
        let bearer = format!("Bearer {TOKEN}");

        // Baseline: before any daemon attaches, BOTH visible/reachable agents read
        // offline — the shared controller holds no attachment for either host. This
        // is the state the live attach must move, so a later `online` cannot be a
        // fixture that was online all along.
        for agent in ["a-online", "a-offline"] {
            let uri = format!("/api/agents/{agent}/availability");
            let (status, body) = request(&router, "GET", &uri, Some(&bearer)).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&body).unwrap()["availability"],
                "offline",
                "{agent} must be offline before any daemon attaches"
            );
        }

        // Serve over real TCP so a daemon can dial the mounted host WebSocket.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let running = tokio::spawn(serve(listener, app, async move {
            let _ = shutdown_rx.await;
            Ok::<(), std::io::Error>(())
        }));

        // Drive the REAL admission→attachment path: a daemon authenticates with the
        // seeded host credential, announces `ready`, and answers the runtime-status
        // command the server issues — the same handshake a production daemon runs.
        let mut ws_request = format!("ws://{address}{HOST_WEBSOCKET_PATH}")
            .into_client_request()
            .unwrap();
        ws_request.headers_mut().insert(
            tokio_tungstenite::tungstenite::http::header::AUTHORIZATION,
            format!("Bearer {HOST_TOKEN}").parse().unwrap(),
        );
        let (mut socket, _) = connect_async(ws_request).await.unwrap();
        socket
            .send(ClientMessage::Text(
                serde_json::json!({
                    "direction": "daemon_to_server",
                    "type": "event",
                    "kind": "ready",
                    "protocol_version": OUTBOUND_PROTOCOL_VERSION,
                    "daemon_version": "test",
                    "daemon_id": "daemon-cp2",
                    "instance_id": "instance-cp2",
                    "host_descriptor": { "name": "CP2 host", "kind": "remote" },
                    "capabilities": [],
                    "daemon_pid": 7,
                    "started_at": 100,
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        let command = next_daemon_json(&mut socket).await;
        assert_eq!(command["kind"], "runtime_status", "{command}");
        socket
            .send(ClientMessage::Text(
                serde_json::json!({
                    "direction": "daemon_to_server",
                    "type": "command_response",
                    "id": command["id"],
                    "kind": command["kind"],
                    "result": { "runtimes": [] },
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

        // The attach + hydrate lands asynchronously; poll the SHARED availability GET
        // until it observes the live attachment (bounded, so broken wiring fails
        // instead of hanging).
        let mut online = false;
        for _ in 0..200 {
            let (status, body) = request(
                &router,
                "GET",
                "/api/agents/a-online/availability",
                Some(&bearer),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{body}");
            if serde_json::from_str::<serde_json::Value>(&body).unwrap()["availability"] == "online"
            {
                online = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            online,
            "an agent whose host attached over the mounted daemon WebSocket must read online — \
             proving the availability route's port IS the composition's live DaemonDeliveryController"
        );

        // Positive control through the SAME controller instance: the equally visible,
        // equally reachable agent whose host never attached stays offline. An
        // always-detached adapter would (wrongly) return this for BOTH; here only the
        // unattached host reads it.
        let (status, body) = request(
            &router,
            "GET",
            "/api/agents/a-offline/availability",
            Some(&bearer),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap()["availability"],
            "offline",
            "an agent on a live host with no attachment must read offline through the same controller"
        );

        socket.close(None).await.unwrap();
        shutdown_tx.send(()).unwrap();
        running.await.unwrap().unwrap();
    }

    /// The composition mounts `GET /api/agents/{id}` (agent-detail) behind the same
    /// perimeter, wired to the real SQLite agent-detail cold read. Proves the
    /// composition obligation: the anonymous perimeter refusal, an authenticated
    /// anti-enumeration 404 for an absent agent, a one-method route checksum, AND — an
    /// admitted creator reading a real seeded row projected off the live SQLite
    /// adapter (id/name/runtime/host, plus the `host_label` derivation off the host
    /// LEFT JOIN). The projection and stage-flag matrix stay with the leaf's own
    /// tests; this proves the mounted leaf reads the composition's real adapter.
    #[tokio::test]
    async fn the_composition_serves_agent_detail_behind_the_perimeter() {
        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        seed_reachable_agents(&fixture.path).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let router = app.router;
        let bearer = format!("Bearer {TOKEN}");
        // `AGENT_DETAIL_PATH` is a `{id}` template; drive a concrete, unseeded id.
        let path = "/api/agents/agent-absent";

        let (status, body) = request(&router, "GET", path, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(body, r#"{"error":"unauthorized"}"#);

        let (status, body) = request(&router, "GET", path, Some(&bearer)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({ "error": "agent not found" })
        );

        let (status, body) = request(&router, "POST", path, Some(&bearer)).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "{body}");

        // Admitted creator (`user-1` created `a-online`): the mounted leaf projects the
        // real seeded row off the live SQLite adapter, including the `host_label`
        // derivation off the host LEFT JOIN (`host-online`, the host's name).
        let (status, body) = request(&router, "GET", "/api/agents/a-online", Some(&bearer)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let agent = &serde_json::from_str::<serde_json::Value>(&body).unwrap()["agent"];
        assert_eq!(agent["id"], "a-online");
        assert_eq!(agent["name"], "agent-online");
        assert_eq!(agent["runtime"], "qoder");
        assert_eq!(agent["host_id"], "h-online");
        assert_eq!(agent["host_label"], "host-online");
        assert_eq!(agent["created_by_user_id"], "user-1");
    }

    /// The composition mounts `GET /internal/agents/{aid}/tasks` (the agent task-LIST)
    /// behind the runtime-credential perimeter, NOT the human session one. The route's
    /// full vertical — real minted credential resolving to the agent, the union board
    /// scope, the candidate fetch and the wire projection, and the port-untouched
    /// anonymous refusal — is proven over the real perimeter seam by the backend-server
    /// `task_list_mount` gate; minting a runtime credential is internal to `prepare`, so
    /// what THIS composition test owns is the remaining, composition-only obligation:
    /// that `prepare` actually placed the route in the served `agent_products` chain.
    ///
    /// The discriminator is `route_layer`: the runtime-credential middleware is attached
    /// with `route_layer`, so it runs ONLY for a request that matches a mounted route. A
    /// bad bearer on the tasks path therefore reaches the perimeter and is refused `401`
    /// — while the SAME bad bearer on a sibling path that is NOT a route falls straight
    /// through to the `404` fallback, the perimeter never consulted. The `401`/`404`
    /// split is the exact mounted-versus-absent signal: were the route left unmounted,
    /// the tasks path would `404` like its unrouted sibling.
    #[tokio::test]
    async fn the_composition_mounts_the_agent_task_list_behind_the_runtime_perimeter() {
        let fixture = fixture(true).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let router = app.router;
        let bad_bearer = "Bearer unknown-runtime-token";

        // The tasks path IS a route: the runtime perimeter runs and refuses the bad
        // bearer `401`, never a `404` — the route is mounted behind the agent perimeter.
        let (status, body) = request(
            &router,
            "GET",
            "/internal/agents/agent-1/tasks",
            Some(bad_bearer),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(body, r#"{"error":"unauthorized"}"#);

        // A sibling path under `/internal/agents/{aid}` that is NOT a route: the
        // `route_layer` perimeter is skipped and the request falls to the `404`
        // fallback, proving the `401` above is the task route's presence, not the
        // perimeter blanket-refusing every internal path.
        let (status, _) = request(
            &router,
            "GET",
            "/internal/agents/agent-1/not-a-mounted-route",
            Some(bad_bearer),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    /// The composition mounts `POST /internal/agents/{aid}/stale-message-resolution` behind
    /// the runtime-credential perimeter, in the SAME `agent_products` chain as the agent
    /// task-list. The route's full vertical — real minted credential resolving to the agent,
    /// the real one-snapshot admission, the real `send_messages` capability, the port-
    /// untouched refusals, and the production observer's single record — is proven over the
    /// real perimeter seam by the backend-server `stale_message_resolution_mount` gate; what
    /// THIS composition test owns is that `prepare` actually placed the route in the served
    /// chain, wired to the SQLite adapter answering the core admission port and to the
    /// production observer.
    ///
    /// The discriminator is the same `route_layer`: a bad bearer on the stale path reaches
    /// the perimeter and is refused `401` (the route is mounted), while the SAME bad bearer on
    /// a sibling path that is NOT a route falls straight through to the `404` fallback. The
    /// `401`/`404` split is the exact mounted-versus-absent signal.
    #[tokio::test]
    async fn the_composition_mounts_stale_message_resolution_behind_the_runtime_perimeter() {
        let fixture = fixture(true).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let router = app.router;
        let bad_bearer = "Bearer unknown-runtime-token";

        // The stale-resolution path IS a route: the runtime perimeter runs and refuses the
        // bad bearer `401`, never a `404` — the route is mounted behind the agent perimeter.
        let (status, body) = request(
            &router,
            "POST",
            "/internal/agents/agent-1/stale-message-resolution",
            Some(bad_bearer),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(body, r#"{"error":"unauthorized"}"#);

        // A sibling path under `/internal/agents/{aid}` that is NOT a route: the `route_layer`
        // perimeter is skipped and the request falls to the `404` fallback, proving the `401`
        // above is the stale route's presence, not the perimeter blanket-refusing.
        let (status, _) = request(
            &router,
            "POST",
            "/internal/agents/agent-1/not-a-mounted-route",
            Some(bad_bearer),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    /// Gate 1 of the CP2 convergence closure — the composed root's COMPLETE positive
    /// mounted table. It enumerates every `(method, path)` `prepare()` mounts across
    /// ALL lanes (already-served + #2193 + #2194 + #2196 + #2195 + #2198 + #2218 + the
    /// #2219 CP4 batch-B custody doors) as fifty entries — forty-one behind the human
    /// session perimeter (including #2218's authenticated `/api/runtimes` and three of the
    /// four #2219 host custody/credential doors), three behind the runtime
    /// credential perimeter, the two authenticated WebSockets, and four ANONYMOUS faces
    /// (#2218's three root faces plus #2219's allowlisted `connect-token/resolve`) — and
    /// asserts each is PRESENT: a guarded route anon → its
    /// perimeter's `401`, a WebSocket → its upgrade surface, an anonymous face → its
    /// handler's own status, and never the `404` fallback. Removing any mounted route's
    /// `.merge(...)` from `prepare()` flips its entry to `404` and reddens this gate.
    /// The tables are named consts with per-table `assert_eq!(len)` (41 / 3 / 2, plus
    /// the four anon faces asserted by exact status/body) so a mis-added or mis-deleted row
    /// reddens the count directly.
    ///
    /// This is a PRESENCE ledger, not a closed universe: black-box probing cannot
    /// prove "no further route was silently added" (axum exposes no route
    /// introspection), so this gate makes no such claim; the length asserts guard the
    /// table rows against mis-add/mis-delete, they make no closed-universe claim (that is
    /// gate 2's property). A new registrar mounted into
    /// `prepare()` MUST add its route here (and, if in the #2195 lane, move it from
    /// residual to landed in gate 2). Each door's per-path method surface and adapter
    /// wiring stays pinned by that route's own mount/unit test — the composed `.layer`
    /// perimeter answers `401` before method dispatch, so per-method surface is not
    /// observable here. F3 (#2217): the six thread-follow/saved methods collapse onto four
    /// distinct paths (`.../follow` and `/api/messages/{id}/save` each carry POST+DELETE),
    /// so anonymous presence here witnesses only those four path-guards; the six methods'
    /// routing truth rides the authenticated per-method gate
    /// `the_message_state_lane_dispatches_every_method_behind_the_perimeter` below.
    #[tokio::test]
    async fn the_composition_mounts_every_declared_route() {
        let fixture = fixture(true).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let router = app.router;
        let unauthorized = r#"{"error":"unauthorized"}"#;

        // The forty-one human-perimeter product doors. Anonymous (no bearer) → the human
        // session perimeter's `401` envelope, never a `404`: each path IS mounted and
        // guarded. (`.layer` runs the perimeter for any matched human route.)
        const HUMAN_PERIMETER_DOORS: [(&str, &str); 41] = [
            ("POST", "/api/hosts"),
            // #2219 CP4 host-custody batch B — the three perimeter-guarded custody doors.
            // `GET /api/hosts` shares the path node with the invite POST above, so its anon
            // 401 only witnesses the shared path-guard; the authenticated two-arm gate below
            // bears that GET actually dispatches to the list handler while POST still reaches
            // the invite. `connect-token/resolve` is NOT here — it is the allowlisted
            // anonymous host door, asserted with the other anon faces below. The other two
            // carry their own distinct paths.
            ("GET", "/api/hosts"),
            ("POST", "/api/hosts/claim-or-create"),
            ("POST", "/api/hosts/host-1/rotate-token"),
            ("POST", "/api/channels/conv000000000001/messages"),
            ("GET", "/api/direct-pairs"),
            // Direct-pair initiation write door, Wave 3A checkpoint A6 (#2203). Distinct
            // method+path from the direct-pair read above; anon POST → the perimeter 401.
            ("POST", "/api/agents/agent-1/direct-messages"),
            ("GET", "/api/workspaces"),
            ("POST", "/api/workspaces/workspace0000001/members"),
            ("GET", "/api/agents"),
            ("GET", "/api/agents/agent-1"),
            ("GET", "/api/agents/agent-1/presence"),
            ("GET", "/api/agents/agent-1/availability"),
            ("GET", "/api/presence"),
            // #2194 channel directory/detail lane, Wave 3A checkpoint A1.
            ("GET", "/api/workspaces/workspace0000001/channels"),
            ("GET", "/api/workspaces/workspace0000001/channels/archived"),
            ("GET", "/api/archived-channels"),
            ("GET", "/api/channels/conv000000000001"),
            ("GET", "/api/channels/conv000000000001/agents"),
            // Runtime/activity projection lane, Wave 3A checkpoint A2.
            ("GET", "/api/channels/conv000000000001/agent-runtime"),
            ("GET", "/api/channels/conv000000000001/agent-run-states"),
            (
                "GET",
                "/api/conversations/conv000000000001/agents/agent-1/activity",
            ),
            ("GET", "/api/activity"),
            // Message navigation/search lane, Wave 3A checkpoint A3. The messages GET
            // shares its path with the send POST above; anon → 401 here proves only that
            // the path is guarded, not which method entered — the authenticated
            // double-method gate below distinguishes GET-window from POST-send.
            ("GET", "/api/conversations/conv000000000001/ref"),
            ("GET", "/api/conversations/conv000000000001/unread"),
            ("GET", "/api/conversations/conv000000000001/threads"),
            ("GET", "/api/channels/conv000000000001/messages"),
            ("GET", "/api/search"),
            // Unread/attention read lane, Wave 3A checkpoint A4.
            ("GET", "/api/workspaces/workspace0000001/message-unread"),
            ("GET", "/api/message-unread-summary"),
            ("GET", "/api/channels/conv000000000001/message-unread"),
            ("GET", "/api/attention/badges"),
            ("GET", "/api/attention/modes"),
            // Host-resources read lane, Wave 3A checkpoint A5 (#2198).
            ("GET", "/api/hosts/host-1/resources"),
            // #2194 viewer-owned message-state lane (#2217). Six methods on four paths:
            // `.../follow` and `/api/messages/{id}/save` each carry POST+DELETE, so anon
            // presence witnesses only the four path-guards — the authenticated per-method
            // gate below bears which of the six methods actually dispatch.
            (
                "GET",
                "/api/channels/conv000000000001/threads/msg000000000000001/followers",
            ),
            (
                "POST",
                "/api/channels/conv000000000001/threads/msg000000000000001/follow",
            ),
            (
                "DELETE",
                "/api/channels/conv000000000001/threads/msg000000000000001/follow",
            ),
            ("GET", "/api/saved"),
            ("POST", "/api/messages/msg000000000000001/save"),
            ("DELETE", "/api/messages/msg000000000000001/save"),
            // #2218: `/api/runtimes`, the one root ops face that is authenticated (under
            // the product's `/api/*` bearer gate with no allowlist entry). Anon → 401.
            ("GET", "/api/runtimes"),
        ];
        assert_eq!(HUMAN_PERIMETER_DOORS.len(), 41);
        for (method, path) in HUMAN_PERIMETER_DOORS {
            let (status, body) = request(&router, method, path, None).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}: {body}");
            assert_eq!(body, unauthorized, "{method} {path}");
        }

        // The three runtime-perimeter internal doors. Anonymous → the runtime
        // credential perimeter's `401` on the matched route, never `404`.
        const RUNTIME_PERIMETER_DOORS: [(&str, &str); 3] = [
            ("POST", "/internal/agents/agent-1/send-message"),
            ("GET", "/internal/agents/agent-1/tasks"),
            ("POST", "/internal/agents/agent-1/stale-message-resolution"),
        ];
        assert_eq!(RUNTIME_PERIMETER_DOORS.len(), 3);
        for (method, path) in RUNTIME_PERIMETER_DOORS {
            let (status, body) = request(&router, method, path, None).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}: {body}");
            assert_eq!(body, unauthorized, "{method} {path}");
        }

        // The two authenticated WebSockets are mounted: a plain (non-upgrade) GET is
        // refused by the upgrade/auth surface, never falling to the `404` fallback. This
        // table is path-only — the upgrade surface, not a method router, answers here.
        const AUTHENTICATED_WEBSOCKETS: [&str; 2] = [EVENT_WEBSOCKET_PATH, HOST_WEBSOCKET_PATH];
        assert_eq!(AUTHENTICATED_WEBSOCKETS.len(), 2);
        for path in AUTHENTICATED_WEBSOCKETS {
            let (status, _) = request(&router, "GET", path, None).await;
            assert_ne!(status, StatusCode::NOT_FOUND, "{path} must be mounted");
        }

        // #2218 + #2219: the FOUR ANONYMOUS faces are mounted ahead of every perimeter, so
        // an anonymous probe reaches the handler — never the 404 an absent path gives. The
        // three #2218 root faces self-distinguish by status (200/200/503, none of which the
        // perimeter or the 404 fallback returns): discovery and liveness always answer 200;
        // `/readyz` on this prepared-but-not-served router answers 503 because
        // `listen_ready` is a serving-boundary fact that `prepare()` does not mark
        // (migrations are marked, the listener is not bound).
        for (method, path, expected) in [
            ("GET", "/api/server/info", StatusCode::OK),
            ("GET", "/api/health", StatusCode::OK),
            ("GET", "/readyz", StatusCode::SERVICE_UNAVAILABLE),
        ] {
            let (status, body) = request(&router, method, path, None).await;
            assert_eq!(status, expected, "anonymous {method} {path}: {body}");
        }

        // #2219: `GET /api/hosts/connect-token/resolve` is the fourth anonymous face — the
        // one host door the product allowlists past the bearer gate. An anonymous probe
        // reaches the handler, which finds no connect-token bearer and answers its OWN
        // `401 {"error":"unauthorized","error_code":"unauthorized"}`. Its status (401)
        // coincides with a guarded door's, so status alone would not prove it landed
        // anonymously — the `error_code` key is the discriminant: the human perimeter emits
        // `{"error":"unauthorized"}` with NO `error_code`. Mounting this behind the
        // perimeter instead would drop the `error_code` (perimeter body) and reject a real
        // connect-token bearer, reddening this assert.
        let (status, body) =
            request(&router, "GET", "/api/hosts/connect-token/resolve", None).await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "anonymous resolve: {body}"
        );
        assert_eq!(
            body, r#"{"error":"unauthorized","error_code":"unauthorized"}"#,
            "anonymous resolve reaches its own handler, not the perimeter"
        );

        // Mounted-vs-absent discriminator: sibling paths that are NOT routes fall to
        // the top `404` fallback (no perimeter blanket-refusing), proving the `401`s
        // above are route presence and not a catch-all.
        for (method, path) in [
            ("GET", "/api/nonexistent"),
            ("GET", "/api/agents/agent-1/not-a-route"),
            ("GET", "/api/workspaces/workspace0000001/not-a-route"),
            ("POST", "/internal/agents/agent-1/not-a-route"),
            ("GET", "/internal/nonexistent"),
        ] {
            let (status, _) = request(&router, method, path, None).await;
            assert_eq!(
                status,
                StatusCode::NOT_FOUND,
                "{method} {path} must be absent"
            );
        }
    }

    /// Seed one message authored by `user-1` in `CONVERSATION_ID` (a valid thread root:
    /// `thread_root_id` is NULL). Enough for the viewer to save it and to follow its
    /// thread through the composed root. Requires `seed_workspace_conversation` first (it
    /// establishes the conversation and the viewer's participation).
    async fn seed_message(path: &Path, message_id: &str) {
        let pool = SqlitePoolOptions::new()
            .connect(path.to_str().unwrap())
            .await
            .unwrap();
        // `seed_workspace_conversation` stores `status = 'open'`, which the message-send
        // path never decodes but the saved/thread-follow authorization does. Normalize to
        // a published status so the conversation-participation snapshot decodes.
        sqlx::query("UPDATE conversations SET status = 'idle' WHERE id = ?")
            .bind(CONVERSATION_ID)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO messages (id, conversation_id, from_kind, from_user_id, content, seq, created_at, thread_root_id, author_id, author_name, author_display_name) VALUES (?, ?, 'user', 'user-1', 'hello', 1, 1, NULL, 'user-1', 'user-1', 'User One')",
        )
        .bind(message_id)
        .bind(CONVERSATION_ID)
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
    }

    /// #2217 F3 — per-METHOD dispatch truth for the two shared-path pairs, which the
    /// presence ledger above cannot bear. The perimeter `.layer` answers `401` before
    /// method dispatch, so anonymous presence witnesses only the four path-guards; a
    /// dropped sibling method (e.g. `DELETE .../follow`) would stay green there under
    /// `assert_eq!(len)`. Here an AUTHENTICATED probe passes the perimeter and reaches the
    /// path's `MethodRouter`: each of the six mounted methods reaches handler-level
    /// behavior (never `405`), and an UNREGISTERED method (`PATCH` — follow/save are
    /// POST/DELETE toggles with no PATCH semantics and no lane plans to mount it) returns
    /// `405`, proving method dispatch actually happened and no catch-all swallows the path.
    #[tokio::test]
    async fn the_message_state_lane_dispatches_every_method_behind_the_perimeter() {
        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let router = app.router;
        let bearer = format!("Bearer {TOKEN}");

        // Clearly-absent coordinates: every id parses (non-empty) but resolves to nothing,
        // so each registered method reaches its handler's domain refusal — never `405`.
        let followers = "/api/channels/conv-absent/threads/root-absent/followers";
        let follow = "/api/channels/conv-absent/threads/root-absent/follow";
        let save = "/api/messages/msg-absent/save";
        let saved_list = "/api/saved";

        // The six REGISTERED methods → handler behavior (asserted exact), never `405`.
        for (method, path, expected) in [
            ("GET", saved_list, StatusCode::OK),
            ("POST", save, StatusCode::NOT_FOUND),
            ("DELETE", save, StatusCode::NOT_FOUND),
            ("GET", followers, StatusCode::NOT_FOUND),
            ("POST", follow, StatusCode::NOT_FOUND),
            ("DELETE", follow, StatusCode::NOT_FOUND),
        ] {
            let (status, body) = request(&router, method, path, Some(&bearer)).await;
            assert_ne!(
                status,
                StatusCode::METHOD_NOT_ALLOWED,
                "{method} {path} must dispatch to a handler, not 405: {body}"
            );
            assert_eq!(status, expected, "{method} {path}: {body}");
        }

        // The UNREGISTERED method on each shared path → `405`. Falsifier: a dropped
        // registered sibling would ALSO be 405 (caught above); a catch-all accepting any
        // method would NOT be 405 here.
        for path in [follow, save] {
            let (status, _) = request(&router, "PATCH", path, Some(&bearer)).await;
            assert_eq!(
                status,
                StatusCode::METHOD_NOT_ALLOWED,
                "PATCH {path} is unregistered and must be 405"
            );
        }
    }

    /// #2217 cut 2 — DUAL proof that `prepare()` wires the REAL hub as the saved
    /// aftermath (not a no-op / second hub) AND addresses the WRITER's own viewer scope.
    /// A committed save/unsave publishes exactly one `saved_changed` frame to
    /// `viewer:<writer>`, projected by the saved context's sole wire authority. A no-op
    /// aftermath would leave the subscription silent; a wrong scope would land the frame
    /// off `viewer:user-1`; a re-typed shape would drift the payload. The frame is read off
    /// a real event-WS subscription opened BEFORE the mutation, so `seq` is deterministic.
    #[tokio::test]
    async fn the_composition_publishes_saved_changed_to_the_writer_on_the_real_hub() {
        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        seed_workspace_conversation(&fixture.path).await;
        seed_message(&fixture.path, "message00000001").await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let running = tokio::spawn(serve(listener, app, async move {
            let _ = shutdown_rx.await;
            Ok::<(), std::io::Error>(())
        }));
        let bearer = format!("Bearer {TOKEN}");
        let mut socket = subscribe_own_viewer(address).await;

        // Save → one `saved_changed { action: "save" }` on the writer's own viewer scope.
        let save = http_over_tcp(
            address,
            "POST",
            "/api/messages/message00000001/save",
            Some(&bearer),
            "",
        )
        .await;
        assert!(save.starts_with("HTTP/1.1 201 Created\r\n"), "{save}");
        let saved = next_socket_json(&mut socket).await;
        assert_eq!(saved["scope"], "viewer:user-1");
        assert_eq!(saved["kind"], "saved_changed");
        assert_eq!(saved["seq"], 1);
        assert_eq!(
            saved["payload"],
            serde_json::json!({"message_id":"message00000001","action":"save"})
        );

        // Unsave → one `saved_changed { action: "unsave" }` on the SAME scope.
        let unsave = http_over_tcp(
            address,
            "DELETE",
            "/api/messages/message00000001/save",
            Some(&bearer),
            "",
        )
        .await;
        assert!(
            unsave.starts_with("HTTP/1.1 204 No Content\r\n"),
            "{unsave}"
        );
        let unsaved = next_socket_json(&mut socket).await;
        assert_eq!(unsaved["scope"], "viewer:user-1");
        assert_eq!(unsaved["kind"], "saved_changed");
        assert_eq!(unsaved["seq"], 2);
        assert_eq!(
            unsaved["payload"],
            serde_json::json!({"message_id":"message00000001","action":"unsave"})
        );

        socket.close(None).await.unwrap();
        shutdown_tx.send(()).unwrap();
        running.await.unwrap().unwrap();
    }

    /// #2217 cut 1 — proof that `prepare()` wires the thread-follow post-commit seam to
    /// the REAL `HubUnreadPublisher` over the REAL `SqliteUnreadReadModel` (not a no-op /
    /// second audience path). A committed follow republishes the conversation's unread
    /// through the ONE unread publisher, which co-emits `unread_updated` +
    /// `attention_badge_updated` to each seated viewer — here the follower on
    /// `viewer:user-1`. A no-op aftermath would leave the subscription silent; a second,
    /// unrelated hub would not reach this subscription. The audience and counts come from
    /// the real read model, so this also proves the reuse (no duplicate calculation).
    #[tokio::test]
    async fn the_composition_republishes_thread_follow_unread_through_the_real_publisher() {
        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        seed_workspace_conversation(&fixture.path).await;
        seed_message(&fixture.path, "message00000001").await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let running = tokio::spawn(serve(listener, app, async move {
            let _ = shutdown_rx.await;
            Ok::<(), std::io::Error>(())
        }));
        let bearer = format!("Bearer {TOKEN}");
        let mut socket = subscribe_own_viewer(address).await;

        // Follow the seeded thread root → the real publisher republishes this viewer's
        // unread as the `unread_updated` + `attention_badge_updated` co-emit.
        let follow = http_over_tcp(
            address,
            "POST",
            &format!("/api/channels/{CONVERSATION_ID}/threads/message00000001/follow"),
            Some(&bearer),
            "",
        )
        .await;
        assert!(follow.starts_with("HTTP/1.1 200 OK\r\n"), "{follow}");

        let unread = next_socket_json(&mut socket).await;
        assert_eq!(unread["scope"], "viewer:user-1");
        assert_eq!(unread["kind"], "unread_updated");
        assert_eq!(unread["seq"], 1);
        assert_eq!(unread["payload"]["conversation_id"], CONVERSATION_ID);
        assert_eq!(unread["payload"]["workspace_id"], WORKSPACE_ID);

        // The batch's second frame — proving it is the one unread publisher's co-emit, not
        // a bespoke single frame.
        let badge = next_socket_json(&mut socket).await;
        assert_eq!(badge["scope"], "viewer:user-1");
        assert_eq!(badge["kind"], "attention_badge_updated");
        assert_eq!(badge["seq"], 2);
        assert_eq!(badge["payload"]["workspace_id"], WORKSPACE_ID);

        socket.close(None).await.unwrap();
        shutdown_tx.send(()).unwrap();
        running.await.unwrap().unwrap();
    }

    /// Open the event WebSocket as `user-1` (the seeded `TOKEN`), authenticate, subscribe
    /// to the caller's own viewer scope, and return the live socket positioned to read the
    /// first post-subscription frame. `subscribed.seq` is asserted so the caller's frame
    /// sequence numbers start from a known baseline.
    async fn subscribe_own_viewer(
        address: std::net::SocketAddr,
    ) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>
    {
        let mut request = format!("ws://{address}{EVENT_WEBSOCKET_PATH}")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert(ORIGIN, "http://localhost:5173".parse().unwrap());
        request.headers_mut().insert(
            COOKIE,
            format!("{EVENT_WS_SESSION_COOKIE}={TOKEN}")
                .parse()
                .unwrap(),
        );
        request
            .headers_mut()
            .insert(DESKTOP_API_EPOCH_HEADER, MINIMUM_CLIENT_API_EPOCH.into());
        let (mut socket, _) = connect_async(request).await.unwrap();
        assert_eq!(next_socket_json(&mut socket).await["type"], "authenticated");
        socket
            .send(ClientMessage::Text(
                serde_json::json!({ "type": "subscribe", "scope": "viewer:self" })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let subscribed = next_socket_json(&mut socket).await;
        assert_eq!(subscribed["type"], "subscribed", "{subscribed}");
        assert_eq!(subscribed["seq"], 0, "fresh viewer scope baseline");
        socket
    }

    /// Gate 2 of the CP2 convergence closure — the #2195 host-agent control-plane lane
    /// as a bidirectionally CLOSED universe of 54, every entry itemized `(method, path)`
    /// in a named table that is mechanically checksummed: the five tables' lengths are
    /// pinned (`10`/`4`/`36`/`3`/`1`), every `(method, path)` across the union is unique,
    /// landed is disjoint from residual, and the union is exactly `54`. This is the
    /// lane's ORIGINAL owned total (it still counts the three dynamic host reads since
    /// handed to #2198). Deleting a row, or copying one between tables, breaks the
    /// checksum — `(10 + 4) + (36 + 3 + 1) == 54` is an assertion, not prose.
    ///
    /// Every one of the 40 residual routes is FALSIFIABLE — none rests on an
    /// unfalsifiable anon `401`:
    /// * The 10 PERIMETER-LANDED routes are mounted in `prepare()` behind a session
    ///   perimeter → anon `401` (includes #2218's authenticated `/api/runtimes` and
    ///   three of #2219's four host-custody routes: list, claim-or-create, and
    ///   `{id}/rotate-token`; the fourth, `connect-token/resolve`, is allowlisted and
    ///   lands anonymously below).
    ///   Deleting any one's `.merge(...)` flips it to `404` and reddens this gate
    ///   (delete-landed RED).
    /// * The 4 ANON-LANDED routes are mounted ahead of every perimeter → an anonymous
    ///   probe reaches the handler: #2218's `server/info` and `health` answer `200`, and
    ///   `/readyz` answers `503` on this prepared-but-not-served router (`listen_ready` is
    ///   a serving-boundary fact `prepare()` does not mark); #2219's allowlisted
    ///   `connect-token/resolve` finds no connect-token bearer and answers its OWN `401`
    ///   whose `error_code` body (asserted after the loop) proves it landed anonymously and
    ///   not behind the perimeter. Neither the guarded (bodiless) `401` nor the absent
    ///   `404`. Deleting any one's `.merge(...)` flips it to `404` and reddens this gate.
    /// * 36 RESIDUAL routes probe a path that matches NO mounted route → anon `404`.
    ///   Mounting any one flips it to its perimeter's `401`/`405` and reddens this gate
    ///   (mount-residual RED).
    /// * 3 METHOD-SHADOW residuals share a concrete path with a mounted sibling that
    ///   answers a DIFFERENT method. Probed anonymously the perimeter's `.layer` answers
    ///   `401` before method dispatch (indistinguishable from mounted), so this gate
    ///   probes them AUTHENTICATED (real seeded bearer): the perimeter passes and the
    ///   path's `MethodRouter` bears the truth → `405 METHOD_NOT_ALLOWED`. Mis-mounting
    ///   the residual method flips its answer to a handler status and reddens this gate.
    /// * 1 STATIC-SHADOW residual (`GET /api/agents/name-availability`) collides with the
    ///   mounted dynamic `GET /api/agents/{id}`. Probed AUTHENTICATED with a valid query,
    ///   it falls through to that detail route's byte-exact absent answer
    ///   (`404 {"error":"agent not found"}`). A real static `name-availability` registrar
    ///   would take axum's static-segment priority over `{id}` and answer with its own
    ///   payload, reddening this exact-body assert.
    ///
    /// RESIDUAL routes are NEVER implemented in this lane — they are disproved (404, 405,
    /// or the detail-route fallthrough), not built. A new registrar mounted into
    /// `prepare()` at any of these paths MUST move its row from residual to landed here
    /// (#2218 moved `/api/runtimes` to perimeter-landed and the three root faces to
    /// anon-landed).
    #[tokio::test]
    async fn the_host_agent_lane_stays_a_closed_universe_of_fifty_four() {
        // The 10 PERIMETER-LANDED routes, mounted in `prepare()` behind the human
        // perimeter → anon 401.
        const LANDED: &[(&str, &str)] = &[
            ("GET", "/api/agents"),
            ("GET", "/api/agents/agent-1"),
            ("GET", "/api/agents/agent-1/presence"),
            ("GET", "/api/agents/agent-1/availability"),
            ("GET", "/api/presence"),
            // Host-resources read, Wave 3A checkpoint A5 (#2198).
            ("GET", "/api/hosts/host-1/resources"),
            // Root runtime catalogue, #2218: under `/api/*` with no allowlist entry, so
            // the product refuses anon 401 before the handler; mounted behind the human
            // perimeter to match.
            ("GET", "/api/runtimes"),
            // Host custody CP4, #2219: three of the four authority-complete host-custody
            // routes, mounted behind the human perimeter → anon 401. `GET /api/hosts`
            // shares its path with the mounted invite `POST /api/hosts`; here it is probed
            // anon (401, perimeter), and its GET→handler / POST→invite /
            // unregistered-method→405 dispatch is borne by the dedicated `/api/hosts`
            // two-arm gate below. The fourth route, `connect-token/resolve`, is allowlisted
            // (anonymous) and lands in ANON_LANDED, not here.
            ("GET", "/api/hosts"),
            ("POST", "/api/hosts/claim-or-create"),
            ("POST", "/api/hosts/host-1/rotate-token"),
        ];
        // The 4 ANON-LANDED routes: mounted ahead of every perimeter, so an anonymous
        // probe reaches the handler. #2218's server/info and health answer 200; readyz
        // answers 503 on this prepared-but-not-served router (listen_ready unmarked).
        // #2219's allowlisted `connect-token/resolve` finds no connect-token bearer and
        // answers its OWN 401 — status coincides with a guarded door, so its `error_code`
        // body (asserted after the loop) is the discriminant that proves it landed
        // anonymously rather than behind the perimeter.
        const ANON_LANDED: &[(&str, &str, StatusCode)] = &[
            ("GET", "/api/server/info", StatusCode::OK),
            ("GET", "/api/health", StatusCode::OK),
            ("GET", "/readyz", StatusCode::SERVICE_UNAVAILABLE),
            (
                "GET",
                "/api/hosts/connect-token/resolve",
                StatusCode::UNAUTHORIZED,
            ),
        ];
        // 36 RESIDUAL routes whose path matches no mounted route → anon 404.
        const CLEAN_RESIDUAL: &[(&str, &str)] = &[
            // routes.ts remaining (1)
            ("POST", "/auth/embedded-bootstrap"),
            // hosts remaining (10 of 15; list/resolve/claim-or-create/rotate-token now
            // landed above by #2219, and `GET /api/hosts` is no longer method-shadowed)
            ("GET", "/api/hosts/host-1"),
            ("DELETE", "/api/hosts/host-1"),
            ("POST", "/api/hosts/host-1/revoke"),
            ("POST", "/api/hosts/host-1/connect-token/rotate"),
            ("POST", "/api/hosts/host-1/disconnect"),
            ("GET", "/api/hosts/host-1/proxy-config"),
            ("PUT", "/api/hosts/host-1/proxy-config"),
            ("GET", "/api/hosts/host-1/runtime-catalog"),
            ("PATCH", "/api/hosts/host-1"),
            ("GET", "/api/hosts/host-1/status"),
            // agents residual (16 of 20; name-availability, POST /api/agents,
            // PATCH/DELETE /api/agents/{id} are shadowed, below)
            ("PUT", "/api/agents/agent-1/runtime"),
            ("POST", "/api/agents/agent-1/clear-session"),
            ("POST", "/api/agents/agent-1/avatar"),
            ("DELETE", "/api/agents/agent-1/avatar"),
            ("GET", "/api/agents/agent-1/avatar"),
            ("GET", "/api/agents/agent-1/workspace/tree"),
            ("GET", "/api/agents/agent-1/workspace/file"),
            ("GET", "/api/agents/agent-1/profile/mcp"),
            ("POST", "/api/agents/agent-1/profile/mcp/probe"),
            ("GET", "/api/agents/agent-1/runtime-state"),
            ("GET", "/api/agents/agent-1/chats"),
            ("GET", "/api/agents/agent-1/chats/conv-1/messages"),
            ("GET", "/api/agents/agent-1/chats/conv-1/attachments/att-1"),
            ("GET", "/api/agents/agent-1/schedules"),
            ("POST", "/api/agents/agent-1/schedules/sched-1/cancel"),
            ("POST", "/api/agents/agent-1/stop"),
            // internal profile-MCP (3)
            ("GET", "/internal/agents/agent-1/profile/mcp"),
            ("POST", "/internal/agents/agent-1/profile/mcp"),
            ("POST", "/internal/agents/agent-1/profile/mcp/probe"),
            // internal profile (5)
            ("POST", "/internal/agents/agent-1/avatar"),
            ("DELETE", "/internal/agents/agent-1/avatar"),
            ("GET", "/internal/agents/agent-1/profile"),
            ("POST", "/internal/agents/agent-1/profile"),
            ("GET", "/internal/agents/agent-1/peer-profile"),
            // diagnostic (1)
            ("POST", "/internal/agents/agent-1/cli-trace"),
        ];
        // 3 METHOD-SHADOW residuals: the path is mounted for a DIFFERENT method, so an
        // authenticated probe of the residual method hits the `MethodRouter` → 405.
        const METHOD_SHADOW_RESIDUAL: &[(&str, &str)] = &[
            ("POST", "/api/agents"),           // ← GET /api/agents (mounted)
            ("PATCH", "/api/agents/agent-1"),  // ← GET /api/agents/{id} (mounted)
            ("DELETE", "/api/agents/agent-1"), // ← GET /api/agents/{id} (mounted)
        ];
        // 1 STATIC-SHADOW residual: collides with the mounted dynamic `GET
        // /api/agents/{id}`; an authenticated probe falls through to that route's absent
        // answer (asserted below), not a static handler.
        const STATIC_SHADOW_RESIDUAL: &[(&str, &str)] = &[("GET", "/api/agents/name-availability")];

        // ── Mechanical checksum: (10 + 4) + (36 + 3 + 1) == 54, all unique, landed ∩
        // residual = ∅ ──
        assert_eq!(LANDED.len(), 10);
        assert_eq!(ANON_LANDED.len(), 4);
        assert_eq!(CLEAN_RESIDUAL.len(), 36);
        assert_eq!(METHOD_SHADOW_RESIDUAL.len(), 3);
        assert_eq!(STATIC_SHADOW_RESIDUAL.len(), 1);
        let landed: std::collections::HashSet<(&str, &str)> = LANDED
            .iter()
            .copied()
            .chain(ANON_LANDED.iter().map(|(m, p, _)| (*m, *p)))
            .collect();
        let residual: std::collections::HashSet<(&str, &str)> = CLEAN_RESIDUAL
            .iter()
            .chain(METHOD_SHADOW_RESIDUAL)
            .chain(STATIC_SHADOW_RESIDUAL)
            .copied()
            .collect();
        assert_eq!(landed.len(), 14, "landed rows are unique");
        assert_eq!(residual.len(), 40, "residual rows are unique");
        assert!(
            landed.is_disjoint(&residual),
            "landed and residual are disjoint"
        );
        assert_eq!(
            landed.len() + residual.len(),
            54,
            "the closed universe is 54"
        );

        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let router = app.router;
        let bearer = format!("Bearer {TOKEN}");
        let unauthorized = r#"{"error":"unauthorized"}"#;

        // ── 11 PERIMETER-LANDED → anon 401 (delete-landed RED) ──
        for (method, path) in LANDED {
            let (status, body) = request(&router, method, path, None).await;
            assert_eq!(
                status,
                StatusCode::UNAUTHORIZED,
                "landed {method} {path}: {body}"
            );
            assert_eq!(body, unauthorized, "landed {method} {path}");
        }

        // ── 4 ANON-LANDED → anon reaches the handler (delete-landed RED). Neither the
        // guarded 401 nor the absent 404: server/info 200, health 200, readyz 503, and
        // resolve its own 401. ──
        for (method, path, expected) in ANON_LANDED {
            let (status, body) = request(&router, method, path, None).await;
            assert_eq!(status, *expected, "anon-landed {method} {path}: {body}");
        }
        // resolve's 401 status coincides with a guarded door's, so it is proved to have
        // landed ANONYMOUSLY (reached its own handler, not the perimeter) by its body's
        // `error_code` key — the human perimeter emits `{"error":"unauthorized"}` with
        // none. Mounting resolve behind the perimeter would drop the key and redden this.
        let (_, resolve_body) =
            request(&router, "GET", "/api/hosts/connect-token/resolve", None).await;
        assert_eq!(
            resolve_body, r#"{"error":"unauthorized","error_code":"unauthorized"}"#,
            "anon resolve reaches its own handler, not the perimeter"
        );

        // ── 36 CLEAN RESIDUAL → anon 404 (mount-residual RED) ──
        for (method, path) in CLEAN_RESIDUAL {
            let (status, _) = request(&router, method, path, None).await;
            assert_eq!(
                status,
                StatusCode::NOT_FOUND,
                "clean residual {method} {path} must be unmounted (404)"
            );
        }

        // ── 3 METHOD-SHADOW RESIDUAL → AUTHENTICATED 405 (perimeter passes, the path's
        // MethodRouter bears the truth). Mis-mounting the residual method reddens this. ──
        for (method, path) in METHOD_SHADOW_RESIDUAL {
            let (status, body) = request(&router, method, path, Some(&bearer)).await;
            assert_eq!(
                status,
                StatusCode::METHOD_NOT_ALLOWED,
                "method-shadow residual {method} {path} must be method-unmounted (405): {body}"
            );
        }

        // ── 1 STATIC-SHADOW RESIDUAL → AUTHENTICATED, valid query, falls through to the
        // dynamic `GET /api/agents/{id}` detail route's byte-exact absent answer. A static
        // `name-availability` registrar would win axum's static priority and answer
        // otherwise, reddening this exact-body assert (static-mount RED). ──
        let (status, body) = request(
            &router,
            "GET",
            "/api/agents/name-availability?name=fresh-name",
            Some(&bearer),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "static-shadow: {body}");
        assert_eq!(
            body, r#"{"error":"agent not found"}"#,
            "static-shadow falls through to GET /api/agents/{{id}}, not a static route"
        );
    }

    /// #2219: `/api/hosts` carries TWO methods on one path — `GET` (the newly mounted
    /// list) and `POST` (the pre-existing invite). axum accumulates them into one
    /// `MethodRouter`, so this gate proves neither clobbered the other and no accidental
    /// catch-all swallowed the path: authenticated `GET` dispatches to the LIST handler
    /// (a `{"hosts":[...]}` body with no `connect_token`), authenticated `POST` dispatches
    /// to the INVITE handler (a `host_id` + `connect_token` body, no `hosts`), and an
    /// unregistered method (`DELETE`/`PATCH`) is `405` from the shared `MethodRouter` — not
    /// `404` (which would mean the path vanished) nor a handler status (which would mean a
    /// catch-all). The two success bodies are disjoint in their keys, so a mount that
    /// accidentally pointed both methods at one handler reddens here.
    #[tokio::test]
    async fn the_api_hosts_path_dispatches_get_to_list_and_post_to_invite() {
        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let router = app.router;
        let bearer = format!("Bearer {TOKEN}");

        // Authenticated GET → the list handler. `user-1` owns no hosts yet, so the real
        // owner-scoped read off live SQLite is an empty list — the LIST shape, never the
        // invite's `connect_token`.
        let (status, body) = request(&router, "GET", "/api/hosts", Some(&bearer)).await;
        assert_eq!(status, StatusCode::OK, "authed GET /api/hosts: {body}");
        let listed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            listed,
            serde_json::json!({ "hosts": [] }),
            "GET dispatches to the list handler"
        );
        assert!(
            listed.get("connect_token").is_none(),
            "the list arm is not the invite arm"
        );

        // Authenticated POST (empty body) → the invite handler: it mints a pending
        // user-managed computer off live SQLite and reveals the connect token. The INVITE
        // shape carries `host_id` + `connect_token` and no `hosts` array.
        let (status, body) = request(&router, "POST", "/api/hosts", Some(&bearer)).await;
        assert_eq!(status, StatusCode::OK, "authed POST /api/hosts: {body}");
        let invited: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(
            invited.get("host_id").is_some_and(|v| v.is_string()),
            "POST dispatches to the invite handler: {body}"
        );
        assert!(
            invited.get("connect_token").is_some_and(|v| v.is_string()),
            "the invite arm reveals a connect token: {body}"
        );
        assert!(
            invited.get("hosts").is_none(),
            "the invite arm is not the list arm"
        );

        // Unregistered methods → 405 from the shared `MethodRouter` (path present, method
        // absent), never 404 (path gone) nor a handler status (accidental catch-all).
        for method in ["DELETE", "PATCH", "PUT"] {
            let (status, body) = request(&router, method, "/api/hosts", Some(&bearer)).await;
            assert_eq!(
                status,
                StatusCode::METHOD_NOT_ALLOWED,
                "{method} /api/hosts must be 405 (no clobber, no catch-all): {body}"
            );
        }
    }

    /// #2219 scope B: the OTHER four CP4 handlers (`GET`/`DELETE /api/hosts/{id}`,
    /// `POST /api/hosts/{id}/revoke`, `POST /api/hosts/{id}/connect-token/rotate`) travel
    /// in this convergence tree as compiled component code but are deliberately NOT
    /// mounted — each awaits an effect authority with no production implementer yet.
    /// "Component absorbed" must never be mistaken for "route landed", so this gate probes
    /// each of the four AUTHENTICATED (a real seeded bearer that passes the human
    /// perimeter) and asserts `404`: an unmounted path is absent to the router at BOTH the
    /// anonymous edge (proven in the closed-universe gate) and past the perimeter here. A
    /// mounted-but-guarded route would answer `401` anon and reach its handler
    /// authenticated; a mounted-but-unregistered-method route would answer `405`. Only a
    /// truly unmounted path is `404` under a valid bearer. Mounting any of the four
    /// reddens this gate (and must move its row in the closed-universe ledger).
    #[tokio::test]
    async fn the_four_unmounted_cp4_routes_stay_absorbed_but_unrouted() {
        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let router = app.router;
        let bearer = format!("Bearer {TOKEN}");

        const UNMOUNTED: [(&str, &str); 4] = [
            ("GET", "/api/hosts/host-1"),
            ("DELETE", "/api/hosts/host-1"),
            ("POST", "/api/hosts/host-1/revoke"),
            ("POST", "/api/hosts/host-1/connect-token/rotate"),
        ];
        for (method, path) in UNMOUNTED {
            let (status, body) = request(&router, method, path, Some(&bearer)).await;
            assert_eq!(
                status,
                StatusCode::NOT_FOUND,
                "{method} {path} is absorbed but must stay UNMOUNTED (404 even authenticated): {body}"
            );
        }
    }

    /// #2219 real-authority binding — the invite→resolve chain proves BOTH placement and
    /// wiring in one shot. (1) A connect-token bearer is NOT a human session; a resolve
    /// mounted behind the human perimeter would reject it with the perimeter body before
    /// its own logic ran, so a 200 here proves resolve sits at the anonymous edge (matching
    /// TS's `installPublicBearerMiddleware` allowlist). (2) Only a token this composition
    /// just minted resolves to the host it minted — an empty no-op mount could never return
    /// the invited `host_id`, so the round-trip proves resolve is bound to the real
    /// credential lookup + computer read off live SQLite (the A6 no-op-mount lesson).
    #[tokio::test]
    async fn the_composition_resolves_a_freshly_invited_connect_token_anonymously() {
        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let router = app.router;
        let bearer = format!("Bearer {TOKEN}");

        // Authenticated invite mints a pending computer and reveals its connect token.
        let (status, body) = request(&router, "POST", "/api/hosts", Some(&bearer)).await;
        assert_eq!(status, StatusCode::OK, "invite: {body}");
        let invited: serde_json::Value = serde_json::from_str(&body).unwrap();
        let host_id = invited["host_id"].as_str().unwrap().to_owned();
        let connect_token = invited["connect_token"].as_str().unwrap().to_owned();

        // The daemon presents that connect token at the ANONYMOUS resolve door (no human
        // session). Resolve verifies the credential against live SQLite and reveals the one
        // fact it may — the `host_id` the token was minted for.
        let connect_bearer = format!("Bearer {connect_token}");
        let (status, body) = request(
            &router,
            "GET",
            "/api/hosts/connect-token/resolve",
            Some(&connect_bearer),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "resolve: {body}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({ "host_id": host_id }),
            "resolve returns the invited host_id off live SQLite"
        );

        // A garbage bearer reaches the same anonymous handler and is refused by ITS OWN
        // logic — a 401 carrying the handler's discriminated `error_code`, never the
        // perimeter's `{"error":"unauthorized"}` (which omits `error_code`).
        let (status, body) = request(
            &router,
            "GET",
            "/api/hosts/connect-token/resolve",
            Some("Bearer not-a-real-connect-token"),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "garbage token: {body}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({ "error": "unauthorized", "error_code": "unauthorized" }),
            "resolve's own 401 body, not the perimeter's"
        );
    }

    /// #2219 real-authority binding — the claim→rotate chain under the Embedded profile.
    /// Claim mints a `kind:"local"` computer off live SQLite; rotate then re-mints that
    /// computer's long-lived token via the embedded router's real `RotateHostToken`. A
    /// no-op mount could not (a) return a fresh 43-char token that DIFFERS from the claim's,
    /// nor (b) answer a byte-exact `host_not_found` for an absent id. Anti-enumeration and
    /// the method checksum ride along so a mount that widened the door reddens here.
    #[tokio::test]
    async fn the_composition_claims_a_local_computer_and_rotates_its_token_embedded() {
        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let router = app.router;
        let bearer = format!("Bearer {TOKEN}");

        // Anonymous claim is refused at the human perimeter before any body is read.
        let (status, _) = request(&router, "POST", "/api/hosts/claim-or-create", None).await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "claim is behind the perimeter"
        );

        // A well-formed claim mints a local computer and reveals its first token.
        let claim_body = r#"{"installation_id":"11111111-1111-4111-8111-111111111111"}"#;
        let (status, body) = request_with_body(
            &router,
            "POST",
            "/api/hosts/claim-or-create",
            Some(&bearer),
            Body::from(claim_body),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "claim: {body}");
        let claimed: serde_json::Value = serde_json::from_str(&body).unwrap();
        let host_id = claimed["host_id"].as_str().unwrap().to_owned();
        assert_eq!(
            claimed["host"]["kind"], "local",
            "claim mints a local computer"
        );
        let first_token = claimed["host_token"].as_str().unwrap().to_owned();
        assert_eq!(
            first_token.len(),
            43,
            "claim reveals the minted token: {body}"
        );

        // A malformed installation_id is a request-classification 400, never a lookup.
        let (status, body) = request_with_body(
            &router,
            "POST",
            "/api/hosts/claim-or-create",
            Some(&bearer),
            Body::from(r#"{"installation_id":"not-a-uuid"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "bad uuid: {body}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap()["error"],
            "invalid input",
            "a malformed body is invalid input, not a not-found"
        );

        // Rotate that freshly claimed local computer through the embedded router's real
        // authority: a new 43-char token that differs from the claim's.
        let rotate_uri = format!("/api/hosts/{host_id}/rotate-token");
        let (status, body) = request(&router, "POST", &rotate_uri, Some(&bearer)).await;
        assert_eq!(status, StatusCode::OK, "rotate: {body}");
        let rotated: serde_json::Value = serde_json::from_str(&body).unwrap();
        let second_token = rotated["host_token"].as_str().unwrap().to_owned();
        assert_eq!(second_token.len(), 43, "rotate re-mints a token: {body}");
        assert_ne!(first_token, second_token, "the token was actually rotated");

        // Anti-enumeration: rotating an absent computer is a byte-exact `host_not_found`
        // from the HANDLER (proving the handler ran), never a bare unmounted-path 404.
        let (status, body) = request(
            &router,
            "POST",
            "/api/hosts/host-absent/rotate-token",
            Some(&bearer),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "absent rotate: {body}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({ "error": "host not found", "error_code": "host_not_found" }),
            "the handler's anti-enumeration 404, not an unmounted-path 404"
        );

        // Anon → 401 (behind the perimeter); GET → 405 (path present, method absent).
        let (status, _) = request(&router, "POST", &rotate_uri, None).await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "rotate is behind the perimeter"
        );
        let (status, _) = request(&router, "GET", &rotate_uri, Some(&bearer)).await;
        assert_eq!(
            status,
            StatusCode::METHOD_NOT_ALLOWED,
            "rotate is POST-only"
        );
    }

    /// #2219 real-authority binding — the standalone (RemoteOnly) rotate arm. The key
    /// differential: with no daemon connected, rotate answers `503 transport_no_connection`,
    /// NOT `503 host_runtime_disabled`. The latter is the composition-time `None` stub; the
    /// former can only come from a wired `Some(coordinator)` that attempted delivery and
    /// found no transport. This proves `standalone_router` was composed with the real daemon
    /// coordinator, not disabled.
    #[tokio::test]
    async fn the_standalone_composition_rotates_a_claimed_computer_through_the_daemon_coordinator()
    {
        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        let app = prepare(&remote_config(fixture.path.clone())).await.unwrap();
        let router = app.router;
        let bearer = format!("Bearer {TOKEN}");

        // Claim mints a local computer under RemoteOnly too — the perimeter chain mounts
        // claim regardless of profile.
        let (status, body) = request_with_body(
            &router,
            "POST",
            "/api/hosts/claim-or-create",
            Some(&bearer),
            Body::from(r#"{"installation_id":"11111111-1111-4111-8111-111111111111"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "claim (standalone): {body}");
        let host_id = serde_json::from_str::<serde_json::Value>(&body).unwrap()["host_id"]
            .as_str()
            .unwrap()
            .to_owned();

        // Rotate reaches the standalone coordinator, which finds no connected daemon.
        let (status, body) = request(
            &router,
            "POST",
            &format!("/api/hosts/{host_id}/rotate-token"),
            Some(&bearer),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::SERVICE_UNAVAILABLE,
            "standalone rotate: {body}"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({
                "error": "host token rotation transport failed",
                "error_code": "transport_no_connection"
            }),
            "a wired Some(coordinator) with no transport, NOT the None host_runtime_disabled stub"
        );
    }

    /// P0-1: `listen_ready` is a SERVING-boundary fact witnessed by the bound listener,
    /// not a flag anyone can flip. There is no public `mark_listen_ready`; the ONLY way
    /// to establish it is to hand a bound `TcpListener` to [`serve`], which marks the
    /// holder the `/readyz` router shares. So this test binds a real listener and
    /// actually starts `serve`, then watches that SAME shared holder go 503 → 200. A
    /// prepared-but-unserved app stays 503; if `prepare()` marked it, or if the mark
    /// were a caller-callable method independent of a listener, the first probe would be
    /// 200 and this reddens.
    #[tokio::test]
    async fn readyz_reports_listen_ready_only_after_serve_receives_the_bound_listener() {
        let fixture = fixture(true).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        // The router shares the SAME `BootProgress` handle `serve` will mark, so probing
        // this clone observes the real serving-boundary flip — not a copy.
        let router = app.router.clone();

        // Prepared but not served: migrations + db green, listen_ready false → 503.
        let (status, body) = request(&router, "GET", "/readyz", None).await;
        assert_eq!(
            status,
            StatusCode::SERVICE_UNAVAILABLE,
            "before serve: {body}"
        );
        let before: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(before["ok"], serde_json::json!(false));
        assert_eq!(
            before["checks"]["migrations_applied"],
            serde_json::json!(true)
        );
        assert_eq!(before["checks"]["listen_ready"], serde_json::json!(false));

        // Bind a REAL listener and actually start serving. `serve` marks `listen_ready`
        // from the bound listener it now holds — nothing else in the process can.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        // The receiver IS the shutdown future (`Output = Result<(), RecvError>`), so it
        // satisfies `serve`'s bound directly.
        let served = tokio::spawn(serve(listener, app, shutdown_rx));

        // Poll the SAME holder until the serve task's mark lands. `serve` marks before
        // its first await, so a bounded yield loop is enough; we never flip the holder
        // ourselves.
        let mut ready = false;
        for _ in 0..100 {
            let (status, _) = request(&router, "GET", "/readyz", None).await;
            if status == StatusCode::OK {
                ready = true;
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(
            ready,
            "serve must establish listen_ready from the bound listener"
        );

        let (status, body) = request(&router, "GET", "/readyz", None).await;
        assert_eq!(status, StatusCode::OK, "after serve: {body}");
        let after: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(after["ok"], serde_json::json!(true));
        assert_eq!(after["checks"]["listen_ready"], serde_json::json!(true));

        let _ = shutdown_tx.send(());
        let _ = served.await;
    }

    /// P0-2: `SILVERHAND_DISABLE_SIGNUP` has TWO launcher contracts, so the parser is
    /// profile×input — never a generic truthy helper. Embedded disables ONLY on the
    /// exact `"1"` and never fails; RemoteOnly trims, accepts only `0`/`1`, defaults
    /// unset/empty to enabled, and hard-fails on anything else. This pins both against
    /// the TS authorities (`packages/backend/src/auth/config.ts`,
    /// `packages/server/src/config.ts`), including the values where they DIVERGE.
    #[test]
    fn signup_admission_matches_each_launchers_contract() {
        use DeploymentProfile::{Embedded, RemoteOnly};

        // Embedded: only exact "1" disables; every other value enables; nothing fails.
        assert!(parse_signup_enabled(Embedded, None).unwrap()); // unset → enabled
        assert!(parse_signup_enabled(Embedded, Some("0")).unwrap());
        assert!(!parse_signup_enabled(Embedded, Some("1")).unwrap()); // disabled
        assert!(parse_signup_enabled(Embedded, Some("true")).unwrap()); // NOT "1" → enabled
        assert!(parse_signup_enabled(Embedded, Some(" 1 ")).unwrap()); // no trim → enabled
        assert!(parse_signup_enabled(Embedded, Some("garbage")).unwrap());
        assert!(parse_signup_enabled(Embedded, Some("")).unwrap());

        // RemoteOnly: unset/empty default enabled; only trimmed 0/1 legal; else fails.
        assert!(parse_signup_enabled(RemoteOnly, None).unwrap());
        assert!(parse_signup_enabled(RemoteOnly, Some("")).unwrap());
        assert!(parse_signup_enabled(RemoteOnly, Some("0")).unwrap());
        assert!(!parse_signup_enabled(RemoteOnly, Some("1")).unwrap()); // disabled
        assert!(!parse_signup_enabled(RemoteOnly, Some(" 1 ")).unwrap()); // trimmed → disabled
        for fails in ["true", "TRUE", "garbage", " "] {
            assert!(
                matches!(
                    parse_signup_enabled(RemoteOnly, Some(fails)),
                    Err(ConfigError::InvalidDisableSignup(_))
                ),
                "RemoteOnly {fails:?} must fail startup, not silently enable"
            );
        }
    }

    /// P0-3: the RemoteOnly half of the ONE product is a real `prepare()` composition,
    /// not just an enum arm — so this differential drives it end-to-end and would redden
    /// if composition swapped the runtimes arms, mis-projected a mode axis, or dropped a
    /// root face. Under the SAME profile it asserts: `/api/health` reports
    /// `mode:"remote"`; `/readyz` reports `mode:"remote"` + `deployment_mode:"standalone"`
    /// + an uninstalled fanout key + 503; and `/api/runtimes` is the control-plane
    /// refusal (503 `host_runtime_disabled` when authenticated, still 401 anonymous
    /// behind the perimeter — never a detection pass).
    #[tokio::test]
    async fn the_remote_only_profile_composes_a_control_plane_backend() {
        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        let app = prepare(&remote_config(fixture.path.clone())).await.unwrap();
        let router = app.router;
        let bearer = format!("Bearer {TOKEN}");

        // `/api/health` — anonymous, remote mode.
        let (status, body) = request(&router, "GET", "/api/health", None).await;
        assert_eq!(status, StatusCode::OK, "remote health: {body}");
        let health: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(health["ok"], serde_json::json!(true));
        assert_eq!(health["mode"], serde_json::json!("remote"));

        // `/readyz` — anonymous, standalone shape, fanout uninstalled → honest 503.
        let (status, body) = request(&router, "GET", "/readyz", None).await;
        assert_eq!(
            status,
            StatusCode::SERVICE_UNAVAILABLE,
            "remote readyz: {body}"
        );
        let ready: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(ready["ok"], serde_json::json!(false));
        assert_eq!(ready["mode"], serde_json::json!("remote"));
        assert_eq!(ready["deployment_mode"], serde_json::json!("standalone"));
        assert_eq!(
            ready["checks"]["outbound_event_fanout_installed"],
            serde_json::json!(false),
            "no fanout call site in RemoteOnly → honestly uninstalled"
        );

        // `/api/runtimes` — anonymous still 401 (behind the perimeter)…
        let (status, _) = request(&router, "GET", "/api/runtimes", None).await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "remote runtimes anon → 401"
        );

        // …and authenticated, the control-plane refusal, never a detection pass.
        let (status, body) = request(&router, "GET", "/api/runtimes", Some(&bearer)).await;
        assert_eq!(
            status,
            StatusCode::SERVICE_UNAVAILABLE,
            "remote runtimes: {body}"
        );
        let refusal: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(refusal["code"], serde_json::json!("host_runtime_disabled"));
    }
    /// one host with DISTINCT `created_at`, so the list's `created_at ASC` order is
    /// defined, plus a registered STRANGER (`user-stranger`, its own seeded session over
    /// `ADMIN_HASH`) who is in no arm of either agent — so the list face collapses that
    /// caller to an empty array with no existence oracle.
    async fn seed_list_agents(path: &Path) {
        let pool = SqlitePoolOptions::new()
            .connect(path.to_str().unwrap())
            .await
            .unwrap();
        for statement in [
            "INSERT INTO hosts (id, name, kind, created_at, user_id) VALUES ('h-list', 'host-list', 'remote', 1, 'user-1')",
            "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, created_by_user_id, materialization_status) \
             VALUES ('al-1', 'agent-list-one', 'qoder', 'h-list', 100, 100, 'user-1', 'active')",
            "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, created_by_user_id, materialization_status) \
             VALUES ('al-2', 'agent-list-two', 'qoder', 'h-list', 200, 200, 'user-1', 'active')",
            "INSERT INTO users (id, name, display_name, created_at, updated_at) VALUES ('user-stranger', 'stranger', 'Stranger', 1, 1)",
        ] {
            sqlx::query(statement).execute(&pool).await.unwrap();
        }
        let now = i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap();
        sqlx::query(
            "INSERT INTO auth_sessions (id, user_id, token_hash, created_at, last_used_at, revoked_at, user_agent, ip_first_seen) VALUES ('session-stranger', 'user-stranger', ?, ?, ?, NULL, NULL, NULL)",
        )
        .bind(ADMIN_HASH)
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
    }

    /// The composition mounts `GET /api/agents` (agent-LIST) behind the SAME human
    /// perimeter, wired to the real SQLite agent-list cold read. Proves the composition
    /// obligation the leaf's own tests cannot: the anonymous perimeter refusal; an
    /// admitted creator reading the real seeded set off the live SQLite adapter in the
    /// port's `created_at ASC` order; a registered STRANGER collapsing to the empty
    /// array with no existence oracle; and a one-method route checksum. The per-branch
    /// matrix (stage flags, `?scope=owned`, projection) stays with the leaf's own tests;
    /// this proves the route is MOUNTED and reads the composition's real adapter.
    #[tokio::test]
    async fn the_composition_serves_agent_list_behind_the_perimeter() {
        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        seed_list_agents(&fixture.path).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let router = app.router;
        let bearer = format!("Bearer {TOKEN}");
        let stranger = format!("Bearer {ADMIN_TOKEN}");
        let path = "/api/agents";

        // Anonymous → the perimeter's refusal envelope, never a list answer.
        let (status, body) = request(&router, "GET", path, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(body, r#"{"error":"unauthorized"}"#);

        // Admitted creator → the real adapter's `created_at ASC` set off live SQLite.
        let (status, body) = request(&router, "GET", path, Some(&bearer)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let ids = serde_json::from_str::<serde_json::Value>(&body).unwrap()["agents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|agent| agent["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(ids, ["al-1", "al-2"]);

        // Registered stranger → the empty array; a list face has no 404, a hidden agent
        // is simply ABSENT, so the mounted surface is never an enumeration oracle.
        let (status, body) = request(&router, "GET", path, Some(&stranger)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({ "agents": [] })
        );

        // One-method route checksum: the mounted path serves GET only.
        let (status, body) = request(&router, "POST", path, Some(&bearer)).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "{body}");
    }

    /// The direct-pair initiation TARGET for viewer `user-1`: one host and one active
    /// agent the viewer created with an `agent` session scope. This is the "creator" arm
    /// of the initiation authority (`direct_pair_initiation_candidate`: `created_by_user_id
    /// = viewer AND materialization_status = 'active' AND session_scope = 'agent'`), so no
    /// workspace membership or pre-existing pair is needed to be allowed to open the line.
    /// The literal id equals `DP_TARGET_AGENT`, which the E2E builds its path from, so any
    /// drift fails loudly.
    const DP_TARGET_AGENT: &str = "dp-target-1";

    async fn seed_direct_pair_target(path: &Path) {
        let pool = SqlitePoolOptions::new()
            .connect(path.to_str().unwrap())
            .await
            .unwrap();
        for statement in [
            "INSERT INTO hosts (id, name, kind, created_at, user_id) VALUES ('h-dp', 'host-dp', 'remote', 1, 'user-1')",
            "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, created_by_user_id, session_scope, materialization_status) \
             VALUES ('dp-target-1', 'pair-target', 'qoder', 'h-dp', 100, 100, 'user-1', 'agent', 'active')",
        ] {
            sqlx::query(statement).execute(&pool).await.unwrap();
        }
        pool.close().await;
    }

    async fn count(path: &Path, sql: &'static str) -> i64 {
        let pool = SqlitePoolOptions::new()
            .connect(path.to_str().unwrap())
            .await
            .unwrap();
        let total: i64 = sqlx::query_scalar(sql).fetch_one(&pool).await.unwrap();
        pool.close().await;
        total
    }

    /// The one direct-pair conversation id from the live store — the pair the initiation
    /// door minted. Used to name the conversation-scope the aftermath's `message` frame
    /// rides, without the test having to predict the allocated id.
    async fn direct_pair_conversation_id(path: &Path) -> String {
        let pool = SqlitePoolOptions::new()
            .connect(path.to_str().unwrap())
            .await
            .unwrap();
        let id: String =
            sqlx::query_scalar("SELECT id FROM conversations WHERE placement_kind = 'direct_pair'")
                .fetch_one(&pool)
                .await
                .unwrap();
        pool.close().await;
        id
    }

    /// A FRESH authenticated event-WS subscription's `subscribed.seq` for `scope`: the hub's
    /// own high-water, which it reports deterministically in the ack. Reading it from a fresh
    /// subscription (rather than draining a live socket) seals the "under-read / extra frame
    /// left queued" false-green — the hub tells the truth about how many frames it published.
    async fn fresh_scope_high_water(address: std::net::SocketAddr, scope: &str) -> i64 {
        let mut request = format!("ws://{address}{EVENT_WEBSOCKET_PATH}")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert(ORIGIN, "http://localhost:5173".parse().unwrap());
        request.headers_mut().insert(
            COOKIE,
            format!("{EVENT_WS_SESSION_COOKIE}={TOKEN}")
                .parse()
                .unwrap(),
        );
        request
            .headers_mut()
            .insert(DESKTOP_API_EPOCH_HEADER, MINIMUM_CLIENT_API_EPOCH.into());
        let (mut socket, _) = connect_async(request).await.unwrap();
        assert_eq!(next_socket_json(&mut socket).await["type"], "authenticated");
        socket
            .send(ClientMessage::Text(
                serde_json::json!({ "type": "subscribe", "scope": scope })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let subscribed = next_socket_json(&mut socket).await;
        assert_eq!(subscribed["type"], "subscribed", "{subscribed}");
        let seq = subscribed["seq"].as_i64().unwrap();
        socket.close(None).await.unwrap();
        seq
    }

    /// Wave 3A checkpoint A6 (#2203): the human direct-pair initiation WRITE door,
    /// `POST /api/agents/{id}/direct-messages`, mounted in `prepare()` behind the SAME
    /// `require_human_session` perimeter and wired to the ONE production `MessagingStore`
    /// the ordinary send door holds (as its get-or-create initiation authority, its
    /// direct-line authority, and its send unit-of-work), the SAME `ScopeEventHub`
    /// (winner-only pair-opened publication), and the SAME required `MessagingAftermath`.
    ///
    /// Two composition obligations the leaf router/adapter tests cannot prove:
    /// * the route is MOUNTED behind the perimeter and reaches the composition's real
    ///   adapters: an anonymous POST is refused `401` by the perimeter's `.layer` before
    ///   routing (the live store showing no pair and no message is a zero-SIDE-EFFECT
    ///   corroboration only — NOT a 0-call proof, since a read-then-write authority could
    ///   also leave 0/0; the auth-before-authority order is proven by
    ///   `the_direct_pair_initiation_authority_is_consulted_only_after_the_perimeter`, and
    ///   the port's zero consult on missing auth by the leaf counting test);
    /// * an admitted viewer opening a pair with an agent they own reaches the live SQLite
    ///   mint through the real hub/aftermath (`201`), and the new pair then appears in the
    ///   composed cold `GET /api/direct-pairs` read that was empty before — write→read both
    ///   off the one production store. A second POST returns the SAME pair (`201`, still ONE
    ///   pair in the cold list) yet still sends a second message — get-or-create idempotency,
    ///   not a rollback. (That the FIRST send additionally announces the winner pair-open and
    ///   BOTH sends run the real aftermath is proven on the event WS by
    ///   `the_composition_delivers_the_pair_open_and_the_aftermath_to_the_real_hubs`; row
    ///   counts here prove neither.) A one-method checksum pins the path to POST only.
    ///
    /// The per-branch refusal matrix (the two size-gate field shapes, reply-target-before-
    /// content-cap ordering, the winner-only LIVE announce) stays with the door's own
    /// router/adapter tests; this gate proves the route is MOUNTED and reaches the
    /// composition's real adapters.
    #[tokio::test]
    async fn the_composition_opens_a_direct_pair_and_sends_behind_the_perimeter() {
        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        seed_direct_pair_target(&fixture.path).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let router = app.router;
        let bearer = format!("Bearer {TOKEN}");
        let path = format!("/api/agents/{DP_TARGET_AGENT}/direct-messages");
        let pairs_sql = "SELECT COUNT(*) FROM conversations WHERE placement_kind = 'direct_pair'";

        // Zero-side-effect corroboration (NOT a 0-call proof): the anonymous POST is refused
        // by the perimeter before any product work, so the real store shows no pair and no
        // message. Auth-before-authority order and the port's zero consult live in their own
        // gates below.
        let (status, body) = request_with_body(
            &router,
            "POST",
            &path,
            None,
            Body::from(r#"{"content":"hi"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(body, r#"{"error":"unauthorized"}"#);
        assert_eq!(
            count(&fixture.path, pairs_sql).await,
            0,
            "anon POST minted a pair"
        );
        assert_eq!(
            count(&fixture.path, "SELECT COUNT(*) FROM messages").await,
            0,
            "anon POST sent a message"
        );

        // Cold list is empty before the first admitted open.
        let (status, body) = request(&router, "GET", "/api/direct-pairs", Some(&bearer)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body, r#"{"direct_pairs":[]}"#);

        // Admitted viewer opens the pair with an agent they own → the live mint + send.
        let (status, body) = request_with_body(
            &router,
            "POST",
            &path,
            Some(&bearer),
            Body::from(r#"{"content":"hello"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        assert_eq!(
            count(&fixture.path, pairs_sql).await,
            1,
            "the winner mints one pair"
        );
        assert_eq!(
            count(&fixture.path, "SELECT COUNT(*) FROM messages").await,
            1,
            "the first message is sent"
        );

        // The new pair is now visible in the composed cold read — write→read off one store.
        let (status, body) = request(&router, "GET", "/api/direct-pairs", Some(&bearer)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let listed = serde_json::from_str::<serde_json::Value>(&body).unwrap();
        assert_eq!(
            listed["direct_pairs"].as_array().unwrap().len(),
            1,
            "{body}"
        );

        // Get-or-create idempotency: a second POST re-uses the SAME pair (still ONE) yet
        // still sends a second message — parity, not a rollback. (The winner-only pair-open
        // announce and the per-send aftermath are proven on the event WS gate below, not by
        // these row counts.)
        let (status, body) = request_with_body(
            &router,
            "POST",
            &path,
            Some(&bearer),
            Body::from(r#"{"content":"again"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        assert_eq!(
            count(&fixture.path, pairs_sql).await,
            1,
            "get-or-create loser re-uses the pair, never a second"
        );
        assert_eq!(
            count(&fixture.path, "SELECT COUNT(*) FROM messages").await,
            2,
            "both paths send their first message"
        );

        // One-method checksum: the mounted path serves POST only.
        let (status, _) = request(&router, "GET", &path, Some(&bearer)).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    }

    /// P0-1 (Cindy): the direct-pair initiation authority is a read-then-write port, so a
    /// zero write count can never prove it was not CONSULTED. This proves the auth-before-
    /// authority ORDER on the real `prepare()` wiring, by a broken-authority differential:
    /// after `prepare()`, DROP the ONE table the initiation authority reads (`agents`) — the
    /// perimeter's own session tables are untouched — and drive the SAME broken tree two
    /// ways. A missing OR unknown credential is still an EXACT `401` (auth refuses before the
    /// now-broken authority is ever touched, so the break is invisible to it); the SAME
    /// broken tree with a real credential clears the perimeter, reaches the authority, and
    /// faults into a safe `500`. That `500` excludes the two false-greens a bare `401`
    /// cannot: a route never mounted (would `404`) and a break that never took effect (would
    /// `201`). A "consult-authority-then-reject-anon" mis-mount would surface the break on the
    /// anonymous call too, so the exact anon `401` is the load-bearing discriminator.
    #[tokio::test]
    async fn the_direct_pair_initiation_authority_is_consulted_only_after_the_perimeter() {
        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        seed_direct_pair_target(&fixture.path).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let running = tokio::spawn(serve(listener, app, async move {
            let _ = shutdown_rx.await;
            Ok::<(), std::io::Error>(())
        }));
        let path = format!("/api/agents/{DP_TARGET_AGENT}/direct-messages");

        // Healthy first: the authenticated door works end-to-end, so a later 500 is caused by
        // the break we introduce and not a pre-existing fault.
        let healthy = http_over_tcp(
            address,
            "POST",
            &path,
            Some(&format!("Bearer {TOKEN}")),
            r#"{"content":"healthy"}"#,
        )
        .await;
        assert!(healthy.starts_with("HTTP/1.1 201 Created\r\n"), "{healthy}");

        // Break the ONE table the initiation authority reads (`SELECT ... FROM agents`).
        let pool = SqlitePoolOptions::new()
            .connect(fixture.path.to_str().unwrap())
            .await
            .unwrap();
        sqlx::query("DROP TABLE agents")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        // Missing AND unknown credential → EXACT 401 with the exact unauthorized envelope:
        // auth refuses before the now-broken authority is ever consulted, so the drop is
        // invisible on this path. Asserting the body (not just the status line) is what makes
        // "EXACT 401" true for BOTH branches — the missing-auth envelope proven on the mount
        // gate cannot stand in for the unknown-token branch.
        for bearer in [None, Some("Bearer not-a-real-token")] {
            let refused = http_over_tcp(address, "POST", &path, bearer, r#"{"content":"x"}"#).await;
            assert!(
                refused.starts_with("HTTP/1.1 401 Unauthorized\r\n"),
                "an unauthenticated POST must be 401 regardless of authority health: {refused}"
            );
            assert_eq!(
                http_json_body(&refused),
                serde_json::json!({ "error": "unauthorized" }),
                "the refusal must carry the exact unauthorized envelope, not a leaked fault: {refused}"
            );
        }

        // SAME broken tree, real credential: the perimeter admits, the authority IS reached
        // and faults on the dropped table → safe 500. Not 404 (route mounted), not 201/created
        // (the break is effective).
        let broken = http_over_tcp(
            address,
            "POST",
            &path,
            Some(&format!("Bearer {TOKEN}")),
            r#"{"content":"x"}"#,
        )
        .await;
        assert!(
            broken.starts_with("HTTP/1.1 500 Internal Server Error\r\n"),
            "an authenticated POST must reach the broken authority and fail safe: {broken}"
        );

        shutdown_tx.send(()).unwrap();
        running.await.unwrap().unwrap();
    }

    /// P0-2 (Cindy + Lio) — DUAL-AXIS causal proof that `prepare()` wires the REAL hub and
    /// the REAL `MessagingAftermath` to this write door (not a no-op / second hub). Row
    /// counts and the leaf `Opened` counter cannot see the activation's composition seam;
    /// these two live event-WS axes can, and each reddens one mutation BY NAME:
    ///
    /// * CONVERSATION scope carries the aftermath. Every committed send publishes its own
    ///   `message` frame there — a kind ONLY the aftermath produces (no-mention sends emit no
    ///   viewer `Notification`). Swapping the mounted aftermath for `NoAftermath` drops this
    ///   axis's high-water to 0, reddening the aftermath seam on its own axis.
    /// * VIEWER scope carries the winner-only pair-open sink. `direct_pairs_changed` is a
    ///   same-shape funnel — mint, direct-line invalidation, AND unread all publish the
    ///   identical `{conversation_id}` frame — so a kind-set assertion has ZERO discriminating
    ///   power here (Lio). The axis is pinned by two ABSOLUTE increments instead: the first
    ///   POST adds exactly `N` viewer frames, the second (loser) exactly `M`, each measured
    ///   against real production behavior. `N == M + 1` (explanation only) is the winner-only
    ///   pair-open; a no-op / second-hub opened sink drops ONLY the first increment to `N-1`
    ///   with `M` unchanged, so the first absolute count reddens alone. Pinning both absolutes
    ///   (not just their difference) means any drift in another same-kind producer reddens a
    ///   named count instead of silently re-tuning the gate.
    ///
    /// Both axes read their high-water from a FRESH subscription's `subscribed.seq`, which is
    /// the hub's own deterministic count and seals the "under-read / extra frame left queued"
    /// false-green.
    #[tokio::test]
    async fn the_composition_delivers_the_pair_open_and_the_aftermath_to_the_real_hubs() {
        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        seed_direct_pair_target(&fixture.path).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let running = tokio::spawn(serve(listener, app, async move {
            let _ = shutdown_rx.await;
            Ok::<(), std::io::Error>(())
        }));
        let path = format!("/api/agents/{DP_TARGET_AGENT}/direct-messages");
        let bearer = format!("Bearer {TOKEN}");

        // Baseline: nothing published to the viewer's list yet.
        assert_eq!(fresh_scope_high_water(address, "viewer:self").await, 0);

        // First POST — winner: mints the pair AND sends the first message.
        let first = http_over_tcp(
            address,
            "POST",
            &path,
            Some(&bearer),
            r#"{"content":"first"}"#,
        )
        .await;
        assert!(first.starts_with("HTTP/1.1 201 Created\r\n"), "{first}");
        let viewer_after_first = fresh_scope_high_water(address, "viewer:self").await;

        // The conversation the winner minted names the scope the aftermath's `message` rides.
        let conversation = direct_pair_conversation_id(&fixture.path).await;
        let conversation_scope = format!("conversation:{conversation}");
        let conversation_after_first = fresh_scope_high_water(address, &conversation_scope).await;

        // Second POST — loser: get-or-creates the SAME pair, sends a second message, and does
        // NOT re-announce the pair-open.
        let second = http_over_tcp(
            address,
            "POST",
            &path,
            Some(&bearer),
            r#"{"content":"second"}"#,
        )
        .await;
        assert!(second.starts_with("HTTP/1.1 201 Created\r\n"), "{second}");
        let viewer_after_second = fresh_scope_high_water(address, "viewer:self").await;
        let conversation_after_second = fresh_scope_high_water(address, &conversation_scope).await;

        let first_viewer_increment = viewer_after_first;
        let second_viewer_increment = viewer_after_second - viewer_after_first;
        let first_conversation_increment = conversation_after_first;
        let second_conversation_increment = conversation_after_second - conversation_after_first;

        // CONVERSATION axis — the aftermath seam. Each send announces exactly one `message`
        // frame; `NoAftermath` would leave both increments at 0.
        assert_eq!(
            first_conversation_increment, 1,
            "the first send's aftermath must announce exactly one conversation `message` frame"
        );
        assert_eq!(
            second_conversation_increment, 1,
            "the second send's aftermath must announce exactly one conversation `message` frame"
        );

        // VIEWER axis — the winner-only pair-open sink. Two ABSOLUTE increments, pinned to the
        // measured production behavior; `N == M + 1` is the winner-only pair-open.
        assert_eq!(
            first_viewer_increment, 2,
            "first POST viewer frames: winner pair-open + one per-send direct-pair invalidation"
        );
        assert_eq!(
            second_viewer_increment, 1,
            "second POST viewer frames: the per-send direct-pair invalidation only (no re-announce)"
        );
        assert_eq!(
            first_viewer_increment,
            second_viewer_increment + 1,
            "the winner-only pair-open is exactly one viewer frame more on the first send"
        );

        shutdown_tx.send(()).unwrap();
        running.await.unwrap().unwrap();
    }

    /// Wave 3A checkpoint A1: the five channel directory/detail read doors, mounted in
    /// `prepare()` behind the SAME human perimeter and wired to the ONE production
    /// `MessagingStore` the send door holds (`.channel_directory()`,
    /// `.channel_lifecycle()`, `.conversation_agent_directory()` — pool clones, no second
    /// authority). Two composition obligations the leaf factories' own tests cannot
    /// prove:
    ///
    /// * `the_composition_serves_channel_directory_and_detail_behind_the_perimeter`
    ///   drives every one of the five through the real composed root: anonymous → the
    ///   perimeter's `401`; an admitted workspace member → a real `200` read off the live
    ///   SQLite adapter (the active list and the detail door carry the seeded
    ///   conversation id, proving the store adapter — not a stub — answered), plus a
    ///   one-method checksum on the detail path.
    /// * `the_channel_perimeter_refuses_before_touching_the_product_port` is the
    ///   load-bearing refusal gate: it mounts the SAME three factories behind the SAME
    ///   `require_human_session` over a counting spy port, and proves an anonymous read
    ///   is refused `401` with the product port invoked ZERO times — the perimeter
    ///   `.layer` runs before routing, so a handler (and its port call) never executes.
    ///   A `401` status alone cannot prove this; the call counter can.
    mod channel_directory_activation {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};

        use silverhand_backend_core::{
            auth::{HumanSessionAuthenticator, SessionTtl, SystemSessionClock},
            identity::{ConversationId, UserId, WorkspaceId},
            messaging::collaboration::{
                channel_directory::{
                    ActiveChannelDirectoryPort, ActiveWorkspaceChannelDirectory, ArchivedSince,
                    ArchivedWorkspaceChannelDirectory, ArchivedWorkspaceChannelDirectoryPort,
                    GlobalArchivedChannelDirectory, GlobalArchivedChannelDirectoryPort,
                    GlobalArchivedDirectoryRefusal, WorkspaceDirectoryRefusal,
                },
                channel_lifecycle::{
                    ChannelDetailFact, ChannelDetailReadPort, ChannelDetailRefusal,
                },
                conversation_agent_directory::{
                    ConversationAgentDirectory, ConversationAgentDirectoryReadPort,
                    ConversationAgentDirectoryRefusal,
                },
            },
        };
        use silverhand_backend_server::{
            auth::{PublicJsonUnauthorized, require_human_session},
            messaging::collaboration::{
                channel_directory, channel_lifecycle, conversation_agent_directory,
            },
        };
        use silverhand_backend_sqlite::auth::SqliteSessionStore;

        use super::*;

        #[tokio::test]
        async fn the_composition_serves_channel_directory_and_detail_behind_the_perimeter() {
            let fixture = fixture(true).await;
            seed_human(&fixture.path).await;
            seed_channel_directory(&fixture.path).await;
            let app = prepare(&config(fixture.path.clone())).await.unwrap();
            let router = app.router;
            let bearer = format!("Bearer {TOKEN}");

            let workspace_channels = format!("/api/workspaces/{WORKSPACE_ID}/channels");
            let workspace_archived = format!("/api/workspaces/{WORKSPACE_ID}/channels/archived");
            let global_archived = "/api/archived-channels".to_owned();
            let channel_detail = format!("/api/channels/{CONVERSATION_ID}");
            let channel_agents = format!("/api/channels/{CONVERSATION_ID}/agents");

            // Anonymous → the perimeter's refusal envelope on every door, never a read.
            for path in [
                &workspace_channels,
                &workspace_archived,
                &global_archived,
                &channel_detail,
                &channel_agents,
            ] {
                let (status, body) = request(&router, "GET", path, None).await;
                assert_eq!(status, StatusCode::UNAUTHORIZED, "anon {path}: {body}");
                assert_eq!(body, r#"{"error":"unauthorized"}"#, "anon {path}");
            }

            // Admitted workspace member → a real `200` off the live SQLite adapter; the
            // active list and the detail door both carry the seeded conversation id.
            let (status, body) = request(&router, "GET", &workspace_channels, Some(&bearer)).await;
            assert_eq!(status, StatusCode::OK, "active channels: {body}");
            assert!(
                body.contains(CONVERSATION_ID),
                "active list must carry the seeded channel off the real adapter: {body}"
            );

            let (status, body) = request(&router, "GET", &channel_detail, Some(&bearer)).await;
            assert_eq!(status, StatusCode::OK, "channel detail: {body}");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&body).unwrap()["channel"]["id"].as_str(),
                Some(CONVERSATION_ID),
                "detail door must project the seeded channel id: {body}"
            );

            for path in [&workspace_archived, &global_archived, &channel_agents] {
                let (status, body) = request(&router, "GET", path, Some(&bearer)).await;
                assert_eq!(status, StatusCode::OK, "authed {path}: {body}");
            }

            // One-method checksum: the detail path serves GET only.
            let (status, body) = request(&router, "POST", &channel_detail, Some(&bearer)).await;
            assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "{body}");
        }

        /// A spy satisfying all five A1 read ports; every method bumps a shared counter
        /// then diverges. Reaching any of them past the perimeter is a bug, so the bodies
        /// never need to fabricate a success value.
        #[derive(Clone, Default)]
        struct RefusalCountingPort {
            calls: Arc<AtomicUsize>,
        }

        impl ActiveChannelDirectoryPort for RefusalCountingPort {
            type Error = std::convert::Infallible;
            async fn active(
                &self,
                _: &UserId,
                _: &WorkspaceId,
            ) -> Result<
                Result<ActiveWorkspaceChannelDirectory, WorkspaceDirectoryRefusal>,
                Self::Error,
            > {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
        }
        impl ArchivedWorkspaceChannelDirectoryPort for RefusalCountingPort {
            type Error = std::convert::Infallible;
            async fn archived(
                &self,
                _: &UserId,
                _: &WorkspaceId,
            ) -> Result<
                Result<ArchivedWorkspaceChannelDirectory, WorkspaceDirectoryRefusal>,
                Self::Error,
            > {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
        }
        impl GlobalArchivedChannelDirectoryPort for RefusalCountingPort {
            type Error = std::convert::Infallible;
            async fn archived_global(
                &self,
                _: &UserId,
                _: Option<&WorkspaceId>,
                _: Option<ArchivedSince>,
            ) -> Result<
                Result<GlobalArchivedChannelDirectory, GlobalArchivedDirectoryRefusal>,
                Self::Error,
            > {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
        }
        impl ChannelDetailReadPort for RefusalCountingPort {
            type Error = std::convert::Infallible;
            async fn detail(
                &self,
                _: &UserId,
                _: &ConversationId,
            ) -> Result<Result<ChannelDetailFact, ChannelDetailRefusal>, Self::Error> {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
        }
        impl ConversationAgentDirectoryReadPort for RefusalCountingPort {
            type Error = std::convert::Infallible;
            async fn read(
                &self,
                _: &UserId,
                _: &ConversationId,
            ) -> Result<
                Result<ConversationAgentDirectory, ConversationAgentDirectoryRefusal>,
                Self::Error,
            > {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
        }

        #[tokio::test]
        async fn the_channel_perimeter_refuses_before_touching_the_product_port() {
            let fixture = fixture(false).await;
            let session_store = SqliteSessionStore::open(&fixture.path).await.unwrap();
            let sessions = HumanSessionAuthenticator::new(
                session_store,
                SystemSessionClock,
                SessionTtl::default(),
            );
            let spy = RefusalCountingPort::default();
            let calls = spy.calls.clone();
            // The SAME three factories `prepare()` mounts, behind the SAME perimeter.
            let router = require_human_session(
                channel_directory::router(spy.clone())
                    .merge(channel_lifecycle::router(spy.clone()))
                    .merge(conversation_agent_directory::router(spy)),
                sessions,
                PublicJsonUnauthorized,
            );

            for path in [
                format!("/api/workspaces/{WORKSPACE_ID}/channels"),
                format!("/api/workspaces/{WORKSPACE_ID}/channels/archived"),
                "/api/archived-channels".to_owned(),
                format!("/api/channels/{CONVERSATION_ID}"),
                format!("/api/channels/{CONVERSATION_ID}/agents"),
            ] {
                let (status, body) = request(&router, "GET", &path, None).await;
                assert_eq!(status, StatusCode::UNAUTHORIZED, "anon {path}: {body}");
                assert_eq!(body, r#"{"error":"unauthorized"}"#, "anon {path}");
            }

            assert_eq!(
                calls.load(Ordering::SeqCst),
                0,
                "the perimeter must refuse every anonymous read before the product port is touched"
            );
        }
    }

    /// Wave 3A checkpoint A2: the four runtime/activity projection doors, mounted in
    /// `prepare()` behind the SAME human perimeter. Three ride pool-clone `&self` reads
    /// off the ONE production `MessagingStore` (`.conversation_agent_runtime()`,
    /// `.conversation_agent_activity()`, `.activity_read_model()`); the run-state door
    /// additionally joins the SAME live `daemon_runtime` owner already composed for
    /// delivery — cloned, sharing the owner's `Arc<Mutex<..>>` state, never a second
    /// runtime snapshot. Two composition obligations the leaf factories' own tests cannot
    /// prove:
    ///
    /// * `the_composition_serves_runtime_and_activity_behind_the_perimeter` drives every
    ///   one of the four through the real composed root: anonymous → the perimeter's
    ///   `401`; an admitted workspace member (whose committed agent seat is seeded) → a
    ///   real `200` off the live composed authorities. Each door's own success envelope
    ///   (`runtime`/`states`/`events`/`items`) proves the real adapter — not a stub —
    ///   answered, and the run-state door's `200` proves the joined SQLite admission and
    ///   live-owner snapshot both resolved. A one-method checksum pins the feed to GET.
    /// * `the_runtime_activity_perimeter_refuses_before_touching_the_product_port` is the
    ///   load-bearing refusal gate: it mounts the SAME four factories behind the SAME
    ///   `require_human_session` over a counting spy port (which serves the run-state
    ///   door's admission AND owner snapshot), and proves an anonymous read is refused
    ///   `401` with the product port invoked ZERO times — the perimeter `.layer` runs
    ///   before routing, so a handler (and its port call) never executes. A `401` status
    ///   alone cannot prove this; the call counter can.
    mod runtime_activity_activation {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};

        use silverhand_backend_core::{
            auth::{HumanSessionAuthenticator, SessionTtl, SystemSessionClock},
            identity::{AgentId, ConversationId, UserId, WorkspaceId},
            messaging::collaboration::{
                activity::{ActivityList, ActivityReadModel},
                channel_lifecycle::{
                    ChannelDetailFact, ChannelDetailReadPort, ChannelDetailRefusal,
                },
                conversation_agent_activity::{
                    ActivityPageRequest, ConversationAgentActivityPage,
                    ConversationAgentActivityReadPort, ConversationAgentActivityRefusal,
                },
                conversation_agent_runtime::{
                    ConversationAgentRuntimeProjection, ConversationAgentRuntimeReadPort,
                    ConversationAgentRuntimeRefusal,
                },
            },
        };
        use silverhand_backend_server::{
            auth::{PublicJsonUnauthorized, require_human_session},
            messaging::collaboration::{
                activity, conversation_agent_activity, conversation_agent_run_states,
                conversation_agent_run_states::{
                    AgentRunStateProjection, ConversationAgentRunStateSource,
                },
                conversation_agent_runtime,
            },
        };
        use silverhand_backend_sqlite::auth::SqliteSessionStore;

        use super::*;

        const AGENT_ID: &str = "agent-1";

        /// Seed the target agent's committed participation for the conversation
        /// `seed_channel_directory` created: a host, the agent, and its conversation seat.
        /// No live runtime slot and no activity event are seeded, so the run-state,
        /// activity, and feed doors answer an empty projection while the runtime door
        /// projects the committed seat as a single idle row — each the real adapter's
        /// honest answer, none a fabricated fact.
        async fn seed_channel_agent(path: &Path) {
            let pool = SqlitePoolOptions::new()
                .connect(path.to_str().unwrap())
                .await
                .unwrap();
            sqlx::raw_sql(
                "INSERT INTO hosts(id,name,kind,created_at) VALUES ('host-1','host-1','app',1); \
                 INSERT INTO agents(id,name,runtime,host_id,created_at,updated_at,created_by_user_id) \
                   VALUES ('agent-1','agent-1','claude','host-1',1,1,'user-1'); \
                 INSERT INTO conversation_agents(conversation_id,agent_id,joined_at) VALUES \
                   ('conv000000000001','agent-1',1);",
            )
            .execute(&pool)
            .await
            .unwrap();
            pool.close().await;
        }

        #[tokio::test]
        async fn the_composition_serves_runtime_and_activity_behind_the_perimeter() {
            let fixture = fixture(true).await;
            seed_human(&fixture.path).await;
            seed_channel_directory(&fixture.path).await;
            seed_channel_agent(&fixture.path).await;
            let app = prepare(&config(fixture.path.clone())).await.unwrap();
            let router = app.router;
            let bearer = format!("Bearer {TOKEN}");

            let agent_runtime = format!("/api/channels/{CONVERSATION_ID}/agent-runtime");
            let agent_run_states = format!("/api/channels/{CONVERSATION_ID}/agent-run-states");
            let agent_activity =
                format!("/api/conversations/{CONVERSATION_ID}/agents/{AGENT_ID}/activity");
            let activity = "/api/activity".to_owned();

            // Anonymous → the perimeter's refusal envelope on every door, never a read.
            for path in [
                &agent_runtime,
                &agent_run_states,
                &agent_activity,
                &activity,
            ] {
                let (status, body) = request(&router, "GET", path, None).await;
                assert_eq!(status, StatusCode::UNAUTHORIZED, "anon {path}: {body}");
                assert_eq!(body, r#"{"error":"unauthorized"}"#, "anon {path}");
            }

            // Admitted member → a real `200` off the live composed authorities; each
            // door's own success envelope proves the real adapter (not a stub) answered.
            // The committed-roster runtime projection emits an idle row for the seeded
            // agent seat even with no live slot, so a stub could never fabricate it.
            let (status, body) = request(&router, "GET", &agent_runtime, Some(&bearer)).await;
            assert_eq!(status, StatusCode::OK, "agent-runtime: {body}");
            let runtime = serde_json::from_str::<serde_json::Value>(&body).unwrap();
            assert_eq!(
                runtime["runtime"][0]["agent_id"].as_str(),
                Some(AGENT_ID),
                "agent-runtime projects the committed roster off the real SQLite adapter: {body}"
            );
            assert_eq!(
                runtime["runtime"][0]["status"].as_str(),
                Some("idle"),
                "the seeded seat with no live slot projects the idle runtime status: {body}"
            );

            // The run-state door joins two live authorities: SQLite admission (member)
            // and the SAME `daemon_runtime` owner's snapshot (empty in a fresh owner).
            let (status, body) = request(&router, "GET", &agent_run_states, Some(&bearer)).await;
            assert_eq!(status, StatusCode::OK, "agent-run-states: {body}");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&body).unwrap()["states"],
                serde_json::json!([]),
                "agent-run-states rides the live daemon owner snapshot: {body}"
            );

            let (status, body) = request(&router, "GET", &agent_activity, Some(&bearer)).await;
            assert_eq!(status, StatusCode::OK, "agent-activity: {body}");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&body).unwrap()["events"],
                serde_json::json!([]),
                "agent-activity rides the persisted-event SQLite projection: {body}"
            );

            let (status, body) = request(&router, "GET", &activity, Some(&bearer)).await;
            assert_eq!(status, StatusCode::OK, "activity: {body}");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&body).unwrap()["items"],
                serde_json::json!([]),
                "activity rides the viewer Activity cold projection: {body}"
            );

            // One-method checksum: the activity feed path serves GET only.
            let (status, body) = request(&router, "POST", &activity, Some(&bearer)).await;
            assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "{body}");
        }

        /// A spy satisfying the four A2 doors' read ports (the run-state door needs two —
        /// the SQLite admission and the live-owner snapshot); every method bumps a shared
        /// counter then diverges. Reaching any of them past the perimeter is a bug, so the
        /// bodies never need to fabricate a success value.
        #[derive(Clone, Default)]
        struct RuntimeActivityCountingPort {
            calls: Arc<AtomicUsize>,
        }

        impl ConversationAgentRuntimeReadPort for RuntimeActivityCountingPort {
            type Error = std::convert::Infallible;
            async fn read(
                &self,
                _: &UserId,
                _: &ConversationId,
            ) -> Result<
                Result<ConversationAgentRuntimeProjection, ConversationAgentRuntimeRefusal>,
                Self::Error,
            > {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
        }
        impl ChannelDetailReadPort for RuntimeActivityCountingPort {
            type Error = std::convert::Infallible;
            async fn detail(
                &self,
                _: &UserId,
                _: &ConversationId,
            ) -> Result<Result<ChannelDetailFact, ChannelDetailRefusal>, Self::Error> {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
        }
        impl ConversationAgentRunStateSource for RuntimeActivityCountingPort {
            type Error = std::convert::Infallible;
            fn snapshot(
                &self,
                _: &ConversationId,
            ) -> Result<Vec<AgentRunStateProjection>, Self::Error> {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
        }
        impl ConversationAgentActivityReadPort for RuntimeActivityCountingPort {
            type Error = std::convert::Infallible;
            async fn admit(
                &self,
                _: &UserId,
                _: &ConversationId,
                _: &AgentId,
            ) -> Result<Result<(), ConversationAgentActivityRefusal>, Self::Error> {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
            async fn read(
                &self,
                _: &UserId,
                _: &ConversationId,
                _: &AgentId,
                _: ActivityPageRequest,
            ) -> Result<
                Result<ConversationAgentActivityPage, ConversationAgentActivityRefusal>,
                Self::Error,
            > {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
        }
        impl ActivityReadModel for RuntimeActivityCountingPort {
            type Error = std::convert::Infallible;
            async fn list_activity(
                &self,
                _: &UserId,
                _: Option<&WorkspaceId>,
            ) -> Result<ActivityList, Self::Error> {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
        }

        #[tokio::test]
        async fn the_runtime_activity_perimeter_refuses_before_touching_the_product_port() {
            let fixture = fixture(false).await;
            let session_store = SqliteSessionStore::open(&fixture.path).await.unwrap();
            let sessions = HumanSessionAuthenticator::new(
                session_store,
                SystemSessionClock,
                SessionTtl::default(),
            );
            let spy = RuntimeActivityCountingPort::default();
            let calls = spy.calls.clone();
            // The SAME four factories `prepare()` mounts, behind the SAME perimeter. The
            // run-state door takes the spy for BOTH its admission and its owner snapshot.
            let router = require_human_session(
                conversation_agent_runtime::router(spy.clone())
                    .merge(conversation_agent_run_states::router(
                        spy.clone(),
                        spy.clone(),
                    ))
                    .merge(conversation_agent_activity::router(spy.clone()))
                    .merge(activity::router(spy)),
                sessions,
                PublicJsonUnauthorized,
            );

            for path in [
                format!("/api/channels/{CONVERSATION_ID}/agent-runtime"),
                format!("/api/channels/{CONVERSATION_ID}/agent-run-states"),
                format!("/api/conversations/{CONVERSATION_ID}/agents/{AGENT_ID}/activity"),
                "/api/activity".to_owned(),
            ] {
                let (status, body) = request(&router, "GET", &path, None).await;
                assert_eq!(status, StatusCode::UNAUTHORIZED, "anon {path}: {body}");
                assert_eq!(body, r#"{"error":"unauthorized"}"#, "anon {path}");
            }

            assert_eq!(
                calls.load(Ordering::SeqCst),
                0,
                "the perimeter must refuse every anonymous read before the product port is touched"
            );
        }
    }

    /// The five Wave 3A message-navigation and search reads, mounted behind the SAME
    /// `require_human_session` perimeter in the real composed root. Two composition
    /// obligations the leaf factories' own tests cannot prove:
    ///
    /// * `the_composition_serves_message_nav_and_search_behind_the_perimeter` drives all
    ///   five through the real `prepare()`: anonymous → the perimeter's `401`; an admitted
    ///   member → a real `200` off each door's live SQLite adapter, asserted by each door's
    ///   OWN success envelope (`ref`/`mainline`/`threads`/`messages`/`results`). It also
    ///   proves the load-bearing A3 coexistence gate: `GET /api/channels/{id}/messages` and
    ///   the already-mounted `POST` on the SAME path each reach their OWN handler — the POST
    ///   commits a send (201 + its own ACK echoing the content) and the GET then reads that
    ///   live write back through the window projection (200 + a `messages` row carrying the
    ///   just-committed content). Neither shadows nor replaces the other, and neither answer
    ///   could come from a shared fallback: a send ACK has no `messages` array and a window
    ///   read never returns 201.
    /// * `the_message_nav_and_search_perimeter_refuses_before_touching_the_product_port`
    ///   mounts the SAME five factories behind the SAME perimeter over a counting spy and
    ///   proves an anonymous read is refused `401` with every product port invoked ZERO
    ///   times — the `.layer` runs before routing, so no handler (and no port call) executes.
    ///   A `401` status alone cannot prove this; the call counter can.
    mod message_nav_search_activation {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};

        use silverhand_backend_core::{
            auth::{HumanSessionAuthenticator, SessionTtl, SystemSessionClock},
            identity::{ConversationId, UserId},
            messaging::collaboration::{
                conversation_message_window::{
                    ConversationMessageWindow, ConversationMessageWindowReadPort,
                    ConversationMessageWindowRequest, MessageWindowRefusal,
                },
                conversation_ref::{
                    ConversationRefReadPort, ConversationRefRefusal, WorkspaceConversationRef,
                },
                conversation_threads::{
                    ConversationThreadsPage, ConversationThreadsReadPort,
                    ConversationThreadsRefusal, ThreadListQuery,
                },
                conversation_unread::{
                    ConversationUnread, ConversationUnreadReadPort, ConversationUnreadRefusal,
                },
                human_search::{
                    HumanSearchPage, HumanSearchQuery, HumanSearchReadPort, HumanSearchRefusal,
                },
            },
        };
        use silverhand_backend_server::{
            auth::{PublicJsonUnauthorized, require_human_session},
            messaging::collaboration::{
                conversation_message_window, conversation_ref, conversation_threads,
                conversation_unread, human_search,
            },
        };
        use silverhand_backend_sqlite::auth::SqliteSessionStore;

        use super::*;

        #[tokio::test]
        async fn the_composition_serves_message_nav_and_search_behind_the_perimeter() {
            let fixture = fixture(true).await;
            seed_human(&fixture.path).await;
            seed_channel_directory(&fixture.path).await;
            let app = prepare(&config(fixture.path.clone())).await.unwrap();
            let router = app.router;
            let bearer = format!("Bearer {TOKEN}");

            let conversation_ref = format!("/api/conversations/{CONVERSATION_ID}/ref");
            let unread = format!("/api/conversations/{CONVERSATION_ID}/unread");
            let threads = format!("/api/conversations/{CONVERSATION_ID}/threads");
            let messages = format!("/api/channels/{CONVERSATION_ID}/messages");
            let search = "/api/search?q=General".to_owned();

            // Anonymous → the perimeter's refusal envelope on every door, never a read.
            for path in [&conversation_ref, &unread, &threads, &messages, &search] {
                let (status, body) = request(&router, "GET", path, None).await;
                assert_eq!(status, StatusCode::UNAUTHORIZED, "anon GET {path}: {body}");
                assert_eq!(body, r#"{"error":"unauthorized"}"#, "anon GET {path}");
            }
            // The POST on the shared messages path is guarded by the SAME perimeter: an
            // anonymous send is refused before method dispatch, so the coexistence is real
            // on both methods rather than a GET-only mount.
            let (status, body) = request_with_body(
                &router,
                "POST",
                &messages,
                None,
                Body::from(r#"{"content":"anon"}"#),
            )
            .await;
            assert_eq!(
                status,
                StatusCode::UNAUTHORIZED,
                "anon POST messages: {body}"
            );

            // ref → its own `{"ref":{...}}` envelope off the real SQLite adapter.
            let (status, body) = request(&router, "GET", &conversation_ref, Some(&bearer)).await;
            assert_eq!(status, StatusCode::OK, "ref: {body}");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&body).unwrap()["ref"]["id"].as_str(),
                Some(CONVERSATION_ID),
                "ref resolves the seeded conversation off the real adapter: {body}"
            );

            // unread → its own `{"mainline":...}` envelope.
            let (status, body) = request(&router, "GET", &unread, Some(&bearer)).await;
            assert_eq!(status, StatusCode::OK, "unread: {body}");
            assert!(
                serde_json::from_str::<serde_json::Value>(&body)
                    .unwrap()
                    .get("mainline")
                    .is_some(),
                "unread projects its mainline stream off the real adapter: {body}"
            );

            // threads → its own `{"threads":[...]}` envelope (empty page, honestly read).
            let (status, body) = request(&router, "GET", &threads, Some(&bearer)).await;
            assert_eq!(status, StatusCode::OK, "threads: {body}");
            assert!(
                serde_json::from_str::<serde_json::Value>(&body).unwrap()["threads"].is_array(),
                "threads projects its page off the real adapter: {body}"
            );

            // search → its own `{"results":[...]}` envelope.
            let (status, body) = request(&router, "GET", &search, Some(&bearer)).await;
            assert_eq!(status, StatusCode::OK, "search: {body}");
            assert!(
                serde_json::from_str::<serde_json::Value>(&body).unwrap()["results"].is_array(),
                "search projects its result list off the real adapter: {body}"
            );

            // THE COEXISTENCE GATE. Same path, two methods, two handlers, two observables.
            // POST commits a send: 201 and the send ACK, whose `message.content` echoes the
            // request — an answer only the send handler produces.
            let (status, body) = request_with_body(
                &router,
                "POST",
                &messages,
                Some(&bearer),
                Body::from(r#"{"content":"hello A3"}"#),
            )
            .await;
            assert_eq!(status, StatusCode::CREATED, "POST messages: {body}");
            let ack = serde_json::from_str::<serde_json::Value>(&body).unwrap();
            assert_eq!(
                ack["message"]["content"].as_str(),
                Some("hello A3"),
                "the POST entered the send handler and committed the content: {body}"
            );
            assert!(
                ack.get("messages").is_none(),
                "the send ACK is NOT the window envelope — no shared fallback: {body}"
            );

            // GET on the SAME path reads that live write back: 200 and a `messages` array
            // containing the just-committed content — an answer only the window handler
            // produces, and one that proves it read the real committed row, not a stub.
            let (status, body) = request(&router, "GET", &messages, Some(&bearer)).await;
            assert_eq!(status, StatusCode::OK, "GET messages: {body}");
            let window = serde_json::from_str::<serde_json::Value>(&body).unwrap();
            let rows = window["messages"]
                .as_array()
                .expect("the window handler answers with a messages array");
            assert!(
                rows.iter()
                    .any(|row| row["content"].as_str() == Some("hello A3")),
                "the GET entered the window handler and read the committed send back: {body}"
            );
        }

        /// A spy satisfying the five A3 doors' read ports; every method bumps a shared
        /// counter then diverges. Reaching any past the perimeter is a bug, so the bodies
        /// never fabricate a success value.
        #[derive(Clone, Default)]
        struct MessageNavSearchCountingPort {
            calls: Arc<AtomicUsize>,
        }

        impl ConversationRefReadPort for MessageNavSearchCountingPort {
            type Error = std::convert::Infallible;
            async fn resolve(
                &self,
                _: &UserId,
                _: &ConversationId,
            ) -> Result<Result<WorkspaceConversationRef, ConversationRefRefusal>, Self::Error>
            {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
        }
        impl ConversationUnreadReadPort for MessageNavSearchCountingPort {
            type Error = std::convert::Infallible;
            async fn read(
                &self,
                _: &UserId,
                _: &ConversationId,
            ) -> Result<Result<ConversationUnread, ConversationUnreadRefusal>, Self::Error>
            {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
        }
        impl ConversationThreadsReadPort for MessageNavSearchCountingPort {
            type Error = std::convert::Infallible;
            async fn admit(
                &self,
                _: &UserId,
                _: &ConversationId,
            ) -> Result<Result<(), ConversationThreadsRefusal>, Self::Error> {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
            async fn read(
                &self,
                _: &UserId,
                _: &ConversationId,
                _: ThreadListQuery,
            ) -> Result<Result<ConversationThreadsPage, ConversationThreadsRefusal>, Self::Error>
            {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
        }
        impl ConversationMessageWindowReadPort for MessageNavSearchCountingPort {
            type Error = std::convert::Infallible;
            async fn admit(
                &self,
                _: &UserId,
                _: &ConversationId,
            ) -> Result<Result<(), MessageWindowRefusal>, Self::Error> {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
            async fn read(
                &self,
                _: &UserId,
                _: &ConversationId,
                _: ConversationMessageWindowRequest,
            ) -> Result<Result<ConversationMessageWindow, MessageWindowRefusal>, Self::Error>
            {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
        }
        impl HumanSearchReadPort for MessageNavSearchCountingPort {
            type Error = std::convert::Infallible;
            async fn search(
                &self,
                _: &UserId,
                _: HumanSearchQuery,
            ) -> Result<Result<HumanSearchPage, HumanSearchRefusal>, Self::Error> {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
        }

        #[tokio::test]
        async fn the_message_nav_and_search_perimeter_refuses_before_touching_the_product_port() {
            let fixture = fixture(false).await;
            let session_store = SqliteSessionStore::open(&fixture.path).await.unwrap();
            let sessions = HumanSessionAuthenticator::new(
                session_store,
                SystemSessionClock,
                SessionTtl::default(),
            );
            let spy = MessageNavSearchCountingPort::default();
            let calls = spy.calls.clone();
            // The SAME five factories `prepare()` mounts, behind the SAME perimeter.
            let router = require_human_session(
                conversation_ref::router(spy.clone())
                    .merge(conversation_unread::router(spy.clone()))
                    .merge(conversation_threads::router(spy.clone()))
                    .merge(conversation_message_window::router(spy.clone()))
                    .merge(human_search::router(spy)),
                sessions,
                PublicJsonUnauthorized,
            );

            for path in [
                format!("/api/conversations/{CONVERSATION_ID}/ref"),
                format!("/api/conversations/{CONVERSATION_ID}/unread"),
                format!("/api/conversations/{CONVERSATION_ID}/threads"),
                format!("/api/channels/{CONVERSATION_ID}/messages"),
                "/api/search?q=General".to_owned(),
            ] {
                let (status, body) = request(&router, "GET", &path, None).await;
                assert_eq!(status, StatusCode::UNAUTHORIZED, "anon {path}: {body}");
                assert_eq!(body, r#"{"error":"unauthorized"}"#, "anon {path}");
            }

            assert_eq!(
                calls.load(Ordering::SeqCst),
                0,
                "the perimeter must refuse every anonymous read before the product port is touched"
            );
        }
    }

    /// The five Wave 3A unread/attention reads, mounted behind the SAME
    /// `require_human_session` perimeter in the real composed root. Two composition
    /// obligations the leaf factories' own tests cannot prove:
    ///
    /// * `the_composition_serves_unread_and_attention_behind_the_perimeter` drives all five
    ///   through the real `prepare()`: anonymous → the perimeter's `401`; an admitted member
    ///   → a real `200` off each door's live SQLite adapter, asserted by each door's OWN
    ///   success envelope (`by_conversation`/`by_workspace`/`by_workspace`+`muted_workspace_ids`/
    ///   `channels`). A one-method checksum pins the badges door to GET.
    /// * `the_unread_and_attention_perimeter_refuses_before_touching_the_product_port` mounts
    ///   the SAME two factories behind the SAME perimeter over a counting spy implementing all
    ///   four read ports and proves an anonymous read is refused `401` with every product port
    ///   invoked ZERO times — the `.layer` runs before routing. A `401` status alone cannot
    ///   prove this; the call counter can.
    mod unread_attention_activation {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};

        use silverhand_backend_core::{
            auth::{HumanSessionAuthenticator, SessionTtl, SystemSessionClock},
            identity::{ConversationId, UserId, WorkspaceId},
            messaging::collaboration::{
                attention_projection::{
                    AttentionBadgeRollup, AttentionModesRefusal, AttentionProjectionPort,
                    WorkspaceAttentionModes,
                },
                message_unread::{
                    ConversationMessageUnread, ConversationMessageUnreadReadPort,
                    ConversationMessageUnreadRefusal, ViewerMessageUnreadSummary,
                    ViewerMessageUnreadSummaryReadPort, WorkspaceMessageUnread,
                    WorkspaceMessageUnreadReadPort, WorkspaceMessageUnreadRefusal,
                },
            },
        };
        use silverhand_backend_server::{
            auth::{PublicJsonUnauthorized, require_human_session},
            messaging::collaboration::{attention_projection, message_unread},
        };
        use silverhand_backend_sqlite::auth::SqliteSessionStore;

        use super::*;

        #[tokio::test]
        async fn the_composition_serves_unread_and_attention_behind_the_perimeter() {
            let fixture = fixture(true).await;
            seed_human(&fixture.path).await;
            seed_channel_directory(&fixture.path).await;
            let app = prepare(&config(fixture.path.clone())).await.unwrap();
            let router = app.router;
            let bearer = format!("Bearer {TOKEN}");

            let workspace_unread = format!("/api/workspaces/{WORKSPACE_ID}/message-unread");
            let summary = "/api/message-unread-summary".to_owned();
            let conversation_unread = format!("/api/channels/{CONVERSATION_ID}/message-unread");
            let badges = "/api/attention/badges".to_owned();
            let modes = format!("/api/attention/modes?workspace_id={WORKSPACE_ID}");

            // Anonymous → the perimeter's refusal envelope on every door, never a read.
            for path in [
                &workspace_unread,
                &summary,
                &conversation_unread,
                &badges,
                &modes,
            ] {
                let (status, body) = request(&router, "GET", path, None).await;
                assert_eq!(status, StatusCode::UNAUTHORIZED, "anon GET {path}: {body}");
                assert_eq!(body, r#"{"error":"unauthorized"}"#, "anon GET {path}");
            }

            // workspace roll-up → its own `{"by_conversation":..,"total":..}` envelope.
            let (status, body) = request(&router, "GET", &workspace_unread, Some(&bearer)).await;
            assert_eq!(status, StatusCode::OK, "workspace-message-unread: {body}");
            let value = serde_json::from_str::<serde_json::Value>(&body).unwrap();
            assert!(
                value.get("by_conversation").is_some() && value.get("total").is_some(),
                "workspace roll-up projects its own envelope off the real adapter: {body}"
            );

            // viewer summary → its own `{"by_workspace":..}` envelope.
            let (status, body) = request(&router, "GET", &summary, Some(&bearer)).await;
            assert_eq!(status, StatusCode::OK, "message-unread-summary: {body}");
            assert!(
                serde_json::from_str::<serde_json::Value>(&body)
                    .unwrap()
                    .get("by_workspace")
                    .is_some(),
                "viewer summary projects its by_workspace map off the real adapter: {body}"
            );

            // per-conversation roll-up → its own `{"by_conversation":..,"total":..}` envelope.
            let (status, body) = request(&router, "GET", &conversation_unread, Some(&bearer)).await;
            assert_eq!(
                status,
                StatusCode::OK,
                "conversation-message-unread: {body}"
            );
            let value = serde_json::from_str::<serde_json::Value>(&body).unwrap();
            assert!(
                value.get("by_conversation").is_some() && value.get("total").is_some(),
                "per-conversation roll-up projects its own envelope off the real adapter: {body}"
            );

            // attention badges → its own `{"by_workspace":..,"total":..,"muted_workspace_ids":..}`.
            let (status, body) = request(&router, "GET", &badges, Some(&bearer)).await;
            assert_eq!(status, StatusCode::OK, "attention-badges: {body}");
            assert!(
                serde_json::from_str::<serde_json::Value>(&body)
                    .unwrap()
                    .get("muted_workspace_ids")
                    .is_some(),
                "attention badges projects its rollup off the real adapter: {body}"
            );

            // attention modes → its own `{"workspace_id":..,"muted":..,"channels":[..]}`
            // envelope, keyed to the requested workspace.
            let (status, body) = request(&router, "GET", &modes, Some(&bearer)).await;
            assert_eq!(status, StatusCode::OK, "attention-modes: {body}");
            let value = serde_json::from_str::<serde_json::Value>(&body).unwrap();
            assert_eq!(
                value["workspace_id"].as_str(),
                Some(WORKSPACE_ID),
                "attention modes binds its answer to the requested workspace: {body}"
            );
            assert!(
                value["channels"].is_array(),
                "attention modes projects its channel list off the real adapter: {body}"
            );

            // One-method checksum: the badges path serves GET only.
            let (status, body) = request(&router, "POST", &badges, Some(&bearer)).await;
            assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "{body}");
        }

        /// A spy satisfying the five A4 doors' four read ports; every method bumps a shared
        /// counter then diverges. Reaching any past the perimeter is a bug, so the bodies
        /// never fabricate a success value.
        #[derive(Clone, Default)]
        struct UnreadAttentionCountingPort {
            calls: Arc<AtomicUsize>,
        }

        impl WorkspaceMessageUnreadReadPort for UnreadAttentionCountingPort {
            type Error = std::convert::Infallible;
            async fn read_workspace(
                &self,
                _: &UserId,
                _: &WorkspaceId,
            ) -> Result<Result<WorkspaceMessageUnread, WorkspaceMessageUnreadRefusal>, Self::Error>
            {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
        }
        impl ViewerMessageUnreadSummaryReadPort for UnreadAttentionCountingPort {
            type Error = std::convert::Infallible;
            async fn read_summary(
                &self,
                _: &UserId,
            ) -> Result<ViewerMessageUnreadSummary, Self::Error> {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
        }
        impl ConversationMessageUnreadReadPort for UnreadAttentionCountingPort {
            type Error = std::convert::Infallible;
            async fn read_conversation(
                &self,
                _: &UserId,
                _: &ConversationId,
            ) -> Result<
                Result<ConversationMessageUnread, ConversationMessageUnreadRefusal>,
                Self::Error,
            > {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
        }
        impl AttentionProjectionPort for UnreadAttentionCountingPort {
            type Error = std::convert::Infallible;
            async fn badges(&self, _: &UserId) -> Result<AttentionBadgeRollup, Self::Error> {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
            async fn modes(
                &self,
                _: &UserId,
                _: &WorkspaceId,
            ) -> Result<Result<WorkspaceAttentionModes, AttentionModesRefusal>, Self::Error>
            {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
        }

        #[tokio::test]
        async fn the_unread_and_attention_perimeter_refuses_before_touching_the_product_port() {
            let fixture = fixture(false).await;
            let session_store = SqliteSessionStore::open(&fixture.path).await.unwrap();
            let sessions = HumanSessionAuthenticator::new(
                session_store,
                SystemSessionClock,
                SessionTtl::default(),
            );
            let spy = UnreadAttentionCountingPort::default();
            let calls = spy.calls.clone();
            // The SAME two factories `prepare()` mounts, behind the SAME perimeter.
            let router = require_human_session(
                message_unread::router(spy.clone()).merge(attention_projection::router(spy)),
                sessions,
                PublicJsonUnauthorized,
            );

            for path in [
                format!("/api/workspaces/{WORKSPACE_ID}/message-unread"),
                "/api/message-unread-summary".to_owned(),
                format!("/api/channels/{CONVERSATION_ID}/message-unread"),
                "/api/attention/badges".to_owned(),
                format!("/api/attention/modes?workspace_id={WORKSPACE_ID}"),
            ] {
                let (status, body) = request(&router, "GET", &path, None).await;
                assert_eq!(status, StatusCode::UNAUTHORIZED, "anon {path}: {body}");
                assert_eq!(body, r#"{"error":"unauthorized"}"#, "anon {path}");
            }

            assert_eq!(
                calls.load(Ordering::SeqCst),
                0,
                "the perimeter must refuse every anonymous read before the product port is touched"
            );
        }
    }

    /// Wave 3A checkpoint A5: the host-resources read door (`GET /api/hosts/{id}/resources`,
    /// #2198), mounted in `prepare()` behind the SAME human perimeter and wired to its own
    /// by-path `SqliteHostResourcesColdRead` cold-read pool — the sanctioned cold-read
    /// pattern every sibling `*ColdRead` uses, kept distinct from the teardown resource
    /// authority. Two composition obligations the leaf/contract tests cannot prove:
    ///
    /// * `the_composition_serves_host_resources_behind_the_perimeter` drives the door
    ///   through the real composed root: anonymous → the perimeter's `401`; an admitted
    ///   OWNER reads the real seeded agents off the live SQLite adapter in the port's
    ///   `created_at ASC` order with the full `{id,name,display_name,runtime}` projection;
    ///   a REAL other-owned host and an ABSENT host id BOTH collapse to the byte-identical
    ///   owner-scoped `404` (no existence oracle); plus a one-method route checksum.
    /// * `the_host_resources_perimeter_refuses_before_touching_the_product_port` is the
    ///   load-bearing refusal gate: it mounts the SAME factory behind the SAME
    ///   `require_human_session` over a counting spy, and proves an anonymous read is
    ///   refused `401` with the product port invoked ZERO times.
    mod host_resources_activation {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};

        use silverhand_backend_core::{
            auth::{HumanSessionAuthenticator, SessionTtl, SystemSessionClock},
            host_resources_read::{HostResourcesFacts, HostResourcesReadModel},
            identity::HostId,
            persistence::PersistenceFailure,
        };
        use silverhand_backend_server::{
            auth::{PublicJsonUnauthorized, require_human_session},
            host_resources,
        };
        use silverhand_backend_sqlite::auth::SqliteSessionStore;

        use super::*;

        /// One host owned by the admitted viewer (`user-1`, seeded by `seed_human`) with
        /// two agents whose insertion order is the REVERSE of their `created_at`, plus a
        /// SECOND host owned by a different registered user. The reversed stamps let the
        /// composed read prove the adapter's `created_at ASC` order; the foreign host lets
        /// it prove owner-scoping is not an existence oracle.
        async fn seed_host_resources(path: &Path) {
            let pool = SqlitePoolOptions::new()
                .connect(path.to_str().unwrap())
                .await
                .unwrap();
            for statement in [
                "INSERT INTO users (id, name, display_name, created_at, updated_at) VALUES ('user-other', 'other', 'Other', 1, 1)",
                "INSERT INTO hosts (id, name, kind, created_at, user_id) VALUES ('h-res', 'host-res', 'desktop', 1, 'user-1')",
                "INSERT INTO hosts (id, name, kind, created_at, user_id) VALUES ('h-other', 'host-other', 'desktop', 1, 'user-other')",
                "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, display_name, created_by_user_id, materialization_status) \
                 VALUES ('res-late', 'late', 'codex', 'h-res', 3000, 3000, 'Late One', 'user-1', 'failed')",
                "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, display_name, created_by_user_id, materialization_status) \
                 VALUES ('res-early', 'early', 'qoder', 'h-res', 1000, 1000, 'Early One', 'user-1', 'active')",
            ] {
                sqlx::query(statement).execute(&pool).await.unwrap();
            }
            pool.close().await;
        }

        #[tokio::test]
        async fn the_composition_serves_host_resources_behind_the_perimeter() {
            let fixture = fixture(true).await;
            seed_human(&fixture.path).await;
            seed_host_resources(&fixture.path).await;
            let app = prepare(&config(fixture.path.clone())).await.unwrap();
            let router = app.router;
            let bearer = format!("Bearer {TOKEN}");
            let owned = "/api/hosts/h-res/resources";
            let foreign = "/api/hosts/h-other/resources";
            let absent = "/api/hosts/h-absent/resources";

            // Anonymous → the perimeter's refusal envelope, never a resource answer.
            let (status, body) = request(&router, "GET", owned, None).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "anon: {body}");
            assert_eq!(body, r#"{"error":"unauthorized"}"#);

            // Admitted owner → the real adapter's `created_at ASC` set off live SQLite,
            // each agent carrying its full `{id,name,display_name,runtime}` projection.
            let (status, body) = request(&router, "GET", owned, Some(&bearer)).await;
            assert_eq!(status, StatusCode::OK, "owner: {body}");
            let value = serde_json::from_str::<serde_json::Value>(&body).unwrap();
            let agents = value["agents"].as_array().unwrap();
            let ids = agents
                .iter()
                .map(|agent| agent["id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>();
            assert_eq!(
                ids,
                ["res-early", "res-late"],
                "adapter orders by created_at ASC"
            );
            assert_eq!(
                agents[0],
                serde_json::json!({
                    "id": "res-early",
                    "name": "early",
                    "display_name": "Early One",
                    "runtime": "qoder"
                }),
                "the real projection carries every declared field: {body}"
            );

            // Admitted, REAL other-owned host → the owner-scoped 404. A registered user who
            // simply does not own this computer is indistinguishable from asking about one
            // that does not exist, so the surface is never an existence oracle for host ids.
            let (status, foreign_body) = request(&router, "GET", foreign, Some(&bearer)).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "foreign: {foreign_body}");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&foreign_body).unwrap(),
                serde_json::json!({ "error": "host not found", "error_code": "host_not_found" })
            );

            // Admitted, ABSENT host id → the SAME 404 bytes as the other-owned host.
            let (status, absent_body) = request(&router, "GET", absent, Some(&bearer)).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "absent: {absent_body}");
            assert_eq!(
                absent_body, foreign_body,
                "an absent host and someone else's collapse to byte-identical refusals"
            );

            // One-method checksum: the mounted path serves GET only.
            let (status, body) = request(&router, "POST", owned, Some(&bearer)).await;
            assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "{body}");
        }

        /// A spy satisfying the host-resources cold-read port; the single read bumps a
        /// counter then diverges. Reaching it past the perimeter is a bug, so the body
        /// never fabricates a success value.
        #[derive(Clone, Default)]
        struct HostResourcesCountingPort {
            calls: Arc<AtomicUsize>,
        }

        impl HostResourcesReadModel for HostResourcesCountingPort {
            async fn read_host_resources(
                &self,
                _: &HostId,
            ) -> Result<Option<HostResourcesFacts>, PersistenceFailure> {
                self.calls.fetch_add(1, Ordering::SeqCst);
                unreachable!("perimeter must refuse the anonymous read before the product port")
            }
        }

        #[tokio::test]
        async fn the_host_resources_perimeter_refuses_before_touching_the_product_port() {
            let fixture = fixture(false).await;
            let session_store = SqliteSessionStore::open(&fixture.path).await.unwrap();
            let sessions = HumanSessionAuthenticator::new(
                session_store,
                SystemSessionClock,
                SessionTtl::default(),
            );
            let spy = HostResourcesCountingPort::default();
            let calls = spy.calls.clone();
            // The SAME factory `prepare()` mounts, behind the SAME perimeter.
            let router = require_human_session(
                host_resources::router(spy),
                sessions,
                PublicJsonUnauthorized,
            );

            let (status, body) = request(&router, "GET", "/api/hosts/host-1/resources", None).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
            assert_eq!(body, r#"{"error":"unauthorized"}"#);

            assert_eq!(
                calls.load(Ordering::SeqCst),
                0,
                "the perimeter must refuse the anonymous read before the product port is touched"
            );
        }
    }

    /// The composition mounts `GET /api/agents/{id}/presence` behind the SAME human
    /// perimeter, wired to the real SQLite agent-presence cold read and the production
    /// `SystemProcessClock`. Proves the composition obligation the leaf's own tests
    /// cannot: the anonymous perimeter refusal; the anti-enumeration 404 a registered
    /// stranger and an absent id share BYTE-for-byte; a one-method route checksum; AND
    /// an admitted creator reading a real seeded stamp projected off the live SQLite
    /// adapter to the shared away deadline, alongside a live `server_now` bracketed by
    /// the wall clock — proving the mount injected the real production clock, not a
    /// fixture. The per-arm/stage matrix stays with the leaf's own tests.
    #[tokio::test]
    async fn the_composition_serves_agent_presence_behind_the_perimeter() {
        let fixture = fixture(true).await;
        seed_human(&fixture.path).await;
        seed_presence_agents(&fixture.path).await;
        let app = prepare(&config(fixture.path.clone())).await.unwrap();
        let router = app.router;
        let bearer = format!("Bearer {TOKEN}");
        let absent = "/api/agents/agent-absent/presence";

        // Anonymous → the perimeter's refusal envelope, never a presence answer.
        let (status, body) = request(&router, "GET", absent, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(body, r#"{"error":"unauthorized"}"#);

        // Admitted, absent id → the anti-enumeration 404.
        let (status, absent_body) = request(&router, "GET", absent, Some(&bearer)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{absent_body}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&absent_body).unwrap(),
            serde_json::json!({ "error": "agent not found" })
        );

        // Admitted stranger: a REAL row the viewer is in no arm of collapses to the
        // SAME 404 bytes as an absent id, so the mounted surface is never an oracle.
        let (status, stranger_body) = request(
            &router,
            "GET",
            "/api/agents/a-stranger/presence",
            Some(&bearer),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{stranger_body}");
        assert_eq!(stranger_body, absent_body);

        // One-method route checksum: the mounted path serves GET only.
        let (status, body) = request(&router, "POST", absent, Some(&bearer)).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "{body}");

        // Admitted creator: the mounted leaf projects the real seeded stamp off the live
        // SQLite adapter to the shared away deadline (`away_at` is the shared TTL policy
        // applied to 1000, not a literal — drift in adapter or policy fails here), and
        // `server_now` is a live wall-clock stamp from the injected production clock.
        let before = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let (status, body) = request(
            &router,
            "GET",
            "/api/agents/a-presence/presence",
            Some(&bearer),
        )
        .await;
        let after = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert_eq!(status, StatusCode::OK, "{body}");
        let presence = serde_json::from_str::<serde_json::Value>(&body).unwrap();
        assert_eq!(
            presence["away_at"],
            serde_json::json!(1_000 + silverhand_backend_core::policy::agent_presence::AWAY_TTL_MS)
        );
        let server_now = presence["server_now"]
            .as_i64()
            .expect("server_now must be an integer stamp from the injected clock");
        assert!(
            before <= server_now && server_now <= after,
            "server_now {server_now} not bracketed by wall clock [{before}, {after}]"
        );
    }

    /// Read the next JSON frame from a daemon socket, answering server pings so the
    /// connection stays live across the attach handshake (the daemon side of the WS
    /// must keep-alive; a text frame is the command/event the test asserts on).
    async fn next_daemon_json<S>(
        socket: &mut tokio_tungstenite::WebSocketStream<S>,
    ) -> serde_json::Value
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        use futures_util::{SinkExt, StreamExt};
        loop {
            match socket.next().await.unwrap().unwrap() {
                ClientMessage::Text(frame) => return serde_json::from_str(&frame).unwrap(),
                ClientMessage::Ping(payload) => {
                    socket.send(ClientMessage::Pong(payload)).await.unwrap()
                }
                other => panic!("unexpected daemon frame: {other:?}"),
            }
        }
    }

    async fn next_socket_json<S>(
        socket: &mut tokio_tungstenite::WebSocketStream<S>,
    ) -> serde_json::Value
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        use futures_util::StreamExt;
        let tokio_tungstenite::tungstenite::Message::Text(frame) =
            socket.next().await.unwrap().unwrap()
        else {
            panic!("expected a text frame");
        };
        serde_json::from_str(&frame).unwrap()
    }

    /// The presence vertical mounted through the composition root: the `GET
    /// /api/presence` route behind the human perimeter, the event-WS lifecycle feed,
    /// and the single `PresenceGraceTimers` both share. Kept in its own module so it
    /// reuses the parent harness (`fixture`, `seed_human`, `config`, `request`,
    /// `next_socket_json`) without touching its import surface.
    mod presence_composition {
        use silverhand_backend_core::{
            cold_read::presence::{LastSeenAt, UserPresenceFacts},
            identity::UserId,
            persistence::PersistenceFailure,
            policy::presence_grace::PresenceFact,
            user_presence_cold_read::UserPresenceReadModel,
            user_presence_last_seen::LastSeenSink,
        };
        use silverhand_backend_server::{
            host_agent::presence::{self, PRESENCE_PATH},
            host_agent_background::presence_grace_timer::PresenceFactSink,
            scope_events::{ConnectionLifecycle, PresenceConnectionFeed},
        };

        use super::*;

        /// A silent last-seen sink for wiring tests: `on_connect` never touches it, so
        /// the online proof needs no working persistence behind the timers.
        #[derive(Clone)]
        struct SilentLastSeen;

        impl LastSeenSink for SilentLastSeen {
            async fn touch_last_seen(
                &self,
                _user_id: UserId,
                _last_seen_at: LastSeenAt,
            ) -> Result<(), PersistenceFailure> {
                Ok(())
            }
        }

        /// A silent presence-fact sink: the offline wire is exercised by the timer's own
        /// already-PASS'd unit tests, not re-driven here.
        #[derive(Clone)]
        struct SilentFacts;

        impl PresenceFactSink for SilentFacts {
            type Error = std::convert::Infallible;

            fn publish(&self, _fact: PresenceFact) -> Result<(), Self::Error> {
                Ok(())
            }
        }

        /// A cold read that serves a fixed fact set, so a wiring test can assert the
        /// live-liveness join without a real database.
        #[derive(Clone)]
        struct FactsFixture(Vec<UserPresenceFacts>);

        impl UserPresenceReadModel for FactsFixture {
            async fn list_user_presence_facts(
                &self,
            ) -> Result<Vec<UserPresenceFacts>, PersistenceFailure> {
                Ok(self.0.clone())
            }
        }

        /// The `GET /api/presence` auth refusal, signed by the REAL TypeScript
        /// perimeter over the REAL presence route
        /// (packages/backend/tests/presence-auth-refusal-parity.test.ts) and checked in
        /// as the sole artifact both implementations answer to. The refusal belongs to
        /// the perimeter the composition root mounts, not to the presence leaf, which is
        /// why the leaf's whole-wire gate deliberately excludes it — and why this
        /// composition consumes the value rather than self-signing it.
        const PRESENCE_REFUSAL: &str = include_str!(
            "../../../../packages/backend/tests/fixtures/presence/unauthorized/refusal.json"
        );

        /// The refusal fixture's two fields: an exact status and the raw body TEXT, so
        /// the differential is over bytes rather than a re-serialized tree. Both are
        /// required — a fixture missing either would silently weaken the gate, so this
        /// panics rather than defaulting.
        fn presence_refusal() -> (u16, String) {
            let refusal: serde_json::Value = serde_json::from_str(PRESENCE_REFUSAL).unwrap();
            let status = u16::try_from(refusal["status"].as_u64().expect("signed status")).unwrap();
            let body = refusal["body"]
                .as_str()
                .expect("signed body text")
                .to_owned();
            (status, body)
        }

        /// The composition mounts `GET /api/presence` behind the human bearer/session
        /// perimeter (exact anonymous 401, authenticated 200, one route), and a live
        /// event-WS connection flips the viewer to online in the very read the GET
        /// serves — the object-identity singleton observed end to end through the real
        /// composed router, not a leaf handler.
        #[tokio::test]
        async fn the_composition_serves_presence_behind_the_perimeter_and_a_live_connection_reads_online()
         {
            let fixture = fixture(true).await;
            seed_human(&fixture.path).await;
            let app = prepare(&config(fixture.path.clone())).await.unwrap();
            // A clone shares the same Arc-backed presence timers with the served router,
            // so a GET on this handle observes the live connection made against the TCP
            // server below.
            let router = app.router.clone();
            let bearer = format!("Bearer {TOKEN}");

            // Anonymous → the perimeter's exact refusal envelope, never the viewer set.
            // The expected status and body BYTES are not this test's to invent: they are
            // the artifact the real TypeScript perimeter signed
            // (packages/backend/tests/presence-auth-refusal-parity.test.ts), consumed
            // here verbatim. Comparison is over the raw body text, so the two
            // implementations cannot drift on separators or key order.
            let (status, body) = request(&router, "GET", PRESENCE_PATH, None).await;
            let (refused_status, refused_body) = presence_refusal();
            assert_eq!(status.as_u16(), refused_status, "{body}");
            assert_eq!(body, refused_body);

            // Authenticated → 200 with the closed wire shape; no live connection yet, so
            // the viewer is offline with a null stamp (never seen).
            let (status, body) = request(&router, "GET", PRESENCE_PATH, Some(&bearer)).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&body).unwrap(),
                serde_json::json!({
                    "users": [
                        { "user_id": "user-1", "presence": "offline", "last_seen_at": null },
                    ]
                })
            );

            // Route checksum = 1: the path carries exactly one method. An AUTHENTICATED
            // POST clears the perimeter and then meets 405 — one route, one handler
            // entry, no second mount.
            let (status, body) = request(&router, "POST", PRESENCE_PATH, Some(&bearer)).await;
            assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "{body}");

            // A live event-WS connection as user-1. Its lifecycle feeds the single
            // presence timers the GET reads.
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (shutdown_tx, shutdown_rx) = oneshot::channel();
            let running = tokio::spawn(serve(listener, app, async move {
                let _ = shutdown_rx.await;
                Ok::<(), std::io::Error>(())
            }));

            let mut websocket_request = format!("ws://{address}{EVENT_WEBSOCKET_PATH}")
                .into_client_request()
                .unwrap();
            websocket_request
                .headers_mut()
                .insert(ORIGIN, "http://localhost:5173".parse().unwrap());
            websocket_request.headers_mut().insert(
                COOKIE,
                format!("{EVENT_WS_SESSION_COOKIE}={TOKEN}")
                    .parse()
                    .unwrap(),
            );
            websocket_request
                .headers_mut()
                .insert(DESKTOP_API_EPOCH_HEADER, MINIMUM_CLIENT_API_EPOCH.into());
            let (mut socket, _) = connect_async(websocket_request).await.unwrap();
            assert_eq!(next_socket_json(&mut socket).await["type"], "authenticated");

            // The connect mark lands around the authenticated handshake; poll the shared
            // GET until it observes online (bounded, so a broken singleton fails instead
            // of hanging).
            let mut online = false;
            for _ in 0..200 {
                let (status, body) = request(&router, "GET", PRESENCE_PATH, Some(&bearer)).await;
                assert_eq!(status, StatusCode::OK, "{body}");
                let json: serde_json::Value = serde_json::from_str(&body).unwrap();
                if json["users"][0]["presence"] == "online" {
                    assert_eq!(json["users"][0]["last_seen_at"], serde_json::Value::Null);
                    online = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            assert!(
                online,
                "a live event-WS connection must mark the viewer online in the GET the composition shares with it"
            );

            socket.close(None).await.unwrap();
            shutdown_tx.send(()).unwrap();
            running.await.unwrap().unwrap();
        }

        /// The singleton wiring is load-bearing: online only appears when the connect
        /// feed and the presence route read ONE timers instance. The counterexample —
        /// two separate `new()` — stays RED (offline), proving the positive control is
        /// not an accident of two registries agreeing.
        #[tokio::test]
        async fn presence_online_requires_the_feed_and_the_route_to_share_one_timers_instance() {
            let viewer = UserId::parse("user-1").unwrap();
            let cold = FactsFixture(vec![UserPresenceFacts {
                id: viewer.clone(),
                last_seen_at: None,
                created_at: 1,
            }]);

            async fn presence_of(router: &Router, viewer: &UserId) -> String {
                let response = router
                    .clone()
                    .oneshot(
                        Request::get(PRESENCE_PATH)
                            .extension(viewer.clone())
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::OK);
                let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
                let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
                json["users"][0]["presence"].as_str().unwrap().to_owned()
            }

            // Positive control: ONE instance. Its clone feeds the connect lifecycle; the
            // instance itself is the route's OnlineViewers.
            let shared = PresenceGraceTimers::new(
                SilentLastSeen,
                SilentFacts,
                GraceWindow::from_millis_or_default(None),
            );
            let feed = PresenceConnectionFeed::new(shared.clone(), SystemDisconnectClock);
            feed.on_connect(&viewer, "conn-1");
            let shared_router = presence::router(cold.clone(), shared);
            assert_eq!(presence_of(&shared_router, &viewer).await, "online");

            // Counterexample: TWO separate `new()`. The feed marks online in registry A;
            // the route reads registry B, which never saw the connection.
            let feed_registry = PresenceGraceTimers::new(
                SilentLastSeen,
                SilentFacts,
                GraceWindow::from_millis_or_default(None),
            );
            let route_registry = PresenceGraceTimers::new(
                SilentLastSeen,
                SilentFacts,
                GraceWindow::from_millis_or_default(None),
            );
            let split_feed = PresenceConnectionFeed::new(feed_registry, SystemDisconnectClock);
            split_feed.on_connect(&viewer, "conn-1");
            let split_router = presence::router(cold, route_registry);
            assert_eq!(presence_of(&split_router, &viewer).await, "offline");
        }
    }
}
