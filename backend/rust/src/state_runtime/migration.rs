use super::journal::{private_open, text};
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader},
    path::Path,
};
/// Remove only unlocked version-one legacy histories; never follow symlinks.
pub fn dispatch(d: Value) -> Result<Value, String> {
    let root = text(&d, "store_dir");
    if root.is_empty() {
        return Err("Missing store_dir".into());
    }
    let folder = Path::new(root).join("sessions");
    if folder.is_symlink() || !folder.exists() {
        return Ok(json!({"removed":0,"skipped":[]}));
    }
    let mut removed = 0;
    let mut skipped = Vec::new();
    for group in fs::read_dir(folder).map_err(|e| e.to_string())? {
        let group = group.map_err(|e| e.to_string())?.path();
        if group.is_symlink() || !group.is_dir() {
            continue;
        }
        for entry in fs::read_dir(&group).map_err(|e| e.to_string())? {
            let p = entry.map_err(|e| e.to_string())?.path();
            if p.is_symlink() || p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            let perform = (|| -> Result<bool, String> {
                let lock = private_open()
                    .write(true)
                    .create(true)
                    .open(format!("{}.lock", p.display()))
                    .map_err(|e| e.to_string())?;
                lock.try_lock_exclusive()
                    .map_err(|_| "This session is open in another process".to_string())?;
                let mut line = String::new();
                BufReader::new(fs::File::open(&p).map_err(|e| e.to_string())?)
                    .read_line(&mut line)
                    .map_err(|e| e.to_string())?;
                let header: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
                if header["type"] != "header" || header["version"] != 1 {
                    return Ok(false);
                }
                fs::remove_file(&p).map_err(|e| e.to_string())?;
                let prefix = format!(
                    "{}.damaged-",
                    p.file_stem().unwrap_or_default().to_string_lossy()
                );
                for e in fs::read_dir(&group).map_err(|e| e.to_string())? {
                    let path = e.map_err(|e| e.to_string())?.path();
                    if !path.is_symlink()
                        && path
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .starts_with(&prefix)
                    {
                        fs::remove_file(path).map_err(|e| e.to_string())?;
                    }
                }
                Ok(true)
            })();
            match perform {
                Ok(true) => removed += 1,
                Ok(false) => (),
                Err(e) => skipped.push(json!({"path":p.to_string_lossy(),"reason":e})),
            }
        }
    }
    Ok(json!({"removed":removed,"skipped":skipped}))
}
