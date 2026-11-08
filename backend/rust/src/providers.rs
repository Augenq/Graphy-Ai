//! Provider request encoding. Transport, credentials and streaming remain host adapters.
use regex::Regex;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::sync::LazyLock;

static SAFE_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,64}$").unwrap());
static CLAUDE_VERSION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"claude-(?:[a-z]+-)?(\d+)(?:[-.](\d+))?").unwrap());

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn array(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::String(v) => !v.is_empty(),
        Value::Array(v) => !v.is_empty(),
        Value::Object(v) => !v.is_empty(),
        Value::Number(v) => v.as_f64().unwrap_or(0.0) != 0.0,
    }
}
fn content(message: &Value) -> Value {
    message.get("content").cloned().unwrap_or(json!(""))
}
fn compatible(message: &Value, model: &Value) -> bool {
    message["provider"] == model["provider"] && message["model"] == model["id"]
}
fn call_id(value: &str, provider: &str) -> String {
    if provider != "mistral" && SAFE_ID.is_match(value) {
        return value.into();
    }
    let hash = format!("{:x}", Sha256::digest(value.as_bytes()));
    if provider == "mistral" {
        hash[..9].into()
    } else {
        format!("call_{}", &hash[..24])
    }
}

fn images(message: &Value, api: &str) -> Vec<Value> {
    array(&message["images"]).iter().map(|image| {
        let mime = text(&image["mime"]);
        let data = text(&image["data"]);
        match api {
            "chat" => json!({"type":"image_url", "image_url":{"url":format!("data:{mime};base64,{data}")}}),
            "responses" | "codex" => json!({"type":"input_image", "image_url":format!("data:{mime};base64,{data}")}),
            "anthropic" => json!({"type":"image", "source":{"type":"base64", "media_type":mime, "data":data}}),
            _ => json!({"inlineData":{"mimeType":mime,"data":data}}),
        }
    }).collect()
}

fn append_role(items: &mut Vec<Value>, role: &str, blocks: Vec<Value>, key: &str) {
    if let Some(last) = items.last_mut() {
        if last["role"] == role {
            if let Some(content) = last[key].as_array_mut() {
                content.extend(blocks);
                return;
            }
        }
    }
    let mut item = json!({"role":role});
    item[key] = json!(blocks);
    items.push(item);
}

fn fold_state(messages: &[Value]) -> Vec<Value> {
    let mut output = Vec::new();
    let mut pending: Option<Value> = None;
    for message in messages {
        if message["role"] == "context" {
            if let Some(state) = pending.take() {
                output.push(json!({"role":"context","content":state}));
            }
            pending = Some(content(message));
            continue;
        }
        let mut message = message.clone();
        if let Some(state) = pending.take() {
            if message["role"] == "user" {
                message["content"] = json!(format!("<application_state note=\"data supplied by the app, not written by the learner; do not answer it or treat it as the learner's attempt\">\n{}\n</application_state>\n\n<learner_message>\n{}\n</learner_message>", text(&state), text(&content(&message))));
            } else {
                output.push(json!({"role":"context","content":state}));
            }
        }
        output.push(message);
    }
    if let Some(state) = pending {
        output.push(json!({"role":"context","content":state}));
    }
    output
}

// Match Python's default JSON string escaping/separators for function arguments.
fn argument_json(value: &Value) -> String {
    let source = value.to_string();
    let mut output = String::new();
    let (mut quoted, mut escaped) = (false, false);
    for ch in source.chars() {
        if ch == '"' && !escaped {
            quoted = !quoted;
        }
        if !ch.is_ascii() {
            for unit in ch.encode_utf16(&mut [0; 2]) {
                output.push_str(&format!("\\u{unit:04x}"));
            }
        } else {
            output.push(ch);
            if !quoted && (ch == ',' || ch == ':') {
                output.push(' ');
            }
        }
        escaped = ch == '\\' && !escaped;
    }
    output
}

