//! SQLite snapshot and write units for human thread following.

use std::collections::HashSet;

#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

use silverhand_backend_core::{
    identity::{AgentId, ConversationId, UserId},
    messaging::{
        PrincipalIdentity, ThreadRootId,
        collaboration::thread_follow::{
            CommittedHumanFollow, CommittedHumanUnfollow, FollowedAt, HumanFollowRefusal,
            HumanUnfollowRefusal, ThreadFollowPort, ThreadFollowerAgent, ThreadFollowerState,
            ThreadFollowerStateRefusal,
        },
        environment::{EnvironmentUnavailable, SendClock},
    },
    persistence::PersistenceFailure,
};
use sqlx::{Row, Sqlite, SqlitePool, Transaction, sqlite::SqliteRow};
use thiserror::Error;

use crate::messaging::MessagingStore;

use super::conversation_unread::{
    ConversationUnreadStoreError, Placement, decode_placement, participates,
};

#[cfg(test)]
static LIVE_PARTICIPATION_STATEMENTS: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone)]
pub struct SqliteThreadFollow<E> {
    pool: SqlitePool,
    environment: E,
}

impl<E: Clone> MessagingStore<E> {
    pub fn thread_follow(&self) -> SqliteThreadFollow<E> {
        SqliteThreadFollow {
            pool: self.pool.clone(),
            environment: self.environment.clone(),
        }
    }
}

