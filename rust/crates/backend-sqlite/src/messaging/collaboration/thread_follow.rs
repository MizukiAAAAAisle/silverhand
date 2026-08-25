//! SQLite snapshot and write units for human thread following.

use silverhand_backend_core::{
    identity::{AgentId, ConversationId, UserId},
    messaging::{
        ThreadRootId,
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
        let mut viewer_following = false;
        let mut agents = Vec::new();
        for row in rows {
            let decoded = decode_follower(&row, conversation, &root)?;
            match decoded.principal {
                FollowerPrincipal::Human(user) => {
                    if &user == viewer {
                        viewer_following = true;
                    }
                }
                FollowerPrincipal::Agent(agent) => {
                    if agent_participates(&mut tx, conversation, &placement, &agent).await? {
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
        let changed = if user_exists == 1 {
            let followed_at = FollowedAt::new(self.environment.now_unix_ms()?)
                .map_err(|_| ThreadFollowStoreError::InvalidClock)?;
            sqlx::query(
                "INSERT OR IGNORE INTO thread_followers \
                 (thread_root_id,conversation_id,principal_kind,principal_id,followed_at,source) \
                 VALUES(?,?,'human',?,?,'manual')",
            )
            .bind(root.as_str())
            .bind(conversation.as_str())
            .bind(viewer.as_str())
            .bind(followed_at.get())
            .execute(&mut *tx)
            .await?
            .rows_affected()
                == 1
        } else {
            false
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
        let changed = sqlx::query(
            "DELETE FROM thread_followers WHERE thread_root_id=? AND conversation_id=? \
             AND principal_kind='human' AND principal_id=?",
        )
        .bind(root.as_str())
        .bind(conversation.as_str())
        .bind(viewer.as_str())
        .execute(&mut *tx)
        .await?
        .rows_affected()
            == 1;
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

async fn agent_participates(
    tx: &mut Transaction<'_, Sqlite>,
    conversation: &ConversationId,
    placement: &Placement,
    agent: &AgentId,
) -> Result<bool, ThreadFollowStoreError> {
    let live: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agents WHERE id=?)")
        .bind(agent.as_str())
        .fetch_one(&mut **tx)
        .await?;
    if live != 1 {
        return Ok(false);
    }
    match placement {
        Placement::Workspace(_) => {
            let seated: i64 = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM conversation_agents WHERE conversation_id=? AND agent_id=?)",
            )
            .bind(conversation.as_str())
            .bind(agent.as_str())
            .fetch_one(&mut **tx)
            .await?;
            Ok(seated == 1)
        }
        Placement::DirectPair(a, b) => Ok([a, b].into_iter().any(|endpoint| {
            matches!(endpoint, silverhand_backend_core::messaging::PrincipalIdentity::Agent(id) if id == agent)
        })),
    }
}
