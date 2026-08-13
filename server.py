#!/usr/bin/env python3
"""
MikuPrompt — a local prompt enhancer for ComfyUI diffusion models.

Talks to any OpenAI-compatible chat endpoint: LM Studio, llama.cpp's
llama-server, Ollama, KoboldCpp, text-generation-webui, TabbyAPI, vLLM, SGLang,
or anything else that speaks /v1/chat/completions. The backend is switchable
from the UI at runtime — no restart, no rebuild.

Everything here is Python standard library: no pip install, no build step, no
venv.

    ./run.sh          # or: python3 server.py
    http://127.0.0.1:3939
"""

from __future__ import annotations

import argparse
import csv
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
SKILLS = ROOT / "skills"
DATA = ROOT / "data"

DEFAULT_COMFY = Path.home() / "bin" / "ComfyUI"
DEFAULT_TAGS = (
    DEFAULT_COMFY / "custom_nodes" / "comfyui-custom-scripts" / "user" / "autocomplete.txt"
)

# Danbooru tag category codes as used by the autocomplete file.
CATEGORY = {0: "general", 1: "artist", 3: "copyright", 4: "character", 5: "meta"}

MAX_BODY = 64 * 1024 * 1024  # generous: vision requests carry base64 images

# Local inference servers worth probing for. All of these expose an
# OpenAI-compatible /v1; the label is only for the UI.
BACKEND_PRESETS = [
    ("LM Studio", "http://127.0.0.1:1234/v1"),
    ("llama.cpp / llama-server", "http://127.0.0.1:8080/v1"),
    ("Ollama", "http://127.0.0.1:11434/v1"),
    ("KoboldCpp", "http://127.0.0.1:5001/v1"),
    ("text-gen-webui / TabbyAPI", "http://127.0.0.1:5000/v1"),
    ("vLLM", "http://127.0.0.1:8000/v1"),
    ("SGLang", "http://127.0.0.1:30000/v1"),
    ("llama.cpp (alt)", "http://127.0.0.1:8081/v1"),
]


# --------------------------------------------------------------------------
# Tag / artist database
# --------------------------------------------------------------------------


class TagDB:
    """In-memory Danbooru tag index built from the ComfyUI autocomplete file.

    The file is `name,category,post_count,"alias,alias"` sorted by post count.
    ~150k rows parses in well under a second, so it is loaded at startup and
    never needs a build step or a stale cache.
    """

    def __init__(self, path: Path):
        self.path = path
        self.all: list[dict] = []
        self.artists: list[dict] = []
        self.by_category: dict[str, list[dict]] = {}
        self.load()

    def load(self) -> None:
        if not self.path.exists():
            print(f"  ! tag database not found at {self.path}", file=sys.stderr)
            print("    artist browser and tag search will be empty", file=sys.stderr)
            return

        rows: list[dict] = []
        with self.path.open("r", encoding="utf-8", errors="replace", newline="") as fh:
            for parts in csv.reader(fh):
                if len(parts) < 3:
                    continue
                name = parts[0].strip()
                if not name:
                    continue
                try:
                    cat = int(parts[1])
                    count = int(parts[2])
                except ValueError:
                    # A handful of rows in the wild have a malformed category or
                    # count column; skip rather than abort the whole load.
                    continue
                aliases = [a.strip() for a in parts[3].split(",")] if len(parts) > 3 else []
                rows.append(
                    {
                        "name": name,
                        "cat": cat,
                        "kind": CATEGORY.get(cat, "other"),
                        "count": count,
                        "aliases": [a for a in aliases if a],
                    }
                )

        rows.sort(key=lambda r: -r["count"])
        self.all = rows
        for row in rows:
            self.by_category.setdefault(row["kind"], []).append(row)
        self.artists = self.by_category.get("artist", [])
        print(f"  · {len(rows):,} tags loaded ({len(self.artists):,} artists)")

    @staticmethod
    def _norm(text: str) -> str:
        return text.lower().replace("_", " ").strip()

    def search(self, query: str, kind: str | None, limit: int, offset: int) -> dict:
        pool = self.by_category.get(kind, []) if kind else self.all
        query = self._norm(query)

        if not query:
            matches = pool
        else:
            exact, prefix, word, loose = [], [], [], []
            for row in pool:
                name = self._norm(row["name"])
                if name == query:
                    exact.append(row)
                elif name.startswith(query):
                    prefix.append(row)
                elif f" {query}" in name or f"({query}" in name:
                    word.append(row)
                elif query in name or any(query in self._norm(a) for a in row["aliases"]):
                    loose.append(row)
            # Each bucket keeps the post-count ordering it inherited from `pool`.
            matches = exact + prefix + word + loose

        return {
            "total": len(matches),
            "results": matches[offset : offset + limit],
        }


