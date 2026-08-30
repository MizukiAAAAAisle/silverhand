//! How this schema's author columns discriminate into a [`MessageAuthor`].
//!
//! The domain owns the *value* — active / deleted / unresolved and their
//! invariants. It deliberately does not own the *discrimination*, because which
//! arm a row projects to is a fact about how one schema encodes authorship: the
//! live provenance FK (`from_agent_id` / `from_user_id`, nulled by
//! `ON DELETE SET NULL`) versus the send-time snapshot columns (`author_id` /
//! `author_name` / `author_display_name`, which survive the delete). That
//! knowledge belongs to the adapter that reads those columns, so it lives here.
//!
//! [`resolve_authors`] is the adapter's one author authority: it takes a batch of
//! author rows and returns the authors they report, owning the read (at most one
//! set-shaped query per principal table) and the discrimination together, so a
//! list read and the write-path point read (its one-element case) share one
//! authority rather than each re-assembling the steps. The pure per-row rule
//! [`resolve_author`] and the batched read [`load_live_actors`] are private parts
//! of that authority, not a toolkit a caller composes. The FK being non-null is
//! itself the proof the actor still exists (referential integrity forbids a
//! dangling FK), so it, not a separate existence probe, tells `active` from
//! `deleted`. It never fabricates `deleted` from a still-intact FK, and never from
//! a nulled FK without a surviving snapshot; both of those fail closed to
//! `unresolved`.

use std::collections::{HashMap, HashSet};

use silverhand_backend_core::persistence::PersistenceFailure;
use silverhand_backend_core::{
    agents::runtime::RuntimeKind,
    identity::{AgentId, UserId},
    messaging::{AvatarRevision, FromKind, MessageAuthor, PrincipalIdentity, PrincipalKind},
};
use sqlx::{Row, SqliteConnection, sqlite::SqliteRow};

use super::{MessagingStoreError, driver};

/// The author evidence carried by one `messages` row: the send-time provenance
/// (`from_kind` and the two nullable FKs) plus the snapshot columns that outlive a
/// deleted principal. Storage-shaped, so it stays inside the adapter crate and never
/// leaves for the domain — the domain sees only the resolved [`MessageAuthor`].
///
/// `pub(crate)`: reused by the agent-audit read adapter to gather the same evidence
/// batch its transcript rows carry.
#[derive(Clone)]
pub(crate) struct AuthorEvidence {
    pub from_kind: FromKind,
    pub from_agent_id: Option<String>,
    pub from_user_id: Option<String>,
    pub author_id: Option<String>,
    pub author_name: Option<String>,
    pub author_display_name: Option<String>,
}

/// The current actor row, supplied only when the provenance FK still resolves.
/// `runtime` is the stored spelling for an agent, and `None` for a human row
/// (users carry no runtime column) or an agent whose column is somehow NULL.
/// Private: it is an internal step of [`resolve_authors`], never handed out.
struct LiveActor {
    name: String,
    display_name: String,
    avatar_storage_key: Option<String>,
    updated_at: i64,
    runtime: Option<String>,
}

/// Discriminate one already-read row into the author it reports, or `None` for a
/// system send. The pure heart of [`resolve_authors`], and private to it: a caller
/// gets the authority, not this rule plus a separate read to wire together.
///
/// `Err` is reserved for a broken database the store itself must own: a snapshot
/// id that names nothing, or a stored runtime outside the closed set. Neither is a
/// caller's mistake, so both surface as a [`PersistenceFailure`] carrying what
/// broke rather than a silently defaulted value.
fn resolve_author(
    evidence: &AuthorEvidence,
    live: Option<&LiveActor>,
) -> Result<Option<MessageAuthor>, PersistenceFailure> {
    let kind = match evidence.from_kind {
        // `system` authorship is the outer `None`, never a synthetic author.
        FromKind::System => return Ok(None),
        FromKind::Agent => PrincipalKind::Agent,
        FromKind::User => PrincipalKind::Human,
    };
    let fk = match kind {
        PrincipalKind::Agent => evidence.from_agent_id.as_deref(),
        PrincipalKind::Human => evidence.from_user_id.as_deref(),
    };
    let author = match (fk, live) {
        // FK intact but the live row did not load: a loader/consistency fault, not
        // a deletion. Fail closed to unresolved rather than dress a living actor as
        // gone, or read a stale snapshot over a still-current row.
        (Some(_), None) => MessageAuthor::unresolved(kind),
        (Some(fk_id), Some(live)) => active_author(kind, fk_id, live)?,
        // FK nulled (the actor was hard-deleted): a complete snapshot names it,
        // otherwise its identity is unrecoverable.
        (None, _) => deleted_or_unresolved(kind, evidence)?,
    };
    Ok(Some(author))
}

