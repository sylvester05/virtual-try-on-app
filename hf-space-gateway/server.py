"""My Heart — Virtual Try-On: CPU gateway for Hugging Face (Docker Space).

This is the *front-facing* FastAPI app served to browsers. It serves the
existing static UI unchanged and proxies every ``/api/tryon`` request to the
ZeroGPU Space (``hf-space-gpu/``) via Gradio's REST API.

Environment variables:
    VTON_GPU_SPACE_URL    URL of the ZeroGPU Space (no trailing slash).
                          Default: https://muse0515-my-heart-vton-zerogpu.hf.space
    VTON_GPU_FN           Gradio function name. Default: run_tryon
    VTON_GPU_MAX_ATTEMPTS Max retries when the Space is busy. Default: 4
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
EXAMPLES_DIR = BASE_DIR / "examples" / "data"

CATEGORIES = ("tops", "bottoms", "one-pieces")
PHOTO_TYPES = ("model", "flat-lay")

# ---------------------------------------------------------------------------
# GPU Space configuration
# ---------------------------------------------------------------------------

GPU_SPACE_URL = (
    os.environ.get("VTON_GPU_SPACE_URL")
    or "https://muse0515-my-heart-vton-zerogpu.hf.space"
).rstrip("/")
GPU_FN = os.environ.get("VTON_GPU_FN", "run_tryon")
GPU_MAX_ATTEMPTS = int(os.environ.get("VTON_GPU_MAX_ATTEMPTS", "4"))
GRADIO_CALL_URL = f"{GPU_SPACE_URL}/gradio_api/call/{GPU_FN}"
HEALTH_URL = f"{GPU_SPACE_URL}/config"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("myheart-gateway")
logger.info("GPU Space: %s (fn=%s)", GPU_SPACE_URL, GPU_FN)

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="My Heart — Virtual Try-On (Gateway)", version="1.5.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
if EXAMPLES_DIR.exists():
    app.mount("/examples", StaticFiles(directory=EXAMPLES_DIR), name="examples")


# ---------------------------------------------------------------------------
# GPU Space health (polled by the UI every 2 s — cached to avoid hammering)
# ---------------------------------------------------------------------------

_status_cache: dict = {"ts": 0.0, "data": None}


async def _check_space() -> dict:
    """Lightweight reachability check of the ZeroGPU Space."""
    now = time.time()
    if _status_cache["data"] is not None and now - _status_cache["ts"] < 15:
        return _status_cache["data"]

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(HEALTH_URL)
            r.raise_for_status()
        data = {
            "state": "ready",
            "message": f"GPU backend reachable · {GPU_SPACE_URL}",
            "device": "ZeroGPU (huggingface.co)",
            "space_url": GPU_SPACE_URL,
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("GPU Space health check failed: %s", exc)
        data = {
            "state": "error",
            "message": f"GPU backend unreachable: {exc}",
            "device": None,
            "space_url": GPU_SPACE_URL,
        }

    _status_cache["ts"] = now
    _status_cache["data"] = data
    return data


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _decode_image(upload: UploadFile, field: str) -> Image.Image:
    """Read an uploaded image and convert it to an RGB PIL image."""
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail=f"`{field}` is empty")
    try:
        with Image.open(io.BytesIO(data)) as im:
            im.load()
            return im.convert("RGB")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"`{field}` is not a valid image: {exc}") from exc


def _pil_to_png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _flatten_gallery(value) -> list[str]:
    """Normalize the many shapes Gradio uses for a gr.Gallery output value."""
    if isinstance(value, str):
        return [value]
    if not isinstance(value, list):
        return []

    flat: list[str] = []
    for item in value:
        if isinstance(item, str):
            flat.append(item)
        elif isinstance(item, (list, tuple)) and item and isinstance(item[0], str):
            # [url, caption] pair
            flat.append(item[0])
        elif isinstance(item, dict):
            # Gradio 5 file object: {"image": {"path": ..., "url": ...}, ...}
            img = item.get("image") or item.get("url") or item.get("path")
            if isinstance(img, dict):
                url = img.get("url") or img.get("path")
                if url:
                    flat.append(url)
            elif isinstance(img, str):
                flat.append(img)
    return flat


def _extract_image_urls(event: dict) -> list[str]:
    """Pull the output image list out of a Gradio SSE event, regardless of shape."""
    payload = event if isinstance(event, dict) else {}
    # Prefer the wrapped output payload, then fall back to the top-level data.
    candidates = []
    out = payload.get("output")
    if isinstance(out, dict):
        if "data" in out:
            candidates.append(out.get("data"))
    if "data" in payload:
        candidates.append(payload.get("data"))

    for data in candidates:
        if not isinstance(data, list) or not data:
            continue
        urls = _flatten_gallery(data[0])
        if urls:
            return urls
    return []


def _resolve_url(url: str) -> str:
    """Make a Gradio-returned URL usable by the browser."""
    if url.startswith("data:"):
        return url
    if url.startswith("/file=") or url.startswith("file="):
        return f"{GPU_SPACE_URL}/{url.removeprefix('/')}"
    return url


def _is_retryable(event: dict, status_code: int) -> bool:
    if status_code in (429, 502, 503, 504):
        return True
    msg = str(event.get("msg", ""))
    if msg == "queue_full" or "busy" in msg.lower():
        return True
    return False


async def _call_gradio_once(
    client: httpx.AsyncClient,
    person_png: bytes,
    garment_png: bytes,
    fields: dict,
) -> tuple[list[str], bool]:
    """POST one request to the Gradio call API and parse the SSE stream.

    Returns (images, retryable). ``images`` is empty when the job needs a
    retry (queue full / rate limited), and ``retryable`` tells the caller
    whether a retry is worth it.
    """
    files = {
        "person_image": ("person.png", person_png, "image/png"),
        "garment_image": ("garment.png", garment_png, "image/png"),
    }

    async with client.stream(
        "POST",
        GRADIO_CALL_URL,
        files=files,
        data=fields,
        timeout=httpx.Timeout(connect=30.0, read=600.0, write=60.0, pool=30.0),
    ) as resp:
        if resp.status_code != 200:
            body = (await resp.aread()).decode(errors="replace")[:500]
            logger.warning("Gradio call failed: HTTP %s — %s", resp.status_code, body)
            retryable = _is_retryable({}, resp.status_code)
            try:
                err = json.loads(body)
                detail = err.get("error") or err.get("detail") or body
            except json.JSONDecodeError:
                detail = body or f"HTTP {resp.status_code}"
            raise HTTPException(
                status_code=503 if retryable else 502,
                detail=f"GPU backend error ({resp.status_code}): {detail}",
            )

        content_type = resp.headers.get("content-type", "")
        if "text/event-stream" not in content_type:
            body = (await resp.aread()).decode(errors="replace")
            try:
                payload = json.loads(body)
            except json.JSONDecodeError:
                payload = {}
            urls = _extract_image_urls(payload)
            if urls:
                return urls, False
            raise HTTPException(status_code=502, detail=f"Unexpected Gradio response: {body[:200]}")

        async for line in resp.aiter_lines():
            if not line.startswith("data:"):
                continue
            raw = line[5:].strip()
            if not raw:
                continue
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg = str(event.get("msg", ""))
            event_type = str(event.get("event_type", ""))

            if msg == "queue_full":
                return [], True
            if msg == "error" or event_type == "error":
                detail = event.get("error") or event.get("detail") or raw
                raise HTTPException(status_code=502, detail=f"GPU backend error: {detail}")

            is_done = msg.endswith("completed") or event_type == "complete"
            if not is_done:
                continue

            urls = _extract_image_urls(event)
            if not urls:
                logger.warning("Gradio completed with no parseable images: %s", raw[:300])
                return [], True
            return [_resolve_url(u) for u in urls], False

        # Stream ended without a complete event
        return [], True


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/healthz", include_in_schema=False)
async def healthz():
    return {"ok": True}


@app.get("/api/status")
async def status():
    """Health / model-loading status, polled by the UI."""
    info = await _check_space()
    return {
        "state": info["state"],
        "message": info["message"],
        "device": info["device"],
        "space_url": info["space_url"],
        "categories": list(CATEGORIES),
        "garment_photo_types": list(PHOTO_TYPES),
    }


@app.get("/api/examples")
async def examples():
    """Return URLs for the bundled example images (model + garment)."""
    files: dict[str, str] = {}
    for name in ("model.webp", "garment.webp"):
        if (EXAMPLES_DIR / name).exists():
            files[name] = f"/examples/{name}"
    return files


@app.post("/api/tryon")
async def tryon(
    person_image: UploadFile = File(..., description="Photo of the person"),
    garment_image: UploadFile = File(..., description="Photo of the garment"),
    category: str = Form("tops", description="tops | bottoms | one-pieces"),
    garment_photo_type: str = Form("model", description="model | flat-lay"),
    num_samples: int = Form(1, description="Number of outputs to generate (1-4)"),
    num_timesteps: int = Form(30, description="Diffusion steps (10-30 on ZeroGPU)"),
    guidance_scale: float = Form(1.5, description="Classifier-free guidance strength"),
    seed: int = Form(42, description="Random seed for reproducibility"),
    segmentation_free: bool = Form(True, description="Segmentation-free mode"),
):
    if category not in CATEGORIES:
        raise HTTPException(status_code=400, detail=f"category must be one of {CATEGORIES}")
    if garment_photo_type not in PHOTO_TYPES:
        raise HTTPException(status_code=400, detail=f"garment_photo_type must be one of {PHOTO_TYPES}")
    num_samples = max(1, min(4, num_samples))
    # ZeroGPU has a hard 120 s per-call limit — cap steps to stay within it.
    num_timesteps = max(10, min(30, num_timesteps))
    guidance_scale = max(0.0, min(5.0, guidance_scale))

    person_img = await _decode_image(person_image, "person_image")
    garment_img = await _decode_image(garment_image, "garment_image")

    logger.info(
        "tryon request: category=%s photo_type=%s samples=%d steps=%d guidance=%.2f seed=%d seg_free=%s",
        category, garment_photo_type, num_samples, num_timesteps, guidance_scale, seed, segmentation_free,
    )

    person_png = _pil_to_png_bytes(person_img)
    garment_png = _pil_to_png_bytes(garment_img)

    fields = {
        "category": category,
        "garment_photo_type": garment_photo_type,
        "num_samples": str(num_samples),
        "num_timesteps": str(num_timesteps),
        "guidance_scale": str(guidance_scale),
        "seed": str(seed),
        "segmentation_free": "true" if segmentation_free else "false",
    }

    attempt = 0
    while attempt < GPU_MAX_ATTEMPTS:
        attempt += 1
        retryable = False
        try:
            async with httpx.AsyncClient() as client:
                images, retryable = await _call_gradio_once(client, person_png, garment_png, fields)
            if images:
                logger.info("Generated %d image(s) via %s (attempt %d)", len(images), GPU_SPACE_URL, attempt)
                return {"images": images}
        except HTTPException as exc:
            if exc.status_code == 503 and attempt < GPU_MAX_ATTEMPTS:
                logger.warning("Retryable failure on attempt %d: %s", attempt, exc.detail)
                retryable = True
            else:
                raise

        if retryable and attempt < GPU_MAX_ATTEMPTS:
            wait = 8 * attempt
            logger.info("GPU backend busy — retrying in %ds (attempt %d/%d)", wait, attempt + 1, GPU_MAX_ATTEMPTS)
            await asyncio.sleep(wait)

    raise HTTPException(
        status_code=503,
        detail="The GPU backend is busy (queue full). Please wait a moment and try again.",
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=7860)