#[derive(Debug, Error)]
pub enum ThreadFollowStoreError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
    #[error("agent follower candidate set could not be encoded")]
    Serialization(#[from] serde_json::Error),
    #[error("conversation access snapshot is malformed")]
    Access(#[from] ConversationUnreadStoreError),
    #[error("stored thread-follow identity is malformed")]
    MalformedIdentity,
    #[error("stored thread follower row has an unknown principal kind or source")]
    MalformedFollower,
    #[error("stored thread follower followed_at is outside its domain")]
    MalformedFollowedAt,
    #[error("stored thread follower set is not in unique total order")]
    MalformedFollowerSet,
    #[error("host clock failed")]
    Environment(#[from] EnvironmentUnavailable),
    #[error("host clock returned a timestamp outside the thread-follow domain")]
    InvalidClock,
}

impl From<ThreadFollowStoreError> for PersistenceFailure {
    fn from(value: ThreadFollowStoreError) -> Self {
        Self::from_source(value)
    }
}

impl<E> ThreadFollowPort for SqliteThreadFollow<E>
where
    E: SendClock + Clone + Send + Sync + 'static,
{
    type Error = PersistenceFailure;

    async fn state(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
        message: &ThreadRootId,
    ) -> Result<Result<ThreadFollowerState, ThreadFollowerStateRefusal>, Self::Error> {
        self.state_inner(viewer, conversation, message)
            .await
            .map_err(PersistenceFailure::from)
    }

    async fn follow(
        &self,
        viewer: UserId,
        conversation: ConversationId,
        message: ThreadRootId,
    ) -> Result<Result<CommittedHumanFollow, HumanFollowRefusal>, Self::Error> {
        self.follow_inner(viewer, conversation, message)
            .await
            .map_err(PersistenceFailure::from)
    }

    async fn unfollow(
        &self,
        viewer: UserId,
        conversation: ConversationId,
        message: ThreadRootId,
    ) -> Result<Result<CommittedHumanUnfollow, HumanUnfollowRefusal>, Self::Error> {
        self.unfollow_inner(viewer, conversation, message)
            .await
            .map_err(PersistenceFailure::from)
    }
}

impl<E> SqliteThreadFollow<E>
where
    E: SendClock + Clone + Send + Sync + 'static,
{
    async fn state_inner(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
        message: &ThreadRootId,
    ) -> Result<Result<ThreadFollowerState, ThreadFollowerStateRefusal>, ThreadFollowStoreError>
    {
        let mut tx = self.pool.begin_with("BEGIN DEFERRED").await?;
        let placement = match access(&mut tx, viewer, conversation).await? {
            Access::NotFound => {
                tx.commit().await?;
                return Ok(Err(ThreadFollowerStateRefusal::ConversationNotFound));
            }
            Access::Forbidden => {
                tx.commit().await?;
                return Ok(Err(ThreadFollowerStateRefusal::Forbidden));
            }
            Access::Allowed(placement) => placement,
        };
        let Some(root) = resolve_root(&mut tx, conversation, message).await? else {
            tx.commit().await?;
            return Ok(Err(ThreadFollowerStateRefusal::RootNotFound));
        };

        let rows = sqlx::query(
            "SELECT thread_root_id,conversation_id,principal_kind,principal_id,followed_at,source \
             FROM thread_followers WHERE thread_root_id=? \
             ORDER BY followed_at ASC,principal_kind ASC,principal_id ASC",
        )
        .bind(root.as_str())
        .fetch_all(&mut *tx)
        .await?;
        // Complete-snapshot safety: no product filtering starts until every
        // selected row has passed the closed persisted-row decoder.
        let decoded = rows
            .iter()
            .map(|row| decode_follower(row, conversation, &root))
            .collect::<Result<Vec<_>, _>>()?;
        let live_agents =
            live_participating_agents(&mut tx, conversation, &placement, &decoded).await?;
        let mut viewer_following = false;
        let mut agents = Vec::new();
        for decoded in decoded {
            match decoded.principal {
                FollowerPrincipal::Human(user) => {
                    if &user == viewer {
                        viewer_following = true;
                    }
                }
                FollowerPrincipal::Agent(agent) => {
                    if live_agents.contains(&agent) {
                        agents.push(ThreadFollowerAgent::projected(
                            decoded.conversation,
                            decoded.root,
                            agent,
                            decoded.followed_at,
                        ));
                    }
                }
            }
        }
        let value = ThreadFollowerState::projected(
            viewer.clone(),
            conversation.clone(),
            message.clone(),
            root,
            viewer_following,
            agents,
        )
        .map_err(|_| ThreadFollowStoreError::MalformedFollowerSet)?;
        tx.commit().await?;
        Ok(Ok(value))
    }

    async fn follow_inner(
        &self,
        viewer: UserId,
        conversation: ConversationId,
        message: ThreadRootId,
    ) -> Result<Result<CommittedHumanFollow, HumanFollowRefusal>, ThreadFollowStoreError> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        match access(&mut tx, &viewer, &conversation).await? {
            Access::NotFound => {
                tx.rollback().await?;
                return Ok(Err(HumanFollowRefusal::ConversationNotFound));
            }
            Access::Forbidden => {
                tx.rollback().await?;
                return Ok(Err(HumanFollowRefusal::Forbidden));
            }
            Access::Allowed(_) => {}
        }
        let Some(root) = resolve_root(&mut tx, &conversation, &message).await? else {
            tx.rollback().await?;
            return Ok(Err(HumanFollowRefusal::RootNotFound));
        };
        let user_exists: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=?)")
            .bind(viewer.as_str())
            .fetch_one(&mut *tx)
            .await?;
        if user_exists != 1 {
            tx.rollback().await?;
            return Err(ThreadFollowStoreError::MalformedIdentity);
        }
        let existing = existing_human(&mut tx, &viewer, &conversation, &root).await?;
        let changed = if existing.is_some() {
            false
        } else {
            let followed_at = FollowedAt::new(self.environment.now_unix_ms()?)
                .map_err(|_| ThreadFollowStoreError::InvalidClock)?;
            sqlx::query(
                "INSERT INTO thread_followers \
                 (thread_root_id,conversation_id,principal_kind,principal_id,followed_at,source) \
                 VALUES(?,?,'human',?,?,'manual') \
                 ON CONFLICT(thread_root_id,principal_kind,principal_id) DO NOTHING",
            )
            .bind(root.as_str())
            .bind(conversation.as_str())
            .bind(viewer.as_str())
            .bind(followed_at.get())
            .execute(&mut *tx)
            .await?
            .rows_affected()
                == 1
        };
        let committed =
            CommittedHumanFollow::committed(viewer, conversation, message, root, changed);
        tx.commit().await?;
        Ok(Ok(committed))
    }

    async fn unfollow_inner(
        &self,
        viewer: UserId,
        conversation: ConversationId,
        message: ThreadRootId,
    ) -> Result<Result<CommittedHumanUnfollow, HumanUnfollowRefusal>, ThreadFollowStoreError> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        match access(&mut tx, &viewer, &conversation).await? {
            Access::NotFound => {
                tx.rollback().await?;
                return Ok(Err(HumanUnfollowRefusal::ConversationNotFound));
            }
            Access::Forbidden => {
                tx.rollback().await?;
                return Ok(Err(HumanUnfollowRefusal::Forbidden));
            }
            Access::Allowed(_) => {}
        }
        let Some(root) = resolve_root(&mut tx, &conversation, &message).await? else {
            tx.rollback().await?;
            return Ok(Err(HumanUnfollowRefusal::RootNotFound));
        };
        let user_exists: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=?)")
            .bind(viewer.as_str())
            .fetch_one(&mut *tx)
            .await?;
        if user_exists != 1 {
            tx.rollback().await?;
            return Err(ThreadFollowStoreError::MalformedIdentity);
        }
        let existing = existing_human(&mut tx, &viewer, &conversation, &root).await?;
        let changed = if existing.is_some() {
            sqlx::query(
                "DELETE FROM thread_followers WHERE thread_root_id=? \
                 AND principal_kind='human' AND principal_id=?",
            )
            .bind(root.as_str())
            .bind(viewer.as_str())
            .execute(&mut *tx)
            .await?
            .rows_affected()
                == 1
        } else {
            false
        };
        let committed =
            CommittedHumanUnfollow::committed(viewer, conversation, message, root, changed);
        tx.commit().await?;
        Ok(Ok(committed))
    }
}

