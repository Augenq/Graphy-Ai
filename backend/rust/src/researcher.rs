//! `spawn_researcher`: a read-only research sub-agent the main agent can call. It runs its own short tool loop
//! (web_search + web_read only, same model, own context, no recursion) and hands back one compact JSON result.
//! The learner sees an ordinary tool row whose live progress line comes from `tool_update` events.
use crate::backend_runtime::{App, Session};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

pub(crate) const NAME: &str = "spawn_researcher";
const WEB_TOOLS: [&str; 2] = ["web_search", "web_read"];

/// Hard caps by depth: model turns with tools, wall clock, tokens (input + output summed over turns).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Limits {
    pub steps: usize,
    pub seconds: u64,
    pub tokens: u64,
}
pub(crate) fn limits(depth: &str) -> Limits {
    match depth {
        "quick" => Limits { steps: 5, seconds: 90, tokens: 80_000 },
        "deep" => Limits { steps: 20, seconds: 480, tokens: 600_000 },
        _ => Limits { steps: 10, seconds: 240, tokens: 250_000 },
    }
}

/// One researcher per backend at a time: the guard is released when the call ends, however it ends.
fn running() -> &'static Mutex<HashSet<String>> {
    static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}
struct Flight(String);
impl Flight {
    fn enter(key: &str) -> Option<Flight> {
        running().lock().unwrap().insert(key.to_owned()).then(|| Flight(key.to_owned()))
    }
}
impl Drop for Flight {
    fn drop(&mut self) {
        running().lock().unwrap().remove(&self.0);
    }
}

fn failure(error: &str, message: &str) -> Value {
    json!({"content":json!({"error":error,"message":message}).to_string(),"error":true})
}
fn progress(app: &App, session_id: &str, call: &Value, line: &str) {
    app.emit(session_id, json!({"type":"tool_update","call_id":call["id"],"text":format!("{line}\n")}));
}
fn norm(url: &str) -> String {
    url.trim().split('#').next().unwrap_or("").trim_end_matches('/').to_lowercase()
}
fn clip(text: &str, chars: usize) -> String {
    text.chars().take(chars).collect()
}
fn clip_words(text: &str, words: usize) -> String {
    let all: Vec<&str> = text.split_whitespace().collect();
    if all.len() <= words {
        text.trim().to_owned()
    } else {
        format!("{}…", all[..words].join(" "))
    }
}

fn task_message(args: &Value, depth: &str, lim: Limits) -> String {
    let mut text = format!("Research question: {}\n", args["question"].as_str().unwrap_or(""));
    if let Some(c) = args["context"].as_str().filter(|c| !c.trim().is_empty()) {
        text.push_str(&format!("Context from the main agent (data): {c}\n"));
    }
    if let Some(focus) = args["focus"].as_array().filter(|f| !f.is_empty()) {
        text.push_str("Focus on:\n");
        for f in focus.iter().filter_map(Value::as_str) {
            text.push_str(&format!("- {f}\n"));
        }
    }
    text.push_str(&format!(
        "Depth: {depth} (at most {} turns of searching and reading, then answer).\nOutput: {}\nLanguage of the result: {}\nToday: {}\n",
        lim.steps,
        args["output"].as_str().unwrap_or("brief"),
        args["language"].as_str().filter(|l| !l.trim().is_empty()).unwrap_or("Russian"),
        chrono_today(),
    ));
    text
}
fn chrono_today() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let (mut days, mut year) = ((secs / 86_400) as i64, 1970i64);
    loop {
        let len = if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) { 366 } else { 365 };
        if days < len {
            break;
        }
        days -= len;
        year += 1;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let months = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 0;
    while days >= months[month] {
        days -= months[month];
        month += 1;
    }
    format!("{year}-{:02}-{:02}", month + 1, days + 1)
}

fn prompt() -> Result<String, String> {
    let root = std::env::var_os("GRAPHY_RESOURCE_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../graphy"));
    std::fs::read_to_string(root.join("prompts/researcher.md")).map_err(|e| format!("Cannot read researcher prompt: {e}"))
}

#[derive(Default)]
struct Trace {
    /// every URL a tool returned or opened (normalised) -> title; only these may appear as sources
    seen: HashMap<String, (String, String)>,
    opened: Vec<String>,
    searches: usize,
    /// consecutive failed web_search calls (reset by a success)
    search_fails: usize,
    last_search_error: String,
    pages: usize,
    spent: u64,
}

