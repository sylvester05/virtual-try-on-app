---
title: My Heart VTON Gateway
emoji: 🛍️
colorFrom: indigo
colorTo: pink
sdk: static
pinned: false
short_description: Custom static UI for the My Heart virtual try-on app
---

# My Heart — Virtual Try-On (Gateway Space)

Serves the full custom try-on UI as a **free Static Space**, and connects
directly to the ZeroGPU inference Space
(`muse0515/my-heart-vton-zerogpu`) from the browser via the official
`@gradio/client` library.

No API server, no CORS issues, no Docker needed:

```
Browser (this Static Space — free)
   │  @gradio/client → /gradio_api/call/run_tryon
   ▼
my-heart-vton-zerogpu (ZeroGPU Space — free) → TryOnPipeline → images
```

## Files

```
hf-space-gateway/
├── index.html    # full custom UI
├── styles.css    # dark theme
└── app.js        # @gradio/client → ZeroGPU Space
```

## Deployment

1. Create a new (empty) Space on https://huggingface.co/new-space
   - Owner: `muse0515`
   - Space name: `my-heart-vton-gateway`
   - SDK: **Static**
   - Visibility: Public
2. Push this folder:

   ```bash
   cd hf-space-gateway
   git init
   git remote add origin https://huggingface.co/spaces/muse0515/my-heart-vton-gateway
   git add .
   git commit -m "Gateway Static Space"
   git push origin main
   ```

3. Open the Space URL — you should see the full try-on UI. The status chip in
   the top bar goes green once the ZeroGPU Space is reachable.

> The gateway is a static site: `index.html` + `styles.css` + `app.js`, with
> `@gradio/client` loaded from the jsDelivr CDN. No build step.

## Configuration

The ZeroGPU Space URL is a constant in `app.js`:

```js
const GRADIO_SPACE_URL = "https://muse0515-my-heart-vton-zerogpu.hf.space";
```

If you rename the GPU Space, update this constant and push.

## How the API call works

```js
const { Client } = window.gradio;
const app = await Client.connect(GRADIO_SPACE_URL);
const result = await app.predict("/run_tryon", {
  person_image: file,
  garment_image: file,
  category: "tops",
  garment_photo_type: "model",
  num_samples: 1,
  num_timesteps: 20,
  guidance_scale: 1.5,
  seed: 42,
  segmentation_free: true,
});
```

## Notes

- If the ZeroGPU Space is sleeping, the first call after a cold start can take
  a minute or two to wake the model — the UI shows a "warming up" state.
- Generation steps are capped at 30 client-side to stay within ZeroGPU's
  per-call budget.
- The **Use example photos** button loads the stock `model.webp`/`garment.webp`
  from the upstream FASHN repo's `raw.githubusercontent.com` URLs (which send
  CORS headers) and drops them into the upload slots so you can try a
  generation instantly. Binary image files are deliberately NOT committed to
  this Space repo — Hugging Face's pre-receive hook rejects non-LFS binaries.