# --------------------------------------------------------------------------
# Skills / profiles
# --------------------------------------------------------------------------


H3_GUIDES = {
    "h3-base-modes.txt": "base-en.txt",
    "h3-full-reference.txt": "ref-en.txt",
}
H3_RAW = ("https://raw.githubusercontent.com/MiniMax-AI/MiniMax-H3/main/"
          "skills/h3-prompt-writing/references/")


def ensure_h3_guides() -> None:
    """Fetch MiniMax's H3 reference guides on first run.

    These are MiniMax's own files and their repository ships no licence, so we
    don't redistribute them — each install pulls its own copy.
    """
    missing = {local: remote for local, remote in H3_GUIDES.items()
               if not (SKILLS / local).exists()}
    if not missing:
        return
    print("  · fetching MiniMax H3 reference guides…")
    for local, remote in missing.items():
        try:
            with urllib.request.urlopen(H3_RAW + remote, timeout=30) as resp:
                (SKILLS / local).write_bytes(resp.read())
            print(f"    ✓ {local}")
        except Exception as exc:  # noqa: BLE001
            print(f"    ! {local} — {exc}", file=sys.stderr)
            print("      H3 mode will be degraded until this file exists.", file=sys.stderr)


def read_skill(name: str) -> str:
    path = SKILLS / name
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8")


def load_profiles() -> dict:
    return json.loads((DATA / "profiles.json").read_text(encoding="utf-8"))


# --------------------------------------------------------------------------
# Backend plumbing (any OpenAI-compatible server)
# --------------------------------------------------------------------------


def normalise_backend(url: str) -> str:
    """Accept whatever the user pasted and produce a usable API base.

    Handles bare hosts, a trailing slash, a full /chat/completions URL, and a
    base that is missing the /v1 suffix most of these servers use.
    """
    url = (url or "").strip().rstrip("/")
    if not url:
        return ""
    if "://" not in url:
        url = "http://" + url
    for suffix in ("/chat/completions", "/completions"):
        if url.endswith(suffix):
            url = url[: -len(suffix)]
            break
    # Ollama's native root and a bare host both need /v1 appended.
    if not re.search(r"/(v\d+|api)$", url):
        url += "/v1"
    return url


def api_call(backend: str, path: str, key: str = "", data: bytes | None = None, timeout: int = 15):
    """Open a request against the backend, with optional bearer auth."""
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    request = urllib.request.Request(
        f"{backend}{path}", data=data, headers=headers, method="POST" if data else "GET"
    )
    return urllib.request.urlopen(request, timeout=timeout)


def list_models(backend: str, key: str = "") -> list[str]:
    with api_call(backend, "/models", key, timeout=8) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    models = []
    for entry in payload.get("data", payload.get("models", [])):
        name = entry.get("id") or entry.get("name") if isinstance(entry, dict) else str(entry)
        if name and "embed" not in name.lower():
            models.append(name)
    return models


def gpu_stats() -> list[dict]:
    """Per-GPU VRAM via nvidia-smi. Returns [] when it isn't available."""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.used,memory.total",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5, check=True,
        ).stdout
    except Exception:  # noqa: BLE001 — no nvidia-smi, AMD, or a CPU box
        return []
    gpus = []
    for line in out.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 3:
            continue
        try:
            gpus.append({"name": parts[0], "used": int(parts[1]), "total": int(parts[2])})
        except ValueError:
            continue
    return gpus


