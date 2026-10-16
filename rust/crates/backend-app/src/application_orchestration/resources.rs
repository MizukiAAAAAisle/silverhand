use crate::*;

pub(super) struct HostRuntimeResources {
    pub(super) host_store: SqliteHostRuntimeStore,
    pub(super) host_agent_store: SqliteHostAgentStore,
    pub(super) computer_agents_read: SqliteComputerAgentsRead,
    pub(super) custody_store: SqliteRuntimeCustodyStore,
    pub(super) delivery_store: SqliteRuntimeDeliveryStore,
    pub(super) host_resources_cold_read: SqliteHostResourcesColdRead,
    pub(super) agent_runtime_state_cold_read: SqliteAgentRuntimeStateColdRead,
}

pub(super) struct MessagingResources {
    pub(super) store: MessagingStore,
    pub(super) task_store: SqliteTaskStore,
    pub(super) task_status_write: SqliteTaskStatusWrite,
    pub(super) task_claim_write: SqliteTaskClaimWrite,
    pub(super) task_edit_write: SqliteTaskEditWrite,
    pub(super) task_create_write: SqliteTaskCreateWrite,
    pub(super) scope_authority: SqliteEventScopeAuthority,
    pub(super) unread_read_model: SqliteUnreadReadModel,
    pub(super) direct_pair_read_model: SqliteDirectPairReadModel,
}

pub(super) struct WorkspaceIdentityResources {
    pub(super) access_store: SqliteAccessStore,
    pub(super) workspace_cold_read: SqliteWorkspaceColdRead,
    pub(super) detail_read: SqliteWorkspaceDetailRead,
    pub(super) metadata_writes: SqliteWorkspaceMetadataWrite,
    pub(super) namespace: SqliteRegularWorkspaceNamespace,
    pub(super) audience_read: SqliteWorkspaceAudienceRead,
}

pub(super) struct AgentIdentityResources {
    pub(super) availability_cold_read: SqliteAgentAvailabilityColdRead,
    pub(super) detail_cold_read: SqliteAgentDetailColdRead,
    pub(super) list_cold_read: SqliteAgentListColdRead,
    pub(super) presence_cold_read: SqliteAgentPresenceColdRead,
    pub(super) profile_write: SqliteAgentProfileWrite,
    pub(super) avatar_read: SqliteAgentAvatarRead,
    pub(super) avatar_design_read: SqliteAvatarDesignRead,
    pub(super) profile_read: SqliteAgentProfileRead,
    pub(super) audit_read: SqliteAgentAuditRead,
}

pub(super) struct HumanIdentityResources {
    pub(super) session_store: SqliteSessionStore,
    pub(super) handle_namespace: SqliteHandleNamespace,
    pub(super) user_store: SqliteUserStore,
    pub(super) registration: SqliteHumanRegistration,
    pub(super) credential_store: SqliteCredentialStore,
}

pub(super) struct PresenceResources {
    pub(super) cold_read: SqliteUserPresenceColdRead,
    pub(super) last_seen_sink: SqliteLastSeenSink,
}

pub(super) struct SchedulingResources {
    pub(super) create: SqliteScheduleCreate,
    pub(super) driver: SqliteScheduleStore,
    pub(super) list_read: SqliteScheduleListRead,
    pub(super) cancel: SqliteScheduleCancel,
}

pub(super) struct WorkspaceDataPlaneResources {
    pub(super) scope_store: SqliteWorkspaceScopeStore,
}

pub(super) struct EmbeddedBootstrapResources {
    pub(super) store: SqliteEmbeddedBootstrap,
}

/// Every resource acquired before the two audit writer tasks start. The outer bundle is
/// an ownership boundary only; its fields remain grouped by their real context owners.
pub(super) struct PassiveResources {
    pub(super) boot: BootProgress,
    pub(super) host_runtime: HostRuntimeResources,
    pub(super) messaging: MessagingResources,
    pub(super) workspace_identity: WorkspaceIdentityResources,
    pub(super) agent_identity: AgentIdentityResources,
    pub(super) human_identity: HumanIdentityResources,
    pub(super) presence: PresenceResources,
    pub(super) scheduling: SchedulingResources,
    pub(super) workspace_data_plane: WorkspaceDataPlaneResources,
    pub(super) embedded_bootstrap: EmbeddedBootstrapResources,
    pub(super) blob_store: LocalBlobStore,
}

