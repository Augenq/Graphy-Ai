"""`graphy serve` runs the local API that the web interface talk to."""

import sys

from . import __version__

USAGE = "usage: graphy serve [--port N] [--allow-origin ORIGIN] [--cwd DIR]   (graphy --version)"


def main():
    args = sys.argv[1:]
    if args[:1] == ["serve"]:
        from .server import main as serve

        serve(args[1:])
    elif args[:1] in (["--version"], ["-V"]):
        print(__version__)
    else:
        print(USAGE, file=sys.stderr)
        sys.exit(0 if args[:1] in (["-h"], ["--help"]) else 2)


if __name__ == "__main__":
    main()
