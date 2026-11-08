//! Text extraction for documents (docx/xlsx/pptx/odf/epub/fb2/rtf/pdf/zip...) through the
//! stdlib-only Python helper `resources/tools/office_text.py` shipped with the app.
use std::path::{Path, PathBuf};

const TIMEOUT_SECS: u64 = 40;

fn helper() -> PathBuf {
    std::env::var_os("GRAPHY_RESOURCE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../graphy"))
        .join("resources/tools/office_text.py")
}

/// Extensions routed to the helper (content is detected by magic bytes first).
pub const DOC_EXTS: &[&str] = &[
    "pdf", "docx", "xlsx", "pptx", "odt", "ods", "odp", "epub", "fb2", "rtf", "zip", "doc", "xls", "ppt", "djvu", "djv",
];
pub fn is_doc_ext(ext: &str) -> bool {
    DOC_EXTS.contains(&ext.to_lowercase().as_str())
}
pub fn ext_of_mime(mime: &str) -> Option<&'static str> {
    Some(match mime {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => "pptx",
        "application/vnd.oasis.opendocument.text" => "odt",
        "application/vnd.oasis.opendocument.spreadsheet" => "ods",
        "application/vnd.oasis.opendocument.presentation" => "odp",
        "application/epub+zip" => "epub",
        "application/x-fictionbook+xml" | "application/x-fictionbook" => "fb2",
        "application/rtf" | "text/rtf" => "rtf",
        "application/zip" | "application/x-zip-compressed" => "zip",
        "application/msword" => "doc",
        "application/vnd.ms-excel" => "xls",
        "application/vnd.ms-powerpoint" => "ppt",
        "image/vnd.djvu" | "image/x-djvu" => "djvu",
        _ => return None,
    })
}

/// Blocking: runs the helper on a file. `Err` is a short actionable message for the model.
pub fn extract_file(path: &Path, ext: &str) -> Result<String, String> {
    let script = helper();
    if !script.is_file() {
        return Err("Document reader is not installed (resources/tools/office_text.py is missing)".into());
    }
    let ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '.').collect();
    let mut child = std::process::Command::new("python3")
        .arg("-I")
        .arg(&script)
        .arg(path)
        .arg(&ext)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "Document reader needs python3, which is not installed".to_owned()
            } else {
                format!("Cannot run the document reader: {e}")
            }
        })?;
    let (mut out, mut err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let o = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = std::io::Read::read_to_end(&mut out, &mut v);
        v
    });
    let e = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = std::io::Read::read_to_end(&mut err, &mut v);
        v
    });
    let start = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if start.elapsed().as_secs() >= TIMEOUT_SECS => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Document reading timed out after {TIMEOUT_SECS} s"));
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(e) => return Err(e.to_string()),
        }
    };
    let out = String::from_utf8_lossy(&o.join().unwrap_or_default()).into_owned();
    let err = String::from_utf8_lossy(&e.join().unwrap_or_default()).trim().to_owned();
    if status.success() {
        Ok(out)
    } else if !err.is_empty() {
        Err(err.chars().take(600).collect())
    } else {
        Err("The document could not be read".into())
    }
}

/// Blocking: same for in-memory bytes (web downloads).
pub fn extract_bytes(bytes: &[u8], ext: &str) -> Result<String, String> {
    let dir = std::env::temp_dir().join(format!("graphy-doc-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
    let input = dir.join(format!("in.{}", if safe.is_empty() { "bin" } else { &safe }));
    let r = std::fs::write(&input, bytes)
        .map_err(|e| e.to_string())
        .and_then(|_| extract_file(&input, &safe));
    let _ = std::fs::remove_dir_all(&dir);
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    fn have_python() -> bool {
        std::process::Command::new("python3").arg("-V").output().is_ok()
    }
    fn zip(files: &[(&str, &str)]) -> Vec<u8> {
        // tiny stored-only zip writer (no deps)
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, body) in files {
            let off = out.len() as u32;
            let crc = {
                let mut c = 0xFFFF_FFFFu32;
                for b in body.bytes() {
                    c ^= b as u32;
                    for _ in 0..8 {
                        c = if c & 1 == 1 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
                    }
                }
                !c
            };
            let hdr = |out: &mut Vec<u8>, sig: u32, central: bool| {
                out.extend(sig.to_le_bytes());
                if central {
                    out.extend(20u16.to_le_bytes());
                }
                out.extend(20u16.to_le_bytes());
                out.extend([0u8; 8]);
                out.extend(crc.to_le_bytes());
                out.extend((body.len() as u32).to_le_bytes());
                out.extend((body.len() as u32).to_le_bytes());
                out.extend((name.len() as u16).to_le_bytes());
                out.extend(0u16.to_le_bytes());
                if central {
                    out.extend([0u8; 10]);
                    out.extend(off.to_le_bytes());
                }
                out.extend(name.bytes());
            };
            hdr(&mut out, 0x0403_4b50, false);
            out.extend(body.bytes());
            hdr(&mut central, 0x0201_4b50, true);
        }
        let cd_off = out.len() as u32;
        let cd_len = central.len() as u32;
        out.extend(central);
        out.extend(0x0605_4b50u32.to_le_bytes());
        out.extend([0u8; 4]);
        out.extend((files.len() as u16).to_le_bytes());
        out.extend((files.len() as u16).to_le_bytes());
        out.extend(cd_len.to_le_bytes());
        out.extend(cd_off.to_le_bytes());
        out.extend(0u16.to_le_bytes());
        out
    }
    #[test]
    fn docx_bytes_are_detected_by_content_even_with_wrong_extension() {
        if !have_python() {
            return;
        }
        let doc = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Теорема Виета</w:t></w:r></w:p></w:body></w:document>"#;
        let bytes = zip(&[("[Content_Types].xml", "<Types/>"), ("word/document.xml", doc)]);
        assert_eq!(extract_bytes(&bytes, "bin").unwrap().trim(), "Теорема Виета");
    }
    #[test]
    fn legacy_and_damaged_files_give_actionable_errors() {
        if !have_python() {
            return;
        }
        let e = extract_bytes(&[0xD0, 0xCF, 0x11, 0xE0, 0, 0, 0, 0], "doc").unwrap_err();
        assert!(e.contains(".docx") && e.contains("upload"), "{e}");
        let e = extract_bytes(&zip(&[("[Content_Types].xml", "<Types/>"), ("word/document.xml", "<bad")]), "docx").unwrap_err();
        assert!(e.contains("damaged"), "{e}");
    }
    #[test]
    fn mime_and_extension_routing() {
        assert!(is_doc_ext("DOCX") && is_doc_ext("fb2") && !is_doc_ext("txt"));
        assert_eq!(ext_of_mime("application/epub+zip"), Some("epub"));
        assert_eq!(ext_of_mime("text/csv"), None);
    }
}