impl PassiveResources {
    pub(super) async fn open(config: &AppConfig) -> Result<Self, StartupError> {
        super::startup_protocol::emit_preparation_phase(config.startup_generation(), false)?;
        let preparation =
            silverhand_backend_sqlite::foundation::database_startup::prepare_database(
                &config.database_path,
                config.allow_schema_upgrade,
            )
            .await
            .map_err(StartupError::DatabasePreparation)?;
        super::startup_protocol::emit_preparation_phase(config.startup_generation(), true)?;
        tracing::info!(
            before_step = preparation.before_step,
            after_step = preparation.after_step,
            applied_steps = ?preparation.applied_steps,
            backup_path = ?preparation.backup_path,
            "database startup preparation completed"
        );
        let boot = BootProgress::new();
        boot.mark_migrations_applied();

        let host_store = open(
            "host runtime",
            SqliteHostRuntimeStore::open(&config.database_path),
        )
        .await?;
        let host_agent_store = open(
            "host agent teardown",
            SqliteHostAgentStore::open(&config.database_path),
        )
        .await?;
        let computer_agents_read = open(
            "computer agents read",
            SqliteComputerAgentsRead::open(&config.database_path),
        )
        .await?;
        let session_store = open(
            "human session",
            SqliteSessionStore::open(&config.database_path),
        )
        .await?;
        let messaging_store =
            open("messaging", MessagingStore::open(&config.database_path)).await?;
        let task_store = open("task board", SqliteTaskStore::open(&config.database_path)).await?;
        let task_status_write = open(
            "task status write",
            SqliteTaskStatusWrite::open(&config.database_path),
        )
        .await?;
        let task_claim_write = open(
            "task claim write",
            SqliteTaskClaimWrite::open(&config.database_path),
        )
        .await?;
        let task_edit_write = open(
            "task edit write",
            SqliteTaskEditWrite::open(&config.database_path),
        )
        .await?;
        let task_create_write = open(
            "task create write",
            SqliteTaskCreateWrite::open(&config.database_path),
        )
        .await?;
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
        let availability_cold_read = open(
            "agent availability cold read",
            SqliteAgentAvailabilityColdRead::open(&config.database_path),
        )
        .await?;
        let detail_cold_read = open(
            "agent detail cold read",
            SqliteAgentDetailColdRead::open(&config.database_path),
        )
        .await?;
        let list_cold_read = open(
            "agent list cold read",
            SqliteAgentListColdRead::open(&config.database_path),
        )
        .await?;
        let agent_presence_cold_read = open(
            "agent presence cold read",
            SqliteAgentPresenceColdRead::open(&config.database_path),
        )
        .await?;
        let profile_write = open(
            "agent profile write",
            SqliteAgentProfileWrite::open(&config.database_path),
        )
        .await?;
        let avatar_read = open(
            "agent avatar read",
            SqliteAgentAvatarRead::open(&config.database_path),
        )
        .await?;
        let avatar_design_read = open(
            "avatar design read",
            SqliteAvatarDesignRead::open(&config.database_path),
        )
        .await?;
        let profile_read = open(
            "agent profile read",
            SqliteAgentProfileRead::open(&config.database_path),
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
        let host_resources_cold_read = open(
            "host resources cold read",
            SqliteHostResourcesColdRead::open(&config.database_path),
        )
        .await?;
        let detail_read = open(
            "workspace detail read",
            SqliteWorkspaceDetailRead::open(&config.database_path),
        )
        .await?;
        let metadata_writes = open(
            "workspace metadata write",
            SqliteWorkspaceMetadataWrite::open(&config.database_path),
        )
        .await?;
        let namespace = open(
            "workspace name availability",
            SqliteRegularWorkspaceNamespace::open(&config.database_path),
        )
        .await?;
        let audience_read = open(
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
        let registration = open(
            "human registration",
            SqliteHumanRegistration::open(&config.database_path),
        )
        .await?;
        let credential_store = open(
            "login credential",
            SqliteCredentialStore::open(&config.database_path),
        )
        .await?;
        let blob_store = open("blob store", LocalBlobStore::open(&config.blobs_root)).await?;
        let agent_runtime_state_cold_read = open(
            "agent runtime-state cold read",
            SqliteAgentRuntimeStateColdRead::open(&config.database_path),
        )
        .await?;
        let agent_audit_read = open(
            "agent-chat audit read",
            SqliteAgentAuditRead::open(&config.database_path),
        )
        .await?;
        let schedule_create = open(
            "agent schedule create",
            SqliteScheduleCreate::open(&config.database_path),
        )
        .await?;
        let schedule_driver = open(
            "schedule fire driver",
            SqliteScheduleStore::open(&config.database_path),
        )
        .await?;
        let schedule_list_read = open(
            "agent schedule list read",
            SqliteScheduleListRead::open(&config.database_path),
        )
        .await?;
        let schedule_cancel = open(
            "agent schedule cancel",
            SqliteScheduleCancel::open(&config.database_path),
        )
        .await?;
        let workspace_scope_store = open(
            "agent workspace scope read",
            SqliteWorkspaceScopeStore::open(&config.database_path),
        )
        .await?;
        let embedded_bootstrap_store = open(
            "embedded bootstrap unit of work",
            SqliteEmbeddedBootstrap::open(&config.database_path),
        )
        .await?;

        Ok(Self {
            boot,
            host_runtime: HostRuntimeResources {
                host_store,
                host_agent_store,
                computer_agents_read,
                custody_store,
                delivery_store,
                host_resources_cold_read,
                agent_runtime_state_cold_read,
            },
            messaging: MessagingResources {
                store: messaging_store,
                task_store,
                task_status_write,
                task_claim_write,
                task_edit_write,
                task_create_write,
                scope_authority,
                unread_read_model,
                direct_pair_read_model,
            },
            workspace_identity: WorkspaceIdentityResources {
                access_store,
                workspace_cold_read,
                detail_read,
                metadata_writes,
                namespace,
                audience_read,
            },
            agent_identity: AgentIdentityResources {
                availability_cold_read,
                detail_cold_read,
                list_cold_read,
                presence_cold_read: agent_presence_cold_read,
                profile_write,
                avatar_read,
                avatar_design_read,
                profile_read,
                audit_read: agent_audit_read,
            },
            human_identity: HumanIdentityResources {
                session_store,
                handle_namespace,
                user_store,
                registration,
                credential_store,
            },
            presence: PresenceResources {
                cold_read: presence_cold_read,
                last_seen_sink,
            },
            scheduling: SchedulingResources {
                create: schedule_create,
                driver: schedule_driver,
                list_read: schedule_list_read,
                cancel: schedule_cancel,
            },
            workspace_data_plane: WorkspaceDataPlaneResources {
                scope_store: workspace_scope_store,
            },
            embedded_bootstrap: EmbeddedBootstrapResources {
                store: embedded_bootstrap_store,
            },
            blob_store,
        })
    }
}
