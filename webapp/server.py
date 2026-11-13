"""My Heart — Virtual Try-On. FastAPI web server.

Wraps the repository's virtual try-on pipeline behind a small REST API and
serves the web UI from ``webapp/static``.

Run (from anywhere):

    .venv/bin/python webapp/server.py            # http://127.0.0.1:8000
    .venv/bin/uvicorn server:app --host 0.0.0.0 --port 8000   # from webapp/

Environment variables:
    VTON_WEIGHTS_DIR    Path to model weights (default: <repo>/weights)
    VTON_DEVICE         Torch device override, e.g. "cuda", "cpu"
"""

from __future__ import annotations

import base64
import io
import logging
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from starlette.concurrency import run_in_threadpool

# ---------------------------------------------------------------------------
# Paths / configuration
# ---------------------------------------------------------------------------

WEBAPP_DIR = Path(__file__).resolve().parent
ROOT_DIR = WEBAPP_DIR.parent
STATIC_DIR = WEBAPP_DIR / "static"
EXAMPLES_DIR = ROOT_DIR / "examples" / "data"
WEIGHTS_DIR = Path(os.environ.get("VTON_WEIGHTS_DIR", ROOT_DIR / "weights"))
DEVICE_OVERRIDE = os.environ.get("VTON_DEVICE") or None

# Offline support: if a bundled HuggingFace cache ships with the project
# (e.g. ``hf_cache/`` created from an online machine's ``~/.cache/huggingface``),
# point huggingface_hub / transformers at it and force offline mode so the
# human-parser weights load without any network access. This MUST happen before
# ``fashn_vton`` is imported (importing it pulls in huggingface_hub, which reads
# these variables at import time).
HF_CACHE_DIR = ROOT_DIR / "hf_cache"
if HF_CACHE_DIR.exists():
    os.environ.setdefault("HF_HOME", str(HF_CACHE_DIR))
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

# NOTE: imported after the offline env vars are configured.
from fashn_vton import TryOnPipeline  # noqa: E402


CATEGORIES = ("tops", "bottoms", "one-pieces")
PHOTO_TYPES = ("model", "flat-lay")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("myheart-web")

# ---------------------------------------------------------------------------
# Pipeline lifecycle: load once in a background thread so the server starts
# instantly and the UI can show loading progress while models warm up.
# ---------------------------------------------------------------------------

pipeline: TryOnPipeline | None = None
_pipeline_lock = threading.Lock()
load_state: dict = {"state": "loading", "message": "Starting…", "device": None}


def _load_pipeline_worker() -> None:
    """Load the TryOnPipeline and update ``load_state``."""
    global pipeline
    try:
        with _pipeline_lock:
            if pipeline is not None:
                return
            load_state["state"] = "loading"
            load_state["message"] = "Initializing models (this can take a minute)…"
            logger.info("Loading TryOnPipeline from %s", WEIGHTS_DIR)
            pipe = TryOnPipeline(weights_dir=str(WEIGHTS_DIR), device=DEVICE_OVERRIDE)
            pipeline = pipe
            load_state["state"] = "ready"
            load_state["device"] = str(pipe.device)
            load_state["message"] = f"Ready · {pipe.device}"
            logger.info("Pipeline ready on %s", pipe.device)
    except Exception as exc:  # noqa: BLE001 - surface any load failure to the UI
        load_state["state"] = "error"
        load_state["message"] = str(exc)
        logger.exception("Failed to load pipeline")


@asynccontextmanager
async def lifespan(_: FastAPI):
    thread = threading.Thread(target=_load_pipeline_worker, daemon=True, name="model-loader")
    thread.start()
    yield


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="My Heart — Virtual Try-On", version="1.5.0", lifespan=lifespan)
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
# Helpers
# ---------------------------------------------------------------------------

def _require_pipeline() -> TryOnPipeline:
    if pipeline is None:
        raise HTTPException(status_code=503, detail=f"Model is not ready: {load_state['message']}")
    return pipeline


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


def _pil_to_data_url(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/status")
async def status():
    """Health / model-loading status, polled by the UI."""
    return {
        "state": load_state["state"],
        "message": load_state["message"],
        "device": load_state["device"],
        "categories": list(CATEGORIES),
        "garment_photo_types": list(PHOTO_TYPES),
    }


@app.get("/api/examples")
async def examples():
    """Return URLs for the bundled example images (model + garment)."""
    files: dict[str, str] = {}
    for name in ("model.jpg", "garment.jpg"):
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
    num_timesteps: int = Form(30, description="Diffusion steps (20-50)"),
    guidance_scale: float = Form(1.5, description="Classifier-free guidance strength"),
    seed: int = Form(42, description="Random seed for reproducibility"),
    segmentation_free: bool = Form(True, description="Segmentation-free mode"),
):
    pipe = _require_pipeline()

    if category not in CATEGORIES:
        raise HTTPException(status_code=400, detail=f"category must be one of {CATEGORIES}")
    if garment_photo_type not in PHOTO_TYPES:
        raise HTTPException(status_code=400, detail=f"garment_photo_type must be one of {PHOTO_TYPES}")
    num_samples = max(1, min(4, num_samples))
    num_timesteps = max(10, min(100, num_timesteps))
    guidance_scale = max(0.0, min(5.0, guidance_scale))

    person_img = await _decode_image(person_image, "person_image")
    garment_img = await _decode_image(garment_image, "garment_image")

    logger.info(
        "tryon request: category=%s photo_type=%s samples=%d steps=%d guidance=%.2f seed=%d seg_free=%s",
        category, garment_photo_type, num_samples, num_timesteps, guidance_scale, seed, segmentation_free,
    )

    try:
        result = await run_in_threadpool(
            pipe,
            person_image=person_img,
            garment_image=garment_img,
            category=category,
            garment_photo_type=garment_photo_type,
            num_samples=num_samples,
            num_timesteps=num_timesteps,
            guidance_scale=guidance_scale,
            seed=seed,
            segmentation_free=segmentation_free,
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("Inference failed")
        raise HTTPException(status_code=500, detail=f"Inference failed: {exc}") from exc

    images = [_pil_to_data_url(img) for img in result.images]
    logger.info("Generated %d image(s)", len(images))
    return {"images": images}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)

