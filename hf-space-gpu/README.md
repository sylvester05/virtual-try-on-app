---
title: My Heart VTON ZeroGPU
emoji: 🧥
colorFrom: blue
colorTo: pink
sdk: gradio
sdk_version: "4.44.1"
app_file: app.py
pinned: false
short_description: GPU inference backend for the My Heart virtual try-on app
---

# My Heart — Virtual Try-On (ZeroGPU inference Space)

Minimal Gradio Space that hosts the `fashn-vton-1.5` `TryOnPipeline` on a free ZeroGPU instance. It exposes the model through the Gradio API (`/gradio_api/call/run_tryon`) so the custom static UI in `my-heart-vton-gateway` can call it directly from the browser.

## Deployment

1. Create a new (empty) Space on https://huggingface.co/new-space
   - Owner: `muse0515`
   - Space name: `my-heart-vton-zerogpu`
   - SDK: **Gradio**
   - Space hardware: **Free (ZeroGPU)**
   - Visibility: Public
2. Push this folder:

   ```bash
   cd hf-space-gpu
   git init
   git remote add origin https://huggingface.co/spaces/muse0515/my-heart-vton-zerogpu
   git add .
   git commit -m "ZeroGPU inference Space"
   git push origin main
   ```

3. When the build finishes, the Space will be live at
   `https://muse0515-my-heart-vton-zerogpu.hf.space`.

The first cold start downloads ~2.3 GB of weights into `weights/` + `hf_cache/`; subsequent activations reuse them.

> **Note:** the free ZeroGPU tier grants limited daily compute. Heavy use may require upgrading hardware.
