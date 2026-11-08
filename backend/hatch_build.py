"""Build the mandatory native core for wheels and editable installs."""

import runpy
import sysconfig
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version, build_data):
        if self.target_name != "wheel":
            return
        script = Path(self.root) / "scripts" / "build_native.py"
        native = runpy.run_path(str(script))["build"]()
        relative = native.relative_to(self.root).as_posix()
        build_data["force_include"][str(native)] = relative
        build_data["pure_python"] = False
        platform = sysconfig.get_platform().replace("-", "_").replace(".", "_")
        build_data["tag"] = f"py3-none-{platform}"