def unload_model(backend: str, model: str = "") -> dict:
    """Free the LLM's VRAM so a diffusion model can have the GPU.

    Local runtimes each do this differently: LM Studio has a CLI, Ollama takes
    keep_alive=0, and llama.cpp/vLLM hold the weights for the process lifetime
    and can only be freed by stopping the server.
    """
    port = urllib.parse.urlparse(backend).port

    if shutil.which("lms") and (port == 1234 or "lmstudio" in backend):
        try:
            proc = subprocess.run(
                ["lms", "unload", "--all"], capture_output=True, text=True, timeout=45
            )
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "detail": f"lms failed: {exc}"}
        if proc.returncode != 0:
            return {"ok": False, "detail": (proc.stderr or proc.stdout).strip()[:300]}
        return {"ok": True, "how": "lms unload --all", "detail": proc.stdout.strip()[:300]}

    if port == 11434 or "ollama" in backend:
        # Ollama evicts a model when a request sets keep_alive to 0.
        base = backend.rsplit("/v1", 1)[0]
        try:
            body = json.dumps({"model": model, "keep_alive": 0}).encode()
            request = urllib.request.Request(
                f"{base}/api/generate", data=body,
                headers={"Content-Type": "application/json"}, method="POST",
            )
            urllib.request.urlopen(request, timeout=30).read()
            return {"ok": True, "how": "ollama keep_alive=0"}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "detail": str(exc)}

    return {
        "ok": False,
        "detail": "This backend holds its weights for the life of the process — "
        "stop the server itself to free VRAM. Automatic unloading works with "
        "LM Studio (needs the `lms` CLI on PATH) and Ollama.",
    }


def detect_backends() -> list[dict]:
    """Probe the usual local ports in parallel and report what answered."""
    found: list[dict] = []
    lock = threading.Lock()

    def probe(label: str, url: str) -> None:
        try:
            models = list_models(url, "")
        except Exception:  # noqa: BLE001 — a closed port is the common case
            return
        with lock:
            found.append({"label": label, "url": url, "models": models})

    seen: set[str] = set()
    threads = []
    for label, url in BACKEND_PRESETS:
        if url in seen:
            continue
        seen.add(url)
        thread = threading.Thread(target=probe, args=(label, url), daemon=True)
        thread.start()
        threads.append(thread)
    for thread in threads:
        thread.join(timeout=3)

    order = {url: i for i, (_, url) in enumerate(BACKEND_PRESETS)}
    found.sort(key=lambda f: order.get(f["url"], 99))
    return found


# --------------------------------------------------------------------------
# Prompt assembly
# --------------------------------------------------------------------------


def build_system_prompt(req: dict, profiles: dict) -> str:
    """Assemble the system prompt: core rules + model skill + user options."""
    profile_id = req.get("profile", "anima")
    profile = profiles["profiles"].get(profile_id) or {}
    parts = [read_skill("_core.md")]

    skill_file = profile.get("skill")
    if skill_file:
        parts.append(read_skill(skill_file))

    # MiniMax H3 carries the upstream reference guide verbatim — it is the
    # authoritative field/section spec and must not be paraphrased.
    if profile.get("family") == "h3":
        mode = (req.get("h3") or {}).get("mode", "ref2va")
        guide = "h3-full-reference.txt" if mode == "ref2va" else "h3-base-modes.txt"
        parts.append(
            "# Authoritative reference guide\n\n"
            "Follow this guide exactly — field names, section order, labels and "
            "timing notation are all normative.\n\n" + read_skill(guide)
        )
        parts.append(build_h3_directive(req))

    parts.append(build_request_directive(req, profile))

    extra = (req.get("systemExtra") or "").strip()
    mode = req.get("systemMode", "append")
    if extra:
        if mode == "replace":
            return extra
        if mode == "prepend":
            parts.insert(0, "# Operator instructions (highest priority)\n\n" + extra)
        else:
            parts.append("# Operator instructions (highest priority)\n\n" + extra)

    return "\n\n---\n\n".join(p for p in parts if p.strip())


