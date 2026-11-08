#!/usr/bin/env python3
"""Stdlib-only text extractor for documents the learning agent is given.

Usage: office_text.py PATH [EXT]
Prints plain text to stdout. Exit 0 = ok; exit 2 = actionable message on stderr
(unsupported/legacy/damaged format). Format is detected from magic bytes first,
the extension (EXT or PATH's suffix) second.

Supported: txt md csv tsv json tex html htm xml rtf docx xlsx pptx odt ods odp
epub fb2 fb2.zip, pdf (via pdftotext when present), zip (listing).
"""
import io
import os
import re
import shutil
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

MAX_MEMBER = 40 * 1024 * 1024
MAX_OUT = 2_000_000
MAX_ROWS = 200
MAX_COLS = 60
PLAIN = {"txt", "md", "markdown", "csv", "tsv", "json", "tex", "log", "rst", "yaml", "yml", "ini", "srt", "latex", "bib"}


class Unsupported(Exception):
    pass


def local(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def member(z, name):
    info = z.getinfo(name)
    if info.file_size > MAX_MEMBER:
        raise Unsupported(f"Part {name} is too large to read safely; extract it with unzip and process it with bash")
    return z.read(name)


def decode(data, hint=None):
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", "replace")
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return data.decode("utf-16", "replace")
    if hint:
        try:
            return data.decode(hint)
        except (LookupError, UnicodeDecodeError):
            pass
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        pass
    try:
        return data.decode("cp1251")
    except UnicodeDecodeError:
        return data.decode("cp1252", "replace")


def parse(data):
    try:
        return ET.fromstring(data)
    except ET.ParseError as e:
        raise Unsupported(f"The document XML is damaged: {e}")


class _Html(HTMLParser):
    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "table", "ul", "ol", "blockquote", "pre", "title"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        if tag in self.BLOCK:
            self.out.append("\n")
        if tag in ("td", "th"):
            self.out.append("\t")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip = max(0, self.skip - 1)
        if tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, d):
        if not self.skip:
            self.out.append(d)


def html_text(data):
    head = data[:4096].decode("ascii", "ignore")
    m = re.search(r"charset\s*=\s*[\"']?\s*([\w.:-]+)", head, re.I)
    p = _Html()
    p.feed(decode(data, m.group(1) if m else None))
    return tidy("".join(p.out))


def tidy(s):
    s = s.replace("\r\n", "\n").replace("\r", "\n").replace("\xa0", " ")
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip() + "\n"


# ---- OOXML -------------------------------------------------------------
def ooxml_para(p):
    out = []
    for e in p.iter():
        n = local(e.tag)
        if n in ("t", "delText") and e.text:
            out.append(e.text)
        elif n == "tab":
            out.append("\t")
        elif n in ("br", "cr"):
            out.append("\n")
    return "".join(out)


def docx(z):
    names = z.namelist()
    if "word/document.xml" not in names:
        raise Unsupported("No word/document.xml: not a valid .docx")
    root = parse(member(z, "word/document.xml"))
    body = next((c for c in root if local(c.tag) == "body"), root)
    out = []

    def walk(parent):
        for c in parent:
            n = local(c.tag)
            if n == "p":
                t = ooxml_para(c)
                style = ""
                for s in c.iter():
                    if local(s.tag) == "pStyle":
                        style = next(iter(s.attrib.values()), "")
                m = re.match(r"(?i)heading\s*(\d)", style)
                out.append(("#" * int(m.group(1)) + " " if m and t.strip() else "") + t)
            elif n == "tbl":
                for tr in c:
                    if local(tr.tag) == "tr":
                        cells = []
                        for tc in tr:
                            if local(tc.tag) == "tc":
                                cells.append(" ".join(ooxml_para(p) for p in tc.iter() if local(p.tag) == "p").strip())
                        out.append("\t".join(cells))
                out.append("")
            elif n in ("sdt", "sdtContent", "customXml", "ins", "smartTag"):
                walk(c)

    walk(body)
    for extra, title in (("word/footnotes.xml", "Footnotes"), ("word/endnotes.xml", "Endnotes")):
        if extra in names:
            notes = [ooxml_para(p) for p in parse(member(z, extra)).iter() if local(p.tag) == "p"]
            notes = [x for x in notes if x.strip()]
            if notes:
                out += ["", f"[{title}]"] + notes
    return "\n".join(out)


