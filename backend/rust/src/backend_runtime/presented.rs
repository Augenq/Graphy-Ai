//! `present_file`: the agent hands the learner a finished document. The file is copied (a snapshot) into
//! `<workspace>/.graphy-presented/<id>/` and served by id, so the card in the transcript keeps working after the
//! agent edits or deletes the original. Nothing here interprets the file; the client decides how to preview it.
use super::{ApiError, App};
use axum::{
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub(crate) const MAX_BYTES: u64 = 20 * 1024 * 1024;
const FOLDER: &str = ".graphy-presented";

pub(crate) fn declaration() -> Value {
    json!({
        "name": "present_file",
        "description": "Present a finished file from the workspace to the learner (a PDF, document, worksheet, spreadsheet, image, text). It opens in a panel beside the chat where the learner can read it full screen and download it; a teacher can also share it with students. Create the file first (bash), then call this once per file. Do not paste the file's content into the reply and do not present scratch files. Up to 20 MB.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "minLength": 1, "maxLength": 1024, "pattern": "\\S", "description": "Path of the file, absolute or relative to the workspace."},
                "title": {"type": "string", "maxLength": 120, "description": "Short title shown to the learner, in their language (default: the file name)."}
            },
            "required": ["path"],
            "additionalProperties": false
        }
    })
}

pub(crate) fn mime_of(name: &str) -> &'static str {
    match name.rsplit_once('.').map(|(_, e)| e.to_lowercase()).as_deref() {
        Some("pdf") => "application/pdf",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("md" | "markdown") => "text/markdown",
        Some("txt" | "log") => "text/plain",
        Some("csv") => "text/csv",
        Some("tsv") => "text/tab-separated-values",
        Some("json") => "application/json",
        Some("html" | "htm") => "text/html",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("pptx") => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        Some("odt") => "application/vnd.oasis.opendocument.text",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
}
/// A display name only: never used to build a path.
fn display_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base.chars().filter(|c| !c.is_control()).take(160).collect();
    let clean = clean.trim().trim_matches('.').to_owned();
    if clean.is_empty() {
        "file".into()
    } else {
        clean
    }
}
fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn folder(cwd: &str) -> PathBuf {
    Path::new(cwd).join(FOLDER)
}

pub(crate) fn tool(app: &App, call: &Value) -> Result<Value, String> {
    let args = &call["arguments"];
    jsonschema::validate(&declaration()["parameters"], args).map_err(|e| e.to_string())?;
    let given = args["path"].as_str().unwrap_or("");
    let source = crate::runtime_tools::path(&app.cwd, given);
    let meta = std::fs::metadata(&source).map_err(|_| format!("File not found: {given}"))?;
    if !meta.is_file() {
        return Err(format!("Not a file: {given}"));
    }
    if meta.len() == 0 {
        return Err("The file is empty: create its content first".into());
    }
    if meta.len() > MAX_BYTES {
        return Err(format!("The file is too large ({} MB, max 20 MB)", meta.len() / 1_048_576));
    }
    let name = display_name(
        source.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
    );
    let mime = mime_of(&name);
    let id = uuid::Uuid::new_v4().simple().to_string();
    let dir = folder(&app.cwd).join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("storage_error: {e}"))?;
    let copied = std::fs::copy(&source, dir.join("file")).map_err(|e| format!("storage_error: {e}"))?;
    let title = args["title"].as_str().map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned);
    let file = json!({"id":id,"name":name,"title":title,"mime":mime,"size":copied});
    std::fs::write(dir.join("meta.json"), file.to_string()).map_err(|e| format!("storage_error: {e}"))?;
    Ok(json!({"content": json!({"ok":true,"file":file,"note":"The file is open beside the chat. Continue in text; do not repeat its content."}).to_string()}))
}

/// `GET /api/v1/presented/{id}`: the bytes of a presented file. Authenticated like every route (the caller checked).
pub(crate) async fn serve(app: &App, id: &str) -> Result<Response, ApiError> {
    let not_found = || ApiError::new(StatusCode::NOT_FOUND, "not_found", "File not found");
    if !valid_id(id) {
        return Err(not_found());
    }
    let dir = folder(&app.cwd).join(id);
    let meta: Value = tokio::fs::read(dir.join("meta.json"))
        .await
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or_else(not_found)?;
    let bytes = tokio::fs::read(dir.join("file")).await.map_err(|_| not_found())?;
    let mime = mime_of(meta["name"].as_str().unwrap_or(""));
    let mut response = (StatusCode::OK, bytes).into_response();
    let h = response.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=3600"));
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declaration_requires_a_path_and_nothing_else() {
        let d = declaration();
        let p = &d["parameters"];
        assert!(jsonschema::validate(p, &json!({"path":"a.pdf"})).is_ok());
        assert!(jsonschema::validate(p, &json!({"path":"a.pdf","title":"Конспект"})).is_ok());
        for bad in [json!({}), json!({"path":""}), json!({"path":"a","x":1}), json!({"path":"  "})] {
            assert!(jsonschema::validate(p, &bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn names_and_ids_cannot_escape() {
        assert_eq!(display_name("../../etc/passwd"), "passwd");
        assert_eq!(display_name("C:\\x\\конспект.pdf"), "конспект.pdf");
        assert_eq!(display_name(".."), "file");
        assert!(valid_id(&uuid::Uuid::new_v4().simple().to_string()));
        for bad in ["", "..", "../x", "ABCDEF0123456789ABCDEF0123456789", "short"] {
            assert!(!valid_id(bad), "{bad}");
        }
        assert_eq!(mime_of("Notes.PDF"), "application/pdf");
        assert_eq!(mime_of("x.unknown"), "application/octet-stream");
    }

    #[tokio::test]
    async fn a_presented_file_is_a_snapshot_that_is_served_by_id() {
        let dir = tempfile::tempdir().unwrap();
        let app = crate::backend_runtime::test_app(dir.path());
        let src = Path::new(&app.cwd).join("notes.md");
        std::fs::write(&src, "# Hi").unwrap();
        let r = tool(&app, &json!({"arguments":{"path":"notes.md","title":"Notes"}})).unwrap();
        let body: Value = serde_json::from_str(r["content"].as_str().unwrap()).unwrap();
        let (id, size) = (body["file"]["id"].as_str().unwrap().to_owned(), body["file"]["size"].as_u64());
        assert_eq!(size, Some(4));
        std::fs::remove_file(&src).unwrap();
        let served = serve(&app, &id).await.unwrap();
        assert_eq!(served.headers()[header::CONTENT_TYPE], "text/markdown");
        assert!(serve(&app, "..").await.is_err());
        assert!(tool(&app, &json!({"arguments":{"path":"missing.pdf"}})).is_err());
        assert!(tool(&app, &json!({"arguments":{"path":"."}})).is_err());
    }

    #[test]
    fn agent_tool_list_includes_present_file() {
        let dir = tempfile::tempdir().unwrap();
        let app = crate::backend_runtime::test_app(dir.path());
        let all = crate::runtime_tools::declarations(&app).unwrap();
        let names: Vec<_> = all.as_array().unwrap().iter().filter_map(|t| t["name"].as_str()).collect();
        assert!(names.contains(&"present_file"));
        assert!(!names.iter().any(|n| n.starts_with("design_")));
    }
}
