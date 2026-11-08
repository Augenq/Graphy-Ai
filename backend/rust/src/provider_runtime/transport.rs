use super::{
    auth,
    catalog::{self, merge, s},
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tokio::sync::mpsc::UnboundedSender;

struct Response {
    model: Value,
    result: Value,
    calls: BTreeMap<String, Value>,
    blocks: BTreeMap<String, Value>,
    parts: Vec<Value>,
    reasoning: Vec<Value>,
    done: bool,
    streamed: bool,
    events: UnboundedSender<Value>,
}
impl Response {
    fn new(model: Value, events: UnboundedSender<Value>) -> Self {
        let result = json!({"role":"assistant","content":"","thinking":"","calls":[],"provider":model["provider"],"model":model["id"],"stop":"stop","usage":{"input":0,"output":0,"cache_read":0,"cache_write":0,"cost":null}});
        Self {
            model,
            result,
            calls: BTreeMap::new(),
            blocks: BTreeMap::new(),
            parts: vec![],
            reasoning: vec![],
            done: false,
            streamed: false,
            events,
        }
    }
    fn delta(&mut self, text: &str, thinking: bool) {
        if text.is_empty() {
            return;
        }
        let field = if thinking { "thinking" } else { "content" };
        let mut old = s(&self.result[field]).to_owned();
        old.push_str(text);
        self.result[field] = json!(old);
        self.streamed = true;
        let _ = self
            .events
            .send(json!({"type":if thinking{"thinking_delta"}else{"text_delta"},"delta":text}));
    }
    fn usage(&mut self, v: &Value, api: &str) {
        let u = &mut self.result["usage"];
        let num = |k: &str| v[k].as_i64().unwrap_or(0);
        if api == "anthropic" {
            for (src, dst) in [
                ("input_tokens", "input"),
                ("output_tokens", "output"),
                ("cache_read_input_tokens", "cache_read"),
                ("cache_creation_input_tokens", "cache_write"),
            ] {
                if v.get(src).is_some() {
                    u[dst] = v[src].clone();
                }
            }
        } else if api == "google" {
            u["input"] = json!(num("promptTokenCount") - num("cachedContentTokenCount"));
            u["output"] = json!(num("candidatesTokenCount") + num("thoughtsTokenCount"));
            u["cache_read"] = json!(num("cachedContentTokenCount"));
        } else {
            let total = v["input_tokens"]
                .as_i64()
                .or_else(|| v["prompt_tokens"].as_i64())
                .unwrap_or(0);
            let cached = v["prompt_cache_hit_tokens"]
                .as_i64()
                .or_else(|| v["input_tokens_details"]["cached_tokens"].as_i64())
                .or_else(|| v["prompt_tokens_details"]["cached_tokens"].as_i64())
                .unwrap_or(0);
            let written = v["prompt_tokens_details"]["cache_write_tokens"].as_i64().unwrap_or(0);
            u["input"] = json!((total - cached - written).max(0));
            if written > 0 {
                u["cache_write"] = json!(written);
            }
            u["output"] = json!(v["output_tokens"]
                .as_i64()
                .or_else(|| v["completion_tokens"].as_i64())
                .unwrap_or(0));
            u["cache_read"] = json!(cached);
        }
        let tokens = u["input"].as_i64().unwrap_or(0)
            + u["cache_read"].as_i64().unwrap_or(0)
            + u["cache_write"].as_i64().unwrap_or(0);
        let mut prices = self.model["cost"].clone();
        if let Some(tiers) = self.model["cost_tiers"].as_array() {
            for tier in tiers {
                if tier["tier"]["size"].as_i64().is_some_and(|x| tokens > x) {
                    merge(&mut prices, tier);
                }
            }
        }
        if prices.is_object()
            && ["input", "output", "cache_read", "cache_write"]
                .iter()
                .all(|k| u[*k].as_i64().unwrap_or(0) == 0 || prices.get(*k).is_some())
        {
            let cost = ["input", "output", "cache_read", "cache_write"]
                .iter()
                .map(|k| u[*k].as_f64().unwrap_or(0.) * prices[*k].as_f64().unwrap_or(0.))
                .sum::<f64>()
                / 1e6;
            u["cost"] = json!(cost);
        }
        if let Some(cost) = v["cost"].as_f64().filter(|x| x.is_finite() && *x >= 0.) {
            u["cost"] = json!(cost);
        }
    }
    fn append_call(&mut self, index: String, c: &Value) {
        self.streamed = true;
        let t = self
            .calls
            .entry(index)
            .or_insert(json!({"id":"","name":"","arguments":""}));
        if !s(&c["id"]).is_empty() {
            t["id"] = c["id"].clone();
        }
        for (src, dst) in [("name", "name"), ("arguments", "arguments")] {
            let value = format!("{}{}", s(&t[dst]), s(&c["function"][src]));
            t[dst] = json!(value);
        }
    }
    fn process(&mut self, api: &str, event: &Value) {
        if event["_done"] == true {
            self.done = true;
            return;
        }
        match api {
            "chat" => {
                if event["usage"].is_object() {
                    self.usage(&event["usage"], api);
                }
                for choice in event["choices"].as_array().into_iter().flatten() {
                    if choice["index"].as_i64().unwrap_or(0) != 0 {
                        continue;
                    }
                    let d = &choice["delta"];
                    // A provider may put both fields in one chunk; display the
                    // reasoning before the answer regardless of JSON field order.
                    for k in ["reasoning_content", "reasoning", "reasoning_text"] {
                        if let Some(t) = d[k].as_str() {
                            self.delta(t, true);
                            break;
                        }
                    }
                    if let Some(content) = d["content"].as_str() {
                        self.delta(content, false);
                    } else if let Some(parts) = d["content"].as_array() {
                        for p in parts {
                            match s(&p["type"]) {
                                "text" => self.delta(s(&p["text"]), false),
                                "thinking" => {
                                    if let Some(t) = p["thinking"].as_str() {
                                        self.delta(t, true);
                                    } else {
                                        for t in p["thinking"].as_array().into_iter().flatten() {
                                            self.delta(s(&t["text"]), true);
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    for c in d["tool_calls"].as_array().into_iter().flatten() {
                        let index = if let Some(i) = c["index"].as_i64() {
                            format!("{i:020}")
                        } else if !s(&c["id"]).is_empty() {
                            self.calls
                                .iter()
                                .find(|(_, v)| v["id"] == c["id"])
                                .map(|(k, _)| k.clone())
                                .unwrap_or_else(|| format!("{:020}", self.calls.len()))
                        } else {
                            self.calls
                                .keys()
                                .next_back()
                                .cloned()
                                .unwrap_or_else(|| format!("{:020}", 0))
                        };
                        self.append_call(index, c);
                    }
                    if let Some(reason) = choice["finish_reason"].as_str() {
                        self.done = true;
                        self.result["stop"] = json!(match reason {
                            "length" => "length",
                            "content_filter" => "error",
                            _ => "stop",
                        });
                    }
                }
            }
            "responses" | "codex" => {
                let kind = s(&event["type"]);
                let idx = || format!("{:020}", event["output_index"].as_u64().unwrap_or(0));
                match kind {
                    "response.output_text.delta" => self.delta(s(&event["delta"]), false),
                    "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                        self.delta(s(&event["delta"]), true)
                    }
                    "response.output_item.added" | "response.output_item.done" => {
                        let item = &event["item"];
                        if item["type"] == "function_call" {
                            self.streamed = true;
                            let t = self
                                .calls
                                .entry(idx())
                                .or_insert(json!({"id":"","name":"","arguments":""}));
                            for (src, dst) in [("call_id", "id"), ("name", "name")] {
                                if item.get(src).is_some() {
                                    t[dst] = item[src].clone();
                                }
                            }
                            if kind.ends_with(".done") && item.get("arguments").is_some() {
                                t["arguments"] = item["arguments"].clone();
                            }
                        } else if kind.ends_with(".done")
                            && item["type"] == "reasoning"
                            && !s(&item["encrypted_content"]).is_empty()
                        {
                            self.reasoning.push(item.clone());
                        }
                    }
                    "response.function_call_arguments.delta" => {
                        self.streamed = true;
                        let t = self
                            .calls
                            .entry(idx())
                            .or_insert(json!({"id":"","name":"","arguments":""}));
                        t["arguments"] =
                            json!(format!("{}{}", s(&t["arguments"]), s(&event["delta"])));
                    }
                    "response.completed"
                    | "response.incomplete"
                    | "response.failed"
                    | "response.cancelled" => {
                        self.done = true;
                        let r = &event["response"];
                        self.result["stop"] = json!(if kind == "response.completed" {
                            "stop"
                        } else if kind == "response.incomplete"
                            && r["incomplete_details"]["reason"] == "max_output_tokens"
                        {
                            "length"
                        } else {
                            "error"
                        });
                        if r["usage"].is_object() {
                            self.usage(&r["usage"], api);
                        }
                        let no_content = s(&self.result["content"]).is_empty();
                        let no_thinking = s(&self.result["thinking"]).is_empty();
                        for (i, item) in r["output"].as_array().into_iter().flatten().enumerate() {
                            if no_thinking && item["type"] == "reasoning" {
                                for part in item["summary"].as_array().into_iter().flatten() {
                                    if part["type"] == "summary_text" {
                                        self.delta(s(&part["text"]), true);
                                    }
                                }
                            }
                            if no_content {
                                for p in item["content"].as_array().into_iter().flatten() {
                                    if p["type"] == "output_text" {
                                        self.delta(s(&p["text"]), false);
                                    }
                                }
                            }
                            if item["type"] == "function_call" {
                                self.calls.insert(format!("{i:020}"),json!({"id":item["call_id"],"name":item["name"],"arguments":item["arguments"]}));
                            }
                            if item["type"] == "reasoning"
                                && !s(&item["encrypted_content"]).is_empty()
                                && !self.reasoning.contains(item)
                            {
                                self.reasoning.push(item.clone());
                            }
                        }
                    }
                    _ => {}
                }
            }
            "anthropic" => {
                let kind = s(&event["type"]);
                let i = format!("{:020}", event["index"].as_u64().unwrap_or(0));
                match kind {
                    "message_start" => self.usage(&event["message"]["usage"], api),
                    "content_block_start" => {
                        let b = event["content_block"].clone();
                        self.blocks.insert(i.clone(), b.clone());
                        match s(&b["type"]) {
                            "text" => self.delta(s(&b["text"]), false),
                            "thinking" => self.delta(s(&b["thinking"]), true),
                            "tool_use" => {
                                self.streamed = true;
                                self.calls.insert(
                                    i,
                                    json!({"id":b["id"],"name":b["name"],"arguments":""}),
                                );
                            }
                            _ => {}
                        }
                    }
                    "content_block_delta" => {
                        let d = &event["delta"];
                        let (field, source) = match s(&d["type"]) {
                            "text_delta" => ("text", "text"),
                            "thinking_delta" => ("thinking", "thinking"),
                            "signature_delta" => ("signature", "signature"),
                            "input_json_delta" => ("arguments", "partial_json"),
                            _ => ("", ""),
                        };
                        if !field.is_empty() {
                            let t = if field == "arguments" {
                                self.calls.get_mut(&i)
                            } else {
                                self.blocks.get_mut(&i)
                            };
                            if let Some(t) = t {
                                t[field] = json!(format!("{}{}", s(&t[field]), s(&d[source])));
                            }
                            if field == "text" || field == "thinking" {
                                self.delta(s(&d[source]), field == "thinking");
                            }
                        }
                    }
                    "message_delta" => {
                        self.result["stop"] = json!(match s(&event["delta"]["stop_reason"]) {
                            "max_tokens" => "length",
                            "refusal" | "safety" => "error",
                            _ => "stop",
                        });
                        self.usage(&event["usage"], api);
                    }
                    "message_stop" => self.done = true,
                    _ => {}
                }
            }
            "google" => {
                if event["usageMetadata"].is_object() {
                    self.usage(&event["usageMetadata"], api);
                }
                if !s(&event["promptFeedback"]["blockReason"]).is_empty() {
                    self.done = true;
                    self.result["stop"] = json!("error");
                }
                if let Some(candidate) = event["candidates"].as_array().and_then(|x| x.first()) {
                    for part in candidate["content"]["parts"]
                        .as_array()
                        .into_iter()
                        .flatten()
                    {
                        self.parts.push(part.clone());
                        if let Some(t) = part["text"].as_str() {
                            self.delta(t, part["thought"] == true);
                        }
                        if part["functionCall"].is_object() {
                            let c = &part["functionCall"];
                            self.streamed = true;
                            self.calls.insert(format!("{:020}",self.calls.len()),json!({"id":c.get("id").cloned().unwrap_or(json!(format!("call_{}",uuid::Uuid::new_v4().simple()))),"name":c["name"],"arguments":c.get("args").cloned().unwrap_or(json!({}))}));
                        }
                    }
                    if let Some(reason) = candidate["finishReason"].as_str() {
                        self.done = true;
                        self.result["stop"] = json!(match reason {
                            "MAX_TOKENS" => "length",
                            "STOP" => "stop",
                            _ => "error",
                        });
                    }
                }
            }
            _ => {}
        }
    }
    fn finish(mut self) -> Result<Value, String> {
        if !self.done {
            return Err(error(
                "Provider stream ended before completion",
                None,
                true,
                self.streamed,
                &self.result,
                None,
            ));
        }
        let mut calls = vec![];
        if self.result["stop"] == "stop" || self.result["stop"] == "length" {
            for (i, mut c) in self.calls {
                let args = if c["arguments"].is_string() {
                    serde_json::from_str::<Value>(if s(&c["arguments"]).is_empty() {
                        "{}"
                    } else {
                        s(&c["arguments"])
                    })
                    .unwrap_or(Value::Null)
                } else {
                    c["arguments"].clone()
                };
                if !args.is_object() || s(&c["name"]).is_empty() {
                    c["arguments"] = json!({});
                    if s(&c["name"]).is_empty() {
                        c["name"] = json!("unknown_tool");
                    }
                    c["argument_error"] =
                        json!("Malformed JSON tool arguments; reissue a complete object.");
                } else {
                    c["arguments"] = args;
                }
                if s(&c["id"]).is_empty() {
                    c["id"] = json!(format!("call_{}", uuid::Uuid::new_v4().simple()));
                }
                if let Ok(v) =
                    crate::providers::dispatch("providers.call_id", json!({"value":c["id"]}))
                {
                    c["id"] = v;
                }
                if let Some(b) = self.blocks.get_mut(&i) {
                    b["input"] = c["arguments"].clone();
                }
                calls.push(c);
            }
        }
        self.result["calls"] = json!(calls);
        let mut native = json!({});
        if !self.reasoning.is_empty() {
            native["reasoning"] = json!(self.reasoning);
        }
        let blocks: Vec<_> = self
            .blocks
            .into_values()
            .filter(|b| b["type"] != "thinking" || !s(&b["signature"]).is_empty())
            .collect();
        if !blocks.is_empty() {
            native["blocks"] = json!(blocks);
        }
        if !self.parts.is_empty() {
            native["parts"] = json!(self.parts);
        }
        if native.as_object().is_some_and(|o| !o.is_empty()) && self.result["stop"] == "stop" {
            self.result["native"] = native;
        }
        Ok(self.result)
    }
}
fn error(
    message: &str,
    status: Option<u16>,
    retryable: bool,
    streamed: bool,
    partial: &Value,
    retry_after: Option<f64>,
) -> String {
    let overflow=status==Some(413)||regex::Regex::new(r"(?i)context[_ ](?:length|window)|too many tokens|maximum.*tokens|prompt is too long|input.*too long").unwrap().is_match(message);
    let mut partial = partial.clone();
    partial["stop"] = json!("error");
    json!({"message":message,"status":status,"retry_after":retry_after,"retryable":retryable,"streamed":streamed,"partial":partial,"context_overflow":overflow}).to_string()
}
fn redact(mut text: String, secrets: &Value) -> String {
    fn visit(t: &mut String, v: &Value) {
        match v {
            Value::Object(o) => {
                for v in o.values() {
                    visit(t, v)
                }
            }
            Value::String(s) if s.len() > 6 => *t = t.replace(s, "[redacted]"),
            _ => {}
        }
    }
    visit(&mut text, secrets);
    regex::Regex::new(r"(?i)(bearer\s+)[\w.\-]+")
        .unwrap()
        .replace_all(&text, "${1}[redacted]")
        .into_owned()
}
fn add_headers(headers: &mut reqwest::header::HeaderMap, obj: &Value) -> Result<(), String> {
    if let Some(o) = obj.as_object() {
        for (k, v) in o {
            let name = reqwest::header::HeaderName::from_bytes(k.as_bytes())
                .map_err(|_| "Invalid provider header")?;
            let value = reqwest::header::HeaderValue::from_str(s(v))
                .map_err(|_| "Invalid provider header")?;
            headers.insert(name, value);
        }
    }
    Ok(())
}
pub async fn stream(request: Value, events: UnboundedSender<Value>) -> Result<Value, String> {
    let root = catalog::root(&request);
    let mut model = request["model"].clone();
    let p = s(&model["provider"]).to_owned();
    let config = catalog::settings(&root, &p)?;
    for k in ["api", "base_url", "strict_tools"] {
        if config.get(k).is_some() {
            model[k] = config[k].clone();
        }
    }
    let api = s(&model["api"]).to_owned();
    let mut state = Response::new(model.clone(), events);
    let mut key = catalog::key(&root, &p, &config)?;
    let secrets = catalog::read(&root, "auth.json")?;
    let credential = catalog::credential(&root, &p)?;
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        "accept",
        reqwest::header::HeaderValue::from_static("text/event-stream"),
    );
    add_headers(&mut headers, &config["headers"])?;
    add_headers(&mut headers, &model["headers"])?;
    add_headers(&mut headers, &credential["headers"])?;
    if api == "codex" {
        let cred = auth::codex_credential(&root).await?;
        key = s(&cred["access"]).to_owned();
        add_headers(
            &mut headers,
            &json!({"authorization":format!("Bearer {key}"),"chatgpt-account-id":cred["accountId"],"openai-beta":"responses=experimental","originator":"pi","session-id":request["session_id"]}),
        )?;
    } else if api == "anthropic" {
        headers.insert(
            "anthropic-version",
            reqwest::header::HeaderValue::from_static("2023-06-01"),
        );
        if !key.is_empty() {
            add_headers(&mut headers, &json!({"x-api-key":key}))?;
        }
    } else if api == "google" {
        if !key.is_empty() {
            add_headers(&mut headers, &json!({"x-goog-api-key":key}))?;
        }
    } else if !key.is_empty() {
        add_headers(
            &mut headers,
            &json!({"authorization":format!("Bearer {key}")}),
        )?;
    }
    let mut input = request.clone();
    input["model"] = model.clone();
    input["style_heading"] = json!("# EXPLANATION STYLE:");
    let payload = crate::providers::dispatch("providers.payload", input)?;
    let arr = payload.as_array().ok_or("Invalid provider payload")?;
    if arr.len() != 3 {
        return Err("Invalid provider payload".into());
    }
    let path = s(&arr[0]);
    let params = arr[1].clone();
    let mut body = arr[2].clone();
    if let Some(sampling) = model["sampling"].as_object() {
        for (k, v) in sampling {
            if ![
                "temperature",
                "top_p",
                "top_k",
                "presence_penalty",
                "frequency_penalty",
                "seed",
            ]
            .contains(&k.as_str())
            {
                continue;
            }
            if matches!(api.as_str(), "responses" | "codex")
                && !matches!(k.as_str(), "temperature" | "top_p")
            {
                continue;
            }
            if api == "anthropic" && !matches!(k.as_str(), "temperature" | "top_p" | "top_k") {
                continue;
            }
            if api == "google" {
                let name = match k.as_str() {
                    "top_p" => "topP",
                    "top_k" => "topK",
                    "presence_penalty" => "presencePenalty",
                    "frequency_penalty" => "frequencyPenalty",
                    x => x,
                };
                body["generationConfig"][name] = v.clone();
            } else {
                body[k] = v.clone();
            }
        }
    }
    merge(&mut body, &config["body"]);
    merge(&mut body, &model["body"]);
    let base = s(&model["base_url"]).trim_end_matches('/');
    let url = if base.ends_with(path) {
        base.to_owned()
    } else {
        format!("{base}{path}")
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(300))
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(url)
        .query(&params)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            error(
                &redact(format!("{p}: {}", e.without_url()), &secrets),
                None,
                true,
                false,
                &state.result,
                None,
            )
        })?;
    let status = resp.status();
    if !status.is_success() {
        let retry = resp
            .headers()
            .get("retry-after-ms")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<f64>().ok())
            .map(|x| (x / 1000.).max(0.))
            .or_else(|| {
                resp.headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| {
                        v.parse::<f64>().ok().or_else(|| {
                            chrono::DateTime::parse_from_rfc2822(v).ok().map(|date| {
                                (date.timestamp_millis() as f64 / 1000.)
                                    - (chrono::Utc::now().timestamp_millis() as f64 / 1000.)
                            })
                        })
                    })
                    .filter(|v| v.is_finite())
                    .map(|x| x.max(0.))
            });
        let raw = resp.text().await.unwrap_or_default();
        let parsed = serde_json::from_str::<Value>(&raw).unwrap_or_default();
        let item = parsed.as_array().and_then(|a| a.first()).unwrap_or(&parsed);
        let e = item.get("error").unwrap_or(item);
        let msg = e
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| e.as_str())
            .unwrap_or(&raw);
        let mut msg = redact(msg.to_owned(), &secrets);
        if !key.is_empty() {
            msg = msg.replace(&key, "[redacted]");
        }
        let retryable = [408, 409, 429, 500, 502, 503, 504, 529].contains(&status.as_u16())
            && !regex::Regex::new(
                "(?i)insufficient_quota|billing|monthly usage|available balance|out of budget",
            )
            .unwrap()
            .is_match(&raw);
        return Err(error(
            &format!(
                "{p} ({}): {}",
                status.as_u16(),
                msg.chars().take(1000).collect::<String>()
            ),
            Some(status.as_u16()),
            retryable,
            false,
            &state.result,
            retry,
        ));
    }
    let mut bytes = resp.bytes_stream();
    let mut buffer = Vec::new();
    let mut data = Vec::new();
    while let Some(chunk) = bytes.next().await {
        let chunk = chunk.map_err(|e| {
            error(
                &redact(format!("{p}: {}", e.without_url()), &secrets),
                None,
                true,
                state.streamed,
                &state.result,
                None,
            )
        })?;
        buffer.extend_from_slice(&chunk);
        while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
            let mut line: Vec<u8> = buffer.drain(..=pos).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.starts_with(b"data:") {
                let value = String::from_utf8_lossy(&line[5..])
                    .trim_start_matches(' ')
                    .to_owned();
                data.push(value);
            } else if line.is_empty() && !data.is_empty() {
                consume(&api, &mut state, &mut data, &secrets, &key)?;
            }
        }
    }
    if !buffer.is_empty() {
        if buffer.last() == Some(&b'\r') {
            buffer.pop();
        }
        if buffer.starts_with(b"data:") {
            data.push(
                String::from_utf8_lossy(&buffer[5..])
                    .trim_start_matches(' ')
                    .to_owned(),
            );
        }
    }
    if !data.is_empty() {
        consume(&api, &mut state, &mut data, &secrets, &key)?;
    }
    state.finish()
}
fn consume(
    api: &str,
    state: &mut Response,
    data: &mut Vec<String>,
    secrets: &Value,
    key: &str,
) -> Result<(), String> {
    let text = data.join("\n");
    data.clear();
    let event = if text == "[DONE]" {
        json!({"_done":true})
    } else {
        serde_json::from_str::<Value>(&text).map_err(|_| {
            error(
                "Invalid SSE event JSON",
                None,
                false,
                state.streamed,
                &state.result,
                None,
            )
        })?
    };
    if !event.is_object() {
        return Err(error(
            "Invalid SSE event object",
            None,
            false,
            state.streamed,
            &state.result,
            None,
        ));
    }
    if event.get("error").is_some_and(|e| !e.is_null()) || event["type"] == "error" {
        let e = &event["error"];
        let msg = e
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| e.as_str())
            .unwrap_or("Provider stream error");
        let mut msg = redact(msg.to_owned(), secrets);
        if !key.is_empty() {
            msg = msg.replace(key, "[redacted]");
        }
        return Err(error(
            &msg,
            None,
            !state.streamed,
            state.streamed,
            &state.result,
            None,
        ));
    }
    state.process(api, &event);
    Ok(())
}