def build_h3_directive(req: dict) -> str:
    h3 = req.get("h3") or {}
    mode = h3.get("mode", "ref2va")
    duration = h3.get("duration", 8)
    names = {
        "t2va": "T2VA (text to video+audio)",
        "i2va": "I2VA (first frame supplied)",
        "fl2va": "FL2VA (first and last frame supplied)",
        "l2va": "L2VA (last frame supplied)",
        "ref2va": "Ref2VA (full reference)",
    }
    lines = [
        "# H3 mode for this request",
        "",
        f"- Mode: **{names.get(mode, mode)}**",
        f"- Target duration: **{float(duration):.2f} seconds** — all cut times and "
        f"alignment marks must fall inside this.",
    ]
    if mode == "ref2va":
        lines.append(
            "- Emit all six sections: `subject_definitions`, `summary`, "
            "`retention_analysis`, `detailed_description`, `overall_soundscape`, "
            "`non_diegetic_music`."
        )
    else:
        lines.append(
            "- Emit the three core fields: `integrated_multimodal_description`, "
            "`overall_soundscape`, `non_diegetic_music`."
        )
        if mode != "t2va":
            lines.append(
                "- The alignment instruction is the first line of your output, "
                "followed by one blank line."
            )
    if h3.get("shots"):
        lines.append(f"- Target roughly {h3['shots']} shot(s).")
    if h3.get("dialogue"):
        lines.append(
            "- Dialogue to place verbatim inside `<d>[Language] …</d>` — preserve "
            f"wording and punctuation exactly:\n\n{h3['dialogue']}"
        )
    if h3.get("labels"):
        lines.append(f"- Reference label assignment given by the user:\n\n{h3['labels']}")
    return "\n".join(lines)


def build_request_directive(req: dict, profile: dict) -> str:
    """Per-request knobs that are not part of the static skill."""
    opts = req.get("options") or {}
    lines = ["# This request", ""]

    if profile.get("family") != "h3":
        lines.append(f"- Target model: **{profile.get('label', 'unknown')}**")

    artists = opts.get("artists") or []
    if artists:
        if profile.get("dialect") == "tags":
            lines.append(
                "- Artist tags to include, immediately after the quality preamble "
                "and before the subject, exactly as written: "
                + ", ".join(artists)
            )
        else:
            lines.append(
                "- Emulate the visual style of these artists, described in plain "
                "language — do not name them in the prompt: " + ", ".join(artists)
            )

    tags = opts.get("tags") or []
    if tags:
        if profile.get("dialect") == "tags":
            lines.append("- Include these tags, placed in their correct slot: " + ", ".join(tags))
        else:
            lines.append(
                "- Work these concepts into the description naturally: " + ", ".join(tags)
            )

    if opts.get("negative") and profile.get("negative"):
        lines.append(
            "- After the prompt, output a blank line, then `NEGATIVE:` followed by "
            "the negative prompt on one line. This is the only case where you may "
            "output anything after the prompt itself."
        )

    if opts.get("rating") and profile.get("dialect") == "tags":
        lines.append(f"- Content rating tag: `{opts['rating']}`")

    if opts.get("aspect"):
        lines.append(f"- Intended aspect ratio: {opts['aspect']} — compose for it.")

    if opts.get("variations", 1) > 1:
        lines.append(
            f"- Produce {opts['variations']} distinct variations. Separate them with "
            "a line containing only `---`. No numbering, no headings."
        )

    if req.get("images"):
        n = len(req["images"])
        noun = "image" if n == 1 else "images"
        lines.append(
            f"- {n} reference {noun} attached. Study them and ground your prompt in "
            "what is actually visible — specific colours, garments, materials, "
            "architecture, light direction."
        )
        if opts.get("imageMode") == "describe":
            lines.append(
                "- The user wants a prompt that would **reproduce** the attached "
                "image. Describe what you see, in the target model's dialect."
            )
        elif opts.get("imageMode") == "style":
            lines.append(
                "- Take **style only** from the attached image — medium, palette, "
                "lighting, rendering. The subject comes from the user's text."
            )

    if req.get("thinking") == "off":
        lines.append(
            "- Do not use extended reasoning. Output the finished prompt directly."
        )

    return "\n".join(lines)


def build_messages(req: dict, profiles: dict) -> list[dict]:
    system = build_system_prompt(req, profiles)
    idea = (req.get("idea") or "").strip()

    user_content: list[dict] | str
    images = req.get("images") or []
    if images:
        user_content = [{"type": "text", "text": idea or "(see attached image)"}]
        for url in images:
            user_content.append({"type": "image_url", "image_url": {"url": url}})
    else:
        user_content = idea

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user_content},
    ]

    # Assistant prefill: LM Studio continues from a trailing assistant turn.
    prefill = (req.get("thinkingPrefill") or "").strip()
    if req.get("thinking") == "prefill" and prefill:
        messages.append({"role": "assistant", "content": prefill})

    return messages


# --------------------------------------------------------------------------
# Reasoning stream splitting
# --------------------------------------------------------------------------