enum Access {
    NotFound,
    Forbidden,
    Allowed(Placement),
}

async fn access(
    tx: &mut Transaction<'_, Sqlite>,
    viewer: &UserId,
    conversation: &ConversationId,
) -> Result<Access, ThreadFollowStoreError> {
    let Some(row) = sqlx::query(
        "SELECT id,workspace_id,placement_kind,roster_policy,title,title_key,status,visibility,\
         endpoint_a_kind,endpoint_a_id,endpoint_a_deleted_at,\
         endpoint_b_kind,endpoint_b_id,endpoint_b_deleted_at \
         FROM conversations WHERE id=?",
    )
    .bind(conversation.as_str())
    .fetch_optional(&mut **tx)
    .await?
    else {
        return Ok(Access::NotFound);
    };
    let stored = ConversationId::parse(row.try_get::<String, _>("id")?)
        .map_err(|_| ThreadFollowStoreError::MalformedIdentity)?;
    if &stored != conversation {
        return Err(ThreadFollowStoreError::MalformedIdentity);
    }
    let placement = decode_placement(&row)?;
    if !participates(tx, viewer, conversation, &placement).await? {
        return Ok(Access::Forbidden);
    }
    Ok(Access::Allowed(placement))
}

async fn resolve_root(
    tx: &mut Transaction<'_, Sqlite>,
    conversation: &ConversationId,
    message: &ThreadRootId,
) -> Result<Option<ThreadRootId>, ThreadFollowStoreError> {
    let Some(row) = sqlx::query(
        "SELECT id,conversation_id,thread_root_id FROM messages WHERE conversation_id=? AND id=?",
    )
    .bind(conversation.as_str())
    .bind(message.as_str())
    .fetch_optional(&mut **tx)
    .await?
    else {
        return Ok(None);
    };
    let id = ThreadRootId::parse(row.try_get::<String, _>("id")?)
        .map_err(|_| ThreadFollowStoreError::MalformedIdentity)?;
    let stored_conversation = ConversationId::parse(row.try_get::<String, _>("conversation_id")?)
        .map_err(|_| ThreadFollowStoreError::MalformedIdentity)?;
    if &stored_conversation != conversation {
        return Err(ThreadFollowStoreError::MalformedIdentity);
    }
    let root = match row.try_get::<Option<String>, _>("thread_root_id")? {
        Some(root) => {
            ThreadRootId::parse(root).map_err(|_| ThreadFollowStoreError::MalformedIdentity)?
        }
        None => id,
    };
    let valid: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM messages WHERE id=? AND conversation_id=? AND thread_root_id IS NULL)",
    )
    .bind(root.as_str())
    .bind(conversation.as_str())
    .fetch_one(&mut **tx)
    .await?;
    if valid != 1 {
        return Err(ThreadFollowStoreError::MalformedIdentity);
    }
    Ok(Some(root))
}

