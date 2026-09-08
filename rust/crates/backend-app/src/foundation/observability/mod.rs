//! Process metrics composition. Libraries emit through the metrics facade; only
//! this executable installs a recorder and owns its private listener and upkeep.
use crate::{AppConfig, ConfigError, StartupError};
use axum::{
    Router,
    body::Body,
    extract::{MatchedPath, Request, State},
    middleware::Next,
    response::Response,
    routing::get,
};
use metrics_exporter_prometheus::{
    Matcher, PrometheusBuilder, PrometheusHandle, PrometheusRecorder,
};
use silverhand_backend_server::application_orchestration::daemon_delivery::OUTBOUND_PROTOCOL_VERSION;
use std::{
    net::SocketAddr,
    time::{Duration, Instant},
};
use tokio::{net::TcpListener, sync::oneshot};

const HTTP_BUCKETS: &[f64] = &[
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1., 2.5, 5., 10., 30.,
];
const DB_BUCKETS: &[f64] = &[
    0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1., 2.5, 5.,
];

pub(crate) fn parse_listen(raw: Option<&str>) -> Result<Option<SocketAddr>, ConfigError> {
    let Some(raw) = raw.filter(|raw| !raw.is_empty()) else {
        return Ok(None);
    };
    let address: SocketAddr = raw
        .trim()
        .parse()
        .map_err(|_| ConfigError::InvalidMetricsListen)?;
    if !address.ip().is_loopback() {
        return Err(ConfigError::InvalidMetricsListen);
    }
    Ok(Some(address))
}

fn recorder(deployment: &'static str) -> PrometheusRecorder {
    PrometheusBuilder::new()
        .add_global_label("deployment_mode", deployment)
        .set_buckets(HTTP_BUCKETS)
        .expect("static nonempty buckets")
        .set_buckets_for_metric(Matcher::Prefix("silverhand_db_".into()), DB_BUCKETS)
        .expect("static nonempty buckets")
        .build_recorder()
}

pub(crate) struct MetricsEndpoint {
    listener: TcpListener,
    handle: PrometheusHandle,
}

pub(crate) async fn prepare_metrics(
    config: &AppConfig,
) -> Result<Option<MetricsEndpoint>, StartupError> {
    let Some(address) = config.metrics_listen else {
        return Ok(None);
    };
    let listener = bind_metrics_listener(address).await?;
    let recorder = recorder(config.deployment_profile.deployment_mode().as_str());
    let handle = recorder.handle();
    metrics::set_global_recorder(recorder).map_err(|source| StartupError::Composition {
        name: "Prometheus recorder",
        source: Box::new(source),
    })?;

    for (name, help) in [
        (
            "silverhand_http_request_duration_seconds",
            "HTTP response duration by normalized route.",
        ),
        (
            "silverhand_db_statement_duration_seconds",
            "Named SQLite statement duration including pool and lock wait.",
        ),
        (
            "silverhand_db_readiness_probe_duration_seconds",
            "Duration of the SQLite readiness write probe.",
        ),
        (
            "silverhand_daemon_command_duration_seconds",
            "Server-to-daemon command duration by command and outcome.",
        ),
    ] {
        metrics::describe_histogram!(name, metrics::Unit::Seconds, help);
    }

    for (name, help) in [
        (
            "silverhand_host_ws_connections_total",
            "Host WebSocket upgrade and ready lifecycle gates.",
        ),
        (
            "silverhand_host_ws_closes_total",
            "Host WebSocket closes by bounded code and reason.",
        ),
        (
            "silverhand_host_ws_protocol_mismatch_total",
            "Host ready frames offering unsupported protocol versions.",
        ),
    ] {
        metrics::describe_counter!(name, help);
    }

    metrics::describe_gauge!(
        "silverhand_host_ws_connections_current",
        "Current open host WebSocket connections."
    );
    metrics::describe_gauge!(
        "silverhand_host_ws_ready_connections_current",
        "Current wire-compatible host WebSocket connections."
    );
    metrics::describe_gauge!(
        "silverhand_tokio_scheduling_delay_seconds",
        metrics::Unit::Seconds,
        "Lateness of the most recent five-second Tokio timer."
    );
    metrics::gauge!("silverhand_host_ws_connections_current", "state" => "websocket_open").set(0.);

    // Register real zero populations; no observations are synthesized to seed histograms.
    metrics::gauge!(
        "silverhand_host_ws_ready_connections_current",
        "protocol_version" => OUTBOUND_PROTOCOL_VERSION.to_string(),
    )
    .set(0.);
    Ok(Some(MetricsEndpoint { listener, handle }))
}