async fn web_call(app: &App, session_id: &str, call: &Value, sub: &Value, tools: &Value, trace: &mut Trace) -> Value {
    let name = sub["name"].as_str().unwrap_or("");
    let message = |content: String, error: bool| {
        json!({"role":"tool","call_id":sub["id"],"name":name,"content":content,"error":error})
    };
    if !WEB_TOOLS.contains(&name) {
        return message(format!("Tool not available to the researcher: {name}. Use web_search and web_read only."), true);
    }
    let Some(schema) = tools.as_array().and_then(|a| a.iter().find(|t| t["name"] == name)).map(|t| t["parameters"].clone()) else {
        return message(format!("Tool disabled: {name}"), true);
    };
    let args = match crate::dispatch("context.normalize_optional", json!({"schema":schema,"value":sub["arguments"]})) {
        Ok(v) => v,
        Err(e) => return message(e, true),
    };
    if let Err(e) = jsonschema::validate(&schema, &args) {
        return message(e.to_string(), true);
    }
    let (op, line) = if name == "web_search" {
        trace.searches += 1;
        ("web.search", format!("Ищу: {}", clip(args["query"].as_str().unwrap_or(""), 120)))
    } else {
        trace.pages += 1;
        let url = args["url"].as_str().unwrap_or("");
        let shown = url::Url::parse(url).ok().map(|u| format!("{}{}", u.host_str().unwrap_or(""), u.path())).unwrap_or_else(|| url.to_owned());
        ("web.read", format!("Открываю: {}", clip(&shown, 100)))
    };
    progress(app, session_id, call, &line);
    match app.provider(op, args.clone()).await {
        Ok(v) => {
            if name == "web_search" {
                trace.search_fails = 0;
                for row in v["results"].as_array().into_iter().flatten() {
                    if let Some(u) = row["url"].as_str() {
                        trace.seen.entry(norm(u)).or_insert((u.to_owned(), row["title"].as_str().unwrap_or("").to_owned()));
                    }
                }
            } else {
                let requested = args["url"].as_str().unwrap_or("");
                let title = v["title"].as_str().unwrap_or("").to_owned();
                for u in [requested, v["url"].as_str().unwrap_or("")].into_iter().filter(|u| !u.is_empty()) {
                    let entry = trace.seen.entry(norm(u)).or_insert((u.to_owned(), title.clone()));
                    if entry.1.is_empty() {
                        entry.1 = title.clone();
                    }
                    if !trace.opened.contains(&norm(u)) {
                        trace.opened.push(norm(u));
                    }
                }
            }
            message(clip(&v.to_string(), 16_000), false)
        }
        Err(e) => {
            if name == "web_search" {
                trace.search_fails += 1;
                trace.last_search_error = clip(&app.redact(e.clone()), 600);
            }
            message(app.redact(e), true)
        }
    }
}

/// Two failed searches in a row end the run (see `run`).
const MAX_SEARCH_FAILS: usize = 2;

/// The contract-shaped result for a run that could not search at all: low confidence, a clear `stopped_by`.
pub(crate) fn search_unavailable(why: &str, stats: Value) -> Value {
    json!({
        "summary":"Поиск в интернете сейчас недоступен, поэтому исследование не выполнено; выводов и источников нет.",
        "key_findings":[],
        "sources":[],
        "open_questions":[format!("Search unavailable: {}", clip(why, 400))],
        "confidence":"low",
        "stopped_by":"search_unavailable",
        "note":"Search unavailable. Do not retry or spawn the researcher again now; tell the learner that web search is down and answer from your own knowledge, labelled as unverified.",
        "stats":stats
    })
}