async fn existing_human(
    tx: &mut Transaction<'_, Sqlite>,
    viewer: &UserId,
    conversation: &ConversationId,
    root: &ThreadRootId,
) -> Result<Option<DecodedFollower>, ThreadFollowStoreError> {
    let row = sqlx::query(
        "SELECT thread_root_id,conversation_id,principal_kind,principal_id,followed_at,source \
         FROM thread_followers WHERE thread_root_id=? AND principal_kind='human' AND principal_id=?",
    )
    .bind(root.as_str())
    .bind(viewer.as_str())
    .fetch_optional(&mut **tx)
    .await?;
    row.as_ref()
        .map(|row| decode_follower(row, conversation, root))
        .transpose()
}

struct DecodedFollower {
    conversation: ConversationId,
    root: ThreadRootId,
    principal: FollowerPrincipal,
    followed_at: FollowedAt,
}

enum FollowerPrincipal {
    Human(UserId),
    Agent(AgentId),
}

fn decode_follower(
    row: &SqliteRow,
    conversation: &ConversationId,
    root: &ThreadRootId,
) -> Result<DecodedFollower, ThreadFollowStoreError> {
    let stored_root = ThreadRootId::parse(row.try_get::<String, _>("thread_root_id")?)
        .map_err(|_| ThreadFollowStoreError::MalformedIdentity)?;
    let stored_conversation = ConversationId::parse(row.try_get::<String, _>("conversation_id")?)
        .map_err(|_| ThreadFollowStoreError::MalformedIdentity)?;
    if &stored_root != root || &stored_conversation != conversation {
        return Err(ThreadFollowStoreError::MalformedIdentity);
    }
    let raw_id: String = row.try_get("principal_id")?;
    let principal = match row.try_get::<String, _>("principal_kind")?.as_str() {
        "human" => FollowerPrincipal::Human(
            UserId::parse(raw_id).map_err(|_| ThreadFollowStoreError::MalformedIdentity)?,
        ),
        "agent" => FollowerPrincipal::Agent(
            AgentId::parse(raw_id).map_err(|_| ThreadFollowStoreError::MalformedIdentity)?,
        ),
        _ => return Err(ThreadFollowStoreError::MalformedFollower),
    };
    if !matches!(
        row.try_get::<String, _>("source")?.as_str(),
        "reply" | "mention" | "manual" | "target_author"
    ) {
        return Err(ThreadFollowStoreError::MalformedFollower);
    }
    let followed_at = FollowedAt::new(row.try_get("followed_at")?)
        .map_err(|_| ThreadFollowStoreError::MalformedFollowedAt)?;
    Ok(DecodedFollower {
        conversation: stored_conversation,
        root: stored_root,
        principal,
        followed_at,
    })
}

async fn live_participating_agents(
    tx: &mut Transaction<'_, Sqlite>,
    conversation: &ConversationId,
    placement: &Placement,
    candidates: &[DecodedFollower],
) -> Result<HashSet<AgentId>, ThreadFollowStoreError> {
    // This is deliberately one set-shaped statement per placement arm.  The
    // number of selected follower candidates changes only the JSON parameter,
    // never the number of authority reads performed in this snapshot.
    let candidate_ids = candidates
        .iter()
        .filter_map(|candidate| match &candidate.principal {
            FollowerPrincipal::Agent(agent) => Some(agent.as_str()),
            FollowerPrincipal::Human(_) => None,
        })
        .collect::<Vec<_>>();
    if candidate_ids.is_empty() {
        return Ok(HashSet::new());
    }
    let encoded = serde_json::to_string(&candidate_ids)?;
    let rows = match placement {
        Placement::Workspace(_) => workspace_live_agent_rows(tx, conversation, &encoded).await?,
        Placement::DirectPair(a, b) => {
            let endpoint_ids = [a, b]
                .into_iter()
                .filter_map(|endpoint| match endpoint {
                    PrincipalIdentity::Agent(agent) => Some(agent.as_str()),
                    PrincipalIdentity::Human(_) => None,
                })
                .collect::<Vec<_>>();
            let endpoints = serde_json::to_string(&endpoint_ids)?;
            direct_pair_live_agent_rows(tx, &encoded, &endpoints).await?
        }
    };
    rows.into_iter()
        .map(|row| {
            AgentId::parse(row.try_get::<String, _>("id")?)
                .map_err(|_| ThreadFollowStoreError::MalformedIdentity)
        })
        .collect()
}