def col_index(ref):
    letters = re.match(r"[A-Za-z]+", ref or "")
    if not letters:
        return None
    n = 0
    for ch in letters.group(0).upper():
        n = n * 26 + ord(ch) - 64
    return n - 1


def xlsx(z):
    names = z.namelist()
    shared = []
    if "xl/sharedStrings.xml" in names:
        for si in parse(member(z, "xl/sharedStrings.xml")):
            shared.append("".join(t.text or "" for t in si.iter() if local(t.tag) == "t"))
    sheets = []
    rels = {}
    if "xl/_rels/workbook.xml.rels" in names:
        for r in parse(member(z, "xl/_rels/workbook.xml.rels")):
            rels[r.get("Id")] = r.get("Target", "")
    if "xl/workbook.xml" in names:
        for s in parse(member(z, "xl/workbook.xml")).iter():
            if local(s.tag) == "sheet":
                rid = next((v for k, v in s.attrib.items() if k.endswith("}id")), None)
                target = rels.get(rid, "")
                target = target.lstrip("/")
                if not target.startswith("xl/"):
                    target = "xl/" + target
                sheets.append((s.get("name", "Sheet"), target))
    if not sheets:
        sheets = [(n, n) for n in sorted(x for x in names if re.match(r"xl/worksheets/sheet\d+\.xml$", x))]
    out = []
    for name, target in sheets:
        if target not in names:
            continue
        out.append(f"## Sheet: {name}")
        count = 0
        total = 0
        for _, row in ET.iterparse(io.BytesIO(member(z, target)), events=("end",)):
            if local(row.tag) != "row":
                continue
            total += 1
            if count >= MAX_ROWS:
                row.clear()
                continue
            cells = {}
            nxt = 0
            for c in row:
                if local(c.tag) != "c":
                    continue
                idx = col_index(c.get("r"))
                idx = nxt if idx is None else idx
                nxt = idx + 1
                t = c.get("t")
                v = next((x for x in c if local(x.tag) == "v"), None)
                if t == "inlineStr":
                    val = "".join(x.text or "" for x in c.iter() if local(x.tag) == "t")
                elif v is None or v.text is None:
                    val = ""
                elif t == "s":
                    try:
                        val = shared[int(v.text)]
                    except (ValueError, IndexError):
                        val = ""
                elif t == "b":
                    val = "TRUE" if v.text == "1" else "FALSE"
                else:
                    val = v.text
                if idx < MAX_COLS:
                    cells[idx] = val.replace("\t", " ").replace("\n", " ")
            if cells:
                line = "\t".join(cells.get(i, "") for i in range(max(cells) + 1)).rstrip("\t")
                if line:
                    out.append(line)
                    count += 1
            row.clear()
        if total > count:
            out.append(f"[Truncated: showing first {count} of {total} rows of sheet '{name}'; read the rest with bash/unzip]")
        out.append("")
    if len(out) <= len(sheets) * 2 and not any(x for x in out if not x.startswith("##") and x):
        out.append("[No cell values found; formulas without cached values are not evaluated]")
    return "\n".join(out)


def pptx(z):
    names = z.namelist()
    num = lambda n: int(re.search(r"(\d+)\.xml$", n).group(1))
    slides = sorted((n for n in names if re.match(r"ppt/slides/slide\d+\.xml$", n)), key=num)
    if not slides:
        raise Unsupported("No slides found: not a valid .pptx")
    out = []
    for i, s in enumerate(slides, 1):
        out.append(f"## Slide {i}")
        for p in parse(member(z, s)).iter():
            if local(p.tag) == "p":
                t = "".join(x.text or "" for x in p.iter() if local(x.tag) == "t")
                if t.strip():
                    out.append(t)
        note = f"ppt/notesSlides/notesSlide{num(s)}.xml"
        if note in names:
            nt = []
            for p in parse(member(z, note)).iter():
                if local(p.tag) == "p":
                    t = "".join(x.text or "" for x in p.iter() if local(x.tag) == "t")
                    if t.strip() and not t.strip().isdigit():
                        nt.append(t)
            if nt:
                out.append("[Notes] " + " ".join(nt))
        out.append("")
    return "\n".join(out)


