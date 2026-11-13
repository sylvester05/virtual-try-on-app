/* ============================================================
   My Heart — Virtual Try-On frontend logic
   ============================================================ */

"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  category: "tops",
  garmentPhotoType: "model",
  numSamples: 1,
  numTimesteps: 30,
  guidanceScale: 1.5,
  seed: 42,
  segmentationFree: true,
  modelState: "loading", // loading | ready | error
  running: false,
  person: null, // { file, url }
  garment: null, // { file, url }
  lastResults: [], // data URLs
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

paintRange(stepsRange);
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
   Example images
   ------------------------------------------------------------------------- */

async function urlToFile(url, filename) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}`);
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type || "image/jpeg" });
}

$("load-example").addEventListener("click", async () => {
  try {
    const res = await fetch("/api/examples");
    if (!res.ok) throw new Error("Example images unavailable");
    const files = await res.json();

    const personKey = files["model.jpg"] ? "model.jpg" : files["model.webp"] ? "model.webp" : null;
    const garmentKey = files["garment.jpg"] ? "garment.jpg" : files["garment.webp"] ? "garment.webp" : null;

    if (!personKey || !garmentKey) throw new Error("Example images unavailable");

    const personFile = await urlToFile(files[personKey], personKey);
    const garmentFile = await urlToFile(files[garmentKey], garmentKey);
    setImage("person", personFile);
    setImage("garment", garmentFile);
    showToast("Example photos loaded", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
});

/* ---------------------------------------------------------------------------
   Model status polling
   ------------------------------------------------------------------------- */

async function pollStatus() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) throw new Error("status unavailable");
    const data = await res.json();
    state.modelState = data.state;

    const chip = $("status-chip");
    chip.classList.remove("chip-loading", "chip-ready", "chip-error");
    if (data.state === "ready") {
      chip.classList.add("chip-ready");
      $("status-text").textContent = "Model ready";
      $("server-info").textContent = data.device ? `Running on ${data.device}` : "";
    } else if (data.state === "error") {
      chip.classList.add("chip-error");
      $("status-text").textContent = "Model failed to load";
    } else {
      chip.classList.add("chip-loading");
      $("status-text").textContent = "Loading model…";
    }
  } catch (err) {
    state.modelState = "error";
    $("status-chip").classList.remove("chip-loading", "chip-ready");
    $("status-chip").classList.add("chip-error");
    $("status-text").textContent = "Server unreachable";
  }
  refreshStateUI();
}

setInterval(pollStatus, 2000);
pollStatus();

/* ---------------------------------------------------------------------------
   Try-on
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

async function runTryOn() {
  if (!state.person || !state.garment || state.running) return;

  if (state.modelState !== "ready") {
    showToast("The model is still loading — wait for the status chip to turn green.", "error");
    return;
  }

  state.running = true;
  $("tryon-btn").disabled = true;
  $("progress").classList.remove("hidden");
  startTimer();
  refreshStateUI();

  const form = new FormData();
  form.append("person_image", state.person.file);
  form.append("garment_image", state.garment.file);
  form.append("category", state.category);
  form.append("garment_photo_type", state.garmentPhotoType);
  form.append("num_samples", String(state.numSamples));
  form.append("num_timesteps", String(state.numTimesteps));
  form.append("guidance_scale", String(state.guidanceScale));
  form.append("seed", String(state.seed));
  form.append("segmentation_free", String(state.segmentationFree));

  try {
    const res = await fetch("/api/tryon", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.detail || `Request failed (${res.status})`);
    }
    if (!Array.isArray(data.images) || data.images.length === 0) {
      throw new Error("No images returned by the server");
    }
    state.lastResults = data.images;
    renderResults();
    $("results").classList.remove("hidden");
    $("results-meta").textContent =
      `${data.images.length} image${data.images.length > 1 ? "s" : ""} · ${state.numTimesteps} steps · seed ${state.seed}`;
    showToast(`Generated in ${formatElapsed(Date.now() - state.startTime)}`, "success");
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    showToast(err.message, "error");
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

  state.lastResults.forEach((dataUrl, i) => {
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
    resultImg.src = dataUrl;
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
    dl.href = dataUrl;
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




