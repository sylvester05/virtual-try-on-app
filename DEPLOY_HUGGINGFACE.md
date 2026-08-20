# Deploying to Hugging Face Spaces

This app is split across **two free Hugging Face Spaces**:

```
Browser ──► my-heart-vton-gateway (CPU Docker Space, free)      my-heart-vton-zerogpu (ZeroGPU Space, free)
            FastAPI + static UI (webapp/static)                    Gradio app → TryOnPipeline
            └─ POST /api/tryon ──────────────────────────────►   /gradio_api/call/run_tryon (SSE)
                   (fastapi ↔ gradio, no CORS, no GPU needed)      returns base64 PNGs
```

- **`hf-space-gpu/`** — GPU Space. Self-contained repo (vendored `src/` + `pyproject.toml`,
  plus a `requirements.txt` that installs CUDA torch first). Downloads ~2.3 GB of model
  weights on first cold start into `weights/` + `hf_cache/`.
- **`hf-space-gateway/`** — CPU Docker Space. Serve the existing UI untouched and proxy
  every `/api/tryon` request to the GPU Space via Gradio's REST API. No torch, tiny image.

---

## 1. Create + deploy the GPU Space ("my-heart-vton-zerogpu")

1. Create a Space: https://huggingface.co/new-space
   - Owner: `muse0515`
   - Space name: `my-heart-vton-zerogpu`
   - SDK: **Gradio**
   - Hardware: **Free (ZeroGPU)**
   - Visibility: Public (needed so the gateway can call it without a token)
2. Push the folder:

   ```bash
   cd hf-space-gpu
   git init
   git remote add origin https://huggingface.co/spaces/muse0515/my-heart-vton-zerogpu
   git add .
   git commit -m "ZeroGPU inference Space"
   git push origin main
   ```

3. First build installs torch (cu124) + deps (~5–10 min). First cold start after
   that downloads the model weights (~2.3 GB). Verify at
   `https://muse0515-my-heart-vton-zerogpu.hf.space` — you should see the minimal
   Gradio demo with two image inputs.

> The ZeroGPU `@spaces.GPU(duration=100)` decorator allocates the GPU for up to
> 100 s per call — enough for a 20-step generation. Keep the gateway's
> `num_timesteps` default at 20–30.

## 2. Create + deploy the gateway Space ("my-heart-vton-gateway")

1. Create a Space: https://huggingface.co/new-space
   - Owner: `muse0515`
   - Space name: `my-heart-vton-gateway`
   - SDK: **Docker**
   - Hardware: **CPU Basic · 2 vCPU · 16 GB** (free)
   - Visibility: Public
2. Push the folder:

   ```bash
   cd hf-space-gateway
   git init
   git remote add origin https://huggingface.co/spaces/muse0515/my-heart-vton-gateway
   git add .
   git commit -m "Gateway Space"
   git push origin main
   ```

3. Open `https://muse0515-my-heart-vton-gateway.hf.space`. The status chip in the
   top bar goes green once the GPU Space is reachable.

## 3. Configuration

The gateway reads these env vars (all optional):

| Variable                 | Default                                        | Description                          |
|--------------------------|------------------------------------------------|--------------------------------------|
| `VTON_GPU_SPACE_URL`     | `https://muse0515-my-heart-vton-zerogpu.hf.space` | ZeroGPU Space root URL (no slash) |
| `VTON_GPU_FN`            | `run_tryon`                                    | Gradio function name                 |
| `VTON_GPU_MAX_ATTEMPTS`  | `4`                                            | Retries on queue-full / rate-limits  |

Set them under **Settings → Variables and secrets** if you rename a Space.

## Behavior notes

- **Steps are capped at 30** by the gateway (`num_timesteps` is clamped to 10–30)
  to stay inside ZeroGPU's 120 s per-call budget. The UI slider still shows up to
  50; anything above 30 is clamped server-side.
- **Queueing:** ZeroGPU queues jobs when the GPU is busy. The gateway retries with
  backoff (8 s, 16 s, 24 s...) up to `VTON_GPU_MAX_ATTEMPTS`, then returns 503.
  The UI shows the error toast and you can just click "Try It On" again.
- **Cold starts:** after ~5–15 min of inactivity the GPU Space sleeps. The first
  request after a cold start can take a few minutes (pipeline reload). The status
  chip on the gateway page reflects the endpoint's reachability (not the model
  load state), so you may also see grey "Connecting…" / red "Server unreachable"
  states.
- **Example photos:** `examples/data/` is gitignored in this repo, so the
  "Use example photos" button is unavailable on HF (the UI degrades gracefully
  with a toast). To enable it, drop `model.webp` + `garment.webp` into
  `hf-space-gateway/examples/data/` and push (they'll be picked up at the next
  Docker build).

## Local smoke test of the gateway (no GPU needed)

```bash
cd hf-space-gateway
python -m venv .venv && . .venv/Scripts/activate   # Windows git-bash
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 7860
```

Then open http://127.0.0.1:7860 — the GPU-space check will fail (not deployed
yet), but the page itself and `/api/status`, `/api/examples` work.

## Alternatives

- Need longer generations or no queueing? Upgrade the ZeroGPU Space to a paid
  T4 (Settings → Space Hardware) — no code changes needed.
- Want the gateway elsewhere (Railway/Render)? Just point `VTON_GPU_SPACE_URL`
  at the ZeroGPU Space URL and run `hf-space-gateway/server.py` there.