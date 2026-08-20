# My Heart — Virtual Try-On Web App

A self-contained web interface for the **My Heart** virtual try-on experience.
A FastAPI server wraps the `TryOnPipeline` inference pipeline and serves a
modern single-page frontend (no build step, no Node.js required).

## Quick start

```bash
# from the repo root
.venv/bin/pip install -e ".[web]"     # installs fastapi + uvicorn + python-multipart
.venv/bin/python webapp/server.py     # starts server on http://0.0.0.0:8000
```

Then open <http://127.0.0.1:8000> in a browser.

Alternative:

```bash
cd webapp
../.venv/bin/uvicorn server:app --host 0.0.0.0 --port 8000
```

## Configuration

| Environment variable | Default          | Description                                  |
|----------------------|------------------|----------------------------------------------|
| `VTON_WEIGHTS_DIR`   | `<repo>/weights` | Directory with `model.safetensors` + `dwpose/` |
| `VTON_DEVICE`        | auto-detect      | e.g. `cuda`, `cuda:0`, `cpu`                 |

The model weights are loaded **in the background** on server start, so the page
loads instantly and shows a live "Loading model…" status chip until inference is
ready. On a machine with a working GPU this is near-instant; on CPU it takes a
minute or two, and each 30-step generation can take tens of minutes.

## API

| Method | Path             | Description                                                      |
|--------|------------------|------------------------------------------------------------------|
| GET    | `/`              | The web UI                                                        |
| GET    | `/api/status`    | Model load state (`loading` / `ready` / `error`), device, options |
| GET    | `/api/examples`  | URLs of the bundled example images (`model.webp`, `garment.webp`) |
| POST   | `/api/tryon`     | Multipart form upload → JSON `{ "images": ["data:image/png;base64,…"] }` |

### POST /api/tryon — form fields

| Field                | Type    | Default | Description                                    |
|----------------------|---------|---------|------------------------------------------------|
| `person_image`       | file    | —       | Photo of the person (required)                 |
| `garment_image`      | file    | —       | Photo of the garment (required)                |
| `category`           | string  | `tops`  | `tops` \| `bottoms` \| `one-pieces`            |
| `garment_photo_type` | string  | `model` | `model` (worn) \| `flat-lay` (product shot)    |
| `num_samples`        | int     | `1`     | 1–4 output images                              |
| `num_timesteps`      | int     | `30`    | Diffusion steps (20 fast, 30 balanced, 50 quality) |
| `guidance_scale`     | float   | `1.5`   | CFG strength                                   |
| `seed`               | int     | `42`    | Reproducibility seed                           |
| `segmentation_free`  | bool    | `true`  | Recommended body-preserving mode               |

### Example

```bash
curl -X POST http://127.0.0.1:8000/api/tryon \
  -F "person_image=@examples/data/model.webp" \
  -F "garment_image=@examples/data/garment.webp" \
  -F "category=tops" \
  -F "garment_photo_type=model" \
  -F "num_timesteps=20" \
  > response.json
```

## Files

```
webapp/
├── server.py          # FastAPI backend (model wrapper + API + static serving)
└── static/
    ├── index.html     # the single-page UI
    ├── styles.css     # dark themed styling
    └── app.js         # uploads, options, status polling, try-on + results
```

Inference results are returned as base64 data URLs (no files are written to
disk) and rendered as **before/after comparison sliders** with per-image
**download** actions and a **new variation** (random seed) shortcut.

> **Note on CPU:** the diffusion model is ~2 GB. Without a working CUDA device,
> generation is slow (roughly a minute per diffusion step on a typical CPU).
> Install a recent NVIDIA driver / PyTorch CUDA build to get interactive speeds —
> the server automatically detects and uses CUDA when available.

## Offline / air-gapped use

The web app is fully self-contained — **no network is required at runtime** once
the model files are in place. The only runtime component that used to be
downloaded (the human-parser weights, ~247 MB, from HuggingFace) has been
pre-cached into `hf_cache/` inside the project.

### What the zip must contain

| Path                | Size   | Needed for                                          |
|---------------------|--------|-----------------------------------------------------|
| `webapp/`           | ~50 KB | Server + UI (code)                                  |
| `src/`, `pyproject.toml` | — | Python package source                        |
| `examples/data/`    | 188 KB | Sample photos for the "Use example photos" button   |
| `weights/`          | 2.2 GB | TryOn model (`model.safetensors`) + DWPose ONNX models |
| `hf_cache/`         | 247 MB | Human-parser weights (HuggingFace cache)            |
| `.venv/`            | 7.9 GB | Python environment with torch + CUDA + FastAPI (see portability note) |
| `requirements.txt`  | —      | Pinned deps for offline `pip install` on new machines |

Total: **~10.5 GB** without the venv, **~18 GB** with it (uncompressed).

### How it stays offline

`webapp/server.py` automatically detects a bundled `hf_cache/` directory and sets:

- `HF_HOME=<project>/hf_cache`
- `HF_HUB_OFFLINE=1`
- `TRANSFORMERS_OFFLINE=1`

so the human parser loads its weights from disk and never phones home.
DWPose and the main TryOn model always load from `weights/` on disk.

If you'd rather keep the cache outside the project, set the same variables
manually before starting the server:

```bash
export HF_HOME=/path/to/hf_cache
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export VTON_WEIGHTS_DIR=/path/to/weights
```

### Option A — same machine / same platform (recommended)

Copy the whole project (including `.venv/`) to the target machine and run:

```bash
cd <project>
.venv/bin/python webapp/server.py   # serves on http://0.0.0.0:8000
```

**Portability caveat:** a venv is only guaranteed to work on the same
**OS + CPU architecture + Python version** it was created on. This venv needs
Python 3.10 at `/usr/bin/python3.10` and an NVIDIA GPU with a driver that
supports CUDA 12.4 (driver ≥ 550).

> ⚠️ **If the project folder is renamed or moved**, the venv's *editable
> install* of the Python package keeps pointing at the old absolute path and
> the server fails with `ModuleNotFoundError: No module named 'fashn_vton'`.
> Fix it by re-registering the package after any move:

```bash
cd <new-location>
.venv/bin/pip install -e .
```

> (Alternative: edit `.venv/lib/python3.10/site-packages/__editable__.fashn_vton-1.5.0.pth`
> and update the `src` path on its single line.)


### Option B — new machine with no matching venv

On an **online** machine with the same OS/Python, prepare an offline wheel
bundle:

```bash
.venv/bin/pip download -r requirements.txt -d wheels/
```

Copy `wheels/` + `requirements.txt` + the source (minus `.venv/`) to the
offline machine, then:

```bash
python3.10 -m venv .venv
.venv/bin/pip install --no-index --find-links wheels/ -r requirements.txt
.venv/bin/pip install -e .          # installs the local package (no network)
.venv/bin/python webapp/server.py
```

> `requirements.txt` is generated from the current environment (`pip freeze`)
> and pins torch `2.6.0+cu124` — make sure the target GPU driver supports
> CUDA 12.4. For a CPU-only target, swap the torch/torchvision lines for the
> CPU builds before downloading wheels.

### Browser fonts

The UI references the Inter font from Google Fonts for nicer typography. When
offline, it falls back to the system font stack automatically — no action
needed. To fully drop the network request, remove the two
`fonts.googleapis.com` `<link>` tags in `webapp/static/index.html`.


