# MyHEART VTON v1.5: Efficient Maskless Virtual Try-On in Pixel Space


Virtual try-on model that generates photorealistic images directly in pixel space without requiring segmentation masks.

This repo contains minimal inference code to run virtual try-on with the FASHN VTON v1.5 model weights. Given a person image and a garment image, the model generates a photorealistic image of the person wearing the garment. Supports both model photos and flat-lay product shots as garment inputs.

---

## Recommended Setup on Ubuntu / WSL

Ubuntu 26.04 does not provide a compatible system Python 3.12 package in the default repositories, so the recommended workflow is to use `uv` to install and manage Python 3.12 for this project.

```bash
cd /mnt/c/virtual-try-on-app

# Install uv if needed
curl -LsSf https://astral.sh/uv/install.sh | sh
source $HOME/.local/bin/env

# Install Python 3.12 with uv
uv python install 3.12

# Create a project virtual environment with Python 3.12
uv venv --python 3.12 .venv
source .venv/bin/activate

# Install the project and dependencies
uv pip install -e .
```

If you also want the FastAPI web app dependencies:

```bash
uv pip install -e '.[web]'
```

**Note:** This project supports Python 3.10–3.12. The `pyproject.toml` file declares `requires-python = ">=3.10"` and includes 3.12 support.

### Alternative (plain venv + pip)

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e .
```

**Note:** Installation includes `onnxruntime-gpu` for GPU-accelerated pose detection. Ensure CUDA is properly configured on your system. For CPU-only environments, replace with the CPU version:

```bash
pip uninstall onnxruntime-gpu
pip install onnxruntime
```

---

## Model Weights

Download the required model weights (~2 GB total):

```bash
python scripts/download_weights.py --weights-dir ./weights
```

This downloads:
- `model.safetensors` — TryOnModel weights from [HuggingFace](https://huggingface.co/fashn-ai/fashn-vton-1.5)
- `dwpose/` — DWPose ONNX models for pose detection

**Note:** The human parser weights (~244 MB) are automatically downloaded on first use to the HuggingFace cache folder. Set `HF_HOME` to customize the location.

---

## Usage

```python
from fashn_vton import TryOnPipeline
from PIL import Image

# Initialize pipeline (automatically uses GPU if available)
pipeline = TryOnPipeline(weights_dir="./weights")

# Load images
person = Image.open("examples/data/model.webp").convert("RGB")
garment = Image.open("examples/data/garment.webp").convert("RGB")

# Run inference
result = pipeline(
    person_image=person,
    garment_image=garment,
    category="tops",  # "tops" | "bottoms" | "one-pieces"
)

# Save output
result.images[0].save("output.png")
```

### CLI

```bash
uv run python examples/basic_inference.py \
    --weights-dir ./weights \
    --person-image examples/data/model.webp \
    --garment-image examples/data/garment.webp \
    --category tops
```

**Note:** The pipeline automatically uses GPU if available. The try-on model weights are stored in bfloat16 and will run in bf16 precision on Ampere+ GPUs (RTX 30xx/40xx, A100, H100). On older hardware or CPU, weights are converted to float32.

See [`examples/basic_inference.py`](examples/basic_inference.py) for additional options.

---

## Categories

| Category | Description |
|----------|-------------|
| `tops` | Upper body: t-shirts, blouses, jackets |
| `bottoms` | Lower body: pants, skirts, shorts |
| `one-pieces` | Full body: dresses, jumpsuits |

---


