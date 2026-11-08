//! HTTP/SSE host for the native runtime.
use crate::runtime_agent;
use crate::{provider_runtime, state_runtime};
use axum::{
    body::to_bytes,
    extract::{Request, State},
    http::{header, HeaderValue, Method, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::any,
    Json, Router,
};
use futures_util::Stream;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::{broadcast, watch};

mod presented;
mod teaching;
pub(crate) use presented::{declaration as present_declaration, tool as present_tool};

const VERSION: &str = "0.3.0";
#[derive(Clone)]
pub(crate) struct App {
    pub root: String,
    pub cwd: String,
    token: String,
    origins: Vec<String>,
    pub bus: broadcast::Sender<Value>,
    shutdown: broadcast::Sender<()>,
    pub seq: Arc<AtomicU64>,
    publish_lock: Arc<Mutex<()>>,
    pub sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
}
pub(crate) struct Session {
    pub data: Mutex<Value>,
    pub operation: Mutex<Operation>,
    _lock: std::fs::File,
    write_failed: AtomicBool,
    pub titling: AtomicBool,
}
#[derive(Default)]
pub(crate) struct Operation {
    pub busy: bool,
    pub compacting: bool,
    pub cancel: Option<watch::Sender<bool>>,
    pub steering: VecDeque<Value>,
    pub followups: VecDeque<Value>,
    pub activity: String,
    pub wait: Arc<tokio::sync::Notify>,
}
impl App {
    pub fn publish(&self, mut event: Value) {
        let _guard = self.publish_lock.lock().unwrap();
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        event["seq"] = json!(seq);
        event["time"] = json!(now());
        let _ = self.bus.send(event);
    }
    pub fn emit(&self, id: &str, mut event: Value) {
        if event["type"] == "status" {
            let session = self.sessions.lock().unwrap().get(id).cloned();
            if let Some(s) = session {
                s.operation.lock().unwrap().activity =
                    event["text"].as_str().unwrap_or("").to_owned();
            }
        }
        event["session_id"] = json!(id);
        self.publish(event);
    }
    pub fn state(&self, op: &str, mut value: Value) -> Result<Value, String> {
        value["store_dir"] = json!(self.root);
        value["cwd"] = json!(self.cwd);
        state_runtime::dispatch(op, value)
    }
    pub async fn provider(&self, op: &str, mut value: Value) -> Result<Value, String> {
        value["store_dir"] = json!(self.root);
        provider_runtime::dispatch(op, value).await
    }
    pub fn redact(&self, mut text: String) -> String {
        fn scrub(v: &Value, text: &mut String) {
            match v {
                Value::Object(o) => {
                    for v in o.values() {
                        scrub(v, text)
                    }
                }
                Value::String(s) if s.len() > 6 => *text = text.replace(s, "[redacted]"),
                _ => {}
            }
        }
        if let Ok(data) = std::fs::read(Path::new(&self.root).join("auth.json")) {
            if let Ok(v) = serde_json::from_slice::<Value>(&data) {
                scrub(&v, &mut text)
            }
        }
        regex::Regex::new(r"(?i)(bearer\s+)[\w.\-]+")
            .unwrap()
            .replace_all(&text, "${1}[redacted]")
            .into_owned()
    }
    fn update_prefs(&self, patch: Value) -> Result<(), String> {
        use fs2::FileExt;
        use std::io::Write;
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(Path::new(&self.root).join("settings.lock"))
            .map_err(|e| e.to_string())?;
        lock.lock_exclusive().map_err(|e| e.to_string())?;
        let file = Path::new(&self.root).join("settings.json");
        let mut value: Value = match std::fs::read(&file) {
            Ok(data) => serde_json::from_slice(&data).map_err(|_| {
                "Cannot read settings.json; correct or rename this file. Sessions are intact."
            })?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
            Err(e) => return Err(e.to_string()),
        };
        let object = value.as_object_mut().ok_or("Invalid settings")?;
        for (k, v) in patch.as_object().ok_or("Invalid settings patch")? {
            object.insert(k.clone(), v.clone());
        }
        let mut temp = tempfile::NamedTempFile::new_in(&self.root).map_err(|e| e.to_string())?;
        serde_json::to_writer_pretty(&mut temp, &value).map_err(|e| e.to_string())?;
        temp.write_all(b"\n")
            .and_then(|_| temp.as_file().sync_all())
            .map_err(|e| e.to_string())?;
        temp.persist(file).map_err(|e| e.to_string())?;
        Ok(())
    }
    fn prefs(&self) -> Value {
        std::fs::read(Path::new(&self.root).join("settings.json"))
            .ok()
            .and_then(|v| serde_json::from_slice(&v).ok())
            .unwrap_or_else(|| json!({}))
    }
    pub fn mutate(&self, session: &Session, op: &str, mut args: Value) -> Result<Value, String> {
        let mut s = session.data.lock().unwrap();
        if session.write_failed.load(Ordering::SeqCst) {
            return Err(
                "storage_error: Previous session write failed; reopen this session to recover before continuing"
                    .into(),
            );
        }
        args["path"] = s["path"].clone();
        args["bucket"] = s["bucket"].clone();
        args["already_locked"] = json!(true);
        args["store_dir"] = json!(self.root);
        args["cwd"] = json!(self.cwd);
        match state_runtime::mutate_cached(op, args, &mut s) {
            Ok(()) => {}
            Err(e) => {
                if e.starts_with("storage_error: ") {
                    session.write_failed.store(true, Ordering::SeqCst);
                }
                return Err(e);
            }
        };
        Ok(s.clone())
    }
    pub fn append(&self, session: &Session, event: Value) -> Result<Value, String> {
        self.mutate(session, "session.append", json!({"event":event}))
    }
    fn get(&self, id: &str) -> Result<Arc<Session>, ApiError> {
        if !valid_id(id) {
            return Err(ApiError::unknown_session());
        }
        if let Some(s) = self.sessions.lock().unwrap().get(id).cloned() {
            return Ok(s);
        }
        for bucket in self.buckets() {
            let course = bucket.as_str();
            let path = Path::new(&self.root)
                .join("learning/courses")
                .join(course)
                .join("sessions")
                .join(format!("{id}.jsonl"));
            if path.is_file() {
                let lock = lock_session(&path)?;
                let s = self
                    .state(
                        "session.load",
                        json!({"path":path,"bucket":course,"already_locked":true}),
                    )
                    .map_err(ApiError::invalid)?;
                let session = Arc::new(Session {
                    data: Mutex::new(s),
                    operation: Mutex::new(Operation::default()),
                    _lock: lock,
                    write_failed: AtomicBool::new(false),
                    titling: AtomicBool::new(false),
                });
                let mut map = self.sessions.lock().unwrap();
                return Ok(map.entry(id.to_owned()).or_insert(session).clone());
            }
        }
        Err(ApiError::unknown_session())
    }
    /// Storage buckets holding sessions: the default one plus any left over from the former course layer.
    fn buckets(&self) -> Vec<String> {
        let mut out = vec![state_runtime::quick::QUICK.to_owned()];
        if let Ok(dir) = std::fs::read_dir(Path::new(&self.root).join("learning/courses")) {
            let mut extra: Vec<String> = dir
                .flatten()
                .filter(|e| e.path().join("sessions").is_dir())
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| n != state_runtime::quick::QUICK)
                .collect();
            extra.sort();
            out.extend(extra);
        }
        out
    }
    pub fn summary(&self, s: &Session) -> Value {
        let data = s.data.lock().unwrap();
        let op = s.operation.lock().unwrap();
        let users: Vec<&Value> = data["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| m["role"] == "user")
            .collect();
        let first = users
            .first()
            .map(|m| {
                m["display"]
                    .as_str()
                    .or_else(|| m["content"].as_str())
                    .unwrap_or("")
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(65)
                    .collect::<String>()
            })
            .unwrap_or_default();
        json!({"id":Path::new(data["path"].as_str().unwrap_or("")).file_stem().and_then(|v|v.to_str()).unwrap_or(""),"name":data["name"].as_str().filter(|s|!s.is_empty()).unwrap_or(&first),"created":data["events"][0]["created"],"said":users.len(),"busy":op.busy,"model":data["model"],"thinking":data["thinking"],"quality":data.get("quality").cloned().unwrap_or(json!("balanced")),"explanation_style":data["explanation_style"],"mode":data.get("mode").filter(|m|!m.is_null()).unwrap_or(&json!("explain")),"quiz_kind":data.get("quiz_kind").filter(|m|!m.is_null()).unwrap_or(&json!("check")),"deadline":data["deadline"]})
    }
    pub async fn snapshot(&self, s: &Session) -> Value {
        let mut result = self.summary(s);
        let (snapshot, snapshot_seq) = {
            let _guard = self.publish_lock.lock().unwrap();
            (
                s.data.lock().unwrap().clone(),
                self.seq.load(Ordering::SeqCst),
            )
        };
        let model = self
            .provider("models.get", json!({"id":snapshot["model"]}))
            .await
            .unwrap_or_else(|_| json!({"context":32768}));
        let used = crate::runtime_agent::context_tokens(self, &snapshot, &model).unwrap_or(0);
        let limit = model["context"].as_u64().unwrap_or(32768).max(1);
        let history = self
            .state("wire.history", json!({"session":snapshot}))
            .unwrap_or_else(|_| json!([]));
        let learning = self
            .state(
                "learning.projection",
                json!({"learning":snapshot["learning"]}),
            )
            .unwrap_or(Value::Null);
        let question = if snapshot["pending_question"].is_null() {
            Value::Null
        } else {
            self.state(
                "wire.public_question",
                json!({"block":snapshot["pending_question"]}),
            )
            .unwrap_or(Value::Null)
        };
        let op = s.operation.lock().unwrap();
        for (k,v) in json!({"seq":snapshot_seq,"messages":history,"learning":learning,"question":question,"resolved_questions":self.state("wire.resolved_questions",json!({"session":snapshot})).unwrap_or_else(|_|json!({})),"context":{"used":used,"limit":limit,"percent":(used as f64/limit as f64*1000.0).round()/10.0},"usage":self.state("session.usage",json!({"session":snapshot})).unwrap_or_else(|_|json!({})),"activity":op.activity,"needs_continuation":self.state("session.needs_continuation",json!({"session":snapshot})).unwrap_or(json!(false)),"warning":snapshot["warning"],"queued":op.steering.len()+op.followups.len()}).as_object().unwrap(){result[k]=v.clone()}
        result
    }
}
pub(crate) fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
fn lock_session(path: &Path) -> Result<std::fs::File, ApiError> {
    use fs2::FileExt;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(format!("{}.lock", path.display()))
        .map_err(|e| ApiError::invalid(e.to_string()))?;
    file.try_lock_exclusive().map_err(|_| {
        ApiError::new(
            StatusCode::CONFLICT,
            "session_locked",
            "This session is open in another process",
        )
    })?;
    Ok(file)
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}
impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
    fn invalid(e: impl Into<String>) -> Self {
        let e = e.into();
        match e.as_str() {
            
            "Unknown provider" => Self::new(StatusCode::NOT_FOUND, "unknown_provider", e),
            "No such login" => Self::new(StatusCode::NOT_FOUND, "unknown_flow", e),
            "A login is already in progress" => {
                Self::new(StatusCode::CONFLICT, "login_in_progress", e)
            }
            _ if e.starts_with("conflict: ") => Self::new(
                StatusCode::CONFLICT,
                "conflict",
                e.trim_start_matches("conflict: "),
            ),
            _ if e.starts_with("not_found: ") => Self::new(
                StatusCode::NOT_FOUND,
                "not_found",
                e.trim_start_matches("not_found: "),
            ),
            "This login is not waiting for input" => {
                Self::new(StatusCode::CONFLICT, "no_prompt", e)
            }
            _ if e.starts_with("storage_error: ") => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "storage_error",
                e.trim_start_matches("storage_error: "),
            ),
            _ => Self::new(StatusCode::BAD_REQUEST, "invalid", e),
        }
    }
    fn unknown_session() -> Self {
        Self::new(StatusCode::NOT_FOUND, "unknown_session", "Unknown session")
    }
    fn busy() -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "busy",
            "Another operation is still running in this chat",
        )
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error":{"code":self.code,"message":self.message}})),
        )
            .into_response()
    }
}
fn host_allowed(s: &str) -> bool {
    let authority = s.parse::<axum::http::uri::Authority>();
    authority.ok().is_some_and(|a| {
        matches!(
            a.host().trim_matches(['[', ']']),
            "localhost" | "127.0.0.1" | "::1"
        )
    })
}
fn text<'a>(body: &'a Value, name: &str) -> Result<&'a str, ApiError> {
    body[name]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ApiError::invalid(format!("{name} must be a nonempty string")))
}
async fn route(State(app): State<App>, req: Request) -> Response {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let allow = origin.as_ref().is_some_and(|o| app.origins.contains(o));
    match checked_route(app.clone(), req).await {
        Ok(r) => r,
        Err(mut e) => {
            e.message = app.redact(e.message);
            let mut r = e.into_response();
            if allow {
                cors(&mut r, origin.as_deref())
            }
            r
        }
    }
}
async fn checked_route(app: App, req: Request) -> Result<Response, ApiError> {
    let headers = req.headers().clone();
    let method = req.method().clone();
    let uri = req.uri().clone();
    let path = uri.path().to_string();
    if !host_allowed(
        headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or(""),
    ) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "bad_host",
            "Unexpected Host header",
        ));
    }
    let origin = headers.get(header::ORIGIN).and_then(|h| h.to_str().ok());
    if origin.is_some_and(|o| !app.origins.iter().any(|x| x == o)) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "bad_origin",
            "Origin is not allowed",
        ));
    }
    if method == Method::OPTIONS {
        let mut r = StatusCode::NO_CONTENT.into_response();
        r.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"),
        );
        r.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("Authorization, Content-Type"),
        );
        r.headers_mut().insert(
            header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from_static("600"),
        );
        cors(&mut r, origin);
        return Ok(r);
    }
    if path != "/api/v1/health" {
        let auth = headers
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .strip_prefix("Bearer ")
            .unwrap_or("")
            .trim();
        let query_token = if path == "/api/v1/events" {
            uri.query()
                .and_then(|q| {
                    url::form_urlencoded::parse(q.as_bytes())
                        .find(|(k, _)| k == "token")
                        .map(|(_, v)| v.into_owned())
                })
                .unwrap_or_default()
        } else {
            String::new()
        };
        if !constant_time_eq(
            if auth.is_empty() {
                query_token.as_bytes()
            } else {
                auth.as_bytes()
            },
            app.token.as_bytes(),
        ) {
            return Err(ApiError::new(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Missing or wrong token",
            ));
        }
    }
    if path == "/api/v1/events" && method == Method::GET {
        let mut response = sse(app.clone()).into_response();
        cors(&mut response, origin);
        return Ok(response);
    }
    if path == "/api/v1/attachments" && method == Method::POST {
        let name = url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
            .find(|(key, _)| key == "name")
            .map(|(_, value)| value.into_owned())
            .unwrap_or_else(|| "attachment".into());
        // Keep the extension for the agent's document/image reader; never use a client path.
        let name = name.rsplit(['/', '\\']).next().unwrap_or("attachment");
        let safe: String = name
            .chars()
            .filter(|c| c.is_alphanumeric() || ['.', '-', '_'].contains(c))
            .take(160)
            .collect();
        let safe = if safe.trim_matches('.').is_empty() {
            "attachment"
        } else {
            &safe
        };
        let bytes = to_bytes(req.into_body(), 20 * 1024 * 1024)
            .await
            .map_err(|_| {
                ApiError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "file_too_large",
                    "File exceeds 20 MB",
                )
            })?;
        if bytes.is_empty() {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "empty_file",
                "File is empty",
            ));
        }
        let directory = Path::new(&app.cwd).join(".graphy-uploads");
        tokio::fs::create_dir_all(&directory).await.map_err(|e| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "upload_failed",
                e.to_string(),
            )
        })?;
        let file = directory.join(format!("{}-{safe}", uuid::Uuid::new_v4()));
        tokio::fs::write(&file, &bytes).await.map_err(|e| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "upload_failed",
                e.to_string(),
            )
        })?;
        let mut response = (
            StatusCode::CREATED,
            Json(json!({"path": file.to_string_lossy(), "size": bytes.len()})),
        ).into_response();
        cors(&mut response, origin);
        return Ok(response);
    }
    if method == Method::GET {
        if let Some(id) = path.strip_prefix("/api/v1/presented/") {
            let mut response = presented::serve(&app, id).await?;
            cors(&mut response, origin);
            return Ok(response);
        }
    }
    let body_bytes = to_bytes(req.into_body(), 4 * 1024 * 1024)
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "http_error",
                "Request Entity Too Large",
            )
        })?;
    let body = if body_bytes.is_empty() {
        json!({})
    } else {
        if !headers
            .get(header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|s| s.split(';').next() == Some("application/json"))
        {
            return Err(ApiError::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported_media_type",
                "Send application/json",
            ));
        }
        let b: Value = serde_json::from_slice(&body_bytes).map_err(|_| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_json",
                "Body is not valid JSON",
            )
        })?;
        if !b.is_object() {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_json",
                "Body must be a JSON object",
            ));
        }
        b
    };
    let (status, value) = dispatch(&app, &method, &path, uri.query().unwrap_or(""), body).await?;
    let mut response = (status, Json(value)).into_response();
    cors(&mut response, origin);
    Ok(response)
}
/// Materials mode is available to all users; teacher-only actions (sharing to class) are enforced elsewhere.
fn require_teacher_for_materials(_app: &App) -> Result<(), ApiError> {
    Ok(())
}
/// `{batch_id: {question_id: grading}}` from the opened and resolved blocks of a session.
pub(crate) fn answer_keys(session: &Value) -> Value {
    let mut out = serde_json::Map::new();
    let mut add = |block: &Value| {
        let (Some(batch), Some(qs)) = (block["batch_id"].as_str(), block["questions"].as_array()) else { return };
        let keys: serde_json::Map<String, Value> = qs
            .iter()
            .filter(|q| q["grading"].is_object())
            .filter_map(|q| Some((q["id"].as_str()?.to_owned(), q["grading"].clone())))
            .collect();
        out.insert(batch.to_owned(), Value::Object(keys));
    };
    for r in session["resolved_questions"].as_object().into_iter().flat_map(|m| m.values()) {
        add(&r["block"]);
    }
    add(&session["pending_question"]);
    Value::Object(out)
}
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut d = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        d |= usize::from(a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0));
    }
    d == 0 && !b.is_empty()
}
fn cors(r: &mut Response, origin: Option<&str>) {
    if let Some(o) = origin {
        if let Ok(v) = HeaderValue::from_str(o) {
            r.headers_mut()
                .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
            r.headers_mut()
                .insert(header::VARY, HeaderValue::from_static("Origin"));
        }
    }
}
fn sse(app: App) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let mut rx = app.bus.subscribe();
    let mut shutdown = app.shutdown.subscribe();
    let stream = async_stream::stream! { let seq=app.seq.load(Ordering::SeqCst); yield Ok(Event::default().id(seq.to_string()).data(json!({"seq":seq,"type":"hello","protocol":1}).to_string())); loop {tokio::select!{_ = shutdown.recv()=>break,received=rx.recv()=>match received {Ok(e)=>yield Ok(Event::default().id(e["seq"].to_string()).data(e.to_string())),Err(broadcast::error::RecvError::Lagged(_))=>{let seq=app.seq.load(Ordering::SeqCst);yield Ok(Event::default().id(seq.to_string()).data(json!({"seq":seq,"type":"lagged"}).to_string()));break},Err(_)=>break}}} };
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("ping"),
    )
}
async fn dispatch(
    app: &App,
    method: &Method,
    path: &str,
    query: &str,
    body: Value,
) -> Result<(StatusCode, Value), ApiError> {
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    if parts.len() < 3 || parts[..2] != ["api", "v1"] {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "http_error",
            "Not Found",
        ));
    }
    let p = &parts[2..];
    let ok = StatusCode::OK;
    let created = StatusCode::CREATED;
    let accepted = StatusCode::ACCEPTED;
    let call = |op: &str, v: Value| app.state(op, v).map_err(ApiError::invalid);
    match (method.as_str(), p) {
        (_, ["teaching", rest @ ..]) => teaching::route(app, method.as_str(), rest, body),
        ("GET", ["health"]) => Ok((
            ok,
            json!({"ok":true,"protocol":1,"version":VERSION,"engine":"rust"}),
        )),
        ("GET", ["bootstrap"]) => {
            let models = app
                .provider("models.list", json!({}))
                .await
                .map_err(ApiError::invalid)?;
            let providers = app
                .provider("providers.list", json!({}))
                .await
                .map_err(ApiError::invalid)?;
            let settings = app
                .provider("settings.get", json!({}))
                .await
                .map_err(ApiError::invalid)?;
            Ok((
                ok,
                json!({"protocol":1,"version":VERSION,"cwd":app.cwd,"root":app.root,"seq":app.seq.load(Ordering::SeqCst),"ready":!models.as_array().is_some_and(|a|a.is_empty()),"models":models,"providers":providers,"settings":settings}),
            ))
        }
        ("GET", ["usage"]) => {
            let params: HashMap<_, _> = url::form_urlencoded::parse(query.as_bytes())
                .into_owned()
                .collect();
            let range = params.get("range").cloned().unwrap_or_else(|| "30d".into());
            let app = app.clone();
            // reads every journal: keep it off the async workers
            let value = tokio::task::spawn_blocking(move || {
                app.state("usage.overview", json!({"range":range}))
            })
            .await
            .map_err(|e| ApiError::invalid(e.to_string()))?
            .map_err(ApiError::invalid)?;
            Ok((ok, value))
        }
        (_, ["study", rest @ ..]) => {
            let params: HashMap<_, _> = url::form_urlencoded::parse(query.as_bytes())
                .into_owned()
                .collect();
            let data = json!({"method":method.as_str(),"path":rest,"query":params,"body":body});
            let app = app.clone();
            // reads the journals: keep it off the async workers
            let value = tokio::task::spawn_blocking(move || app.state("study.route", data))
                .await
                .map_err(|e| ApiError::invalid(e.to_string()))?
                .map_err(ApiError::invalid)?;
            Ok((if method.as_str() == "POST" && rest != ["review", "next"] { created } else { ok }, value,
            ))
        }
        ("GET", ["sessions"]) => {
            let params: HashMap<_, _> = url::form_urlencoded::parse(query.as_bytes())
                .into_owned()
                .collect();
            let mut rows = vec![];
            for cid in app.buckets() {
                let cid = cid.as_str();
                for mut row in call("session.list", json!({"bucket":cid}))?
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                {
                    let path = row["path"].as_str().unwrap_or("");
                    let id = Path::new(path)
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    let existing = app.sessions.lock().unwrap().get(&id).cloned();
                    if row["said"].as_u64().unwrap_or(0) == 0
                        && params.get("include_empty").map(String::as_str) != Some("1")
                        && existing.is_none()
                    {
                        continue;
                    }
                    row["id"] = json!(id);
                    row["open"] = json!(existing.is_some());
                    row["busy"] =
                        json!(existing
                            .as_ref()
                            .is_some_and(|s| s.operation.lock().unwrap().busy));
                    row.as_object_mut().unwrap().remove("path");
                    rows.push(row)
                }
            }
            rows.sort_by(|a, b| {
                b["modified"]
                    .as_f64()
                    .partial_cmp(&a["modified"].as_f64())
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            Ok((ok, json!({"sessions":rows})))
        }
        ("POST", ["sessions"]) => {
            let folder = Path::new(&app.root)
                .join("learning/courses")
                .join(state_runtime::quick::QUICK)
                .join("sessions");
            std::fs::create_dir_all(&folder).map_err(|e| ApiError::invalid(e.to_string()))?;
            let id = format!(
                "{}-{}",
                chrono::Local::now().format("%Y%m%d-%H%M%S"),
                &uuid::Uuid::new_v4().simple().to_string()[..8]
            );
            let path = folder.join(format!("{id}.jsonl"));
            let lock = lock_session(&path)?;
            let data = call(
                "session.create",
                json!({"path":path,"already_locked":true}),
            )?;
            let s = Arc::new(Session {
                data: Mutex::new(data),
                operation: Mutex::new(Operation::default()),
                _lock: lock,
                write_failed: AtomicBool::new(false),
                titling: AtomicBool::new(false),
            });
            let prefs: Value = std::fs::read(Path::new(&app.root).join("settings.json"))
                .ok()
                .and_then(|v| serde_json::from_slice(&v).ok())
                .unwrap_or_else(|| json!({}));
            if let Some(style) = body["explanation_style"].as_str()
                .or_else(|| prefs["default_style"].as_str()) {
                app.append(
                    &s,
                    json!({"type":"explanation_style","explanation_style":style}),
                )
                .map_err(ApiError::invalid)?;
            }
            if body["mode"] == "materials" {
                require_teacher_for_materials(app)?;
            }
            if matches!(body["mode"].as_str(), Some("quiz" | "materials")) {
                app.append(&s, json!({"type":"session_mode","mode":body["mode"],"quiz_kind":body["quiz_kind"],"deadline":body["deadline"]}))
                    .map_err(ApiError::invalid)?;
            }
            let (model, thinking) = if let Some(quality) = body["quality"].as_str().filter(|q| !q.is_empty()) {
                let default_model = prefs["default_model"].as_str().unwrap_or("");
                let resolved = app.provider("quality.resolve", json!({"quality":quality,"default_model":default_model}))
                    .await
                    .map_err(ApiError::invalid)?;
                (
                    resolved["model"].as_str().unwrap_or(default_model).to_string(),
                    resolved["thinking"].as_str().unwrap_or("medium").to_string(),
                )
            } else {
                let available = app
                    .provider("models.list", json!({}))
                    .await
                    .map_err(ApiError::invalid)?;
                let model = body["model"]
                    .as_str()
                    .filter(|m| !m.is_empty())
                    .or_else(|| prefs["last_model"].as_str().filter(|m| !m.is_empty()))
                    .or_else(|| prefs["default_model"].as_str().filter(|m| !m.is_empty()))
                    .or_else(|| {
                        available
                            .as_array()
                            .and_then(|v| v.first())
                            .and_then(|v| v["id"].as_str())
                    })
                    .unwrap_or("openai/gpt-5.4")
                    .to_string();
                let metadata = app
                    .provider("models.get", json!({"id":model}))
                    .await
                    .map_err(ApiError::invalid)?;
                let wanted = body["thinking"]
                    .as_str()
                    .filter(|v| !v.is_empty())
                    .or_else(|| prefs["default_thinking"].as_str())
                    .unwrap_or("off");
                let thinking = if metadata["thinking_levels"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v == wanted))
                {
                    wanted.to_string()
                } else {
                    metadata["thinking_levels"]
                        .as_array()
                        .and_then(|a| a.first())
                        .and_then(Value::as_str)
                        .unwrap_or("off")
                        .to_string()
                };
                (model, thinking)
            };
            let quality = body["quality"].as_str().filter(|q| !q.is_empty()).unwrap_or("custom");
            app.append(
                &s,
                json!({"type":"model","model":model,"thinking":thinking,"quality":quality}),
            )
            .map_err(ApiError::invalid)?;
            if body["quality"].is_null() && body["model"].as_str().is_some_and(|v| !v.is_empty()) {
                app.update_prefs(json!({"last_model":model}))
                    .map_err(ApiError::invalid)?;
            }
            app.sessions.lock().unwrap().insert(id.clone(), s.clone());
            app.emit(
                &id,
                json!({"type":"session_created","session":app.summary(&s)}),
            );
            Ok((created, app.snapshot(&s).await))
        }
        ("GET", ["sessions", id]) => {
            let s = app.get(id)?;
            Ok((ok, app.snapshot(&s).await))
        }
        ("PATCH", ["sessions", id]) => {
            let s = app.get(id)?;
            let name = text(&body, "name")?
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            if name.chars().count() > 200 {
                return Err(ApiError::invalid("Name must contain 1-200 characters"));
            }
            app.append(&s, json!({"type":"name","name":name}))
                .map_err(ApiError::invalid)?;
            let summary = app.summary(&s);
            app.emit(id, json!({"type":"session_updated","session":summary}));
            Ok((ok, summary))
        }
        ("DELETE", ["sessions", id]) => {
            let s = app.get(id)?;
            if s.operation.lock().unwrap().busy {
                return Err(ApiError::busy());
            }
            let data = s.data.lock().unwrap().clone();
            let path = PathBuf::from(data["path"].as_str().unwrap_or(""));
            app.sessions.lock().unwrap().remove(*id);
            std::fs::remove_file(path).map_err(|e| ApiError::invalid(e.to_string()))?;
            app.emit(
                id,
                json!({"type":"session_deleted"}),
            );
            Ok((ok, json!({"deleted":true})))
        }
        ("POST", ["sessions", id, "close"]) => {
            if let Some(s) = app.sessions.lock().unwrap().get(*id).cloned() {
                if s.operation.lock().unwrap().busy {
                    return Err(ApiError::busy());
                }
            }
            let closed = app.sessions.lock().unwrap().remove(*id).is_some();
            if closed {
                app.emit(id, json!({"type":"session_closed"}))
            }
            Ok((ok, json!({"closed":closed})))
        }
        ("POST", ["sessions", id, "messages"]) => {
            let s = app.get(id)?;
            let paths = body.get("paths").cloned().unwrap_or_else(|| json!([]));
            if !paths.is_array() || paths.as_array().unwrap().iter().any(|v| !v.is_string()) {
                return Err(ApiError::invalid("paths must be a list of strings"));
            }
            let content = body["text"].as_str().unwrap_or("");
            if content.trim().is_empty() && paths.as_array().unwrap().is_empty() {
                return Err(ApiError::invalid("Message is empty"));
            }
            if !s.data.lock().unwrap()["pending_question"].is_null() {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "question_open",
                    "Сначала отправьте или отмените открытый блок вопросов.",
                ));
            }
            let message = crate::runtime_tools::attachments(&app.cwd, content, &paths)
                .await
                .map_err(ApiError::invalid)?;
            if message["images"].as_array().is_some_and(|a| !a.is_empty()) {
                let prefs: Value = std::fs::read(Path::new(&app.root).join("settings.json"))
                    .ok()
                    .and_then(|v| serde_json::from_slice(&v).ok())
                    .unwrap_or_else(|| json!({}));
                if prefs["block_images"] == true {
                    return Err(ApiError::invalid("Изображения отключены в настройках"));
                }
                let model_id = { s.data.lock().unwrap()["model"].clone() };
                let model = app
                    .provider("models.get", json!({"id":model_id}))
                    .await
                    .map_err(ApiError::invalid)?;
                if model["vision"] != true {
                    return Err(ApiError::invalid(
                        "Эта модель не принимает изображения. Выберите модель с поддержкой vision.",
                    ));
                }
            }
            let followup = body["followup"].as_bool().unwrap_or(false);
            // Retry re-sends the unanswered last learner message without adding it twice, and only
            // while the reply has not started (never replays a tool).
            let retry = body["retry"].as_bool().unwrap_or(false);
            let message = if retry {
                let data = s.data.lock().unwrap();
                let last = data["messages"].as_array().and_then(|m| m.last());
                if !crate::runtime_watchdog::can_retry(&data["messages"]) {
                    return Err(ApiError::new(
                        StatusCode::CONFLICT,
                        "retry_not_allowed",
                        "Повтор невозможен: ответ уже начался. Напишите «Продолжай».",
                    ));
                }
                if last.is_some_and(|m| m["content"].as_str() == message["content"].as_str()) {
                    None
                } else {
                    Some(message)
                }
            } else {
                Some(message)
            };
            let mut op = s.operation.lock().unwrap();
            if op.busy && message.is_none() {
                return Err(ApiError::busy());
            }
            if op.busy {
                let message = message.unwrap();
                if op.compacting {
                    return Err(ApiError::busy());
                }
                if followup {
                    op.followups.push_back(message)
                } else {
                    op.steering.push_back(message)
                }
                drop(op);
                app.emit(
                    id,
                    json!({"type":"queued","followup":followup,"text":content}),
                );
                return Ok((
                    accepted,
                    json!({"started":false,"queued":true,"followup":followup}),
                ));
            }
            drop(op);
            launch(app.clone(), id.to_string(), s, message)?;
            Ok((accepted, json!({"started":true,"queued":false})))
        }
        ("POST", ["sessions", id, "abort"]) => {
            let s = app.get(id)?;
            let op = s.operation.lock().unwrap();
            let result = op.busy && op.cancel.as_ref().is_some_and(|c| c.send(true).is_ok());
            Ok((ok, json!({"aborted":result})))
        }
        ("POST", ["sessions", id, "stall", "wait"]) => {
            let s = app.get(id)?;
            let op = s.operation.lock().unwrap();
            if !op.busy {
                return Err(ApiError::new(StatusCode::CONFLICT, "not_running", "Агент уже не работает.",
                ));
            }
            op.wait.notify_one();
            Ok((ok, json!({"waiting":true})))
        }
        ("POST", ["sessions", id, "queue", "edit"]) => {
            // body: {followup, index (within that kind), text?}; no `text` removes the item
            let s = app.get(id)?;
            let followup = body["followup"].as_bool().unwrap_or(false);
            let index = body["index"].as_u64().unwrap_or(u64::MAX) as usize;
            let mut op = s.operation.lock().unwrap();
            let queue = if followup { &mut op.followups } else { &mut op.steering };
            if index >= queue.len() {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "queue_item_gone",
                    "Это сообщение уже отправлено агенту или возвращено в поле ввода.",
                ));
            }
            match body["text"].as_str() {
                Some(text) if text.trim().is_empty() => {
                    return Err(ApiError::invalid("Message is empty"))
                }
                Some(text) => queue[index]["content"] = json!(text),
                None => {
                    queue.remove(index);
                }
            }
            Ok((ok, json!({"changed":true,"queued":op.steering.len()+op.followups.len()}),
            ))
        }
        ("POST", ["sessions", id, "restore"]) => {
            let s = app.get(id)?;
            let mut op = s.operation.lock().unwrap();
            let mut queued: Vec<_> = op.steering.drain(..).collect();
            queued.extend(op.followups.drain(..));
            let text = queued
                .iter()
                .filter_map(|m| m["content"].as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            Ok((ok, json!({"text":text})))
        }
        ("PUT", ["sessions", id, "style"]) => {
            let s = app.get(id)?;
            let style = body["explanation_style"]
                .as_str()
                .unwrap_or("structured_reference");
            app.append(
                &s,
                json!({"type":"explanation_style","explanation_style":style}),
            )
            .map_err(ApiError::invalid)?;
            let summary = app.summary(&s);
            app.emit(id, json!({"type":"session_updated","session":summary}));
            Ok((ok, summary))
        }
        ("PUT", ["sessions", id, "mode"]) => {
            let s = app.get(id)?;
            if body["mode"] == "materials" {
                require_teacher_for_materials(app)?;
            }
            app.append(&s, json!({"type":"session_mode","mode":body["mode"],"quiz_kind":body["quiz_kind"],"deadline":body["deadline"]}))
                .map_err(ApiError::invalid)?;
            let summary = app.summary(&s);
            app.emit(id, json!({"type":"session_updated","session":summary}));
            Ok((ok, summary))
        }
        ("PUT", ["sessions", id, "model"]) => {
            let s = app.get(id)?;
            if s.operation.lock().unwrap().busy {
                return Err(ApiError::busy());
            }
            let (model, thinking, quality) = if let Some(quality) = body["quality"].as_str().filter(|q| !q.is_empty()) {
                let prefs = app.prefs();
                let default_model = prefs["default_model"].as_str().unwrap_or("");
                let resolved = app.provider("quality.resolve", json!({"quality":quality,"default_model":default_model}))
                    .await
                    .map_err(ApiError::invalid)?;
                (
                    resolved["model"].as_str().unwrap_or(default_model).to_string(),
                    resolved["thinking"].as_str().unwrap_or("medium").to_string(),
                    quality.to_string(),
                )
            } else {
                let model = text(&body, "model")?;
                let metadata = app
                    .provider("models.get", json!({"id":model}))
                    .await
                    .map_err(ApiError::invalid)?;
                let levels = metadata["thinking_levels"]
                    .as_array()
                    .cloned()
                    .unwrap_or_else(|| vec![json!("off")]);
                let previous = s.data.lock().unwrap()["thinking"]
                    .as_str()
                    .unwrap_or("off")
                    .to_owned();
                let thinking = body["thinking"]
                    .as_str()
                    .filter(|v| !v.is_empty())
                    .unwrap_or_else(|| {
                        if levels.iter().any(|v| v == &previous) {
                            &previous
                        } else {
                            levels.first().and_then(Value::as_str).unwrap_or("off")
                        }
                    })
                    .to_string();
                if !levels.iter().any(|v| v.as_str() == Some(&thinking)) {
                    return Err(ApiError::invalid(format!(
                        "Unsupported reasoning level for this model: {}",
                        levels.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")
                    )));
                }
                (model.to_string(), thinking, "custom".to_string())
            };
            app.append(
                &s,
                json!({"type":"model","model":model,"thinking":thinking,"quality":quality}),
            )
            .map_err(ApiError::invalid)?;
            if body["quality"].is_null() {
                let mut changes = json!({"last_model":model});
                if body["make_default"] == true {
                    changes["default_model"] = json!(model);
                    changes["default_thinking"] = json!(thinking)
                }
                app.update_prefs(changes).map_err(ApiError::invalid)?;
            }
            let summary = app.summary(&s);
            app.emit(id, json!({"type":"session_updated","session":summary}));
            Ok((ok, summary))
        }
        ("GET", ["sessions", id, "answer_keys"]) => {
            // teacher-only: the keys never reach the learner client in question events
            if call("teaching.role.get", json!({}))?["teacher"] != true {
                return Err(ApiError::new(
                    StatusCode::FORBIDDEN,
                    "forbidden",
                    "Ключи ответов доступны только учителю",
                ));
            }
            let s = app.get(id)?;
            let data = s.data.lock().unwrap();
            Ok((ok, answer_keys(&data)))
        }
        ("PUT", ["sessions", id, "questions", batch, "draft"]) => {
            let s = app.get(id)?;
            app.mutate(
                &s,
                "session.question_draft",
                json!({"batch_id":batch,"answers":body["answers"],"step":body["step"]}),
            )
            .map_err(ApiError::invalid)?;
            Ok((ok, json!({"saved":true})))
        }
        ("POST", ["sessions", id, "questions", batch, action])
            if *action == "submit" || *action == "cancel" =>
        {
            let s = app.get(id)?;
            if s.operation.lock().unwrap().busy {
                return Err(ApiError::busy());
            }
            let answers = if body["answers"].is_null() {
                s.data.lock().unwrap()["pending_question"]["answers"].clone()
            } else {
                body["answers"].clone()
            };
            let next = app
                .mutate(
                    &s,
                    "session.question_resolve",
                    json!({"batch_id":batch,"answers":answers,"cancel":*action=="cancel","late":crate::state_runtime::forms::is_late(&s.data.lock().unwrap(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d|d.as_secs_f64()).unwrap_or(0.0))}),
                )
                .map_err(ApiError::invalid)?;
            let message = next["messages"]
                .as_array()
                .and_then(|m| m.last())
                .cloned()
                .unwrap_or(Value::Null);
            let public = call(
                "wire.public_message",
                json!({"session":*s.data.lock().unwrap(),"message":message}),
            )
            .unwrap_or(Value::Null);
            app.emit(id, json!({"type":"message","message":public}));
            app.emit(id,json!({"type":"question_resolved","batch_id":batch,"status":if *action=="cancel"{"cancelled"}else{"submitted"}}));
            launch(app.clone(), id.to_string(), s, None)?;
            Ok((accepted, json!({"started":true})))
        }
        ("POST", ["login", "codex"]) => {
            let result = app
                .provider("auth.start", json!({"method":text(&body,"method")?}))
                .await
                .map_err(ApiError::invalid)?;
            Ok((accepted, result))
        }
        ("POST", ["login", flow, "input"]) => {
            app.provider("auth.input", json!({"flow_id":flow,"value":body["value"]}))
                .await
                .map_err(ApiError::invalid)?;
            Ok((ok, json!({"accepted":true})))
        }
        ("DELETE", ["login", flow]) => {
            app.provider("auth.cancel", json!({"flow_id":flow}))
                .await
                .map_err(ApiError::invalid)?;
            Ok((ok, json!({"cancelled":true})))
        }
        ("POST", ["sessions", id, "skill"]) => {
            let s = app.get(id)?;
            if !s.data.lock().unwrap()["pending_question"].is_null() {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "question_open",
                    "Сначала отправьте или отмените открытый блок вопросов",
                ));
            }
            if app.prefs()["skills_enabled"] == false {
                return Err(ApiError::invalid("Skills отключены в настройках"));
            }
            let name = text(&body, "name")?;
            let skill = call("skills.load", json!({"name":name}))?;
            app.append(&s,json!({"type":"learning_skill","data":{"name":name,"path":skill["path"],"instructions":skill["instructions"]}})).map_err(ApiError::invalid)?;
            let request = body["request"].as_str().unwrap_or("");
            let message = json!({"role":"user","content":format!("Use skill {name}. Supporting files are relative to {}.\nSkill instructions:\n{}\n\nLearner request: {}",skill["base_directory"].as_str().unwrap_or(""),skill["instructions"].as_str().unwrap_or(""),if request.is_empty(){"Помоги применить этот skill."}else{request}),"display":format!("/{name} {request}").trim()});
            launch(app.clone(), id.to_string(), s, Some(message))?;
            Ok((accepted, json!({"started":true})))
        }
        ("POST", ["sessions", id, "compact"]) => {
            let s = app.get(id)?;
            if !s.data.lock().unwrap()["pending_question"].is_null() {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "question_open",
                    "Submit or cancel the open question before compacting",
                ));
            }
            let instructions = body["instructions"].as_str().unwrap_or("").to_owned();
            launch_compact(app.clone(), id.to_string(), s, instructions)?;
            Ok((accepted, json!({"started":true})))
        }
        ("GET", ["models"]) => Ok((
            ok,
            json!({"models":app.provider("models.list",json!({})).await.map_err(ApiError::invalid)?}),
        )),
        ("POST", ["models", "refresh"]) => Ok((
            ok,
            json!({"models":app.provider("models.refresh",json!({"provider":text(&body,"provider")?})).await.map_err(ApiError::invalid)?}),
        )),
        ("GET", ["providers"]) => Ok((
            ok,
            json!({"providers":app.provider("providers.list",json!({})).await.map_err(ApiError::invalid)?}),
        )),
        ("PUT", ["providers", name]) => {
            let mut v = body;
            v["name"] = json!(name);
            let result = app
                .provider("providers.connect", v)
                .await
                .map_err(ApiError::invalid)?;
            app.publish(json!({"type":"providers_changed"}));
            Ok((ok, result))
        }
        ("DELETE", ["providers", name]) => {
            let result = app
                .provider("providers.disconnect", json!({"name":name}))
                .await
                .map_err(ApiError::invalid)?;
            app.publish(json!({"type":"providers_changed"}));
            Ok((ok, result))
        }
        ("GET", ["settings"]) => Ok((
            ok,
            app.provider("settings.get", json!({}))
                .await
                .map_err(ApiError::invalid)?,
        )),
        ("PATCH", ["settings"]) => {
            let result = app
                .provider("settings.update", json!({"patch":body}))
                .await
                .map_err(ApiError::invalid)?;
            app.publish(json!({"type":"settings_changed"}));
            Ok((ok, result))
        }
        ("PUT", ["settings", "web-key"]) => {
            let result = app
                .provider("settings.web_key", body)
                .await
                .map_err(ApiError::invalid)?;
            app.publish(json!({"type":"settings_changed"}));
            Ok((ok, result))
        }
        ("GET", ["memory"]) => Ok((ok, call("strategy.overview", json!({}))?)),
        ("POST", ["memory", "rescan"]) => Ok((ok, call("strategy.rescan", json!({}))?)),
        ("PUT", ["memory", "settings"]) => Ok((ok, call("strategy.settings", body)?)),
        ("POST", ["memory", "rollback"]) => Ok((ok, call("strategy.rollback", body)?)),
        ("PATCH", ["memory", "observations", id]) => {
            let mut b = body.clone();
            b["id"] = json!(id);
            Ok((ok, call("strategy.edit", b)?))
        }
        ("DELETE", ["memory", "observations", id]) => {
            Ok((ok, call("strategy.delete", json!({"id":id}))?))
        }
        ("GET", ["skills"]) => Ok((ok, call("skills.list", json!({}))?)),
        ("GET", ["skills", "project"]) => Ok((
            ok,
            call(
                "skills.list",
                json!({"project_only": true, "include_disabled": true}),
            )?,
        )),
        ("GET", ["skills", "library"]) => Ok((ok, call("skills.library", json!({}))?)),
        ("GET", ["skills", "catalog"]) => Ok((ok, call("skills.catalog", json!({}))?)),
        ("POST", ["skills", "catalog", id, "install"]) => {
            let mut b = body.clone();
            b["id"] = json!(id);
            Ok((created, call("skills.catalog_install", b)?))
        }
        ("POST", ["skills"]) => Ok((created, call("skills.create", body)?)),
        ("POST", ["skills", "import"]) => Ok((created, call("skills.import", body)?)),
        ("GET", ["skills", id]) => Ok((ok, call("skills.read", json!({"id":id}))?)),
        ("PUT", ["skills", id]) => {
            let mut b = body.clone();
            b["id"] = json!(id);
            Ok((ok, call("skills.update", b)?))
        }
        ("DELETE", ["skills", id]) => Ok((ok, call("skills.delete", json!({"id":id}))?)),
        ("PUT", ["skills", id, "enabled"]) => {
            let mut b = body.clone();
            b["id"] = json!(id);
            Ok((ok, call("skills.enable", b)?))
        }
        ("POST", ["skills", id, "duplicate"]) => {
            Ok((created, call("skills.duplicate", json!({"id":id}))?))
        }
        _ => Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "http_error",
            "Not Found",
        )),
    }
}
fn launch(app: App, id: String, s: Arc<Session>, message: Option<Value>) -> Result<(), ApiError> {
    let (tx, rx) = watch::channel(false);
    {
        let mut op = s.operation.lock().unwrap();
        if op.busy {
            return Err(ApiError::busy());
        }
        op.busy = true;
        op.compacting = false;
        op.cancel = Some(tx);
    }
    app.emit(&id, json!({"type":"busy","busy":true}));
    tokio::spawn(async move {
        let result = runtime_agent::run(app.clone(), id.clone(), s.clone(), message, rx).await;
        if let Err(e) = result {
            let messages = s.data.lock().unwrap()["messages"].clone();
            app.emit(&id, crate::runtime_watchdog::failure_event(app.redact(e), &messages),
            );
        }
        let restored = {
            let mut op = s.operation.lock().unwrap();
            let mut q: Vec<_> = op.steering.drain(..).collect();
            q.extend(op.followups.drain(..));
            op.busy = false;
            op.compacting = false;
            op.cancel = None;
            op.activity.clear();
            q.iter()
                .filter_map(|v| v["content"].as_str())
                .collect::<Vec<_>>()
                .join("\n\n")
        };
        if !restored.is_empty() {
            app.emit(&id, json!({"type":"queue_restored","text":restored}));
        }
        app.emit(&id, json!({"type":"status","text":""}));
        let snapshot = app.snapshot(&s).await;
        app.emit(&id, json!({"type":"context","context":snapshot["context"]}));
        app.emit(&id, json!({"type":"usage","usage":snapshot["usage"]}));
        app.emit(
            &id,
            json!({"type":"learning","learning":snapshot["learning"]}),
        );
        app.emit(
            &id,
            json!({"type":"busy","busy":false,"needs_continuation":snapshot["needs_continuation"]}),
        );
        let app2 = app.clone();
        let id2 = id.clone();
        let s2 = Arc::downgrade(&s);
        tokio::spawn(async move {
            runtime_agent::generate_title(app2, id2, s2).await;
        });
    });
    Ok(())
}
fn launch_compact(
    app: App,
    id: String,
    s: Arc<Session>,
    instructions: String,
) -> Result<(), ApiError> {
    let (tx, rx) = watch::channel(false);
    {
        let mut op = s.operation.lock().unwrap();
        if op.busy {
            return Err(ApiError::busy());
        }
        op.busy = true;
        op.compacting = true;
        op.cancel = Some(tx)
    }
    app.emit(&id, json!({"type":"busy","busy":true}));
    tokio::spawn(async move {
        if let Err(e) = runtime_agent::compact(&app, &id, &s, &instructions, rx, 8000).await {
            app.emit(
                &id,
                json!({"type":"notice","text":app.redact(e),"error":true}),
            );
        }
        {
            let mut op = s.operation.lock().unwrap();
            op.busy = false;
            op.compacting = false;
            op.cancel = None;
        }
        app.emit(&id, json!({"type":"status","text":""}));
        app.emit(&id, json!({"type":"busy","busy":false}));
    });
    Ok(())
}
pub fn main_entry(args: Vec<String>) -> Result<(), String> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?
        .block_on(serve(args))
}
async fn serve(args: Vec<String>) -> Result<(), String> {
    use base64::Engine;
    let mut host = "127.0.0.1".to_string();
    let mut port = 0u16;
    let mut origins = Vec::new();
    let mut cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let mut close_stdin = false;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "serve" => {}
            "--host" => host = args.next().ok_or("Missing --host")?,
            "--port" => {
                port = args
                    .next()
                    .ok_or("Missing --port")?
                    .parse()
                    .map_err(|_| "Invalid port")?
            }
            "--allow-origin" => origins.push(args.next().ok_or("Missing --allow-origin")?),
            "--cwd" => cwd = PathBuf::from(args.next().ok_or("Missing --cwd")?),
            "--exit-on-stdin-close" => close_stdin = true,
            "--help" | "-h" => {
                println!("graphy serve [--host HOST] [--port PORT] [--allow-origin ORIGIN] [--cwd DIR] [--exit-on-stdin-close]");
                return Ok(());
            }
            _ => return Err(format!("Unknown argument: {arg}")),
        }
    }
    if !["127.0.0.1", "localhost", "::1"].contains(&host.as_str())
        && std::env::var("GRAPHY_SANDBOX").ok().as_deref() != Some("docker")
    {
        return Err("the server listens on the loopback interface only".into());
    }
    cwd = std::fs::canonicalize(cwd).map_err(|e| e.to_string())?;
    origins.extend(
        std::env::var("GRAPHY_ALLOWED_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .filter(|v| !v.is_empty())
            .map(str::to_owned),
    );
    let token = std::env::var("GRAPHY_TOKEN")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| {
            use rand::RngCore;
            let mut bytes = [0u8; 32];
            rand::rng().fill_bytes(&mut bytes);
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
        });
    let root = std::env::var_os("GRAPHY_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".graphy")
        });
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let (bus, _) = broadcast::channel(2000);
    let (shutdown, _) = broadcast::channel(1);
    let app = App {
        root: root.to_string_lossy().into_owned(),
        cwd: cwd.to_string_lossy().into_owned(),
        token: token.clone(),
        origins,
        bus,
        shutdown,
        seq: Arc::new(AtomicU64::new(0)),
        publish_lock: Arc::new(Mutex::new(())),
        sessions: Arc::new(Mutex::new(HashMap::new())),
    };
    app.state("migration.purge_coding_sessions", json!({}))?;
    let listener = tokio::net::TcpListener::bind((host.as_str(), port))
        .await
        .map_err(|e| e.to_string())?;
    let actual = listener.local_addr().map_err(|e| e.to_string())?.port();
    let shown = if host.contains(':') {
        format!("[{host}]")
    } else {
        host
    };
    println!(
        "{}",
        json!({"type":"ready","url":format!("http://{shown}:{actual}"),"token":token,"protocol":1,"version":VERSION,"pid":std::process::id()})
    );
    let mut auth = provider_runtime::subscribe_auth();
    let auth_app = app.clone();
    tokio::spawn(async move {
        while let Ok(event) = auth.recv().await {
            auth_app.publish(event)
        }
    });
    let shutdown_app = app.clone();
    let router = Router::new().fallback(any(route)).with_state(app);
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            if close_stdin {
                tokio::select! {_ = stdin_closed()=>{},_ = shutdown_signal()=>{}}
            } else {
                shutdown_signal().await;
            }
            let _ = shutdown_app.shutdown.send(());
            for session in shutdown_app.sessions.lock().unwrap().values() {
                if let Some(cancel) = &session.operation.lock().unwrap().cancel {
                    let _ = cancel.send(true);
                }
            }
        })
        .await
        .map_err(|e| e.to_string())
}

