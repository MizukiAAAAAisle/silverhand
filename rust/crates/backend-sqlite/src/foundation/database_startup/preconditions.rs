//! Native equivalents of the shared plan's nine procedural preconditions.
//! DDL/data SQL remains generated from that plan; persisted-name keying reuses
//! the same pinned core normalization/fold as ordinary Rust writers.
use super::{DatabaseStartupError, HashSet};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use silverhand_backend_core::foundation::name_canonicalization::canonicalize_stored_name;
use sqlx::{Executor, Row, SqliteConnection};

pub(super) async fn run(db: &mut SqliteConnection, step: i64) -> Result<(), DatabaseStartupError> {
    match step {
        53 => reject_count(db, "SELECT COUNT(*) FROM conversations WHERE kind='thread' OR parent_conversation_id IS NOT NULL", "step53 legacy thread fossils remain").await?,
        54 => reject_count(db, "SELECT COUNT(*) FROM conversations WHERE parent_conversation_id IS NOT NULL", "step54 parent conversation references remain").await?,
        71 => {
            db.execute("DROP TABLE IF EXISTS temp.agent_inbox_backfill; CREATE TEMP TABLE agent_inbox_backfill(agent_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL UNIQUE)").await?;
            let agents: Vec<String> = sqlx::query_scalar("SELECT id FROM agents").fetch_all(&mut *db).await?;
            for agent in agents {
                let mut bytes = [0u8; 12];
                getrandom::fill(&mut bytes).map_err(|e| DatabaseStartupError::Integrity(format!("inbox ID entropy: {e}")))?;
                sqlx::query("INSERT INTO temp.agent_inbox_backfill(agent_id,conversation_id) VALUES(?,?)")
                    .bind(agent).bind(URL_SAFE_NO_PAD.encode(bytes)).execute(&mut *db).await?;
            }
        }
        72 => {
            audit_titles(db, false).await?;
            db.execute("DROP TABLE IF EXISTS temp.conversation_title_backfill; CREATE TEMP TABLE conversation_title_backfill(conversation_id TEXT PRIMARY KEY,title TEXT NOT NULL,title_key TEXT NOT NULL)").await?;
            let rows = sqlx::query("SELECT id,title FROM conversations WHERE placement_kind='workspace' ORDER BY workspace_id,created_at,id").fetch_all(&mut *db).await?;
            for row in rows {
                let id: String = row.try_get("id")?;
                let (title,key) = canonicalize_stored_name(&row.try_get::<String,_>("title")?);
                sqlx::query("INSERT INTO temp.conversation_title_backfill(conversation_id,title,title_key) VALUES(?,?,?)")
                    .bind(id).bind(title).bind(key).execute(&mut *db).await?;
            }
        }
        76 => reject_count(db, "SELECT COUNT(*) FROM tasks t LEFT JOIN conversations c ON c.id=t.conversation_id WHERE c.id IS NULL OR t.workspace_id IS NOT c.workspace_id", "step76 task owner missing or workspace mismatch").await?,
        78 => {
            audit_workspaces(db, false).await?;
            db.execute("DROP TABLE IF EXISTS temp.workspace_name_backfill; CREATE TEMP TABLE workspace_name_backfill(workspace_id TEXT PRIMARY KEY,name TEXT NOT NULL,name_key TEXT NOT NULL)").await?;
            let rows = sqlx::query("SELECT id,name FROM workspaces WHERE workspace_kind='regular' ORDER BY created_at,id").fetch_all(&mut *db).await?;
            for row in rows {
                let id: String = row.try_get("id")?;
                let (name,key) = canonicalize_stored_name(&row.try_get::<String,_>("name")?);
                sqlx::query("INSERT INTO temp.workspace_name_backfill(workspace_id,name,name_key) VALUES(?,?,?)")
                    .bind(id).bind(name).bind(key).execute(&mut *db).await?;
            }
        }
        79 => reject_count(db, "SELECT COUNT(*) FROM (SELECT user_id, CASE WHEN SUBSTR(entity_id,1,8)='channel:' THEN 'conversation:'||SUBSTR(entity_id,9) WHEN SUBSTR(entity_id,1,11)='dm_channel:' THEN 'conversation:'||SUBSTR(entity_id,12) ELSE entity_id END AS canonical_key FROM user_sort_entry WHERE list_key='favorites' GROUP BY user_id,canonical_key HAVING COUNT(*)>1)", "step79 favorite keys collide after conversation-kind retirement").await?,
        81 => reject_count(db, "SELECT COUNT(*) FROM saved_messages sm JOIN conversations c ON c.id=sm.conversation_id WHERE sm.workspace_id IS NOT c.workspace_id", "step81 saved-message workspace mismatch").await?,
        87 => reject_count(db, "SELECT COUNT(*) FROM messages m WHERE m.task_number IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.id=m.id)", "step87 retired task carrier has no canonical task; restore backfill before upgrading").await?,
        96 => {
            use silverhand_backend_core::conversation_messaging::messaging::task::TaskTitle;

            db.execute("CREATE TEMP TABLE task_title_backfill (id TEXT PRIMARY KEY, title TEXT NOT NULL)").await?;
            let rows = sqlx::query("SELECT id, title FROM tasks").fetch_all(&mut *db).await?;
            for row in rows {
                let id: String = row.try_get("id")?;
                let raw: String = row.try_get("title")?;
                let title = TaskTitle::parse(&raw).map_err(|_| DatabaseStartupError::Integrity(
                    "step96: tasks.title cannot satisfy the canonical title contract".to_owned()
                ))?;
                if title.as_str() != raw {
                    sqlx::query("INSERT INTO task_title_backfill VALUES (?, ?)")
                        .bind(id).bind(title.as_str()).execute(&mut *db).await?;
                }
            }
        }
        _ => return Err(DatabaseStartupError::Integrity(format!("unimplemented migration precondition {step}"))),
    }
    Ok(())
}