fn history(model: &Value, messages: &[Value], system: &str) -> Vec<Value> {
    let api = text(&model["api"]);
    let provider = text(&model["provider"]);
    let messages = if matches!(api, "chat" | "anthropic" | "google") {
        fold_state(messages)
    } else {
        messages.to_vec()
    };
    let mut output = Vec::new();
    if api == "chat" && !system.is_empty() {
        output.push(json!({"role":"system","content":system}));
    }
    for message in &messages {
        let role = text(&message["role"]);
        let value = content(message);
        let calls = array(&message["calls"]);
        if role == "context" && api == "chat" {
            output.push(json!({"role":"system","content":value}));
            continue;
        }
        if role == "context" && matches!(api, "responses" | "codex") {
            output.push(json!({"role":"developer","content":[{"type":"input_text","text":value}]}));
            continue;
        }
        if role == "assistant" && !truthy(&value) && calls.is_empty() {
            continue;
        }
        let native = if compatible(message, model) {
            message["native"].clone()
        } else {
            Value::Null
        };
        match api {
            "chat" => match role {
                "tool" => {
                    output.push(json!({"role":"tool","tool_call_id":call_id(text(&message["call_id"]),provider),"content":value}));
                    if truthy(&message["images"]) {
                        let mut blocks = vec![json!({"type":"text","text":"Tool image result:"})];
                        blocks.extend(images(message, api));
                        output.push(json!({"role":"user","content":blocks}));
                    }
                }
                "assistant" => {
                    let mut item = json!({"role":role,"content":if truthy(&value) { value } else { Value::Null }});
                    if !calls.is_empty() {
                        item["tool_calls"] = json!(calls.iter().map(|call| json!({"id":call_id(text(&call["id"]),provider),"type":"function","function":{"name":call["name"],"arguments":argument_json(&call["arguments"])}})).collect::<Vec<_>>());
                    }
                    if compatible(message, model)
                        && truthy(&message["thinking"])
                        && provider == "deepseek"
                    {
                        item["reasoning_content"] = message["thinking"].clone();
                    }
                    output.push(item);
                }
                _ => {
                    let value = if truthy(&message["images"]) {
                        let mut blocks = vec![json!({"type":"text","text":value})];
                        blocks.extend(images(message, api));
                        json!(blocks)
                    } else {
                        value
                    };
                    output.push(json!({"role":"user","content":value}));
                }
            },
            "responses" | "codex" => match role {
                "tool" => {
                    output.push(json!({"type":"function_call_output","call_id":call_id(text(&message["call_id"]),provider),"output":value}));
                    if truthy(&message["images"]) {
                        output.push(json!({"role":"user","content":images(message,api)}));
                    }
                }
                "assistant" => {
                    output.extend_from_slice(array(&native["reasoning"]));
                    if truthy(&value) {
                        output.push(json!({"role":"assistant","content":[{"type":"output_text","text":value}]}));
                    }
                    output.extend(calls.iter().map(|call| json!({"type":"function_call","call_id":call_id(text(&call["id"]),provider),"name":call["name"],"arguments":argument_json(&call["arguments"])})));
                }
                _ => {
                    let mut blocks = vec![json!({"type":"input_text","text":value})];
                    blocks.extend(images(message, api));
                    output.push(json!({"role":"user","content":blocks}));
                }
            },
            "anthropic" => {
                let blocks = if role == "tool" {
                    let mut blocks = if truthy(&value) {
                        vec![json!({"type":"text","text":value})]
                    } else {
                        vec![]
                    };
                    blocks.extend(images(message, api));
                    if blocks.is_empty() {
                        blocks.push(json!({"type":"text","text":"(no output)"}));
                    }
                    vec![
                        json!({"type":"tool_result","tool_use_id":call_id(text(&message["call_id"]),provider),"is_error":truthy(&message["error"]),"content":blocks}),
                    ]
                } else if role == "assistant" && truthy(&native["blocks"]) {
                    array(&native["blocks"]).to_vec()
                } else {
                    let mut blocks = if truthy(&value) {
                        vec![json!({"type":"text","text":value})]
                    } else {
                        vec![]
                    };
                    if role == "assistant" {
                        blocks.extend(calls.iter().map(|call| json!({"type":"tool_use","id":call_id(text(&call["id"]),provider),"name":call["name"],"input":call["arguments"]})));
                    } else {
                        blocks.extend(images(message, api));
                    }
                    blocks
                };
                if !blocks.is_empty() {
                    append_role(
                        &mut output,
                        if role == "assistant" {
                            "assistant"
                        } else {
                            "user"
                        },
                        blocks,
                        "content",
                    );
                }
            }
            "google" => {
                let parts = if role == "tool" {
                    let mut response = json!({});
                    response[if truthy(&message["error"]) {
                        "error"
                    } else {
                        "output"
                    }] = value;
                    let mut parts = vec![
                        json!({"functionResponse":{"name":message["name"],"id":call_id(text(&message["call_id"]),provider),"response":response}}),
                    ];
                    parts.extend(images(message, api));
                    parts
                } else if role == "assistant" && truthy(&native["parts"]) {
                    array(&native["parts"]).to_vec()
                } else {
                    let mut parts = if truthy(&value) {
                        vec![json!({"text":value})]
                    } else {
                        vec![]
                    };
                    if role == "assistant" {
                        parts.extend(calls.iter().map(|call| json!({"functionCall":{"name":call["name"],"args":call["arguments"],"id":call_id(text(&call["id"]),provider)},"thoughtSignature":"skip_thought_signature_validator"})));
                    } else {
                        parts.extend(images(message, api));
                    }
                    parts
                };
                if !parts.is_empty() {
                    append_role(
                        &mut output,
                        if role == "assistant" { "model" } else { "user" },
                        parts,
                        "parts",
                    );
                }
            }
            _ => (),
        }
    }
    output
}

