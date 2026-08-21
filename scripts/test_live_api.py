"""End-to-end probe of the live ZeroGPU Gradio REST API.

Working flow (Gradio 4.44, api_prefix=null):
  1. POST /upload (multipart, field "files") -> [paths]
  2. POST /call/run_tryon with FileData payloads -> {"event_id": "..."}
  3. GET  /call/run_tryon/{event_id}  -> SSE stream; the final event is
     `event: complete` with `data: [[{"image": {"url": ...}}]]`
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

import requests

SPACE = "https://muse0515-my-heart-vton-zerogpu.hf.space"
PERSON_URL = "https://raw.githubusercontent.com/fashn-AI/fashn-vton-1.5/main/examples/data/model.webp"
GARMENT_URL = "https://raw.githubusercontent.com/fashn-AI/fashn-vton-1.5/main/examples/data/garment.webp"

CATEGORY = sys.argv[1] if len(sys.argv) > 1 else "tops"
STEPS = int(sys.argv[2]) if len(sys.argv) > 2 else 16


def download(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    print(f"[1] Downloading {url.split('/')[-1]} ...")
    urllib.request.urlretrieve(url, dest)
    return dest


def _filedata(p: str) -> dict:
    return {
        "path": p,
        "url": None,
        "size": None,
        "orig_name": None,
        "mime_type": None,
        "meta": {"_type": "gradio.FileData"},
    }


def _extract_gallery_urls(data) -> list:
    """Flatten Gradio 4 Gallery outputs into image URLs (descends nesting)."""
    urls = []

    def walk(node):
        if isinstance(node, str):
            if node.startswith(("http://", "https://", "data:")):
                urls.append(node)
            return
        if isinstance(node, dict):
            img = node.get("image")
            if isinstance(img, dict):
                u = img.get("url") or img.get("path")
                if u:
                    urls.append(u)
            v = node.get("video")
            if isinstance(v, dict):
                u = v.get("url") or v.get("path")
                if u:
                    urls.append(u)
            for k in ("data", "output", "value"):
                walk(node.get(k))
        elif isinstance(node, (list, tuple)):
            for item in node:
                walk(item)

    walk(data)
    return urls


def _check_url(url: str) -> None:
    head = requests.head(url, allow_redirects=True, timeout=30)
    print(f"    HEAD {url[:80]}... -> {head.status_code} {head.headers.get('content-type')}")
    if head.status_code == 200:
        print("    result image reachable")


def main() -> None:
    tmp = Path("scripts/_tmp")
    tmp.mkdir(parents=True, exist_ok=True)
    person = download(PERSON_URL, tmp / "person.webp")
    garment = download(GARMENT_URL, tmp / "garment.webp")

    print(f"[2] POST {SPACE}/upload")
    with open(person, "rb") as pf, open(garment, "rb") as gf:
        up = requests.post(
            SPACE + "/upload",
            files=[
                ("files", ("person.webp", pf, "image/webp")),
                ("files", ("garment.webp", gf, "image/webp")),
            ],
            timeout=120,
        )
    up.raise_for_status()
    paths = up.json()
    print(f"    upload returned: {paths}")
    assert isinstance(paths, list) and len(paths) >= 2, paths

    body = {
        "data": [
            _filedata(paths[0]),
            _filedata(paths[1]),
            CATEGORY,
            "model",
            1,
            STEPS,
            1.5,
            42,
            True,
        ],
    }
    print(f"[3] POST {SPACE}/call/run_tryon (category={CATEGORY}, steps={STEPS})")
    call = requests.post(SPACE + "/call/run_tryon", json=body, timeout=30)
    print(f"    status={call.status_code} text={call.text[:200]}")
    call.raise_for_status()
    data = call.json()
    event_id = data.get("event_id")
    assert event_id, data
    print(f"    event_id={event_id}")

    url = f"{SPACE}/call/run_tryon/{event_id}"
    print(f"[4] GET {url} (SSE) - cold starts may take minutes, be patient.")
    t0 = time.time()
    with requests.get(url, stream=True, timeout=1800) as r:
        r.raise_for_status()
        for raw in r.iter_lines(decode_unicode=True):
            if not raw:
                continue
            line = raw
            if line.startswith("event: "):
                continue
            if not line.startswith("data: "):
                continue
            payload = line[6:]
            if payload == "null":
                continue
            try:
                ev = json.loads(payload)
            except json.JSONDecodeError:
                continue
            print(f"    [{int(time.time()-t0)}s] {line[:160]}")
            if isinstance(ev, list):
                # Gradio 4.44 REST SSE 'complete': data is directly the
                # array of output values, e.g. [[{"image": {...}}]]
                urls = _extract_gallery_urls(ev)
                print("GALLERY URLS =", urls)
                if urls:
                    _check_url(urls[0])
                return
            if isinstance(ev, dict):
                if ev.get("msg") == "process_completed":
                    outputs = ev.get("output", {}).get("data", [])
                    urls = _extract_gallery_urls(outputs)
                    print("GALLERY URLS =", urls)
                    if urls:
                        _check_url(urls[0])
                    return
                if ev.get("msg") in ("process_error", "error"):
                    print("process_error:", ev)
                    sys.exit(2)


if __name__ == "__main__":
    main()