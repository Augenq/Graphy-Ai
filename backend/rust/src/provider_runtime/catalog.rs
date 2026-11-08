use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

pub fn root(data: &Value) -> PathBuf {
    data.get("store_dir")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("GRAPHY_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".graphy")
                })
        })
}
pub fn read(root: &Path, name: &str) -> Result<Value, String> {
    let p = root.join(name);
    match std::fs::read_to_string(&p) {
        Ok(s) => {
            let v: Value = serde_json::from_str(&s).map_err(|_| {
                format!("Cannot read {name}; correct or rename this file. Sessions are intact.")
            })?;
            if !v.is_object() {
                return Err(format!(
                    "Cannot read {name}; correct or rename this file. Sessions are intact."
                ));
            }
            Ok(v)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(_) => Err(format!(
            "Cannot read {name}; correct or rename this file. Sessions are intact."
        )),
    }
}
pub fn write(root: &Path, name: &str, value: &Value) -> Result<(), String> {
    use std::io::Write;
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let mut f = tempfile::NamedTempFile::new_in(root).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut f, value).map_err(|e| e.to_string())?;
    f.write_all(b"\n").map_err(|e| e.to_string())?;
    f.as_file().sync_all().map_err(|e| e.to_string())?;
    f.persist(root.join(name)).map_err(|e| e.to_string())?;
    Ok(())
}
/// The project's own model service: the app sends the request to our server, which forwards it to OpenRouter with the server key.
/// It needs no setup: an anonymous per-install token is created on first use. `GRAPHY_SERVICE_URL` overrides the address, `off` disables it.
pub const GRAPHY_SERVICE_URL: &str = "https://78-17-61-24.sslip.io:8443/llm";
pub fn graphy_enabled() -> bool {
    std::env::var("GRAPHY_SERVICE_URL").map(|v| v != "off").unwrap_or(true)
}
pub const PRESETS: &[(&str, &str, &str, &str)] = &[
    ("graphy", "chat", GRAPHY_SERVICE_URL, "GRAPHY_API_KEY"),
    (
        "openai",
        "responses",
        "https://api.openai.com/v1",
        "OPENAI_API_KEY",
    ),
    (
        "openai-codex",
        "codex",
        "https://chatgpt.com/backend-api",
        "",
    ),
    (
        "anthropic",
        "anthropic",
        "https://api.anthropic.com/v1",
        "ANTHROPIC_API_KEY",
    ),
    (
        "google",
        "google",
        "https://generativelanguage.googleapis.com/v1beta",
        "GEMINI_API_KEY",
    ),
    (
        "deepseek",
        "chat",
        "https://api.deepseek.com",
        "DEEPSEEK_API_KEY",
    ),
    (
        "openrouter",
        "chat",
        "https://openrouter.ai/api/v1",
        "OPENROUTER_API_KEY",
    ),
    ("xai", "responses", "https://api.x.ai/v1", "XAI_API_KEY"),
    (
        "mistral",
        "chat",
        "https://api.mistral.ai/v1",
        "MISTRAL_API_KEY",
    ),
    (
        "groq",
        "chat",
        "https://api.groq.com/openai/v1",
        "GROQ_API_KEY",
    ),
    (
        "together",
        "chat",
        "https://api.together.ai/v1",
        "TOGETHER_API_KEY",
    ),
    ("ollama", "chat", "http://localhost:11434/v1", ""),
    ("lmstudio", "chat", "http://localhost:1234/v1", ""),
    (
        "llama.cpp",
        "chat",
        "http://localhost:8080/v1",
        "LLAMA_API_KEY",
    ),
    ("vllm", "chat", "http://localhost:8000/v1", ""),
    ("sglang", "chat", "http://localhost:30000/v1", ""),
    ("localai", "chat", "http://localhost:8080/v1", ""),
];
pub fn local(name: &str) -> bool {
    matches!(
        name,
        "ollama" | "lmstudio" | "llama.cpp" | "vllm" | "sglang" | "localai"
    )
}
pub fn settings(root: &Path, provider: &str) -> Result<Value, String> {
    let (_, api, url, env) = PRESETS
        .iter()
        .find(|x| x.0 == provider)
        .copied()
        .unwrap_or((provider, "chat", "", ""));
    let prefs = read(root, "settings.json")?;
    let mut v = json!({"api":api,"base_url":url,"env":env});
    merge(&mut v, &prefs["providers"][provider]);
    if provider == "graphy" {
        if let Ok(u) = std::env::var("GRAPHY_SERVICE_URL") {
            if !u.is_empty() && u != "off" {
                v["base_url"] = json!(u.trim_end_matches('/'));
            }
        }
    }
    if provider == "llama.cpp" {
        let u = std::env::var("LLAMA_BASE_URL")
            .ok()
            .filter(|x| !x.is_empty())
            .unwrap_or_else(|| s(&v["base_url"]).to_owned());
        let u = u.trim_end_matches('/');
        v["base_url"] = json!(if u.ends_with("/v1") {
            u.to_owned()
        } else {
            format!("{u}/v1")
        });
    }
    if local(provider) {
        if let Ok(gateway) = std::env::var("GRAPHY_HOST_GATEWAY") {
            if let Ok(mut u) = url::Url::parse(s(&v["base_url"])) {
                if matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "::1")) {
                    let _ = u.set_host(Some(&gateway));
                    v["base_url"] = json!(u.as_str().trim_end_matches('/'));
                }
            }
        }
    }
    let api = s(&v["api"]);
    v["api"] = json!(match api {
        "openai-completions" => "chat",
        "openai-responses" => "responses",
        "anthropic-messages" => "anthropic",
        "google-generative-ai" => "google",
        "openai-codex-responses" => "codex",
        x => x,
    });
    if s(&v["base_url"]).is_empty() {
        return Err(format!("Configure a base_url for provider {provider}"));
    }
    Ok(v)
}
pub fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub fn merge(to: &mut Value, from: &Value) {
    if let (Some(a), Some(b)) = (to.as_object_mut(), from.as_object()) {
        for (k, v) in b {
            a.insert(k.clone(), v.clone());
        }
    }
}
pub fn credential(root: &Path, p: &str) -> Result<Value, String> {
    Ok(read(root, "auth.json")?
        .get(p)
        .cloned()
        .unwrap_or(json!({})))
}
pub fn key(root: &Path, p: &str, c: &Value) -> Result<String, String> {
    let env = c
        .get("env")
        .and_then(Value::as_str)
        .filter(|x| !x.is_empty())
        .or_else(|| c.get("api_key_env").and_then(Value::as_str))
        .unwrap_or("");
    if let Ok(value) = std::env::var(env) {
        if !value.is_empty() {
            return Ok(value);
        }
    }
    let stored = s(&credential(root, p)?["key"]).to_owned();
    if stored.is_empty() && p == "graphy" && graphy_enabled() {
        // first use: an anonymous install token (random, no account); the server limits it per day
        let token = format!("anon-{}", uuid::Uuid::new_v4().simple());
        let mut auth = read(root, "auth.json")?;
        auth[p] = json!({"key": token});
        write(root, "auth.json", &auth)?;
        return Ok(token);
    }
    Ok(stored)
}
fn model(root: &Path, p: &str, item: &Value) -> Result<Value, String> {
    let c = settings(root, p)?;
    let mut v = json!({"provider":p,"api":c["api"],"base_url":c["base_url"],"context":32768,"max_output":4096,"vision":false,"tools":true,"reasoning":false,"thinking_levels":["off"],"cost":null,"metadata_estimated":true});
    merge(&mut v, item);
    v["provider"] = json!(p);
    if v.get("name").is_none() {
        v["name"] = v["id"].clone();
    }
    Ok(v)
}
pub fn catalog(root: &Path) -> Result<Vec<Value>, String> {
    let snapshot: Vec<Value> =
        serde_json::from_str(include_str!("models_snapshot.json")).map_err(|e| e.to_string())?;
    let prefs = read(root, "settings.json")?;
    let cache = read(root, "models.json")?;
    let mut map = std::collections::BTreeMap::new();
    for item in snapshot {
        let p = s(&item["provider"]);
        if p == "graphy" && !graphy_enabled() {
            continue;
        }
        map.insert(
            (p.to_owned(), s(&item["id"]).to_owned()),
            model(root, p, &item)?,
        );
    }
    if let Some(providers) = cache.as_object() {
        for (p, items) in providers {
            if let Some(items) = items.as_array() {
                for item in items {
                    map.insert(
                        (p.clone(), s(&item["id"]).to_owned()),
                        model(root, p, item)?,
                    );
                }
            }
        }
    }
    if let Some(providers) = prefs["providers"].as_object() {
        for (p, c) in providers {
            let items = match &c["models"] {
                Value::Array(a) => a.clone(),
                Value::Object(o) => o
                    .iter()
                    .map(|(id, v)| {
                        let mut x = v.clone();
                        x["id"] = json!(id);
                        x
                    })
                    .collect(),
                _ => vec![],
            };
            for item in items {
                let item = if item.is_string() {
                    json!({"id":item})
                } else {
                    item
                };
                let id = s(&item["id"]).to_owned();
                let mut v = map.remove(&(p.clone(), id.clone())).unwrap_or(json!({}));
                merge(&mut v, &item);
                map.insert((p.clone(), id), model(root, p, &v)?);
            }
        }
    }
    let mut out: Vec<_> = map.into_values().collect();
    out.sort_by_key(|v| (s(&v["provider"]).to_owned(), s(&v["name"]).to_owned()));
    Ok(out)
}
pub fn get(root: &Path, id: &str) -> Result<Value, String> {
    let (p, name) = id
        .split_once('/')
        .filter(|(_, n)| !n.is_empty())
        .ok_or("Use provider/model-id")?;
    let found = catalog(root)?
        .into_iter()
        .find(|m| s(&m["provider"]) == p && s(&m["id"]) == name);
    let mut v = match found {
        Some(x) => x,
        None => model(root, p, &json!({"id":name}))?,
    };
    let c = settings(root, p)?;
    v["api"] = c["api"].clone();
    v["base_url"] = c["base_url"].clone();
    Ok(v)
}
pub fn available(root: &Path) -> Result<Vec<Value>, String> {
    let prefs = read(root, "settings.json")?;
    let cache = read(root, "models.json")?;
    let mut out = vec![];
    for v in catalog(root)? {
        let p = s(&v["provider"]);
        let c = settings(root, p)?;
        let enabled = (p == "llama.cpp" && std::env::var("LLAMA_BASE_URL").is_ok())
            || (local(p) && (prefs["providers"].get(p).is_some() || cache.get(p).is_some()))
            || (p == "openai-codex" && !s(&credential(root, p)?["refresh"]).is_empty())
            || !key(root, p, &c)?.is_empty()
            || (prefs["providers"].get(p).is_some() && s(&c["env"]).is_empty());
        if enabled {
            out.push(v)
        }
    }
    Ok(out)
}
pub async fn dispatch(op: &str, data: Value) -> Result<Value, String> {
    let root = root(&data);
    let p = data.get("provider").and_then(Value::as_str).unwrap_or("");
    match op {
        "models.get" => get(&root, s(&data["id"])),
        "models.list" => Ok(json!(available(&root)?.iter().map(row).collect::<Vec<_>>())),
        "models.available" => Ok(json!(available(&root)?)),
        "models.all" => Ok(json!(catalog(&root)?)),
        "providers.settings" | "settings.provider" => settings(&root, p),
        "providers.list" => {
            let prefs = read(&root, "settings.json")?;
            let models = catalog(&root)?;
            let mut names: Vec<String> = PRESETS.iter().map(|x| x.0.to_owned()).collect();
            if let Some(m) = prefs["providers"].as_object() {
                for n in m.keys() {
                    if !names.contains(n) {
                        names.push(n.clone());
                    }
                }
            }
            let mut rows = vec![];
            for n in names {
                let Ok(c) = settings(&root, &n) else { continue };
                let cred = credential(&root, &n)?;
                let env = s(&c["env"]);
                let from_env =
                    !env.is_empty() && std::env::var(env).map(|s| !s.is_empty()).unwrap_or(false);
                let stored = !s(&cred["key"]).is_empty();
                let configured = if n == "graphy" {
                    graphy_enabled()
                } else if n == "openai-codex" {
                    !s(&cred["refresh"]).is_empty()
                } else {
                    from_env
                        || stored
                        || (prefs["providers"].get(&n).is_some() && (local(&n) || env.is_empty()))
                };
                rows.push(json!({"name":n,"kind":if s(&c["api"])=="codex"{"oauth"}else if n=="graphy"{"service"}else if local(&n){"local"}else if PRESETS.iter().any(|x|x.0==n){"api"}else{"custom"},"api":c["api"],"base_url":c["base_url"],"key_env":env,"configured":configured,"key_source":if from_env{"env"}else if stored{"stored"}else{""},"models":models.iter().filter(|m|s(&m["provider"])==n).count()}));
            }
            Ok(json!(rows))
        }
        "models.refresh" => {
            refresh(&root, p).await?;
            Ok(json!(available(&root)?.iter().map(row).collect::<Vec<_>>()))
        }
        _ => Err(format!("Unknown provider operation: {op}")),
    }
}
async fn save_models(root: &Path, provider: &str, entries: &[Value]) -> Result<(), String> {
    let _guard = super::auth::lock(root, "models.lock").await?;
    let mut cache = read(root, "models.json")?;
    cache[provider] = json!(entries);
    write(root, "models.json", &cache)
}
async fn refresh(root: &Path, p: &str) -> Result<Value, String> {
    let p = p.split('/').next().unwrap_or("");
    if p.is_empty() {
        let mut ps = BTreeSet::new();
        for v in available(root)? {
            ps.insert(s(&v["provider"]).to_owned());
        }
        if let Some(m) = read(root, "settings.json")?["providers"].as_object() {
            ps.extend(m.keys().cloned());
        }
        for p in ps {
            if p != "openai-codex" {
                Box::pin(refresh(root, &p)).await?;
            }
        }
        return Ok(json!(catalog(root)?));
    }
    let c = settings(root, p)?;
    if s(&c["api"]) == "codex" {
        return Ok(json!(catalog(root)?
            .into_iter()
            .filter(|m| s(&m["provider"]) == p)
            .collect::<Vec<_>>()));
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let key = key(root, p, &c)?;
    let mut headers = reqwest::header::HeaderMap::new();
    for obj in [&c["headers"], &credential(root, p)?["headers"]] {
        if let Some(o) = obj.as_object() {
            for (k, v) in o {
                if let (Ok(n), Ok(v)) = (
                    reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                    reqwest::header::HeaderValue::from_str(s(v)),
                ) {
                    headers.insert(n, v);
                }
            }
        }
    }
    if !key.is_empty() {
        let (k, v) = match s(&c["api"]) {
            "anthropic" => ("x-api-key", key.clone()),
            "google" => ("x-goog-api-key", key.clone()),
            _ => ("authorization", format!("Bearer {key}")),
        };
        headers.insert(
            reqwest::header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
            reqwest::header::HeaderValue::from_str(&v).map_err(|e| e.to_string())?,
        );
    }
    if s(&c["api"]) == "anthropic" {
        headers.insert(
            "anthropic-version",
            reqwest::header::HeaderValue::from_static("2023-06-01"),
        );
    }
    let known = catalog(root)?;
    if p == "llama.cpp" {
        if let Some(entries) = llama_router(&client, &c, &headers, &known).await? {
            save_models(root, p, &entries).await?;
            return Ok(json!(catalog(root)?
                .into_iter()
                .filter(|m| s(&m["provider"]) == p)
                .collect::<Vec<_>>()));
        }
    }
    let mut cursor = String::new();
    let mut seen = BTreeSet::new();
    let mut entries = vec![];
    loop {
        let mut req = client
            .get(format!(
                "{}/models",
                s(&c["base_url"]).trim_end_matches('/')
            ))
            .headers(headers.clone());
        if !cursor.is_empty() {
            req = req.query(&[(
                if s(&c["api"]) == "google" {
                    "pageToken"
                } else {
                    "after"
                },
                &cursor,
            )]);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| format!("Model discovery failed: {}", e.without_url()))?;
        if !resp.status().is_success() {
            return Err(format!("Model discovery returned HTTP {}", resp.status()));
        }
        let body: Value = resp
            .json()
            .await
            .map_err(|_| "Invalid model discovery response")?;
        let rows = body
            .get("models")
            .or_else(|| body.get("data"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let served: std::collections::BTreeMap<String, Value> = body["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|x| {
                x["id"]
                    .as_str()
                    .map(|id| (id.to_owned(), x["meta"]["n_ctx"].clone()))
            })
            .collect();
        for row in rows {
            let id = row
                .get("id")
                .or_else(|| row.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim_start_matches("models/");
            if id.is_empty() {
                continue;
            }
            if s(&c["api"]) == "google"
                && !row["supportedGenerationMethods"]
                    .as_array()
                    .is_some_and(|x| x.iter().any(|v| v == "generateContent"))
            {
                continue;
            }
            let mut item = known
                .iter()
                .find(|v| s(&v["provider"]) == p && s(&v["id"]) == id)
                .cloned()
                .unwrap_or(json!({"id":id}));
            item["name"] = row
                .get("displayName")
                .or_else(|| row.get("name"))
                .cloned()
                .unwrap_or(json!(id));
            if let Some(limit) = row
                .get("context_length")
                .or_else(|| row.get("inputTokenLimit"))
                .or_else(|| {
                    if p == "llama.cpp" {
                        served.get(id).filter(|v| !v.is_null())
                    } else {
                        None
                    }
                })
            {
                item["context"] = limit.clone();
                item["metadata_estimated"] = json!(false);
            }
            if let Some(limit) = row
                .get("outputTokenLimit")
                .or_else(|| row["top_provider"].get("max_completion_tokens"))
            {
                item["max_output"] = limit.clone();
            }
            if let Some(price) = row["pricing"].as_object() {
                let mut cost = json!({});
                for (k, source) in [
                    ("input", "prompt"),
                    ("output", "completion"),
                    ("cache_read", "input_cache_read"),
                    ("cache_write", "input_cache_write"),
                ] {
                    if let Some(v) = price.get(source).and_then(|v| {
                        v.as_f64()
                            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                    }) {
                        if v.is_finite() && v >= 0.0 {
                            cost[k] = json!(v * 1e6);
                        }
                    }
                }
                item["cost"] = cost;
            }
            if let Some(a) = row["architecture"]["input_modalities"].as_array() {
                item["vision"] = json!(a.iter().any(|x| x == "image"));
            }
            let curated: Vec<Value> = serde_json::from_str(include_str!("models_snapshot.json"))
                .map_err(|e| e.to_string())?;
            if !curated
                .iter()
                .any(|m| s(&m["provider"]) == p && s(&m["id"]) == id)
            {
                if let Some(levels) = reasoning_levels(&row) {
                    item["reasoning"] = json!(true);
                    item["thinking_levels"] = json!(levels);
                }
            }
            entries.push(item);
        }
        let next = body
            .get("nextPageToken")
            .or_else(|| {
                if body["has_more"] == true {
                    body.get("last_id")
                } else {
                    None
                }
            })
            .and_then(Value::as_str)
            .unwrap_or("");
        if next.is_empty() || !seen.insert(next.to_owned()) {
            break;
        }
        cursor = next.to_owned();
    }
    if p == "llama.cpp" {
        let base = s(&c["base_url"])
            .trim_end_matches('/')
            .trim_end_matches("/v1");
        if let Ok(resp) = client
            .get(format!("{base}/props"))
            .headers(headers.clone())
            .send()
            .await
        {
            if let Ok(props) = resp.json::<Value>().await {
                if s(&props["chat_template"]).contains("enable_thinking") {
                    for item in &mut entries {
                        item["reasoning"] = json!(true);
                        item["thinking_levels"] = json!(["off", "medium"]);
                        item["reasoning_format"] = json!("qwen-chat-template");
                    }
                }
            }
        }
    }
    save_models(root, p, &entries).await?;
    Ok(json!(catalog(root)?
        .into_iter()
        .filter(|m| s(&m["provider"]) == p)
        .collect::<Vec<_>>()))
}

pub fn row(m: &Value) -> Value {
    let mut v = json!({"id":format!("{}/{}",s(&m["provider"]),s(&m["id"]))});
    for k in [
        "provider",
        "name",
        "context",
        "max_output",
        "vision",
        "tools",
        "reasoning",
        "thinking_levels",
        "cost",
        "metadata_estimated",
    ] {
        v[k] = m.get(k).cloned().unwrap_or(Value::Null);
    }
    v
}

fn reasoning_levels(row: &Value) -> Option<Vec<&'static str>> {
    let info = &row["reasoning"];
    let mut levels = std::collections::HashSet::new();
    if let Some(efforts) = info["supported_efforts"].as_array() {
        for e in efforts {
            let e = s(e);
            levels.insert(if e == "none" { "off" } else { e });
        }
        if info["mandatory"] != true && !levels.contains("off") {
            levels.insert("off");
        }
    } else if row["supported_parameters"]
        .as_array()
        .is_some_and(|p| p.iter().any(|v| v == "reasoning"))
    {
        return Some(vec!["off", "medium"]);
    } else {
        return None;
    }
    let result: Vec<_> = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        .into_iter()
        .filter(|l| levels.contains(l))
        .collect();
    if result.len() > 1 {
        Some(result)
    } else {
        None
    }
}
async fn llama_router(
    client: &reqwest::Client,
    config: &Value,
    headers: &reqwest::header::HeaderMap,
    known: &[Value],
) -> Result<Option<Vec<Value>>, String> {
    let base = s(&config["base_url"])
        .trim_end_matches('/')
        .trim_end_matches("/v1");
    let response = client
        .get(format!("{base}/models"))
        .headers(headers.clone())
        .send()
        .await
        .map_err(|e| format!("Model discovery failed: {}", e.without_url()))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!(
            "Model discovery returned HTTP {}",
            response.status()
        ));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| "Invalid model discovery response")?;
    let Some(rows) = body["data"].as_array().filter(|r| {
        r.iter()
            .all(|x| x["id"].is_string() && x["status"]["value"].is_string())
    }) else {
        return Ok(None);
    };
    let general = client
        .get(format!("{base}/props"))
        .headers(headers.clone())
        .send()
        .await
        .ok();
    let general = match general {
        Some(r) if r.status().is_success() => r.json::<Value>().await.unwrap_or_default(),
        _ => Value::Null,
    };
    let mut entries = vec![];
    for row in rows {
        let status = &row["status"];
        let state = s(&status["value"]);
        let outputs = row["architecture"]["output_modalities"].as_array();
        if outputs.is_some_and(|a| !a.is_empty() && !a.iter().any(|v| v == "text"))
            || status["failed"] == true
            || !(matches!(state, "loaded" | "sleeping")
                || (general["models_autoload"] == true
                    && state == "unloaded"
                    && row["source"] == "preset"))
        {
            continue;
        }
        let id = s(&row["id"]);
        let old = known
            .iter()
            .find(|v| s(&v["provider"]) == "llama.cpp" && s(&v["id"]) == id);
        let mut item = old.cloned().unwrap_or(json!({}));
        item["id"] = json!(id);
        item["name"] = json!(id);
        item["router_status"] = json!(state);
        let props = client
            .get(format!("{base}/props"))
            .headers(headers.clone())
            .query(&[("model", id), ("autoload", "false")])
            .send()
            .await
            .ok();
        let props = match props {
            Some(r) if r.status().is_success() => r.json::<Value>().await.unwrap_or_default(),
            _ => Value::Null,
        };
        let meta = &row["meta"];
        let mut context = meta["n_ctx"]
            .as_u64()
            .or_else(|| props["n_ctx"].as_u64())
            .or_else(|| props["default_generation_settings"]["n_ctx"].as_u64());
        if context.is_none() {
            if let Some(args) = status["args"].as_array() {
                for pair in args.windows(2) {
                    if ["--ctx-size", "-c", "-ctx"].contains(&s(&pair[0])) {
                        context = pair[1].as_str().and_then(|v| v.parse().ok());
                        break;
                    }
                }
            }
        }
        context = context
            .or_else(|| {
                old.filter(|v| v["metadata_estimated"] == false)
                    .and_then(|v| v["context"].as_u64())
            })
            .or_else(|| meta["n_ctx_train"].as_u64());
        if let Some(n) = context.filter(|n| *n > 0) {
            item["context"] = json!(n);
            item["max_output"] = json!(n);
            item["metadata_estimated"] = json!(false);
        }
        let inputs = row["architecture"]["input_modalities"].as_array();
        let vision = props["modalities"]
            .get("vision")
            .or_else(|| meta.get("vision"));
        if inputs.is_some() || vision.is_some() {
            item["vision"] = json!(
                inputs.is_some_and(|v| v.iter().any(|x| x == "image"))
                    || vision == Some(&json!(true))
            );
        }
        if props.get("chat_template").is_some() {
            let enabled = s(&props["chat_template"]).contains("enable_thinking");
            item["reasoning"] = json!(enabled);
            item["thinking_levels"] = if enabled {
                json!(["off", "medium"])
            } else {
                json!(["off"])
            };
            item["reasoning_format"] = if enabled {
                json!("qwen-chat-template")
            } else {
                Value::Null
            };
        }
        item["cost"] = json!({"input":0,"output":0,"cache_read":0,"cache_write":0});
        entries.push(item);
    }
    Ok(Some(entries))
}

#[cfg(test)]
mod graphy_tests {
    use super::*;
    #[test]
    fn graphy_models_are_the_three_quality_presets_and_the_token_is_created_once() {
        let dir = tempfile::tempdir().unwrap();
        let ids: Vec<String> = available(dir.path()).unwrap().iter().filter(|m| s(&m["provider"]) == "graphy").map(|m| s(&m["id"]).to_owned()).collect();
        assert_eq!(ids.len(), 3, "{ids:?}");
        for want in ["deepseek/deepseek-v4.1-flash", "anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5"] {
            assert!(ids.iter().any(|i| i == want), "{want}");
        }
        let first = credential(dir.path(), "graphy").unwrap();
        assert!(s(&first["key"]).starts_with("anon-"));
        let again = key(dir.path(), "graphy", &settings(dir.path(), "graphy").unwrap()).unwrap();
        assert_eq!(again, s(&first["key"]), "the same install keeps its token");
    }
}
