//! Reaction detail and message-window aggregate read models.

use silverhand_backend_core::{
    conversation_messaging::messaging::collaboration::reaction::{
        ReactionAggregate, ReactionDetail, ReactionEmoji, ReactionReactor, ReactionReadPort,
        ReactionReadRefusal, Reactor,
    },
    conversation_messaging::messaging::{MessageId, PrincipalIdentity},
    foundation::identity::UserId,
};
use sqlx::{QueryBuilder, Row, Sqlite, SqliteConnection, Transaction};

use super::{
    ConversationFacts, ReactionStoreError, SqliteReactionStore, conversation_facts, message_facts,
};

impl ReactionReadPort for SqliteReactionStore {
    type Error = ReactionStoreError;

    async fn detail(
        &self,
        viewer: &UserId,
        message: &MessageId,
    ) -> Result<Result<Vec<ReactionDetail>, ReactionReadRefusal>, Self::Error> {
        let mut tx = self.pool.begin_with("BEGIN DEFERRED").await?;
        let Some(message_facts) = message_facts(&mut tx, message).await? else {
            tx.rollback().await?;
            return Ok(Err(ReactionReadRefusal));
        };
        let Some(conversation) = conversation_facts(&mut tx, &message_facts.conversation).await?
        else {
            tx.rollback().await?;
            return Ok(Err(ReactionReadRefusal));
        };
        if !may_view_human(&mut tx, viewer, &message_facts.conversation, &conversation).await? {
            tx.rollback().await?;
            return Ok(Err(ReactionReadRefusal));
        }
        let rows = sqlx::query(
            "SELECT mr.emoji, mr.reactor_kind, mr.reactor_id, \
             COALESCE(NULLIF(u.display_name, ''), u.name, NULLIF(a.display_name, ''), a.name, mr.reactor_id) AS display_name, \
             MIN(mr.created_at) OVER (PARTITION BY mr.emoji) AS emoji_first_at, mr.created_at \
             FROM message_reactions mr \
             LEFT JOIN users u ON mr.reactor_kind = 'user' AND u.id = mr.reactor_id \
             LEFT JOIN agents a ON mr.reactor_kind = 'agent' AND a.id = mr.reactor_id \
             WHERE mr.message_id = ? ORDER BY emoji_first_at, mr.emoji, mr.created_at",
        ).bind(message.as_str()).fetch_all(&mut *tx).await?;
        let mut out: Vec<ReactionDetail> = Vec::new();
        for row in rows {
            let emoji = ReactionEmoji::parse(&row.try_get::<String, _>("emoji")?)
                .map_err(|_| ReactionStoreError::MalformedEmoji)?;
            let reactor = decode_reactor(row.try_get("reactor_kind")?, row.try_get("reactor_id")?)?;
            let projected = ReactionReactor::projected(reactor, row.try_get("display_name")?);
            if let Some(last) = out.last_mut().filter(|detail| detail.emoji() == &emoji) {
                let mut reactors = last.reactors().to_vec();
                reactors.push(projected);
                *last = ReactionDetail::projected(emoji, reactors);
            } else {
                out.push(ReactionDetail::projected(emoji, vec![projected]));
            }
        }
        tx.commit().await?;
        Ok(Ok(out))
    }

    async fn aggregates(
        &self,
        viewer: &Reactor,
        messages: &[MessageId],
    ) -> Result<Vec<(MessageId, Vec<ReactionAggregate>)>, Self::Error> {
        if messages.is_empty() {
            return Ok(Vec::new());
        }
        let mut connection = self.pool.acquire().await?;
        let facts = aggregate_facts_in_snapshot(&mut connection, Some(viewer), messages).await?;
        let mut out: Vec<(MessageId, Vec<ReactionAggregate>)> = Vec::new();
        for fact in facts {
            if let Some((_, list)) = out.last_mut().filter(|(id, _)| id == &fact.message) {
                list.push(fact.aggregate);
            } else {
                out.push((fact.message, vec![fact.aggregate]));
            }
        }
        Ok(out)
    }
}