class ThinkSplitter:
    """Separates <think>…</think> spans from real content across chunk boundaries.

    Models differ in how they surface reasoning: some use a `reasoning_content`
    delta field (handled upstream), others inline `<think>` tags in the content
    stream. This handles the latter, including tags split across chunks.
    """

    OPEN = re.compile(r"<(think|thinking|reasoning)>", re.I)
    CLOSE = re.compile(r"</(think|thinking|reasoning)>", re.I)

    def __init__(self) -> None:
        self.buf = ""
        self.in_think = False

    def feed(self, chunk: str) -> list[tuple[str, str]]:
        self.buf += chunk
        out: list[tuple[str, str]] = []

        while self.buf:
            pattern = self.CLOSE if self.in_think else self.OPEN
            match = pattern.search(self.buf)
            if match:
                head, self.buf = self.buf[: match.start()], self.buf[match.end() :]
                if head:
                    out.append(("reasoning" if self.in_think else "content", head))
                self.in_think = not self.in_think
                continue

            # No complete tag. Hold back a tail that could be a partial tag so a
            # split like "<thi" + "nk>" is not emitted as content.
            cut = self.buf.rfind("<")
            if cut != -1 and len(self.buf) - cut <= 12:
                head, tail = self.buf[:cut], self.buf[cut:]
            else:
                head, tail = self.buf, ""
            if head:
                out.append(("reasoning" if self.in_think else "content", head))
            self.buf = tail
            break

        return out

    def flush(self) -> list[tuple[str, str]]:
        if not self.buf:
            return []
        out = [("reasoning" if self.in_think else "content", self.buf)]
        self.buf = ""
        return out


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    server_version = "MikuPrompt"
    protocol_version = "HTTP/1.1"

    # -- plumbing ---------------------------------------------------------

    def log_message(self, fmt: str, *args) -> None:
        if self.server.verbose:  # type: ignore[attr-defined]
            sys.stderr.write("  %s\n" % (fmt % args))

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8")

    def _err(self, code: int, message: str) -> None:
        self._json({"error": message}, code)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ValueError("request body too large")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    # -- routing ----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        path, _, query = self.path.partition("?")
        params = dict(
            (k, urllib.parse.unquote_plus(v))
            for k, _, v in (p.partition("=") for p in query.split("&") if p)
        )

        if path.startswith("/api/"):
            return self._api_get(path, params)
        return self._static(path)

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.partition("?")[0]
        try:
            body = self._body()
        except ValueError as exc:
            return self._err(400, str(exc))

        if path == "/api/generate":
            return self._generate(body)
        if path == "/api/export-artists":
            return self._export_artists(body)
        if path == "/api/unload":
            backend = normalise_backend(body.get("backend") or self.server.backend)
            result = unload_model(backend, body.get("model", ""))
            result["gpus"] = gpu_stats()
            return self._json(result)
        return self._err(404, "no such endpoint")

    def _api_get(self, path: str, params: dict) -> None:
        srv = self.server

        if path == "/api/health":
            return self._json(
                {
                    "ok": True,
                    "tags": len(srv.db.all),
                    "artists": len(srv.db.artists),
                    "backend": srv.backend,
                    "tagfile": str(srv.db.path),
                    "comfy": str(srv.comfy),
                }
            )

        if path == "/api/profiles":
            return self._json(srv.profiles)

        if path == "/api/tagsets":
            return self._json(json.loads((DATA / "tagsets.json").read_text("utf-8")))

        if path in ("/api/artists", "/api/tags"):
            kind = "artist" if path == "/api/artists" else (params.get("kind") or None)
            try:
                limit = min(int(params.get("limit", 60)), 500)
                offset = max(int(params.get("offset", 0)), 0)
            except ValueError:
                return self._err(400, "limit and offset must be integers")
            return self._json(srv.db.search(params.get("q", ""), kind, limit, offset))

        if path == "/api/models":
            backend = normalise_backend(params.get("backend") or srv.backend)
            try:
                return self._json({"backend": backend, "models": list_models(backend, params.get("key", ""))})
            except Exception as exc:  # noqa: BLE001 — surfaced to the UI as-is
                return self._json({"backend": backend, "models": [], "error": str(exc)})

        if path == "/api/gpu":
            return self._json({"gpus": gpu_stats()})

        if path == "/api/detect":
            return self._json({"found": detect_backends(), "presets": [
                {"label": label, "url": url} for label, url in BACKEND_PRESETS
            ]})

        return self._err(404, "no such endpoint")

    # -- static -----------------------------------------------------------

    def _static(self, path: str) -> None:
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        target = (WEB / rel).resolve()
        if not str(target).startswith(str(WEB.resolve())) or not target.is_file():
            return self._err(404, "not found")
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)

    # -- generation -------------------------------------------------------

    def _generate(self, req: dict) -> None:
        srv = self.server
        try:
            messages = build_messages(req, srv.profiles)
        except Exception as exc:  # noqa: BLE001
            return self._err(400, f"could not build prompt: {exc}")

        if req.get("dryRun"):
            return self._json({"messages": messages})

        backend = normalise_backend(req.get("backend") or srv.backend)
        key = req.get("apiKey") or srv.api_key

        payload = {
            "model": req.get("model") or "",
            "messages": messages,
            "temperature": float(req.get("temperature", 0.8)),
            "max_tokens": int(req.get("maxTokens", 2048)),
            "stream": True,
            # Lets us report the real prompt size when a context limit is hit.
            "stream_options": {"include_usage": True},
        }
        top_p = req.get("topP")
        if top_p is not None:
            payload["top_p"] = float(top_p)

        # Gemma-family chat templates read `thinking`; Qwen-family read
        # `enable_thinking`. Servers that don't know the field either ignore it
        # or reject the request — the retry below covers the strict ones.
        thinking = req.get("thinking", "off")
        if thinking in ("off", "on"):
            want = thinking == "on"
            payload["chat_template_kwargs"] = {"thinking": want, "enable_thinking": want}

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        sent_any = False
        sent_content = False

        def emit(obj: dict) -> bool:
            nonlocal sent_any, sent_content
            try:
                self.wfile.write(f"data: {json.dumps(obj)}\n\n".encode("utf-8"))
                self.wfile.flush()
                if obj.get("type") in ("content", "reasoning"):
                    sent_any = True
                if obj.get("type") == "content" and obj.get("text", "").strip():
                    sent_content = True
                return True
            except (BrokenPipeError, ConnectionResetError):
                return False

        if thinking == "prefill" and (req.get("thinkingPrefill") or "").strip():
            emit({"type": "content", "text": req["thinkingPrefill"]})

        finish = {"reason": None, "prompt_tokens": None}

        def stream(body: dict) -> bool:
            """Run one attempt. Returns False if the client hung up."""
            splitter = ThinkSplitter()
            with api_call(
                backend, "/chat/completions", key,
                data=json.dumps(body).encode("utf-8"), timeout=900,
            ) as resp:
                for raw in resp:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    usage = chunk.get("usage") or {}
                    if usage.get("prompt_tokens"):
                        finish["prompt_tokens"] = usage["prompt_tokens"]
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    if choices[0].get("finish_reason"):
                        finish["reason"] = choices[0]["finish_reason"]
                    delta = choices[0].get("delta") or choices[0].get("message") or {}

                    reasoning = delta.get("reasoning_content") or delta.get("reasoning")
                    if reasoning and not emit({"type": "reasoning", "text": reasoning}):
                        return False

                    text = delta.get("content")
                    if text:
                        for kind, piece in splitter.feed(text):
                            if not emit({"type": kind, "text": piece}):
                                return False

            for kind, piece in splitter.flush():
                if not emit({"type": kind, "text": piece}):
                    return False
            return True

        try:
            try:
                if not stream(payload):
                    return
            except urllib.error.HTTPError as exc:
                # Strict servers (some vLLM/Kobold builds) reject unknown
                # top-level fields. Drop the optional ones and try once more,
                # but only if the client has not already seen output.
                optional = ("chat_template_kwargs", "stream_options")
                if exc.code not in (400, 422) or sent_any or not any(k in payload for k in optional):
                    raise
                for field in optional:
                    payload.pop(field, None)
                if not stream(payload):
                    return

            # The model hit its ceiling before writing any prompt. Almost always
            # the loaded context is too small for the skill plus the answer —
            # say so precisely instead of returning a blank panel.
            if finish["reason"] == "length" and not sent_content:
                used = finish["prompt_tokens"]
                budget = f"Your prompt used {used:,} tokens. " if used else ""
                need = 32768 if (used or 0) > 6000 else 16384
                emit(
                    {
                        "type": "error",
                        "text": (
                            "The model ran out of context before writing the prompt. "
                            f"{budget}Raise the context length of the loaded model to "
                            f"{need:,} or more and reload it, then try again.\n\n"
                            "In LM Studio that is the context length slider on the "
                            "model; in llama.cpp it is -c / --ctx-size; in Ollama it "
                            "is num_ctx."
                        ),
                    }
                )
                return

            emit({"type": "done"})

            # Hand the GPU back so a diffusion model can load straight after.
            if req.get("unloadAfter") and sent_content:
                emit({"type": "unloading"})
                result = unload_model(backend, payload.get("model", ""))
                emit({"type": "unloaded", "ok": result.get("ok"),
                      "detail": result.get("detail", ""), "gpus": gpu_stats()})

        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:600]
            emit({"type": "error", "text": f"Backend returned HTTP {exc.code}: {detail}"})
        except urllib.error.URLError as exc:
            emit(
                {
                    "type": "error",
                    "text": f"Cannot reach a backend at {backend} ({exc.reason}). "
                    "Check that your inference server is running, then set the URL "
                    "in Settings → Backend.",
                }
            )
        except Exception as exc:  # noqa: BLE001
            emit({"type": "error", "text": f"{type(exc).__name__}: {exc}"})

    # -- ComfyUI artist-list export ---------------------------------------

    def _export_artists(self, req: dict) -> None:
        artists = [a.strip() for a in (req.get("artists") or []) if a.strip()]
        if not artists:
            return self._err(400, "no artists supplied")

        comfy = Path(req.get("comfy") or self.server.comfy)
        targets = [
            comfy / "custom_nodes" / "comfyui-prompt-composer" / "custom-lists" / f"artist_{i}.txt"
            for i in (1, 2, 3)
        ]
        targets.append(comfy / "custom_nodes" / "comfyui-impact-pack" / "wildcards" / "artists.txt")

        body = "\n".join(f"by {a}" if not a.startswith("by ") else a for a in artists) + "\n"
        written, skipped = [], []
        for target in targets:
            if not target.parent.is_dir():
                skipped.append(str(target))
                continue
            target.write_text(body, encoding="utf-8")
            written.append(str(target))

        return self._json(
            {
                "written": written,
                "skipped": skipped,
                "count": len(artists),
                "note": "Restart ComfyUI — dropdown contents are cached at startup.",
            }
        )


