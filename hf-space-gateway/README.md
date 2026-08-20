---
title: My Heart VTON Gateway
emoji: 🛍️
colorFrom: indigo
colorTo: pink
sdk: docker
app_port: 7860
pinned: false
short_description: FastAPI gateway + UI for the My Heart virtual try-on app (ZeroGPU backend)
---

# My Heart — Virtual Try-On (Gateway Space)

Browser-facing FastAPI app that serves the full try-on UI and forwards
`/api/tryon` to the ZeroGPU inference Space
(`muse0515/my-heart-vton-zerogpu`) via Gradio's REST API
(`/gradio_api/call/run_tryon`).

## Layout

```
hf-space-gateway/
├── Dockerfile        # Python 3.11 slim + uvicorn (CPU only — no torch)
├── requirements.txt  # fastapi, uvicorn, httpx, pillow, python-multipart
├── server.py         # FastAPI app (static UI + proxy to the GPU Space)
├── static/           # webapp/static/ copied in (unchanged UI)
└── examples/data/    # model.webp + garment.webp (for "Use example photos")
```

## Deployment

1. Create a **new** (empty) Space on https://huggingface.co/new-space
   - Owner: `muse0515`
   - Space name: `my-heart-vton-gateway`
   - SDK: **Docker**
   - Space hardware: **CPU Basic · 2 vCPU · 16 GB** (free)
   - Visibility: Public
2. The default `VTON_GPU_SPACE_URL` already points at
   `https://muse0515-my-heart-vton-zerogpu.hf.space`. If you used a different
   ZeroGPU Space name, set the `VTON_GPU_SPACE_URL` secret under
   **Settings → Variables and secrets**.
3. Push this folder:

   ```bash
   cd hf-space-gateway
   git init
   git remote add origin https://huggingface.co/spaces/muse0515/my-heart-vton-gateway
   git add .
   git commit -m "Gateway Space"
   git push origin main
   ```

4. Open the Space URL — you should see the full try-on UI. The status chip in
   the top bar goes green once the ZeroGPU Space is reachable.

> The gateway is deliberately tiny (no torch, no model weights) so builds and
> cold starts are fast.

## Environment variables

| Variable                | Default                                        | Description                          |
|-------------------------|------------------------------------------------|--------------------------------------|
| `VTON_GPU_SPACE_URL`    | `https://muse0515-my-heart-vton-zerogpu.hf.space` | ZeroGPU Space root URL (no slash)  |
| `VTON_GPU_FN`           | `run_tryon`                                    | Gradio function name                 |
| `VTON_GPU_MAX_ATTEMPTS` | `4`                                            | Retries on queue-full / rate-limits  |