/// The live row won, so name/display/avatar/runtime are current values — a rename
/// or new avatar shows through rather than the send-time snapshot.
fn active_author(
    kind: PrincipalKind,
    fk_id: &str,
    live: &LiveActor,
) -> Result<MessageAuthor, PersistenceFailure> {
    let avatar = avatar_revision(live);
    match kind {
        PrincipalKind::Agent => {
            let id = agent_id(fk_id, "from_agent_id")?;
            // agents.runtime is NOT NULL, so a live agent always carries one; a NULL
            // is the same loader/consistency fault as a missing row, and fails closed
            // to unresolved rather than inventing a runtime.
            match parse_runtime(live.runtime.as_deref())? {
                None => Ok(MessageAuthor::unresolved(PrincipalKind::Agent)),
                Some(runtime) => Ok(MessageAuthor::active_agent(
                    id,
                    live.name.clone(),
                    live.display_name.clone(),
                    avatar,
                    runtime,
                )),
            }
        }
        PrincipalKind::Human => {
            let id = user_id(fk_id, "from_user_id")?;
            Ok(MessageAuthor::active_human(
                id,
                live.name.clone(),
                live.display_name.clone(),
                avatar,
            ))
        }
    }
}

/// FK nulled: a complete snapshot (`author_id` and `author_name` both present)
/// names a deleted principal; anything less is unrecoverable.
fn deleted_or_unresolved(
    kind: PrincipalKind,
    evidence: &AuthorEvidence,
) -> Result<MessageAuthor, PersistenceFailure> {
    match (
        evidence.author_id.as_deref(),
        evidence.author_name.as_deref(),
    ) {
        (Some(id), Some(name)) => {
            let identity = principal_identity(kind, id, "author_id")?;
            // display_name is NOT NULL at the source; falling back to name is a
            // defensive floor so the deleted arm's `display_name` is never empty by
            // accident, matching the resolver's `?? name`.
            let display_name = evidence
                .author_display_name
                .clone()
                .unwrap_or_else(|| name.to_owned());
            Ok(MessageAuthor::deleted(
                identity,
                name.to_owned(),
                display_name,
            ))
        }
        _ => Ok(MessageAuthor::unresolved(kind)),
    }
}

/// The avatar cache-buster, decided from the storage key by the product's JS
/// truthiness: both NULL and the empty string mean "no avatar", and only a
/// non-empty key carries a revision.
fn avatar_revision(live: &LiveActor) -> Option<AvatarRevision> {
    match live.avatar_storage_key.as_deref() {
        None | Some("") => None,
        Some(_) => Some(AvatarRevision::at(live.updated_at)),
    }
}

/// A NULL runtime is a `None` the caller maps to unresolved; a non-null value
/// outside the closed set is a broken database, surfaced with the offending
/// spelling rather than defaulted.
fn parse_runtime(raw: Option<&str>) -> Result<Option<RuntimeKind>, PersistenceFailure> {
    match raw {
        None => Ok(None),
        Some(value) => RuntimeKind::parse(value).map(Some).ok_or_else(|| {
            PersistenceFailure::from_source(MessagingStoreError::MalformedRuntime {
                value: value.to_owned(),
            })
        }),
    }
}

fn principal_identity(
    kind: PrincipalKind,
    id: &str,
    field: &'static str,
) -> Result<PrincipalIdentity, PersistenceFailure> {
    Ok(match kind {
        PrincipalKind::Agent => PrincipalIdentity::Agent(agent_id(id, field)?),
        PrincipalKind::Human => PrincipalIdentity::Human(user_id(id, field)?),
    })
}

