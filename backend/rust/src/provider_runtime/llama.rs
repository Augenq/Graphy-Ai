use super::catalog::{self, s};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, OnceLock,
};
use std::time::Duration;
use tokio::sync::broadcast;
fn base(value: &str) -> Result<String, String> {
    let mut u = url::Url::parse(value.trim())
        .map_err(|_| "Router URL must be HTTP(S), without embedded credentials")?;
    if !matches!(u.scheme(), "http" | "https")
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
    {
        return Err("Router URL must be HTTP(S), without embedded credentials".into());
    }
    let path = u
        .path()
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .to_owned();
    u.set_path(&path);
    u.set_query(None);
    u.set_fragment(None);
    Ok(u.as_str().trim_end_matches('/').to_owned())
}

static EVENTS: OnceLock<broadcast::Sender<Value>> = OnceLock::new();
pub fn subscribe() -> broadcast::Receiver<Value> {
    EVENTS.get_or_init(|| broadcast::channel(256).0).subscribe()
}
fn emit(model: &str, action: &str, message: &str) {
    let _ = EVENTS
        .get_or_init(|| broadcast::channel(256).0)
        .send(json!({"type":"llama_progress","model":model,"action":action,"message":message}));
}
fn progress(data: &Value) -> String {
    let v = data
        .get("progress")
        .filter(|x| x.is_object())
        .unwrap_or(data);
    let mut done = 0.;
    let mut total = 0.;
    if let Some(o) = v.as_object() {
        for entry in o.values() {
            if let (Some(d), Some(t)) = (entry["done"].as_f64(), entry["total"].as_f64()) {
                done += d;
                total += t;
            }
        }
    }
    if total > 0. {
        return format!(
            "Downloading {:.1}% ({:.1}/{:.1} MiB)",
            (done / total * 100.).clamp(0., 100.),
            done / 1048576.,
            total / 1048576.
        );
    }
    let stage = v
        .get("current")
        .or_else(|| v.get("stage"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let value = v["value"].as_f64();
    if !stage.is_empty() || value.is_some() {
        let mut ratio = value.unwrap_or(0.).clamp(0., 1.);
        if let Some(stages) = v["stages"].as_array() {
            if let Some(index) = stages.iter().position(|x| x == stage) {
                ratio = (index as f64 + ratio) / stages.len() as f64;
            }
        }
        return format!("Loading {} {:.1}%", stage.replace('_', " "), ratio * 100.)
            .trim()
            .to_owned();
    }
    String::new()
}
struct Watcher(tokio::task::JoinHandle<()>);
impl Drop for Watcher {
    fn drop(&mut self) {
        self.0.abort();
    }
}
async fn watch(base: String, key: String, model: String, action: String, failed: Arc<AtomicBool>) {
    let Ok(client) = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .build()
    else {
        return;
    };
    let mut req = client.get(format!("{base}/models/sse"));
    if !key.is_empty() {
        req = req.bearer_auth(key);
    }
    let Ok(response) = req.send().await else {
        return;
    };
    if !response.status().is_success() {
        return;
    }
    let mut chunks = response.bytes_stream();
    let mut buf = Vec::new();
    let mut data = Vec::new();
    while let Some(Ok(chunk)) = chunks.next().await {
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let mut line: Vec<_> = buf.drain(..=pos).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.starts_with(b"data:") {
                data.push(String::from_utf8_lossy(&line[5..]).trim_start().to_owned());
            } else if line.is_empty() && !data.is_empty() {
                let raw = data.join("\n");
                data.clear();
                let Ok(event) = serde_json::from_str::<Value>(&raw) else {
                    continue;
                };
                if event["model"] != model {
                    continue;
                }
                if event["event"] == "download_failed" {
                    failed.store(true, Ordering::SeqCst);
                }
                let message = progress(&event["data"]);
                if !message.is_empty() {
                    emit(&model, &action, &message);
                }
            }
        }
    }
}

struct CancelGuard {
    client: reqwest::Client,
    url: String,
    key: String,
    model: String,
    armed: bool,
}
impl Drop for CancelGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let client = self.client.clone();
        let url = self.url.clone();
        let key = self.key.clone();
        let model = self.model.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = request(
                    &client,
                    &url,
                    "POST",
                    &key,
                    Some(&json!({"model":model})),
                    &[],
                    "llama.cpp",
                )
                .await;
            });
        }
    }
}
async fn request(
    client: &reqwest::Client,
    url: &str,
    method: &str,
    key: &str,
    body: Option<&Value>,
    params: &[(&str, &str)],
    service: &str,
) -> Result<Value, String> {
    let mut req = client
        .request(
            if method == "POST" {
                reqwest::Method::POST
            } else {
                reqwest::Method::GET
            },
            url,
        )
        .query(params);
    if !key.is_empty() {
        req = req.bearer_auth(key);
    }
    if let Some(body) = body {
        req = req.json(body);
    }
    let response = req
        .send()
        .await
        .map_err(|_| format!("{service} connection failed"))?;
    if !response.status().is_success() {
        let suffix = if response.status().as_u16() == 429 {
            response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .filter(|v| v.chars().all(|c| c.is_ascii_digit()))
                .map(|x| format!("; retry after {x}s"))
                .unwrap_or_default()
        } else {
            String::new()
        };
        return Err(format!(
            "{service} returned HTTP {}{suffix}",
            response.status().as_u16()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| format!("{service} connection failed"))?;
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&bytes).map_err(|_| format!("{service} returned invalid JSON"))
}
fn validate(v: Value) -> Result<Value, String> {
    let rows = v["data"]
        .as_array()
        .ok_or("Invalid router catalog; llama.cpp must run in router mode")?;
    if rows
        .iter()
        .any(|x| !x["id"].is_string() || !x["status"]["value"].is_string())
    {
        return Err("Invalid router catalog; llama.cpp must run in router mode".into());
    }
    Ok(json!(rows))
}
fn entry<'a>(rows: &'a Value, model: &str) -> Option<&'a Value> {
    rows.as_array()?.iter().find(|r| {
        s(&r["id"]) == model
            || r["aliases"]
                .as_array()
                .is_some_and(|a| a.iter().any(|x| x == model))
    })
}
pub async fn dispatch(op: &str, data: Value) -> Result<Value, String> {
    let root = catalog::root(&data);
    let config = catalog::settings(&root, "llama.cpp")?;
    let endpoint = data["base_url"]
        .as_str()
        .unwrap_or_else(|| s(&config["base_url"]));
    let base = base(endpoint)?;
    let key = if let Some(key) = data["key"].as_str() {
        key.to_owned()
    } else {
        catalog::key(&root, "llama.cpp", &config)?
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let model = s(&data["model"]);
    let list = |reload: bool| {
        let client = &client;
        let base = &base;
        let key = &key;
        async move {
            let params = if reload {
                vec![("reload", "1")]
            } else {
                vec![]
            };
            validate(
                request(
                    &client,
                    &format!("{base}/models"),
                    "GET",
                    &key,
                    None,
                    &params,
                    "llama.cpp",
                )
                .await?,
            )
        }
    };
    match op {
        "llama.list" => list(data["reload"] == true).await,
        "llama.props" => {
            let params = if model.is_empty() {
                vec![]
            } else {
                vec![("model", model), ("autoload", "false")]
            };
            request(
                &client,
                &format!("{base}/props"),
                "GET",
                &key,
                None,
                &params,
                "llama.cpp",
            )
            .await
        }
        "llama.cancel" => {
            let action = s(&data["action"]);
            if !matches!(action, "load" | "unload" | "download") {
                return Err("Unknown router action".into());
            }
            let requested = matches!(action, "load" | "download");
            let error = if requested {
                request(
                    &client,
                    &format!("{base}/models/unload"),
                    "POST",
                    &key,
                    Some(&json!({"model":model})),
                    &[],
                    "llama.cpp",
                )
                .await
                .err()
            } else {
                None
            };
            let observed = list(false).await.ok();
            let state = observed
                .as_ref()
                .and_then(|v| entry(v, model))
                .map(|v| s(&v["status"]["value"]))
                .unwrap_or(if observed.is_some() {
                    "absent"
                } else {
                    "unknown"
                });
            let confirmed = matches!(state, "absent" | "unloaded");
            Ok(
                json!({"requested":requested,"confirmed":confirmed,"message":format!("Router state: {state}. {}{}",if confirmed{"Operation stopped."}else{"Remote cancellation is not confirmed."},error.map(|s|format!(" {s}")).unwrap_or_default()),"models":observed}),
            )
        }
        "llama.perform" => {
            let action = s(&data["action"]);
            let path = match action {
                "load" => "/models/load",
                "unload" => "/models/unload",
                "download" => "/models",
                _ => return Err("Expected load, unload or download and a nonempty model".into()),
            };
            if model.trim().is_empty() {
                return Err("Expected load, unload or download and a nonempty model".into());
            }
            let failed = Arc::new(AtomicBool::new(false));
            let _watcher = Watcher(tokio::spawn(watch(
                base.clone(),
                key.clone(),
                model.to_owned(),
                action.to_owned(),
                failed.clone(),
            )));
            let mut cancel_guard = CancelGuard {
                client: client.clone(),
                url: format!("{base}/models/unload"),
                key: key.clone(),
                model: model.to_owned(),
                armed: matches!(action, "load" | "download"),
            };
            let outcome:Result<Value,String>=async {
            if let Err(e) = request(
                &client,
                &format!("{base}{path}"),
                "POST",
                &key,
                Some(&json!({"model":model})),
                &[],
                "llama.cpp",
            )
            .await
            {
                return Err(format!(
                    "{e}. Operation was not retried; inspect router status before retrying"
                ));
            }
            emit(model,action,match action {"load"=>"Loading model","unload"=>"Unloading model",_=>"Downloading model"});
            let deadline = tokio::time::Instant::now() + Duration::from_secs(1200);
            let mut stable = 0;
            loop {
                if tokio::time::Instant::now() > deadline {
                    return Err("Router operation timed out; remote work may continue. Inspect status or cancel before retrying".into());
                }
                let models = list(false).await?;
                let ent = entry(&models, model);
                let status = ent.map(|x| &x["status"]);
                let value = status.map(|x| s(&x["value"])).unwrap_or("");
                if status.is_some_and(|x| x["failed"] == true) || value == "failed" || failed.load(Ordering::SeqCst) {
                    return Err(format!("Model {action} failed"));
                }
                if (action == "load" && value == "loaded")
                    || (action == "unload" && (ent.is_none() || value == "unloaded"))
                {
                    return Ok(models);
                }
                if action == "download" {
                    if ent.is_some() && !matches!(value, "downloading" | "loading") {
                        stable += 1
                    } else {
                        stable = 0;
                    }
                    if stable >= 2 {
                        return list(true).await;
                    }
                }
                if let Some(status)=status {let message=progress(status);if !message.is_empty(){emit(model,action,&message);}}
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            }.await;
            cancel_guard.armed = false;
            outcome
        }
        "llama.search" => {
            let query = s(&data["query"]);
            let token = std::env::var("HF_TOKEN").unwrap_or_default();
            let v = request(
                &client,
                "https://huggingface.co/api/models",
                "GET",
                &token,
                None,
                &[
                    ("search", query),
                    ("filter", "gguf"),
                    ("sort", "downloads"),
                    ("direction", "-1"),
                    ("limit", "20"),
                ],
                "Hugging Face",
            )
            .await?;
            let rows = v
                .as_array()
                .ok_or("Hugging Face returned invalid search results")?;
            Ok(json!(rows.iter().filter(|v|v["id"].is_string()).map(|v|json!({"id":v["id"],"downloads":v.get("downloads").cloned().unwrap_or(json!(0))})).collect::<Vec<_>>()))
        }
        "llama.variants" => {
            let repo = s(&data["repo"]).split(':').next().unwrap_or("");
            let mut u = url::Url::parse("https://huggingface.co/api/models/").unwrap();
            {
                let mut seg = u
                    .path_segments_mut()
                    .map_err(|_| "Invalid model repository")?;
                seg.pop_if_empty();
                for p in repo.split('/') {
                    seg.push(p);
                }
            }
            let token = std::env::var("HF_TOKEN").unwrap_or_default();
            let v = request(
                &client,
                u.as_str(),
                "GET",
                &token,
                None,
                &[("blobs", "true")],
                "Hugging Face",
            )
            .await?;
            let siblings = v["siblings"]
                .as_array()
                .ok_or("Hugging Face returned invalid model details")?;
            let re=regex::Regex::new(r"(?i)(?:^|[-_.])((?:UD-)?(?:(?:IQ|Q)\d(?:_[A-Z0-9]+)+|BF16|F16|F32|MXFP\d(?:_[A-Z0-9]+)*))$").unwrap();
            let shard = regex::Regex::new(r"-\d{5}-of-\d{5}$").unwrap();
            let mut sizes = std::collections::BTreeMap::<String, Option<u64>>::new();
            for file in siblings {
                let name = s(&file["rfilename"]).rsplit('/').next().unwrap_or("");
                if !name.to_lowercase().ends_with(".gguf")
                    || name.to_lowercase().starts_with("mmproj")
                {
                    continue;
                }
                let stem = shard.replace(&name[..name.len() - 5], "");
                if let Some(c) = re.captures(&stem) {
                    let quant = c[1].to_uppercase();
                    let size = file["size"].as_u64();
                    sizes
                        .entry(quant)
                        .and_modify(|x| *x = x.zip(size).map(|(a, b)| a + b))
                        .or_insert(size);
                }
            }
            let mut quants: Vec<_> = sizes
                .into_iter()
                .map(|(name, size)| {
                    let mut v = json!({"name":name});
                    if let Some(size) = size {
                        v["size"] = json!(size);
                    }
                    v
                })
                .collect();
            quants.sort_by_key(|v| {
                (
                    s(&v["name"]) != "Q4_K_M",
                    v["size"].as_u64().unwrap_or(u64::MAX),
                    s(&v["name"]).to_owned(),
                )
            });
            Ok(
                json!({"id":v.get("id").cloned().unwrap_or(json!(repo)),"gated":v.get("gated").cloned().unwrap_or(json!(false)),"quantizations":quants}),
            )
        }
        _ => Err(format!("Unknown llama operation: {op}")),
    }
}
