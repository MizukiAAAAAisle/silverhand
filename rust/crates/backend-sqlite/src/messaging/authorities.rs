use std::error::Error;

use silverhand_backend_core::{
    identity::{AgentId, ConversationId, UserId, WorkspaceId},
    messaging::{
        AddressRefusal, AddressedPrincipals, CapabilityDenied, ChannelAccess, ChannelAccessRefusal,
        DirectLineAuthority, DirectPairAllocation, DirectPairOpenedPort, DirectPairParticipants,
        OpenDirectPairError, PrincipalIdentity, PrincipalKind, ResolvedStream, SendCapability,
        SendClock, SendEntropy, TargetAddress, ThreadRootId,
    },
    persistence::PersistenceFailure,
};
use sqlx::Row;
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;

use super::{
    ENDPOINT_KIND_AGENT, ENDPOINT_KIND_HUMAN, MessagingStore, MessagingStoreError,
    PLACEMENT_DIRECT_PAIR, driver,
};

const PLACEMENT_WORKSPACE: &str = "workspace";
const ADDRESS_ID_LEN: usize = 16;

mod name_charset {
    include!(concat!(env!("OUT_DIR"), "/name_charset.rs"));
}

#[derive(Debug, Error)]
pub enum TargetAddressStoreError<O>
where
    O: Error + Send + Sync + 'static,
{
    #[error("target lookup failed")]
    Persistence(#[source] PersistenceFailure),
    #[error("target allocation clock failed")]
    Clock(#[source] silverhand_backend_core::messaging::EnvironmentUnavailable),
    #[error("direct-pair open failed")]
    Open(#[source] OpenDirectPairError<PersistenceFailure, O>),
}

fn corrupt(field: &'static str) -> PersistenceFailure {
    PersistenceFailure::from_source(MessagingStoreError::MalformedIdentity { field })
}

#[derive(Clone)]
pub struct SqliteTargetAddress<E, O> {
    store: MessagingStore<E>,
    opened: O,
}

impl<E, O> SqliteTargetAddress<E, O> {
    pub(super) fn new(store: MessagingStore<E>, opened: O) -> Self {
        Self { store, opened }
    }
}

struct ConversationPlacement {
    id: ConversationId,
    kind: String,
    workspace: Option<WorkspaceId>,
    endpoint_a: Option<(PrincipalIdentity, bool)>,
    endpoint_b: Option<(PrincipalIdentity, bool)>,
}

impl<E> MessagingStore<E> {
    async fn authority_conversation(
        &self,
        id: &ConversationId,
    ) -> Result<Option<ConversationPlacement>, PersistenceFailure> {
        let row = sqlx::query(
            "SELECT id, placement_kind, workspace_id, endpoint_a_kind, endpoint_a_id, \
             endpoint_a_deleted_at, endpoint_b_kind, endpoint_b_id, endpoint_b_deleted_at \
             FROM conversations WHERE id = ?",
        )
        .bind(id.as_str())
        .fetch_optional(&self.pool)
        .await
        .map_err(driver)?;
        row.map(decode_placement).transpose()
    }

    async fn agent_participates(
        &self,
        conversation: &ConversationPlacement,
        agent: &AgentId,
    ) -> Result<bool, PersistenceFailure> {
        match conversation.kind.as_str() {
            PLACEMENT_WORKSPACE => {
                let present: Option<i64> = sqlx::query_scalar(
                    "SELECT 1 FROM conversation_agents WHERE conversation_id = ? AND agent_id = ?",
                )
                .bind(conversation.id.as_str())
                .bind(agent.as_str())
                .fetch_optional(&self.pool)
                .await
                .map_err(driver)?;
                Ok(present.is_some())
            }
            PLACEMENT_DIRECT_PAIR => {
                Ok(conversation
                    .endpoint_a
                    .as_ref()
                    .is_some_and(|(p, deleted)| {
                        !deleted && p == &PrincipalIdentity::Agent(agent.clone())
                    })
                    || conversation
                        .endpoint_b
                        .as_ref()
                        .is_some_and(|(p, deleted)| {
                            !deleted && p == &PrincipalIdentity::Agent(agent.clone())
                        }))
            }
            _ => Err(corrupt("conversations.placement_kind")),
        }
    }

    async fn resolve_thread(
        &self,
        conversation: ConversationId,
        thread: Option<String>,
    ) -> Result<Result<ResolvedStream, AddressRefusal>, PersistenceFailure> {
        let Some(thread) = thread else {
            return Ok(Ok(ResolvedStream {
                conversation,
                thread_root: None,
            }));
        };
        let row: Option<Option<String>> = sqlx::query_scalar(
            "SELECT thread_root_id FROM messages WHERE conversation_id = ? AND id = ?",
        )
        .bind(conversation.as_str())
        .bind(&thread)
        .fetch_optional(&self.pool)
        .await
        .map_err(driver)?;
        if !matches!(row, Some(None)) {
            return Ok(Err(AddressRefusal::ThreadNotInTarget));
        }
        let root = ThreadRootId::parse(thread).map_err(|_| corrupt("messages.id"))?;
        Ok(Ok(ResolvedStream {
            conversation,
            thread_root: Some(root),
        }))
    }
}

impl<E> ChannelAccess for MessagingStore<E>
where
    E: Send + Sync,
{
    type Error = PersistenceFailure;

    async fn may_post(
        &self,
        channel: &ConversationId,
        author: &UserId,
    ) -> Result<Result<(), ChannelAccessRefusal>, Self::Error> {
        let Some(conversation) = self.authority_conversation(channel).await? else {
            return Ok(Err(ChannelAccessRefusal::NotFound));
        };
        let allowed = match conversation.kind.as_str() {
            PLACEMENT_WORKSPACE => {
                let workspace = conversation
                    .workspace
                    .as_ref()
                    .ok_or_else(|| corrupt("conversations.workspace_id"))?;
                let present: Option<i64> = sqlx::query_scalar(
                    "SELECT 1 FROM conversation_users cu JOIN workspace_users wu \
                     ON wu.workspace_id = ? AND wu.user_id = cu.user_id \
                     WHERE cu.conversation_id = ? AND cu.user_id = ?",
                )
                .bind(workspace.as_str())
                .bind(channel.as_str())
                .bind(author.as_str())
                .fetch_optional(&self.pool)
                .await
                .map_err(driver)?;
                present.is_some()
            }
            PLACEMENT_DIRECT_PAIR => {
                let a = conversation
                    .endpoint_a
                    .as_ref()
                    .ok_or_else(|| corrupt("conversations.endpoint_a"))?;
                let b = conversation
                    .endpoint_b
                    .as_ref()
                    .ok_or_else(|| corrupt("conversations.endpoint_b"))?;
                if a.1 || b.1 {
                    false
                } else if a.0 == PrincipalIdentity::Human(author.clone()) {
                    principal_exists(&self.pool, &b.0).await?
                } else if b.0 == PrincipalIdentity::Human(author.clone()) {
                    principal_exists(&self.pool, &a.0).await?
                } else {
                    false
                }
            }
            _ => return Err(corrupt("conversations.placement_kind")),
        };
        Ok(if allowed {
            Ok(())
        } else {
            Err(ChannelAccessRefusal::Forbidden)
        })
    }
}

impl<E> SendCapability for MessagingStore<E>
where
    E: Send + Sync,
{
    type Error = PersistenceFailure;

    async fn may_send_messages(
        &self,
        agent: &AgentId,
        conversation: &ConversationId,
    ) -> Result<Result<(), CapabilityDenied>, Self::Error> {
        let Some(place) = self.authority_conversation(conversation).await? else {
            return Ok(Err(CapabilityDenied));
        };
        let allowed = match place.kind.as_str() {
            PLACEMENT_WORKSPACE => {
                let workspace = place
                    .workspace
                    .as_ref()
                    .ok_or_else(|| corrupt("conversations.workspace_id"))?;
                let allowed: Option<i64> = sqlx::query_scalar(
                    "SELECT 1 FROM workspaces w WHERE w.id = ? AND \
                     (w.owner_agent_id = ? OR EXISTS (SELECT 1 FROM workspace_agent_capabilities c \
                     WHERE c.workspace_id = w.id AND c.agent_id = ? AND c.capability = 'send_messages'))",
                )
                .bind(workspace.as_str())
                .bind(agent.as_str())
                .bind(agent.as_str())
                .fetch_optional(&self.pool)
                .await
                .map_err(driver)?;
                allowed.is_some()
            }
            PLACEMENT_DIRECT_PAIR => self.agent_participates(&place, agent).await?,
            _ => return Err(corrupt("conversations.placement_kind")),
        };
        Ok(if allowed {
            Ok(())
        } else {
            Err(CapabilityDenied)
        })
    }
}

impl<E> DirectLineAuthority for MessagingStore<E>
where
    E: Send + Sync,
{
    async fn direct_lines(
        &self,
        author: &UserId,
        addressed: &AddressedPrincipals,
    ) -> Result<Vec<AgentId>, PersistenceFailure> {
        let mut agents = Vec::new();
        for reference in addressed
            .iter()
            .filter(|r| r.kind() == PrincipalKind::Agent)
        {
            let raw: Option<String> = sqlx::query_scalar(
                 "SELECT a.id FROM agents a WHERE a.name = ? AND a.materialization_status = 'active' \
                 AND a.deletion_started_at IS NULL AND a.session_scope = 'agent' \
                 AND (a.created_by_user_id = ? OR EXISTS (SELECT 1 \
                 FROM conversations c WHERE c.placement_kind = 'direct_pair' AND \
                 c.endpoint_a_deleted_at IS NULL AND c.endpoint_b_deleted_at IS NULL AND \
                 ((c.endpoint_a_kind = 'human' AND c.endpoint_a_id = ? AND c.endpoint_b_kind = 'agent' \
                 AND c.endpoint_b_id = a.id) OR (c.endpoint_b_kind = 'human' AND c.endpoint_b_id = ? \
                 AND c.endpoint_a_kind = 'agent' AND c.endpoint_a_id = a.id))) OR EXISTS (SELECT 1 \
                 FROM workspace_members wm JOIN workspace_users wu ON wu.workspace_id = wm.workspace_id \
                 WHERE wm.agent_id = a.id AND wu.user_id = ?))",
            )
            .bind(reference.handle().as_str())
            .bind(author.as_str())
            .bind(author.as_str())
            .bind(author.as_str())
            .bind(author.as_str())
            .fetch_optional(&self.pool)
            .await
            .map_err(driver)?;
            if let Some(raw) = raw {
                agents.push(AgentId::parse(raw).map_err(|_| corrupt("agents.id"))?);
            }
        }
        Ok(agents)
    }
}

impl<E, O> TargetAddress for SqliteTargetAddress<E, O>
where
    E: SendClock + SendEntropy + Send + Sync,
    O: DirectPairOpenedPort + Send + Sync,
{
    type Error = TargetAddressStoreError<O::Error>;

    async fn resolve(
        &self,
        agent: &AgentId,
        target: &str,
        allocation: DirectPairAllocation,
    ) -> Result<Result<ResolvedStream, AddressRefusal>, Self::Error> {
        let Some(parsed) = parse_target(target) else {
            return Ok(Err(AddressRefusal::Malformed));
        };
        let (conversation, thread) = match parsed {
            ParsedTarget::Conversation { id, thread } => {
                let id = ConversationId::parse(id).map_err(|_| {
                    TargetAddressStoreError::Persistence(corrupt("target.conversation_id"))
                })?;
                let Some(place) = self
                    .store
                    .authority_conversation(&id)
                    .await
                    .map_err(TargetAddressStoreError::Persistence)?
                else {
                    return Ok(Err(AddressRefusal::Unresolved));
                };
                if !self
                    .store
                    .agent_participates(&place, agent)
                    .await
                    .map_err(TargetAddressStoreError::Persistence)?
                {
                    return Ok(Err(AddressRefusal::Unresolved));
                }
                (id, thread)
            }
            ParsedTarget::Named {
                workspace_key,
                title_key,
                thread,
            } => {
                let rows: Vec<String> = sqlx::query_scalar(
                    "SELECT c.id FROM workspaces w JOIN conversations c ON c.workspace_id = w.id \
                     WHERE w.owner_agent_id IS NULL AND w.name_key = ? AND c.title_key = ? LIMIT 2",
                )
                .bind(workspace_key)
                .bind(title_key)
                .fetch_all(&self.store.pool)
                .await
                .map_err(driver)
                .map_err(TargetAddressStoreError::Persistence)?;
                let raw = match rows.as_slice() {
                    [] => return Ok(Err(AddressRefusal::Unresolved)),
                    [raw] => raw.clone(),
                    _ => {
                        return Err(TargetAddressStoreError::Persistence(corrupt(
                            "target.named_stream",
                        )));
                    }
                };
                let id = ConversationId::parse(raw).map_err(|_| {
                    TargetAddressStoreError::Persistence(corrupt("conversations.id"))
                })?;
                let place = self
                    .store
                    .authority_conversation(&id)
                    .await
                    .map_err(TargetAddressStoreError::Persistence)?
                    .ok_or_else(|| {
                        TargetAddressStoreError::Persistence(corrupt("conversations.id"))
                    })?;
                if !self
                    .store
                    .agent_participates(&place, agent)
                    .await
                    .map_err(TargetAddressStoreError::Persistence)?
                {
                    return Ok(Err(AddressRefusal::Unresolved));
                }
                (id, thread)
            }
            ParsedTarget::DirectPair { handle, thread } => {
                let agent_row: Option<String> =
                    sqlx::query_scalar("SELECT id FROM agents WHERE name = ?")
                        .bind(&handle)
                        .fetch_optional(&self.store.pool)
                        .await
                        .map_err(driver)
                        .map_err(TargetAddressStoreError::Persistence)?;
                let user_row: Option<String> =
                    sqlx::query_scalar("SELECT id FROM users WHERE name = ?")
                        .bind(&handle)
                        .fetch_optional(&self.store.pool)
                        .await
                        .map_err(driver)
                        .map_err(TargetAddressStoreError::Persistence)?;
                let other = match (agent_row, user_row) {
                    (Some(_), Some(_)) => {
                        return Err(TargetAddressStoreError::Persistence(corrupt(
                            "principal.handle",
                        )));
                    }
                    (Some(raw), None) => {
                        PrincipalIdentity::Agent(AgentId::parse(raw).map_err(|_| {
                            TargetAddressStoreError::Persistence(corrupt("agents.id"))
                        })?)
                    }
                    (None, Some(raw)) => {
                        PrincipalIdentity::Human(UserId::parse(raw).map_err(|_| {
                            TargetAddressStoreError::Persistence(corrupt("users.id"))
                        })?)
                    }
                    (None, None) => return Ok(Err(AddressRefusal::Unresolved)),
                };
                let me = PrincipalIdentity::Agent(agent.clone());
                if other == me {
                    return Ok(Err(AddressRefusal::SelfPair));
                }
                let participants = DirectPairParticipants::between(me, other).map_err(|_| {
                    TargetAddressStoreError::Persistence(corrupt("direct_pair.participants"))
                })?;
                let existing: Option<String> = sqlx::query_scalar(super::SELECT_DIRECT_PAIR)
                    .bind(super::principal_kind(participants.first()))
                    .bind(participants.first().as_str())
                    .bind(super::principal_kind(participants.second()))
                    .bind(participants.second().as_str())
                    .fetch_optional(&self.store.pool)
                    .await
                    .map_err(driver)
                    .map_err(TargetAddressStoreError::Persistence)?;
                let id = match (existing, allocation) {
                    (Some(raw), _) => ConversationId::parse(raw).map_err(|_| {
                        TargetAddressStoreError::Persistence(corrupt("conversations.id"))
                    })?,
                    (None, DirectPairAllocation::Forbidden) => {
                        return Ok(Err(AddressRefusal::Unresolved));
                    }
                    (None, DirectPairAllocation::Permitted) => {
                        let now = self
                            .store
                            .environment
                            .now_unix_ms()
                            .map_err(TargetAddressStoreError::Clock)?;
                        self.store
                            .open_direct_pair(&self.opened, participants, now)
                            .await
                            .map_err(TargetAddressStoreError::Open)?
                    }
                };
                (id, thread)
            }
        };
        self.store
            .resolve_thread(conversation, thread)
            .await
            .map_err(TargetAddressStoreError::Persistence)
    }
}

fn decode_placement(
    row: sqlx::sqlite::SqliteRow,
) -> Result<ConversationPlacement, PersistenceFailure> {
    let id: String = row.try_get("id").map_err(driver)?;
    let kind: String = row.try_get("placement_kind").map_err(driver)?;
    let workspace: Option<String> = row.try_get("workspace_id").map_err(driver)?;
    let endpoint_a = decode_endpoint(
        &row,
        "endpoint_a_kind",
        "endpoint_a_id",
        "endpoint_a_deleted_at",
    )?;
    let endpoint_b = decode_endpoint(
        &row,
        "endpoint_b_kind",
        "endpoint_b_id",
        "endpoint_b_deleted_at",
    )?;
    let id = ConversationId::parse(id).map_err(|_| corrupt("conversations.id"))?;
    let workspace = workspace
        .map(WorkspaceId::parse)
        .transpose()
        .map_err(|_| corrupt("conversations.workspace_id"))?;
    match kind.as_str() {
        PLACEMENT_WORKSPACE
            if workspace.is_some() && endpoint_a.is_none() && endpoint_b.is_none() => {}
        PLACEMENT_DIRECT_PAIR
            if workspace.is_none() && endpoint_a.is_some() && endpoint_b.is_some() => {}
        PLACEMENT_WORKSPACE | PLACEMENT_DIRECT_PAIR => {
            return Err(corrupt("conversations.placement"));
        }
        _ => return Err(corrupt("conversations.placement_kind")),
    }
    Ok(ConversationPlacement {
        id,
        kind,
        workspace,
        endpoint_a,
        endpoint_b,
    })
}

fn decode_endpoint(
    row: &sqlx::sqlite::SqliteRow,
    kind_field: &'static str,
    id_field: &'static str,
    deleted_field: &'static str,
) -> Result<Option<(PrincipalIdentity, bool)>, PersistenceFailure> {
    let kind: Option<String> = row.try_get(kind_field).map_err(driver)?;
    let id: Option<String> = row.try_get(id_field).map_err(driver)?;
    let deleted: Option<i64> = row.try_get(deleted_field).map_err(driver)?;
    match (kind.as_deref(), id) {
        (None, None) if deleted.is_none() => Ok(None),
        (Some(ENDPOINT_KIND_AGENT), Some(raw)) => Ok(Some((
            PrincipalIdentity::Agent(AgentId::parse(raw).map_err(|_| corrupt(id_field))?),
            deleted.is_some(),
        ))),
        (Some(ENDPOINT_KIND_HUMAN), Some(raw)) => Ok(Some((
            PrincipalIdentity::Human(UserId::parse(raw).map_err(|_| corrupt(id_field))?),
            deleted.is_some(),
        ))),
        _ => Err(corrupt(kind_field)),
    }
}

async fn principal_exists(
    pool: &sqlx::SqlitePool,
    principal: &PrincipalIdentity,
) -> Result<bool, PersistenceFailure> {
    let found: Option<i64> = match principal.kind() {
        PrincipalKind::Agent => sqlx::query_scalar(
            "SELECT 1 FROM agents WHERE id = ? AND materialization_status = 'active' \
             AND deletion_started_at IS NULL",
        )
        .bind(principal.as_str())
        .fetch_optional(pool)
        .await
        .map_err(driver)?,
        PrincipalKind::Human => sqlx::query_scalar("SELECT 1 FROM users WHERE id = ?")
            .bind(principal.as_str())
            .fetch_optional(pool)
            .await
            .map_err(driver)?,
    };
    Ok(found.is_some())
}

enum ParsedTarget {
    Conversation {
        id: String,
        thread: Option<String>,
    },
    Named {
        workspace_key: String,
        title_key: String,
        thread: Option<String>,
    },
    DirectPair {
        handle: String,
        thread: Option<String>,
    },
}

fn parse_target(raw: &str) -> Option<ParsedTarget> {
    if let Some(rest) = raw.strip_prefix("#conv:")
        && let Some((id, thread)) = split_thread(rest, false)
        && address_id(id)
    {
        return Some(ParsedTarget::Conversation {
            id: id.into(),
            thread,
        });
    }
    if let Some(rest) = raw.strip_prefix("dm:@") {
        let (handle, thread) = split_thread(rest, false)?;
        let valid = handle.len() <= 64
            && handle
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphabetic)
            && handle
                .as_bytes()
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-');
        return valid.then(|| ParsedTarget::DirectPair {
            handle: handle.into(),
            thread,
        });
    }
    let rest = raw.strip_prefix('#')?;
    let (head, thread) = split_thread(rest, true)?;
    let (workspace, title) = head.split_once('/')?;
    if title.contains('/') {
        return None;
    }
    let workspace = decode_name_segment(workspace, 64)?;
    let title = decode_name_segment(title, 128)?;
    Some(ParsedTarget::Named {
        workspace_key: fold_key(&workspace),
        title_key: fold_key(&title),
        thread,
    })
}

fn split_thread(raw: &str, named: bool) -> Option<(&str, Option<String>)> {
    let Some((head, suffix)) = raw.rsplit_once("/thread:") else {
        return Some((raw, None));
    };
    if named && !head.contains('/') {
        return Some((raw, None));
    }
    address_id(suffix).then(|| (head, Some(suffix.to_owned())))
}

fn address_id(raw: &str) -> bool {
    raw.len() == ADDRESS_ID_LEN
        && raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn fold_key(raw: &str) -> String {
    let mut folded = String::with_capacity(raw.len());
    for character in raw.chars() {
        if let Ok(index) = name_charset::CASE_FOLD.binary_search_by_key(&character, |(key, _)| *key)
        {
            let replacement = name_charset::CASE_FOLD[index].1;
            folded.push_str(replacement);
        } else {
            folded.push(character);
        }
    }
    folded.nfc().collect()
}

fn decode_name_segment(segment: &str, max: usize) -> Option<String> {
    if segment.is_empty() || segment.contains('/') {
        return None;
    }
    const ESCAPES: &[(&str, &str)] = &[
        ("%E3%80%80", "\u{3000}"),
        ("%E2%81%9F", "\u{205f}"),
        ("%E2%80%AF", "\u{202f}"),
        ("%E2%80%8A", "\u{200a}"),
        ("%E2%80%89", "\u{2009}"),
        ("%E2%80%88", "\u{2008}"),
        ("%E2%80%87", "\u{2007}"),
        ("%E2%80%86", "\u{2006}"),
        ("%E2%80%85", "\u{2005}"),
        ("%E2%80%84", "\u{2004}"),
        ("%E2%80%83", "\u{2003}"),
        ("%E2%80%82", "\u{2002}"),
        ("%E2%80%81", "\u{2001}"),
        ("%E2%80%80", "\u{2000}"),
        ("%E1%9A%80", "\u{1680}"),
        ("%C2%A0", "\u{00a0}"),
        ("%25", "%"),
        ("%2F", "/"),
        ("%20", " "),
    ];
    let mut decoded = String::new();
    let mut index = 0;
    while index < segment.len() {
        let rest = &segment[index..];
        if rest.starts_with('%') {
            let (escaped, value) = ESCAPES
                .iter()
                .find(|(escaped, _)| rest.starts_with(*escaped))?;
            decoded.push_str(value);
            index += escaped.len();
        } else {
            let ch = rest.chars().next()?;
            if ch == '%' || is_space_separator(ch) {
                return None;
            }
            decoded.push(ch);
            index += ch.len_utf8();
        }
    }
    if decoded.chars().count() > max
        || decoded.trim() != decoded
        || decoded.nfc().collect::<String>() != decoded
        || decoded.chars().any(name_character_is_forbidden)
    {
        return None;
    }
    Some(decoded)
}

fn name_character_is_forbidden(character: char) -> bool {
    let point = character as u32;
    !in_ranges(name_charset::NAME_RENDERABLE_RANGES, point)
        || in_ranges(name_charset::NAME_DEFAULT_IGNORABLE_RANGES, point)
        || in_ranges(name_charset::NAME_ENCLOSING_MARK_RANGES, point)
        || in_ranges(name_charset::NAME_EMOJI_MODIFIER_RANGES, point)
        || in_ranges(name_charset::NAME_REGIONAL_INDICATOR_RANGES, point)
}

fn in_ranges(ranges: &[(u32, u32)], point: u32) -> bool {
    ranges
        .binary_search_by(|(first, last)| {
            if point < *first {
                std::cmp::Ordering::Greater
            } else if point > *last {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

fn is_space_separator(ch: char) -> bool {
    matches!(
        ch,
        '\u{20}' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}'
    )
}

#[cfg(test)]
mod tests {
    use super::{ParsedTarget, fold_key, parse_target};
    use unicode_normalization::UnicodeNormalization;

    #[test]
    fn parser_keeps_the_three_published_arms_disjoint() {
        assert!(matches!(
            parse_target("#conv:aBcDeFgHiJkLmN_P"),
            Some(ParsedTarget::Conversation { thread: None, .. })
        ));
        for malformed in [
            "#silverhand/%20general",
            "#silverhand/general%20",
            "#silverhand/gene\u{200d}ral",
            "#silverhand/❤\u{fe0f}",
            "#silverhand/1\u{20e3}",
            "#silverhand/\u{1f1e8}\u{1f1f3}",
        ] {
            assert!(parse_target(malformed).is_none(), "{malformed:?}");
        }
        assert!(matches!(
            parse_target("#conv:aBcDeFgHiJkLmN_P/room"),
            Some(ParsedTarget::Named { thread: None, .. })
        ));
        assert!(matches!(
            parse_target("#silverhand/thread:aBcDeFgHiJkLmN_P"),
            Some(ParsedTarget::Named { thread: None, .. })
        ));
        assert!(matches!(
            parse_target("#silverhand/thread:aBcDeFgHiJkLmN_P/thread:root000000000001"),
            Some(ParsedTarget::Named {
                thread: Some(_),
                ..
            })
        ));
    }

    #[test]
    fn pinned_case_fold_matches_the_typescript_authority_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../packages/shared/tests/fixtures/unicode-case-fold.json"
        ))
        .unwrap();
        assert_eq!(fixture["unicodeVersion"], "16.0.0");
        for (from, to) in fixture["mappings"].as_object().unwrap() {
            let input = char::from_u32(u32::from_str_radix(from, 16).unwrap())
                .unwrap()
                .to_string();
            let expected: String = to
                .as_str()
                .unwrap()
                .split_whitespace()
                .map(|point| char::from_u32(u32::from_str_radix(point, 16).unwrap()).unwrap())
                .collect();
            assert_eq!(
                fold_key(&input),
                expected.nfc().collect::<String>(),
                "U+{from}"
            );
        }
    }
}