fn agent_id(raw: &str, field: &'static str) -> Result<AgentId, PersistenceFailure> {
    AgentId::parse(raw).map_err(|_| malformed_identity(field))
}

fn user_id(raw: &str, field: &'static str) -> Result<UserId, PersistenceFailure> {
    UserId::parse(raw).map_err(|_| malformed_identity(field))
}

fn malformed_identity(field: &'static str) -> PersistenceFailure {
    PersistenceFailure::from_source(MessagingStoreError::MalformedIdentity { field })
}

// The current-row lookups the resolver reads against. Both are driven by the
// caller's own id set (`json_each(?)` supplies the rows), and each id probes the
// table's `TEXT PRIMARY KEY` — so the read is bounded by the ids asked for, never
// by the size of `agents`/`users`. One statement per table serves a set of any
// size, which is what forecloses an N+1 over the page. A macro, so the plan-gate
// tests can assert the SAME text through an `EXPLAIN QUERY PLAN` prefix.
macro_rules! live_agents_sql {
    () => {
        "SELECT a.id, a.name, a.display_name, a.avatar_storage_key, a.updated_at, a.runtime \
         FROM json_each(?) requested JOIN agents a ON a.id = requested.value"
    };
}
macro_rules! live_users_sql {
    () => {
        "SELECT u.id, u.name, u.display_name, u.avatar_storage_key, u.updated_at \
         FROM json_each(?) requested JOIN users u ON u.id = requested.value"
    };
}
const SELECT_LIVE_AGENTS: &str = live_agents_sql!();
const SELECT_LIVE_USERS: &str = live_users_sql!();
#[cfg(test)]
pub(super) const EXPLAIN_LIVE_AGENTS: &str = concat!("EXPLAIN QUERY PLAN ", live_agents_sql!());
#[cfg(test)]
pub(super) const EXPLAIN_LIVE_USERS: &str = concat!("EXPLAIN QUERY PLAN ", live_users_sql!());

/// The current rows for a batch of author FKs, one map per principal table.
/// Private to this module: it is a step inside [`resolve_authors`], never a part
/// a caller composes with the discriminator itself.
#[derive(Default)]
struct LiveActors {
    agents: HashMap<String, LiveActor>,
    users: HashMap<String, LiveActor>,
}

impl LiveActors {
    /// The current row for one principal, or `None` when the FK named a row this
    /// batch did not find — the "no live row" the resolver reads as deleted (with
    /// a snapshot) or unresolved (without one).
    fn get(&self, kind: PrincipalKind, id: &str) -> Option<&LiveActor> {
        match kind {
            PrincipalKind::Agent => self.agents.get(id),
            PrincipalKind::Human => self.users.get(id),
        }
    }
}

/// Load the current rows for a set of agent and user FKs in AT MOST two queries —
/// one per table, and none for a table whose id set is empty. The set is the
/// bound: `json_each` over the requested ids drives each join, so the cost tracks
/// the ids asked for, not the installation, and there is never one query per row.
async fn load_live_actors(
    conn: &mut SqliteConnection,
    agent_ids: &[&str],
    user_ids: &[&str],
) -> Result<LiveActors, PersistenceFailure> {
    let mut live = LiveActors::default();
    if !agent_ids.is_empty() {
        let requested = ids_json(agent_ids)?;
        let rows = sqlx::query(SELECT_LIVE_AGENTS)
            .bind(requested)
            .fetch_all(&mut *conn)
            .await
            .map_err(driver)?;
        for row in &rows {
            live.agents.insert(id_of(row)?, live_actor(row, true)?);
        }
    }
    if !user_ids.is_empty() {
        let requested = ids_json(user_ids)?;
        let rows = sqlx::query(SELECT_LIVE_USERS)
            .bind(requested)
            .fetch_all(&mut *conn)
            .await
            .map_err(driver)?;
        for row in &rows {
            live.users.insert(id_of(row)?, live_actor(row, false)?);
        }
    }
    Ok(live)
}

