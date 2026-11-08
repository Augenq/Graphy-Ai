//! Host-side tool execution and attachments.
use crate::backend_runtime::{App, Session};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::AsyncReadExt;

pub(crate) fn path(cwd: &str, value: &str) -> PathBuf {
    let p = PathBuf::from(value);
    if p.is_absolute() {
        p
    } else {
        Path::new(cwd).join(p)
    }
}
fn image(path: &Path) -> Result<Value, String> {
    use base64::Engine;
    use image::ImageFormat;
    let img = image::open(path)
        .map_err(|e| e.to_string())?
        .thumbnail(2000, 2000);
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let mut data = out.into_inner();
    let mime = if data.len() > 3_000_000 {
        let mut out = std::io::Cursor::new(Vec::new());
        img.to_rgb8()
            .write_to(&mut out, ImageFormat::Jpeg)
            .map_err(|e| e.to_string())?;
        data = out.into_inner();
        "image/jpeg"
    } else {
        "image/png"
    };
    if data.len() > 4_500_000 {
        return Err("Image is too large after resize".into());
    }
    Ok(
        json!({"mime":mime,"data":base64::engine::general_purpose::STANDARD.encode(data),"name":path.file_name().unwrap_or_default().to_string_lossy()}),
    )
}
fn is_image(p: &Path) -> bool {
    p.extension().and_then(|s| s.to_str()).is_some_and(|s| {
        ["png", "jpg", "jpeg", "gif", "webp", "bmp"].contains(&s.to_lowercase().as_str())
    })
}
fn read(cwd: &str, args: &Value) -> Result<Value, String> {
    read_inner(cwd, args, &std::sync::atomic::AtomicBool::new(false))
}
fn read_inner(
    cwd: &str,
    args: &Value,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<Value, String> {
    let name = args["path"].as_str().ok_or("path is required")?;
    let p = path(cwd, name);
    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
    // Documents and BOM-prefixed UTF-16 text go through the stdlib helper (docx, xlsx, pptx, odf,
    // epub, fb2, rtf, pdf, zip listing, legacy-format messages); paging below is shared.
    let utf16 = std::fs::File::open(&p).ok().is_some_and(|mut f| {
        let mut b = [0u8; 2];
        std::io::Read::read_exact(&mut f, &mut b).is_ok() && (b == [0xFF, 0xFE] || b == [0xFE, 0xFF])
    });
    let extracted = if crate::doc_text::is_doc_ext(&ext) || utf16 {
        Some(crate::doc_text::extract_file(&p, &ext)?)
    } else {
        None
    };
    if is_image(&p) {
        return Ok(
            json!({"content":format!("Image: {}",p.file_name().unwrap_or_default().to_string_lossy()),"images":[image(&p)?]}),
        );
    }
    use std::io::{BufRead, BufReader};
    use std::sync::atomic::Ordering;
    let mut reader: Box<dyn BufRead> = match extracted {
        Some(text) => Box::new(std::io::Cursor::new(text.into_bytes())),
        None => Box::new(BufReader::new(std::fs::File::open(&p).map_err(|e| e.to_string())?)),
    };
    let start = args["offset"].as_u64().unwrap_or(1) as usize;
    let limit = (args["limit"].as_u64().unwrap_or(2000) as usize).min(2000);
    let mut current = 1usize;
    let mut last = start - 1;
    let mut line = Vec::new();
    let mut selected = Vec::new();
    let mut truncated = false;
    let mut checked = 0usize;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("Read cancelled".into());
        }
        let buf = reader.fill_buf().map_err(|e| e.to_string())?;
        if buf.is_empty() {
            if current >= start && !line.is_empty() {
                if selected.len() + line.len() > 51200 || last + 1 - start >= limit {
                    truncated = true
                } else {
                    selected.extend(&line);
                    last = current
                }
            }
            break;
        }
        let n = buf
            .iter()
            .position(|b| *b == b'\n')
            .map_or(buf.len(), |i| i + 1);
        if checked < 4096 && buf[..n.min(4096 - checked)].contains(&0) {
            return Err("Бинарный файл нельзя прочитать как учебный текст".into());
        }
        checked += n;
        if current >= start {
            if last + 1 - start >= limit || selected.len() + line.len() + n > 51200 {
                truncated = true;
                break;
            }
            line.extend_from_slice(&buf[..n]);
        }
        let newline = buf[n - 1] == b'\n';
        reader.consume(n);
        if newline {
            if current >= start {
                selected.extend(&line);
                line.clear();
                last = current;
            }
            current += 1;
        }
    }
    let mut content = match String::from_utf8(selected) {
        Ok(s) => s,
        // not UTF-8: Russian school files are very often windows-1251
        Err(e) => e.as_bytes().iter().map(|&b| match b {
            0..=0x7F => b as char,
            0xC0..=0xFF => char::from_u32(0x410 + (b - 0xC0) as u32).unwrap_or('\u{FFFD}'),
            0xA8 => 'Ё',
            0xB8 => 'ё',
            0x93 | 0x94 => '"',
            0x96 => '–',
            0x97 => '—',
            0xAB => '«',
            0xBB => '»',
            0xB9 => '№',
            _ => '\u{FFFD}',
        }).collect(),
    };
    if truncated && last < start {
        content=format!("[Line {start} exceeds 51200 bytes. Read it with bash, e.g. sed -n '{start}p' file | cut -c1-4000.]");
        return Ok(json!({"content":content,"next_offset":null,"truncated":true}));
    }
    if truncated {
        content.push_str(&format!(
            "\n[Truncated; continue with offset={}. For an oversized line use bash.]",
            last + 1
        ))
    }
    Ok(
        json!({"content":content,"next_offset":if truncated{Some(last+1)}else{None},"truncated":truncated}),
    )
}
pub async fn attachments(cwd: &str, text: &str, paths: &Value) -> Result<Value, String> {
    let mut names = Vec::new();
    let re = regex::Regex::new(r#"(?:^|\s)@(?:"([^"\n]+)"|'([^'\n]+)'|([^\s]+))"#).unwrap();
    for m in re.captures_iter(text) {
        if let Some(v) = (1..=3).find_map(|i| m.get(i)) {
            names.push(v.as_str().to_owned())
        }
    }
    names.extend(
        paths
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned),
    );
    let mut seen = std::collections::HashSet::new();
    let mut content = text.to_owned();
    let mut images = Vec::new();
    let mut chips = Vec::new();
    for name in names {
        let p = path(cwd, &name);
        if !p.is_file() || !seen.insert(p.clone()) {
            continue;
        }
        let kind = if is_image(&p) {
            images.push(image(&p)?);
            "image"
        } else {
            let cwd = cwd.to_owned();
            let arguments = json!({"path":p});
            let result = tokio::task::spawn_blocking(move || read(&cwd, &arguments))
                .await
                .map_err(|e| e.to_string())?;
            // An unreadable attachment must not discard the learner's message: tell the model why.
            let shown = match &result {
                Ok(v) => v["content"].as_str().unwrap_or("").to_owned(),
                Err(e) => format!("[Could not read this file: {e}]"),
            };
            content.push_str(&format!("\n\nAttached file {}:\n{}", p.display(), shown));
            "file"
        };
        chips.push(json!({"name":p.file_name().unwrap_or_default().to_string_lossy(),"path":p,"kind":kind,"size":std::fs::metadata(&p).map_err(|e|e.to_string())?.len()}))
    }
    let mut msg = json!({"role":"user","content":content});
    if !images.is_empty() {
        msg["images"] = json!(images)
    }
    if !chips.is_empty() {
        msg["display"] = json!(text);
        msg["attachments"] = json!(chips)
    }
    Ok(msg)
}
pub(crate) fn declarations(app: &App) -> Result<Value, String> {
    let root = std::env::var_os("GRAPHY_RESOURCE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../graphy"));
    let parsed: Value = serde_json::from_slice(
        &std::fs::read(root.join("resources/contracts.json"))
            .map_err(|e| format!("Cannot read tool contracts: {e}"))?,
    )
    .map_err(|e| format!("Invalid tool contracts: {e}"))?;
    let prefs: Value = std::fs::read(Path::new(&app.root).join("settings.json"))
        .ok()
        .and_then(|v| serde_json::from_slice(&v).ok())
        .unwrap_or_else(|| json!({}));
    let enabled = |name: &str| {
        prefs["learning_tools"]
            .as_array()
            .map_or(true, |a| a.iter().any(|v| v == name))
    };
    let local: Value = serde_json::from_slice(
        &std::fs::read(root.join("resources/tools.json"))
            .map_err(|e| format!("Cannot read local tool contracts: {e}"))?,
    ).map_err(|e| format!("Invalid local tool contracts: {e}"))?;
    let mut out = Vec::new();
    for name in ["read", "bash"] {
        if enabled(name) {
            out.push(json!({"name":name,"description":local["DEFINITIONS"][name][0],
                "parameters":local["DEFINITIONS"][name][1]}));
        }
    }
    for (name, schema) in parsed["PUBLIC"].as_object().into_iter().flatten() {
        out.push(json!({"name":name,"description":parsed["DESCRIPTIONS"][name].as_str().unwrap_or(name),"parameters":schema}))
    }
    for (name, schema) in parsed["WEB_PUBLIC"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(name, _)| enabled(name))
    {
        out.push(json!({"name":name,"description":parsed["DESCRIPTIONS"][name],"parameters":schema}))
    }
    if enabled("load_skill")
        && prefs["skills_enabled"] != false
        && app
            .state("skills.list", json!({}))
            .ok()
            .is_some_and(|v| v["skills"].as_array().is_some_and(|v| !v.is_empty()))
    {
        out.push(json!({"name":"load_skill","description":parsed["DESCRIPTIONS"]["load_skill"],"parameters":parsed["SKILL_PUBLIC"]}))
    }
    let widgets: Value = serde_json::from_slice(
        &std::fs::read(root.join("resources/widgets.json"))
            .map_err(|e| format!("Cannot read widget contracts: {e}"))?,
    )
    .map_err(|e| format!("Invalid widget contracts: {e}"))?;
    out.extend(
        widgets["DECLARATIONS"]
            .as_array()
            .cloned()
            .unwrap_or_default(),
    );
    out.push(crate::backend_runtime::present_declaration());
    // available to every user in every mode; not switchable through learning_tools
    out.push(json!({"name":crate::researcher::NAME,"description":local["DEFINITIONS"]["spawn_researcher"][0],"parameters":local["DEFINITIONS"]["spawn_researcher"][1]}));
    Ok(json!(out))
}
struct CancelRead(std::sync::Arc<std::sync::atomic::AtomicBool>);
impl Drop for CancelRead {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::Relaxed)
    }
}
pub(crate) async fn execute(app: &App, session_id: &str, session: &Session, call: &Value) -> Value {
    let name = call["name"].as_str().unwrap_or("");
    let mut normalized_call = call.clone();
    if [
        "read",
        "bash",
        "web_search",
        "web_read",
        "load_skill",
        "set_learning_plan",
        "record_assessment",
        "finish_lesson",
        "spawn_researcher",
    ]
    .contains(&name)
    {
        let declarations = match declarations(app) {
            Ok(v) => v,
            Err(e) => return json!({"content":app.redact(e),"error":true}),
        };
        let schema = declarations
            .as_array()
            .and_then(|a| a.iter().find(|v| v["name"] == name))
            .map(|v| v["parameters"].clone());
        let Some(schema) = schema else {
            return json!({"content":format!("Unknown or disabled tool: {name}"),"error":true});
        };
        let normalized = match crate::dispatch(
            "context.normalize_optional",
            json!({"schema":schema,"value":call["arguments"]}),
        ) {
            Ok(v) => v,
            Err(e) => return json!({"content":e,"error":true}),
        };
        if let Err(e) = jsonschema::validate(&schema, &normalized) {
            return json!({"content":e.to_string(),"error":true});
        }
        normalized_call["arguments"] = normalized;
    }
    let call = &normalized_call;
    let args = &call["arguments"];
    let prefs: Value = std::fs::read(Path::new(&app.root).join("settings.json"))
        .ok()
        .and_then(|v| serde_json::from_slice(&v).ok())
        .unwrap_or_else(|| json!({}));
    if ["read", "bash", "web_search", "web_read", "load_skill"].contains(&name)
        && prefs["learning_tools"]
            .as_array()
            .is_some_and(|a| !a.iter().any(|v| v == name))
    {
        return json!({"content":format!("Tool disabled: {name}"),"error":true});
    }
    if name == crate::researcher::NAME {
        return crate::researcher::run(app, session_id, session, call).await;
    }
    let result: Result<Value, String> = match name {
        "read" => {
            let cwd = app.cwd.clone();
            let args = args.clone();
            let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let guard = CancelRead(cancel.clone());
            tokio::task::spawn_blocking(move || read_inner(&cwd, &args, &cancel))
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r)
                .map(|v| {
                    drop(guard);
                    v
                })
        }
        "bash" => {
            bash_with_updates(
                &app.cwd,
                args,
                Some((app.clone(), session_id.to_owned(), call["id"].clone())),
            )
            .await
        }
        "web_search" | "web_read" => {
            let mut request = args.clone();
            if name == "web_read" {
                let data = session.data.lock().unwrap();
                let path = Path::new(data["path"].as_str().unwrap_or(""));
                let cache = path.with_file_name(format!(
                    "{}.web",
                    path.file_stem().unwrap_or_default().to_string_lossy()
                ));
                request["cache_dir"] = json!(cache);
            }
            app.provider(
                if name == "web_search" {
                    "web.search"
                } else {
                    "web.read"
                },
                request,
            )
            .await
            .map(|v| json!({"content":v.to_string()}))
        }
        "set_learning_plan" | "record_assessment" | "finish_lesson" => {
            lesson(app, session, call)
        }
        "visualize_read_me" | "show_widget" => widget(session, call),
        "present_file" => crate::backend_runtime::present_tool(app, call),
        "load_skill" => load_skill(app, session, call),
        _ => Err(format!("Unknown or disabled tool: {name}")),
    };
    result.unwrap_or_else(|e|{let storage=e.starts_with("storage_error: ");let e=app.redact(e);json!({"content":json!({"error":if storage{"storage_error"}else{"invalid_argument"},"message":e}).to_string(),"error":true})})
}
fn lesson(app: &App, s: &Session, call: &Value) -> Result<Value, String> {
    let next = app.mutate(s, "session.lesson_call", json!({"call":call}))?;
    Ok(json!({"content":next["last_result"].to_string()}))
}
fn load_skill(app: &App, session: &Session, call: &Value) -> Result<Value, String> {
    let name = call["arguments"]["name"]
        .as_str()
        .ok_or("name is required")?;
    let skill = app.state("skills.load", json!({"name":name}))?;
    app.append(session,json!({"type":"learning_skill","data":{"name":name,"path":skill["path"],"instructions":skill["instructions"]}}))?;
    Ok(
        json!({"content":format!("Skill: {}\nBase directory: {}\n\n{}",name,skill["base_directory"].as_str().unwrap_or(""),skill["instructions"].as_str().unwrap_or(""))}),
    )
}
fn widget(session: &Session, call: &Value) -> Result<Value, String> {
    let root = std::env::var_os("GRAPHY_RESOURCE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../graphy"));
    let definitions: Value = serde_json::from_slice(
        &std::fs::read(root.join("resources/widgets.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let name = call["name"].as_str().unwrap_or("");
    let args = &call["arguments"];
    let schema = if name == "visualize_read_me" {
        &definitions["READ_ME_SCHEMA"]
    } else {
        &definitions["SHOW_SCHEMA"]
    };
    jsonschema::validate(schema, args).map_err(|e| e.to_string())?;
    if name == "visualize_read_me" {
        let mut names = vec!["core"];
        for n in ["diagram", "chart", "interactive"] {
            if args["modules"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == n))
            {
                names.push(n)
            }
        }
        let mut parts = Vec::new();
        for n in names {
            parts.push(
                std::fs::read_to_string(root.join("prompts/widgets").join(format!("{n}.md")))
                    .map_err(|e| e.to_string())?
                    .trim()
                    .to_owned(),
            )
        }
        return Ok(json!({"content":parts.join("\n\n")}));
    }
    let data = session.data.lock().unwrap();
    let boundary = data["boundary"].as_u64().unwrap_or(0) as usize;
    if !data["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .skip(boundary)
        .any(|m| m["role"] == "tool" && m["name"] == "visualize_read_me" && m["error"] != true)
    {
        return Err("Call visualize_read_me first (silently), then repeat show_widget".into());
    }
    Ok(
        json!({"content":format!("Widget \"{}\" is shown to the learner. Continue in text; do not describe it line by line.",args["title"].as_str().unwrap_or(""))}),
    )
}
#[cfg(unix)]
struct ProcessGroup(u32);
#[cfg(unix)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        unsafe extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        if self.0 > 0 {
            unsafe {
                kill(-(self.0 as i32), 9);
            }
        }
    }
}
#[cfg(test)]
async fn bash(cwd: &str, args: &Value) -> Result<Value, String> {
    bash_with_updates(cwd, args, None).await
}
async fn bash_with_updates(
    cwd: &str,
    args: &Value,
    update: Option<(App, String, Value)>,
) -> Result<Value, String> {
    let command = args["command"].as_str().ok_or("command is required")?;
    let timeout = args["timeout"].as_f64().unwrap_or(86400.0);
    if !timeout.is_finite() || timeout <= 0.0 || timeout > 31_536_000.0 {
        return Err("timeout must be positive".into());
    }
    let mut command_builder = tokio::process::Command::new("bash");
    command_builder
        .arg("-c")
        .arg(command)
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command_builder.as_std_mut().process_group(0);
    }
    let mut child = command_builder.spawn().map_err(|e| e.to_string())?;
    #[cfg(unix)]
    let _group = ProcessGroup(child.id().unwrap_or(0));
    let stdout = child.stdout.take().ok_or("Missing stdout")?;
    let mut stderr = child.stderr.take().ok_or("Missing stderr")?;
    let output = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let file = std::sync::Arc::new(tokio::sync::Mutex::new(tokio::fs::File::from_std(
        output.reopen().map_err(|e| e.to_string())?,
    )));
    let progress_bytes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let stdout_bytes = progress_bytes.clone();
    let stdout_update = update.clone();
    let consume = |mut reader: tokio::process::ChildStdout,
                   file: std::sync::Arc<tokio::sync::Mutex<tokio::fs::File>>| async move {
        use tokio::io::AsyncWriteExt;
        let mut buf = [0; 8192];
        loop {
            let n = reader.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            file.lock().await.write_all(&buf[..n]).await?;
            if let Some((app, id, call_id)) = &stdout_update {
                let count = stdout_bytes.fetch_add(n, std::sync::atomic::Ordering::Relaxed);
                let shown = n.min(51200usize.saturating_sub(count));
                if shown > 0 {
                    app.emit(id, json!({"type":"tool_update","call_id":call_id,"text":app.redact(String::from_utf8_lossy(&buf[..shown]).into_owned())}));
                }
            }
        }
        Ok::<(), std::io::Error>(())
    };
    let err_file = file.clone();
    let err = async move {
        use tokio::io::AsyncWriteExt;
        let mut buf = [0; 8192];
        loop {
            let n = stderr.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            err_file.lock().await.write_all(&buf[..n]).await?;
            if let Some((app, id, call_id)) = &update {
                let count = progress_bytes.fetch_add(n, std::sync::atomic::Ordering::Relaxed);
                let shown = n.min(51200usize.saturating_sub(count));
                if shown > 0 {
                    app.emit(id, json!({"type":"tool_update","call_id":call_id,"text":app.redact(String::from_utf8_lossy(&buf[..shown]).into_owned())}));
                }
            }
        }
        Ok::<(), std::io::Error>(())
    };
    let wait = async {
        let (status, out, err) = tokio::join!(child.wait(), consume(stdout, file.clone()), err);
        out?;
        err?;
        status
    };
    let timed = tokio::time::timeout(Duration::from_secs_f64(timeout), wait).await;
    let (code, timed_out) = match timed {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(e)) => return Err(e.to_string()),
        Err(_) => {
            #[cfg(unix)]
            drop(_group);
            let _ = child.kill().await;
            (None, true)
        }
    };
    use std::io::{Read, Seek, SeekFrom};
    let mut spool = std::fs::File::open(output.path()).map_err(|e| e.to_string())?;
    let size = spool.metadata().map_err(|e| e.to_string())?.len();
    spool
        .seek(SeekFrom::Start(size.saturating_sub(51200)))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(size.min(51200) as usize);
    spool
        .take(51200)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let truncated = size > 51200 || bytes.iter().filter(|b| **b == b'\n').count() > 2000;
    let raw = String::from_utf8_lossy(&bytes);
    let lines: Vec<_> = raw.split_inclusive('\n').collect();
    let tail = if lines.len() > 2000 {
        lines[lines.len() - 2000..].concat()
    } else {
        raw.into_owned()
    };
    let mut content = if truncated {
        format!("[Earlier output omitted]\n{tail}")
    } else {
        tail
    };
    if timed_out {
        content.push_str(&format!(
            "\n[Timed out after {timeout}s; the command was killed]"
        ))
    }
    let mut result = json!({"content":content,"exit_code":code,"error":timed_out||code!=Some(0)});
    if truncated {
        let (_, path) = output.keep().map_err(|e| e.error.to_string())?;
        result["full_output_path"] = json!(path);
        result["content"] = json!(format!("{}\n[Full output: {}]", content, path.display()));
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn attachments_read_rtf_cp1251_and_report_legacy_without_dropping_message() {
        if std::process::Command::new("python3").arg("-V").output().is_err() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("a.rtf"), br"{\rtf1\ansi\ansicpg1251 \'cf\'f0\'e8\'e2\'e5\'f2\par}").unwrap();
        std::fs::write(dir.path().join("b.txt"), "Ответ: №5".encode_utf16().flat_map(|u| u.to_le_bytes()).collect::<Vec<_>>().iter().copied().fold(vec![0xFF, 0xFE], |mut v, b| { v.push(b); v })).unwrap();
        let mut cp = b"\xcf\xf0\xe8\xe2\xe5\xf2 \xbb".to_vec();
        cp.push(b'\n');
        std::fs::write(dir.path().join("c.txt"), cp).unwrap();
        std::fs::write(dir.path().join("d.doc"), [0xD0, 0xCF, 0x11, 0xE0, 0, 0]).unwrap();
        let m = attachments(cwd, "look", &json!(["a.rtf", "b.txt", "c.txt", "d.doc"])).await.unwrap();
        let c = m["content"].as_str().unwrap();
        assert!(c.contains("Привет"), "{c}");
        assert!(c.contains("Ответ: №5"), "{c}");
        assert!(c.contains("Привет »"), "{c}");
        assert!(c.contains("Could not read this file") && c.contains(".docx"), "{c}");
        assert_eq!(m["attachments"].as_array().unwrap().len(), 4);
    }
    #[test]
    fn executable_tool_declarations_include_usage_and_respect_disabled_tools() {
        let root = tempfile::tempdir().unwrap();
        let app = crate::backend_runtime::test_app(root.path());
        let tools = declarations(&app).unwrap();
        let find = |name: &str| tools.as_array().unwrap().iter().find(|t| t["name"] == name).unwrap();
        assert!(find("read")["description"].as_str().unwrap().contains("next_offset"));
        assert!(find("bash")["description"].as_str().unwrap().contains("exit code"));
        for name in ["web_read", "web_search"] {
            let tool = find(name);
            assert!(tool["description"].as_str().unwrap().len() > name.len());
            assert_eq!(tool["parameters"]["additionalProperties"], false);
        }
        assert_eq!(find("web_read")["parameters"]["required"], json!(["url"]));
        assert_eq!(find("web_search")["parameters"]["required"], json!(["query"]));
        std::fs::write(root.path().join("settings.json"), r#"{"learning_tools":["read"],"skills_enabled":false}"#).unwrap();
        let disabled = declarations(&app).unwrap();
        let names: Vec<_> = disabled.as_array().unwrap().iter().filter_map(|t| t["name"].as_str()).collect();
        assert!(names.contains(&"read"));
        for name in ["bash", "web_read", "web_search", "load_skill"] {
            assert!(!names.contains(&name), "{name} was disabled");
        }
    }
    #[tokio::test]
    async fn interrupted_bash_kills_descendants() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_string_lossy().into_owned();
        let marker = dir.path().join("should-not-exist");
        let task = tokio::spawn(async move {
            bash(
                &cwd,
                &json!({"command":"(sleep 1; touch should-not-exist) & wait"}),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        task.abort();
        let _ = task.await;
        tokio::time::sleep(Duration::from_millis(1300)).await;
        assert!(!marker.exists(), "a cancelled tool left its child running");
    }
    #[tokio::test]
    async fn bash_timeout_and_bounded_read() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("text.txt"), "one\ntwo\nthree\n").unwrap();
        let cwd = dir.path().to_str().unwrap();
        let result = read(cwd, &json!({"path":"text.txt","offset":2,"limit":1})).unwrap();
        assert_eq!(result["next_offset"], 3);
        assert!(result["content"].as_str().unwrap().starts_with("two\n"));
        let out = bash(cwd, &json!({"command":"sleep 5","timeout":0.1}))
            .await
            .unwrap();
        assert_eq!(out["error"], true);
        assert!(out["content"].as_str().unwrap().contains("Timed out"));
    }
}
