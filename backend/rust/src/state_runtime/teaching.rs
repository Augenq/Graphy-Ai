//! Teacher / student role: a local setting, not an account.
//! Storage: `<store>/learning/teaching/role.json`.
use super::journal::{mkdir, private_open, text};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

fn base(d: &Value) -> Result<PathBuf, String> {
    let r = text(d, "store_dir");
    if r.is_empty() {
        return Err("Missing store_dir".into());
    }
    Ok(Path::new(r).join("learning/teaching"))
}
fn write_file(p: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = p.parent().ok_or("Invalid path")?;
    mkdir(parent)?;
    let tmp = parent.join(format!(".graphy-{}", Uuid::new_v4().simple()));
    let result = (|| {
        let mut f = private_open().write(true).create_new(true).open(&tmp).map_err(|e| e.to_string())?;
        f.write_all(bytes).and_then(|_| f.sync_all()).map_err(|e| e.to_string())?;
        fs::rename(&tmp, p).map_err(|e| e.to_string())
    })();
    if tmp.exists() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(p).ok()?).ok()
}
pub fn is_teacher(d: &Value) -> bool {
    base(d)
        .ok()
        .and_then(|b| read_json(&b.join("role.json")))
        .is_some_and(|v| v["teacher"] == true)
}

pub fn dispatch(op: &str, d: Value) -> Result<Value, String> {
    match op {
        "teaching.role.get" => Ok(json!({"teacher":is_teacher(&d)})),
        "teaching.role.set" => {
            let on = d["teacher"].as_bool().ok_or("teacher должно быть true или false")?;
            write_file(&base(&d)?.join("role.json"), json!({"teacher":on}).to_string().as_bytes())?;
            Ok(json!({"teacher":on}))
        }
        _ => Err("Unknown teaching operation".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn role_defaults_to_student_and_persists() {
        let t = tempfile::tempdir().unwrap();
        let d = json!({"store_dir":t.path().to_string_lossy()});
        assert_eq!(dispatch("teaching.role.get", d.clone()).unwrap()["teacher"], false);
        let mut on = d.clone();
        on["teacher"] = json!(true);
        dispatch("teaching.role.set", on).unwrap();
        assert!(is_teacher(&d));
        assert!(dispatch("teaching.role.set", d.clone()).is_err());
    }
}
