//! Network-facing provider adapters and model catalog.
mod auth;
mod catalog;
mod llama;
mod quality;
mod settings;
mod transport;
mod web;
use serde_json::Value;

pub fn subscribe_llama() -> tokio::sync::broadcast::Receiver<Value> {
    llama::subscribe()
}

pub fn subscribe_auth() -> tokio::sync::broadcast::Receiver<Value> {
    auth::subscribe()
}

pub async fn stream(
    request: Value,
    events: tokio::sync::mpsc::UnboundedSender<Value>,
) -> Result<Value, String> {
    transport::stream(request, events).await
}

pub async fn dispatch(op: &str, data: Value) -> Result<Value, String> {
    match op.split('.').next().unwrap_or("") {
        "providers" if matches!(op, "providers.connect" | "providers.disconnect") => {
            settings::dispatch(op, data).await
        }
        "settings" => settings::dispatch(op, data).await,
        "models" | "providers" => catalog::dispatch(op, data).await,
        "web" => web::dispatch(op, data).await,
        "auth" => auth::dispatch(op, data).await,
        "quality" => Ok(quality::dispatch(op, data)?),
        "llama" => llama::dispatch(op, data).await,
        _ => Err(format!("Unknown provider operation: {op}")),
    }
}