async fn reject_count(
    db: &mut SqliteConnection,
    sql: &'static str,
    reason: &str,
) -> Result<(), DatabaseStartupError> {
    let count: i64 = sqlx::query_scalar(sql).fetch_one(db).await?;
    if count > 0 {
        return Err(DatabaseStartupError::Integrity(format!(
            "{reason}: {count} rows"
        )));
    }
    Ok(())
}

pub(super) async fn audit_addresses(
    db: &mut SqliteConnection,
    titles: bool,
    workspaces: bool,
) -> Result<(), DatabaseStartupError> {
    if titles {
        audit_titles(db, true).await?;
    }
    if workspaces {
        audit_workspaces(db, true).await?;
    }
    Ok(())
}

async fn audit_titles(
    db: &mut SqliteConnection,
    keys_expected: bool,
) -> Result<(), DatabaseStartupError> {
    let sql = if keys_expected {
        "SELECT id,workspace_id,title,title_key FROM conversations WHERE placement_kind='workspace' ORDER BY workspace_id,created_at,id"
    } else {
        "SELECT id,workspace_id,title,NULL AS title_key FROM conversations WHERE placement_kind='workspace' ORDER BY workspace_id,created_at,id"
    };
    let rows = sqlx::query(sql).fetch_all(db).await?;
    let mut seen = HashSet::new();
    for row in rows {
        let id: String = row.try_get("id")?;
        let workspace: String = row.try_get("workspace_id")?;
        let title: String = row.try_get("title")?;
        let (display, key) = canonicalize_stored_name(&title);
        if !seen.insert((workspace, key.clone())) {
            return Err(DatabaseStartupError::Integrity(format!(
                "title folded_collision at {id}"
            )));
        }
        if keys_expected {
            let stored: Option<String> = row.try_get("title_key")?;
            if stored.as_deref() != Some(&key) {
                return Err(DatabaseStartupError::Integrity(format!(
                    "title missing/stale_key at {id}"
                )));
            }
            if display != title {
                return Err(DatabaseStartupError::Integrity(format!(
                    "unnormalized_title at {id}"
                )));
            }
        }
    }
    Ok(())
}

async fn audit_workspaces(
    db: &mut SqliteConnection,
    keys_expected: bool,
) -> Result<(), DatabaseStartupError> {
    let sql = if keys_expected {
        "SELECT id,owner_agent_id,name,name_key FROM workspaces ORDER BY created_at,id"
    } else {
        "SELECT id,owner_agent_id,name,NULL AS name_key FROM workspaces ORDER BY created_at,id"
    };
    let rows = sqlx::query(sql).fetch_all(db).await?;
    let mut seen = HashSet::new();
    for row in rows {
        let id: String = row.try_get("id")?;
        let owner: Option<String> = row.try_get("owner_agent_id")?;
        let stored: Option<String> = row.try_get("name_key")?;
        if owner.is_some() {
            if keys_expected && stored.is_some() {
                return Err(DatabaseStartupError::Integrity(format!(
                    "agent_home_has_key at {id}"
                )));
            }
            continue;
        }
        let name: String = row.try_get("name")?;
        let (display, key) = canonicalize_stored_name(&name);
        if !seen.insert(key.clone()) {
            return Err(DatabaseStartupError::Integrity(format!(
                "workspace folded_collision at {id}"
            )));
        }
        if keys_expected {
            if stored.as_deref() != Some(&key) {
                return Err(DatabaseStartupError::Integrity(format!(
                    "workspace missing/stale_key at {id}"
                )));
            }
            if display != name {
                return Err(DatabaseStartupError::Integrity(format!(
                    "unnormalized_name at {id}"
                )));
            }
        }
    }
    Ok(())
}
