#!/usr/bin/env python3
"""A resident transcriber, speaking whisper.cpp's HTTP API.

Core already knows how to talk to whisper.cpp's server — POST /inference, multipart, the
field is `file`. That path is written and tested. What it lacks on a Debian-family machine
is a whisper.cpp to talk to: the distribution ships `libwhisper` but not the tools, so there
is no `apt install` that produces the binary, and building it needs a compiler toolchain
that a borrowed demo laptop may not have.

faster-whisper does have a wheel. It runs the same whisper models — base.en is base.en —
through CTranslate2, which is markedly quicker than the reference implementation on a CPU
with no GPU worth using. So this wraps it in the API Core already speaks, and nothing in
Core has to know the difference.

The model is loaded once and stays loaded. That is the whole point: the command-line tools
re-read it for every utterance, which on a 63MB model is most of the time budget for a
short command.

    scripts/whisper-server.py --model base.en --port 8910

Stdlib only besides faster_whisper — no framework, for the same reason Core has no
dependencies: this runs on a machine with no internet at the venue.
"""

import argparse
import json
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODEL = None

# The words this room is built out of. Whisper takes it as the run-up to what it is about to
# hear, so the names and commands stop being surprises.
PROMPT = (
    "JARVIS. Hey JARVIS. Take the room. Release the room. "
    "Identify device one. Identify device two. Identify device three. "
    "Show me the architecture. Show the reactor. Switch to terminal. "
    "Move to device two. Split yourself. Reactor sequence. How many are online."
)


def parse_multipart(body: bytes, content_type: str) -> bytes:
    """Pull the one file part out of a multipart body.

    Written by hand because Python 3.13 removed the `cgi` module, and pulling in a parsing
    dependency for a single field would be silly. Only the `file` field matters; everything
    else Core sends (response_format, temperature) is ignored, since this server has one job.
    """
    marker = "boundary="
    if marker not in content_type:
        raise ValueError("no multipart boundary")

    boundary = content_type.split(marker, 1)[1].strip().strip('"')
    sep = b"--" + boundary.encode()

    for part in body.split(sep):
        # Headers and payload are separated by a blank line; no headers means no part.
        split = part.find(b"\r\n\r\n")
        if split == -1:
            continue
        headers = part[:split].decode("latin-1", "replace")
        if 'name="file"' not in headers:
            continue
        data = part[split + 4:]
        # Exactly one CRLF belongs to the delimiter. Stripping a *set* of trailing bytes
        # here was a real bug: WAV samples end in 0x0D, 0x0A and 0x2D often enough, and
        # eating them truncated the audio into something the decoder rejected with
        # "invalid data found while processing input" — intermittently, which is worse.
        if data.endswith(b"\r\n"):
            data = data[:-2]
        return data

    raise ValueError('no "file" field in the request')


class Handler(BaseHTTPRequestHandler):
    # Quiet: Core logs what it heard, and a line per request would drown that out.
    def log_message(self, *_args):
        pass

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # So a health check can tell "loaded and listening" from "port is open".
        if self.path == "/health":
            self._send(200, {"ok": True, "loaded": MODEL is not None})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/inference":
            return self._send(404, {"error": "not found"})

        try:
            length = int(self.headers.get("Content-Length", 0))
            audio = parse_multipart(self.rfile.read(length), self.headers.get("Content-Type", ""))
        except Exception as exc:  # noqa: BLE001 - the reply has to say what went wrong
            return self._send(400, {"error": f"bad request: {exc}"})

        try:
            with tempfile.NamedTemporaryFile(suffix=".wav") as clip:
                clip.write(audio)
                clip.flush()
                segments, _info = MODEL.transcribe(
                    clip.name,
                    language="en",
                    # Tell it what it is likely to hear.
                    #
                    # A small model has no reason to expect a proper noun it has never seen,
                    # so it substitutes the nearest common word — measured, "Jarvis" came
                    # back as "always", every time, which loses the wake word and with it
                    # the command. Naming the vocabulary up front biases it toward the words
                    # this room actually uses. It costs nothing at run time.
                    initial_prompt=PROMPT,
                    # Off: it costs time, and Core discards anything it cannot match anyway.
                    without_timestamps=True,
                    # A room has noise in it. Without this, silence is transcribed as
                    # whatever the model hallucinates into it — usually "Thank you."
                    vad_filter=True,
                )
                text = " ".join(segment.text for segment in segments).strip()
        except Exception as exc:  # noqa: BLE001
            return self._send(500, {"error": f"transcription failed: {exc}"})

        self._send(200, {"text": text})


def main() -> int:
    global MODEL

    parser = argparse.ArgumentParser(description="A resident whisper, over HTTP.")
    parser.add_argument("--model", default="base.en", help="whisper model (default: base.en)")
    parser.add_argument("--port", type=int, default=8910)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--download-dir", default=None, help="where models are kept")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper is not installed:  pip install faster-whisper", file=sys.stderr)
        return 1

    print(f"loading {args.model}...", file=sys.stderr, flush=True)

    # int8 rather than float32: roughly half the work for a difference this demo cannot
    # hear, on a laptop CPU where that difference is the whole latency budget.
    MODEL = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        cpu_threads=args.threads,
        download_root=str(Path(args.download_dir).expanduser()) if args.download_dir else None,
    )

    print(f"ready on {args.host}:{args.port}", file=sys.stderr, flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