# --------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="MikuPrompt server")
    parser.add_argument("--port", type=int, default=3939)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--backend",
        default=os.environ.get("MIKU_BACKEND", "http://127.0.0.1:1234/v1"),
        help="default OpenAI-compatible base URL; switchable from the UI",
    )
    parser.add_argument(
        "--api-key",
        default=os.environ.get("MIKU_API_KEY", ""),
        help="bearer token, if your backend requires one",
    )
    parser.add_argument("--tags", default=os.environ.get("MIKU_TAGS", str(DEFAULT_TAGS)))
    parser.add_argument("--comfy", default=os.environ.get("MIKU_COMFY", str(DEFAULT_COMFY)))
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    print("\n  \033[96m♪ MikuPrompt\033[0m")
    ensure_h3_guides()
    db = TagDB(Path(args.tags))
    profiles = load_profiles()
    backend = normalise_backend(args.backend)
    print(f"  · {len(profiles['profiles'])} model profiles")

    live = detect_backends()
    if live:
        for entry in live:
            mark = "→" if entry["url"] == backend else " "
            count = len(entry["models"])
            plural = "" if count == 1 else "s"
            print(f"  {mark} {entry['label']}: {entry['url']} ({count} model{plural})")
    else:
        print("  ! no local inference server found — set one in Settings → Backend")

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.db = db  # type: ignore[attr-defined]
    httpd.profiles = profiles  # type: ignore[attr-defined]
    httpd.backend = backend  # type: ignore[attr-defined]
    httpd.api_key = args.api_key  # type: ignore[attr-defined]
    httpd.comfy = args.comfy  # type: ignore[attr-defined]
    httpd.verbose = args.verbose  # type: ignore[attr-defined]

    url = f"http://{args.host}:{args.port}"
    print(f"\n  \033[96m→\033[0m {url}\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  bye ♪\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