/// One row from the single reaction-aggregate authority. Message-window reads
/// also need the first-reaction timestamp for their stable wire order, so the
/// adapter retains it here rather than reconstructing a second aggregate SQL.
pub(in crate::messaging::collaboration) struct ReactionAggregateFact {
    pub(in crate::messaging::collaboration) message: MessageId,
    pub(in crate::messaging::collaboration) aggregate: ReactionAggregate,
    pub(in crate::messaging::collaboration) first_created_at: i64,
}

pub(in crate::messaging::collaboration) async fn aggregate_facts_in_snapshot(
    connection: &mut SqliteConnection,
    viewer: Option<&Reactor>,
    messages: &[MessageId],
) -> Result<Vec<ReactionAggregateFact>, ReactionStoreError> {
    if messages.is_empty() {
        return Ok(Vec::new());
    }
    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT message_id, emoji, COUNT(*) AS count, MAX(CASE WHEN reactor_kind = ",
    );
    builder
            .push_bind(viewer.map_or("", Reactor::kind))
            .push(" AND reactor_id = ")
            .push_bind(viewer.map_or("", Reactor::id))
            .push(" THEN 1 ELSE 0 END) AS viewer_reacted, MIN(created_at) AS first_created_at FROM message_reactions WHERE message_id IN (");
    let mut separated = builder.separated(", ");
    for message in messages {
        separated.push_bind(message.as_str());
    }
    separated.push_unseparated(
        ") GROUP BY message_id, emoji ORDER BY message_id, MIN(created_at), emoji",
    );
    let rows = builder.build().fetch_all(&mut *connection).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let message = MessageId::parse(row.try_get::<String, _>("message_id")?)
            .map_err(|_| ReactionStoreError::MalformedIdentity)?;
        let emoji = ReactionEmoji::parse(&row.try_get::<String, _>("emoji")?)
            .map_err(|_| ReactionStoreError::MalformedEmoji)?;
        let count =
            silverhand_backend_core::conversation_messaging::messaging::collaboration::reaction::ReactionCount::new(
                row.try_get("count")?,
            )
            .map_err(|_| ReactionStoreError::InvalidCount)?;
        if count.value() == 0 {
            return Err(ReactionStoreError::InvalidCount);
        }
        let aggregate = ReactionAggregate::projected(
            emoji,
            count,
            row.try_get::<i64, _>("viewer_reacted")? == 1,
        );
        out.push(ReactionAggregateFact {
            message,
            aggregate,
            first_created_at: row.try_get("first_created_at")?,
        });
    }
    Ok(out)
}

async fn may_view_human(
    tx: &mut Transaction<'_, Sqlite>,
    viewer: &UserId,
    conversation: &silverhand_backend_core::foundation::identity::ConversationId,
    facts: &ConversationFacts,
) -> Result<bool, ReactionStoreError> {
    match facts.placement.as_str() {
        "workspace" => {
            let workspace = facts
                .workspace
                .as_deref()
                .filter(|id| !id.is_empty())
                .ok_or(ReactionStoreError::InvalidConversationPlacement)?;
            let allowed: i64 = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?) \
                 AND EXISTS(SELECT 1 FROM conversation_users WHERE conversation_id = ? AND user_id = ?)",
            ).bind(workspace).bind(viewer.as_str()).bind(conversation.as_str()).bind(viewer.as_str())
            .fetch_one(&mut **tx).await?;
            Ok(allowed != 0)
        }
        "direct_pair" => Ok([facts.endpoint_a.as_ref(), facts.endpoint_b.as_ref()]
            .into_iter()
            .flatten()
            .any(|endpoint| matches!(&endpoint.principal, PrincipalIdentity::Human(id) if id == viewer))),
        _ => Err(ReactionStoreError::InvalidConversationPlacement),
    }
}

fn decode_reactor(kind: String, id: String) -> Result<Reactor, ReactionStoreError> {
    if id.is_empty() {
        return Err(ReactionStoreError::MalformedIdentity);
    }
    match kind.as_str() {
        "user" => Ok(Reactor::Human(
            UserId::parse(id).map_err(|_| ReactionStoreError::MalformedIdentity)?,
        )),
        "agent" => Ok(Reactor::Agent(
            silverhand_backend_core::foundation::identity::AgentId::parse(id)
                .map_err(|_| ReactionStoreError::MalformedIdentity)?,
        )),
        _ => Err(ReactionStoreError::MalformedIdentity),
    }
}
