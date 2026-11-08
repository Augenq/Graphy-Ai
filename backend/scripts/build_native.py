"""Build and install the Rust core into the Python source package."""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def build(*, offline=False):
    target = Path(os.environ.get("CARGO_TARGET_DIR", ROOT / "rust" / "target")).resolve()
    command = ["cargo", "build", "--release", "--locked", "--manifest-path", str(ROOT / "rust" / "Cargo.toml")]
    if offline:
        command.append("--offline")
    env = os.environ | {"CARGO_TARGET_DIR": str(target)}
    subprocess.run(command, check=True, env=env)
    filename = "graphy_core.dll" if sys.platform == "win32" else (
        "libgraphy_core.dylib" if sys.platform == "darwin" else "libgraphy_core.so")
    destination = ROOT / "graphy" / "_native" / filename
    destination.parent.mkdir(exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    shutil.copy2(target / "release" / filename, temporary)
    os.replace(temporary, destination)
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true")
    print(build(offline=parser.parse_args().offline))
