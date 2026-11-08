#!/usr/bin/env python3
"""Rebuilds src/assets/fonts/material-symbols-subset.woff2 from the full material-symbols font, keeping only the icon names that appear in src/.

Requirements (the woff2 container cannot be read by fontTools without the brotli module, so the binaries do that step):
  - python3 with fontTools (pip install fonttools; Arch: python-fonttools)
  - woff2_compress and woff2_decompress on PATH (Arch: woff2; Debian: woff2)
Run from frontend/:  python3 scripts/subset-material-symbols.py
Scratch files go to $TMPDIR if set, otherwise node_modules/.cache (never /tmp, which may be a small tmpfs); they are removed afterwards."""
import os, re, shutil, subprocess, tempfile
from fontTools.ttLib import TTFont
from fontTools import subset

FULL = "node_modules/material-symbols/material-symbols-outlined.woff2"
OUT = "src/assets/fonts/material-symbols-subset.woff2"
scratch = os.environ.get("TMPDIR") or os.path.join("node_modules", ".cache")
os.makedirs(scratch, exist_ok=True)
tmp = tempfile.mkdtemp(dir=scratch)
subprocess.run(["cp", FULL, f"{tmp}/full.woff2"], check=True)
subprocess.run(["woff2_decompress", f"{tmp}/full.woff2"], check=True)
tokens = set()
for base in ["src", "index.html", "max-preview.html"]:
    paths = [base] if os.path.isfile(base) else [os.path.join(d, f) for d, _, fs in os.walk(base) for f in fs if f.endswith((".ts", ".tsx", ".css", ".html"))]
    for p in paths:
        tokens |= set(re.findall(r"[a-z][a-z0-9_]*", open(p, encoding="utf8").read()))
font = TTFont(f"{tmp}/full.ttf")
rev = {v: k for k, v in font.getBestCmap().items()}
for lookup in font["GSUB"].table.LookupList.Lookup:
    for st in lookup.SubTable:
        st = getattr(st, "ExtSubTable", st)
        if hasattr(st, "ligatures"):
            for first in list(st.ligatures):
                keep = [lg for lg in st.ligatures[first] if "".join(chr(rev[g]) for g in (first, *lg.Component)) in tokens]
                if keep: st.ligatures[first] = keep
                else: del st.ligatures[first]
font.save(f"{tmp}/trim.ttf")
opts = subset.Options()
opts.layout_features = ["liga", "calt", "rlig", "ccmp", "locl", "mark", "mkmk", "kern"]
opts.notdef_outline = True
ft = subset.load_font(f"{tmp}/trim.ttf", opts)
s = subset.Subsetter(opts)
s.populate(unicodes=list(range(0x61, 0x7B)) + list(range(0x30, 0x3A)) + [0x5F])
s.subset(ft)
subset.save_font(ft, f"{tmp}/subset.ttf", opts)
subprocess.run(["woff2_compress", f"{tmp}/subset.ttf"], check=True)
subprocess.run(["cp", f"{tmp}/subset.woff2", OUT], check=True)
print("wrote", OUT, os.path.getsize(OUT), "bytes")
shutil.rmtree(tmp, ignore_errors=True)
