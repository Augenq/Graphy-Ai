"""Small, mandatory binding to the versioned Graphy Rust core (no Python fallback)."""

import ctypes
import json
import os
import sys
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=1)
def _library():
    filename = "graphy_core.dll" if sys.platform == "win32" else (
        "libgraphy_core.dylib" if sys.platform == "darwin" else "libgraphy_core.so")
    path = Path(os.environ["GRAPHY_CORE_LIBRARY"]) if os.environ.get("GRAPHY_CORE_LIBRARY") else (
        Path(__file__).parent / "_native" / filename)
    try:
        lib = ctypes.CDLL(str(path))
    except OSError as exc:
        raise RuntimeError(
            "Graphy Rust core is missing or incompatible. Reinstall graphy-agent or run "
            "'python scripts/build_native.py' from backend (Rust toolchain required)."
        ) from exc
    lib.graphy_core_abi_version.argtypes = []
    lib.graphy_core_abi_version.restype = ctypes.c_uint32
    if lib.graphy_core_abi_version() != 1:
        raise RuntimeError("Incompatible Graphy Rust core ABI; rebuild or reinstall graphy-agent")
    lib.graphy_core_call.argtypes = [ctypes.c_char_p]
    lib.graphy_core_call.restype = ctypes.c_void_p
    lib.graphy_core_free.argtypes = [ctypes.c_void_p]
    lib.graphy_core_free.restype = None
    return lib


def invoke(operation, data=None):
    """Execute a core operation and release its owned response even on decoding errors."""
    request = json.dumps({"version": 1, "op": operation, "data": data}, ensure_ascii=False, allow_nan=False,
                         separators=(",", ":"))
    lib = _library()
    pointer = lib.graphy_core_call(request.encode("utf-8"))
    if not pointer:
        raise RuntimeError("Graphy Rust core returned no response")
    try:
        response = json.loads(ctypes.string_at(pointer))
    finally:
        lib.graphy_core_free(pointer)
    if not response["ok"]:
        raise ValueError(response["error"])
    return response["value"]
