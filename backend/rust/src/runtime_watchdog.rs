//! Stall watchdog and typed failure reasons for one agent run.
//!
//! A run that produces no provider/tool event for the configured time is first reported (`stalled`,
//! the learner may wait or stop) and, if it stays silent for another period, aborted cleanly: the
//! caller keeps the partial answer and the lesson state as for an ordinary stop.
use serde_json::{json, Value};
use std::future::Future;
use std::time::Duration;
use tokio::sync::{mpsc, watch, Notify};

pub(crate) const DEFAULT_STALL_SECS: u64 = 120;
/// Tools bring their own timeouts; the watchdog is only a backstop beyond the longest sensible one.
pub(crate) const TOOL_BACKSTOP_SECS: u64 = 3600;

/// `stall_timeout_s` from settings: default 120, `0` disables, anything else is clamped to 5..=3600.
pub(crate) fn stall_limit(prefs: &Value) -> Option<Duration> {
    let secs = match prefs["stall_timeout_s"].as_f64() {
        Some(v) if v.is_finite() && v >= 0.0 => v as u64,
        _ => DEFAULT_STALL_SECS,
    };
    (secs != 0).then(|| Duration::from_secs(secs.clamp(5, 3600)))
}

pub(crate) enum Stall {
    /// No activity for the period: the learner decides (`Notify` = wait, abort = stop).
    Warned(u64),
    /// Activity came back after a warning.
    Cleared,
}

pub(crate) enum Drive<T> {
    Done(T),
    Cancelled,
    /// Silent for two periods in a row (or after a wait): aborted by the watchdog.
    Stalled(u64),
}

/// Drives `fut` while forwarding its events. Every event (or a `wait` request) re-arms the watchdog.
pub(crate) async fn drive<T>(
    fut: impl Future<Output = T>,
    rx: &mut mpsc::UnboundedReceiver<Value>,
    cancel: &mut watch::Receiver<bool>,
    limit: Option<Duration>,
    wait: &Notify,
    mut on_event: impl FnMut(Value),
    mut on_stall: impl FnMut(Stall),
) -> Drive<T> {
    tokio::pin!(fut);
    let period = limit.unwrap_or(Duration::from_secs(86400 * 365));
    let mut warned = false;
    let sleep = tokio::time::sleep(period);
    tokio::pin!(sleep);
    loop {
        tokio::select! {biased;
            changed = cancel.changed() => { if changed.is_ok() && *cancel.borrow() { return Drive::Cancelled } }
            Some(event) = rx.recv() => {
                if warned { warned = false; on_stall(Stall::Cleared) }
                on_event(event);
                sleep.as_mut().reset(tokio::time::Instant::now() + period);
            }
            result = &mut fut => {
                while let Ok(event) = rx.try_recv() { on_event(event) }
                return Drive::Done(result);
            }
            _ = wait.notified(), if limit.is_some() => {
                sleep.as_mut().reset(tokio::time::Instant::now() + period);
            }
            _ = &mut sleep, if limit.is_some() => {
                if warned { return Drive::Stalled(period.as_secs() * 2) }
                warned = true;
                on_stall(Stall::Warned(period.as_secs()));
                sleep.as_mut().reset(tokio::time::Instant::now() + period);
            }
        }
    }
}

/// Typed reason for a failed run, shown by the interface next to the retry actions.
pub(crate) fn classify(message: &str) -> &'static str {
    let m = message.to_lowercase();
    if m.contains("429") || m.contains("rate limit") || m.contains("quota") {
        "rate_limit"
    } else if m.contains("401") || m.contains("403") || m.contains("api key") || m.contains("unauthorized") || m.contains("login") {
        "auth"
    } else if m.contains("timed out") || m.contains("timeout") || m.contains("connect") || m.contains("network") || m.contains("dns") || m.contains("error sending request") {
        "network"
    } else if m.contains("context") && (m.contains("length") || m.contains("window") || m.contains("overflow") || m.contains("too long")) {
        "context"
    } else if m.contains("does not support tool") {
        "model"
    } else if m.contains("пустой ответ") || m.contains("empty") {
        "empty"
    } else {
        "error"
    }
}

/// `true` when the learner's last message has not been answered at all (no assistant text, no tool
/// result after it): only then is a plain re-send safe and never replays a tool.
pub(crate) fn can_retry(messages: &Value) -> bool {
    messages
        .as_array()
        .and_then(|m| m.last())
        .is_some_and(|m| m["role"] == "user")
}