async fn bind_metrics_listener(address: SocketAddr) -> Result<TcpListener, StartupError> {
    TcpListener::bind(address).await.map_err(StartupError::Bind)
}

async fn scrape(
    State(handle): State<PrometheusHandle>,
) -> ([(&'static str, &'static str); 1], String) {
    (
        [("content-type", "text/plain; version=0.0.4; charset=utf-8")],
        handle.render(),
    )
}

impl MetricsEndpoint {
    pub(crate) async fn serve_metrics(self, stop: oneshot::Receiver<()>) -> std::io::Result<()> {
        let upkeep = self.handle.clone();
        let router = Router::new()
            .route("/metrics", get(scrape))
            .with_state(self.handle);
        let server = axum::serve(self.listener, router).with_graceful_shutdown(async {
            let _ = stop.await;
        });
        let maintenance = async move {
            let process = metrics_process::Collector::default();
            process.describe();
            // A scrape outage must not leave raw histogram observations accumulating.
            let mut tick = tokio::time::interval(Duration::from_secs(5));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                let scheduled = tick.tick().await;
                let now = tokio::time::Instant::now();
                metrics::gauge!("silverhand_tokio_scheduling_delay_seconds")
                    .set(now.saturating_duration_since(scheduled).as_secs_f64());
                process.collect();
                upkeep.run_upkeep();
            }
        };
        tokio::select! { result = server => result, _ = maintenance => unreachable!() }
    }
}

struct HttpObservation {
    started: Instant,
    histogram: metrics::Histogram,
}

impl Drop for HttpObservation {
    fn drop(&mut self) {
        self.histogram.record(self.started.elapsed().as_secs_f64());
    }
}

pub(crate) async fn observe_http(request: Request, next: Next) -> Response {
    let started = Instant::now();
    let method = match request.method().as_str() {
        "GET" => "GET",
        "POST" => "POST",
        "PUT" => "PUT",
        "PATCH" => "PATCH",
        "DELETE" => "DELETE",
        "HEAD" => "HEAD",
        "OPTIONS" => "OPTIONS",
        "CONNECT" => "CONNECT",
        "TRACE" => "TRACE",
        _ => "OTHER",
    };
    // MatchedPath is the router's template, never URI/user input. Preserve the
    // existing Express-style label spelling while Axum uses {parameter} syntax.
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|path| normalize_route(path.as_str()))
        .unwrap_or_else(|| "unmatched".into());

    let response = next.run(request).await;

    let status = match response.status().as_u16() / 100 {
        1 => "1xx",
        2 => "2xx",
        3 => "3xx",
        4 => "4xx",
        5 => "5xx",
        _ => "unknown",
    };
    let observation = HttpObservation {
        started,
        histogram: metrics::histogram!(
            "silverhand_http_request_duration_seconds",
            "method" => method,
            "route" => route,
            "status_class" => status,
        ),
    };

    let (parts, body) = response.into_parts();
    // Time streaming responses through end-of-stream (or client cancellation),
    // not merely until the handler has returned headers.
    Response::from_parts(
        parts,
        Body::new(ObservedBody {
            body,
            observation: Some(observation),
        }),
    )
}

struct ObservedBody {
    body: Body,
    observation: Option<HttpObservation>,
}