fn id_of(row: &SqliteRow) -> Result<String, PersistenceFailure> {
    row.try_get("id").map_err(driver)
}

/// Build a [`LiveActor`] from a fetched row. `runtime` is read only for an agent;
/// a user has no such column, so it is `None` without a read.
fn live_actor(row: &SqliteRow, is_agent: bool) -> Result<LiveActor, PersistenceFailure> {
    Ok(LiveActor {
        name: row.try_get("name").map_err(driver)?,
        display_name: row.try_get("display_name").map_err(driver)?,
        avatar_storage_key: row.try_get("avatar_storage_key").map_err(driver)?,
        updated_at: row.try_get("updated_at").map_err(driver)?,
        runtime: if is_agent {
            row.try_get("runtime").map_err(driver)?
        } else {
            None
        },
    })
}

fn ids_json(ids: &[&str]) -> Result<String, PersistenceFailure> {
    serde_json::to_string(ids)
        .map_err(|error| PersistenceFailure::from_source(MessagingStoreError::Serialization(error)))
}

/// The live-row lookup key for one row's author evidence: the principal kind and
/// the still-intact FK to fetch. `None` for a system author (no principal) or a
/// nulled FK (the actor is gone, so the row resolves from its snapshot rather
/// than a live read), so such a row contributes nothing to the batched reads.
fn live_key(evidence: &AuthorEvidence) -> Option<(PrincipalKind, &str)> {
    let kind = match evidence.from_kind {
        FromKind::System => return None,
        FromKind::Agent => PrincipalKind::Agent,
        FromKind::User => PrincipalKind::Human,
    };
    let fk = match kind {
        PrincipalKind::Agent => evidence.from_agent_id.as_deref(),
        PrincipalKind::Human => evidence.from_user_id.as_deref(),
    }?;
    Some((kind, fk))
}

