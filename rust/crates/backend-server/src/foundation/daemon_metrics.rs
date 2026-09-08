//! Metrics follow the lifetime of the actual socket, including cancelled tasks.
use axum::extract::ws::{Message, WebSocket};

pub(super) fn connection(stage: &'static str, outcome: impl Into<metrics::SharedString>) {
    metrics::counter!(
        "silverhand_host_ws_connections_total",
        "stage" => stage,
        "outcome" => outcome.into(),
    )
    .increment(1);
}

pub(super) struct ObservedDaemonSocket {
    inner: WebSocket,
    open: metrics::Gauge,
    ready: Option<metrics::Gauge>,
    close: (u16, &'static str),
}

impl ObservedDaemonSocket {
    pub(super) fn new(inner: WebSocket) -> Self {
        connection("upgrade", "accepted");
        let open =
            metrics::gauge!("silverhand_host_ws_connections_current", "state" => "websocket_open");
        open.increment(1.);

        Self {
            inner,
            open,
            ready: None,
            close: (1006, "no_reason"),
        }
    }

    pub(super) fn ready(&mut self, version: u32) {
        connection("ready", format!("protocol_{version}"));
        if self.ready.is_none() {
            let gauge = metrics::gauge!(
                "silverhand_host_ws_ready_connections_current",
                "protocol_version" => version.to_string(),
            );
            gauge.increment(1.);
            self.ready = Some(gauge);
        }
    }

    fn close_frame(message: &Message) -> Option<(u16, &'static str)> {
        let Message::Close(frame) = message else {
            return None;
        };
        Some(
            frame
                .as_ref()
                .map(|frame| (frame.code, close_reason(frame.code, frame.reason.as_str())))
                .unwrap_or((1005, "no_reason")),
        )
    }

    pub(super) async fn send(&mut self, message: Message) -> Result<(), axum::Error> {
        let close = Self::close_frame(&message);
        let result = self.inner.send(message).await;

        // A failed write is an abnormal transport close, not a delivered close code.
        if result.is_ok()
            && let Some(close) = close
        {
            self.close = close;
        }

        result
    }

    pub(super) async fn recv(&mut self) -> Option<Result<Message, axum::Error>> {
        let result = self.inner.recv().await;

        if let Some(Ok(message)) = &result
            && let Some(close) = Self::close_frame(message)
        {
            self.close = close;
        }

        result
    }
}

impl Drop for ObservedDaemonSocket {
    fn drop(&mut self) {
        self.open.decrement(1.);
        if let Some(ready) = &self.ready {
            ready.decrement(1.);
        }

        let code = match self.close.0 {
            1000 => "1000",
            1001 => "1001",
            1002 => "1002",
            1006 => "1006",
            1008 => "1008",
            1011 => "1011",
            _ => "other",
        };
        metrics::counter!(
            "silverhand_host_ws_closes_total",
            "code" => code,
            "reason" => self.close.1,
        )
        .increment(1);
    }
}

fn close_reason(code: u16, reason: &str) -> &'static str {
    match reason {
        "server_shutdown" => "server_shutdown",
        "host_revoked" => "host_revoked",
        "host_disconnected" => "host_disconnected",
        "host_connection_replaced" => "host_connection_replaced",
        "heartbeat_timeout" => "heartbeat_timeout",
        _ if reason == super::daemon_transport::UPDATE_REQUIRED_CLOSE_REASON => "update_required",
        _ if code == 1002 => "protocol_error",
        _ if code == 1000 => "normal",
        "" => "no_reason",
        _ => "other",
    }
}