# ---- OpenDocument -------------------------------------------------------
def odf(z):
    root = parse(member(z, "content.xml"))
    out = []

    def inline(e):
        s = [e.text or ""]
        for c in e:
            n = local(c.tag)
            if n == "tab":
                s.append("\t")
            elif n == "line-break":
                s.append("\n")
            elif n == "s":
                s.append(" " * min(int(c.get(next((k for k in c.attrib if k.endswith("}c")), ""), "1") or 1), 50))
            elif n in ("note",):
                pass
            else:
                s.append(inline(c))
            s.append(c.tail or "")
        return "".join(s)

    def walk(e):
        for c in e:
            n = local(c.tag)
            if n == "h":
                out.append("# " + inline(c))
            elif n == "p":
                out.append(inline(c))
            elif n == "table":
                tname = next((v for k, v in c.attrib.items() if k.endswith("}name")), "")
                out.append(f"## Table: {tname}")
                rows = 0
                for tr in c.iter():
                    if local(tr.tag) != "table-row":
                        continue
                    if rows >= MAX_ROWS:
                        out.append(f"[Truncated: first {MAX_ROWS} rows shown]")
                        break
                    cells = []
                    for tc in tr:
                        if local(tc.tag) in ("table-cell", "covered-table-cell"):
                            txt = " ".join(inline(p) for p in tc if local(p.tag) in ("p", "h")).strip()
                            rep = next((int(v) for k, v in tc.attrib.items() if k.endswith("}number-columns-repeated")), 1)
                            cells += [txt] * (rep if txt else min(rep, 1))
                    line = "\t".join(x.replace("\n", " ") for x in cells[:MAX_COLS]).rstrip("\t")
                    if line:
                        out.append(line)
                        rows += 1
                out.append("")
            elif n == "page":
                out.append(f"## Slide {sum(1 for x in out if x.startswith('## Slide')) + 1}")
                walk(c)
            elif n in ("list", "list-item", "section", "body", "text", "spreadsheet", "presentation", "frame", "text-box", "span", "a", "list-header", "table-of-content", "index-body"):
                walk(c)
            elif n in ("document-content", "office"):
                walk(c)

    walk(root)
    return "\n".join(out)


# ---- ebooks -------------------------------------------------------------
def epub(z):
    names = z.namelist()
    order = []
    try:
        cont = parse(member(z, "META-INF/container.xml"))
        opf_path = next(e.get("full-path") for e in cont.iter() if local(e.tag) == "rootfile")
        opf = parse(member(z, opf_path))
        base = opf_path.rsplit("/", 1)[0] + "/" if "/" in opf_path else ""
        manifest = {e.get("id"): e.get("href") for e in opf.iter() if local(e.tag) == "item"}
        from urllib.parse import unquote
        for e in opf.iter():
            if local(e.tag) == "itemref" and e.get("idref") in manifest:
                order.append(unquote(base + manifest[e.get("idref")]))
    except Exception:
        pass
    order = [n for n in order if n in names]
    if not order:
        order = sorted(n for n in names if n.lower().endswith((".xhtml", ".html", ".htm")))
    if not order:
        raise Unsupported("No readable chapters found in this EPUB")
    parts = []
    for n in order:
        t = html_text(member(z, n))
        if t.strip():
            parts.append(t)
    return "\n".join(parts)


def fb2_text(data):
    root = parse(data)
    out = []

    def title_of(e):
        return " ".join(("".join(x.itertext())).strip() for x in e if local(x.tag) in ("p",)).strip()

    def walk(e, depth):
        for c in e:
            n = local(c.tag)
            if n == "title":
                out.append("\n" + "#" * min(depth, 4) + " " + title_of(c))
            elif n in ("p", "v", "subtitle", "text-author"):
                out.append("".join(c.itertext()))
            elif n == "empty-line":
                out.append("")
            elif n in ("section", "body", "poem", "stanza", "cite", "epigraph"):
                walk(c, depth + 1 if n == "section" else depth)

    for info in root:
        if local(info.tag) == "description":
            ti = next((x for x in info.iter() if local(x.tag) == "book-title"), None)
            if ti is not None and ti.text:
                out.append("# " + ti.text.strip())
    for body in root:
        if local(body.tag) == "body":
            walk(body, 1)
    return "\n".join(out)


