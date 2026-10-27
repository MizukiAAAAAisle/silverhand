//! Host-runtime status and host-connection scope-event projection.

use serde_json::{Map, Value, json};
use silverhand_backend_core::foundation::{
    identity::{HostId, UserId},
    scope_event::EventScope,
};

use crate::{
    foundation::{
        scope_event_transport::ScopeEventHub,
        scope_event_wire::{NotificationEvent, NotificationKind, ProductEvent},
    },
    host_runtime::runtime_event_settlement::{
        LiveProjectionFailure, RuntimeStatusProjectionFact, RuntimeStatusProjectionPort,
        RuntimeStatusProjectionUpdate,
    },
};

#[derive(Clone)]
pub struct HubRuntimeStatusPublisher(ScopeEventHub);

impl ScopeEventHub {
    pub fn runtime_status_publisher(&self) -> HubRuntimeStatusPublisher {
        HubRuntimeStatusPublisher(self.clone())
    }
}

impl RuntimeStatusProjectionPort for HubRuntimeStatusPublisher {
    fn publish_host_connection_changed(
        &self,
        owner: &UserId,
        host: &HostId,
    ) -> Result<(), LiveProjectionFailure> {
        self.0
            .publish(
                EventScope::Viewer(owner.clone()),
                ProductEvent::HostConnectionChanged {
                    host_id: host.as_str().to_owned(),
                },
            )
            .map_err(LiveProjectionFailure::from_source)
    }

    fn publish_start_failure(&self, owner: &UserId) -> Result<(), LiveProjectionFailure> {
        self.0
            .publish(
                EventScope::Viewer(owner.clone()),
                ProductEvent::Notification(NotificationEvent {
                    kind: NotificationKind::AgentStartFailed,
                    conversation_id: None,
                    message_id: None,
                }),
            )
            .map_err(LiveProjectionFailure::from_source)
    }

    fn publish(&self, fact: RuntimeStatusProjectionFact) -> Result<(), LiveProjectionFailure> {
        let (payload, origin_payload) = status_payload(fact.update);
        let mut first_failure = None;
        for target in fact.targets {
            let mut object = payload.clone();
            if target.carries_origin_detail()
                && let Some(detail) = origin_payload.as_ref()
            {
                object.extend(detail.clone());
            }
            object.insert(
                "agent_id".into(),
                Value::String(fact.agent.as_str().to_owned()),
            );
            if let Err(cause) = self.0.publish(
                EventScope::ConversationSide(target.conversation().clone()),
                ProductEvent::AgentStatus(Value::Object(object)),
            ) && first_failure.is_none()
            {
                first_failure = Some(LiveProjectionFailure::from_source(cause));
            }
        }
        first_failure.map_or(Ok(()), Err)
    }
}

fn status_payload(
    update: RuntimeStatusProjectionUpdate,
) -> (Map<String, Value>, Option<Map<String, Value>>) {
    match update {
        RuntimeStatusProjectionUpdate::Active { cli_session_id } => {
            let mut payload = Map::from_iter([("status".into(), json!("active"))]);
            if let Some(cli_session_id) = cli_session_id {
                payload.insert("cli_session_id".into(), json!(cli_session_id));
            }
            (payload, None)
        }
        RuntimeStatusProjectionUpdate::StartingRetry {
            retry_attempt,
            max_retries,
            timeout_reason,
        } => (
            Map::from_iter([
                ("status".into(), json!("starting")),
                ("reason".into(), json!("init_timeout_retrying")),
                ("retry_attempt".into(), json!(retry_attempt)),
                ("max_retries".into(), json!(max_retries)),
                (
                    "timeout_reason".into(),
                    json!(timeout_reason.map(|reason| reason.as_str())),
                ),
            ]),
            None,
        ),
        RuntimeStatusProjectionUpdate::CrashedCooldown {
            cooldown_until,
            attempts_exhausted,
        } => (
            Map::from_iter([
                ("status".into(), json!("crashed")),
                ("reason".into(), json!("init_cooldown")),
                ("cooldown_until".into(), json!(cooldown_until)),
                ("attempts_exhausted".into(), json!(attempts_exhausted)),
            ]),
            None,
        ),
        RuntimeStatusProjectionUpdate::Exit {
            status,
            code,
            intentional,
            clear_cli_session_id,
            run_state,
        } => {
            let mut payload = Map::from_iter([
                ("status".into(), json!(status.as_str())),
                ("exit_code".into(), json!(code)),
                ("intentional".into(), json!(intentional)),
            ]);
            if clear_cli_session_id {
                payload.insert("cli_session_id".into(), Value::Null);
            }
            (
                payload,
                Some(Map::from_iter([("run_state".into(), json!(run_state))])),
            )
        }
    }
}
