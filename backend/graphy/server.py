"""Compatibility launcher: the HTTP server and agent run entirely in Rust."""

import json
import os
import sys
from pathlib import Path

from .native import _library


def main(argv=None):
    import ctypes

    os.environ.setdefault("GRAPHY_RESOURCE_DIR", str(Path(__file__).parent))
    library = _library()
    library.graphy_backend_main.argtypes = [ctypes.c_char_p]
    library.graphy_backend_main.restype = ctypes.c_int
    args = sys.argv[1:] if argv is None else argv
    status = library.graphy_backend_main(json.dumps(args, ensure_ascii=False).encode("utf-8"))
    if status:
        raise SystemExit(status)


if __name__ == "__main__":
    main()
