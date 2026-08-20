"""My Heart — Virtual Try-On: ZeroGPU inference Space.

A minimal Gradio app whose only job is to serve the FASHN VTON v1.5
``TryOnPipeline`` to a remote FastAPI gateway.

The Gradio REST API (``/gradio_api/call/run_tryon``) is what the gateway
(``hf-space-gateway/server.py``) talks to — nobody uses this UI directly.
"""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path

import gradio as gr
import spaces

logger = logging.getLogger("myheart-hf-gpu")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent

# The Space repo ships a vendored copy of the package (src/ + pyproject.toml),
# so `pip install -e .` makes `import fashn_vton` resolve to this folder.
WEIGHTS_DIR = Path(os.environ.get("VTON_WEIGHTS_DIR", BASE_DIR / "weights"))
WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)

# Keep the human-parser download inside the Space so it survives cold starts.
os.environ.setdefault("HF_HOME", str(BASE_DIR / "hf_cache"))


def _ensure_weights() -> None:
    """Download the ~2 GB of model files if they're not already present."""
    tryon = WEIGHTS_DIR / "model.safetensors"
    yolox = WEIGHTS_DIR / "dwpose" / "yolox_l.onnx"
    dwpose = WEIGHTS_DIR / "dwpose" / "dw-ll_ucoco_384.onnx"

    if all(p.exists() for p in (tryon, yolox, dwpose)):
        logger.info("Weights already present")
        return

    from huggingface_hub import hf_hub_download

    logger.info("Downloading TryOnModel (model.safetensors, ~2 GB)…")
    hf_hub_download(
        repo_id="fashn-ai/fashn-vton-1.5",
        filename="model.safetensors",
        local_dir=str(WEIGHTS_DIR),
    )
    logger.info("Downloading DWPose ONNX models…")
    for fname in ("yolox_l.onnx", "dw-ll_ucoco_384.onnx"):
        hf_hub_download(
            repo_id="fashn-ai/DWPose",
            filename=fname,
            local_dir=str(WEIGHTS_DIR / "dwpose"),
        )
    logger.info("All weights downloaded")


_PIPELINE = None
_PIPELINE_LOCK = threading.Lock()


def _load_pipeline():
    """Load *and keep* the pipeline (weights are big; load once, reuse)."""
    global _PIPELINE
    if _PIPELINE is not None:
        return _PIPELINE
    with _PIPELINE_LOCK:
        if _PIPELINE is not None:
            return _PIPELINE
        _ensure_weights()
        from fashn_vton import TryOnPipeline

        logger.info("Instantiating TryOnPipeline (this is the slow part)…")
        _PIPELINE = TryOnPipeline(weights_dir=str(WEIGHTS_DIR))
        logger.info("Pipeline ready on %s", _PIPELINE.device)
        return _PIPELINE


def _unpad(images: list, pad_fn) -> list:
    """Remove the padding the pipeline added, to hand back nicely cropped images."""
    return [pad_fn.unpad(img) for img in images]


@spaces.GPU(duration=100)
def run_tryon(
    person_image,
    garment_image,
    category: str = "tops",
    garment_photo_type: str = "model",
    num_samples: int = 1,
    num_timesteps: int = 20,
    guidance_scale: float = 1.5,
    seed: int = 42,
    segmentation_free: bool = True,
):
    """Run one try-on generation and return PNG base64 data URLs."""
    import base64
    import io

    from PIL import Image

    logger.info(
        "run_tryon: category=%s photo_type=%s samples=%d steps=%d guidance=%.2f seed=%d seg_free=%s",
        category, garment_photo_type, num_samples, num_timesteps, guidance_scale, seed, segmentation_free,
    )

    # Gradio passes file paths by default; accept both.
    if isinstance(person_image, (str, os.PathLike)):
        person_image = Image.open(person_image).convert("RGB")
    if isinstance(garment_image, (str, os.PathLike)):
        garment_image = Image.open(garment_image).convert("RGB")

    pipe = _load_pipeline()
    result = pipe(
        person_image=person_image,
        garment_image=garment_image,
        category=category,
        garment_photo_type=garment_photo_type,
        num_samples=num_samples,
        num_timesteps=num_timesteps,
        guidance_scale=guidance_scale,
        seed=seed,
        segmentation_free=segmentation_free,
    )
    # Unpad each output so the result isn't letter-boxed with black borders.
    images = _unpad(result.images, pipe.resize_pad_fn)

    out = []
    for img in images:
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        out.append(f"data:image/png;base64,{base64.b64encode(buf.getvalue()).decode('ascii')}")
    return out


demo = gr.Interface(
    fn=run_tryon,
    inputs=[
        gr.Image(type="pil", label="Person photo (required)"),
        gr.Image(type="pil", label="Garment photo (required)"),
        gr.Dropdown(["tops", "bottoms", "one-pieces"], value="tops", label="Category"),
        gr.Radio(["model", "flat-lay"], value="model", label="Garment photo type"),
        gr.Slider(1, 4, value=1, step=1, label="Number of samples"),
        gr.Slider(10, 50, value=20, step=1, label="Diffusion steps"),
        gr.Slider(0.0, 5.0, value=1.5, step=0.1, label="Guidance scale"),
        gr.Number(value=42, precision=0, label="Seed"),
        gr.Checkbox(value=True, label="Segmentation-free"),
    ],
    outputs=gr.Gallery(label="Try-on results"),
    title="My Heart — Virtual Try-On (API backend)",
    description=(
        "GPU inference endpoint for the My Heart virtual try-on app. "
        "This UI is intentionally minimal — the FastAPI gateway calls this "
        "Space's Gradio API (`/gradio_api/call/run_tryon`) and presents the "
        "results in the full web app."
    ),
    allow_flagging="never",
)

demo.queue(default_concurrency_limit=1).launch()