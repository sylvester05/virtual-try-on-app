/* ============================================================
   My Heart — Virtual Try-On frontend logic
   Static site for Hugging Face Spaces.
   Talks directly to the ZeroGPU Space's Gradio REST API (no API server, no
   @gradio/client — that library uses credentials:"include", which HF's static
   gateway origin can't preflight).

   Gradio 4.44 REST flow used here (verified against the live Space):
      1. POST /upload        (multipart "files")  -> [path, path]
      2. POST /call/run_tryon (JSON, FileData)     -> {"event_id": "..."}
      3. GET  /call/run_tryon/{event_id} (SSE)    -> event: complete
                                                       data: [[{"image":{url}}]]
   ============================================================ */

"use strict";

const $ = (id) => document.getElementById(id);

// ZeroGPU Space this frontend talks to.
// NOTE: if you rename the GPU Space, update this to match your HF URL:
const GRADIO_SPACE_URL = "https://muse0515-my-heart-vton-zerogpu.hf.space";

const state = {
  category: "tops",
  garmentPhotoType: "model",
  numSamples: 1,
  numTimesteps: 20,
  guidanceScale: 1.5,
  seed: 42,
  segmentationFree: true,
  modelState: "connecting", // connecting | ready | error | unreachable
  running: false,
  person: null, // { file, url }
  garment: null, // { file, url }
  lastResults: [], // display URLs
  originalPersonUrl: null,
  timerInterval: null,
  startTime: 0,
};

const zones = {
  person: {
    zone: $("person-zone"),
    input: $("person-input"),
    preview: $("person-preview"),
    placeholder: $("person-placeholder"),
    remove: $("person-remove"),
  },
  garment: {
    zone: $("garment-zone"),
    input: $("garment-input"),
    preview: $("garment-preview"),
    placeholder: $("garment-placeholder"),
    remove: $("garment-remove"),
  },
};

/* ---------------------------------------------------------------------------
   Uploads
   ------------------------------------------------------------------------- */

function setImage(kind, file) {
  if (state[kind]) URL.revokeObjectURL(state[kind].url);
  state[kind] = { file, url: URL.createObjectURL(file) };
  const z = zones[kind];
  z.preview.src = state[kind].url;
  z.preview.hidden = false;
  z.placeholder.hidden = true;
  z.remove.hidden = false;
  z.zone.querySelector(".upload-slot").classList.add("has-image");
  if (kind === "person") state.originalPersonUrl = state.person.url;
  refreshStateUI();
}

function clearImage(kind) {
  if (state[kind]) {
    URL.revokeObjectURL(state[kind].url);
    state[kind] = null;
  }
  const z = zones[kind];
  z.preview.hidden = true;
  z.preview.removeAttribute("src");
  z.placeholder.hidden = false;
  z.remove.hidden = true;
  z.zone.querySelector(".upload-slot").classList.remove("has-image");
  if (kind === "person") state.originalPersonUrl = null;
  refreshStateUI();
}

function bindUpload(kind) {
  const z = zones[kind];
  const slot = z.zone.querySelector(".upload-slot");

  z.zone.addEventListener("click", () => {
    if (!state[kind]) z.input.click();
  });

  z.input.addEventListener("change", () => {
    if (z.input.files && z.input.files[0]) setImage(kind, z.input.files[0]);
    z.input.value = "";
  });

  z.remove.addEventListener("click", (e) => {
    e.stopPropagation();
    clearImage(kind);
  });

  ["dragenter", "dragover"].forEach((evt) =>
    slot.addEventListener(evt, (e) => {
      e.preventDefault();
      slot.classList.add("dragover");
    })
  );

  ["dragleave", "drop"].forEach((evt) =>
    slot.addEventListener(evt, (e) => {
      e.preventDefault();
      slot.classList.remove("dragover");
    })
  );

  slot.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) setImage(kind, file);
  });

  z.zone.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && !state[kind]) {
      e.preventDefault();
      z.input.click();
    }
  });
}

bindUpload("person");
bindUpload("garment");

/* ---------------------------------------------------------------------------
   Controls
   ------------------------------------------------------------------------- */

function bindSegGroup(containerId, onSelect) {
  const container = $(containerId);
  container.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    container.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    onSelect(btn.dataset.value);
    refreshActionBar();
  });
}