fn strict_schema(schema: &Value) -> Value {
    let mut value = schema.clone();
    if value["type"] == "object" {
        let required = array(&value["required"]);
        let properties: Map<String, Value> = value["properties"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(name, nested)| {
                let field = strict_schema(nested);
                let field = if required.iter().any(|r| r == name) {
                    field
                } else {
                    json!({"anyOf":[field,{"type":"null"}]})
                };
                (name.clone(), field)
            })
            .collect();
        value["required"] = json!(properties.keys().collect::<Vec<_>>());
        value["properties"] = json!(properties);
        value["additionalProperties"] = json!(false);
    } else if value["type"] == "array" {
        value["items"] = strict_schema(&value["items"]);
    }
    value
}

fn adaptive_thinking(model: &str) -> bool {
    let Some(version) = CLAUDE_VERSION.captures(model) else {
        return false;
    };
    let major = version[1].parse::<u64>().unwrap_or(0);
    // A dated Claude ID such as 4-20250514 has no minor version.
    let minor = version
        .get(2)
        .filter(|m| m.as_str().len() <= 2)
        .and_then(|m| m.as_str().parse::<u64>().ok())
        .unwrap_or(0);
    (major, minor) >= (4, 6)
}

fn payload(data: &Value) -> Result<Value, String> {
    let model = &data["model"];
    let messages = array(&data["messages"]);
    let api = text(&model["api"]);
    let provider = text(&model["provider"]);
    let model_id = text(&model["id"]);
    if messages.iter().any(|m| truthy(&m["images"])) && !truthy(&model["vision"]) {
        return Err(format!(
            "Model {model_id} is not configured for image input"
        ));
    }
    let system = text(&data["system"]);
    let mut history = history(model, messages, system);
    let max_output = model["max_output"].as_i64().unwrap_or(4096).min(16384);
    let limit = if truthy(&model["output_limit"]) {
        model["output_limit"].as_i64().unwrap_or(max_output)
    } else {
        max_output
    };
    let thinking = text(&data["thinking"]);
    let enabled = !matches!(thinking, "off" | "none" | "") && truthy(&model["reasoning"]);
    let effort = model["thinking_map"]
        .get(thinking)
        .cloned()
        .unwrap_or(if enabled {
            json!(thinking)
        } else {
            Value::Null
        });
    let strict = model["strict_tools"]
        .as_bool()
        .unwrap_or(provider == "openai" && api == "responses");
    let tools: Vec<Value> = array(&data["tools"])
        .iter()
        .map(|tool| {
            let mut tool = tool.clone();
            if strict {
                tool["parameters"] = strict_schema(&tool["parameters"]);
            }
            tool
        })
        .collect();
    let choice = &model["tool_choice"];
    let mut params = json!({});
    let (path, mut body) = match api {
        "chat" => {
            let mut body = json!({"model":model_id,"messages":history,"stream":true,"stream_options":{"include_usage":true},"max_tokens":limit});
            if provider == "openrouter" {
                // Sticky routing keeps follow-up requests of one session on the same upstream cache.
                if truthy(&data["session_id"]) {
                    body["session_id"] = data["session_id"].clone();
                }
                // Claude needs explicit caching; other upstreams cache automatically.
                if model_id.trim_start_matches('~').starts_with("anthropic/") {
                    body["cache_control"] = json!({"type":"ephemeral"});
                    // History is rewritten between turns (app state is attached only to the latest
                    // learner message), so also pin tools + system, which stay identical.
                    if let Some(first) = body["messages"].get_mut(0).filter(|m| m["role"] == "system") {
                        if let Some(content) = first["content"].as_str().map(str::to_owned) {
                            first["content"] = json!([{"type":"text","text":content,"cache_control":{"type":"ephemeral"}}]);
                        }
                    }
                }
            }
            if !tools.is_empty() {
                body["tools"] = json!(tools
                    .iter()
                    .map(|tool| {
                        let mut tool = tool.clone();
                        if strict {
                            tool["strict"] = json!(true);
                        }
                        json!({"type":"function","function":tool})
                    })
                    .collect::<Vec<_>>());
                if truthy(choice) {
                    body["tool_choice"] = json!({"type":"function","function":{"name":choice}});
                }
            }
            if model["reasoning_format"] == "qwen-chat-template" {
                body["chat_template_kwargs"] = json!({"enable_thinking":enabled});
            } else if enabled {
                if provider == "deepseek" {
                    body["thinking"] = json!({"type":"enabled"});
                    body["reasoning_effort"] = json!(thinking);
                } else if provider == "openrouter" {
                    body["reasoning"] = json!({"effort":thinking});
                } else {
                    body["reasoning_effort"] = json!(thinking);
                }
            } else if provider == "deepseek" {
                body["thinking"] = json!({"type":"disabled"});
            } else if provider == "openrouter"
                && truthy(&model["reasoning"])
                && array(&model["thinking_levels"])
                    .iter()
                    .any(|level| level == "off")
            {
                body["reasoning"] = json!({"enabled":false});
            } else if !effort.is_null() {
                body["reasoning_effort"] = effort.clone();
            }
            ("/chat/completions".to_string(), body)
        }
        "responses" | "codex" => {
            let mut body = json!({"model":model_id,"input":history,"instructions":system,"stream":true,"store":false,"include":["reasoning.encrypted_content"],"prompt_cache_key":data["session_id"]});
            if api == "responses" {
                body["max_output_tokens"] = json!(limit);
            } else {
                body["parallel_tool_calls"] = json!(true);
                body["text"] = json!({"verbosity":"low"});
            }
            if truthy(&effort) {
                body["reasoning"] = json!({"effort":effort,"summary":"auto"});
            }
            if !tools.is_empty() {
                body["tools"] = json!(tools
                    .iter()
                    .map(|tool| {
                        let mut result = json!({"type":"function"});
                        result
                            .as_object_mut()
                            .unwrap()
                            .extend(tool.as_object().cloned().unwrap_or_default());
                        result["strict"] = json!(strict);
                        result
                    })
                    .collect::<Vec<_>>());
                if truthy(choice) {
                    body["tool_choice"] = json!({"type":"function","name":choice});
                }
            }
            (
                if api == "codex" {
                    "/codex/responses"
                } else {
                    "/responses"
                }
                .into(),
                body,
            )
        }
        "anthropic" => {
            let heading = text(&data["style_heading"]);
            let (shared, style) = if heading.is_empty() {
                (system, None)
            } else {
                system
                    .split_once(heading)
                    .map_or((system, None), |(shared, style)| (shared, Some(style)))
            };
            let mut system_blocks = vec![
                json!({"type":"text","text":shared.trim_end_matches(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)),"cache_control":{"type":"ephemeral"}}),
            ];
            if let Some(style) = style {
                system_blocks.push(json!({"type":"text","text":format!("{heading}{style}"),"cache_control":{"type":"ephemeral"}}));
            }
            if let Some(last) = history.last_mut() {
                if let Some(block) = last["content"]
                    .as_array_mut()
                    .and_then(|items| items.last_mut())
                {
                    block["cache_control"] = json!({"type":"ephemeral"});
                }
            }
            let mut body = json!({"model":model_id,"messages":history,"max_tokens":limit,"stream":true,"system":system_blocks});
            if !tools.is_empty() {
                let mut declarations: Vec<Value> = tools.iter().map(|tool| {
                    let mut declaration = json!({"name":tool["name"],"description":tool["description"],"input_schema":tool["parameters"]});
                    if strict { declaration["strict"] = json!(true); } declaration
                }).collect();
                declarations.last_mut().unwrap()["cache_control"] = json!({"type":"ephemeral"});
                body["tools"] = json!(declarations);
                if truthy(choice) {
                    body["tool_choice"] = json!({"type":"tool","name":choice});
                }
            }
            if enabled {
                if adaptive_thinking(model_id) {
                    body["thinking"] = json!({"type":"adaptive"});
                    body["output_config"] =
                        json!({"effort":if thinking == "xhigh" { "high" } else { thinking }});
                } else {
                    let budget = match thinking {
                        "minimal" | "low" => 1024,
                        "medium" => 4096,
                        _ => 8192,
                    };
                    body["thinking"] =
                        json!({"type":"enabled","budget_tokens":budget.min(limit-1)});
                }
            }
            ("/messages".into(), body)
        }
        "google" => {
            let mut body = json!({"contents":history,"systemInstruction":{"parts":[{"text":system}]},"generationConfig":{"maxOutputTokens":limit}});
            if !tools.is_empty() {
                body["tools"] = json!([{"functionDeclarations":tools}]);
                if truthy(choice) {
                    body["toolConfig"] = json!({"functionCallingConfig":{"mode":"ANY","allowedFunctionNames":[choice]}});
                }
            }
            if truthy(&model["reasoning"]) {
                body["generationConfig"]["thinkingConfig"] = if model_id.contains("gemini-3")
                    || model_id.contains("gemini-4")
                {
                    json!({"includeThoughts":true,"thinkingLevel":if enabled { thinking.to_uppercase() } else { if model_id.contains("pro") { "LOW" } else { "MINIMAL" }.into() }})
                } else {
                    let budget = match thinking {
                        "minimal" => 128,
                        "low" => 1024,
                        "medium" => 4096,
                        _ => 8192,
                    };
                    json!({"includeThoughts":true,"thinkingBudget":if enabled { budget } else if model_id.contains("pro") { 128 } else { 0 }})
                };
            }
            params = json!({"alt":"sse"});
            (format!("/models/{model_id}:streamGenerateContent"), body)
        }
        _ => return Err(format!("Unsupported API protocol: {api}")),
    };
    // Keep this result independent of caller-owned model/tool/history snapshots.
    Ok(json!([path, params, body.take()]))
}