pub(crate) fn failure_event(message: String, messages: &Value) -> Value {
    let code = classify(&message);
    json!({"type":"notice","text":message,"error":true,"code":code,"can_retry":can_retry(messages)})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn channels() -> (mpsc::UnboundedSender<Value>, mpsc::UnboundedReceiver<Value>, watch::Sender<bool>, watch::Receiver<bool>,
    ) {
        let (tx, rx) = mpsc::unbounded_channel();
        let (ctx, crx) = watch::channel(false);
        (tx, rx, ctx, crx)
    }

    #[test]
    fn limit_reads_settings() {
        assert_eq!(stall_limit(&json!({})), Some(Duration::from_secs(120)));
        assert_eq!(stall_limit(&json!({"stall_timeout_s":0})), None);
        assert_eq!(stall_limit(&json!({"stall_timeout_s":1})), Some(Duration::from_secs(5)));
        assert_eq!(stall_limit(&json!({"stall_timeout_s":"x"})), Some(Duration::from_secs(120)));
    }

    #[tokio::test]
    async fn hanging_provider_is_warned_then_aborted() {
        let (_tx, mut rx, _c, mut crx) = channels();
        let wait = Notify::new();
        let warned = AtomicUsize::new(0);
        let out = drive(std::future::pending::<()>(), &mut rx, &mut crx, Some(Duration::from_millis(100)), &wait, |_| {}, |s| {
            if let Stall::Warned(_) = s { warned.fetch_add(1, Ordering::SeqCst); }
        },
        )
        .await;
        assert!(matches!(out, Drive::Stalled(_)));
        assert_eq!(warned.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn wait_extends_and_events_reset() {
        let (tx, mut rx, _c, mut crx) = channels();
        let wait = std::sync::Arc::new(Notify::new());
        let w = wait.clone();
        let seen = AtomicUsize::new(0);
        let cleared = AtomicUsize::new(0);
        let helper = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(130)).await; // after the warning
            tx.send(json!({"type":"text_delta"})).unwrap(); // activity returns
            tokio::time::sleep(Duration::from_millis(80)).await;
            w.notify_one();
            tx
        });
        let fut = async { tokio::time::sleep(Duration::from_millis(250)).await; 7 };
        let out = drive(fut, &mut rx, &mut crx, Some(Duration::from_millis(100)), &wait, |_| { seen.fetch_add(1, Ordering::SeqCst); }, |s| {
            if matches!(s, Stall::Cleared) { cleared.fetch_add(1, Ordering::SeqCst); }
        },
        )
        .await;
        assert!(matches!(out, Drive::Done(7)));
        assert_eq!(seen.load(Ordering::SeqCst), 1);
        assert_eq!(cleared.load(Ordering::SeqCst), 1);
        drop(helper.await);
    }

    #[tokio::test]
    async fn abort_mid_stream_keeps_events_and_stops() {
        let (tx, mut rx, c, mut crx) = channels();
        let wait = Notify::new();
        tx.send(json!({"delta":"a"})).unwrap();
        let mut got = vec![];
        let canceller = tokio::spawn(async move { tokio::time::sleep(Duration::from_millis(10)).await; c.send(true).unwrap(); c });
        let out = drive(std::future::pending::<()>(), &mut rx, &mut crx, Some(Duration::from_secs(60)), &wait, |e| got.push(e), |_| {},
        ).await;
        assert!(matches!(out, Drive::Cancelled));
        assert_eq!(got.len(), 1);
        drop(canceller.await);
    }

    #[tokio::test]
    async fn disabled_watchdog_never_fires() {
        let (_tx, mut rx, _c, mut crx) = channels();
        let wait = Notify::new();
        let fut = async { tokio::time::sleep(Duration::from_millis(200)).await; 1 };
        let out = drive(fut, &mut rx, &mut crx, None, &wait, |_| {}, |_| panic!("no stall"),
        ).await;
        assert!(matches!(out, Drive::Done(1)));
    }

    #[test]
    fn retry_only_before_the_reply_started() {
        assert!(can_retry(&json!([{"role":"assistant"},{"role":"user"}])));
        assert!(!can_retry(&json!([{"role":"user"},{"role":"assistant"}])));
        assert!(!can_retry(&json!([{"role":"user"},{"role":"assistant"},{"role":"tool"}])));
        assert!(!can_retry(&json!([])));
        assert_eq!(classify("HTTP 429 rate limit"), "rate_limit");
        assert_eq!(failure_event("boom".into(), &json!([{"role":"user"}]))["can_retry"], true);
    }
}
