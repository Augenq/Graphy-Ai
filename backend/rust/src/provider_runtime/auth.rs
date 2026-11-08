use super::catalog::{self, s};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use fs2::FileExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{broadcast, mpsc, oneshot},
};
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH: &str = "https://auth.openai.com";
const REDIRECT: &str = "http://localhost:1455/auth/callback";
struct Flow {
    input: mpsc::UnboundedSender<String>,
    cancel: oneshot::Sender<()>,
}
static FLOWS: OnceLock<Mutex<HashMap<String, Flow>>> = OnceLock::new();
static EVENTS: OnceLock<broadcast::Sender<Value>> = OnceLock::new();
fn flows() -> &'static Mutex<HashMap<String, Flow>> {
    FLOWS.get_or_init(|| Mutex::new(HashMap::new()))
}
pub fn subscribe() -> broadcast::Receiver<Value> {
    EVENTS.get_or_init(|| broadcast::channel(256).0).subscribe()
}
fn publish(id: &str, state: &str, extra: Value) {
    let mut v = json!({"type":"login","flow_id":id,"provider":"openai-codex","state":state});
    catalog::merge(&mut v, &extra);
    let _ = EVENTS.get_or_init(|| broadcast::channel(256).0).send(v);
}
fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
fn token_credential(data: &Value) -> Result<Value, String> {
    let access = s(&data["access_token"]);
    let refresh = s(&data["refresh_token"]);
    let part = access
        .split('.')
        .nth(1)
        .ok_or("Codex token response missing valid access/refresh/expiry/account ID")?;
    let decoded = URL_SAFE_NO_PAD
        .decode(part)
        .map_err(|_| "Codex token response missing valid access/refresh/expiry/account ID")?;
    let jwt: Value = serde_json::from_slice(&decoded)
        .map_err(|_| "Codex token response missing valid access/refresh/expiry/account ID")?;
    let account = s(&jwt["https://api.openai.com/auth"]["chatgpt_account_id"]);
    let expiry = data["expires_in"]
        .as_f64()
        .or_else(|| data["expires_in"].as_str().and_then(|v| v.parse().ok()))
        .unwrap_or(0.);
    if access.is_empty()
        || refresh.is_empty()
        || account.is_empty()
        || !expiry.is_finite()
        || expiry <= 0.
    {
        return Err("Codex token response missing valid access/refresh/expiry/account ID".into());
    }
    Ok(
        json!({"type":"oauth","access":access,"refresh":refresh,"expires":now()+expiry,"accountId":account}),
    )
}
async fn token(
    client: &reqwest::Client,
    auth_base: &str,
    fields: &[(&str, &str)],
) -> Result<Value, String> {
    let mut form = vec![("client_id", CLIENT_ID)];
    form.extend_from_slice(fields);
    let resp = client
        .post(format!("{auth_base}/oauth/token"))
        .form(&form)
        .send()
        .await
        .map_err(|_| "Codex token exchange failed")?;
    if !resp.status().is_success() {
        return Err(format!(
            "Codex token exchange failed ({}); log in again if expired",
            resp.status().as_u16()
        ));
    }
    let value: Value = resp
        .json()
        .await
        .map_err(|_| "Invalid Codex token response")?;
    token_credential(&value)
}
pub(super) async fn lock(root: &Path, name: &str) -> Result<std::fs::File, String> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let f = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(name))
        .map_err(|e| e.to_string())?;
    loop {
        match f.try_lock_exclusive() {
            Ok(()) => return Ok(f),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                tokio::time::sleep(Duration::from_millis(100)).await
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}
pub async fn set_credential(root: &Path, p: &str, value: Option<Value>) -> Result<(), String> {
    let _guard = lock(root, "auth.lock").await?;
    let mut auth = catalog::read(root, "auth.json")?;
    if let Some(v) = value {
        auth[p] = v;
    } else if let Some(map) = auth.as_object_mut() {
        map.remove(p);
    }
    catalog::write(root, "auth.json", &auth)
}
pub async fn update_credential(root: &Path, p: &str, patch: Value) -> Result<(), String> {
    let _guard = lock(root, "auth.lock").await?;
    let mut auth = catalog::read(root, "auth.json")?;
    if !auth[p].is_object() {
        auth[p] = json!({});
    }
    catalog::merge(&mut auth[p], &patch);
    catalog::write(root, "auth.json", &auth)
}
pub async fn codex_credential(root: &Path) -> Result<Value, String> {
    let _guard = lock(root, "codex-refresh.lock").await?;
    let mut cred = catalog::credential(root, "openai-codex")?;
    let original = cred.clone();
    let refresh = s(&cred["refresh"]).to_owned();
    if refresh.is_empty() {
        return Err("Use /login openai-codex to sign in with ChatGPT".into());
    }
    let mut expires = cred["expires"].as_f64().unwrap_or(0.);
    if expires > 1e11 {
        expires /= 1000.;
    }
    if expires > now() + 60. {
        return Ok(cred);
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let refreshed = token(
        &client,
        AUTH,
        &[("grant_type", "refresh_token"), ("refresh_token", &refresh)],
    )
    .await?;
    catalog::merge(&mut cred, &refreshed);
    commit_refresh(root, &original, &cred).await?;
    Ok(cred)
}
async fn commit_refresh(root: &Path, original: &Value, refreshed: &Value) -> Result<(), String> {
    let _guard = lock(root, "auth.lock").await?;
    let mut auth = catalog::read(root, "auth.json")?;
    if &auth["openai-codex"] != original {
        return Err(
            "Codex credentials changed during refresh; retry the request or sign in again".into(),
        );
    }
    auth["openai-codex"] = refreshed.clone();
    catalog::write(root, "auth.json", &auth)
}

fn authorization_input(value: &str, state: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("Missing authorization code".into());
    }
    let query = if value.contains("://") {
        url::Url::parse(value)
            .map_err(|_| "Missing authorization code")?
            .query()
            .unwrap_or("")
            .to_owned()
    } else {
        value.to_owned()
    };
    let (code, supplied) = if query.contains("code=") {
        let pairs: HashMap<String, String> = url::form_urlencoded::parse(query.as_bytes())
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        (
            pairs.get("code").cloned().unwrap_or_default(),
            pairs.get("state").cloned().unwrap_or_default(),
        )
    } else if let Some((code, state)) = value.split_once('#') {
        (code.to_owned(), state.to_owned())
    } else {
        (value.to_owned(), String::new())
    };
    if !supplied.is_empty() && supplied != state {
        return Err("OAuth state mismatch".into());
    }
    if code.is_empty() {
        return Err("Missing authorization code".into());
    }
    Ok(code)
}
async fn run(
    root: std::path::PathBuf,
    id: &str,
    method: &str,
    auth_base: &str,
    mut input: mpsc::UnboundedReceiver<String>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let cred = if matches!(method, "device" | "device_code") {
        let response = client
            .post(format!("{auth_base}/api/accounts/deviceauth/usercode"))
            .json(&json!({"client_id":CLIENT_ID}))
            .send()
            .await
            .map_err(|_| "Codex device login unavailable; try browser login")?;
        if !response.status().is_success() {
            return Err(format!(
                "Codex device login unavailable ({}); try browser login",
                response.status().as_u16()
            ));
        }
        let data: Value = response
            .json()
            .await
            .map_err(|_| "Invalid device authorization response")?;
        let device = s(&data["device_auth_id"]);
        let user = s(&data["user_code"]);
        let mut interval = data["interval"]
            .as_f64()
            .or_else(|| data["interval"].as_str().and_then(|v| v.parse().ok()))
            .unwrap_or(5.)
            .max(1.);
        if device.is_empty() || user.is_empty() || interval > 60. {
            return Err("Invalid device authorization response".into());
        }
        publish(
            id,
            "running",
            json!({"message":format!("Open {AUTH}/codex/device and enter code: {user}"),"url":format!("{AUTH}/codex/device"),"user_code":user}),
        );
        let deadline = tokio::time::Instant::now() + Duration::from_secs(900);
        loop {
            if tokio::time::Instant::now() >= deadline {
                return Err("Device login expired; start again".into());
            }
            tokio::time::sleep(Duration::from_secs_f64(interval)).await;
            let response = client
                .post(format!("{auth_base}/api/accounts/deviceauth/token"))
                .json(&json!({"device_auth_id":device,"user_code":user}))
                .send()
                .await
                .map_err(|_| "Device login failed")?;
            let status = response.status();
            let v: Value = response.json().await.unwrap_or_default();
            if status.is_success() {
                let code = s(&v["authorization_code"]);
                let verifier = s(&v["code_verifier"]);
                if code.is_empty() || verifier.is_empty() {
                    return Err("Invalid device token response".into());
                }
                break token(
                    &client,
                    auth_base,
                    &[
                        ("grant_type", "authorization_code"),
                        ("code", code),
                        ("code_verifier", verifier),
                        (
                            "redirect_uri",
                            "https://auth.openai.com/deviceauth/callback",
                        ),
                    ],
                )
                .await?;
            }
            let e = v["error"]
                .as_str()
                .or_else(|| v["error"]["code"].as_str())
                .unwrap_or("");
            if e == "slow_down" {
                interval += 5.;
            } else if ![403, 404].contains(&status.as_u16())
                && e != "deviceauth_authorization_pending"
            {
                return Err(format!("Device login failed ({})", status.as_u16()));
            }
        }
    } else {
        let verifier = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let state = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let mut url = url::Url::parse(&format!("{auth_base}/oauth/authorize")).unwrap();
        url.query_pairs_mut().extend_pairs(&[
            ("response_type", "code"),
            ("client_id", CLIENT_ID),
            ("redirect_uri", REDIRECT),
            ("scope", "openid profile email offline_access"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("state", &state),
            ("id_token_add_organizations", "true"),
            ("codex_cli_simplified_flow", "true"),
            ("originator", "pi"),
        ]);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:1455").await.ok();
        if listener.is_none() {
            publish(
                id,
                "running",
                json!({"message":"Port 1455 unavailable; paste the final redirect URL after login."}),
            );
        }
        publish(
            id,
            "running",
            json!({"message":format!("Open this URL to sign in with ChatGPT:\n{url}"),"url":url.as_str()}),
        );
        publish(
            id,
            "waiting_input",
            json!({"prompt":"Complete browser login, or paste redirect URL / code:"}),
        );
        let callback = async {
            if let Some(listener) = listener {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let mut buf = [0u8; 8192];
                    let n = tokio::time::timeout(Duration::from_secs(5), socket.read(&mut buf))
                        .await
                        .ok()
                        .and_then(Result::ok)
                        .unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let path = req.split_whitespace().nth(1).unwrap_or("");
                    let parsed = url::Url::parse(&format!("http://localhost{path}"));
                    let code = parsed
                        .ok()
                        .filter(|u| u.path() == "/auth/callback")
                        .and_then(|u| {
                            let pairs: HashMap<_, _> = u
                                .query_pairs()
                                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                                .collect();
                            if pairs.get("state") == Some(&state) {
                                pairs.get("code").filter(|x| !x.is_empty()).cloned()
                            } else {
                                None
                            }
                        });
                    let body = if code.is_some() {
                        "Login complete. You may close this tab."
                    } else {
                        "Invalid OAuth callback."
                    };
                    let response=format!("HTTP/1.1 {}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\r\n{body}",if code.is_some(){"200 OK"}else{"400 Bad Request"},body.len());
                    let _ = socket.write_all(response.as_bytes()).await;
                    if let Some(code) = code {
                        return Some(code);
                    }
                }
            }
            std::future::pending::<Option<String>>().await
        };
        let code=tokio::time::timeout(Duration::from_secs(900),async{tokio::select!{v=input.recv()=>v.map(|v|authorization_input(&v,&state)).unwrap_or_else(||Err("Login cancelled".into())),v=callback=>v.ok_or_else(||"Login cancelled".to_owned())}}).await.map_err(|_|"Browser login expired; start again")??;
        token(
            &client,
            auth_base,
            &[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("code_verifier", &verifier),
                ("redirect_uri", REDIRECT),
            ],
        )
        .await?
    };
    set_credential(&root, "openai-codex", Some(cred)).await?;
    publish(id, "running", json!({"message":"Codex login saved."}));
    Ok(())
}
pub async fn dispatch(op: &str, data: Value) -> Result<Value, String> {
    match op {
        "auth.start" => {
            let method = data["method"].as_str().unwrap_or("browser");
            if !matches!(method, "browser" | "device") {
                return Err("method must be browser or device".into());
            }
            let mut active = flows().lock().map_err(|_| "Login flow lock poisoned")?;
            if !active.is_empty() {
                return Err("A login is already in progress".into());
            }
            let id = uuid::Uuid::new_v4().simple().to_string();
            let (input_tx, input_rx) = mpsc::unbounded_channel();
            let (cancel_tx, cancel_rx) = oneshot::channel();
            active.insert(
                id.clone(),
                Flow {
                    input: input_tx,
                    cancel: cancel_tx,
                },
            );
            let root = catalog::root(&data);
            let id2 = id.clone();
            let method = method.to_owned();
            tokio::spawn(async move {
                publish(&id2, "starting", json!({}));
                tokio::select! {result=run(root,&id2,&method,AUTH,input_rx)=>match result{Ok(())=>publish(&id2,"done",json!({})),Err(e)=>publish(&id2,"error",json!({"message":e}))},_=cancel_rx=>publish(&id2,"cancelled",json!({}))};
                if let Ok(mut active) = flows().lock() {
                    active.remove(&id2);
                }
            });
            Ok(json!({"flow_id":id}))
        }
        "auth.input" => {
            let id = s(&data["flow_id"]);
            let active = flows().lock().map_err(|_| "Login flow lock poisoned")?;
            let f = active.get(id).ok_or("No such login")?;
            f.input
                .send(s(&data["value"]).to_owned())
                .map_err(|_| "This login is not waiting for input")?;
            Ok(json!({}))
        }
        "auth.cancel" => {
            let id = s(&data["flow_id"]);
            let mut active = flows().lock().map_err(|_| "Login flow lock poisoned")?;
            let f = active.remove(id).ok_or("No such login")?;
            let _ = f.cancel.send(());
            Ok(json!({}))
        }
        "auth.authorization_input" => Ok(json!(authorization_input(
            s(&data["value"]),
            s(&data["state"])
        )?)),
        _ => Err(format!("Unknown auth operation: {op}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    #[tokio::test]
    async fn device_login_polls_pending_then_saves_credential_and_reports_code() {
        async fn usercode() -> Json<Value> {
            Json(json!({"device_auth_id":"device-id","user_code":"ABCD","interval":1}))
        }
        async fn poll(State(n): State<Arc<AtomicUsize>>) -> (StatusCode, Json<Value>) {
            if n.fetch_add(1, Ordering::SeqCst) == 0 {
                (
                    StatusCode::FORBIDDEN,
                    Json(json!({"error":"deviceauth_authorization_pending"})),
                )
            } else {
                (
                    StatusCode::OK,
                    Json(json!({"authorization_code":"code","code_verifier":"verifier"})),
                )
            }
        }
        async fn exchange() -> Json<Value> {
            let claims = URL_SAFE_NO_PAD.encode(
                json!({"https://api.openai.com/auth":{"chatgpt_account_id":"account"}}).to_string(),
            );
            Json(
                json!({"access_token":format!("header.{claims}.signature"),"refresh_token":"refresh-secret","expires_in":3600}),
            )
        }
        let polls = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route("/api/accounts/deviceauth/usercode", post(usercode))
            .route("/api/accounts/deviceauth/token", post(poll))
            .route("/oauth/token", post(exchange))
            .with_state(polls.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut events = subscribe();
        let id = uuid::Uuid::new_v4().simple().to_string();
        let dir = tempfile::tempdir().unwrap();
        let (_input, rx) = mpsc::unbounded_channel();
        run(
            dir.path().to_owned(),
            &id,
            "device",
            &format!("http://{addr}"),
            rx,
        )
        .await
        .unwrap();
        assert_eq!(polls.load(Ordering::SeqCst), 2);
        let credential = catalog::credential(dir.path(), "openai-codex").unwrap();
        assert_eq!(credential["accountId"], "account");
        assert_eq!(credential["refresh"], "refresh-secret");
        let event = loop {
            let event = events.recv().await.unwrap();
            if event["flow_id"] == id && event.get("user_code").is_some() {
                break event;
            }
        };
        assert_eq!(event["flow_id"], id);
        assert_eq!(event["user_code"], "ABCD");
        assert!(!event.to_string().contains("refresh-secret"));
    }
    #[tokio::test]
    async fn browser_login_reports_prompt_and_rejects_wrong_state_before_exchange() {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_owned();
        let mut events = subscribe();
        let (input, rx) = mpsc::unbounded_channel();
        let id2 = id.clone();
        let task =
            tokio::spawn(async move { run(root, &id2, "browser", "http://127.0.0.1:1", rx).await });
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let event = events.recv().await.unwrap();
                if event["flow_id"] == id && event["state"] == "waiting_input" {
                    assert!(event["prompt"].is_string());
                    break;
                }
            }
        })
        .await
        .unwrap();
        input.send("code=abc&state=wrong".into()).unwrap();
        assert_eq!(task.await.unwrap().unwrap_err(), "OAuth state mismatch");
        assert!(!dir.path().join("auth.json").exists());
    }
}

#[cfg(test)]
mod refresh_race_tests {
    use super::*;
    #[tokio::test]
    async fn refresh_cannot_resurrect_disconnected_or_overwrite_relogged_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let old = json!({"refresh":"old"});
        let fresh = json!({"refresh":"refreshed"});
        set_credential(dir.path(), "openai-codex", Some(old.clone()))
            .await
            .unwrap();
        commit_refresh(dir.path(), &old, &fresh).await.unwrap();
        assert_eq!(
            catalog::credential(dir.path(), "openai-codex").unwrap(),
            fresh
        );
        set_credential(dir.path(), "openai-codex", None)
            .await
            .unwrap();
        assert!(commit_refresh(dir.path(), &old, &fresh).await.is_err());
        assert!(catalog::read(dir.path(), "auth.json")
            .unwrap()
            .get("openai-codex")
            .is_none());
        let login = json!({"refresh":"new-login"});
        set_credential(dir.path(), "openai-codex", Some(login.clone()))
            .await
            .unwrap();
        assert!(commit_refresh(dir.path(), &old, &fresh).await.is_err());
        assert_eq!(
            catalog::credential(dir.path(), "openai-codex").unwrap(),
            login
        );
    }
}