/// One model turn. Returns the assistant message (with `calls`) or an error text.
async fn turn(app: &App, session: &Value, system: &str, messages: &[Value], tools: &Value, budget: Duration) -> Result<Value, String> {
    let model = app.provider("models.get", json!({"id":session["model"]})).await?;
    let req = json!({"model":model,"messages":messages,"system":system,"tools":tools,"thinking":session["thinking"],"session_id":session["id"],"store_dir":app.root});
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let run = async {
        let (result, _) = tokio::join!(crate::provider_runtime::stream(req, tx), async { while rx.recv().await.is_some() {} });
        result
    };
    match tokio::time::timeout(budget, run).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(serde_json::from_str::<Value>(&e).ok().and_then(|d| d["message"].as_str().map(str::to_owned)).unwrap_or(e)),
        Err(_) => Err("timeout".into()),
    }
}
fn charge(app: &App, session: &Session, trace: &mut Trace, resp: &Value) {
    let u = &resp["usage"];
    trace.spent += u["input"].as_u64().unwrap_or(0) + u["output"].as_u64().unwrap_or(0);
    if u.is_object() {
        let _ = app.append(session, json!({"type":"usage","usage":u,"purpose":"researcher"}));
    }
}

fn parse_object(text: &str) -> Option<Value> {
    let (a, b) = (text.find('{')?, text.rfind('}')?);
    serde_json::from_str::<Value>(&text[a..=b]).ok().filter(Value::is_object)
}
fn id_of(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().trim_matches(['[', ']']).parse().ok()))
}

/// Shape the model's answer into the contract: sources are limited to URLs a tool really returned, ids are
/// renumbered 1..n, supports point at surviving ids, sizes are bounded.
pub(crate) fn finish(raw: &str, trace_seen: &HashMap<String, (String, String)>, opened: &[String], output: &str, stopped: Option<&str>, stats: Value) -> Value {
    let parsed = parse_object(raw);
    let mut sources: Vec<Value> = vec![];
    let mut map: HashMap<u64, u64> = HashMap::new();
    let mut used: HashSet<String> = HashSet::new();
    let mut open_questions: Vec<Value> = vec![];
    if let Some(p) = &parsed {
        for (i, s) in p["sources"].as_array().into_iter().flatten().enumerate() {
            let Some(url) = s["url"].as_str() else { continue };
            let Some((real, seen_title)) = trace_seen.get(&norm(url)) else {
                open_questions.push(json!(format!("Источник без подтверждения поиском отброшен: {}", clip(url, 80))));
                continue;
            };
            if !used.insert(norm(url)) || sources.len() >= 12 {
                continue;
            }
            let title = s["title"].as_str().filter(|t| !t.trim().is_empty()).unwrap_or(seen_title);
            let n = sources.len() as u64 + 1;
            map.insert(id_of(&s["id"]).unwrap_or(i as u64 + 1), n);
            sources.push(json!({"id":n,"title":clip(if title.is_empty() { real } else { title }, 200),"url":real,"note":clip(s["note"].as_str().unwrap_or(""), 300)}));
        }
    }
    let mut result = if let Some(p) = parsed {
        let findings: Vec<Value> = p["key_findings"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|f| {
                let claim = f["claim"].as_str().filter(|c| !c.trim().is_empty())?;
                let support: Vec<Value> = f["support"].as_array().into_iter().flatten().filter_map(id_of).filter_map(|i| map.get(&i)).map(|n| json!(n)).collect();
                Some(json!({"claim":clip(claim, 500),"support":support}))
            })
            .take(10)
            .collect();
        for q in p["open_questions"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            open_questions.push(json!(clip(q, 300)));
        }
        let confidence = match p["confidence"].as_str() {
            Some(c @ ("low" | "medium" | "high")) if !sources.is_empty() => c,
            _ => "low",
        };
        let words = if output == "report" { 150 } else { 300 };
        let mut r = json!({"summary":clip_words(p["summary"].as_str().unwrap_or(""), words),"key_findings":findings,"sources":sources,"open_questions":open_questions.into_iter().take(8).collect::<Vec<_>>(),"confidence":confidence});
        if output == "report" {
            if let Some(report) = p["report"].as_str().filter(|r| !r.trim().is_empty()) {
                r["report"] = json!(clip(report, 12_000));
            }
        }
        r
    } else {
        let fallback: Vec<Value> = opened
            .iter()
            .filter_map(|u| trace_seen.get(u))
            .take(6)
            .enumerate()
            .map(|(i, (url, title))| json!({"id":i + 1,"title":clip(if title.is_empty() { url } else { title }, 200),"url":url,"note":"opened; not summarised"}))
            .collect();
        json!({"summary":clip_words(raw, 300),"key_findings":[],"sources":fallback,"open_questions":["Исследователь не вернул структурированный ответ; выводы не проверены."],"confidence":"low"})
    };
    if let Some(why) = stopped {
        result["stopped_by"] = json!(why);
    }
    result["stats"] = stats;
    result
}