# ---- RTF ----------------------------------------------------------------
def rtf(data):
    text = data.decode("latin-1")
    m = re.search(r"\\ansicpg(\d+)", text)
    cp = "cp" + m.group(1) if m else "cp1252"
    try:
        "".encode(cp)
    except LookupError:
        cp = "cp1252"
    skip_dest = {"fonttbl", "colortbl", "stylesheet", "info", "pict", "header", "footer", "headerl", "headerr", "footerl", "footerr", "themedata", "colorschememapping", "latentstyles", "datastore", "listtable", "listoverridetable", "rsidtbl", "generator", "xmlnstbl", "object", "fldinst", "bkmkstart", "bkmkend"}
    out = []
    stack = []
    skipping = 0
    ignorable = False
    i, n = 0, len(text)
    uc = 1
    pending = bytearray()

    def flush():
        if pending:
            out.append(pending.decode(cp, "replace"))
            pending.clear()

    while i < n:
        ch = text[i]
        if ch == "{":
            stack.append((skipping, uc))
            if skipping:
                skipping += 1
            ignorable = True
            i += 1
        elif ch == "}":
            flush()
            if stack:
                skipping, uc = stack.pop()
            ignorable = False
            i += 1
        elif ch == "\\":
            i += 1
            if i >= n:
                break
            c = text[i]
            if c == "'":
                if not skipping:
                    try:
                        pending.append(int(text[i + 1:i + 3], 16))
                    except ValueError:
                        pass
                i += 3
                continue
            flush()
            if c in "\\{}":
                if not skipping:
                    out.append(c)
                i += 1
            elif c == "*":
                if ignorable:
                    skipping = skipping or 1
                i += 1
            elif c in "~":
                out.append(" " if not skipping else "")
                i += 1
            elif c.isalpha():
                m = re.compile(r"([a-zA-Z]+)(-?\d+)? ?").match(text, i)
                word, arg = m.group(1), m.group(2)
                i = m.end()
                if word in skip_dest and ignorable:
                    skipping = skipping or 1
                if skipping:
                    ignorable = False
                    continue
                if word in ("par", "line", "row", "sect", "page"):
                    out.append("\n")
                elif word in ("tab", "cell"):
                    out.append("\t")
                elif word == "u" and arg:
                    v = int(arg)
                    out.append(chr(v + 65536 if v < 0 else v))
                    for _ in range(uc):  # skip the ASCII fallback character(s)
                        if text[i:i + 2] == "\\'":
                            i += 4
                        elif i < n and text[i] not in "\\{}":
                            i += 1
                elif word == "uc" and arg:
                    uc = int(arg)
                elif word == "emdash":
                    out.append("\u2014")
                elif word == "endash":
                    out.append("\u2013")
            else:
                i += 1
            ignorable = False
        elif ch in "\r\n":
            i += 1
        else:
            if not skipping:
                flush()
                out.append(ch)
            i += 1
    flush()
    return tidy("".join(out))


# ---- dispatch ------------------------------------------------------------
LEGACY = {
    "doc": "Word 97-2003 (.doc)",
    "xls": "Excel 97-2003 (.xls)",
    "ppt": "PowerPoint 97-2003 (.ppt)",
}


def zip_kind(z, ext):
    names = z.namelist()
    if "mimetype" in names:
        mt = z.read("mimetype")[:100].decode("ascii", "ignore")
        if "epub" in mt:
            return "epub"
        if "opendocument.text" in mt:
            return "odt"
        if "opendocument.spreadsheet" in mt:
            return "ods"
        if "opendocument.presentation" in mt:
            return "odp"
        if "opendocument" in mt:
            return "odt"
    if "[Content_Types].xml" in names:
        if "word/document.xml" in names:
            return "docx"
        if "xl/workbook.xml" in names:
            return "xlsx"
        if any(n.startswith("ppt/slides/") for n in names):
            return "pptx"
    if "META-INF/container.xml" in names:
        return "epub"
    if any(n.lower().endswith(".fb2") for n in names):
        return "fb2.zip"
    return "zip"