async fn workspace_live_agent_rows(
    tx: &mut Transaction<'_, Sqlite>,
    conversation: &ConversationId,
    candidates: &str,
) -> Result<Vec<SqliteRow>, sqlx::Error> {
    #[cfg(test)]
    LIVE_PARTICIPATION_STATEMENTS.fetch_add(1, Ordering::SeqCst);
    sqlx::query(
        "SELECT a.id FROM json_each(?) candidate \
         JOIN agents a ON a.id=candidate.value \
         JOIN conversation_agents ca ON ca.agent_id=a.id AND ca.conversation_id=? \
         ORDER BY a.id ASC",
    )
    .bind(candidates)
    .bind(conversation.as_str())
    .fetch_all(&mut **tx)
    .await
}

async fn direct_pair_live_agent_rows(
    tx: &mut Transaction<'_, Sqlite>,
    candidates: &str,
    endpoints: &str,
) -> Result<Vec<SqliteRow>, sqlx::Error> {
    #[cfg(test)]
    LIVE_PARTICIPATION_STATEMENTS.fetch_add(1, Ordering::SeqCst);
    sqlx::query(
        "SELECT a.id FROM json_each(?) candidate \
         JOIN agents a ON a.id=candidate.value \
         WHERE a.id IN (SELECT value FROM json_each(?)) ORDER BY a.id ASC",
    )
    .bind(candidates)
    .bind(endpoints)
    .fetch_all(&mut **tx)
    .await
}

#[cfg(test)]
mod tests {
    use silverhand_backend_core::identity::WorkspaceId;
    use sqlx::{Connection, Executor, SqliteConnection, sqlite::SqliteConnectOptions};

    use super::*;

    #[tokio::test]
    async fn candidate_cardinality_does_not_change_the_number_of_participation_statements() {
        const SCHEMA: &str = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/backend/tests/migration-baseline/schema-current.sql"
        ));
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("thread-follow-set-authority.sqlite");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let mut db = SqliteConnection::connect_with(&options).await.unwrap();
        db.execute(sqlx::raw_sql(SCHEMA)).await.unwrap();
        db.execute(sqlx::raw_sql(
            "INSERT INTO users(id,name,display_name,created_at,updated_at) \
             VALUES('local','local-thread-follow-set','Local',1,1); \
             INSERT INTO hosts(id,name,kind,created_at) VALUES('host','Host','local',1); \
             INSERT INTO workspaces(id,name,name_key,created_at,updated_at) \
             VALUES('w','Workspace','thread-follow-set',1,1); \
             INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,title,title_key,status,visibility,created_at,updated_at) \
             VALUES('c','w','workspace','open','General','thread-follow-set','idle','private',1,1);",
        ))
        .await
        .unwrap();
        let mut candidates = Vec::new();
        for ordinal in 0..32_i64 {
            let id = format!("agent-{ordinal:02}");
            let name = format!("thread-follow-set-{ordinal:02}");
            sqlx::query(
                "INSERT INTO agents(id,name,runtime,host_id,created_at,updated_at,created_by_user_id) \
                 VALUES(?,?,'claude','host',1,1,'local')",
            )
            .bind(&id)
            .bind(name)
            .execute(&mut db)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO conversation_agents(conversation_id,agent_id,joined_at) VALUES('c',?,1)",
            )
            .bind(&id)
            .execute(&mut db)
            .await
            .unwrap();
            candidates.push(DecodedFollower {
                conversation: ConversationId::parse("c").unwrap(),
                root: ThreadRootId::parse("root").unwrap(),
                principal: FollowerPrincipal::Agent(AgentId::parse(id).unwrap()),
                followed_at: FollowedAt::new(ordinal).unwrap(),
            });
        }
        db.close().await.unwrap();

        let store = MessagingStore::open(path).await.unwrap();
        let mut tx = store.pool.begin_with("BEGIN DEFERRED").await.unwrap();
        LIVE_PARTICIPATION_STATEMENTS.store(0, Ordering::SeqCst);
        let live = live_participating_agents(
            &mut tx,
            &ConversationId::parse("c").unwrap(),
            &Placement::Workspace(WorkspaceId::parse("w").unwrap()),
            &candidates,
        )
        .await
        .unwrap();
        assert_eq!(live.len(), 32);
        assert_eq!(LIVE_PARTICIPATION_STATEMENTS.load(Ordering::SeqCst), 1);
        tx.commit().await.unwrap();
    }
}