pub(crate) async fn run(app: &App, session_id: &str, session: &Session, call: &Value) -> Value {
    let args = &call["arguments"];
    let Some(_flight) = Flight::enter(&app.root) else {
        return failure("researcher_busy", "A researcher is already running. Wait for it to finish (one at a time) or continue without it.");
    };
    let tools = match crate::runtime_tools::declarations(app) {
        Ok(all) => json!(all.as_array().into_iter().flatten().filter(|t| WEB_TOOLS.iter().any(|n| t["name"] == *n)).cloned().collect::<Vec<_>>()),
        Err(e) => return failure("unavailable", &app.redact(e)),
    };
    if tools.as_array().is_some_and(|t| t.is_empty()) {
        return failure("web_disabled", "Web search and reading are disabled in settings, so the researcher cannot work.");
    }
    let system = match prompt() {
        Ok(p) => p,
        Err(e) => return failure("unavailable", &e),
    };
    let depth = args["depth"].as_str().unwrap_or("standard");
    let output = args["output"].as_str().unwrap_or("brief");
    let lim = limits(depth);
    let snapshot = session.data.lock().unwrap().clone();
    let started = Instant::now();
    let total = Duration::from_secs(lim.seconds);
    let mut messages = vec![json!({"role":"user","content":task_message(args, depth, lim)})];
    let mut trace = Trace::default();
    let mut final_text: Option<String> = None;
    let mut stopped: Option<&str> = None;
    let mut steps = 0usize;
    progress(app, session_id, call, "Планирую поиск…");
    while final_text.is_none() {
        if steps >= lim.steps {
            stopped = Some("steps");
            break;
        }
        if trace.spent >= lim.tokens {
            stopped = Some("tokens");
            break;
        }
        let Some(left) = total.checked_sub(started.elapsed()).filter(|d| *d > Duration::from_secs(3)) else {
            stopped = Some("time");
            break;
        };
        steps += 1;
        let resp = match turn(app, &snapshot, &system, &messages, &tools, left).await {
            Ok(r) => r,
            Err(e) if e == "timeout" => {
                stopped = Some("time");
                break;
            }
            Err(e) if steps == 1 => return failure("provider_error", &app.redact(e)),
            Err(_) => {
                stopped = Some("error");
                break;
            }
        };
        charge(app, session, &mut trace, &resp);
        let calls = resp["calls"].as_array().cloned().unwrap_or_default();
        let mut assistant = resp.clone();
        assistant["role"] = json!("assistant");
        assistant["id"] = json!(resp["id"].as_str().unwrap_or("researcher"));
        messages.push(assistant);
        if calls.is_empty() {
            final_text = Some(resp["content"].as_str().unwrap_or("").to_owned());
            break;
        }
        for sub in calls.iter().take(6) {
            let result = web_call(app, session_id, call, sub, &tools, &mut trace).await;
            messages.push(result);
        }
        if trace.search_fails >= MAX_SEARCH_FAILS {
            stopped = Some("search_unavailable");
            break;
        }
        for extra in calls.iter().skip(6) {
            messages.push(json!({"role":"tool","call_id":extra["id"],"name":extra["name"],"content":"Not executed: at most 6 calls per turn.","error":true}));
        }
    }
    if stopped == Some("search_unavailable") && trace.seen.is_empty() {
        let stats = json!({"turns":steps,"searches":trace.searches,"pages":trace.pages,"tokens":trace.spent,"seconds":started.elapsed().as_secs()});
        progress(app, session_id, call, "Поиск недоступен");
        return json!({"content":search_unavailable(&trace.last_search_error, stats).to_string()});
    }
    if final_text.is_none() {
        progress(app, session_id, call, "Собираю ответ…");
        messages.push(json!({"role":"user","content":"The research budget is used up. Do not call tools. Reply now with the final JSON object only, from the evidence you already have; lower the confidence and list what is unverified in open_questions."}));
        match turn(app, &snapshot, &system, &messages, &json!([]), Duration::from_secs(45)).await {
            Ok(r) => {
                charge(app, session, &mut trace, &r);
                final_text = Some(r["content"].as_str().unwrap_or("").to_owned());
            }
            Err(e) => {
                final_text = Some(String::new());
                stopped.get_or_insert(if e == "timeout" { "time" } else { "error" });
            }
        }
    } else {
        progress(app, session_id, call, "Собираю ответ…");
    }
    let raw = final_text.unwrap_or_default();
    let stats = json!({"turns":steps,"searches":trace.searches,"pages":trace.pages,"tokens":trace.spent,"seconds":started.elapsed().as_secs()});
    let result = finish(&raw, &trace.seen, &trace.opened, output, stopped, stats);
    if result["summary"].as_str().unwrap_or("").is_empty() && result["sources"].as_array().is_some_and(|s| s.is_empty()) {
        return failure("empty_result", "The researcher found nothing usable; try a narrower question or answer without it.");
    }
    progress(app, session_id, call, &format!("Готово: источников {}", result["sources"].as_array().map_or(0, Vec::len)));
    json!({"content":result.to_string()})
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::State, response::IntoResponse, routing::{get, post}, Json, Router};
    use std::sync::{atomic::{AtomicUsize, Ordering}, Arc};

    fn sse(delta: Value, finish: &str) -> String {
        format!("data: {}\n\ndata: [DONE]\n\n", json!({"choices":[{"index":0,"delta":delta,"finish_reason":finish}],"usage":{"prompt_tokens":10,"completion_tokens":5}}))
    }
    struct Mock {
        base: String,
        turns: Arc<AtomicUsize>,
        seen_tools: Arc<Mutex<Vec<Vec<String>>>>,
        bodies: Arc<Mutex<Vec<Value>>>,
        _root: tempfile::TempDir,
        app: App,
        session: Arc<Session>,
    }
    /// Provider mock: turn 1 searches, turn 2 opens the page, turn 3 answers. `endless` keeps asking for searches.
    async fn mock(endless: bool, answer: impl Fn(&str) -> String + Send + Sync + 'static) -> Mock {
        mock_with(endless, false, answer).await
    }
    /// `search_down`: the searxng mock answers with no results and failed engines.
    async fn mock_with(endless: bool, search_down: bool, answer: impl Fn(&str) -> String + Send + Sync + 'static) -> Mock {
        #[derive(Clone)]
        struct St {
            down: bool,
            turns: Arc<AtomicUsize>,
            tools: Arc<Mutex<Vec<Vec<String>>>>,
            bodies: Arc<Mutex<Vec<Value>>>,
            base: Arc<Mutex<String>>,
            endless: bool,
            answer: Arc<dyn Fn(&str) -> String + Send + Sync>,
        }
        async fn chat(State(st): State<St>, Json(body): Json<Value>) -> impl IntoResponse {
            let n = st.turns.fetch_add(1, Ordering::SeqCst);
            st.bodies.lock().unwrap().push(body.clone());
            st.tools.lock().unwrap().push(body["tools"].as_array().into_iter().flatten().filter_map(|t| t["function"]["name"].as_str().map(str::to_owned)).collect());
            let base = st.base.lock().unwrap().clone();
            let tools_offered = body["tools"].as_array().is_some_and(|t| !t.is_empty());
            let call = |id: &str, name: &str, args: Value| sse(json!({"tool_calls":[{"index":0,"id":id,"type":"function","function":{"name":name,"arguments":args.to_string()}}]}), "tool_calls");
            let text = if tools_offered && (st.endless || n == 0) {
                call(&format!("s{n}"), "web_search", json!({"query":"центральная предельная теорема"}))
            } else if tools_offered && n == 1 {
                call("r1", "web_read", json!({"url":format!("{base}/page")}))
            } else {
                sse(json!({"content":(st.answer)(&base)}), "stop")
            };
            ([("content-type", "text/event-stream")], text)
        }
        async fn search(State(st): State<St>) -> Json<Value> {
            let base = st.base.lock().unwrap().clone();
            if st.down {
                return Json(json!({"results":[],"unresponsive_engines":[["brave","too many requests"],["duckduckgo","timeout"]]}));
            }
            Json(json!({"results":[{"title":"ЦПТ","url":format!("{base}/page"),"content":"Центральная предельная теорема"}]}))
        }
        async fn page() -> impl IntoResponse {
            let body: Vec<u8> = "<html><head><title>Теорема</title></head><body><p>Сумма независимых величин сходится к нормальному закону.</p></body></html>".as_bytes().to_vec();
            ([("content-type", "text/html; charset=utf-8")], body)
        }
        let st = St { down: search_down, turns: Arc::new(AtomicUsize::new(0)), tools: Arc::new(Mutex::new(vec![])), bodies: Arc::new(Mutex::new(vec![])), base: Arc::new(Mutex::new(String::new())), endless, answer: Arc::new(answer) };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        *st.base.lock().unwrap() = base.clone();
        let router = Router::new().route("/v1/chat/completions", post(chat)).route("/search", get(search)).route("/page", get(page)).with_state(st.clone());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("settings.json"), json!({"providers":{"ollama":{"base_url":format!("{base}/v1")}},"web_provider":"searxng","searxng_url":base}).to_string()).unwrap();
        let app = crate::backend_runtime::test_app(root.path());
        let session = crate::backend_runtime::test_session(&app, "a1b2", "r");
        session.data.lock().unwrap()["model"] = json!("ollama/demo");
        Mock { base, turns: st.turns, seen_tools: st.tools, bodies: st.bodies, _root: root, app, session }
    }
    fn good_answer(base: &str) -> String {
        json!({"summary":"ЦПТ: сумма сходится к нормальному закону.","key_findings":[{"claim":"Сумма сходится к нормальному закону","support":[1,"7"]}],
            "sources":[{"id":1,"title":"Теорема","url":format!("{base}/page"),"note":"учебная страница"},{"id":7,"title":"Выдумка","url":"https://invented.example/x","note":""}],
            "open_questions":[],"confidence":"high"}).to_string()
    }
    fn spawn(args: Value) -> Value {
        json!({"id":"call1","name":NAME,"arguments":args})
    }

    #[test]
    fn declaration_is_listed_with_a_strict_schema_for_every_user() {
        let root = tempfile::tempdir().unwrap();
        let app = crate::backend_runtime::test_app(root.path());
        let tools = crate::runtime_tools::declarations(&app).unwrap();
        let tool = tools.as_array().unwrap().iter().find(|t| t["name"] == NAME).expect("spawn_researcher declared");
        assert_eq!(tool["parameters"]["required"], json!(["question"]));
        assert_eq!(tool["parameters"]["additionalProperties"], false);
        assert_eq!(tool["parameters"]["properties"]["depth"]["enum"], json!(["quick", "standard", "deep"]));
        assert!(tool["description"].as_str().unwrap().contains("never paste the raw JSON"));
        // the sub-agent's own tool list contains no way to recurse or write
        std::fs::write(root.path().join("settings.json"), r#"{"learning_tools":["read"]}"#).unwrap();
        assert!(crate::runtime_tools::declarations(&app).unwrap().as_array().unwrap().iter().any(|t| t["name"] == NAME), "not gated by learning_tools");
        assert!(limits("quick").steps < limits("standard").steps && limits("standard").steps < limits("deep").steps);
    }

    #[tokio::test]
    async fn runs_the_loop_and_returns_the_contract_shape_with_only_real_sources() {
        let m = mock(false, good_answer).await;
        let mut events = m.app.bus.subscribe();
        let out = crate::runtime_tools::execute(&m.app, "sid", &m.session, &spawn(json!({"question":"Что такое ЦПТ?","depth":"quick","focus":["формулировка"]}))).await;
        assert!(out["error"].is_null(), "{out}");
        let v: Value = serde_json::from_str(out["content"].as_str().unwrap()).unwrap();
        for k in ["summary", "key_findings", "sources", "open_questions", "confidence"] {
            assert!(!v[k].is_null(), "{k} missing: {v}");
        }
        assert_eq!(v["confidence"], "high");
        assert_eq!(v["sources"].as_array().unwrap().len(), 1, "the invented URL is dropped: {v}");
        assert_eq!(v["sources"][0]["id"], 1);
        assert!(v["sources"][0]["url"].as_str().unwrap().ends_with("/page"));
        assert_eq!(v["key_findings"][0]["support"], json!([1]));
        assert!(v["open_questions"][0].as_str().unwrap().contains("отброшен"));
        assert!(v["report"].is_null());
        assert_eq!(m.turns.load(Ordering::SeqCst), 3);
        assert_eq!((v["stats"]["searches"].as_u64(), v["stats"]["pages"].as_u64()), (Some(1), Some(1)));
        // the researcher only ever saw web tools
        for offered in m.seen_tools.lock().unwrap().iter() {
            assert!(offered.iter().all(|n| n == "web_search" || n == "web_read"), "{offered:?}");
        }
        // live progress reached the UI as tool_update on the spawn call
        let mut lines = String::new();
        while let Ok(e) = events.try_recv() {
            if e["type"] == "tool_update" && e["call_id"] == "call1" {
                lines.push_str(e["text"].as_str().unwrap());
            }
        }
        assert!(lines.contains("Ищу:") && lines.contains("Открываю:") && lines.contains("Собираю ответ") && lines.contains("Готово: источников 1"), "{lines}");
    }

    #[tokio::test]
    async fn researcher_starts_from_a_fresh_context_and_leaves_the_parent_transcript_alone() {
        let m = mock(false, good_answer).await;
        const SECRET: &str = "СЕКРЕТНАЯ-ИСТОРИЯ-ЧАТА-42";
        for msg in [json!({"id":"u1","role":"user","content":format!("привет, {SECRET}")}), json!({"id":"a1","role":"assistant","content":format!("ответ {SECRET}")})] {
            m.app.append(&m.session, json!({"type":"message","message":msg})).unwrap();
        }
        m.session.data.lock().unwrap()["learning"]["goal"] = json!(SECRET);
        let before = m.session.data.lock().unwrap()["messages"].as_array().unwrap().len();
        let out = crate::runtime_tools::execute(&m.app, "sid", &m.session, &spawn(json!({"question":"Что такое ЦПТ?","context":"ученик 10 класса","focus":["формулировка"],"depth":"quick","output":"brief","language":"Russian"}))).await;
        assert!(out["error"].is_null(), "{out}");
        let bodies = m.bodies.lock().unwrap().clone();
        assert_eq!(bodies.len(), 3);
        let first = bodies[0]["messages"].as_array().unwrap();
        let roles: Vec<&str> = first.iter().filter_map(|x| x["role"].as_str()).collect();
        assert_eq!(roles, ["system", "user"], "system prompt + exactly one user message: {first:?}");
        assert_eq!(first[0]["content"].as_str().unwrap(), prompt().unwrap());
        let task = first[1]["content"].as_str().unwrap();
        for part in ["Что такое ЦПТ?", "ученик 10 класса", "формулировка", "quick", "brief", "Russian"] {
            assert!(task.contains(part), "{part} missing from {task}");
        }
        for body in &bodies {
            assert!(!body.to_string().contains(SECRET), "parent history leaked into the researcher request");
        }
        // its own turns and tool calls never reach the parent's message history
        let after = m.session.data.lock().unwrap()["messages"].as_array().unwrap().clone();
        assert_eq!(after.len(), before);
        assert!(!serde_json::to_string(&after).unwrap().contains("web_search"));
    }

    #[tokio::test]
    async fn report_output_keeps_the_markdown_report_and_garbage_falls_back() {
        let m = mock(false, |base| json!({"summary":"s","key_findings":[],"sources":[{"id":1,"title":"T","url":format!("{base}/page")}],"open_questions":[],"confidence":"medium","report":"# Отчёт\nФакт [1]."}).to_string()).await;
        let out = crate::runtime_tools::execute(&m.app, "sid", &m.session, &spawn(json!({"question":"Вопрос?","output":"report"}))).await;
        let v: Value = serde_json::from_str(out["content"].as_str().unwrap()).unwrap();
        assert!(v["report"].as_str().unwrap().contains("[1]"));
        let m = mock(false, |_| "Не JSON, просто текст".into()).await;
        let out = crate::runtime_tools::execute(&m.app, "sid", &m.session, &spawn(json!({"question":"Вопрос?"}))).await;
        let v: Value = serde_json::from_str(out["content"].as_str().unwrap()).unwrap();
        assert_eq!(v["confidence"], "low");
        assert_eq!(v["sources"].as_array().unwrap().len(), 1, "opened pages are listed: {v}");
    }

    #[tokio::test]
    async fn step_cap_forces_a_toolless_final_answer() {
        let m = mock(true, |_| json!({"summary":"частично","key_findings":[],"sources":[],"open_questions":["не успел"],"confidence":"low"}).to_string()).await;
        let out = crate::runtime_tools::execute(&m.app, "sid", &m.session, &spawn(json!({"question":"Вопрос?","depth":"quick"}))).await;
        let v: Value = serde_json::from_str(out["content"].as_str().unwrap()).unwrap();
        assert_eq!(v["stopped_by"], "steps");
        assert_eq!(m.turns.load(Ordering::SeqCst), limits("quick").steps + 1);
        assert!(m.seen_tools.lock().unwrap().last().unwrap().is_empty(), "synthesis turn offers no tools");
    }

    #[tokio::test]
    async fn two_failed_searches_in_a_row_end_the_run_fast_with_low_confidence() {
        // fallbacks point at a closed port so nothing leaves the machine
        std::env::set_var("GRAPHY_DDG_URL", "http://127.0.0.1:9/ddg");
        std::env::set_var("GRAPHY_WIKI_API_URL", "http://127.0.0.1:9/wiki");
        let m = mock_with(true, true, |_| unreachable!("no synthesis turn after an outage")).await;
        let t = Instant::now();
        let out = crate::runtime_tools::execute(&m.app, "sid", &m.session, &spawn(json!({"question":"Вопрос?","depth":"deep"}))).await;
        assert!(t.elapsed() < Duration::from_secs(20));
        let v: Value = serde_json::from_str(out["content"].as_str().unwrap()).unwrap();
        assert_eq!(v["stopped_by"], "search_unavailable");
        assert_eq!(v["confidence"], "low");
        assert_eq!(v["sources"], json!([]));
        assert!(v["open_questions"][0].as_str().unwrap().contains("Search unavailable"));
        assert_eq!(m.turns.load(Ordering::SeqCst), 2, "stops after the second failure, no further model turns");
        assert_eq!(v["stats"]["searches"], 2);
    }

    #[test]
    fn search_unavailable_result_has_the_contract_fields() {
        let v = search_unavailable("x", json!({}));
        for k in ["summary", "key_findings", "sources", "open_questions", "confidence"] {
            assert!(!v[k].is_null(), "{k}");
        }
        assert!(v["note"].as_str().unwrap().contains("Do not retry"));
    }

    #[tokio::test]
    async fn a_second_concurrent_researcher_is_rejected_and_the_slot_frees_afterwards() {
        let m = mock(false, good_answer).await;
        let call = spawn(json!({"question":"Что такое ЦПТ?","depth":"quick"}));
        let (a, b) = tokio::join!(
            crate::runtime_tools::execute(&m.app, "sid", &m.session, &call),
            async {
                tokio::task::yield_now().await;
                crate::runtime_tools::execute(&m.app, "sid", &m.session, &spawn(json!({"question":"Второй?"}))).await
            }
        );
        let results = [a, b];
        let busy = results.iter().filter(|r| r["error"] == true && r["content"].as_str().unwrap().contains("researcher_busy")).count();
        assert_eq!(busy, 1, "{results:?}");
        assert!(results.iter().any(|r| r["error"].is_null()));
        let again = crate::runtime_tools::execute(&m.app, "sid", &m.session, &call).await;
        assert!(again["error"].is_null(), "{again}");
        let _ = &m.base;
    }

    #[tokio::test]
    async fn invalid_arguments_and_recursion_are_refused() {
        let m = mock(false, good_answer).await;
        let bad = crate::runtime_tools::execute(&m.app, "sid", &m.session, &spawn(json!({"depth":"quick"}))).await;
        assert_eq!(bad["error"], true);
        let bad = crate::runtime_tools::execute(&m.app, "sid", &m.session, &spawn(json!({"question":"Вопрос?","depth":"endless"}))).await;
        assert_eq!(bad["error"], true);
        let mut trace = Trace::default();
        let tools = json!([{"name":"web_search","parameters":{"type":"object"}}]);
        let r = web_call(&m.app, "sid", &spawn(json!({})), &json!({"id":"x","name":NAME,"arguments":{"question":"again"}}), &tools, &mut trace).await;
        assert_eq!(r["error"], true);
        assert!(r["content"].as_str().unwrap().contains("not available"));
    }

    #[test]
    fn today_is_a_plausible_iso_date() {
        let d = chrono_today();
        assert!(d.starts_with("20") && d.len() == 10, "{d}");
    }
}
