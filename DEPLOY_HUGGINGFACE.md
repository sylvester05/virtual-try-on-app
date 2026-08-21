# Deploying to Hugging Face Spaces

This app is split across **two free Hugging Face Spaces** — no Docker, no PRO
subscription needed:

```
Browser ──► my-heart-vton-gateway (Static Space — free, HTML/JS/CSS)
            │  custom UI calls the GPU Space directly
            │  @gradio/client → /gradio_api/call/run_tryon
            ▼
        my-heart-vton-zerogpu (ZeroGPU Space — free, Gradio)
            TryOnPipeline → base64 PNGs
```

- **`hf-space-gpu/`** — GPU Space. Self-contained Gradio repo (vendored `src/` +
  `pyproject.toml`, plus a `requirements.txt` that installs ZeroGPU-supported
  torch first). Downloads ~2.3 GB of model weights on first cold start into
  `weights/` + `hf_cache/`.
- **`hf-space-gateway/`** — Static Space. Your existing custom UI
  (`index.html`, `styles.css`, `app.js`), now talking to the GPU Space through
  the official `@gradio/client` JS library. No backend server needed.

---

## 1. Create + deploy the GPU Space ("my-heart-vton-zerogpu")

1. Create a Space: https://huggingface.co/new-space
   - Owner: `muse0515`
   - Space name: `my-heart-vton-zerogpu`
   - SDK: **Gradio**
   - Hardware: **Free (ZeroGPU)**
   - Visibility: Public (needed so the browser can call it without a token)
2. Push the folder:

   ```bash
   cd hf-space-gpu
   git init
   git remote add origin https://huggingface.co/spaces/muse0515/my-heart-vton-zerogpu
   git add .
   git commit -m "ZeroGPU inference Space"
   git push origin main
   ```

3. First build installs ZeroGPU-compatible torch (2.9.1) + deps (~5–10 min).
   The first cold start after that downloads the model weights (~2.3 GB).
   Verify at `https://muse0515-my-heart-vton-zerogpu.hf.space` — you should see
   a minimal Gradio demo with two image inputs.

> The ZeroGPU `@spaces.GPU(duration=110)` decorator allocates the GPU for up to
> 110 s per call — enough for a 20–30 step generation.

## 2. Create + deploy the gateway Space ("my-heart-vton-gateway")

1. Create a Space: https://huggingface.co/new-space
   - Owner: `muse0515`
   - Space name: `my-heart-vton-gateway`
   - SDK: **Static**
   - Visibility: Public
2. Push the folder:

   ```bash
   cd hf-space-gateway
   git init
   git remote add origin https://huggingface.co/spaces/muse0515/my-heart-vton-gateway
   git add .
   git commit -m "Gateway Static Space"
   git push origin main
   ```

3. Open `https://muse0515-my-heart-vton-gateway.hf.space`. The status chip in
   the top bar goes green once the GPU Space is reachable.

## 3. Configuration

The GPU Space URL is a constant at the top of `hf-space-gateway/app.js`:

```js
const GRADIO_SPACE_URL = "https://muse0515-my-heart-vton-zerogpu.hf.space";
```

Rename the GPU Space? Update this constant and push the gateway again.

## Behavior notes

- **Direct browser call:** public Gradio Spaces expose CORS-enabled API
  endpoints, so `@gradio/client` can call the ZeroGPU Space from the static
  page — no backend, no token, no CORS workarounds.
- **Steps capped at 30**: the UI slider runs 10–30 steps to stay inside
  ZeroGPU's per-call budget (120 s). The default is 20 for snappier results.
- **Cold starts:** after ~5–15 min of inactivity the GPU Space sleeps. The
  first request after a cold start can take a few minutes (pipeline reload).
  The status chip polls every few seconds and reflects the current state.
- **Queueing:** ZeroGPU queues jobs when the GPU is busy. Retry a moment later
  if you see a queue/busy error.
- **Example photos:** `examples/data/` is gitignored in this repo, so the
  "Use example photos" button is unavailable on HF by default. The UI degrades
  gracefully with a toast. To enable it, host `model.webp` + `garment.webp`
  somewhere HTTP-reachable (e.g. a public HF dataset repo) and point
  `app.js`'s example URLs at them.

## Local smoke test of the gateway (no GPU needed)

Because the gateway is plain HTML/JS, just open `hf-space-gateway/index.html`
in a browser (or serve it with any static file server, e.g. `python -m
http.server`). The UI will load; the status chip will turn error until the GPU
Space is deployed and reachable.

## Alternatives

- Need longer generations or no queueing? Upgrade the ZeroGPU Space to a paid
  T4 (Settings → Space Hardware) — no code changes needed.
- Want the gateway elsewhere (any static host — Vercel, GitHub Pages, Netlify)?
  Just host the `hf-space-gateway/` files anywhere and point `GRADIO_SPACE_URL`
  at the ZeroGPU Space URL.