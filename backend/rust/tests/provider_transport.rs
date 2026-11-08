use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use graphy_core::provider_runtime;
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::mpsc;
#[derive(Clone)]
struct Fixture {
    body: Vec<u8>,
    status: StatusCode,
    requests: Arc<Mutex<Vec<(HeaderMap, Value)>>>,
}
async fn handler(
    State(f): State<Fixture>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<Value>,
) -> Response {
    f.requests.lock().unwrap().push((headers, body));
    (
        f.status,
        [("content-type", "text/event-stream"), ("retry-after", "3")],
        f.body,
    )
        .into_response()
}
async fn server(body: &str, status: StatusCode) -> (String, Arc<Mutex<Vec<(HeaderMap, Value)>>>) {
    let requests = Arc::new(Mutex::new(vec![]));
    let fixture = Fixture {
        body: body.as_bytes().to_vec(),
        status,
        requests: requests.clone(),
    };
    let app = Router::new()
        .route("/v1/chat/completions", post(handler))
        .route("/v1/messages", post(handler))
        .route("/v1/responses", post(handler))
        .with_state(fixture);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{address}/v1"), requests)
}
fn setup(dir: &std::path::Path, url: &str, api: &str) -> Value {
    std::fs::write(
        dir.join("settings.json"),
        json!({"providers":{"fixture":{"api":api,"base_url":url}}}).to_string(),
    )
    .unwrap();
    json!({"model":{"provider":"fixture","id":"test","api":api,"base_url":url,"context":32768,"max_output":1024,"tools":true},"messages":[{"role":"user","content":"hello"}],"system":"","tools":[],"thinking":"off","session_id":"s","store_dir":dir})
}
#[tokio::test]
async fn chat_stream_collects_tool_chunks_usage_and_events() {
    let sse=concat!("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Привет\",\"reasoning_content\":\"why\",\"tool_calls\":[{\"index\":0,\"id\":\"call_abc\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"path\\\":\"}}]}}]}\r\n\r\n", "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"a\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":3,\"prompt_tokens_details\":{\"cached_tokens\":2}}}\r\n\r\n", "data: [DONE]\r\n\r\n");
    let (url, requests) = server(sse, StatusCode::OK).await;
    let dir = tempfile::tempdir().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let result = provider_runtime::stream(setup(dir.path(), &url, "chat"), tx)
        .await
        .unwrap();
    assert_eq!(result["content"], "Привет");
    assert_eq!(result["thinking"], "why");
    assert_eq!(result["calls"][0]["arguments"]["path"], "a");
    assert_eq!(result["usage"]["input"], 8);
    assert_eq!(result["usage"]["cache_read"], 2);
    assert_eq!(rx.recv().await.unwrap()["type"], "thinking_delta");
    assert_eq!(rx.recv().await.unwrap()["type"], "text_delta");
    assert_eq!(requests.lock().unwrap()[0].1["stream"], true);
}
#[tokio::test]
async fn responses_completed_recovers_unstreamed_reasoning_summary() {
    let sse = "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"reasoning\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"Reason\"}]},{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"Answer\"}]}]}}\n\n";
    let (url, _) = server(sse, StatusCode::OK).await;
    let dir = tempfile::tempdir().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let result = provider_runtime::stream(setup(dir.path(), &url, "responses"), tx).await.unwrap();
    assert_eq!(result["thinking"], "Reason");
    assert_eq!(result["content"], "Answer");
    assert_eq!(rx.recv().await.unwrap()["type"], "thinking_delta");
    assert_eq!(rx.recv().await.unwrap()["type"], "text_delta");
}
#[tokio::test]
async fn http_error_redacts_key_and_preserves_retry_metadata() {
    let (url, _) = server(
        "{\"error\":{\"message\":\"bad supersecretkey\"}}",
        StatusCode::TOO_MANY_REQUESTS,
    )
    .await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("auth.json"),
        json!({"fixture":{"key":"supersecretkey"}}).to_string(),
    )
    .unwrap();
    let (tx, _) = mpsc::unbounded_channel();
    let error = provider_runtime::stream(setup(dir.path(), &url, "chat"), tx)
        .await
        .unwrap_err();
    assert!(!error.contains("supersecretkey"));
    let value: Value = serde_json::from_str(&error).unwrap();
    assert_eq!(value["status"], 429);
    assert_eq!(value["retry_after"], 3.0);
    assert_eq!(value["retryable"], true);
}
#[tokio::test]
async fn anthropic_signed_thinking_is_preserved() {
    let sse=concat!("data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":5}}}\n\n", "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n", "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"reason\"}}\n\n", "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig\"}}\n\n", "data: {\"type\":\"message_stop\"}\n\n");
    let (url, _) = server(sse, StatusCode::OK).await;
    let dir = tempfile::tempdir().unwrap();
    let (tx, _) = mpsc::unbounded_channel();
    let result = provider_runtime::stream(setup(dir.path(), &url, "anthropic"), tx)
        .await
        .unwrap();
    assert_eq!(result["thinking"], "reason");
    assert_eq!(result["native"]["blocks"][0]["signature"], "sig");
}
#[tokio::test]
async fn premature_eof_is_retryable_and_marks_partial() {
    let (url, _) = server(
        "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
        StatusCode::OK,
    )
    .await;
    let dir = tempfile::tempdir().unwrap();
    let (tx, _) = mpsc::unbounded_channel();
    let err = provider_runtime::stream(setup(dir.path(), &url, "chat"), tx)
        .await
        .unwrap_err();
    let err: Value = serde_json::from_str(&err).unwrap();
    assert_eq!(err["streamed"], true);
    assert_eq!(err["partial"]["content"], "partial");
    assert_eq!(err["retryable"], true);
}
#[tokio::test]
async fn cancellation_drops_network_future() {
    use axum::body::{Body, Bytes};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::oneshot;
    struct OnDrop(Option<oneshot::Sender<()>>);
    impl Drop for OnDrop {
        fn drop(&mut self) {
            if let Some(tx) = self.0.take() {
                let _ = tx.send(());
            }
        }
    }
    #[derive(Clone)]
    struct StreamState {
        drop_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
        received: Arc<AtomicBool>,
    }
    async fn slow(State(state): State<StreamState>) -> Response {
        state.received.store(true, Ordering::SeqCst);
        let guard = OnDrop(state.drop_tx.lock().unwrap().take());
        let body = async_stream::stream! {let _guard=guard;yield Ok::<_,std::convert::Infallible>(Bytes::from_static(b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n"));loop {tokio::time::sleep(Duration::from_millis(10)).await;yield Ok(Bytes::from_static(b": keepalive\n\n"));}};
        Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(body))
            .unwrap()
    }
    let (drop_tx, drop_rx) = oneshot::channel();
    let received = Arc::new(AtomicBool::new(false));
    let state = StreamState {
        drop_tx: Arc::new(Mutex::new(Some(drop_tx))),
        received: received.clone(),
    };
    let app = Router::new()
        .route("/v1/chat/completions", post(slow))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let request = setup(dir.path(), &format!("http://{addr}/v1"), "chat");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move { provider_runtime::stream(request, tx).await });
    let event = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(received.load(Ordering::SeqCst));
    assert_eq!(event["delta"], "partial");
    task.abort();
    assert!(tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap_err()
        .is_cancelled());
    tokio::time::timeout(Duration::from_secs(3), drop_rx)
        .await
        .expect("server stream must be dropped after client cancellation")
        .unwrap();
}
#[tokio::test]
async fn responses_replay_reasoning_tool_arguments_and_cached_usage() {
    let sse = concat!(
        "data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"think\"}\n\n",
        "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"type\":\"function_call\",\"call_id\":\"call_a\",\"name\":\"read\"}}\n\n",
        "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":1,\"delta\":\"{\\\"path\\\":\\\"file\\\"}\"}\n\n",
        "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"id\":\"r1\",\"encrypted_content\":\"ciphertext\"}}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"input_tokens_details\":{\"cached_tokens\":4}}}}\n\n"
    );
    let (url, _) = server(sse, StatusCode::OK).await;
    let dir = tempfile::tempdir().unwrap();
    let (tx, _) = mpsc::unbounded_channel();
    let result = provider_runtime::stream(setup(dir.path(), &url, "responses"), tx)
        .await
        .unwrap();
    assert_eq!(result["thinking"], "think");
    assert_eq!(
        result["native"]["reasoning"][0]["encrypted_content"],
        "ciphertext"
    );
    assert_eq!(result["calls"][0]["arguments"]["path"], "file");
    assert_eq!(result["usage"]["input"], 6);
    assert_eq!(result["usage"]["cache_read"], 4);
}
#[tokio::test]
async fn malformed_arguments_salvage_and_stream_error_is_not_retryable() {
    let sse = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"a\",\"function\":{\"name\":\"read\",\"arguments\":\"{broken\"}}]},\"finish_reason\":\"length\"}]}\n\n";
    let (url, _) = server(sse, StatusCode::OK).await;
    let dir = tempfile::tempdir().unwrap();
    let (tx, _) = mpsc::unbounded_channel();
    let result = provider_runtime::stream(setup(dir.path(), &url, "chat"), tx)
        .await
        .unwrap();
    assert_eq!(result["stop"], "length");
    assert_eq!(result["calls"][0]["arguments"], json!({}));
    assert!(result["calls"][0]["argument_error"].is_string());
    let (url, _) = server(
        concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
            "data: {\"error\":{\"message\":\"context length exceeded\"}}\n\n"
        ),
        StatusCode::OK,
    )
    .await;
    let (tx, _) = mpsc::unbounded_channel();
    let err = provider_runtime::stream(setup(dir.path(), &url, "chat"), tx)
        .await
        .unwrap_err();
    let err: Value = serde_json::from_str(&err).unwrap();
    assert_eq!(err["retryable"], false);
    assert_eq!(err["streamed"], true);
    assert_eq!(err["context_overflow"], true);
    assert_eq!(err["partial"]["stop"], "error");
}
#[tokio::test]
async fn split_utf8_crlf_multiline_sse_is_decoded_incrementally() {
    use axum::body::{Body, Bytes};
    use futures_util::stream;
    async fn split() -> Response {
        let bytes = "data: {\"choices\":[{\"delta\":{\"content\":\"я\"},\r\ndata: \"finish_reason\":\"stop\"}]}\r\n\r\n".as_bytes();
        let chunks: Vec<Result<Bytes, std::convert::Infallible>> = bytes
            .iter()
            .map(|b| Ok(Bytes::copy_from_slice(&[*b])))
            .collect();
        Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(stream::iter(chunks)))
            .unwrap()
    }
    let app = Router::new().route("/v1/chat/completions", post(split));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let (tx, _) = mpsc::unbounded_channel();
    let result =
        provider_runtime::stream(setup(dir.path(), &format!("http://{addr}/v1"), "chat"), tx)
            .await
            .unwrap();
    assert_eq!(result["content"], "я");
}
#[tokio::test]
async fn google_parts_function_calls_and_usage() {
    async fn google() -> Response {
        ([("content-type", "text/event-stream")],"data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"idea\",\"thought\":true},{\"functionCall\":{\"name\":\"read\",\"args\":{\"path\":\"a\"}},\"thoughtSignature\":\"opaque\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":8,\"cachedContentTokenCount\":3,\"candidatesTokenCount\":4,\"thoughtsTokenCount\":2}}\n\n").into_response()
    }
    let app = Router::new().route("/v1/models/test:streamGenerateContent", post(google));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let (tx, _) = mpsc::unbounded_channel();
    let result = provider_runtime::stream(
        setup(dir.path(), &format!("http://{addr}/v1"), "google"),
        tx,
    )
    .await
    .unwrap();
    assert_eq!(result["thinking"], "idea");
    assert_eq!(result["calls"][0]["arguments"]["path"], "a");
    assert_eq!(result["native"]["parts"][1]["thoughtSignature"], "opaque");
    assert_eq!(result["usage"]["input"], 5);
    assert_eq!(result["usage"]["output"], 6);
}
#[tokio::test]
async fn retry_after_http_date_is_parsed() {
    async fn limited() -> Response {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            [("retry-after", "Wed, 21 Oct 2015 07:28:00 GMT")],
            "busy",
        )
            .into_response()
    }
    let app = Router::new().route("/v1/chat/completions", post(limited));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let (tx, _) = mpsc::unbounded_channel();
    let err = provider_runtime::stream(setup(dir.path(), &format!("http://{addr}/v1"), "chat"), tx)
        .await
        .unwrap_err();
    let err: Value = serde_json::from_str(&err).unwrap();
    assert_eq!(err["retry_after"], 0.0);
    assert_eq!(err["retryable"], true);
}
#[tokio::test]
async fn provider_redirect_never_forwards_auth_or_custom_headers() {
    use axum::{http::header::LOCATION, routing::any};
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[derive(Clone)]
    struct Redirect {
        sink: String,
        seen: Arc<Mutex<Vec<HeaderMap>>>,
    }
    async fn origin(State(state): State<Redirect>, headers: HeaderMap) -> Response {
        state.seen.lock().unwrap().push(headers);
        (StatusCode::TEMPORARY_REDIRECT, [(LOCATION, state.sink)]).into_response()
    }
    async fn sink(State(hits): State<Arc<AtomicUsize>>) -> StatusCode {
        hits.fetch_add(1, Ordering::SeqCst);
        StatusCode::OK
    }
    let hits = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let sink_addr = listener.local_addr().unwrap();
    let sink_app = Router::new()
        .route("/stolen", any(sink))
        .with_state(hits.clone());
    tokio::spawn(async move {
        axum::serve(listener, sink_app).await.unwrap();
    });
    let seen = Arc::new(Mutex::new(Vec::new()));
    let state = Redirect {
        sink: format!("http://{sink_addr}/stolen"),
        seen: seen.clone(),
    };
    let app = Router::new()
        .route("/v1/chat/completions", post(origin))
        .route("/v1/messages", post(origin))
        .route("/v1/models/test:streamGenerateContent", post(origin))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let base = format!("http://{addr}/v1");
    for api in ["anthropic", "google", "chat"] {
        let mut request = setup(dir.path(), &base, api);
        request["model"]["headers"] = json!({"x-private-token":"custom-secret"});
        std::fs::write(
            dir.path().join("auth.json"),
            json!({"fixture":{"key":"provider-secret"}}).to_string(),
        )
        .unwrap();
        let (tx, _) = mpsc::unbounded_channel();
        let error = provider_runtime::stream(request, tx).await.unwrap_err();
        let error: Value = serde_json::from_str(&error).unwrap();
        assert_eq!(error["status"], 307);
        assert!(!error.to_string().contains("provider-secret"));
    }
    let requests = seen.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0]["x-api-key"], "provider-secret");
    assert_eq!(requests[1]["x-goog-api-key"], "provider-secret");
    assert_eq!(requests[2]["authorization"], "Bearer provider-secret");
    for headers in requests.iter() {
        assert_eq!(headers["x-private-token"], "custom-secret");
    }
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}