def extract(path, ext=None):
    with open(path, "rb") as f:
        data = f.read(60 * 1024 * 1024)
    ext = (ext or os.path.splitext(path)[1].lstrip(".")).lower()
    if path.lower().endswith(".fb2.zip"):
        ext = "fb2.zip"
    if data.startswith(b"%PDF"):
        exe = shutil.which("pdftotext")
        if not exe:
            raise Unsupported("PDF extraction needs pdftotext (poppler-utils), which is not installed")
        r = subprocess.run([exe, "-layout", "-enc", "UTF-8", path, "-"], capture_output=True, timeout=30)
        if r.returncode != 0:
            raise Unsupported("pdftotext could not read this PDF (damaged or encrypted)")
        t = r.stdout.decode("utf-8", "replace")
        if not t.strip():
            raise Unsupported("PDF has no text layer (probably a scan); OCR is not available here. Ask for a text version or a photo of the page")
        return t
    if data.startswith(b"\xd0\xcf\x11\xe0"):
        kind = LEGACY.get(ext, "legacy Microsoft Office binary")
        raise Unsupported(f"{kind} is an old binary format that cannot be read here. Ask the user to re-save it as .docx/.xlsx/.pptx (or PDF) and upload it again.")
    if data.startswith(b"AT&TFORM"):
        exe = shutil.which("djvutxt")
        if exe:
            r = subprocess.run([exe, path], capture_output=True, timeout=60)
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout.decode("utf-8", "replace")
        raise Unsupported("DjVu is not readable here (no DjVu tools, usually a scan without text). Ask the user to export it to PDF or upload photos of the pages.")
    if zipfile.is_zipfile(io.BytesIO(data)):
        try:
            z = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile:
            raise Unsupported("The archive is damaged")
        kind = zip_kind(z, ext)
        if kind == "docx":
            return docx(z)
        if kind == "xlsx":
            return xlsx(z)
        if kind == "pptx":
            return pptx(z)
        if kind in ("odt", "ods", "odp"):
            return odf(z)
        if kind == "epub":
            return epub(z)
        if kind == "fb2.zip":
            name = next(n for n in z.namelist() if n.lower().endswith(".fb2"))
            return fb2_text(member(z, name))
        infos = z.infolist()
        lines = [f"ZIP archive, {len(infos)} entries (extract with: unzip -d DIR FILE, then read files):"]
        lines += [f"{i.file_size:>10}  {i.filename}" for i in infos[:500]]
        if len(infos) > 500:
            lines.append(f"[Truncated: {len(infos) - 500} more entries]")
        return "\n".join(lines)
    head = data[:2000].lstrip()
    if data.startswith(b"{\\rtf"):
        return rtf(data)
    if ext == "fb2" or b"<FictionBook" in data[:3000]:
        return fb2_text(data)
    if ext in ("html", "htm", "xhtml") or head[:15].lower().startswith((b"<!doctype html", b"<html")):
        return html_text(data)
    if b"\x00" in data[:4096] and data[:2] not in (b"\xff\xfe", b"\xfe\xff"):
        raise Unsupported(f"Binary file (.{ext or 'unknown'}) is not readable as text; use bash tools or ask for another format")
    return decode(data)


def main():
    if len(sys.argv) < 2:
        print("usage: office_text.py PATH [EXT]", file=sys.stderr)
        return 64
    try:
        text = extract(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
    except Unsupported as e:
        print(str(e), file=sys.stderr)
        return 2
    except subprocess.TimeoutExpired:
        print("Extraction timed out", file=sys.stderr)
        return 2
    except Exception as e:  # damaged files must give a message, not a traceback
        print(f"Cannot read this file ({type(e).__name__}: {e}). It may be damaged.", file=sys.stderr)
        return 2
    if len(text) > MAX_OUT:
        text = text[:MAX_OUT] + f"\n[Truncated at {MAX_OUT} characters]\n"
    if not text.strip():
        print("The document contains no extractable text", file=sys.stderr)
        return 2
    sys.stdout.buffer.write(text.encode("utf-8", "replace"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
