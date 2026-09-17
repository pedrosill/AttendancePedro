"""Servidor local identificado da aplicação de presenças."""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the attendance app locally.")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    root = Path(__file__).resolve().parent
    handler = partial(QuietHandler, directory=str(root))
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"Attendance app available at http://127.0.0.1:{args.port}/index.html", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