bindSegGroup("photo-type-seg", (v) => { state.garmentPhotoType = v; });
bindSegGroup("samples-seg", (v) => { state.numSamples = Number(v); });

const pills = $("category-pills");
pills.addEventListener("click", (e) => {
  const pill = e.target.closest(".pill");
  if (!pill) return;
  pills.querySelectorAll(".pill").forEach((p) => p.classList.remove("active"));
  pill.classList.add("active");
  state.category = pill.dataset.value;
  refreshActionBar();
});

// Sliders with gradient fill
function paintRange(el) {
  const min = Number(el.min) || 0;
  const max = Number(el.max) || 100;
  const pct = ((Number(el.value) - min) / (max - min)) * 100;
  el.style.setProperty("--fill", `${pct}%`);
}

const stepsRange = $("steps-range");
const guidanceRange = $("guidance-range");

stepsRange.addEventListener("input", () => {
  state.numTimesteps = Number(stepsRange.value);
  $("steps-out").textContent = stepsRange.value;
  paintRange(stepsRange);
  refreshActionBar();
});

guidanceRange.addEventListener("input", () => {
  state.guidanceScale = Number(guidanceRange.value);
  $("guidance-out").textContent = guidanceRange.value;
  paintRange(guidanceRange);
  refreshActionBar();
});

paintRange(stepsRange); // NB: this also sets the initial fill (10–30)
paintRange(guidanceRange);

// Seed
const seedInput = $("seed-input");
seedInput.addEventListener("input", () => {
  state.seed = Math.max(0, Math.floor(Number(seedInput.value) || 0));
  refreshActionBar();
});
$("seed-random").addEventListener("click", () => {
  const seed = Math.floor(Math.random() * 1_000_000_000);
  state.seed = seed;
  seedInput.value = seed;
  refreshActionBar();
});

// Segmentation-free toggle
$("seg-free").addEventListener("change", (e) => {
  state.segmentationFree = e.target.checked;
});

/* ---------------------------------------------------------------------------
   Dynamic UI state (hint + action bar)
   ------------------------------------------------------------------------- */

const CATEGORY_LABELS = { tops: "Tops", bottoms: "Bottoms", "one-pieces": "One-piece" };

function refreshStateUI() {
  updateInputHint();
  refreshActionBar();
  updateTryOnButton();
}

function updateInputHint() {
  const hint = $("input-hint");
  hint.classList.remove("ok", "warn");
  if (state.person && state.garment) {
    hint.textContent = "Both photos ready ✓";
    hint.classList.add("ok");
  } else if (state.person || state.garment) {
    hint.textContent = "One more photo needed";
    hint.classList.add("warn");
  } else {
    hint.textContent = "Person + garment required";
  }
}

function refreshActionBar() {
  const stateEl = $("actionbar-state");
  const metaEl = $("actionbar-meta");

  if (state.running) {
    stateEl.textContent = "Generating your try-on…";
    metaEl.textContent = "";
    return;
  }

  const meta = [
    CATEGORY_LABELS[state.category],
    state.garmentPhotoType === "model" ? "Model photo" : "Flat-lay",
    `${state.numTimesteps} steps`,
    `Seed ${state.seed}`,
  ].join(" · ");

  if (!state.person || !state.garment) {
    stateEl.textContent = "Upload a person and a garment photo to continue";
    metaEl.textContent = state.person ? "Person added — now add a garment" : state.garment ? "Garment added — now add a person" : "";
  } else if (state.modelState !== "ready") {
    stateEl.textContent = "Photos ready — model is warming up…";
    metaEl.textContent = meta;
  } else {
    stateEl.textContent = "Ready to generate";
    metaEl.textContent = meta;
  }
}

/* ---------------------------------------------------------------------------
   Example images (raw.githubusercontent sends CORS headers, so the browser
   can fetch them cross-origin).
   ------------------------------------------------------------------------- */