/// Resolve a batch of author rows into the authors they report, in input order.
///
/// This is the adapter's ONE author authority — the whole orchestration a list
/// read needs, not a set of parts a caller assembles. It collects the intact FKs
/// this batch names, DEDUPED per principal table, issues at most one set-shaped
/// live read per table through [`load_live_actors`] (none for a table nothing in
/// the batch names), and resolves every input through the single pure
/// discriminator [`resolve_author`]. A point read is the one-element case, so the
/// write path and a list read share this authority rather than each re-deriving
/// "collect FKs → read → match rows → discriminate" and risking a missed id, a
/// per-row query, or a bypassed discriminator.
///
/// `Err` fails the WHOLE batch — a single broken row (a stored runtime outside the
/// set, a snapshot id that names nothing, a driver fault) is a persistence
/// invariant the store owns, so there is no partial result and the source chain is
/// preserved.
///
/// `pub(crate)`: the agent-audit read adapter resolves its transcript authors through
/// this same authority (see [`AuthorEvidence`]).
pub(crate) async fn resolve_authors(
    conn: &mut SqliteConnection,
    evidence: &[AuthorEvidence],
) -> Result<Vec<Option<MessageAuthor>>, PersistenceFailure> {
    let mut agent_ids: Vec<&str> = Vec::new();
    let mut user_ids: Vec<&str> = Vec::new();
    let mut seen_agents: HashSet<&str> = HashSet::new();
    let mut seen_users: HashSet<&str> = HashSet::new();
    for row in evidence {
        match live_key(row) {
            Some((PrincipalKind::Agent, id)) if seen_agents.insert(id) => agent_ids.push(id),
            Some((PrincipalKind::Human, id)) if seen_users.insert(id) => user_ids.push(id),
            _ => {}
        }
    }

    let live = load_live_actors(conn, &agent_ids, &user_ids).await?;

    evidence
        .iter()
        .map(|row| {
            let actor = live_key(row).and_then(|(kind, id)| live.get(kind, id));
            resolve_author(row, actor)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use silverhand_backend_core::messaging::ActiveAuthor;

    const AGENT_FK: &str = "agent-1";
    const USER_FK: &str = "user-1";

    /// Evidence for a live send: the provenance FK set, no snapshot yet (the row is
    /// current). `kind` picks which FK carries the id.
    fn live_evidence(kind: FromKind) -> AuthorEvidence {
        AuthorEvidence {
            from_kind: kind,
            from_agent_id: matches!(kind, FromKind::Agent).then(|| AGENT_FK.to_owned()),
            from_user_id: matches!(kind, FromKind::User).then(|| USER_FK.to_owned()),
            author_id: None,
            author_name: None,
            author_display_name: None,
        }
    }

    fn live_agent(runtime: Option<&str>) -> LiveActor {
        LiveActor {
            name: "lio".to_owned(),
            display_name: "Lio".to_owned(),
            avatar_storage_key: None,
            updated_at: 7,
            runtime: runtime.map(str::to_owned),
        }
    }

    #[test]
    fn a_system_send_has_no_author_regardless_of_any_live_row() {
        let evidence = AuthorEvidence {
            from_kind: FromKind::System,
            from_agent_id: None,
            from_user_id: None,
            author_id: None,
            author_name: None,
            author_display_name: None,
        };
        assert_eq!(resolve_author(&evidence, None).unwrap(), None);
        // Even with a live row in hand, system authorship stays the outer `None`.
        assert_eq!(
            resolve_author(&evidence, Some(&live_agent(Some("claude")))).unwrap(),
            None
        );
    }

    #[test]
    fn an_intact_agent_fk_with_a_live_row_resolves_active_with_current_values() {
        let evidence = live_evidence(FromKind::Agent);
        let live = LiveActor {
            name: "lio-renamed".to_owned(),
            display_name: "Lio Renamed".to_owned(),
            avatar_storage_key: Some("k".to_owned()),
            updated_at: 99,
            runtime: Some("codex".to_owned()),
        };
        let MessageAuthor::Active(ActiveAuthor::Agent(agent)) =
            resolve_author(&evidence, Some(&live)).unwrap().unwrap()
        else {
            panic!("expected an active agent");
        };
        assert_eq!(agent.id().as_str(), AGENT_FK);
        assert_eq!(agent.name(), "lio-renamed");
        assert_eq!(agent.display_name(), "Lio Renamed");
        assert_eq!(agent.avatar().map(|a| a.cache_buster()), Some(99));
        assert_eq!(agent.runtime(), RuntimeKind::Codex);
    }

    #[test]
    fn an_intact_user_fk_with_a_live_row_resolves_active_with_no_runtime() {
        let evidence = live_evidence(FromKind::User);
        let live = LiveActor {
            name: "human".to_owned(),
            display_name: "Human".to_owned(),
            avatar_storage_key: None,
            updated_at: 3,
            runtime: None,
        };
        let MessageAuthor::Active(ActiveAuthor::Human(human)) =
            resolve_author(&evidence, Some(&live)).unwrap().unwrap()
        else {
            panic!("expected an active human");
        };
        assert_eq!(human.id().as_str(), USER_FK);
        assert_eq!(human.name(), "human");
        assert_eq!(human.avatar(), None);
    }

    #[test]
    fn a_live_row_overrides_a_present_snapshot_so_a_rename_shows_through() {
        // Both the live row and a stale snapshot are present; the intact FK means the
        // live row wins and the snapshot is never read.
        let mut evidence = live_evidence(FromKind::Agent);
        evidence.author_id = Some(AGENT_FK.to_owned());
        evidence.author_name = Some("stale-name".to_owned());
        evidence.author_display_name = Some("Stale Name".to_owned());
        let MessageAuthor::Active(ActiveAuthor::Agent(agent)) =
            resolve_author(&evidence, Some(&live_agent(Some("claude"))))
                .unwrap()
                .unwrap()
        else {
            panic!("expected an active agent");
        };
        assert_eq!(agent.name(), "lio");
        assert_eq!(agent.display_name(), "Lio");
    }

    #[test]
    fn an_intact_fk_with_no_live_row_fails_closed_to_unresolved_not_deleted() {
        // A complete snapshot is present, yet the FK is intact and the live row is
        // missing: this is a loader fault, and must not be dressed as `deleted`.
        let mut evidence = live_evidence(FromKind::Agent);
        evidence.author_id = Some(AGENT_FK.to_owned());
        evidence.author_name = Some("snapshot".to_owned());
        let author = resolve_author(&evidence, None).unwrap().unwrap();
        assert!(matches!(author, MessageAuthor::Unresolved(_)));
        assert_eq!(author.stable_identity(), None);
    }

    #[test]
    fn a_live_agent_with_a_null_runtime_fails_closed_to_unresolved() {
        let evidence = live_evidence(FromKind::Agent);
        let author = resolve_author(&evidence, Some(&live_agent(None)))
            .unwrap()
            .unwrap();
        assert!(matches!(author, MessageAuthor::Unresolved(_)));
    }

    #[test]
    fn a_live_agent_with_a_runtime_outside_the_set_is_a_broken_database() {
        let evidence = live_evidence(FromKind::Agent);
        let error = resolve_author(&evidence, Some(&live_agent(Some("aider")))).unwrap_err();
        // Source-preserving: the offending spelling rides along rather than being
        // defaulted or dropped.
        let rendered = format!("{}", std::error::Error::source(&error).unwrap());
        assert!(
            rendered.contains("aider"),
            "runtime value must survive: {rendered}"
        );
    }

    #[test]
    fn a_nulled_fk_with_a_complete_snapshot_resolves_deleted() {
        let evidence = AuthorEvidence {
            from_kind: FromKind::Agent,
            from_agent_id: None,
            from_user_id: None,
            author_id: Some(AGENT_FK.to_owned()),
            author_name: Some("lio".to_owned()),
            author_display_name: Some("Lio".to_owned()),
        };
        let MessageAuthor::Deleted(deleted) = resolve_author(&evidence, None).unwrap().unwrap()
        else {
            panic!("expected a deleted author");
        };
        assert_eq!(
            deleted.identity(),
            &PrincipalIdentity::Agent(agent_id(AGENT_FK, "x").unwrap())
        );
        assert_eq!(deleted.name(), "lio");
        assert_eq!(deleted.display_name(), "Lio");
    }

    #[test]
    fn a_deleted_snapshot_without_a_display_name_falls_back_to_the_name() {
        let evidence = AuthorEvidence {
            from_kind: FromKind::User,
            from_agent_id: None,
            from_user_id: None,
            author_id: Some(USER_FK.to_owned()),
            author_name: Some("human".to_owned()),
            author_display_name: None,
        };
        let MessageAuthor::Deleted(deleted) = resolve_author(&evidence, None).unwrap().unwrap()
        else {
            panic!("expected a deleted author");
        };
        assert_eq!(deleted.display_name(), "human");
    }

    #[test]
    fn a_nulled_fk_with_no_snapshot_is_unresolved_and_non_aggregating() {
        let evidence = AuthorEvidence {
            from_kind: FromKind::Agent,
            from_agent_id: None,
            from_user_id: None,
            author_id: None,
            author_name: None,
            author_display_name: None,
        };
        let author = resolve_author(&evidence, None).unwrap().unwrap();
        assert!(matches!(author, MessageAuthor::Unresolved(_)));
        assert_eq!(author.stable_identity(), None);
    }

    #[test]
    fn the_avatar_key_is_read_by_js_truthiness_null_and_empty_alike_mean_none() {
        let evidence = live_evidence(FromKind::User);
        let avatar_of = |key: Option<&str>| {
            let live = LiveActor {
                name: "human".to_owned(),
                display_name: "Human".to_owned(),
                avatar_storage_key: key.map(str::to_owned),
                updated_at: 42,
                runtime: None,
            };
            let MessageAuthor::Active(ActiveAuthor::Human(human)) =
                resolve_author(&evidence, Some(&live)).unwrap().unwrap()
            else {
                panic!("expected an active human");
            };
            human.avatar().map(|a| a.cache_buster())
        };

        assert_eq!(avatar_of(None), None, "NULL key ⇒ no avatar");
        assert_eq!(avatar_of(Some("")), None, "empty key ⇒ no avatar");
        assert_eq!(avatar_of(Some("k")), Some(42), "non-empty key ⇒ revision");
    }
}