async fn stdin_closed() {
    use tokio::io::AsyncReadExt;
    let mut input = tokio::io::stdin();
    let mut buf = [0; 4096];
    while let Ok(n) = input.read(&mut buf).await {
        if n == 0 {
            break;
        }
    }
}
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut term) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
#[cfg(test)]
pub(crate) fn test_session(app: &App, bucket: &str, name: &str) -> Arc<Session> {
    let folder = Path::new(&app.root).join("learning/courses").join(bucket).join("sessions");
    std::fs::create_dir_all(&folder).unwrap();
    let path = folder.join(format!("{name}.jsonl"));
    let lock = lock_session(&path).unwrap();
    let data = app
        .state("session.create", json!({"bucket":bucket,"path":path,"already_locked":true}),
        )
        .unwrap();
    Arc::new(Session {
        data: Mutex::new(data),
        operation: Mutex::new(Operation::default()),
        _lock: lock,
        write_failed: AtomicBool::new(false),
        titling: AtomicBool::new(false),
    })
}
#[cfg(test)]
pub(crate) fn test_app(root: &Path) -> App {
    let (bus, _) = broadcast::channel(2000);
    let (shutdown, _) = broadcast::channel(1);
    App {
        root: root.to_string_lossy().into_owned(),
        cwd: root.to_string_lossy().into_owned(),
        token: "test-token".into(),
        origins: vec![],
        bus,
        shutdown,
        seq: Arc::new(AtomicU64::new(0)),
        publish_lock: Arc::new(Mutex::new(())),
        sessions: Arc::new(Mutex::new(HashMap::new())),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    async fn start(root: &Path) -> (String, App, tokio::task::JoinHandle<()>) {
        let (bus, _) = broadcast::channel(2000);
        let (shutdown, _) = broadcast::channel(1);
        let app = App {
            root: root.to_string_lossy().into_owned(),
            cwd: root.to_string_lossy().into_owned(),
            token: "test-token".into(),
            origins: vec!["http://localhost:5174".into()],
            bus,
            shutdown,
            seq: Arc::new(AtomicU64::new(0)),
            publish_lock: Arc::new(Mutex::new(())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new().fallback(any(route)).with_state(app.clone());
        let handle = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (address, app, handle)
    }
    #[test]
    fn answer_keys_collect_grading_per_batch() {
        let session = json!({"resolved_questions":{"b1":{"block":{"batch_id":"b1","questions":[{"id":"q1","grading":{"correct_option_ids":["a"]}},{"id":"q2"}]}}},
            "pending_question":{"batch_id":"b2","questions":[{"id":"q1","grading":{"rubric":"r"}}]}});
        let keys = answer_keys(&session);
        assert_eq!(keys["b1"]["q1"]["correct_option_ids"], json!(["a"]));
        assert!(keys["b1"].get("q2").is_none());
        assert_eq!(keys["b2"]["q1"]["rubric"], "r");
    }
    #[tokio::test]
    async fn browser_upload_is_authenticated_bounded_and_keeps_bytes_in_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let (base, app, server) = start(dir.path()).await;
        let client = reqwest::Client::new();
        let url = format!("{base}/api/v1/attachments?name=..%2F..%2Fdiagram.png");
        let unauthorized = client.post(&url).body("test").send().await.unwrap();
        assert_eq!(unauthorized.status(), 401);
        let bytes = vec![0, 255, 42, 13, 10];
        let response = client
            .post(&url)
            .bearer_auth("test-token")
            .header("Origin", "http://localhost:5174")
            .body(bytes.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 201);
        assert_eq!(
            response.headers()["access-control-allow-origin"],
            "http://localhost:5174"
        );
        let uploaded: Value = response.json().await.unwrap();
        let file = Path::new(uploaded["path"].as_str().unwrap());
        assert_eq!(
            file.parent().unwrap(),
            Path::new(&app.cwd).join(".graphy-uploads")
        );
        assert!(file
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .ends_with("-diagram.png"));
        assert_eq!(std::fs::read(file).unwrap(), bytes);
        let another: Value = client
            .post(&url)
            .bearer_auth("test-token")
            .body("new")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_ne!(another["path"], uploaded["path"]);
        let empty = client
            .post(&url)
            .bearer_auth("test-token")
            .body("")
            .send()
            .await
            .unwrap();
        assert_eq!(empty.status(), 400);
        let large = client
            .post(&url)
            .bearer_auth("test-token")
            .body(vec![0; 20 * 1024 * 1024 + 1])
            .send()
            .await
            .unwrap();
        assert_eq!(large.status(), 413);
        assert_eq!(
            std::fs::read_dir(file.parent().unwrap()).unwrap().count(),
            2
        );
        server.abort();
    }
    #[tokio::test]
    async fn http_guard_sse_and_durable_session() {
        let dir = tempfile::tempdir().unwrap();
        let (base, _app, server) = start(dir.path()).await;
        let client = reqwest::Client::new();
        let health: Value = client
            .get(format!("{base}/api/v1/health"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(health["engine"], "rust");
        assert_eq!(
            client
                .get(format!("{base}/api/v1/sessions"))
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        assert_eq!(
            client
                .get(format!("{base}/api/v1/health"))
                .header("host", "evil.test")
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        assert_eq!(
            client
                .get(format!("{base}/api/v1/health"))
                .header("origin", "https://evil.test")
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        let pre = client
            .request(reqwest::Method::OPTIONS, format!("{base}/api/v1/sessions"))
            .header("origin", "http://localhost:5174")
            .send()
            .await
            .unwrap();
        assert_eq!(pre.status(), 204);
        assert_eq!(
            pre.headers()["access-control-allow-origin"],
            "http://localhost:5174"
        );
        let mut events = client
            .get(format!("{base}/api/v1/events?token=test-token"))
            .send()
            .await
            .unwrap();
        let initial = String::from_utf8(events.chunk().await.unwrap().unwrap().to_vec()).unwrap();
        assert!(initial.contains("\"type\":\"hello\""));
        let session: Value = client
            .post(format!("{base}/api/v1/sessions"))
            .bearer_auth("test-token")
            .json(&json!({"model":"ollama/demo"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let id = session["id"].as_str().expect("session id");
        assert_eq!(session["model"], "ollama/demo");
        let renamed: Value = client
            .patch(format!("{base}/api/v1/sessions/{id}"))
            .bearer_auth("test-token")
            .json(&json!({"name":"Persisted"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(renamed["name"], "Persisted");
        let closed: Value = client
            .post(format!("{base}/api/v1/sessions/{id}/close"))
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(closed["closed"], true);
        let loaded: Value = client
            .get(format!("{base}/api/v1/sessions/{id}"))
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(loaded["name"], "Persisted");
        let frame = String::from_utf8(events.chunk().await.unwrap().unwrap().to_vec()).unwrap();
        assert!(frame.contains("session_created"));
        server.abort();
    }
    #[tokio::test]
    async fn chats_are_plain_and_legacy_course_sessions_stay_readable() {
        let dir = tempfile::tempdir().unwrap();
        let (base, _app, server) = start(dir.path()).await;
        let client = reqwest::Client::new();
        let call = |method: reqwest::Method, path: String, body: Value| {
            let client = client.clone();
            let url = format!("{base}/api/v1{path}");
            async move {
                let mut req = client.request(method, url).bearer_auth("test-token");
                if !body.is_null() {
                    req = req.json(&body);
                }
                let r = req.send().await.unwrap();
                let status = r.status();
                (status, r.json::<Value>().await.unwrap_or(Value::Null))
            }
        };
        // A chat needs no course; a stale `course_id` in an older client payload is ignored.
        for body in [json!({"model":"ollama/demo"}), json!({"model":"ollama/demo","course_id":"abc"})] {
            let (st, made) = call(reqwest::Method::POST, "/sessions".into(), body).await;
            assert_eq!(st, 201, "{made}");
            assert!(made.get("course_id").is_none());
        }
        // Sessions stored in the default bucket and in a leftover course folder are both listed and reopenable.
        let old = test_session(&_app, "aaaa", "old-course-chat");
        let old_id = old.data.lock().unwrap()["id"].as_str().unwrap().to_owned();
        drop(old);
        let folder = dir.path().join("learning/courses/aaaa/sessions");
        std::fs::rename(folder.join("old-course-chat.jsonl"), folder.join(format!("{old_id}.jsonl"))).unwrap();
        let (_, listed) = call(reqwest::Method::GET, "/sessions?include_empty=1".into(), json!(null)).await;
        let rows = listed["sessions"].as_array().unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|r| r.get("course_id").is_none()));
        assert!(rows.iter().any(|r| r["id"] == json!(old_id)));
        let (st, again) = call(reqwest::Method::GET, format!("/sessions/{old_id}"), json!(null)).await;
        assert_eq!(st, 200, "{again}");
        assert!(again.get("course_id").is_none());
        // the removed course routes are gone
        let (st, _) = call(reqwest::Method::GET, "/courses".into(), json!(null)).await;
        assert_eq!(st, 404);
        server.abort();
    }
    #[tokio::test]
    async fn slow_subscriber_gets_lagged_and_disconnects() {
        let dir = tempfile::tempdir().unwrap();
        let (base, app, server) = start(dir.path()).await;
        let mut stream = sse(app.clone())
            .into_response()
            .into_body()
            .into_data_stream();
        use futures_util::StreamExt;
        let first = stream.next().await.unwrap().unwrap();
        assert!(String::from_utf8_lossy(&first).contains("hello"));
        for n in 0..2100 {
            app.publish(json!({"type":"notice","n":n}));
        }
        let lagged = stream.next().await.unwrap().unwrap();
        assert!(String::from_utf8_lossy(&lagged).contains("lagged"));
        assert!(stream.next().await.is_none());
        let _ = base;
        server.abort();
    }
    #[tokio::test]
    async fn mock_provider_stream_is_persisted_and_replayed() {
        async fn mock() -> impl IntoResponse {
            ([(header::CONTENT_TYPE,"text/event-stream")],"data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello \"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"world\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
        }
        let provider = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let provider_url = format!("http://{}/v1", provider.local_addr().unwrap());
        let provider_task = tokio::spawn(async move {
            axum::serve(
                provider,
                Router::new().route("/v1/chat/completions", axum::routing::post(mock)),
            )
            .await
            .unwrap()
        });
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            json!({"providers":{"ollama":{"base_url":provider_url}}}).to_string(),
        )
        .unwrap();
        let (base, _app, server) = start(dir.path()).await;
        let client = reqwest::Client::new();
        let session: Value = client
            .post(format!("{base}/api/v1/sessions"))
            .bearer_auth("test-token")
            .json(&json!({"model":"ollama/demo"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let id = session["id"].as_str().unwrap().to_owned();
        client
            .patch(format!("{base}/api/v1/sessions/{id}"))
            .bearer_auth("test-token")
            .json(&json!({"name":"Mock lesson"}))
            .send()
            .await
            .unwrap();
        let mut events = client
            .get(format!("{base}/api/v1/events?token=test-token"))
            .send()
            .await
            .unwrap();
        let _ = events.chunk().await.unwrap();
        let response = client
            .post(format!("{base}/api/v1/sessions/{id}/messages"))
            .bearer_auth("test-token")
            .json(&json!({"text":"Hi"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 202);
        let mut transcript = String::new();
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while !transcript.contains("\"busy\":false") {
                let chunk = events.chunk().await.unwrap().unwrap();
                transcript.push_str(&String::from_utf8_lossy(&chunk));
            }
        })
        .await
        .unwrap();
        assert!(transcript.contains("text_delta"), "{transcript}");
        assert!(transcript.contains("message_end"), "{transcript}");
        let events: Vec<Value> = transcript
            .lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .map(|v| serde_json::from_str(v).unwrap())
            .collect();
        let assistant = events
            .iter()
            .find(|e| e["type"] == "message" && e["message"]["role"] == "assistant")
            .unwrap();
        let message_id = assistant["message"]["id"].as_str().unwrap();
        let deltas = events
            .iter()
            .filter(|e| e["type"] == "text_delta")
            .collect::<Vec<_>>();
        assert_eq!(deltas.len(), 2);
        assert!(deltas.iter().all(|e| e["message_id"] == message_id));
        assert_eq!(
            deltas
                .iter()
                .map(|e| e["delta"].as_str().unwrap())
                .collect::<String>(),
            "Hello world"
        );
        let end = events.iter().find(|e| e["type"] == "message_end").unwrap();
        assert_eq!(end["message"]["id"], message_id);
        client
            .post(format!("{base}/api/v1/sessions/{id}/close"))
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap();
        let loaded: Value = client
            .get(format!("{base}/api/v1/sessions/{id}"))
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let messages = loaded["messages"].as_array().unwrap();
        assert_eq!(messages[0]["content"], "Hi");
        assert_eq!(messages[1]["content"], "Hello world");
        server.abort();
        provider_task.abort();
    }
}