async function urlToFile(url, filename) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}`);
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type || "image/webp" });
}

const EXAMPLE_IMAGES = {
  person: {
    url: "https://raw.githubusercontent.com/fashn-AI/fashn-vton-1.5/main/examples/data/model.webp",
    name: "model.webp",
  },
  garment: {
    url: "https://raw.githubusercontent.com/fashn-AI/fashn-vton-1.5/main/examples/data/garment.webp",
    name: "garment.webp",
  },
};

const loadExampleBtn = $("load-example");
if (loadExampleBtn) {
  loadExampleBtn.addEventListener("click", async () => {
    try {
      const personFile = await urlToFile(EXAMPLE_IMAGES.person.url, EXAMPLE_IMAGES.person.name);
      const garmentFile = await urlToFile(EXAMPLE_IMAGES.garment.url, EXAMPLE_IMAGES.garment.name);
      setImage("person", personFile);
      setImage("garment", garmentFile);
      showToast("Example photos loaded", "success");
    } catch (err) {
      showToast(err.message || "Example photos unavailable", "error");
    }
  });
}

/* ---------------------------------------------------------------------------
   Gradio connection / status
   ------------------------------------------------------------------------- */

async function checkConnection() {
  try {
    // Gradio exposes the app's config at /config; a plain (non-credentialed)
    // fetch proves the Space is up. We deliberately do NOT use @gradio/client
    // here: it fetches with credentials:"include", and the GPU Space's OPTIONS
    // preflight doesn't return Access-Control-Allow-Credentials for the static
    // gateway's origin, so the browser blocks it. Plain fetches work fine.
    const res = await fetch(GRADIO_SPACE_URL + "/config");
    if (!res.ok) throw new Error(`config returned ${res.status}`);
    state.modelState = "ready";
    $("status-chip").classList.remove("chip-loading", "chip-error");
    $("status-chip").classList.add("chip-ready");
    $("status-text").textContent = "Model ready";
    $("server-info").textContent = "ZeroGPU · huggingface.co";
  } catch (err) {
    console.warn("[gradio] connection check failed:", err);
    state.modelState = "error";
    $("status-chip").classList.remove("chip-ready", "chip-loading");
    $("status-chip").classList.add("chip-error");
    $("status-text").textContent = "Model offline — cold start may take a while";
  }
  refreshStateUI();
}

/* ---------------------------------------------------------------------------
   Try-on (Gradio 4 REST + SSE)
   ------------------------------------------------------------------------- */

function updateTryOnButton() {
  const btn = $("tryon-btn");
  const ready = state.person && state.garment && !state.running && state.modelState === "ready";
  btn.disabled = !ready;
  $("tryon-label").textContent = state.running ? "Generating…" : "Try It On";
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function startTimer() {
  state.startTime = Date.now();
  const tick = () => {
    $("progress-text").textContent = `Generating… ${formatElapsed(Date.now() - state.startTime)}`;
  };
  tick();
  state.timerInterval = setInterval(tick, 1000);
}

function stopTimer() {
  clearInterval(state.timerInterval);
  state.timerInterval = null;
}

// Gradio FileData serialization for image inputs.
function _toFileData(path) {
  return {
    path,
    url: null,
    size: null,
    orig_name: null,
    mime_type: null,
    meta: { _type: "gradio.FileData" },
  };
}

// Recursively collect displayable image URLs from a Gradio 4 Gallery output.
// Accepts: [[{image:{path,url}}], ["/gradio_file=..."], [dataURLs], or any
// nesting of arrays/objects containing {image:{...}} / {video:{...}}.
function _collectGalleryUrls(value, out) {
  out = out || [];
  if (typeof value === "string") {
    if (/^https?:\/\//.test(value) || value.startsWith("data:") || value.startsWith("/gradio")) {
      out.push(value);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) _collectGalleryUrls(v, out);
    return out;
  }
  if (value && typeof value === "object") {
    if (value.image && typeof value.image === "object") {
      const u = value.image.url || value.image.path;
      if (u) out.push(u);
    }
    if (value.video && typeof value.video === "object") {
      const u = value.video.url || value.video.path;
      if (u) out.push(u);
    }
    for (const k of ["data", "output", "value"]) {
      if (k in value) _collectGalleryUrls(value[k], out);
    }
  }
  return out;
}

// Parse one SSE block. Returns an array of image URLs when the job completed,
// null if the block was progress/heartbeat, throws if Gradio reported failure.
function _parseSseBlock(block) {
  const dataLines = (block || "")
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6));
  if (!dataLines.length) return null;
  const jsonText = dataLines.join("");
  if (!jsonText || jsonText === "null") return null;

  let ev;
  try {
    ev = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (Array.isArray(ev)) {
    // Gradio 4.44 REST SSE 'complete': data is directly [[{image:{...}}]]
    const urls = _collectGalleryUrls(ev);
    return urls.length ? urls : null;
  }
  if (ev && typeof ev === "object") {
    if (ev.msg === "process_completed") {
      const urls = _collectGalleryUrls(ev.output && ev.output.data);
      return urls.length ? urls : null;
    }
    if (ev.msg === "process_error" || ev.msg === "error") {
      const detail = (ev.error && ev.error.trim()) || ev.msg;
      throw new Error(detail);
    }
  }
  return null;
}

// Consume the Gradio 4 REST SSE stream for an event until it completes
// (returns image URLs) or fails (rejects).
async function streamEventUrls(eventId) {
  const res = await fetch(`${GRADIO_SPACE_URL}/call/run_tryon/${eventId}`, {
    method: "GET",
    credentials: "omit",
  });
  if (!res.ok || !res.body) throw new Error(`Result stream failed (HTTP ${res.status})`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const drain = () => {
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const urls = _parseSseBlock(block);
      if (urls) return urls;
    }
    return null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const urls = drain();
      if (urls) return urls;
    }
    const urls = _parseSseBlock(buffer);
    return urls || [];
  } finally {
    try {
      reader.releaseLock();
    } catch { /* ignore */ }
  }
}

// Make a result URL usable from the browser.
function _resolveResultUrl(url) {
  if (!url) return url;
  if (url.startsWith("data:") || url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("/")) return GRADIO_SPACE_URL + url;
  // Server-local file path (rare) — best effort.
  return GRADIO_SPACE_URL + "/gradio_file=" + encodeURIComponent(url);
}

async function runTryOn() {
  if (!state.person || !state.garment || state.running) return;

  if (state.modelState !== "ready") {
    showToast("The model is warming up. It may take a minute after a cold start — try again shortly.", "error");
    return;
  }

  state.running = true;
  $("tryon-btn").disabled = true;
  $("progress").classList.remove("hidden");
  startTimer();
  refreshStateUI();

  try {
    // --- Step 1: upload the two images to the GPU Space, get their paths ---
    // /upload accepts multipart field "files" (repeatable) and returns path strings.
    const upForm = new FormData();
    upForm.append("files", state.person.file, state.person.file.name || "person.png");
    upForm.append("files", state.garment.file, state.garment.file.name || "garment.png");
    const upRes = await fetch(GRADIO_SPACE_URL + "/upload", {
      method: "POST",
      body: upForm,
      credentials: "omit",
    });
    if (!upRes.ok) throw new Error(`Upload failed (HTTP ${upRes.status})`);
    const paths = await upRes.json();
    if (!Array.isArray(paths) || paths.length < 2) throw new Error("Upload returned invalid paths");

    // --- Step 2: start the job via Gradio 4 REST /call/run_tryon ---
    const body = {
      data: [
        _toFileData(paths[0]),
        _toFileData(paths[1]),
        state.category,
        state.garmentPhotoType,
        state.numSamples,
        state.numTimesteps,
        state.guidanceScale,
        state.seed,
        state.segmentationFree,
      ],
    };
    const callRes = await fetch(GRADIO_SPACE_URL + "/call/run_tryon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
    });
    if (!callRes.ok) throw new Error(`Queue join failed (HTTP ${callRes.status})`);
    const callData = await callRes.json();
    const eventId = callData && callData.event_id;
    if (!eventId) throw new Error("Model did not return an event_id");

    // --- Step 3: stream results from the SSE endpoint until COMPLETE ---
    const rawUrls = await streamEventUrls(eventId);
    if (!rawUrls.length) throw new Error("The model returned no images. Try again in a moment.");

    state.lastResults = rawUrls.map(_resolveResultUrl);
    renderResults();
    $("results").classList.remove("hidden");
    $("results-meta").textContent =
      `${state.lastResults.length} image${state.lastResults.length > 1 ? "s" : ""} · ${state.numTimesteps} steps · seed ${state.seed}`;
    showToast(`Generated in ${formatElapsed(Date.now() - state.startTime)}`, "success");
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    console.error("[tryon] run failed:", err);
    showToast(err.message || "Generation failed. The ZeroGPU Space may be cold — try again.", "error");
  } finally {
    state.running = false;
    stopTimer();
    $("progress").classList.add("hidden");
    refreshStateUI();
  }
}

$("tryon-btn").addEventListener("click", runTryOn);
$("try-again-btn").addEventListener("click", () => {
  $("seed-random").click();
  $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(runTryOn, 120);
});

// Keyboard shortcut: Ctrl/Cmd + Enter to try on
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") runTryOn();
});

/* ---------------------------------------------------------------------------
   Results rendering (before/after comparison slider)
   ------------------------------------------------------------------------- */

function buildCompareSlider(wrap, originalUrl) {
  const before = document.createElement("img");
  before.className = "compare-before";
  before.src = originalUrl;
  before.alt = "Original photo";
  before.setAttribute("draggable", "false");

  const handle = document.createElement("div");
  handle.className = "compare-handle";
  handle.setAttribute("aria-hidden", "true");

  const labelOriginal = document.createElement("span");
  labelOriginal.className = "compare-label original";
  labelOriginal.textContent = "Original";

  const labelTryon = document.createElement("span");
  labelTryon.className = "compare-label tryon";
  labelTryon.textContent = "Try-on";

  wrap.appendChild(before);
  wrap.appendChild(handle);
  wrap.appendChild(labelOriginal);
  wrap.appendChild(labelTryon);

  let pos = 50; // percent of "before" visible from the left

  const apply = () => {
    before.style.clipPath = `inset(0 ${100 - pos}% 0 0)`;
    handle.style.left = `${pos}%`;
  };

  const setFromEvent = (clientX) => {
    const rect = wrap.getBoundingClientRect();
    pos = Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100));
    apply();
  };

  wrap.addEventListener("pointerdown", (e) => {
    wrap.setPointerCapture(e.pointerId);
    setFromEvent(e.clientX);
  });
  wrap.addEventListener("pointermove", (e) => {
    if (e.buttons === 1 || e.pressure > 0) setFromEvent(e.clientX);
  });
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { pos = Math.max(0, pos - 5); apply(); e.preventDefault(); }
    if (e.key === "ArrowRight") { pos = Math.min(100, pos + 5); apply(); e.preventDefault(); }
  });

  apply();
}

function renderResults() {
  const grid = $("results-grid");
  grid.innerHTML = "";

  state.lastResults.forEach((displayUrl, i) => {
    const card = document.createElement("div");
    card.className = "result-card";
    card.style.animationDelay = `${i * 90}ms`;

    const wrap = document.createElement("div");
    wrap.className = "compare-wrap";
    wrap.setAttribute("role", "slider");
    wrap.setAttribute("tabindex", "0");
    wrap.setAttribute("aria-label", `Compare original with try-on result ${i + 1}`);
    wrap.setAttribute("aria-valuemin", "0");
    wrap.setAttribute("aria-valuemax", "100");
    wrap.setAttribute("aria-valuenow", "50");

    const resultImg = document.createElement("img");
    resultImg.src = displayUrl;
    resultImg.alt = `Try-on result ${i + 1}`;
    resultImg.setAttribute("draggable", "false");
    wrap.appendChild(resultImg);

    if (state.originalPersonUrl) buildCompareSlider(wrap, state.originalPersonUrl);

    const body = document.createElement("div");
    body.className = "result-body";
    const label = document.createElement("strong");
    label.textContent = `Result ${i + 1}`;

    const actions = document.createElement("div");
    actions.className = "result-actions";

    const dl = document.createElement("a");
    dl.className = "download-btn";
    dl.textContent = "⬇ Save";
    dl.href = displayUrl;
    dl.download = `tryon-result-${String(i + 1).padStart(2, "0")}.png`;
    dl.target = "_blank";
    dl.rel = "noopener";

    actions.appendChild(dl);
    body.appendChild(label);
    body.appendChild(actions);
    card.appendChild(wrap);
    card.appendChild(body);
    grid.appendChild(card);
  });
}

/* ---------------------------------------------------------------------------
   Toast
   ------------------------------------------------------------------------- */

let toastTimer = null;

function showToast(message, type = "info") {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.remove("error", "success");
  if (type === "error") toast.classList.add("error");
  if (type === "success") toast.classList.add("success");
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 4500);
}

/* ---------------------------------------------------------------------------
   Init
   ------------------------------------------------------------------------- */

// Initial polling — retries while the Space warms up.
async function init() {
  try {
    await checkConnection();
  } finally {
    // Keep polling every 15s so the status chip updates if the Space wakes up.
    setInterval(checkConnection, 15000);
  }
}

init();