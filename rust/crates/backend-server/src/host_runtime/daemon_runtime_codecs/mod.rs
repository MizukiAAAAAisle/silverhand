//! Runtime lifecycle command codecs owned by the host-runtime context.

use serde_json::{Value, json};
use silverhand_backend_core::{
    host_runtime::runtime_credential::RuntimeScope,
    identity::AgentId,
    runtime_delivery::{RuntimeMember, RuntimePlacement, RuntimeRoster, RuntimeSpawnPlan},
};

pub(crate) mod runtime_clear_session;
pub(crate) mod runtime_start;
pub(crate) mod runtime_stop;

pub(crate) fn spawn_options(plan: &RuntimeSpawnPlan, token: &str) -> Value {
    let common = json!({
        "agent": { "id": plan.agent.id.as_str(), "name": plan.agent.name },
        "driver": {
            "kind": plan.agent.runtime.as_str(),
            "cli_session_id": plan.agent.cli_session_id,
            "model": plan.agent.model,
            "reasoning_effort": plan.agent.reasoning_effort,
            "fast_mode": plan.agent.fast_mode,
        },
        "env_policy": { "silverhand": { "auth_token": token } },
    });
    let mut object = common.as_object().cloned().expect("object literal");
    object.insert("runtime_scope".to_owned(), scope_wire(&plan.scope));
    if let Some(session) = &plan.session {
        object.insert(
            "workspace".to_owned(),
            plan.workspace.as_ref().map_or(Value::Null, workspace_wire),
        );
        object.insert(
            "workspace_memory_index".to_owned(),
            Value::Array(
                plan.workspace_memory_index
                    .iter()
                    .map(workspace_wire)
                    .collect(),
            ),
        );
        object.insert("session".to_owned(), session_wire(session));
    }
    Value::Object(object)
}

pub(crate) fn scope_wire(scope: &RuntimeScope) -> Value {
    match scope {
        RuntimeScope::ConversationSlot { agent, source } => json!({
            "kind": "conversation", "conversation_id": source.as_str(), "agent_id": agent.as_str()
        }),
        RuntimeScope::AgentSlot { agent } => json!({ "kind": "agent", "agent_id": agent.as_str() }),
    }
}

pub(crate) fn workspace_wire(
    workspace: &silverhand_backend_core::runtime_delivery::RuntimeWorkspaceRef,
) -> Value {
    json!({ "id": workspace.id().as_str(), "name": workspace.name() })
}

fn session_wire(session: &silverhand_backend_core::runtime_delivery::RuntimeSessionSpec) -> Value {
    let members = session
        .members
        .iter()
        .map(|member| match member {
            RuntimeMember::Agent {
                id,
                name,
                display_name,
                runtime,
            } => json!({
                "kind": "agent", "agent_id": id.as_str(), "name": name,
                "display_name": display_name, "runtime": runtime.as_str(),
            }),
            RuntimeMember::Human {
                id,
                name,
                display_name,
            } => json!({
                "kind": "human", "user_id": id.as_str(), "name": name,
                "display_name": display_name, "avatar_url": Value::Null,
            }),
        })
        .collect::<Vec<_>>();
    json!({
        "conversation_id": session.conversation.as_str(),
        "placement_kind": match session.placement { RuntimePlacement::Workspace => "workspace", RuntimePlacement::DirectPair => "direct_pair" },
        "roster_policy": match session.roster { RuntimeRoster::Open => "open", RuntimeRoster::Fixed => "fixed" },
        "title": session.title,
        "spawned_by_agent_id": session.spawned_by_agent.as_ref().map(AgentId::as_str),
        "members": members,
    })
}
