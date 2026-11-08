//! Graphy's portable agent core. Host applications own I/O and execute core decisions.
//! Requests: {"version":1,"op":"...","data":{...}}.
//! Responses: {"ok":true,"value":...} or {"ok":false,"error":"..."}.
//! Each non-null result is owned by the caller and must be freed exactly once.
use serde_json::{json, Value};
use std::ffi::{c_char, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};

pub(crate) fn py_trim(text: &str) -> &str {
    text.trim_matches(|ch: char| ch.is_whitespace() || matches!(ch, '\u{1c}'..='\u{1f}'))
}

pub mod agent;
pub mod backend_runtime;
pub mod context;
pub mod doc_text;
pub mod provider_runtime;
pub mod providers;
pub mod questions;
mod researcher;
mod runtime_agent;
mod runtime_tools;
mod runtime_watchdog;
pub mod state_runtime;

pub fn dispatch(op: &str, data: Value) -> Result<Value, String> {
    if let Some(operation) = op.strip_prefix("state.") {
        return state_runtime::dispatch(operation, data);
    }
    if op == "health" {
        return Ok(json!({"abi": 1, "version": env!("CARGO_PKG_VERSION"), "engine": "rust"}));
    }
    if op.starts_with("agent.") {
        return agent::dispatch(op, data);
    }
    if op.starts_with("context.") {
        return context::dispatch(op, data);
    }
    if op.starts_with("providers.") {
        return providers::dispatch(op, data);
    }
    if op.starts_with("questions.") {
        return questions::dispatch(op, data);
    }
    Err(format!("Unknown core operation: {op}"))
}

fn request(input: &str) -> Result<Value, String> {
    let request: Value = serde_json::from_str(input).map_err(|e| e.to_string())?;
    if request["version"].as_u64() != Some(1) {
        return Err("Unsupported core ABI version".into());
    }
    let op = request["op"].as_str().ok_or("Missing core operation")?;
    dispatch(op, request.get("data").cloned().unwrap_or(Value::Null))
}

#[no_mangle]
pub extern "C" fn graphy_core_abi_version() -> u32 {
    1
}

/// # Safety
/// `input` must be null or a live NUL-terminated UTF-8 string for this call.
#[no_mangle]
pub unsafe extern "C" fn graphy_core_call(input: *const c_char) -> *mut c_char {
    let result = catch_unwind(AssertUnwindSafe(|| {
        if input.is_null() {
            return Err("Null request".to_owned());
        }
        let input = unsafe { CStr::from_ptr(input) }
            .to_str()
            .map_err(|e| e.to_string())?;
        request(input)
    }));
    let response = match result {
        Ok(Ok(value)) => json!({"ok": true, "value": value}),
        Ok(Err(error)) => json!({"ok": false, "error": error}),
        Err(_) => json!({"ok": false, "error": "Core operation panicked"}),
    };
    CString::new(response.to_string())
        .expect("JSON escapes NUL")
        .into_raw()
}

/// # Safety
/// `output` must be null or an unfreed pointer returned by graphy_core_call.
#[no_mangle]
pub unsafe extern "C" fn graphy_core_free(output: *mut c_char) {
    if !output.is_null() {
        drop(unsafe { CString::from_raw(output) });
    }
}

/// Run the full backend, blocking until shutdown. `arguments` is a JSON array of CLI strings.
/// # Safety
/// `arguments` must be a live NUL-terminated UTF-8 string during the call.
#[no_mangle]
pub unsafe extern "C" fn graphy_backend_main(arguments: *const c_char) -> i32 {
    let result = catch_unwind(AssertUnwindSafe(|| -> Result<(), String> {
        if arguments.is_null() {
            return Err("Null backend arguments".into());
        }
        let input = unsafe { CStr::from_ptr(arguments) }
            .to_str()
            .map_err(|e| e.to_string())?;
        let args: Vec<String> = serde_json::from_str(input).map_err(|e| e.to_string())?;
        backend_runtime::main_entry(args)
    }));
    match result {
        Ok(Ok(())) => 0,
        Ok(Err(error)) => {
            eprintln!("graphy serve: {error}");
            1
        }
        Err(_) => {
            eprintln!("graphy serve: Rust backend panicked");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ffi_errors_and_lifetime() {
        for input in [
            "{",
            r#"{"version":2,"op":"health"}"#,
            r#"{"version":1,"op":"missing"}"#,
        ] {
            let input = CString::new(input).unwrap();
            unsafe {
                let output = graphy_core_call(input.as_ptr());
                let response: Value =
                    serde_json::from_str(CStr::from_ptr(output).to_str().unwrap()).unwrap();
                assert_eq!(response["ok"], false);
                graphy_core_free(output);
            }
        }
        unsafe {
            let output = graphy_core_call(std::ptr::null());
            assert!(!output.is_null());
            graphy_core_free(output);
            graphy_core_free(std::ptr::null_mut());
        }
        assert_eq!(dispatch("health", Value::Null).unwrap()["abi"], 1);
    }
}
