//! Teacher / student role routes. Logic lives in `state_runtime/teaching.rs`; this maps HTTP to it.
use super::{ApiError, App};
use axum::http::StatusCode;
use serde_json::{json, Value};

/// The only request fields that reach an operation; the rest of a body is ignored.
const ALLOWED: &[&str] = &["teacher"];
pub(crate) fn route(
    app: &App,
    method: &str,
    p: &[&str],
    body: Value,
) -> Result<(StatusCode, Value), ApiError> {
    let ok = StatusCode::OK;
    let call = |op: &str, mut v: Value| -> Result<Value, ApiError> {
        for (k, x) in body.as_object().into_iter().flatten().filter(|(k, _)| ALLOWED.contains(&k.as_str())) {
            v[k] = x.clone();
        }
        app.state(op, v).map_err(ApiError::invalid)
    };
    match (method, p) {
        ("GET", ["role"]) => Ok((ok, call("teaching.role.get", json!({}))?)),
        ("PUT", ["role"]) => Ok((ok, call("teaching.role.set", json!({}))?)),
        _ => Err(ApiError::new(StatusCode::NOT_FOUND, "http_error", "Not Found")),
    }
}