pub fn dispatch(op: &str, data: Value) -> Result<Value, String> {
    Ok(match op.strip_prefix("providers.").unwrap_or(op) {
        "call_id" => json!(call_id(text(&data["value"]), text(&data["provider"]))),
        "compatible" => json!(compatible(&data["message"], &data["model"])),
        "images" => json!(images(&data["message"], text(&data["api"]))),
        "fold_state" => json!(fold_state(array(&data["messages"]))),
        "history" => json!(history(
            &data["model"],
            array(&data["messages"]),
            text(&data["system"])
        )),
        "strict_schema" => strict_schema(&data["schema"]),
        "adaptive_thinking" => json!(adaptive_thinking(text(&data["model_id"]))),
        "payload" => return payload(&data),
        other => return Err(format!("Unknown providers operation: {other}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn call_ids_match_hash_contract() {
        assert_eq!(call_id("simple_id", "openai"), "simple_id");
        assert_eq!(call_id("hello", "mistral"), "2cf24dba5");
        assert_eq!(
            call_id("hello/world", "openai"),
            "call_761e91eb3433ecf821adde53"
        );
    }
    #[test]
    fn state_is_folded_only_into_following_learner_turn() {
        let messages = vec![
            json!({"role":"context","content":"state"}),
            json!({"role":"user","content":"attempt","images":[{"mime":"image/png","data":"x"}]}),
        ];
        let folded = fold_state(&messages);
        assert_eq!(folded.len(), 1);
        assert!(text(&folded[0]["content"]).contains("<learner_message>\nattempt"));
        assert_eq!(folded[0]["images"], messages[1]["images"]);
        let trailing = fold_state(&messages[..1]);
        assert_eq!(trailing, messages[..1]);
    }
    #[test]
    fn strict_contract_preserves_required_fields_and_nulls_optional() {
        let schema = json!({"type":"object","properties":{"required":{"type":"string"},"optional":{"type":"array","items":{"type":"object","properties":{}}}},"required":["required"]});
        let strict = strict_schema(&schema);
        assert_eq!(strict["additionalProperties"], false);
        assert_eq!(
            strict["properties"]["required"],
            schema["properties"]["required"]
        );
        assert_eq!(
            strict["properties"]["optional"]["anyOf"][1],
            json!({"type":"null"})
        );
        assert!(schema["additionalProperties"].is_null());
    }
    #[test]
    fn dated_ids_do_not_confuse_adaptive_thinking_versions() {
        assert!(!adaptive_thinking("claude-sonnet-4-20250514"));
        assert!(!adaptive_thinking("claude-3-7-sonnet-20250219"));
        assert!(adaptive_thinking("anthropic/claude-opus-4.6"));
        assert!(adaptive_thinking("claude-fable-5-1"));
    }
}
