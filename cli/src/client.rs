use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use anyhow::{Context as AnyhowCtx, Result, bail};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::Request;
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo};

use crate::paths;

// Unix socket connector for hyper 1.x
#[derive(Clone)]
pub struct UnixConnector {
    path: Arc<str>,
}

impl tower::Service<hyper::Uri> for UnixConnector {
    type Response = TokioIo<tokio::net::UnixStream>;
    type Error = std::io::Error;
    type Future = Pin<Box<dyn Future<Output = std::result::Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<std::result::Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, _uri: hyper::Uri) -> Self::Future {
        let path = self.path.clone();
        Box::pin(async move {
            let stream = tokio::net::UnixStream::connect(&*path).await?;
            Ok(TokioIo::new(stream))
        })
    }
}

pub type HttpClient = Client<UnixConnector, Full<Bytes>>;

pub fn make_client() -> HttpClient {
    let sock_path: Arc<str> = paths::socket_path().to_string_lossy().into_owned().into();
    let connector = UnixConnector { path: sock_path };
    Client::builder(TokioExecutor::new()).build(connector)
}

pub async fn get(client: &HttpClient, path: &str) -> Result<serde_json::Value> {
    let uri = format!("http://localhost{path}");
    let resp = client
        .get(uri.parse().context("invalid URI")?)
        .await
        .context("failed to connect to latticed — is it running? (`lattice daemon start`)")?;
    let status = resp.status();
    let body = resp.into_body().collect().await?.to_bytes();
    let val: serde_json::Value = serde_json::from_slice(&body)?;
    if !status.is_success() {
        bail!("{}", val.get("error").and_then(|e| e.as_str()).unwrap_or("unknown error"));
    }
    Ok(val)
}

pub async fn request(
    client: &HttpClient,
    method: &str,
    path: &str,
    json_body: Option<serde_json::Value>,
) -> Result<serde_json::Value> {
    let uri: hyper::Uri = format!("http://localhost{path}").parse().context("invalid URI")?;
    let mut builder = Request::builder().method(method).uri(uri);

    let body = if let Some(json) = json_body {
        builder = builder.header("content-type", "application/json");
        Full::new(Bytes::from(serde_json::to_vec(&json)?))
    } else {
        Full::new(Bytes::new())
    };

    let req = builder.body(body).context("failed to build request")?;
    let resp = client
        .request(req)
        .await
        .context("failed to connect to latticed — is it running? (`lattice daemon start`)")?;
    let status = resp.status();
    let body_bytes = resp.into_body().collect().await?.to_bytes();

    if body_bytes.is_empty() {
        return Ok(serde_json::json!({}));
    }
    let val: serde_json::Value = serde_json::from_slice(&body_bytes)?;
    if !status.is_success() {
        bail!("{}", val.get("error").and_then(|e| e.as_str()).unwrap_or("unknown error"));
    }
    Ok(val)
}

/// SSE wait-approval: connects to /phases/:id/events and blocks until approved/timeout.
pub async fn sse_wait_approval(
    client: &HttpClient,
    phase_id: &str,
    timeout: u64,
) -> Result<serde_json::Value> {
    let path = format!("/phases/{phase_id}/events?timeout={timeout}");
    let uri: hyper::Uri = format!("http://localhost{path}").parse().context("invalid URI")?;
    let resp = client
        .get(uri)
        .await
        .context("failed to connect to latticed — is it running? (`lattice daemon start`)")?;

    if !resp.status().is_success() {
        let body = resp.into_body().collect().await?.to_bytes();
        bail!("SSE request failed: {}", String::from_utf8_lossy(&body));
    }

    // Read SSE body frame by frame
    let mut body = resp.into_body();
    let mut buffer = String::new();
    let mut current_event = String::new();
    let mut current_data = String::new();

    loop {
        let frame_opt = body.frame().await;
        match frame_opt {
            Some(Ok(frame)) => {
                if let Some(data) = frame.data_ref() {
                    buffer.push_str(&String::from_utf8_lossy(data));

                    while let Some(pos) = buffer.find('\n') {
                        let line = buffer[..pos].to_string();
                        buffer = buffer[pos + 1..].to_string();

                        if line.is_empty() {
                            if !current_data.is_empty() {
                                let evt = std::mem::take(&mut current_event);
                                let dat = std::mem::take(&mut current_data);
                                match evt.as_str() {
                                    "approved" => {
                                        return Ok(serde_json::from_str(&dat)?);
                                    }
                                    "error" => {
                                        bail!("SSE error: {dat}");
                                    }
                                    "timeout" => {
                                        bail!("timeout waiting for approval of {phase_id}");
                                    }
                                    _ => {
                                        // "waiting" 등 — 계속 대기
                                        eprintln!("lattice: waiting for approval of {phase_id}...");
                                    }
                                }
                            }
                        } else if let Some(val) = line.strip_prefix("event: ") {
                            current_event = val.to_string();
                        } else if let Some(val) = line.strip_prefix("data: ") {
                            current_data = val.to_string();
                        }
                    }
                }
            }
            Some(Err(e)) => bail!("SSE stream error: {e}"),
            None => bail!("SSE stream ended unexpectedly"),
        }
    }
}