impl http_body::Body for ObservedBody {
    type Data = axum::body::Bytes;
    type Error = axum::Error;
    fn poll_frame(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        let this = self.get_mut();
        let result = std::pin::Pin::new(&mut this.body).poll_frame(cx);
        if matches!(&result, std::task::Poll::Ready(None | Some(Err(_))))
            || this.body.is_end_stream()
        {
            this.observation.take();
        }
        result
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.body.size_hint()
    }
}

fn normalize_route(template: &str) -> String {
    template
        .split('/')
        .map(|part| {
            if let Some(parameter) = part
                .strip_prefix('{')
                .and_then(|part| part.strip_suffix('}'))
            {
                format!(":{}", parameter.trim_start_matches('*'))
            } else {
                part.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn http_observation_waits_for_body_and_preserves_trailers_and_status() {
        use http_body_util::BodyExt;
        use tower::ServiceExt;
        let recorder = recorder("standalone");
        let _guard = metrics::set_default_local_recorder(&recorder);
        let app = Router::new()
            .route(
                "/items/{id}",
                get(|| async {
                    let mut trailers = axum::http::HeaderMap::new();
                    trailers.insert("x-proof", "retained".parse().unwrap());
                    let frames = futures_util::stream::iter(vec![
                        Ok::<_, std::io::Error>(http_body::Frame::data(
                            axum::body::Bytes::from_static(b"payload"),
                        )),
                        Ok(http_body::Frame::trailers(trailers)),
                    ]);
                    Response::builder()
                        .status(503)
                        .header("x-handler", "unchanged")
                        .body(Body::new(http_body_util::StreamBody::new(frames)))
                        .unwrap()
                }),
            )
            .layer(axum::middleware::from_fn(observe_http));
        let response = app
            .oneshot(
                Request::get("/items/private-id?secret=hidden")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 503);
        assert_eq!(response.headers()["x-handler"], "unchanged");
        let before = recorder.handle().render();
        assert!(!before.lines().any(|line| {
            line.starts_with("silverhand_http_request_duration_seconds_count")
                && line.ends_with(" 1")
        }));
        let body = response.into_body().collect().await.unwrap();
        assert_eq!(body.trailers().unwrap()["x-proof"], "retained");
        assert_eq!(body.to_bytes(), "payload");
        let after = recorder.handle().render();
        let count = after
            .lines()
            .find(|line| line.starts_with("silverhand_http_request_duration_seconds_count{"))
            .unwrap();
        assert!(count.contains("route=\"/items/:id\""));
        assert!(count.contains("status_class=\"5xx\""));
        assert!(count.ends_with(" 1"));
        assert!(!after.contains("private-id"));
        assert!(!after.contains("hidden"));
    }

    #[test]
    fn private_address_contract() {
        for address in ["127.0.0.1:9464", "[::1]:9464", "127.0.0.2:0"] {
            assert!(parse_listen(Some(address)).unwrap().is_some());
        }
        for address in [
            "0.0.0.0:9464",
            "[::]:9464",
            "192.168.1.1:9464",
            "localhost:9464",
            " ",
            "bad",
        ] {
            assert!(parse_listen(Some(address)).is_err());
        }
        assert_eq!(parse_listen(None).unwrap(), None);
        assert_eq!(parse_listen(Some("")).unwrap(), None);
    }
    #[test]
    fn histogram_wire_contract() {
        let recorder = recorder("standalone");
        metrics::with_local_recorder(&recorder, || {
            metrics::histogram!(
                "silverhand_db_statement_duration_seconds",
                "query_name" => "hosts.get_by_id",
                "operation" => "get",
                "outcome" => "busy",
            )
            .record(0.003);
        });

        let text = recorder.handle().render();
        assert!(text.contains("# TYPE silverhand_db_statement_duration_seconds histogram"));
        assert!(text.contains("deployment_mode=\"standalone\""));
        assert!(text.contains("le=\"0.0025\""));
        assert!(text.contains("silverhand_db_statement_duration_seconds_count"));
    }
}
