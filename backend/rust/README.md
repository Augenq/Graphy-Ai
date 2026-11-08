# graphy-core and the Rust backend

The Rust runtime owns the HTTP/SSE server, agent loop, providers and authentication, tools, web access, persistence, courses and questions. The Python package is a thin launcher; prompts and schemas remain data resources. A standalone `graphy-backend` executable runs the same runtime without Python.

From the project root, build and test with Rust/Cargo 1.89 or newer and a system linker:

```sh
cargo test --locked --manifest-path backend/rust/Cargo.toml
cargo build --release --locked --manifest-path backend/rust/Cargo.toml --bin graphy-backend
python backend/scripts/build_native.py
```

Add `--offline` when Cargo dependencies are cached. The last command installs the shared library into the Python package; Python 3.12+ is needed for that adapter, with no third-party Python runtime dependencies. Source installation and wheel builds compile the library; a built wheel contains the platform library. `GRAPHY_CORE_LIBRARY` can select an installed library, including the library built in Docker.

The library provides an `rlib` and a shared library. Pure Rust callers can use `graphy_core::dispatch(operation, serde_json::Value)`. The versioned C ABI offers `graphy_core_abi_version` (currently 1), `graphy_core_call`, and `graphy_core_free`: pass a NUL-terminated UTF-8 JSON request such as `{"version":1,"op":"health","data":null}` and free each non-null response once with `graphy_core_free`. The response has either `{"ok":true,"value":...}` or `{"ok":false,"error":"..."}`. Input is borrowed during the call; invalid pointers are caller errors. The pure dispatch operations accept JSON snapshots and do not use global mutable state.

`graphy_backend_main` is the C entry point for the complete runtime; it accepts a NUL-terminated UTF-8 JSON argument array and returns a process-style status. The Python launcher passes CLI arguments to it. The standalone binary offers the same `serve` command. See the source and [architecture](../../docs/architecture.md) for runtime boundaries, and [protocol](../docs/protocol.md) for the HTTP API.

Rust unit and HTTP tests exercise the native runtime. The test-only `tests/reference_graphy` is a legacy behavior oracle; it is not shipped as the runtime and Rust never calls it. The JSON boundary copies payloads; performance depends on the workload and should be measured.
