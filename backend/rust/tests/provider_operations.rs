use axum::{extract::Query, routing::get, Json, Router};
use futures_util::StreamExt;
use graphy_core::provider_runtime::dispatch;
use serde_json::{json, Value};
use std::collections::HashMap;
#[tokio::test]
async fn local_router_discovery_persists_runtime_context_and_thinking() {
    async fn models() -> Json<Value> {
        Json(
            json!({"data":[{"id":"loaded","status":{"value":"loaded"},"meta":{"n_ctx":8192},"architecture":{"input_modalities":["text","image"],"output_modalities":["text"]}},{"id":"preset","status":{"value":"unloaded"},"source":"preset"},{"id":"hidden","status":{"value":"unloaded"},"source":"download"}]}),
        )
    }
    async fn props(Query(q): Query<HashMap<String, String>>) -> Json<Value> {
        if q.contains_key("model") {
            assert_eq!(q["autoload"], "false");
            Json(json!({"chat_template":"{% if enable_thinking %}"}))
        } else {
            Json(json!({"models_autoload":true}))
        }
    }
    let app = Router::new()
        .route("/models", get(models))
        .route("/props", get(props));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("settings.json"),
        json!({"providers":{"llama.cpp":{"base_url":format!("http://{addr}")}}}).to_string(),
    )
    .unwrap();
    let root = dir.path().to_str().unwrap();
    let rows = dispatch(
        "models.refresh",
        json!({"store_dir":root,"provider":"llama.cpp"}),
    )
    .await
    .unwrap();
    assert!(rows
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["id"] == "llama.cpp/loaded"));
    let loaded = dispatch(
        "models.get",
        json!({"store_dir":root,"id":"llama.cpp/loaded"}),
    )
    .await
    .unwrap();
    assert_eq!(loaded["context"], 8192);
    assert_eq!(loaded["vision"], true);
    assert_eq!(loaded["thinking_levels"], json!(["off", "medium"]));
    assert_eq!(loaded["reasoning_format"], "qwen-chat-template");
    let cache: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("models.json")).unwrap()).unwrap();
    assert_eq!(cache["llama.cpp"].as_array().unwrap().len(), 2);
}
#[tokio::test]
async fn settings_validate_and_never_expose_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let result = dispatch(
        "settings.web_key",
        json!({"store_dir":root,"key":"brave-secret-key"}),
    )
    .await
    .unwrap();
    assert_eq!(result["web_key_set"], true);
    assert!(!result.to_string().contains("brave-secret-key"));
    assert!(dispatch(
        "settings.update",
        json!({"store_dir":root,"patch":{"skills_enabled":"yes"}})
    )
    .await
    .is_err());
    let result=dispatch("settings.update",json!({"store_dir":root,"patch":{"explanation_depth":"detailed","tools":["read","read","web_read"]}})).await.unwrap();
    assert_eq!(result["explanation_depth"], "detailed");
    assert_eq!(result["tools"], json!(["read", "web_read"]));
    let rows = dispatch("providers.list", json!({"store_dir":root}))
        .await
        .unwrap();
    assert!(!rows.to_string().contains("brave-secret-key"));
}
#[tokio::test]
async fn authorization_state_mismatch_and_code_parsing() {
    let ok=dispatch("auth.authorization_input",json!({"value":"http://localhost:1455/auth/callback?code=hello&state=correct","state":"correct"})).await.unwrap();
    assert_eq!(ok, "hello");
    let err = dispatch(
        "auth.authorization_input",
        json!({"value":"code=hello&state=wrong","state":"correct"}),
    )
    .await
    .unwrap_err();
    assert_eq!(err, "OAuth state mismatch");
}
#[tokio::test]
async fn web_page_snapshot_paginates_and_removes_tracking() {
    async fn page() -> ([(&'static str, &'static str); 1], &'static str) {
        ([("content-type","text/html")],"<html><head><title>Example</title><meta name='author' content='Ada'></head><body><nav>Hidden</nav><p>First line</p><p>Second line</p><script>Secret</script></body></html>")
    }
    std::env::set_var("GRAPHY_WEB_ALLOW_PRIVATE", "1"); // the fixture server is on loopback
    let app = Router::new().route("/page", get(page));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let cache = tempfile::tempdir().unwrap();
    let url = format!("http://{addr}/page?utm_source=foo&keep=1#section");
    let a = dispatch(
        "web.read",
        json!({"url":url,"cache_dir":cache.path(),"limit":1}),
    )
    .await
    .unwrap();
    assert_eq!(a["title"], "Example");
    assert_eq!(a["author"], "Ada");
    let at = a["text"].as_str().unwrap();
    assert!(at.starts_with("<untrusted_web_content source=\""), "{at}");
    assert!(at.contains("First line\n") && !at.contains("Second line"), "{at}");
    assert!(!a["url"].as_str().unwrap().contains("utm_"));
    assert_eq!(a["next_offset"], 2);
    let b = dispatch(
        "web.read",
        json!({"url":url,"cache_dir":cache.path(),"offset":2}),
    )
    .await
    .unwrap();
    let bt = b["text"].as_str().unwrap();
    assert!(bt.contains("Second line") && !bt.contains("First line"), "{bt}");
    assert_eq!(a["snapshot"], b["snapshot"]);
}
#[tokio::test]
async fn cancelling_llama_load_requests_remote_unload() {
    use axum::{extract::State, routing::post};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    async fn load(State(count): State<Arc<AtomicUsize>>) -> Json<Value> {
        count.fetch_add(1, Ordering::SeqCst);
        Json(json!({}))
    }
    async fn unload(State(count): State<Arc<AtomicUsize>>) -> Json<Value> {
        count.fetch_add(10, Ordering::SeqCst);
        Json(json!({}))
    }
    async fn list() -> Json<Value> {
        Json(json!({"data":[{"id":"test","status":{"value":"loading"}}]}))
    }
    let count = Arc::new(AtomicUsize::new(0));
    let app = Router::new()
        .route("/models/load", post(load))
        .route("/models/unload", post(unload))
        .route("/models", get(list))
        .with_state(count.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().into_owned();
    let task = tokio::spawn(async move {
        dispatch("llama.perform",json!({"store_dir":root,"base_url":format!("http://{addr}"),"model":"test","action":"load"})).await
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while count.load(Ordering::SeqCst) < 1 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    task.abort();
    let _ = task.await;
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while count.load(Ordering::SeqCst) < 11 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn llama_sse_progress_is_forwarded_for_matching_model() {
    use axum::{
        body::{Body, Bytes},
        response::Response,
        routing::post,
    };
    use futures_util::stream;
    async fn start() -> Json<Value> {
        Json(json!({}))
    }
    async fn list() -> Json<Value> {
        Json(json!({"data":[{"id":"test","status":{"value":"loading"}}]}))
    }
    async fn events() -> Response {
        let data=concat!("data: {\"model\":\"other\",\"event\":\"progress\",\"data\":{\"progress\":{\"weights\":{\"done\":99,\"total\":100}}}}\n\n", "data: {\"model\":\"test\",\"event\":\"progress\",\"data\":{\"progress\":{\"weights\":{\"done\":524288,\"total\":1048576}}}}\r\n\r\n");
        let chunks = stream::iter(
            data.as_bytes()
                .chunks(7)
                .map(|c| Ok::<_, std::convert::Infallible>(Bytes::copy_from_slice(c)))
                .collect::<Vec<_>>(),
        )
        .chain(stream::pending());
        Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(chunks))
            .unwrap()
    }
    let app = Router::new()
        .route("/models/load", post(start))
        .route("/models/unload", post(start))
        .route("/models", get(list))
        .route("/models/sse", get(events));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut rx = graphy_core::provider_runtime::subscribe_llama();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().into_owned();
    let task = tokio::spawn(async move {
        dispatch("llama.perform",json!({"store_dir":root,"base_url":format!("http://{addr}"),"model":"test","action":"load"})).await
    });
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let e = rx.recv().await.unwrap();
            if e["message"].as_str().unwrap_or("").contains("50.0%") {
                break e;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(event["model"], "test");
    assert_eq!(event["action"], "load");
    assert_eq!(event["message"], "Downloading 50.0% (0.5/1.0 MiB)");
    task.abort();
    let _ = task.await;
}
#[tokio::test]
async fn model_discovery_rejects_redirect_before_private_headers_reach_sink() {
    use axum::{
        extract::State,
        http::{header::LOCATION, HeaderMap, StatusCode},
        response::{IntoResponse, Response},
        routing::any,
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };
    #[derive(Clone)]
    struct Origin {
        url: String,
        seen: Arc<Mutex<Vec<HeaderMap>>>,
    }
    async fn redirect(State(origin): State<Origin>, headers: HeaderMap) -> Response {
        origin.seen.lock().unwrap().push(headers);
        (StatusCode::TEMPORARY_REDIRECT, [(LOCATION, origin.url)]).into_response()
    }
    async fn sink(State(count): State<Arc<AtomicUsize>>) -> StatusCode {
        count.fetch_add(1, Ordering::SeqCst);
        StatusCode::OK
    }
    let count = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let sink_addr = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/stolen", any(sink))
        .with_state(count.clone());
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let seen = Arc::new(Mutex::new(vec![]));
    let state = Origin {
        url: format!("http://{sink_addr}/stolen"),
        seen: seen.clone(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/v1/models", get(redirect))
        .with_state(state);
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    std::fs::write(dir.path().join("settings.json"),json!({"providers":{"fixture":{"api":"anthropic","base_url":format!("http://{addr}/v1"),"headers":{"x-private-token":"private-secret"}}}}).to_string()).unwrap();
    std::fs::write(
        dir.path().join("auth.json"),
        json!({"fixture":{"key":"provider-secret"}}).to_string(),
    )
    .unwrap();
    let err = dispatch(
        "models.refresh",
        json!({"store_dir":root,"provider":"fixture"}),
    )
    .await
    .unwrap_err();
    assert!(err.contains("307"));
    assert!(!err.contains("provider-secret"));
    let headers = seen.lock().unwrap();
    assert_eq!(headers.len(), 1);
    assert_eq!(headers[0]["x-api-key"], "provider-secret");
    assert_eq!(headers[0]["x-private-token"], "private-secret");
    assert_eq!(count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn settings_and_credentials_wait_for_external_writers() {
    use fs2::FileExt;
    use std::fs::OpenOptions;
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let lock = |name: &str| {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.path().join(name))
            .unwrap();
        file.lock_exclusive().unwrap();
        file
    };
    let settings_lock = lock("settings.lock");
    let task_root = root.clone();
    let mut update = tokio::spawn(async move {
        dispatch(
            "settings.update",
            json!({"store_dir":task_root,"patch":{"default_model":"fixture/model"}}),
        )
        .await
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(250), &mut update)
            .await
            .is_err()
    );
    std::fs::write(
        dir.path().join("settings.json"),
        json!({"skills_enabled":false}).to_string(),
    )
    .unwrap();
    drop(settings_lock);
    update.await.unwrap().unwrap();
    let settings: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("settings.json")).unwrap()).unwrap();
    assert_eq!(settings["skills_enabled"], false);
    assert_eq!(settings["default_model"], "fixture/model");

    let auth_lock = lock("auth.lock");
    let mut update = tokio::spawn(async move {
        dispatch(
            "settings.web_key",
            json!({"store_dir":root,"key":"test-web-key"}),
        )
        .await
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(250), &mut update)
            .await
            .is_err()
    );
    std::fs::write(
        dir.path().join("auth.json"),
        json!({"other-provider":{"key":"other-key"}}).to_string(),
    )
    .unwrap();
    drop(auth_lock);
    update.await.unwrap().unwrap();
    let auth: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("auth.json")).unwrap()).unwrap();
    assert_eq!(auth["other-provider"]["key"], "other-key");
    assert_eq!(auth["web-search"]["key"], "test-web-key");
}

#[tokio::test]
async fn concurrent_model_refreshes_preserve_both_providers() {
    use axum::extract::{Path, State};
    use fs2::FileExt;
    use std::sync::Arc;
    use tokio::sync::Barrier;

    async fn models(
        Path(provider): Path<String>,
        State(barrier): State<Arc<Barrier>>,
    ) -> Json<Value> {
        barrier.wait().await;
        Json(json!({"data":[{"id":format!("{provider}-model") }]}))
    }
    let barrier = Arc::new(Barrier::new(2));
    let app = Router::new()
        .route("/{provider}/models", get(models))
        .with_state(barrier);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("settings.json"),
        json!({"providers":{
            "first":{"api":"chat","base_url":format!("http://{addr}/first")},
            "second":{"api":"chat","base_url":format!("http://{addr}/second")}
        }})
        .to_string(),
    )
    .unwrap();
    let held = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.path().join("models.lock"))
        .unwrap();
    held.lock_exclusive().unwrap();
    let root = dir.path().to_str().unwrap();
    let first = dispatch(
        "models.refresh",
        json!({"store_dir":root,"provider":"first"}),
    );
    let second = dispatch(
        "models.refresh",
        json!({"store_dir":root,"provider":"second"}),
    );
    let both = async { tokio::join!(first, second) };
    tokio::pin!(both);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(300), &mut both)
            .await
            .is_err()
    );
    drop(held);
    let (first, second) = tokio::time::timeout(std::time::Duration::from_secs(3), both)
        .await
        .unwrap();
    first.unwrap();
    second.unwrap();
    let cache: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("models.json")).unwrap()).unwrap();
    assert_eq!(cache["first"][0]["id"], "first-model");
    assert_eq!(cache["second"][0]["id"], "second-model");
}
