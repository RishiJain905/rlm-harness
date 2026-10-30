"""KV cache: none

`python -X utf8 -m rlm_engine serve`: serves the link on stdin and stdout until stdin closes.
"""

from __future__ import annotations

import asyncio
import logging
import os
import platform
import sys
from typing import BinaryIO, Sequence

from . import PROTOCOL_VERSION, __version__
from .appport import LinkAppPort
from .link import Link
from .service import Engine

USAGE = "usage: python -X utf8 -m rlm_engine serve"


def claim_stdio() -> tuple[BinaryIO, BinaryIO]:
    """Take fds 0 and 1 for the protocol, so a stray print or a C-level write can't reach it.

    Returns private unbuffered binary files on dups of the original stdin and stdout. Then fd 0
    points at the null device, fd 1 at fd 2, and sys.stdout is sys.stderr. sys.stdin.buffer is
    never touched: a daemon thread blocked in a BufferedReader can abort interpreter shutdown.
    """
    in_fd = os.dup(0)
    out_fd = os.dup(1)
    if os.name == "nt":
        import msvcrt

        msvcrt.setmode(in_fd, os.O_BINARY)  # never write \r\n
        msvcrt.setmode(out_fd, os.O_BINARY)
    null_fd = os.open(os.devnull, os.O_RDONLY)
    os.dup2(null_fd, 0)
    os.close(null_fd)
    sys.stdout.flush()
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return os.fdopen(in_fd, "rb", buffering=0), os.fdopen(out_fd, "wb", buffering=0)


def main(argv: Sequence[str] | None = None) -> int:
    """`argv` is the arguments after the program name (sys.argv[1:] by default)."""
    args = list(sys.argv[1:] if argv is None else argv)
    if args != ["serve"]:
        print(USAGE, file=sys.stderr)
        return 2
    reader, writer = claim_stdio()
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="rlm_engine %(levelname)s %(name)s: %(message)s")
    link = Link(reader, writer)
    engine = Engine(LinkAppPort(link), debug=os.environ.get("RLMH_DEBUG") == "1")
    engine.register(link)
    logging.getLogger("rlm_engine").info(
        "rlm_engine %s serving (protocol %d, python %s)", __version__, PROTOCOL_VERSION, platform.python_version()
    )
    try:
        asyncio.run(link.serve())
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
